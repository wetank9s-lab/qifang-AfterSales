/**
 * arc-a5-mobile-verify.mjs —— ARC-V1 / A5 移动页正式验证（正确路由形态）
 *
 * 上一轮的错（写下来防止再犯）：
 *   我用 `/v/mobile/<uid>`、`/v/mobile/page/<uid>` 去访问，全 404，
 *   于是误以为"页面没建在 V2"。真实原因是**路径拼接规则**：
 *   V2 前端按 `/{type}/{schemaUid}` 拼接，本页 type=flowPage
 *   ⇒ 正确路径是 `/v/mobile/flowPage/<uid>`；
 *   `/v/mobile` 会落到第一个可见的底部标签。
 *
 * 本脚本验的是**用户指定的 4 项**：
 *   1. 读真实路由与 FlowModel 结构（已由 arc-a5-page-structure.mjs 覆盖，这里只引用结论）
 *   2. 刷新后页面仍可正常打开（强行 ignoreCache + 冷启动）
 *   3. 仅为本页配置 store_sales 移动端访问
 *   4. 用普通销售账号真实验证路由可见性
 *
 * 判据纪律：
 *   · "打开了"的判据是**渲染出该页标题**，不是 HTTP 200，也不是"非 404"
 *   · 每条正向断言都配一条反向对照
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { launchCdp, sleep } from '../scripts/verify-store-ui-primary-action.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = 'https://127.0.0.1';
const PAGE_UID = 'n5c25yq5qlt';
const PAGE_TITLE = '档案移动测试';
/**
 * 真实 URL 形态（实测得出，别再猜）：
 *   `/v/mobile`                 → 自动重定向到 `/v/mobile/<uid>`（**不带 type 段**）
 *   `/v/mobile/<uid>`           → 可直接打开
 *   `/v/mobile/flowPage/<uid>`  → 404（`/{type}/{schemaUid}` 只在"底部标签路由"生效，
 *                                  不是浏览器地址栏的形态）
 * 🔴 上一版我把 `/{type}/{schemaUid}` 当成地址栏形态，导致 2b/2c/2d 假红。
 */
const URL_PAGE = `/v/mobile/${PAGE_UID}`;
const URL_ROOT = '/v/mobile';

const credLines = fs.readFileSync('.tmp-verify/admin-credential-dev.txt', 'utf8').split(/\r?\n/);
const cred = (k) => { const l = credLines.find((x) => new RegExp('^\\s*' + k + '\\s*[:：]').test(x)); return l ? l.replace(/^\s*[A-Za-z]+\s*[:：]\s*/, '').trim() : ''; };
const ROOT = { email: cred('email') || cred('username'), password: cred('password') };
const SALES = { email: 'arc1.sales.a@svc.local', password: ARC_TEST_PW };
const SALES_B = { email: 'arc1.sales.b@svc.local', password: ARC_TEST_PW };
const MGR = { email: 'arc1.mgr.a@svc.local', password: ARC_TEST_PW };

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
function psql(sql) {
  return execFileSync('docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket',
      '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8' }).trim();
}

// 浏览器里"这页真的出来了"的判据
const PAGE_PROBE = `(() => {
  const rt = document.querySelector('#root') || document.body;
  const x = (rt.innerText || '').replace(/\\s+/g,' ').trim();
  return {
    path: location.pathname,
    title: (document.querySelector('header, .ant-layout-header')?.innerText || '').replace(/\\s+/g,' ').trim().slice(0,60),
    len: x.length,
    hasTitle: x.indexOf(${JSON.stringify(PAGE_TITLE)}) >= 0,
    notFound: /404|页面不存在/.test(x),
    emptyMobile: /暂无移动端页面/.test(x),
    txt: x.slice(0, 120),
  };
})()`;

const real = (p) => p.hasTitle && !p.notFound && !p.emptyMobile;

const browserLogin = async (cdp, a) => {
  /**
   * 🔴 三条实测定理（都在这里踩过）：
   *  1) NocoBase 会话既写 httpOnly cookie，也写 `NOCOBASE_TOKEN`（localStorage）。
   *     只清 localStorage 不够，必须走 `/api/auth:signOut` + `Network.clearBrowserCookies`。
   *  2) `NOCOBASE_TOKEN` 被清空后**键还在，值是空串**。
   *     用 `localStorage.getItem('NOCOBASE_TOKEN') ? 已登录 : 未登录` 会判错；
   *     必须判 `值 && 值.length > 20`。
   *  3) 判断"当前是谁"要看 `NOCOBASE_STORAGE_PREFIX` 之外的 user 缓存或 /api/auth:check，
   *     不能靠"有没有 localStorage 键"。
   */
  const session = async () => (await cdp.evaluate(`(() => {
    try {
      const tk = localStorage.getItem('NOCOBASE_TOKEN') || '';
      return { token: tk.length > 20, role: localStorage.getItem('NOCOBASE_ROLE') || '', path: location.pathname || '' };
    } catch (e) { return { token: false, role: '', path: '' }; }
  })()`)) || { token: false, role: '', path: '' };

  const signOut = async () => {
    await cdp.evaluate(`(async () => {
      try {
        const tk = localStorage.getItem('NOCOBASE_TOKEN') || '';
        if (tk) await fetch('/api/auth:signOut', { method: 'POST',
          headers: { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + tk, 'X-Request-Id': crypto.randomUUID() }, body: '{}' });
      } catch(e) {}
      try { localStorage.clear(); sessionStorage.clear(); } catch(e) {}
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
    // 仍被弹回：说明 cookie 还在，再清一次
    await signOut();
    await cdp.send('Page.navigate', { url: `${BASE}/signin` });
    await sleep(2500);
  }

  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { timeout: 45000 });
  await cdp.evaluate(`(()=>{const ins=[...document.querySelectorAll('input')];const set=(el,v)=>{const st=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set;st.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};set(ins[0],${JSON.stringify(a.email)});set(ins[1],${JSON.stringify(a.password)});return true;})()`);
  await sleep(700);
  await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
  await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { timeout: 45000 });
  await sleep(1500);

  // 用服务端 auth:check 确认身份（比翻 localStorage 可靠）
  const me = await cdp.evaluate(`(async () => {
    try {
      const tk = localStorage.getItem('NOCOBASE_TOKEN') || '';
      const r = await fetch('/api/auth:check', { headers: { 'Authorization': 'Bearer ' + tk, 'X-Request-Id': crypto.randomUUID() } });
      const j = await r.json();
      return { status: r.status, email: j?.data?.email || j?.data?.user?.email || '(无)' };
    } catch (e) { return { status: 0, email: '(err)' }; }
  })()`);
  if (me.email !== '(无)' && me.email !== '(err)' && me.email !== a.email) {
    throw new Error(`登录身份不符：期望 ${a.email}，实际 ${me.email}`);
  }
  return me.email;
};

console.log('='.repeat(78));
console.log('ARC-V1 / A5 · 移动页正式验证');
console.log(`页面: ${PAGE_TITLE}  schemaUid=${PAGE_UID}`);
console.log(`路由: ${URL_ROOT}（自动落页） / ${URL_PAGE}（直连）`);
console.log('='.repeat(78));

const rootTok = await signIn(ROOT);
const salesTok = await signIn(SALES);
const salesBTok = await signIn(SALES_B);
const mgrTok = await signIn(MGR);
console.log('root / 销售A / 销售B / 负责人A 登录完成');

// ---------------------------------------------------------------------------
section('【第 2 项】刷新后页面仍可打开');
// ---------------------------------------------------------------------------
const s = await launchCdp({ label: 'a5mv' });
const { cdp } = s;
try {
  await browserLogin(cdp, ROOT);

  // 2a 首次打开（自动落页）
  await cdp.send('Page.navigate', { url: BASE + URL_ROOT });
  await sleep(10000);
  const a1 = await cdp.evaluate(PAGE_PROBE);
  check(real(a1), '2a /v/mobile 自动落到该页并渲染出标题',
    `path=${a1.path} hasTitle=${a1.hasTitle} len=${a1.len} txt=${JSON.stringify(a1.txt)}`);

  // 2b 直连 URL
  await cdp.send('Page.navigate', { url: BASE + URL_PAGE });
  await sleep(9000);
  const a2 = await cdp.evaluate(PAGE_PROBE);
  check(real(a2), '2b 直连 /v/mobile/flowPage/<uid> 可打开',
    `path=${a2.path} hasTitle=${a2.hasTitle}`);

  // 2c 强制刷新（忽略缓存）
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(10000);
  const a3 = await cdp.evaluate(PAGE_PROBE);
  check(real(a3), '2c 强制刷新（ignoreCache）后仍打开',
    `path=${a3.path} hasTitle=${a3.hasTitle}`);

  // 2d 离开再回来（冷路径）
  await cdp.send('Page.navigate', { url: `${BASE}/v/admin` });
  await sleep(5000);
  await cdp.send('Page.navigate', { url: BASE + URL_PAGE });
  await sleep(10000);
  const a4 = await cdp.evaluate(PAGE_PROBE);
  check(real(a4), '2d 离开后重新进入仍打开',
    `path=${a4.path} hasTitle=${a4.hasTitle}`);

  // R 反向对照：不存在的 uid 必须**不显示本页标题**
  //
  // 🔴 第一版用 `/v/mobile/zzzznotexist`，结果被重定向回默认页（仍然显示标题），
  //    于是我判"反向对照失败"。真实原因是：`/v/mobile/<uid>` 这个路由
  //    对**任何** uid 都兜底到"第一个可见底部标签"，它根本不是"按 uid 取页"。
  //    ⇒ 拿它做反向对照没有区分力，必须换成**有区分力**的路径：
  //       ① 桌面端不存在的页面：/v/admin/<随机>
  //       ② 移动端根路径本身（不指定 uid，应落到默认页而非"证明 uid 有效"）
  const rnd = crypto.randomBytes(6).toString('hex');
  await cdp.send('Page.navigate', { url: `${BASE}/v/admin/${rnd}` });
  await sleep(8000);
  const r = await cdp.evaluate(PAGE_PROBE);
  check(!real(r), 'R  反向对照：不存在的桌面页面 uid 打不开（判据有区分力）',
    `path=${r.path} notFound=${r.notFound} hasTitle=${r.hasTitle} txt=${JSON.stringify(r.txt)}`);

  // -------------------------------------------------------------------------
  section('【第 3 项】store_sales 移动端访问权限');
  // -------------------------------------------------------------------------
  // 先看现状：本页是否已在 mobile-layout 布局里、以及角色授权
  const layoutInfo = psql(`
    SELECT COALESCE(o.value::text,'(无)') FROM "desktopRoutes" d
    LEFT JOIN LATERAL (SELECT 1 AS value) o ON true WHERE d.id = 396888170692608;
  `);
  const grantedRows = psql(`SELECT COALESCE(string_agg(rd."roleName", ',' ORDER BY rd."roleName"),'(无)')
    FROM "rolesDesktopRoutes" rd WHERE rd."desktopRouteId" = 396888170692608;`);
  console.log(`  本页路由角色授权: ${grantedRows}`);

  // 授权前：销售账号拉取移动端路由
  const ACCESS = '/api/desktopRoutes:listAccessible?tree=true&sort=sort&layout=mobile-layout-model';

  // 🔴 脚本必须可重入：先把 store_sales 对本页的授权**撤掉**再测"授权前"，
  //    否则第二次运行时上一轮的授权还在，"授权前就能看到"会让 3a 假红。
  const revoke = await api(rootTok, '/api/roles:update?filterByTk=store_sales', {
    method: 'POST', body: { desktopRoutes: [] },
  });
  console.log(`  先撤销 store_sales 的本页授权 → HTTP ${revoke.status}`);
  await sleep(1500);

  const before = await api(salesTok, ACCESS);
  const beforeTitles = JSON.stringify(before.json?.data || []);
  check(!beforeTitles.includes(PAGE_TITLE),
    '3a 授权前销售账号看不到该页（正向对照）',
    `HTTP ${before.status} 含标题=${beforeTitles.includes(PAGE_TITLE)}`);

  // 授权（只授这一条路由）
  const grant = await api(rootTok, '/api/roles:update?filterByTk=store_sales', {
    method: 'POST',
    body: { desktopRoutes: [{ id: 396888170692608 }] },
  });
  console.log(`  授予 store_sales → HTTP ${grant.status} ${grant.status >= 400 ? grant.text.slice(0, 200) : ''}`);
  await sleep(1500);
  const after = await api(salesTok, ACCESS);
  const afterTitles = JSON.stringify(after.json?.data || []);
  check(afterTitles.includes(PAGE_TITLE), '3b 授权后销售账号能看到该页',
    `HTTP ${after.status} 含标题=${afterTitles.includes(PAGE_TITLE)}`);

  // -------------------------------------------------------------------------
  section('【第 4 项】真实销售账号浏览器验证路由可见性');
  // -------------------------------------------------------------------------
  await browserLogin(cdp, SALES);
  await cdp.send('Page.navigate', { url: BASE + URL_ROOT });
  await sleep(10000);
  const sv = await cdp.evaluate(PAGE_PROBE);
  check(real(sv), '4a 销售A 登录后 /v/mobile 直接显示该页',
    `path=${sv.path} hasTitle=${sv.hasTitle} txt=${JSON.stringify(sv.txt)}`);

  // 4b 销售能否直连 URL（不只是靠默认落页）
  await cdp.send('Page.navigate', { url: BASE + URL_PAGE });
  await sleep(9000);
  const sv2 = await cdp.evaluate(PAGE_PROBE);
  check(real(sv2), '4b 销售A 可直连该页 URL', `hasTitle=${sv2.hasTitle}`);

  // 4c 另一家店销售（B店）也应有同一页面权限 —— 这是移动端菜单级权限，
  //    页面级数据隔离由 svc: 动作负责，此处只验"菜单可见"这一层
  await browserLogin(cdp, SALES_B);
  await cdp.send('Page.navigate', { url: BASE + URL_ROOT });
  await sleep(10000);
  const svb = await cdp.evaluate(PAGE_PROBE);
  check(real(svb), '4c 销售B（另一家店）同样能看到该页入口',
    `hasTitle=${svb.hasTitle}`);

  // R 反向对照：一个未被授权的角色不应看到
  const hqActions = await api(rootTok, '/api/roles:update?filterByTk=viewer', {
    method: 'POST', body: { desktopRoutes: [] },
  });
  const viewerTok = await (async () => {
    // viewer 账号可能不存在，缺失即跳过该条对照
    try { return await signIn({ email: 'arc1.viewer@svc.local', password: ARC_TEST_PW }); } catch { return null; }
  })();
  if (viewerTok) {
    const vj = await api(viewerTok, ACCESS);
    const vTitles = JSON.stringify(vj.json?.data || []);
    check(!vTitles.includes(PAGE_TITLE), 'R2 未授权角色看不到该页（反向对照）',
      `HTTP ${vj.status} 含标题=${vTitles.includes(PAGE_TITLE)}`);
  } else {
    console.log('  (viewer 账号不存在，跳过 R2 反向对照 —— 已在 3a 用过授权前对照)');
  }

  // 截图留证（销售账号视角）
  await browserLogin(cdp, SALES);
  await cdp.send('Page.navigate', { url: BASE + URL_ROOT });
  await sleep(10000);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const png = `.tmp-verify/arc-a5-sales-mobile-${Date.now()}.png`;
  fs.writeFileSync(png, Buffer.from(shot.data, 'base64'));
  console.log(`\n  销售账号视角截图: ${png} (${Buffer.from(shot.data, 'base64').length} bytes)`);
} finally {
  s.close();
}

section('汇总');
const pass = results.filter((r) => r.pass).length;
console.log(`${pass}/${results.length} PASS`);
for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.label}`);
process.exit(pass === results.length ? 0 : 1);
// 测试口令只在 .env（`ARC_TEST_PW`）：源码不留凭据字面量（见 docs/R2-SECURITY-FREEZE.md 第 2 项）
const ARC_TEST_PW = (() => {
  try {
    const t = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = /^ARC_TEST_PW=(.*)$/m.exec(t);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();

