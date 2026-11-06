// 鱼来 · 潮汐调和预报引擎（tide7）：对每港的历史逐时潮高做最小二乘调和拟合，
// 外推未来 7 天高低潮。chaoxibiao.net 只有当日数据（实测过，无历史页），
// 历史靠数据仓自积累：data/tides-history.json 每日并入当日快照，攒够 15 天（覆盖 M2/S2 半日潮 14.77 天拍频）
// 后 fit.ok 置真，预报页「未来 7 天潮汐」自动点亮——宁缺毋滥，没攒够就诚实显示进度。
//
// 模型：h(t) = mean + Σ_k [ A_k·cos(ω_k·t) + B_k·sin(ω_k·t) ]，k ∈ {M2, S2, K1, O1}
// t = Unix 小时（UTC）；ω 单位 rad/h；4 分量 9 未知数，正则方程高斯消元，零依赖。
// 与小程序端 utils/tide.js 的 evalFit/forecast7 共用同一套约定（改这里必须同步那边）。
//
// 用法（fetch.js 每轮调用）：
//   const tidefit = require('./tidefit');
//   const hist = tidefit.mergeHistory(oldHist, tidesJson);   // 并入当日快照
//   const fit = tidefit.buildFits(hist);                      // 逐港拟合 → data/tides-fit.json

// 分潮角速度（度/小时，天文常数）
const FREQS = { M2: 28.9841042, S2: 30.0, K1: 15.0410686, O1: 13.9430356 };
const KEYS = Object.keys(FREQS);
const OMEGA = KEYS.map((k) => (FREQS[k] * Math.PI) / 180); // rad/h

// 预报资质门槛：≥15 天观测（M2/S2 拍频 14.77 天，少一天两分量就分不开）、
// 残差 ≤40cm（典型半日潮潮差 1-4m，残差过大说明数据脏/非潮信号为主）、
// 潮幅合计 ≥20cm（内河微潮港拟合无意义）
const MIN_DAYS = 15;
const MAX_RMS = 40;
const MIN_AMP = 20;
const CAP_DAYS = 45; // 历史归档保留天数（控体积，45 天足够拟合也留了重跑余地）

const p2 = (x) => (x < 10 ? '0' + x : '' + x);

/** 北京时 (date 'YYYY-MM-DD', hour 0-23) → Unix 小时 */
function tOf(date, hour) {
  return Date.parse(`${date}T${p2(hour)}:00:00+08:00`) / 3600000;
}

/**
 * 历史归档并入一日快照：hist = {v, days:{date:{portId:[24 潮高]}}, updated}
 * 同日重复并入取后者（当日晚些时候的快照通常补齐了更多港）。
 * capDays 截旧；返回新对象（入参不动）。
 */
function mergeHistory(hist, snap, capDays = CAP_DAYS) {
  const out = { v: 1, days: Object.assign({}, hist && hist.days), updated: new Date().toISOString() };
  if (snap && snap.date && Array.isArray(snap.ports)) {
    const day = {};
    for (const p of snap.ports) {
      if (p && p.id && Array.isArray(p.h) && p.h.length === 24 && p.h.every((v) => isFinite(v))) {
        day[String(p.id)] = p.h.map((v) => Math.round(v));
      }
    }
    if (Object.keys(day).length) out.days[snap.date] = day;
  }
  const dates = Object.keys(out.days).sort();
  while (dates.length > capDays) delete out.days[dates.shift()];
  return out;
}

/** n×n 线性方程组高斯消元（列主元），零依赖 */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat(b[i]));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null; // 病态（样本太少/全零）
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * 单港拟合：days = {date:{portId:[24]}}（整个归档，不只这一港）。
 * 返回 {days, ok, rms, ampSum, mean, comps:{M2:[A,B],...}} 或 null（样本不足 3 天，连拟合都不做）。
 * ok=false 的港照样给参数（页面显示进度用），只是客户端不放行 7 天预报。
 */
function fitPort(days, portId) {
  const xs = [];
  const ys = [];
  let dayCount = 0;
  for (const date of Object.keys(days).sort()) {
    const h = days[date][portId];
    if (!h) continue;
    dayCount++;
    for (let i = 0; i < 24; i++) {
      if (h[i] == null || !isFinite(h[i])) continue;
      xs.push(tOf(date, i));
      ys.push(h[i]);
    }
  }
  if (dayCount < 3 || xs.length < 48) return null;

  // 正则方程 (XᵀX)β = Xᵀy；基 = [1, cos ω1 t, sin ω1 t, …]
  const n = 1 + 2 * KEYS.length;
  const XtX = Array.from({ length: n }, () => new Array(n).fill(0));
  const Xty = new Array(n).fill(0);
  for (let s = 0; s < xs.length; s++) {
    const row = [1];
    for (let k = 0; k < KEYS.length; k++) {
      row.push(Math.cos(OMEGA[k] * xs[s]), Math.sin(OMEGA[k] * xs[s]));
    }
    for (let i = 0; i < n; i++) {
      Xty[i] += row[i] * ys[s];
      for (let j = i; j < n; j++) XtX[i][j] += row[i] * row[j];
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) XtX[i][j] = XtX[j][i];
  const beta = solve(XtX, Xty);
  if (!beta) return null;

  // 残差 rms 与分潮振幅
  let sse = 0;
  for (let s = 0; s < xs.length; s++) {
    let h = beta[0];
    for (let k = 0; k < KEYS.length; k++) h += beta[1 + 2 * k] * Math.cos(OMEGA[k] * xs[s]) + beta[2 + 2 * k] * Math.sin(OMEGA[k] * xs[s]);
    sse += (h - ys[s]) ** 2;
  }
  const rms = Math.sqrt(sse / xs.length);
  const comps = {};
  let ampSum = 0;
  KEYS.forEach((k, i) => {
    const A = beta[1 + 2 * i];
    const B = beta[2 + 2 * i];
    comps[k] = [Math.round(A * 100) / 100, Math.round(B * 100) / 100];
    ampSum += Math.hypot(A, B);
  });
  return {
    days: dayCount,
    ok: dayCount >= MIN_DAYS && rms <= MAX_RMS && ampSum >= MIN_AMP,
    rms: Math.round(rms * 10) / 10,
    ampSum: Math.round(ampSum),
    mean: Math.round(beta[0] * 10) / 10,
    comps,
  };
}

/** 全港拟合 → tides-fit.json 内容（端口元数据不重复存，客户端拿 tides.json 的港表按 id join） */
function buildFits(hist) {
  const ids = new Set();
  for (const date of Object.keys(hist.days)) for (const id of Object.keys(hist.days[date])) ids.add(id);
  const ports = [];
  for (const id of ids) {
    const f = fitPort(hist.days, id);
    if (f) ports.push(Object.assign({ id }, f));
  }
  return { v: 1, updated: new Date().toISOString(), minDays: MIN_DAYS, ports };
}

module.exports = { FREQS, MIN_DAYS, CAP_DAYS, tOf, mergeHistory, solve, fitPort, buildFits };
