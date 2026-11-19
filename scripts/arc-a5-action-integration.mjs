/**
 * arc-a5-action-integration.mjs —— ARC-V1 / A5 第 5 项：移动页如何调用受控 svc: Action
 *
 * 要回答的问题：V2 移动端能不能**在不开放 serviceArchives 原生写**的前提下，
 *   调用 svc:archiveCreate / archiveUpdate / archivePhotoAttach？
 *
 * 事实基础（全部实测，不是推断）：
 *   · `svc` 是以 `type: 'single'` 注册的**全局单例资源**（plugin.ts: resourcer.define({name:'svc', type:'single'})）
 *     ⇒ 地址是 `/api/svc:<action>`，**不绑定任何 collection**
 *     ⇒ 未带 token 访问返回 401（不是 404），证明路由存在且鉴权生效
 *   · `plugin-workflow-custom-action-trigger` 已启用（applicationPlugins.enabled=true）
 *     ⇒ 提供"自定义操作事件"，可在任意 collection 的任意自定义 action 上挂工作流
 *   · `plugin-action-custom-request` 已启用 ⇒ 可发任意 HTTP 请求（含 svc:）
 *
 * 本脚本验证三件事：
 *   ① 原生写通道**必须**对业务角色关闭（否则等于绕过服务端校验）
 *   ② 受控 svc: 通道对业务角色**可用**，并且服务端校验真的会拦截（缺照片不能完工）
 *   ③ 浏览器里（真实销售会话）能直接打到 `/api/svc:archiveCreate`，即"页面按钮接得上"
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { launchCdp, sleep } from '../scripts/verify-store-ui-primary-action.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = 'https://127.0.0.1';

const credLines = fs.readFileSync('.tmp-verify/admin-credential-dev.txt', 'utf8').split(/\r?\n/);
const cred = (k) => { const l = credLines.find((x) => new RegExp('^\\s*' + k + '\\s*[:：]').test(x)); return l ? l.replace(/^\s*[A-Za-z]+\s*[:：]\s*/, '').trim() : ''; };
const ROOT = { email: cred('email') || cred('username'), password: cred('password') };
const SALES = { email: 'arc1.sales.a@svc.local', password: ARC_TEST_PW };
const MGR = { email: 'arc1.mgr.a@svc.local', password: ARC_TEST_PW };
const HQ = { email: 'uat.hqadmin@svc.local', password: (() => { const m = /^UAT_HQADMIN_PASSWORD=(.*)$/m.exec(fs.readFileSync('.env', 'utf8')); return m ? m[1].trim() : ''; })() };

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};
const section = (t) => console.log(`\n${'─'.repeat(74)}\n${t}\n${'─'.repeat(74)}`);

async function api(token, p, opt = {}) {
  const res = await fetch(BASE + p, {
    method: opt.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Request-Id': crypto.randomUUID(),
      ...(opt.headers || {}),
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}
async function signIn(a) {
  const r = await api(null, '/api/auth:signIn', { method: 'POST', body: { account: a.email, password: a.password } });
  if (!r.json?.data?.token) throw new Error(`登录失败 ${a.email}: HTTP ${r.status}`);
  return r.json.data.token;
}

console.log('='.repeat(78));
console.log('ARC-V1 / A5 · 第 5 项：移动页调用受控 svc: Action 的可行性');
console.log('='.repeat(78));

const rootTok = await signIn(ROOT);
const salesTok = await signIn(SALES);
const mgrTok = await signIn(MGR);
const hqTok = await signIn(HQ);
console.log('root / 销售A / 负责人A / hq_admin 登录完成');

// ---------------------------------------------------------------------------
section('① 原生写通道必须关闭（否则 = 绕过服务端校验）');
// ---------------------------------------------------------------------------
for (const [label, tok] of [['销售A', salesTok], ['负责人A', mgrTok]]) {
  const c = await api(tok, '/api/serviceArchives:create', {
    method: 'POST',
    body: { archive_type: 'service', store_id: 1, customer_name: '原生写试探', customer_mobile: '13900000099' },
  });
  check(c.status === 403 || c.status === 401,
    `①a ${label} 直写 serviceArchives:create 被拒`,
    `HTTP ${c.status} ${c.text.slice(0, 120)}`);

  const u = await api(tok, '/api/serviceArchives:update?filterByTk=1', { method: 'POST', body: { remark: 'x' } });
  check(u.status === 403 || u.status === 401 || u.status === 404,
    `①b ${label} 直改 serviceArchives:update 被拒`,
    `HTTP ${u.status} ${u.text.slice(0, 120)}`);

  const d = await api(tok, '/api/serviceArchives:destroy?filterByTk=1', { method: 'POST', body: {} });
  check(d.status === 403 || d.status === 401 || d.status === 404,
    `①c ${label} 直删 serviceArchives:destroy 被拒`,
    `HTTP ${d.status} ${d.text.slice(0, 120)}`);
}
// 反向对照：同一个角色通过受控 action 是能写的（否则"被拒"可能只是它什么都不能做）
const ctl = await api(salesTok, '/api/svc:archiveCreate', {
  method: 'POST',
  body: {
    archive_type: 'service', store_id: 1,
    customer_name: '受控通道对照', customer_mobile: '13900000088',
    service_address: '对照地址', service_type: 'install', product_description: '对照机型',
  },
});
check(ctl.status === 200 && !!ctl.json?.data?.archive?.id,
  '①d 反向对照：销售A 通过 svc:archiveCreate 可以创建（证明 ①a-c 是"通道被关"而非"角色无用"）',
  `HTTP ${ctl.status} id=${ctl.json?.data?.archive?.id ?? 'n/a'}`);

const ctlArchiveId = ctl.json?.data?.archive?.id;
const ctlVersion = ctl.json?.data?.archive?.version;

// ---------------------------------------------------------------------------
section('② 受控 action 的服务端校验真实生效');
// ---------------------------------------------------------------------------
// 2a 缺前后照片 → 不能完工
// ⚠️ 契约来自源码（actions/svc/archive.ts），不是猜的：
//    archiveComplete 读 `id` + `expected_version`（不是 archive_id / version）
const completeNoPhoto = await api(salesTok, '/api/svc:archiveComplete', {
  method: 'POST',
  body: { id: ctlArchiveId, expected_version: ctlVersion },
});
check(completeNoPhoto.status === 409 || completeNoPhoto.status === 400,
  '②a 缺前后照片时完工被服务端拒绝',
  `HTTP ${completeNoPhoto.status} ${completeNoPhoto.text.slice(0, 160)}`);

// 2b 编辑（带正确 version）
const upd = await api(salesTok, '/api/svc:archiveUpdate', {
  method: 'POST',
  body: { id: ctlArchiveId, expected_version: ctlVersion, notes: 'A5 集成验证备注' },
});
check(upd.status === 200, '②b 带正确 expected_version 的编辑成功', `HTTP ${upd.status} ${upd.text.slice(0, 100)}`);
const v2 = upd.json?.data?.archive?.version;

// 2c 用过期 version 编辑 → 409（乐观锁）
const updStale = await api(salesTok, '/api/svc:archiveUpdate', {
  method: 'POST',
  body: { id: ctlArchiveId, expected_version: ctlVersion, notes: '过期版本' },
});
check(updStale.status === 409, '②c 过期 expected_version 编辑被拒（乐观锁生效）',
  `HTTP ${updStale.status} ${updStale.text.slice(0, 120)}`);

// 2d 照片类型白名单
// archivePhotoAttach 是 multipart；用 JSON 打不到"类型白名单"那一层，
// 会先被 NO_FILE（422）挡下。这里如实记录它拦在哪一层，并另测"跨店绑照片"。
const badType = await api(salesTok, '/api/svc:archivePhotoAttach', {
  method: 'POST',
  body: { id: ctlArchiveId, photo_type: 'not_a_type' },
});
check(badType.status === 400 || badType.status === 422,
  '②d 非 multipart 调用被拒（拦在入口层）', `HTTP ${badType.status} ${badType.text.slice(0, 120)}`);

// 2e 跨店越权：销售A 操作 B 店（store 4）的档案
// 跨店创建（实测修正）：
//   我原以为"门店归属由 actor 绑定门店决定、body 里的 4 会被忽略"。
//   实际是**直接拒绝**（404 ARCHIVE_NOT_FOUND = "档案不存在或无权限"），
//   连落库都不会发生 —— 更严格，也更不容易被误用。
//   判据因此改成：**必须拒绝**，且同时用本店创建成功做正向对照（证明它拒绝的是"跨店"而非"一切创建"）。
const crossStore = await api(salesTok, '/api/svc:archiveCreate', {
  method: 'POST',
  body: {
    archive_type: 'service', store_id: 4,
    customer_name: '跨店试探', customer_mobile: '13900000077',
    service_address: 'x', service_type: 'install', product_description: 'x',
  },
});
const landedStore = String(crossStore.json?.data?.archive?.store_id ?? '');
check((crossStore.status === 403 || crossStore.status === 404) && landedStore === '',
  '②e 请求体传 store_id=4（非本店）被直接拒绝，且不落库',
  `HTTP ${crossStore.status} ${crossStore.text.slice(0, 120)}`);
check(ctl.status === 200 && String(ctl.json?.data?.archive?.store_id) === '1',
  '②f 正向对照：同一账号创建本店(store_id=1)档案成功（证明拒绝的是"跨店"而非"创建")',
  `HTTP ${ctl.status} store_id=${ctl.json?.data?.archive?.store_id ?? 'n/a'}`);

// ---------------------------------------------------------------------------
section('③ 浏览器里（真实销售会话）直接打 svc: —— 即"页面按钮接得上"');
// ---------------------------------------------------------------------------
const s = await launchCdp({ label: 'a5act' });
const { cdp } = s;
const PROBE = `(async () => {
  const tk = localStorage.getItem('NOCOBASE_TOKEN') || '';
  const call = async (path, body) => {
    const r = await fetch(path, { method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + tk, 'X-Request-Id': crypto.randomUUID() },
      body: JSON.stringify(body || {}) });
    let j = null; try { j = await r.json(); } catch(e){}
    return { status: r.status, code: j?.errors?.[0]?.code || '', msg: (j?.errors?.[0]?.message || '').slice(0, 80) };
  };
  return {
    hasToken: tk.length > 20,
    create: await call('/api/svc:archiveCreate', { archive_type:'service', store_id:1,
      customer_name:'浏览器内创建', customer_mobile:'13900000066',
      service_address:'浏览器地址', service_type:'install', product_description:'浏览器机型' }),
    // 原生写通道（应当被拒）
    native: await call('/api/serviceArchives:create', { archive_type:'service', store_id:1,
      customer_name:'原生写', customer_mobile:'13900000055' }),
  };
})()`;

try {
  await cdp.send('Page.navigate', { url: `${BASE}/signin` });
  await sleep(2500);
  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { timeout: 45000 });
  await cdp.evaluate(`(()=>{const ins=[...document.querySelectorAll('input')];const set=(el,v)=>{const st=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set;st.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};set(ins[0],${JSON.stringify(SALES.email)});set(ins[1],${JSON.stringify(SALES.password)});return true;})()`);
  await sleep(700);
  await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
  await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { timeout: 45000 });
  await sleep(2000);

  // 先到移动端页面上下文（模拟用户在该页面上点按钮）
  await cdp.send('Page.navigate', { url: `${BASE}/v/mobile/n5c25yq5qlt` });
  await sleep(8000);

  const r = await cdp.evaluate(PROBE);
  console.log('        ' + JSON.stringify(r, null, 1).replace(/\n/g, '\n        '));
  check(r.hasToken, '③a 浏览器内持有真实销售会话 token', `hasToken=${r.hasToken}`);
  check(r.create.status === 200,
    '③b 在移动端页面上下文内，`fetch("/api/svc:archiveCreate")` 成功（按钮可直连）',
    `HTTP ${r.create.status} ${r.create.msg}`);
  check(r.native.status === 403 || r.native.status === 401,
    '③c 同一会话下 `fetch("/api/serviceArchives:create")` 被拒（原生写仍关闭）',
    `HTTP ${r.native.status} ${r.native.code} ${r.native.msg}`);
} finally {
  s.close();
}

// ---------------------------------------------------------------------------
section('④ 结论性判据：V2 移动端可用的接线方式');
// ---------------------------------------------------------------------------
const providers = execFileSync('docker', ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket',
  '-A', '-t', '-F', '|', '-c',
  `SELECT string_agg(name || '=' || enabled::text, ' ') FROM "applicationPlugins"
   WHERE name IN ('workflow-custom-action-trigger','action-custom-request','workflow-request','workflow-javascript');`],
  { encoding: 'utf8' }).trim();
console.log(`  相关插件启用状态: ${providers}`);
check(providers.includes('workflow-custom-action-trigger=t'),
  '④a 「工作流：自定义操作事件」已启用（可在自定义按钮上挂工作流）');
check(providers.includes('action-custom-request=t'),
  '④b 「自定义请求」动作已启用（可直接发 HTTP 到 svc:）');

section('汇总');
const pass = results.filter((r) => r.pass).length;
console.log(`${pass}/${results.length} PASS`);
for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.label}`);
console.log(`\n本次创建用于验证的档案 id: ${ctlArchiveId}（开发环境，可直接清理）`);
process.exit(pass === results.length ? 0 : 1);
// 测试口令只在 .env（`ARC_TEST_PW`）：源码不留凭据字面量（见 docs/R2-SECURITY-FREEZE.md 第 2 项）
const ARC_TEST_PW = (() => {
  try {
    const t = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = /^ARC_TEST_PW=(.*)$/m.exec(t);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();

