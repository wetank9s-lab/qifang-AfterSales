/**
 * ARC-V1 / A6 补证 · **隔离环境重建后的真实渲染与越权验证**（用户 §2 的后三项）
 *
 * 本脚本在**隔离实例**（http://127.0.0.1:13001）上验证：
 *   B1  销售账号能在浏览器里打开录入页（渲染出页面标题）
 *   B2  负责人 / 总部管理员 / 总部售后都能打开只读页
 *   C1  原生档案集合写接口对只读角色**依然拒绝**（403）
 *   C2  反向对照：读接口对同一角色**是放行的**（证明 403 来自写权限，不是整体不可用）
 *
 * 判据纪律（照抄 arc-a5-mobile-verify.mjs 的三条实测定理）：
 *   · "打开了"的判据是**渲染出该页标题**，不是 HTTP 200，也不是"非 404"
 *   · 每条正向断言都配一条反向对照
 *   · 会话清理要 `/api/auth:signOut` + `Network.clearBrowserCookies`
 *     （只清 localStorage 不够；`NOCOBASE_TOKEN` 清空后**键还在值是空串**）
 *
 * 用法：UAT_ROOT_PASSWORD=... node .tmp-verify/a6/verify-render-uat.mjs
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { launchCdp, sleep } from '../verify-store-ui-primary-action.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_UAT_BASE || 'http://127.0.0.1:13001';
const PAGE_UID = 'n5c25yq5qlt';
const PAGE_TITLE = '档案移动测试';
const URL_PAGE = `/v/mobile/${PAGE_UID}`;
const URL_ROOT = '/v/mobile';
// 🔴 R1-READY（2026-11-11）密钥审计修正：口令只从环境变量读（见 arc-v1-rebuild-accounts.mjs 同处说明）。
const PW = process.env.ARC_ACCOUNT_PASSWORD;
if (!PW) {
  throw new Error('缺少 ARC_ACCOUNT_PASSWORD（本脚本刻意只读环境变量，不读凭据文件、不写默认口令）');
}

const ACCOUNTS = {
  sales: { email: 'arc1.sales.a@svc.local', role: 'store_sales' },
  mgr: { email: 'arc1.mgr.a@svc.local', role: 'store_manager' },
  hq: { email: 'uat.hq@svc.local', role: 'hq_after_sales' },
  hqadmin: { email: 'uat.hqadmin@svc.local', role: 'hq_admin' },
};

const results = [];
const check = (id, desc, pass, detail = '') => {
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}${detail ? `\n        ${detail}` : ''}`);
};

const api = async (token, p, opt = {}) => {
  const r = await fetch(BASE + p, {
    method: opt.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      // 🔴 必须显式带 X-Role：用 `users:create` 建的账号，**默认角色是 member**
      //    （roles:check 返回 role=member、strategy.actions=["view:own"]），
      //    此时 ACL 拿的是 member 的权限 ⇒ 对业务集合一律 403，看起来像"越权被拦"，
      //    其实**测试没切到目标角色**。带 X-Role 后 resources 立刻变为
      //    [serviceArchives, serviceArchiveStages, serviceArchiveEvents]。
      ...(opt.role ? { 'X-Role': opt.role } : {}),
      'X-Data-Source': 'main',
      'X-Request-Id': crypto.randomUUID(),
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text };
};

const PAGE_PROBE = `(() => {
  const rt = document.querySelector('#root') || document.body;
  const x = (rt.innerText || '').replace(/\\s+/g,' ').trim();
  return {
    path: location.pathname,
    len: x.length,
    hasTitle: x.indexOf(${JSON.stringify(PAGE_TITLE)}) >= 0,
    notFound: /404|页面不存在/.test(x),
    emptyMobile: /暂无移动端页面/.test(x),
    txt: x.slice(0, 100),
  };
})()`;
const real = (p) => p.hasTitle && !p.notFound && !p.emptyMobile;

const browserLogin = async (cdp, email) => {
  const session = async () => (await cdp.evaluate(`(() => {
    try { const tk = localStorage.getItem('NOCOBASE_TOKEN') || '';
      return { token: tk.length > 20, path: location.pathname || '' }; }
    catch (e) { return { token: false, path: '' }; }
  })()`)) || { token: false, path: '' };

  const signOut = async () => {
    await cdp.evaluate(`(async () => {
      try { const tk = localStorage.getItem('NOCOBASE_TOKEN') || '';
        if (tk) await fetch('/api/auth:signOut', { method:'POST',
          headers:{ 'Content-Type':'application/json','Authorization':'Bearer '+tk,'X-Request-Id':crypto.randomUUID() }, body:'{}' }); } catch(e){}
      try { localStorage.clear(); sessionStorage.clear(); } catch(e){}
      return true;
    })()`);
    await sleep(600);
    await cdp.send('Network.clearBrowserCookies');
    await sleep(300);
  };

  let st = await session();
  if (st.token) { await signOut(); st = await session(); }

  await cdp.send('Page.navigate', { url: `${BASE}/signin` });
  await sleep(2500);
  st = await session();
  if (st.path.indexOf('/signin') === -1) {
    await signOut();
    await cdp.send('Page.navigate', { url: `${BASE}/signin` });
    await sleep(2500);
  }

  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { timeout: 45000 });
  await cdp.evaluate(`(()=>{const ins=[...document.querySelectorAll('input')];const set=(el,v)=>{const st=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set;st.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};set(ins[0],${JSON.stringify(email)});set(ins[1],${JSON.stringify(PW)});return true;})()`);
  await sleep(700);
  await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
  await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { timeout: 45000 });
  await sleep(1500);
  return await cdp.evaluate(`(() => { const tk = localStorage.getItem('NOCOBASE_TOKEN') || ''; return tk.length > 20; })()`);
};

console.log('='.repeat(78));
console.log(`ARC-V1 · 隔离环境渲染 + 越权验证   实例=${BASE}`);
console.log(`页面 ${PAGE_TITLE}  uid=${PAGE_UID}`);
console.log('='.repeat(78));

// ---------------------------------------------------------------------------
// C. 先做 API 级越权验证（比浏览器快且准）
// ---------------------------------------------------------------------------
console.log('\n--- C. 原生档案集合写接口越权验证 ---');
const toks = {};
for (const [k, a] of Object.entries(ACCOUNTS)) {
  const r = await api(null, '/api/auth:signIn', { method: 'POST', body: { account: a.email, password: PW } });
  toks[k] = r.json?.data?.token;
  if (!toks[k]) { console.log(`  ✗ ${a.email} 登录失败`); process.exit(1); }
}
console.log(`  四账号登录完成：${Object.keys(toks).join(' / ')}`);

// C1：四个角色对 serviceArchives 的 write 动作**必须全被拒**（403）
/**
 * 🔴 500 陷阱：`update/destroy` 的 `filterByTk` 放 **body 里不生效**，
 *    服务端会报 `to do update action, filter or filterByTk is required`（**500**）。
 *    ⇒ 必须走 URL query。上一版放在 body，于是 8 条 write 得 500 而非 403，
 *      看起来像"越权没被拦住"，其实是**测试自己写错了**。
 */
const writeVerbs = ['create', 'update', 'destroy'];
let denied = 0, attempted = 0;
const writeDetail = [];
for (const [k, a] of Object.entries(ACCOUNTS)) {
  for (const verb of writeVerbs) {
    attempted++;
    let path = `/api/serviceArchives:${verb}`;
    let body = {};
    if (verb === 'create') body = { storeId: 1, status: 'draft', customerName: '越权探测' };
    else path += `?filterByTk=1`;   // ← 必须在 query 上
    const r = await api(toks[k], path, { method: 'POST', body, role: a.role });
    if (r.status === 403) denied++;
    else writeDetail.push(`${a.role}/${verb}=${r.status}:${r.text.slice(0, 60)}`);
  }
}
check('C1', `原生档案集合写接口对四个角色全部拒绝（${denied}/${attempted} 得 403）`,
  denied === attempted,
  writeDetail.length ? `未拒绝：${writeDetail.join(' ')}` : `create/update/destroy × ${Object.keys(ACCOUNTS).length} 角色 = ${attempted} 次全部 403`);

// C2：反向对照 —— 同一角色**读**接口应当是放行的（证明 C1 的 403 来自写权限，不是账号整体不可用）
let readOk = 0;
const readDetail = [];
for (const [k, a] of Object.entries(ACCOUNTS)) {
  const r = await api(toks[k], '/api/serviceArchives:list?pageSize=1', { role: a.role });
  if (r.status === 200) readOk++; else readDetail.push(`${a.role}/list=${r.status}`);
}
check('C2', '反向对照：同一批角色**读**接口放行（403 确来自写权限，非整体不可用）',
  readOk === Object.keys(ACCOUNTS).length,
  readDetail.length ? `未放行：${readDetail.join(' ')}` : `四个角色 list 全部 200`);

// ---------------------------------------------------------------------------
// B. 浏览器真实渲染
// ---------------------------------------------------------------------------
console.log('\n--- B. 浏览器真实渲染 ---');
const s = await launchCdp({ label: 'uat-render' });
const { cdp } = s;
let shots = {};
try {
  // B1：销售 —— 录入页
  const ok1 = await browserLogin(cdp, ACCOUNTS.sales.email);
  check('B0', '销售账号在隔离实例里登录成功（会话真建立）', ok1 === true, `token 已建立=${ok1}`);
  await cdp.send('Page.navigate', { url: BASE + URL_ROOT });
  await sleep(11000);
  const p1 = await cdp.evaluate(PAGE_PROBE);
  check('B1', '销售打开录入页（渲染出页面标题，非 404/空态）', real(p1),
    `path=${p1.path} hasTitle=${p1.hasTitle} notFound=${p1.notFound} empty=${p1.emptyMobile} txt=${JSON.stringify(p1.txt)}`);
  const sh1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  shots.sales = Buffer.from(sh1.data, 'base64');

  // B1b：销售直连 URL
  await cdp.send('Page.navigate', { url: BASE + URL_PAGE });
  await sleep(9000);
  const p1b = await cdp.evaluate(PAGE_PROBE);
  check('B1b', '销售可直连该页 URL（不只是靠默认落页）', real(p1b), `path=${p1b.path} hasTitle=${p1b.hasTitle}`);

  // B2：三个只读角色
  for (const k of ['mgr', 'hqadmin', 'hq']) {
    const okL = await browserLogin(cdp, ACCOUNTS[k].email);
    await cdp.send('Page.navigate', { url: BASE + URL_ROOT });
    await sleep(11000);
    const p = await cdp.evaluate(PAGE_PROBE);
    check(`B2-${k}`, `${ACCOUNTS[k].role} 可打开只读页${okL ? '' : '（注意：登录态未建立）'}`,
      okL && real(p),
      `email=${ACCOUNTS[k].email} path=${p.path} hasTitle=${p.hasTitle} notFound=${p.notFound} txt=${JSON.stringify(p.txt)}`);
    const sh = await cdp.send('Page.captureScreenshot', { format: 'png' });
    shots[k] = Buffer.from(sh.data, 'base64');
  }

  // 反向对照：不存在的桌面页面打不开（证明判据有区分力）
  const rnd = crypto.randomBytes(6).toString('hex');
  await cdp.send('Page.navigate', { url: `${BASE}/v/admin/${rnd}` });
  await sleep(8000);
  const pr = await cdp.evaluate(PAGE_PROBE);
  check('B-R', '反向对照：不存在的页面打不开（判据有区分力）', !real(pr),
    `path=${pr.path} notFound=${pr.notFound} hasTitle=${pr.hasTitle} txt=${JSON.stringify(pr.txt)}`);
} finally {
  s.close();
}

// 截图按**字节数+哈希**落盘，证明四种状态各自独立（旧图不复用）
fs.mkdirSync('.tmp-verify/evidence/a6', { recursive: true });
console.log('\n--- 截图证据（字节数 + sha256 前 12 位）---');
for (const [k, buf] of Object.entries(shots)) {
  if (!buf) continue;
  const h = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
  const f = `.tmp-verify/evidence/a6/uat-render-${k}-${buf.length}-${h}.png`;
  fs.writeFileSync(f, buf);
  console.log(`  ${k.padEnd(8)} ${String(buf.length).padStart(8)} B  sha=${h}  ${f}`);
}

const failed = results.filter((r) => !r.pass);
fs.writeFileSync('.tmp-verify/evidence/a6/verify-render-uat-result.json',
  JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));
console.log(`\n汇总：PASS ${results.length - failed.length} / ${results.length}`);
if (failed.length) console.log(`FAIL：${failed.map((f) => f.id).join(', ')}`);
process.exit(failed.length ? 1 : 0);
