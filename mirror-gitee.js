// Gitee 镜像 API 兜底：git 推送被 Gitee 拦（数据中心 IP 偶发被拒）时，改走 API v5 直接更新数据文件
// 令牌从环境变量来（GitHub Actions Secrets 注入），绝不写进仓库
// 用法：GITEE_TOKEN=xx GITEE_USER=xx GITEE_REPO=user/repo node mirror-gitee.js
const fs = require('fs');
const path = require('path');

const { GITEE_TOKEN: TOKEN, GITEE_USER: USER, GITEE_REPO: REPO } = process.env;
if (!TOKEN || !USER || !REPO) {
  console.log('缺 Gitee 环境变量，跳过 API 镜像');
  process.exit(0);
}
const API = `https://gitee.com/api/v5/repos/${REPO}/contents/data/hydro.json`;

(async () => {
  const cur = await fetch(`${API}?ref=master&access_token=${TOKEN}`).then((r) => r.json());
  if (!cur || !cur.sha) throw new Error('拿远端 sha 失败: ' + JSON.stringify(cur).slice(0, 120));
  const buf = fs.readFileSync(path.join(__dirname, 'data', 'hydro.json'));
  const put = await fetch(`${API}?access_token=${TOKEN}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: TOKEN,
      content: buf.toString('base64'),
      sha: cur.sha,
      branch: 'master',
      message: `hydro 镜像更新(API兜底) ${new Date().toISOString()}`,
    }),
  }).then((r) => r.json());
  if (!put || !put.content) throw new Error('API 更新失败: ' + JSON.stringify(put).slice(0, 150));
  console.log(`[ok] Gitee API 镜像成功 ${(put.content.sha || '').slice(0, 8)}`);
})().catch((e) => {
  console.error('[fail] mirror-gitee →', e.message);
  process.exit(1);
});
