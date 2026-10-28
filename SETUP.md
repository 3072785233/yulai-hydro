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
| 加/改抓取源 | 改 `fetch.js` 里的 `SOURCES`（站码 stcd 全流域唯一，自动去重） |
| 某个源挂了 | 不用管，`sources` 里标 fail，其余源照常；全挂了 Actions 会红牌提醒 |
| 换抓取频率 | 改 `.github/workflows/hydro.yml` 里的 `cron` |
| Gitee 同步失败 | 检查三个 secrets（GITEE_USER/GITEE_TOKEN/GITEE_REPO）是否还有效，令牌过期去 Gitee 重新生成并更新 GitHub 仓库 Settings → Secrets |

数据来源为水利部门公开报汛页面，仅供个人参考，不构成防汛建议。
