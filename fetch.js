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

// 8 号源：交通运输部「珠江水情信息」每日公告（每日 8 时，约 13 站）
// 珠江委官网被 WAF 挡、广东各水文站 DNS 全死，交通部这条路是珠江流域唯一公开直出源
// 注意：部分站水位为当地/冻结基面（石角 1m、高要 0.9m 量级），非绝对高程，站对象标 src:'zj' 区分
const ZJ_LIST = 'https://www.mot.gov.cn/fuwu/yujingtishi/zhujiangshuiqingxx/';
// 站名 → 河名（只标有把握的，其余统一「珠江水系」不硬编）
const ZJ_RIVERS = {
  '南宁（三）': '郁江', 贵港: '郁江', '大湟江口（二）': '浔江', '梧州（四）': '西江',
  高要: '西江', 石角: '北江', 柳州: '柳江', 武宣: '黔江', 迁江: '红水河',
};

// 9 号源：松辽委「实时水情」（松花江/嫩江/辽河干流 6 站，每日 8 时）
// slwr.gov.cn 明文 JSON 接口无反爬（从 sssq.jhtml 页面 JS 逆向所得）；站码为全国统一水文编码
// 注意：各站水位为当地（冻结）基面，非绝对高程——看涨落与流量更直观，站对象标 src:'sl' 区分展示
const SL_API = 'http://www.slwr.gov.cn/slwSQ/api/sq-list';
// 站名 → 河名（接口不带河名；全部 6 站显式标，未来新增站兜底「松辽流域」不硬编）
const SL_RIVERS = {
  哈尔滨: '松花江', 宁江: '松花江', 大赉: '松花江',
  江桥: '嫩江', 铁岭: '辽河', 沈阳: '浑河',
};

// 10 号源：太湖流域管理局「水文信息服务系统」后端接口（太湖流域 + 浙闽片，逐小时）
// info.tbasw.cn 展示页是 miniui SPA，但后端裸 IP 直连明文 JSON、无鉴权（从页面 JS 逆向所得）
// 站型含 河道/水库/潮位/闸坝——只收 河道+潮位+闸坝 且 z 非空的站（水库大多无水位值，诚实跳过）
// 潮位站对河口/感潮河段钓鱼是独有价值；站对象标 src:'tba'，携带 wrz 警戒水位备用
const TBA_BASE = 'http://58.247.45.108:8020/RegionalWaterAnalysis/getWA_WaterDay';
// 11 号源：水利部「全国水雨情信息网」xxfb.mwr.cn（全国 ~2000 站，每日 8 时一期）
// mapSearch 接口明文 JSON（网页渲染层的字体加密挡不住后端接口），经纬度为双重 Base64
// 只收 stType=river 的站（水库 z 为空需逐站查详情，成本高先不做）；
// 浙闽+太湖流域剔除（10 号源小时级更优）；无官方站码，用稳定 idNo 造伪码 mwr_ 前缀
const MWR_API = 'http://xxfb.mwr.cn/hydroSearch/mapSearch';
// 12 号源：山东省水文中心「实时雨水情」openapi（约 110 站，逐小时，带真实站码+坐标+水势码）
// 覆盖海河流域漳卫系（卫运河/漳卫新河/马颊河/徒骇河）+ 淮河沂沭泗（沂河/沭河/泗河/南四湖）+ 大汶河/东平湖
const SD_API = 'http://60.216.119.102:10086/sd-ww-api/openapi/water_info';

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

/** 站名 → 稳定伪站码（zj_ 前缀 + djb2 哈希），沿用 mot 的做法 */
function zjId(name) {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  return 'zj_' + h.toString(16);
}

/** 交通部「珠江水情信息」：列表页第一篇即最新 → 正文表格 td 为 站名/时间/水位/流量 四列一组（内嵌 span，需剥标签） */
async function fetchZhujiang() {
  const listHtml = await fetchText(ZJ_LIST, 25000);
  const link = listHtml.match(/href="(\.\/\d{6}\/t\d+_\d+\.html)"/); // 列表按新到旧，第一篇最新
  if (!link) throw new Error('列表页没找到文章链接');
  const artUrl = new URL(link[1], ZJ_LIST).href;
  const html = await fetchText(artUrl, 25000);
  // 年月藏在文章路径 /202610/ 里；日和时在表格「10-29 08:00」里
  const ym = artUrl.match(/\/(\d{4})(\d{2})\/t\d+_\d+\.html/);
  if (!ym) throw new Error('文章路径里没有年月');
  const tds = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;|　/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const rows = [];
  for (let i = 0; i < tds.length - 3; i++) {
    const tmM = tds[i + 1].match(/^(\d{2})-(\d{2}) (\d{2}):\d{2}$/);
    if (!tmM || !/^[\d.]+$/.test(tds[i + 2]) || !/^[\d.]+$/.test(tds[i + 3])) continue;
    if (tds[i] === '站名') continue;
    const z = Number(tds[i + 2]);
    const q = Number(tds[i + 3]);
    if (!isFinite(z)) continue;
    rows.push({
      stcd: zjId(tds[i]),
      stnm: tds[i],
      rvnm: ZJ_RIVERS[tds[i]] || '珠江水系',
      z: Math.round(z * 100) / 100,
      q: Math.round(q * 100) / 100,
      tm: Date.UTC(+ym[1], +ym[2] - 1, +tmM[2], +tmM[3] - 8, 0, 0),
      w: 'unk',
      src: 'zj',
    });
  }
  if (!rows.length) throw new Error('文章里没解析到站点行');
  console.log(`[ok] zj 交通部珠江水情 ${ym[1]}-${ym[2]} · ${rows.length} 站`);
  return rows;
}

/** 松辽委实时水情：明文 JSON，报汛时间「30日08时」按北京时解析（跨月自动归上个月） */
async function fetchSongliao() {
  const json = JSON.parse(await fetchText(SL_API, 25000));
  const arr = Array.isArray(json.data) ? json.data : [];
  const bj = new Date(Date.now() + 8 * 3600e3);
  const y = bj.getUTCFullYear(), mo = bj.getUTCMonth() + 1, day0 = bj.getUTCDate();
  const rows = [];
  for (const it of arr) {
    if (!it || !it.stcd || it.z == null) continue;
    const tmM = String(it.tm || '').match(/(\d{1,2})日(\d{1,2})时/);
    if (!tmM) continue;
    const day = +tmM[1], hh = +tmM[2];
    let yy = y, mm = mo;
    if (day > day0) { // 月初还挂着上月末的公告 → 归上个月
      mm -= 1;
      if (mm === 0) { mm = 12; yy -= 1; }
    }
    const z = Number(it.z), q = Number(it.q);
    if (!isFinite(z)) continue;
    rows.push({
      stcd: String(it.stcd),
      stnm: String(it.stnm || it.stcd),
      rvnm: SL_RIVERS[it.stnm] || '松辽流域',
      z: Math.round(z * 100) / 100,
      q: isFinite(q) ? Math.round(q * 100) / 100 : 0,
      tm: Date.UTC(yy, mm - 1, day, hh - 8, 0, 0),
      w: trendOf(String(it.wptn)),
      src: 'sl',
    });
  }
  if (!rows.length) throw new Error('接口没解析到站点');
  console.log(`[ok] sl 松辽委水情 ${rows.length} 站`);
  return rows;
}

async function fetchPost(url, body, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const isJson = typeof body === 'string' && body.trim().startsWith('{');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded',
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 北京时「YYYY-MM-DD HH」字符串（太湖局接口的 stime 参数） */
function bjHourStr(offsetH = 0) {
  const d = new Date(Date.now() + (8 + offsetH) * 3600e3);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}`;
}

/** 太湖局接口：POST 表单 stime+sbsnm（TH 太湖流域 / ZM 浙闽片），收 河道/潮位/闸坝 且 z 非空的站 */
async function fetchTaihu() {
  const rows = [];
  const sttpKeep = new Set(['河道', '潮位', '闸坝']);
  const parseTm = (s) => {
    const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2}) (\d{2})/);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, 0, 0) : 0;
  };
  for (const sbsnm of ['TH', 'ZM']) {
    let arr = [];
    // 报汛是逐站滚动的：当前整点只有几十站出数，上一整点才齐全——默认问上一整点
    for (const off of [-1, 0]) {
      try {
        const txt = await fetchPost(TBA_BASE, `stime=${encodeURIComponent(bjHourStr(off))}&sbsnm=${sbsnm}`);
        const j = JSON.parse(txt);
        arr = (j.data || []).filter((s) => s && s.z != null && sttpKeep.has(s.sttp) && s.lgtd && s.lttd);
        if (arr.length > 50) break;
      } catch (e) {
        if (off === 0) throw e;
      }
    }
    for (const s of arr) {
      const q = Number(s.q);
      rows.push({
        stcd: String(s.stcd),
        stnm: String(s.stnm || s.stcd),
        rvnm: String(s.dyrn || s.hnnm || s.bsnm || '太湖流域'),
        z: Math.round(Number(s.z) * 100) / 100,
        q: isFinite(q) && q > 0 ? Math.round(q * 100) / 100 : 0,
        tm: parseTm(s.tm),
        w: 'unk',
        src: 'tba',
        wrz: s.wrz != null && isFinite(Number(s.wrz)) && Number(s.wrz) > 0 ? Number(s.wrz) : null,
        lgtd: Math.round(Number(s.lgtd) * 1e5) / 1e5,
        lttd: Math.round(Number(s.lttd) * 1e5) / 1e5,
      });
    }
  }
  // 同站码去重（TH 与 ZM 不重叠，但防接口重复回包）
  const by = new Map(rows.map((r) => [r.stcd, r]));
  if (!by.size) throw new Error('两个片区都没抓到站');
  console.log(`[ok] tba 太湖局水文（太湖流域+浙闽片）${by.size} 站`);
  return [...by.values()];
}

/** 山东省水文中心 openapi：warnList+normalList 全收，z 非空且带坐标 */
async function fetchShandong() {
  const txt = await fetchText(SD_API, 25000);
  const j = JSON.parse(txt);
  const arr = [...((j.data && j.data.warnList) || []), ...((j.data && j.data.normalList) || [])];
  const rows = [];
  for (const s of arr) {
    if (!s || !s.stcd || s.z == null || !s.lgtd || !s.lttd) continue;
    const m = String(s.tmFull || '').match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
    const q = Number(s.q);
    rows.push({
      stcd: String(s.stcd),
      stnm: String(s.stnm || s.stcd),
      rvnm: String(s.rvnm || '山东'),
      z: Math.round(Number(s.z) * 100) / 100,
      q: isFinite(q) && q > 0 ? Math.round(q * 100) / 100 : 0,
      tm: m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], 0) : 0,
      w: trendOf(String(s.wptn)),
      src: 'sd',
      lgtd: Math.round(Number(s.lgtd) * 1e5) / 1e5,
      lttd: Math.round(Number(s.lttd) * 1e5) / 1e5,
    });
  }
  if (!rows.length) throw new Error('接口没解析到站点');
  console.log(`[ok] sd 山东省水文中心 ${rows.length} 站`);
  return rows;
}

/** 水利部 xxfb mapSearch：全国河站（stType=river）每日 8 时；坐标双重 Base64，浙闽/太湖剔除（10 号源小时级更优） */
async function fetchMwr() {
  const txt = await fetchPost(MWR_API, '{}', 30000);
  const j = JSON.parse(txt);
  const arr = (j.result || []).filter((r) => r && r.stType === 'river' && r.z != null && r.lgtd && r.lttd);
  const dec = (s) => {
    try {
      return Number(Buffer.from(Buffer.from(String(s), 'base64').toString('utf8'), 'base64').toString('utf8'));
    } catch (e) {
      return NaN;
    }
  };
  const rows = [];
  for (const r of arr) {
    if (r.addvnm === '浙江' || r.addvnm === '福建' || /太湖/.test(r.bsnm || '')) continue;
    const lgtd = dec(r.lgtd), lttd = dec(r.lttd);
    if (!isFinite(lgtd) || !isFinite(lttd)) continue;
    const m = String(r.tm || '').match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
    rows.push({
      stcd: 'mwr_' + r.idNo,
      stnm: String(r.stnm || ''),
      rvnm: String(r.rvnm || r.bsnm || '未知河流'),
      z: Math.round(Number(r.z) * 100) / 100,
      q: 0,
      tm: m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], 0) : 0,
      w: 'unk',
      src: 'mwr',
      lgtd: Math.round(lgtd * 1e5) / 1e5,
      lttd: Math.round(lttd * 1e5) / 1e5,
    });
  }
  if (!rows.length) throw new Error('接口没解析到站点');
  console.log(`[ok] mwr 水利部全国水雨情 ${rows.length} 站（浙闽/太湖已剔除）`);
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

  // 8 号源：交通部珠江水情公告（独立容错；珠江流域首批站，全部为新增）
  try {
    const zj = await fetchZhujiang();
    for (const r of zj) byStcd.set(r.stcd, r);
    sources.zj = `ok ${zj.length}站`;
  } catch (e) {
    sources.zj = 'fail ' + String(e.message || e).slice(0, 40);
    console.log('[fail] zj →', e.message);
  }

  // 9 号源：松辽委水情（独立容错；松花江/嫩江/辽河首批站，全部为新增）
  try {
    const sl = await fetchSongliao();
    for (const r of sl) byStcd.set(r.stcd, r);
    sources.sl = `ok ${sl.length}站`;
  } catch (e) {
    sources.sl = 'fail ' + String(e.message || e).slice(0, 40);
    console.log('[fail] sl →', e.message);
  }

  // 10 号源：太湖局（独立容错；真实站码，与长江委重码站保留 tm 较新者）
  try {
    const tba = await fetchTaihu();
    let added = 0;
    for (const r of tba) {
      const prev = byStcd.get(r.stcd);
      if (!prev || r.tm >= prev.tm) { byStcd.set(r.stcd, r); added++; }
    }
    sources.tba = `ok ${added}/${tba.length}站`;
  } catch (e) {
    sources.tba = 'fail ' + String(e.message || e).slice(0, 40);
    console.log('[fail] tba →', e.message);
  }

  // 12 号源：山东省水文中心（独立容错；真实站码，同码保留较新者）
  try {
    const sd = await fetchShandong();
    let added = 0;
    for (const r of sd) {
      const prev = byStcd.get(r.stcd);
      if (!prev || r.tm >= prev.tm) { byStcd.set(r.stcd, r); added++; }
    }
    sources.sd = `ok ${added}/${sd.length}站`;
  } catch (e) {
    sources.sd = 'fail ' + String(e.message || e).slice(0, 40);
    console.log('[fail] sd →', e.message);
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

  // 11 号源：水利部全国水雨情（最后合入；伪码 mwr_ 不会撞站码，但站名去重必须做——
  // 哈尔滨/梧州（四）/寸滩等站在松辽/珠江/长江委源里已有更优版本（小时级/带水势码））
  try {
    const mwr = await fetchMwr();
    const norm = (n) => String(n).replace(/[(（].*$/, '').trim();
    const names = new Set();
    for (const r of byStcd.values()) names.add(norm(r.stnm));
    let added = 0;
    for (const r of mwr) {
      if (names.has(norm(r.stnm))) continue;
      byStcd.set(r.stcd, r);
      names.add(norm(r.stnm));
      added++;
    }
    sources.mwr = `ok ${added}/${mwr.length}站`;
    console.log(`     mwr 去重后新增 ${added} 站（其余与既有源重名跳过）`);
  } catch (e) {
    sources.mwr = 'fail ' + String(e.message || e).slice(0, 40);
    console.log('[fail] mwr →', e.message);
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
    // 去重 + 只留近 26h + 降采样到 ≤10 点（小时级源上千站，全量走势会把文件撑爆；10 点算 24h 变幅够用）
    const seen = new Set();
    h = h
      .filter(([t]) => t >= now - 26 * 3600e3 && !seen.has(t) && seen.add(t))
      .sort((a, b) => a[0] - b[0]);
    if (h.length > 10) {
      const step = (h.length - 1) / 9;
      h = Array.from({ length: 10 }, (_, i) => h[Math.round(i * step)]);
    }
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
      ...(r.lgtd != null ? { lgtd: r.lgtd, lttd: r.lttd } : {}),
      ...(r.wrz != null ? { wrz: r.wrz } : {}),
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
  if (size > 700) console.log('::warning::文件超 700KB，真机加载变慢——考虑收紧采集范围或走势降采样更狠');
}

main();
