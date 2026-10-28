// 鱼来 · 江河水情抓取器（零依赖 Node ≥18）
// 数据源：长江水利委员会水文局「长江水文网」5 个页面（HTTP，服务端直出 var sssq=[...] 数组）
// 产物：data/hydro.json —— 全流域站表 + 近24h走势 + 24h变幅（给小程序钓鱼指数用）
// 部署：GitHub Actions 每小时跑一次 → commit 回本仓库 → 同步推 Gitee（国内访问）
// 用法：node fetch.js   （退出码：一个站都没抓到才算失败）

const fs = require('fs');
const path = require('path');

// 5 个数据源（站码 stcd 全流域唯一，跨源去重保留最新）
const SOURCES = [
  { key: 'main', url: 'http://www.cjh.com.cn/sssqcwww.html', note: '长江干流7站' },
  { key: 'sy', url: 'http://sy.cjh.com.cn/', note: '上游局10站' },
  { key: 'zy', url: 'http://zy.cjh.com.cn/sqall.html', note: '中游局65站' },
  { key: 'xy', url: 'http://xy.cjh.com.cn/', note: '下游局13站' },
  { key: 'hj', url: 'http://hj.cjh.com.cn/', note: '汉江局19站' },
];

const DATA_FILE = path.join(__dirname, 'data', 'hydro.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

// 水势码 → 语义（水情信息编码 SL 330：5涨 4落 6平；其余视为未知）
const trendOf = (wptn) => (wptn === '5' ? 'rise' : wptn === '4' ? 'fall' : wptn === '6' ? 'flat' : 'unk');

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parsePage(html) {
  const m = html.match(/var sssq ?= ?(\[[\s\S]*?\]);/);
  if (!m) return null;
  return JSON.parse(m[1]);
}

/** 就近 24h：取离 (now-24h) 最近的走势点，偏差 ≤4h 才算数 */
function delta24(hist, nowTs) {
  const target = nowTs - 24 * 3600e3;
  let best = null;
  let bestGap = Infinity;
  for (const [t, z] of hist) {
    const gap = Math.abs(t - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = z;
    }
  }
  if (best == null || bestGap > 4 * 3600e3) return null;
  return Math.round((hist[hist.length - 1][1] - best) * 100) / 100;
}

async function main() {
  const sources = {};
  const byStcd = new Map(); // stcd → 原始记录（跨源去重，保留 tm 较新者）

  await Promise.all(
    SOURCES.map(async (s) => {
      try {
        const arr = parsePage(await fetchText(s.url));
        if (!Array.isArray(arr) || !arr.length) throw new Error('页面里没有 sssq 数组');
        let n = 0;
        for (const raw of arr) {
          if (!raw || !raw.stcd) continue;
          // 汉江局页面用大写字段（Z/Q/TM/WPTN），其余站小写——归一
          const r = {
            z: raw.z != null ? raw.z : raw.Z,
            q: raw.q != null ? raw.q : raw.Q,
            tm: raw.tm != null ? raw.tm : raw.TM,
            wptn: raw.wptn != null ? raw.wptn : raw.WPTN,
            rvnm: raw.rvnm,
          };
          if (r.z == null) continue;
          const tm = Number(r.tm) || 0;
          const prev = byStcd.get(raw.stcd);
          if (!prev || tm >= prev.tm) {
            byStcd.set(String(raw.stcd), {
              stcd: String(raw.stcd),
              stnm: String(raw.stnm || raw.stcd),
              rvnm: String(r.rvnm || '').replace('(null)', '') || (s.key === 'hj' ? '汉江' : '长江流域'),
              z: Math.round(Number(r.z) * 100) / 100,
              q: Number(r.q) || 0,
              tm,
              w: trendOf(String(r.wptn)),
            });
          }
          n++;
        }
        sources[s.key] = `ok ${n}条`;
        console.log(`[ok] ${s.key} ${s.note} ${n} 条`);
      } catch (e) {
        sources[s.key] = 'fail ' + String(e.message || e).slice(0, 40);
        console.log(`[fail] ${s.key} ${s.url} → ${e.message}`);
      }
    })
  );

  if (!byStcd.size) {
    console.error('全部数据源失败，保留旧文件');
    process.exit(1);
  }

  // 合并上一次快照的走势（GitHub Actions 每小时一次，累积出 24h 变幅）
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { /* 首次运行 */ }

  const now = Date.now();
  const stations = [];
  for (const [stcd, r] of byStcd) {
    const old = prev && Array.isArray(prev.stations) ? prev.stations.find((x) => x.stcd === stcd) : null;
    let h = Array.isArray(old && old.h) ? old.h.slice() : [];
    const lastT = h.length ? h[h.length - 1][0] : 0;
    if (r.tm && r.tm > lastT) h.push([r.tm, r.z]);
    // 去重 + 只留近 26h
    const seen = new Set();
    h = h
      .filter(([t]) => t >= now - 26 * 3600e3 && !seen.has(t) && seen.add(t))
      .sort((a, b) => a[0] - b[0]);
    const st = { stcd, stnm: r.stnm, rvnm: r.rvnm, z: r.z, q: r.q, tm: r.tm, w: r.w, d24: delta24(h, r.tm || now), h };
    stations.push(st);
  }
  stations.sort((a, b) => (a.rvnm + a.stnm).localeCompare(b.rvnm + b.stnm, 'zh'));

  const out = { v: 1, updated: new Date().toISOString(), sources, stations };
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(out));
  const size = Math.round(fs.statSync(DATA_FILE).size / 1024);
  const withD = stations.filter((s) => s.d24 != null).length;
  console.log(`写入 data/hydro.json：${stations.length} 站 · ${withD} 站有24h变幅 · ${size}KB`);
}

main();
