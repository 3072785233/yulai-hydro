// Gitee 镜像 API 兜底：git 推送被 Gitee 拦（数据中心 IP 偶发被拒）时，改走 API v5 直接更新数据文件
// 令牌从环境变量来（GitHub Actions Secrets 注入），绝不写进仓库
// 用法：GITEE_TOKEN=xx GITEE_USER=xx GITEE_REPO=user/repo node mirror-gitee.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { GITEE_TOKEN: TOKEN, GITEE_USER: USER, GITEE_REPO: REPO } = process.env;
if (!TOKEN || !USER || !REPO) {
  console.log('缺 Gitee 环境变量，跳过 API 镜像');
  process.exit(0);
}

// 本地文件的 git blob sha（与远端 content.sha 对得上说明没变，跳过不产生空提交）
const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

(async () => {
  let failed = 0;
  for (const file of ['data/hydro.json', 'data/tides.json']) {
    try {
      const local = fs.readFileSync(path.join(__dirname, file));
      const api = `https://gitee.com/api/v5/repos/${REPO}/contents/${file}`;
      const cur = await fetch(`${api}?ref=master&access_token=${TOKEN}`).then((r) => r.json());
      const remoteSha = cur && cur.sha && !cur.message ? cur.sha : null; // 404（文件还没有）= 新建
      if (remoteSha === blobSha(local)) {
        console.log(`[skip] ${file} 远端已是最新`);
        continue;
      }
      const body = {
        access_token: TOKEN,
        content: local.toString('base64'),
        branch: 'master',
        message: `${file} 镜像更新(API兜底) ${new Date().toISOString()}`,
      };
      if (remoteSha) body.sha = remoteSha;
      const put = await fetch(`${api}?access_token=${TOKEN}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (!put || !put.content) throw new Error('API 更新失败: ' + JSON.stringify(put).slice(0, 150));
      console.log(`[ok] Gitee API 镜像成功 ${file} ${(put.content.sha || '').slice(0, 8)}`);
    } catch (e) {
      failed++;
      console.error(`[fail] mirror-gitee ${file} →`, e.message);
    }
  }
  if (failed) process.exit(1);
})();
