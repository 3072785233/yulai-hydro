# 水情数据仓部署与维护

> 部署由 Claude 代办，你只需要配合两次授权（下述第 1、2 步）。
> 全部功能保留：GitHub 主仓（Actions 每小时抓）→ Gitee 镜像（国内快、正式版白名单）→ jsDelivr 备用。

## 你要配合的两步

**第 1 步 · GitHub 授权（1 分钟）**
Claude 发起登录后，记下终端里显示的 **8 位一次性代码**（形如 `XXXX-XXXX`），浏览器打开
[github.com/login/device](https://github.com/login/device) → 输入代码 → 授权。

**第 2 步 · Gitee 令牌（2 分钟，正式版发布前做也行）**
1. 注册/登录 [gitee.com](https://gitee.com)（手机号即可）
2. 头像 → 设置 → 安全设置 → **私人令牌** → 生成新令牌（权限只勾 **projects**）→ 复制
3. 把 **Gitee 用户名 + 令牌** 发给 Claude，剩下的（建仓、配密钥、验证）全部自动完成

## 架构（配好后的样子）

```
长江水文网 5 页（HTTP，每小时报汛）
   │  GitHub Actions（每小时 :11 抓取，fetch.js）
   ▼
github.com/<你>/yulai-hydro ──自动强推──▶ gitee.com/<你>/yulai-hydro（master）
   │                                        │
   ▼ jsDelivr CDN（备用，自动刷新缓存）      ▼ Gitee raw（主用，国内快、域名可加微信白名单）
   └──────────────► 小程序 utils/hydro.js ◄──┘
```

## 维护手册（以后要动的时候看）

| 想做什么 | 怎么做 |
|---|---|
| 手动立刻刷新数据 | GitHub 仓库 → Actions → hydro → Run workflow |
| 看数据新不新 | 打开 `https://gitee.com/<你>/yulai-hydro/raw/master/data/hydro.json`，看 `updated` 字段和 `sources` |
| 加/改抓取源 | 改 `fetch.js` 里的 `SOURCES`（站码 stcd 全流域唯一，自动去重）；另有 6 号源 `fetchMot()`（交通运输部每日长江水位表，8/16 时各一期，站对象标 `src:'mot'`、伪站码 `mot_*`，与长江委重名站自动跳过，水位为当地航行基准面非绝对高程）、7 号源 `fetchHubei()`（湖北省水情平台 45 站单站页，`src:'hb'`、逐小时实测，全国统一站码与长江委自动去重；该平台走 http、并发>3 会甩 413，短时被封也不怕——断源 48h 内的站会沿用上轮读数保留在数据里）、8 号源 `fetchZhujiang()`（交通部珠江水情公告，`src:'zj'`、伪站码 `zj_*`，部分站当地基面）、9 号源 `fetchSongliao()`（松辽委明文 JSON 接口，`src:'sl'`，松花江/嫩江/辽河/浑河 6 站，各站当地冻结基面；报汛时间「30日08时」按北京时解析、跨月自动归上个月）、10 号源 `fetchTaihu()`（太湖局后端接口，`src:'tba'`，太湖流域+浙闽片 792 站小时级，只收河道/潮位/闸坝站，坐标随数据下发；**必须问上一整点**——当前整点只有几十站出数）、11 号源 `fetchMwr()`（水利部 xxfb.mwr.cn 全国平台，`src:'mwr'`、伪码 `mwr_+idNo`，每日 8 时 ~1120 站，浙闽/太湖剔除，与既有源站名去重）、12 号源 `fetchShandong()`（山东省水文中心 openapi，`src:'sd'`，118 站小时级带真实站码）、13 号源 `fetchCjhdj()`（长江航道局水位公告，`src:'hdj'`、伪码 `hdj_*`，每日 8/16 时两期，流量行按 z>200 滤掉）、14 号源 `fetchHunan()`（湖南省水文中心「一张图」，`src:'hn'`、全国统一老站码 217 站逐小时；**坑：站表 list 接口里的值是登记旧值，真实时逐时线要逐站 POST process 接口**）。另有**潮汐表** `fetchTides()`：chaoxibiao.net 102 精选港 → `data/tides.json`（每日一更，同日跳过）。全国约 2200 站后 `data/hydro.json` 约 430KB：走势数组已降采样到每站 ≤10 点（24h 变幅不受影响），文件超 700KB 时 Actions 会黄牌提醒 |
| 某个源挂了 | 不用管，`sources` 里标 fail，其余源照常；全挂了 Actions 会红牌提醒 |
| 换抓取频率 | 改 `.github/workflows/hydro.yml` 里的 `cron` |
| Gitee 同步失败 | 工作流自带双通道：git 推送被拒会自动降级 API 直写（`mirror-gitee.js` 双文件 hydro+tides，blob sha 相同跳过、远端没有该文件走新建；令牌走 Secrets 不入库）；两条都挂才检查 secrets 是否过期，去 Gitee 重新生成并更新 GitHub 仓库 Settings → Secrets |
| 潮汐数据没更新 | 看 Actions 日志 `[ok] tides` / `[skip] tides` 行：同日只抓一次是设计（潮汐一天一更）；换日还失败才会 `[fail] tides`。港口清单/坐标改 `fetch.js` 里的 `TIDE_PORTS` |

数据来源为水利部门公开报汛页面，仅供个人参考，不构成防汛建议。
