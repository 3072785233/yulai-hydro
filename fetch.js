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

// 6 号源：交通运输部官网「长江水位」每日公告（8/16 时各一期，29 站）
// 补上长江委对外页没有的三峡库区段（长寿/涪陵/万州/秭归）——秭归·郭家坝就在巴东下游约50km
// 注意：航道水位按当地航行基准面起算，与长江委站（绝对高程）基准不同，站对象标 src:'mot' 区分展示
const MOT_LIST = 'https://www.mot.gov.cn/fuwu/yujingtishi/cjshuiweichaowei/';

// 7 号源：湖北省水情平台（单站页直出 ECharts 10 天逐小时序列，小时级）
// 平台列表页依赖 Redis 不稳定（时常 500）→ 用固定站码表逐站抓单站页，坏一个站不影响其他
// 站码为全国统一水文编码，与长江委 5 源按 stcd 自动去重（保留时间较新者）；
// 补长江委对外页没有的：四口洪道 / 汉江中下游 / 倒举巴·浠河 / 江汉平原诸站
const HB_STATIONS = [
  ['60105400', '寸滩', '长江'], ['60107300', '宜昌', '长江'], ['60107400', '枝城', '长江'],
  ['60108300', '沙市', '长江'], ['60109400', '石首', '长江'], ['60110500', '监利', '长江'],
  ['60111200', '莲花塘', '长江'], ['60111300', '螺山', '长江'], ['60112200', '汉口', '长江'],
  ['60112900', '黄石港', '长江'], ['60113205', '码头镇', '长江'], ['60113400', '九江', '长江'],
  ['60803000', '武隆', '乌江'], ['60908000', '河溶', '沮漳河'], ['61607000', '阳新', '富水'],
  ['61500300', '新江口', '松滋河'], ['61501200', '沙道观', '松滋河'], ['61501500', '弥陀寺', '虎渡河'],
  ['61501800', '藕池(康)', '藕池河'], ['61502200', '藕池(管)', '藕池河'], ['61512000', '城陵矶(七里山)', '洞庭湖口'],
  ['61801300', '安康', '汉江'], ['61801700', '白河', '汉江'], ['61802800', '黄家港', '汉江'],
  ['61803400', '襄阳', '汉江'], ['61803500', '宜城', '汉江'], ['61804110', '皇庄', '汉江'],
  ['61804210', '沙洋(三)', '汉江'], ['61804250', '兴隆', '汉江'], ['61804400', '岳口', '汉江'],
  ['61804600', '仙桃(二)', '汉江'], ['61804710', '汉川', '汉江'],
  ['62201400', '隔蒲潭', '府河'], ['62201800', '卧龙潭', '澴水'], ['62205800', '孝感', '府澴河'],
  ['62206900', '天门', '天门河'], ['62209400', '应城', '大富水'], ['62213000', '潜江', '田关河'],
  ['61609400', '黄陂', '滠水'], ['61610600', '李家集', '倒水'], ['61612400', '柳子港', '举水'],
  ['61615600', '马家潭', '巴河'], ['61619600', '西河驿', '浠水'], ['62016400', '郭滩', '唐白河'],
  ['62601600', '湖口', '鄱阳湖口'],
];
// 注意走 http：该站 TLS 是老旧 legacy renegotiation，Node18+（OpenSSL 3）握手直接拒绝
const HB_BASE = 'http://hbwater.wetruetech.com/water/portal/wx_station_info?stationCode=';

const DATA_FILE = path.join(__dirname, 'data', 'hydro.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

// 水势码 → 语义（水情信息编码 SL 330：5涨 4落 6平；其余视为未知）
const trendOf = (wptn) => (wptn === '5' ? 'rise' : wptn === '4' ? 'fall' : wptn === '6' ? 'flat' : 'unk');

async function fetchText(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 站名 → 稳定伪站码（mot_ 前缀 + djb2 哈希），走势合并按 stcd 追踪 */
function motId(name) {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  return 'mot_' + h.toString(16);
}

/** 交通部每日长江水位表：列表页找最新「N时长江水位」文章 → 解析 站点/水位/涨落 三列表格 */
async function fetchMot() {
  const listHtml = await fetchText(MOT_LIST, 25000);
  const m = listHtml.match(/href="(\.\/[^"]+\.html)"[\s\S]{0,160}?(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2})时长江水位/);
  if (!m) throw new Error('列表页没找到长江水位文章');
  const artUrl = new URL(m[1], MOT_LIST).href;
  const tm = Date.UTC(+m[2], +m[3] - 1, +m[4], +m[5] - 8, 0, 0); // 公告为北京时间 → epoch
  const html = await fetchText(artUrl, 25000);
  const rows = [];
  const trRe = /<tr[^>]*>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>/g;
  let t;
  while ((t = trRe.exec(html))) {
    const name = t[1].trim();
    if (!name || name === '站点') continue;
    const z = Number(t[2].trim());
    if (!isFinite(z)) continue;
    const d24 = Number(String(t[3].trim()).replace('+', '')); // 涨落 ±x.xx，0 记 0
    rows.push({
      stcd: motId(name),
      stnm: name,
      rvnm: '长江(航道)',
      z: Math.round(z * 100) / 100,
      q: 0,
      tm,
      w: !isFinite(d24) ? 'unk' : d24 > 0 ? 'rise' : d24 < 0 ? 'fall' : 'flat',
      src: 'mot',
      d24: isFinite(d24) ? Math.round(d24 * 100) / 100 : null,
    });
  }
  if (!rows.length) throw new Error('文章里没解析到站点行');
  console.log(`[ok] mot 交通部长江水位表 ${m[2]}-${m[3]}-${m[4]} ${m[5]}时 · ${rows.length} 站`);
  return rows;
}

/** 湖北省水情平台：逐站抓单站页，解析 ECharts 的 横轴(月,日,时) + 水位 + 流量 三条序列 */
async function fetchHubei() {
  const rows = [];
  let okN = 0;
  const CONC = 3; // 并发高了这个老服务器会随机甩 413
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < HB_STATIONS.length; i += CONC) {
    await Promise.all(
      HB_STATIONS.slice(i, i + CONC).map(async ([code, name, rv]) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt) await sleep(900);
          try {
          const html = await fetchText(HB_BASE + code, 20000);
          // 图例（data:['水位','流量']）之后的长数组依次是：横轴、水位、流量
          const legend = html.match(/data: ?\['水位','流量'\]/);
          if (!legend) throw new Error('页面模板变了');
          const tail = html.slice(legend.index + legend[0].length);
          const arrs = [...tail.matchAll(/data: ?\[([\s\S]*?)\]/g)]
            .map((m) => ({ raw: m[1], nums: (m[1].match(/-?\d+(?:\.\d+)?/g) || []).map(Number) }))
            .filter((a) => a.nums.length > 0);
          // 横轴是 'MM-DD HH' 字符串三元组（长度被3整除）；其后两条长度=点数的序列是 水位、流量
          // 有的站 6 小时一报（10 天只有 40 来点），不能用「点数多」当判据
          // 注意日不能走数字正则——'10-29' 的连字符会把日期吃成 -29
          let xRaw = null, zSe = null, qSe = null;
          for (let k = 0; k < arrs.length; k++) {
            const a = arrs[k];
            if (a.nums.length >= 6 && a.nums.length % 3 === 0) {
              const n = a.nums.length / 3;
              const toks = a.raw.match(/'(\d{1,2})-(\d{1,2}) (\d{1,2})'/g) || [];
              if (toks.length !== n) continue;
              const after = arrs.slice(k + 1).filter((b) => b.nums.length === n);
              if (after.length >= 1) { xRaw = toks; zSe = after[0].nums; qSe = after[1] ? after[1].nums : null; break; }
            }
          }
          if (!xRaw) throw new Error('没找到横轴+序列');
          // 横轴是 月,日,时 三元组 → epoch（北京时间）。年份推断：取离现在最近且不超前的
          const now = Date.now();
          const epoch = (mo, d, hh) => {
            const y = new Date().getFullYear();
            for (const yy of [y, y - 1]) {
              const t = Date.UTC(yy, mo - 1, d, hh - 8, 0, 0);
              if (t <= now + 3600e3) return t;
            }
            return null;
          };
          const pts = [];
          for (let k = 0; k < xRaw.length; k++) {
            const [, mo, d, hh] = xRaw[k].match(/(\d{1,2})-(\d{1,2}) (\d{1,2})/);
            const t = epoch(+mo, +d, +hh);
            if (t != null && zSe[k] != null) pts.push([t, Math.round(zSe[k] * 100) / 100]);
          }
          if (pts.length < 2) throw new Error('序列解析为空');
          const last = pts[pts.length - 1];
          const q = qSe ? qSe[qSe.length - 1] : 0;
          // 水势：与上一个不相等的点比（±0.01 视为平）
          let w = 'unk';
          for (let k = pts.length - 2; k >= 0; k--) {
            if (Math.abs(pts[k][1] - last[1]) >= 0.01) {
              w = pts[k][1] < last[1] ? 'rise' : 'fall';
              break;
            } else if (pts.length - 1 - k >= 2) { w = 'flat'; break; }
          }
          rows.push({
            stcd: code, stnm: name, rvnm: rv,
            z: last[1], q: Math.round(Number(q) || 0), tm: last[0], w, src: 'hb',
            d24: delta24(pts, last[0]), // 页面自带10天序列，首抓就有24h变幅
          });
          okN++;
          break;
          } catch (e) {
            if (attempt) console.log(`     hb ${name} → ${String(e.message || e).slice(0, 50)}`);
          }
        }
      })
    );
  }
  if (!rows.length) throw new Error('45 站全军覆没（平台可能又在 500）');
  console.log(`[ok] hb 湖北省水情平台 ${okN}/${HB_STATIONS.length} 站`);
  return rows;
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

  // 7 号源：湖北省水情平台（独立容错；全国统一站码，与长江委重码站保留 tm 较新者）
  try {
    const hb = await fetchHubei();
    let added = 0;
    for (const r of hb) {
      const prev = byStcd.get(r.stcd);
      if (!prev || r.tm >= prev.tm) { byStcd.set(r.stcd, r); added++; }
    }
    sources.hb = `ok ${added}/${hb.length}站`;
  } catch (e) {
    sources.hb = 'fail ' + String(e.message || e).slice(0, 40);
    console.log('[fail] hb →', e.message);
  }

  // 6 号源：交通部每日水位表（独立容错：它挂了不影响长江委 5 源；与长江委重名站跳过——水文口径小时级更优）
  try {
    const mot = await fetchMot();
    const cjhNames = new Set();
    for (const r of byStcd.values()) {
      cjhNames.add(r.stnm.replace(/[(（].*/, ''));
    }
    let added = 0;
    for (const r of mot) {
      const prefix = r.stnm.replace(/[(（].*/, ''); // 重庆（寸滩）→ 重庆
      const paren = (r.stnm.match(/[(（]([^)）]+)/) || [])[1] || ''; // → 寸滩
      const dup = [...cjhNames].some((n) => (paren && n === paren) || (prefix.length >= 2 && (n === prefix || n.startsWith(prefix))));
      if (dup) continue;
      if (!byStcd.has(r.stcd)) {
        byStcd.set(r.stcd, r);
        added++;
      }
    }
    sources.mot = `ok ${added}/${mot.length}条`;
    console.log(`     mot 去重后新增 ${added} 站（其余与长江委重名跳过）`);
  } catch (e) {
    sources.mot = 'fail ' + String(e.message || e).slice(0, 40);
    console.log('[fail] mot →', e.message);
  }

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
    const st = {
      stcd,
      stnm: r.stnm,
      rvnm: r.rvnm,
      z: r.z,
      q: r.q,
      tm: r.tm,
      w: r.w,
      // mot 站用公告「涨落」列、hb 站用页面序列自带的 24h 变幅（首次抓取即有）；长江委站由走势推算
      d24: r.d24 != null ? r.d24 : delta24(h, r.tm || now),
      src: r.src || 'cjh',
      h,
    };
    stations.push(st);
  }
  // 短暂断源的站不硬删：上一轮快照有、这轮没抓到且数据还在 48h 内的，原样保留
  // （比如湖北平台偶发 413/500 封一轮——站消失一小时比显示两小时前的读数更伤）
  if (prev && Array.isArray(prev.stations)) {
    const have = new Set(stations.map((s) => s.stcd));
    let kept = 0;
    for (const old of prev.stations) {
      if (have.has(old.stcd) || !old.tm || old.tm < now - 48 * 3600e3) continue;
      stations.push(old);
      kept++;
    }
    if (kept) console.log(`断源保留 ${kept} 站（沿用上轮读数，时间戳即滞后程度）`);
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
