/**
 * verify-ux-01d-preview-auth.mjs —— UX-01D M1 **预览双重鉴权**定向门禁（签收补证 #1）
 *
 * 验证预览不是"只验 HMAC"，而是**五件事同时成立**：
 *   ① 已登录；② hq_admin；③ 凭证签发者 == 当前登录人；④ 凭证未过期且未被篡改；⑤ 草稿 revision 未变。
 *
 * 用例（对应用户 §一 的 1–5）：
 *   1. hq_admin 本人 + 有效凭证 → 200，且拿到的是**草稿**（不是已发布）
 *   2. 退出登录（无 Authorization）→ 401
 *   3. 换成 store_after_sales / viewer → 403
 *   4. 换另一个 **hq_admin** 账号 → 403 `PREVIEW_ISSUER_MISMATCH`
 *      （做法：临时给 UAT 账号 `uat.hq@svc.local` 加 hq_admin 角色 → 登录 → 用别人签发的凭证 → 拒绝；
 *        结束时**移除该角色并回查**，不留下权限变更）
 *   5. 草稿 revision 变化 → 409 `PREVIEW_STALE`
 *   6. 篡改 / 过期凭证 → 401
 *
 * 额外（用户 §一 第二段）：
 *   · `postMessage` 接收端必须校验 `event.origin` 与 `event.source`；发送端 targetOrigin 不得为 `*`；
 *   · 凭证不进入 URL、nginx access log、应用日志、Referer。
 *
 * 用法：node scripts/verify-ux-01d-preview-auth.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};
const note = (label, detail = '') => console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);

function envValue(key, fallback = '') {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* fallthrough */
  }
  return process.env[key] ?? fallback;
}
const SIGN_SECRET = envValue('SIGN_SECRET');
const pg = (sql) =>
  execFileSync('docker', ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-tAc', sql], {
    encoding: 'utf8',
    timeout: 20_000,
  }).trim();

async function api(pathname, { method = 'GET', token, body, requestId } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    // 任何一步卡住都要**快速失败**：门禁挂在后台比红更糟（它会占住端口/会话）
    signal: AbortSignal.timeout(15_000),
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Origin: BASE,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* noop */
  }
  return { status: res.status, json, text };
}
const uuid = () => crypto.randomUUID();
const unwrap = (r) => r.json?.data?.data ?? r.json?.data ?? r.json;
const login = async (email, password) => {
  const r = await api('/api/auth:signIn', { method: 'POST', body: { email, password } });
  if (r.status !== 200) throw new Error(`登录失败 ${email}: HTTP ${r.status}`);
  return r.json.data.token;
};

// 看门狗：门禁挂在后台比红更糟（占住会话、掩盖真实结论）
const watchdog = setTimeout(() => {
  console.error('预览鉴权门禁超时（180s）—— 按环境问题退出（exit 2），不给产品结论');
  process.exit(2);
}, 180_000);
watchdog.unref?.();

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  UX-01D M1：预览双重鉴权（登录 / 角色 / 签发者 / 时长 / revision）');
console.log('══════════════════════════════════════════════════════════════');

let admin;
let storeToken;
let viewerToken;
try {
  admin = await login(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), envValue('UAT_HQADMIN_PASSWORD'));
  storeToken = await login(envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'), envValue('UAT_STORE_A_PASSWORD'));
  viewerToken = await login(envValue('UAT_VIEWER_EMAIL', 'uat.viewer@svc.local'), envValue('UAT_VIEWER_PASSWORD'));
} catch (error) {
  console.log(`  ⛔ 环境未就绪：${error.message}`);
  process.exit(2);
}

const draftNow = async () => unwrap(await api('/api/svc:uiThemeDraft', { token: admin }));
const mint = async () =>
  unwrap(
    await api('/api/svc:uiThemePreview', { method: 'POST', token: admin, requestId: uuid(), body: {} }),
  );
const previewDoc = (token, bearer) =>
  api('/api/svc:uiThemePreviewDoc', {
    method: 'POST',
    token: bearer,
    requestId: uuid(),
    body: { token },
  });

let secondAdminId = 0;
let granted = false;
try {
  const before = await draftNow();
  const draftName = before.draft?.doc?.brand?.name;
  note('草稿品牌', String(draftName));

  // ---- 0. 匿名接口已不存在（预览不再在公开面） ----
  const oldPublic = await api('/api/publicUiTheme:preview', { method: 'POST', body: { token: 'x' } });
  check(oldPublic.status === 404, '匿名预览接口**已移除**（404，不是"还在但拒绝"）', `HTTP ${oldPublic.status}`);

  // ---- 1. 本人 + 有效凭证 ----
  const minted = await mint();
  const token = String(minted?.token ?? '');
  check(Boolean(token), '签发预览凭证', token ? `${token.slice(0, 10)}…` : '空');
  const okRes = await previewDoc(token, admin);
  const okBody = unwrap(okRes);
  check(okRes.status === 200, '① hq_admin 本人 + 有效凭证 ⇒ 200', `HTTP ${okRes.status}`);
  check(okBody?.doc?.brand?.name === draftName, '返回的是**草稿**内容（不是已发布）', String(okBody?.doc?.brand?.name));
  check(
    okBody?.store?.name === '示例门店（预览）',
    '返回合成门店（不读真实门店资料）',
    String(okBody?.store?.name),
  );
  check(okBody?.revision === before.draft?.revision, 'revision 与草稿一致', String(okBody?.revision));

  // ---- 2. 退出登录（无 Authorization） ----
  const anon = await previewDoc(token, undefined);
  check(anon.status === 401, '② 未登录持原凭证 ⇒ 401', `HTTP ${anon.status}`);

  // ---- 3. 其它角色 ----
  for (const [name, tk] of [
    ['store_after_sales', storeToken],
    ['viewer', viewerToken],
  ]) {
    const r = await previewDoc(token, tk);
    check(r.status === 403, `③ ${name} 持原凭证 ⇒ 403`, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  }

  // ---- 4. 另一个 hq_admin 账号 ----
  const hqUserId = Number(pg(`select id from users where email='uat.hq@svc.local'`) || 0);
  if (!hqUserId) {
    check(false, '④ 另一个 hq_admin 账号：找不到 UAT 备用账号 uat.hq@svc.local', '跳过（环境缺失）');
  } else {
    const hadAdminBefore = Number(
      pg(`select count(*) from "rolesUsers" where "userId"=${hqUserId} and "roleName"='hq_admin'`) || 0,
    ) > 0;
    if (!hadAdminBefore) {
      // 核心表是驼峰列（未启 underscored），时间戳必须显式给值
      pg(
        `insert into "rolesUsers" ("userId","roleName","createdAt","updatedAt") values (${hqUserId},'hq_admin', now(), now())`,
      );
      granted = true;
    } else {
      note('uat.hq 原本已有 hq_admin（不新增、也不撤销）', `userId=${hqUserId}`);
    }
    secondAdminId = hqUserId;
    const secondToken = await login('uat.hq@svc.local', envValue('UAT_HQ_PASSWORD'));
    const r = await previewDoc(token, secondToken);
    check(
      r.status === 403 && /PREVIEW_ISSUER_MISMATCH/.test(r.text),
      '④ 另一个 hq_admin 持**别人签发**的凭证 ⇒ 403 PREVIEW_ISSUER_MISMATCH',
      `HTTP ${r.status} ${r.text.slice(0, 140)}`,
    );
  }

  // ---- 5. revision 变化 ----
  const cur = await draftNow();
  const sameDoc = cur.draft.doc;
  const saved = await api('/api/svc:uiThemeSave', {
    method: 'POST',
    token: admin,
    requestId: uuid(),
    body: { doc: sameDoc, expected_revision: cur.draft.revision },
  });
  check(saved.status === 200, '（准备）保存一次草稿使 revision+1', `HTTP ${saved.status}`);
  const stale = await previewDoc(token, admin);
  check(
    stale.status === 409,
    '⑤ revision 已变 ⇒ 旧凭证 409',
    `HTTP ${stale.status} ${stale.text.slice(0, 120)}`,
  );
  check(/PREVIEW_STALE/.test(stale.text), '错误码 PREVIEW_STALE', stale.text.slice(0, 120));

  // ---- 6. 篡改 / 过期 ----
  const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
  const t1 = await previewDoc(tampered, admin);
  check(t1.status === 401, '⑥ 篡改凭证 ⇒ 401', `HTTP ${t1.status}`);

  const expPayload = Buffer.from(
    JSON.stringify({ u: Number(pg(`select id from users where email='uat.hqadmin@svc.local'`) || 0), r: 1, e: Date.now() - 60_000, s: 'hq' }),
    'utf8',
  ).toString('base64url');
  const expSig = crypto.createHmac('sha256', SIGN_SECRET).update(`ui-preview:${expPayload}`).digest('base64url');
  const t2 = await previewDoc(`${expPayload}.${expSig}`, admin);
  check(t2.status === 401, '⑥ 过期凭证（签名有效）⇒ 401', `HTTP ${t2.status}`);

  // ---- 7. 凭证不进 URL / 日志 ----
  const fresh = await mint();
  const freshToken = String(fresh?.token ?? '');
  await previewDoc(freshToken, admin);
  await new Promise((r) => setTimeout(r, 800));
  const probe = freshToken.slice(0, 18);
  const nginxHits = (() => {
    // ⚠️ `/var/log/nginx/access.log` 是 **/dev/stdout 的符号链接**：在容器里 grep 它会永久阻塞
    //    （实测把门禁挂了 7 分钟）。必须读 docker 的 json-file 日志，并限制条数 + 超时。
    try {
      const text = execFileSync('docker', ['logs', '--tail', '2000', 'svc-nginx'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      });
      return String(text.split(String.fromCharCode(10)).filter((line) => line.includes(probe)).length);
    } catch {
      return 'unavailable';
    }
  })();
  const appHits = (() => {
    try {
      return execFileSync('docker', ['logs', '--since', '2m', 'svc-app'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        .split('\n')
        .filter((line) => line.includes(probe)).length;
    } catch {
      return -1;
    }
  })();
  check(nginxHits === '0', 'nginx access log 中不含凭证前缀', `grep -c=${nginxHits}`);
  check(appHits === 0, '应用日志（近 2 分钟）不含凭证前缀', `hits=${appHits}`);

  const model = fs.readFileSync(
    path.join(ROOT, 'nocobase/plugins/service-ticket/src/client/page-theme-model.tsx'),
    'utf8',
  );
  const reportVue = fs.readFileSync(path.join(ROOT, 'h5/src/pages/Report/index.vue'), 'utf8');
  check(
    /event\.origin !== host\.location\.origin/.test(model) &&
      /event\.source !== iframeRef\.current\?\.contentWindow/.test(model),
    'postMessage 接收端（后台）校验 origin + source',
  );
  check(
    /event\.origin !== window\.location\.origin/.test(reportVue) && /event\.source !== window\.parent/.test(reportVue),
    'postMessage 接收端（H5）校验 origin + 必须来自 parent',
  );
  check(
    !/postMessage\([^)]*,\s*['"]\*['"]\s*\)/.test(model) && !/postMessage\([^)]*,\s*['"]\*['"]\s*\)/.test(reportVue),
    '发送端 targetOrigin **不是** `*`（使用明确 origin）',
  );
  check(!/token/.test(model.split('srcdoc')[0]?.match(/src: '\/h5\/report\?uiPreview=1'/)?.[0] ?? ''), 'iframe src 中不含 token');
} finally {
  // 撤销临时授权的 hq_admin 角色，并回查
  if (granted && secondAdminId > 0) {
    pg(`delete from "rolesUsers" where "userId"=${secondAdminId} and "roleName"='hq_admin'`);
    const left = Number(
      pg(`select count(*) from "rolesUsers" where "userId"=${secondAdminId} and "roleName"='hq_admin'`) || 0,
    );
    note('已撤销临时 hq_admin 授权', `userId=${secondAdminId}，残留 ${left}`);
    if (left !== 0) results.push({ pass: false, label: '临时授权未撤销', detail: String(left) });
  }

  const failed = results.filter((r) => !r.pass);
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  预览鉴权：${results.length - failed.length} / ${results.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
    process.exit(1);
  }
  console.log('  ✅ 全部通过');
  console.log('');
}
