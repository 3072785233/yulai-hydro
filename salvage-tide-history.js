// 一次性打捞：潮汐历史归档（tide7）。
// chaoxibiao 只有当日页面，历史只存在于两处——本仓 git 提交史 + Gitee 镜像提交史（中继每轮 API 直写都会留 commit）。
// 本脚本两头都捞：逐 blob 解析 tides.json，按其自带 date 分组、同日取港口数最多的快照，
// 顺日期序喂 mergeHistory → data/tides-history.json，再顺手出一版 data/tides-fit.json。
// 用法：node salvage-tide-history.js  （在 hydro-repo 目录；Gitee 是公开仓，列表/读 blob 免令牌）
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const tidefit = require('./tidefit');

const GITEE_API = 'https://gitee.com/api/v5/repos/Mortar630/yulai-hydro';
const HIST_FILE = path.join(__dirname, 'data', 'tides-history.json');
const FIT_FILE = path.join(__dirname, 'data', 'tides-fit.json');

async function giteeBlobs() {
  const shas = [];
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(`${GITEE_API}/commits?path=data/tides.json&per_page=100&page=${page}`);
    if (!r.ok) break;
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) break;
    arr.forEach((c) => shas.push(c.sha));
    if (arr.length < 100) break;
  }
  const out = [];
  for (const sha of shas) {
    try {
      const r = await fetch(`${GITEE_API}/contents/data/tides.json?ref=${sha}`);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.content) out.push(JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')));
    } catch (e) { /* 单个 blob 挂了不挡道 */ }
  }
  return out;
}

function localBlobs() {
  const out = [];
  let shas = '';
  try {
    shas = execSync('git log --format=%H -- data/tides.json', { cwd: __dirname }).toString().trim();
  } catch (e) {
    return out;
  }
  for (const sha of shas.split('\n').filter(Boolean)) {
    try {
      out.push(JSON.parse(execSync(`git show ${sha}:data/tides.json`, { cwd: __dirname, maxBuffer: 8 * 1024 * 1024 }).toString('utf8')));
    } catch (e) { /* 跳过坏 blob */ }
  }
  return out;
}

(async () => {
  const snaps = [...localBlobs(), ...(await giteeBlobs())].filter(
    (s) => s && s.date && Array.isArray(s.ports) && s.ports.length >= 10
  );
  // 同日取港口数最多的快照（当日晚间快照通常更全）
  const best = new Map();
  for (const s of snaps) if (!best.has(s.date) || s.ports.length > best.get(s.date).ports.length) best.set(s.date, s);
  const dates = [...best.keys()].sort();
  console.log(`打捞到 ${snaps.length} 个快照，去重后 ${dates.length} 天：${dates.join('、')}`);

  let hist = { v: 1, days: {} };
  for (const d of dates) hist = tidefit.mergeHistory(hist, best.get(d));

  fs.mkdirSync(path.dirname(HIST_FILE), { recursive: true });
  fs.writeFileSync(HIST_FILE, JSON.stringify(hist));
  const days = Object.keys(hist.days).length;
  const ports = new Set();
  for (const d of Object.keys(hist.days)) Object.keys(hist.days[d]).forEach((id) => ports.add(id));
  console.log(`[ok] tides-history ${days} 天 · ${ports.size} 港 · ${Math.round(fs.statSync(HIST_FILE).size / 1024)}KB（上限 ${tidefit.CAP_DAYS} 天）`);

  const fit = tidefit.buildFits(hist);
  fs.writeFileSync(FIT_FILE, JSON.stringify(fit));
  const okN = fit.ports.filter((p) => p.ok).length;
  console.log(`[ok] tides-fit ${fit.ports.length} 港拟合 · ${okN} 港达标（≥${tidefit.MIN_DAYS} 天且残差合格）· ${Math.round(fs.statSync(FIT_FILE).size / 1024)}KB`);
  if (days < tidefit.MIN_DAYS) console.log(`历史 ${days}/${tidefit.MIN_DAYS} 天——继续攒，fetch.js 每日自动并入`);
})();
