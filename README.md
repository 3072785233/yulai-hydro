# yulai-hydro · 鱼来水情数据仓

长江流域 **~108 个水文站**的实时水位/流量/涨落，每小时自动从长江水利委员会水文局官网（[长江水文网](http://www.cjh.com.cn)）抓取，合成一个静态 JSON 供「鱼来」小程序拉取。

- 抓取器：`fetch.js`（零依赖 Node，5 个页面：干流/上游局/中游局/下游局/汉江局）
- 自动任务：`.github/workflows/hydro.yml`（GitHub Actions 每小时，commit 回本仓 + 强推 Gitee 镜像）
- 产物：`data/hydro.json` —— `stations[]`（站码/站名/河名/水位z/流量q/水势w/时间tm/24h变幅d24/近24h走势h）

**首次部署看 [SETUP.md](SETUP.md)。**

数据来源为水利部门公开报汛页面，仅供个人参考，不构成防汛建议。
