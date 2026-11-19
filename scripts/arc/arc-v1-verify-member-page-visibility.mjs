/**
 * A6 收口 · 第 1 项取证（决定性）：member 角色在浏览器里的真实行为
 *
 * 为什么必须真机测：DEV-222 的教训是"页面能开、标题在、正文全空、不报错无红请求"，
 *   纯 API 断言（403）无法区分"打不开"与"打开了但空"。
 *
 * 用法：SMOKE_ADMIN_PASSWORD=... node .tmp-verify/a6/probe-member-browser.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { launchCdp, sleep } = await import('../../scripts/verify-store-ui-primary-action.mjs');
const BASE = process.env.SVC_UAT_BASE || 'http://127.0.0.1:13001';
const PAGE_UID = 'n5c25yq5qlt';
const PAGE_TITLE = '档案移动测试';
// 🔴 R1-READY（2026-11-11）密钥审计修正：口令只从环境变量读（见 arc-v1-rebuild-accounts.mjs 同处说明）。
const PW = process.env.ARC_ACCOUNT_PASSWORD;
if (!PW) {
  throw new Error('缺少 ARC_ACCOUNT_PASSWORD（本脚本刻意只读环境变量，不读凭据文件、不写默认口令）');
}
const uuid = () => crypto.randomUUID();

async function signIn(account, password) {
  const r = await fetch(BASE + '/api/auth:signIn', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': uuid() },
    body: JSON.stringify({ account, password }),
  });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, token: j && j.data && j.data.token };
}
async function api(token, p, opt) {
  opt = opt || {};
  const r = await fetch(BASE + p, {
    method: opt.method || 'GET',
    headers: Object.assign({
      'Content-Type': 'application/json',
      'X-Data-Source': 'main', 'X-Request-Id': uuid(),
    }, token ? { Authorization: 'Bearer ' + token } : {}, opt.role ? { 'X-Role': opt.role } : {}),
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t.slice(0, 160) };
}

const out = [];
const rec = function (id, desc, detail) { out.push({ id: id, desc: desc, detail: detail }); console.log('[' + id + '] ' + desc + '\n     ' + detail); };

const root = await signIn('admin@nocobase.com', process.env.SMOKE_ADMIN_PASSWORD);
if (!root.token) { console.log('root 登录失败'); process.exit(1); }

const email = 'probe.member.b.' + Date.now() + '@svc.local';
const mk = await api(root.token, '/api/users:create', { method: 'POST', body: { email: email, password: PW, nickname: 'probe-member-b' } });
const uid = mk.json && mk.json.data && mk.json.data.id;
rec('M1', '建纯 member 探测账号', 'status=' + mk.status + ' id=' + (uid || '-'));
if (!uid) { console.log(JSON.stringify(out, null, 2)); process.exit(1); }

const ru = await api(root.token, '/api/rolesUsers:list?filter=' + encodeURIComponent(JSON.stringify({ userId: uid })));
const roles = (ru.json && ru.json.data || []).map(function (x) { return x.roleName; });
rec('M1b', '该账号的角色集合', 'roles=' + (roles.join(',') || '(空)') + '（应为 member）');

const s = await signIn(email, PW);
rec('M2', '纯 member 账号登录', 'status=' + s.status + ' hasToken=' + !!s.token);
const tk = s.token;
const rc = await api(tk, '/api/roles:check');
rec('M2b', '会话角色', 'status=' + rc.status + ' role=' + (rc.json && rc.json.data && rc.json.data.role || '?') + ' strategy=' + JSON.stringify(rc.json && rc.json.data && rc.json.data.strategy || null));

let browser = null;
try {
  browser = await launchCdp({ label: 'member-probe' });
  const cdp = browser.cdp;
  const netResp = [];
  cdp.on('Network.responseReceived', function (p) { try { netResp.push({ url: p.response && p.response.url || '', s: p.response && p.response.status }); } catch (e) {} });

  await cdp.send('Page.navigate', { url: BASE + '/signin' });
  await sleep(2500);
  const loginExpr = `(async () => {
    const r = await fetch('/api/auth:signIn', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ account: ${JSON.stringify(email)}, password: ${JSON.stringify(PW)} }) });
    const j = await r.json();
    localStorage.setItem('NOCOBASE_TOKEN', (j && j.data && j.data.token) || '');
    localStorage.setItem('NOCOBASE_ROLE', 'member');
    return (j && j.data && j.data.token) ? 'ok' : 'fail';
  })()`;
  const lg = await cdp.evaluate(loginExpr);
  rec('M3', '浏览器内登录（置 token + 角色）', 'result=' + lg);
  netResp.length = 0;

  await cdp.send('Page.navigate', { url: BASE + '/v/mobile' });
  await sleep(5000);
  const p1 = await cdp.evaluate(`(() => {
    const rt = document.querySelector('#root') || document.body;
    const x = (rt.innerText || '').replace(/\\s+/g,' ').trim();
    return { path: location.pathname, len: x.length, txt: x.slice(0, 220), hasErr: /No permissions|加载失败|错误/.test(x) };
  })()`);
  rec('M3b', '打开 /v/mobile', 'path=' + (p1 && p1.path) + ' len=' + (p1 && p1.len) + ' 含错误文案=' + (p1 && p1.hasErr) + '\n     正文：' + (p1 && p1.txt));
  const rel = netResp.filter(function (r) { return /desktopRoutes|flowModels|flowSurfaces|serviceArchives/.test(r.url); });
  rec('M3c', '该页对页面配置的请求状态', rel.length ? rel.map(function (r) { return r.s + ' ' + (r.url.split('/api/')[1] || '').split('?')[0]; }).slice(0, 8).join(' | ') : '（无相关请求）');
  const denied = netResp.filter(function (r) { return r.s === 403 && /desktopRoutes|flowModels|serviceArchives|flowSurfaces/.test(r.url); });
  rec('M3d', '403 计数（页面配置/业务集合）', 'count=' + denied.length + (denied.length ? ' 例：' + denied.slice(0, 3).map(function (r) { return (r.url.split('/api/')[1] || '').split('?')[0]; }).join(',') : ''));

  netResp.length = 0;
  await cdp.send('Page.navigate', { url: BASE + '/v/mobile/' + PAGE_UID });
  await sleep(6000);
  const p2 = await cdp.evaluate(`(() => {
    const rt = document.querySelector('#root') || document.body;
    const x = (rt.innerText || '').replace(/\\s+/g,' ').trim();
    return { path: location.pathname, len: x.length,
      hasTitle: x.indexOf(${JSON.stringify(PAGE_TITLE)}) >= 0,
      notFound: /404|页面不存在/.test(x), emptyMobile: /暂无移动端页面/.test(x),
      noPerm: /No permissions|权限/.test(x), txt: x.slice(0, 260) };
  })()`);
  const rendered = p2 && p2.hasTitle && !p2.notFound && !p2.emptyMobile;
  rec('M4', '打开 ARC 移动页（DEV-222 判据）',
    'path=' + (p2 && p2.path) + ' len=' + (p2 && p2.len) + ' 渲染标题=' + (p2 && p2.hasTitle) + ' 404=' + (p2 && p2.notFound) + ' 空页=' + (p2 && p2.emptyMobile) + ' 权限文案=' + (p2 && p2.noPerm) +
    '\n     ⇒ 结论：' + (rendered ? '页面渲染成功（member 能看到该页）' : '页面未渲染（member 打不开该页）') +
    '\n     正文：' + (p2 && p2.txt));
  const rel2 = netResp.filter(function (r) { return /desktopRoutes|flowModels|flowSurfaces|serviceArchives/.test(r.url); });
  rec('M4b', 'ARC 页请求状态', rel2.length ? rel2.map(function (r) { return r.s + ' ' + (r.url.split('/api/')[1] || '').split('?')[0]; }).slice(0, 8).join(' | ') : '（无相关请求）');

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(shot.data, 'base64');
  const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const f = 'C:/Users/Administrator/WorkBuddy/2026-09-20-15-28-58/.tmp-verify/a6/member-arc-page-' + Date.now() + '.png';
  fs.writeFileSync(f, buf);
  rec('M4c', '截图存证', 'bytes=' + buf.length + ' sha256=' + sha + ' file=' + f.split('/').pop());
} catch (e) {
  rec('E1', '浏览器实测异常', String(e && e.message || e).slice(0, 300));
} finally {
  try { if (browser) browser.close(); } catch (e) {}
}

try {
  const del = await api(root.token, '/api/users:destroy?filterByTk=' + uid, { method: 'POST' });
  rec('Z1', '清理探测账号', 'status=' + del.status);
} catch (e) { rec('Z1', '清理探测账号异常', String(e).slice(0, 160)); }

console.log('\n=== JSON ===');
console.log(JSON.stringify(out, null, 2));
