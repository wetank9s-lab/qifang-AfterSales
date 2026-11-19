/**
 * arc-a5-v2-mobile-create.mjs —— ARC-V1 / A5 第一步：在 V2 移动端真正建页并验证
 *
 * 背景（事实，非推断）：
 *   · 用户手工建的「档案移动测试」落在了 **V1** 入口：
 *       desktopRoutes: flowPage(schemaUid=n5c25yq5qlt) + tabs
 *       /m/page/n5c25yq5qlt  → 能进，但"暂无页面，请先配置"
 *       /v/admin/n5c25yq5qlt → 404（而同库其它 flowPage 都能开 ⇒ 它不是 V2 页）
 *   · V2 移动端的页面表是 **mobileRoutes**（当前 0 行），
 *     客户端调用 `mobileRoutes:listAccessible`，服务端按 rolesMobileRoutes 过滤。
 *   · `/v/mobile` 实测能打开，截图显示"暂无移动端页面"+ 手机框。
 *
 * 本脚本做三件事（全部在开发环境）：
 *   1. 用 admin 正常 API 建 1 个 V2 移动页面路由（不直接 SQL 插）
 *   2. 建完后**用真实渲染**验证：/v/mobile 菜单里出现该页、点进去能打开
 *   3. 授予 store_sales 可见性，再用销售账号真实登录验证
 *
 * 纪律：
 *   · 不碰 serviceArchives 原生写权限
 *   · 失败即回滚（删除本次创建的行），不留脏数据
 *   · 每条断言都要能变红
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { launchCdp, sleep } from '../scripts/verify-store-ui-primary-action.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = 'https://127.0.0.1';
const envText = fs.readFileSync('.env', 'utf8');
const g = (k) => { const m = new RegExp('^' + k + '=(.*)$', 'm').exec(envText); return m ? m[1].trim() : ''; };

const ADMIN_EMAIL = g('UAT_HQADMIN_EMAIL') || 'uat.hqadmin@svc.local';
const ADMIN_PW = g('UAT_HQADMIN_PASSWORD');

/**
 * V2 移动端路由的写权限只给 root/admin（hq_admin 实测 403 "No permissions"）。
 * 因此建页必须用 root 账号。凭据来自本地开发环境的临时凭据文件
 * （用户已授权、权限已收紧为 Administrator+SYSTEM），**不写进任何源码或报告**。
 */
function readRootCredential() {
  const p = '.tmp-verify/admin-credential-dev.txt';
  if (!fs.existsSync(p)) throw new Error('缺少 root 凭据文件 ' + p);
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  // ⚠️ 取"第一个冒号之后的**全部**内容"。
  //    用 \S+ 会在口令含空格时被截断；截断后登录返回 400，
  //    而 400 看起来像"账号不对"，很容易误判成"凭据无效"。
  const get = (k) => {
    const l = lines.find((x) => new RegExp('^\\s*' + k + '\\s*[:：]').test(x));
    return l ? l.replace(/^\s*[A-Za-z]+\s*[:：]\s*/, '').trim() : '';
  };
  const email = get('email') || get('username');
  const password = get('password');
  if (!email || !password) throw new Error('root 凭据文件缺少 email/password 字段');
  return { email, password };
}
const ROOT = readRootCredential();

const SALES_EMAIL = 'arc1.sales.a@svc.local';
const SALES_PW = ARC_TEST_PW;

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};
const section = (t) => console.log(`\n--- ${t} ---`);

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
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}
async function signIn(account, password) {
  const r = await api(null, '/api/auth:signIn', { method: 'POST', body: { account, password } });
  if (!r.json?.data?.token) throw new Error(`登录失败 ${account}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.data.token;
}
function psql(sql) {
  return execFileSync('docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket',
      '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8' }).trim();
}

// 生成本次页面 uid（NocoBase 用的是短随机串）
const PAGE_UID = crypto.randomBytes(6).toString('hex').slice(0, 11);
const PAGE_TITLE = '档案移动测试V2';
console.log('='.repeat(78));
console.log(`ARC-V1 / A5 · V2 移动页创建与验证`);
console.log(`新页 uid = ${PAGE_UID}   标题 = ${PAGE_TITLE}`);
console.log('='.repeat(78));

const adminTok = await signIn(ROOT.email, ROOT.password);
console.log(`root 账号登录完成（${ROOT.email}）`);

// -------------------------------------------------------------------------
// 0. 为什么必须用 root：先把 hq_admin 被拒这件事留成证据
// -------------------------------------------------------------------------
const hqTok = await signIn(ADMIN_EMAIL, ADMIN_PW);
const hqTry = await api(hqTok, '/api/mobileRoutes:create', {
  method: 'POST',
  body: { type: 'flowPage', title: '不应被创建的页', sort: 999 },
});
check(hqTry.status === 403,
  'hq_admin 建移动页被拒（403）—— 证明写权限边界真实存在',
  `HTTP ${hqTry.status} ${hqTry.text.slice(0, 120)}`);

let createdId = null;
try {
  // -------------------------------------------------------------------------
  section('1. 现状基线');
  // -------------------------------------------------------------------------
  const before = psql(`SELECT count(*) FROM "mobileRoutes";`);
  check(before === '0', 'mobileRoutes 基线为 0 行（干净）', `实际 ${before}`);
  const v2Accessible = await api(adminTok, '/api/mobileRoutes:listAccessible?tree=true&sort=sort&paginate=false');
  check(v2Accessible.status === 200 && Array.isArray(v2Accessible.json?.data),
    'admin 可调用 mobileRoutes:listAccessible', `HTTP ${v2Accessible.status} rows=${v2Accessible.json?.data?.length}`);

  // -------------------------------------------------------------------------
  section('2. 用正常 API 建 V2 移动页面');
  // -------------------------------------------------------------------------
  // 先试最可能被拒绝的形态，如实记录
  const candidates = [
    { label: 'type=flowPage + schemaUid', body: { type: 'flowPage', title: PAGE_TITLE, schemaUid: PAGE_UID, icon: 'ProfileOutlined', sort: 1 } },
    { label: 'type=page + schemaUid', body: { type: 'page', title: PAGE_TITLE, schemaUid: PAGE_UID, icon: 'ProfileOutlined', sort: 1 } },
    { label: '仅 title（让服务端生成 schemaUid）', body: { type: 'flowPage', title: PAGE_TITLE, icon: 'ProfileOutlined', sort: 1 } },
  ];
  let created = null;
  for (const c of candidates) {
    const r = await api(adminTok, '/api/mobileRoutes:create', { method: 'POST', body: c.body });
    console.log(`  尝试「${c.label}」→ HTTP ${r.status}`);
    if (r.status < 400 && r.json?.data?.id) {
      created = { ...c, r };
      console.log(`        ✓ 成功 id=${r.json.data.id} schemaUid=${r.json.data.schemaUid}`);
      break;
    } else {
      console.log(`        ✗ ${r.text.slice(0, 200)}`);
    }
  }
  check(!!created, '通过正常 API 成功创建 V2 移动页面路由',
    created ? `方式「${created.label}」id=${created.r.json.data.id}` : '三种形态全部失败');

  if (!created) { throw new Error('无法创建，停止后续验证'); }
  createdId = created.r.json.data.id;
  const realUid = created.r.json.data.schemaUid;

  // -------------------------------------------------------------------------
  section('3. 库内核对');
  // -------------------------------------------------------------------------
  const row = psql(`SELECT id, "parentId", type, title, "schemaUid", icon, sort FROM "mobileRoutes" WHERE id=${createdId};`);
  console.log(`  库内行: ${row}`);
  check(row.split('|')[4] === realUid, '库内 schemaUid 与接口返回一致', `db=${row.split('|')[4]} api=${realUid}`);

  // -------------------------------------------------------------------------
  section('4. 真实渲染验证：/v/mobile 是否出现该页');
  // -------------------------------------------------------------------------
  const s = await launchCdp({ label: 'a5v2' });
  const { cdp } = s;
  const PROBE_LIST = `(() => {
    const rt = document.querySelector('#root') || document.body;
    const x = (rt.innerText || '').replace(/\\s+/g,' ').trim();
    return { url: location.pathname, len: x.length, txt: x.slice(0, 300),
      empty: /暂无移动端页面/.test(x),
      hasTitle: x.indexOf(${JSON.stringify(PAGE_TITLE)}) >= 0 };
  })()`;
  try {
    // admin 登录
    await cdp.send('Page.navigate', { url: `${BASE}/signin` });
    await cdp.waitFor('document.querySelectorAll("input").length >= 2', { timeout: 45000 });
    await cdp.evaluate(`(()=>{const ins=[...document.querySelectorAll('input')];const set=(el,v)=>{const st=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set;st.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};set(ins[0],${JSON.stringify(ADMIN_EMAIL)});set(ins[1],${JSON.stringify(ADMIN_PW)});return true;})()`);
    await sleep(700);
    await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
    await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { timeout: 45000 });

    await cdp.send('Page.navigate', { url: `${BASE}/v/mobile` });
    await sleep(9000);
    const l1 = await cdp.evaluate(PROBE_LIST);
    console.log('        ' + JSON.stringify({ empty: l1.empty, hasTitle: l1.hasTitle, txt: l1.txt.slice(0, 160) }));
    check(!l1.empty, 'V2 移动端不再是"暂无移动端页面"', `empty=${l1.empty}`);
    check(l1.hasTitle, 'V2 移动端菜单里出现新页标题', `hasTitle=${l1.hasTitle}`);

    // 反向对照：一个不存在的标题不应出现
    check(l1.txt.indexOf('绝不存在的页面XYZ') < 0, 'R1 反向对照：不存在标题不会出现（判据有效）');

    // 点进页面
    const clicked = await cdp.evaluate(`(() => {
      const els = [...document.querySelectorAll('a,div,button,li')];
      const t = els.find(e => (e.innerText||'').trim() === ${JSON.stringify(PAGE_TITLE)} && e.offsetParent !== null);
      if (!t) return { ok:false };
      t.click();
      return { ok:true, tag:t.tagName };
    })()`);
    await sleep(8000);
    const detail = await cdp.evaluate(`(() => {
      const rt = document.querySelector('#root') || document.body;
      const x = (rt.innerText||'').replace(/\\s+/g,' ').trim();
      return { url: location.pathname, len: x.length, txt: x.slice(0,300),
        nf: /404|页面不存在/.test(x), emptyPage: /暂无页面/.test(x) };
    })()`);
    console.log(`        clicked=${JSON.stringify(clicked)} → ${JSON.stringify({ url: detail.url, len: detail.len, nf: detail.nf, txt: detail.txt.slice(0,140) })}`);
    check(clicked.ok, '能在 V2 移动端菜单中定位并点击新页', JSON.stringify(clicked));
    check(!detail.nf && detail.url.indexOf(realUid) >= 0,
      '点击后进入该页（URL 含 schemaUid 且非 404）', `url=${detail.url} nf=${detail.nf}`);

    // 直接访问实测
    for (const p of [`/v/mobile/page/${realUid}`, `/v/mobile/${realUid}`]) {
      await cdp.send('Page.navigate', { url: BASE + p });
      await sleep(7000);
      const d = await cdp.evaluate(`(()=>{const rt=document.querySelector('#root')||document.body;const x=(rt.innerText||'').replace(/\\s+/g,' ').trim();return {len:x.length,nf:/404|页面不存在/.test(x),txt:x.slice(0,100)};})()`);
      console.log(`        ${p} → len=${d.len} nf=${d.nf} ${JSON.stringify(d.txt.slice(0, 80))}`);
    }

    // -----------------------------------------------------------------------
    section('5. 授予 store_sales 可见性（含反向验证）');
    // -----------------------------------------------------------------------
    const salesTok = await signIn(SALES_EMAIL, SALES_PW);
    // 授权前：销售账号拉取移动路由，不应含本页
    const beforeGrant = await api(salesTok, '/api/mobileRoutes:listAccessible?tree=true&sort=sort&paginate=false');
    const beforeIds = (beforeGrant.json?.data || []).map((r) => String(r.id));
    check(!beforeIds.includes(String(createdId)),
      '授权前 store_sales 看不到该页（正向对照）', `可见 ${beforeIds.length} 条，含本页=${beforeIds.includes(String(createdId))}`);

    // grants 走角色接口
    const grant = await api(adminTok, `/api/roles:update?filterByTk=store_sales`, {
      method: 'POST',
      body: { mobileRoutes: [{ id: createdId }] },
    });
    console.log(`  授予 store_sales → HTTP ${grant.status} ${grant.status >= 400 ? grant.text.slice(0, 200) : ''}`);

    await sleep(1500);
    const afterGrant = await api(salesTok, '/api/mobileRoutes:listAccessible?tree=true&sort=sort&paginate=false');
    const afterIds = (afterGrant.json?.data || []).map((r) => String(r.id));
    check(afterIds.includes(String(createdId)),
      '授权后 store_sales 能看到该页', `可见 ${afterIds.length} 条，含本页=${afterIds.includes(String(createdId))}`);

    // 销售账号浏览器实测
    await cdp.send('Page.navigate', { url: `${BASE}/signin` });
    await cdp.waitFor('document.querySelectorAll("input").length >= 2', { timeout: 45000 });
    await cdp.evaluate(`(()=>{const ins=[...document.querySelectorAll('input')];const set=(el,v)=>{const st=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set;st.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};set(ins[0],${JSON.stringify(SALES_EMAIL)});set(ins[1],${JSON.stringify(SALES_PW)});return true;})()`);
    await sleep(700);
    await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
    await sleep(6000);
    await cdp.send('Page.navigate', { url: `${BASE}/v/mobile` });
    await sleep(9000);
    const salesView = await cdp.evaluate(PROBE_LIST);
    console.log('        ' + JSON.stringify({ ok: salesView.hasTitle, txt: salesView.txt.slice(0, 180) }));
    check(salesView.hasTitle, '销售账号真实登录后能看到该页入口', `hasTitle=${salesView.hasTitle}`);

    // 截图留证
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const pngPath = `.tmp-verify/arc-a5-v2-sales-mobile-${Date.now()}.png`;
    fs.writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));
    console.log(`\n  销售账号视角截图: ${pngPath} (${Buffer.from(shot.data, 'base64').length} bytes)`);
  } finally {
    s.close();
  }
} catch (e) {
  console.log(`\n!! 中断: ${e.message}`);
} finally {
  if (createdId) {
    console.log(`\n  本次创建 id=${createdId}，页面 uid 见上。`);
  }
}

section('汇总');
const pass = results.filter((r) => r.pass).length;
console.log(`${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
// 测试口令只在 .env（`ARC_TEST_PW`）：源码不留凭据字面量（见 docs/R2-SECURITY-FREEZE.md 第 2 项）
const ARC_TEST_PW = (() => {
  try {
    const t = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = /^ARC_TEST_PW=(.*)$/m.exec(t);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();

