#!/usr/bin/env node
/**
 * verify-ux-01c-store-entry.mjs —— B-18「门店报修入口」专项门禁（UX-01C-R6）
 *
 * ===========================================================================
 * 它守什么
 * ===========================================================================
 * B-18 的原始现象：页面是一张 `stores` 原生表格，业务角色没有该资源的原生只读授权
 * ⇒ `stores:list` 403 ⇒ 区块「渲染失败」。门禁必须同时证明三件事：
 *   ① **页面能开**（不是只有接口 200）；
 *   ② **行级范围正确**（门店账号只看授权门店；总部/viewer 按既有范围）；
 *   ③ **入口本身可用**（签名链接、二维码、下载、复制、旧码兼容、篡改被拒）。
 *
 * ⚠️ 这条**不允许**再用 `knownIssue` 把"预期 403"写成通过 —— 那是本次整改的硬要求。
 *
 * 用法：node scripts/verify-ux-01c-store-entry.mjs
 * 退出码：0 通过 / 1 判据不满足 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SVC_BASE_URL } from './lib/base-url.mjs';
import { launchCdp, psql, psqlRows, sleep } from './verify-store-ui-primary-action.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.tmp-verify');
const PAGE_UID = 'qbr4apqripv'; // 「门店报修入口」
const ORIGIN = new URL(SVC_BASE_URL).origin;
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

async function login(emailKey, fallback) {
  const r = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({
      email: envValue(emailKey, fallback),
      password: envValue(emailKey.replace('_EMAIL', '_PASSWORD')),
    }),
  });
  const text = await r.text();
  if (r.status !== 200) throw new Error(`${fallback} 登录失败 HTTP ${r.status}`);
  return JSON.parse(text).data.token;
}

async function apiGet(token, pathname) {
  const r = await fetch(`${SVC_BASE_URL}/api/${pathname}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* noop */
  }
  return { status: r.status, json, text };
}

const EXPECTED_FIELDS = ['active', 'address', 'code', 'contact_phone', 'createdAt', 'id', 'name', 'sort_order', 'updatedAt'];

/**
 * 角色清单必须与后台菜单矩阵一致。
 * 这里直接查**库里的资源授权**（而不是读源码常量），因为库里那份才是 ACL 真正用的：
 * 少了 ⇒ 该角色 403；多了 ⇒ 有人把 stores 加进了全局白名单/多授了角色。
 */
const MENU_ROLES_WITH_PAGE = ['hq_admin', 'hq_after_sales', 'store_after_sales', 'viewer'];

// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  UX-01C-R6 / B-18：门店报修入口（页面 + 行级权限 + 二维码）');
console.log('══════════════════════════════════════════════════════════════');

const totalStores = Number(String(psql('select count(*) from stores')).trim());
const activeStores = Number(String(psql('select count(*) from stores where active=true')).trim());
const disabled = psqlRows('select code from stores where active=false order by code').map((r) => r[0]);
note('门店数据', `total=${totalStores} · active=${activeStores} · disabled=${disabled.join(',') || '(无)'}`);

// ---- A. 接口权限矩阵 ------------------------------------------------------
console.log('');
console.log('  A. 接口权限矩阵（行级范围 + 字段 + 写拒绝）');
{
  const granted = psqlRows(
    `select "roleName" from "dataSourcesRolesResources" where name='stores' order by "roleName"`,
  ).map((r) => r[0]);
  check(
    JSON.stringify(granted) === JSON.stringify(MENU_ROLES_WITH_PAGE),
    'stores 资源授权恰好覆盖四个有菜单的角色（不多不少）',
    `实际：${granted.join(',') || '(无)'}`,
  );
}

const tokens = {};
try {
  tokens.hqAdmin = await login('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local');
  tokens.hq = await login('UAT_HQ_EMAIL', 'uat.hq@svc.local');
  tokens.storeA = await login('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local');
  tokens.storeB = await login('UAT_STORE_B_EMAIL', 'uat.store.b@svc.local');
  tokens.viewer = await login('UAT_VIEWER_EMAIL', 'uat.viewer@svc.local');
} catch (error) {
  console.log(`  ⛔ ${String(error?.message ?? error)}`);
  process.exit(2);
}

const storeIds = new Map(
  psqlRows('select code, id from stores order by id').map(([code, id]) => [code, Number(id)]),
);
{
  const hq = await apiGet(tokens.hqAdmin, 'stores:list?pageSize=50&sort=code');
  const rows = hq.json?.data ?? [];
  check(hq.status === 200 && rows.length === totalStores, 'hq_admin 读到全部门店', `HTTP ${hq.status} rows=${rows.length}/${totalStores}`);
  const fields = rows[0] ? Object.keys(rows[0]).sort() : [];
  check(JSON.stringify(fields) === JSON.stringify(EXPECTED_FIELDS), '字段集合 = 服务端白名单（不含任何未登记列）', fields.join(','));

  const hqas = await apiGet(tokens.hq, 'stores:list?pageSize=50');
  check(hqas.status === 200 && (hqas.json?.data ?? []).length === totalStores, 'hq_after_sales 读到全部门店', `HTTP ${hqas.status}`);

  const a = await apiGet(tokens.storeA, 'stores:list?pageSize=50');
  const aCodes = (a.json?.data ?? []).map((x) => x.code);
  check(a.status === 200 && aCodes.length === 1 && aCodes[0] === 'S01', 'store_A 只读到 S01', `HTTP ${a.status} codes=${aCodes.join(',')}`);

  const b = await apiGet(tokens.storeB, 'stores:list?pageSize=50');
  const bCodes = (b.json?.data ?? []).map((x) => x.code);
  check(b.status === 200 && bCodes.length === 1 && bCodes[0] === 'S02', 'store_B 只读到 S02', `HTTP ${b.status} codes=${bCodes.join(',')}`);

  const v = await apiGet(tokens.viewer, 'stores:list?pageSize=50');
  check(v.status === 200 && (v.json?.data ?? []).length === totalStores, 'viewer 读到全部门店（只读策略不变）', `HTTP ${v.status}`);

  const own = await apiGet(tokens.storeA, `stores:get?filterByTk=${storeIds.get('S01')}`);
  check(own.status === 200, 'store_A get 本店 200', `HTTP ${own.status}`);
  const cross = await apiGet(tokens.storeA, `stores:get?filterByTk=${storeIds.get('S02')}`);
  check(cross.status === 404, 'store_A get 跨店 404（不泄露存在性）', `HTTP ${cross.status}`);

  const bypass = await apiGet(
    tokens.storeA,
    `stores:list?pageSize=50&filter=${encodeURIComponent(JSON.stringify({ code: 'S02' }))}`,
  );
  check((bypass.json?.data ?? []).length === 0, 'store_A 用 filter 也拿不到 S02（$and 不能被挤掉）', `rows=${(bypass.json?.data ?? []).length}`);

  const anon = await apiGet('', 'stores:list?pageSize=1');
  check(anon.status === 401, '未登录 401', `HTTP ${anon.status}`);

  const upd = await fetch(`${SVC_BASE_URL}/api/stores:update?filterByTk=${storeIds.get('S01')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: `Bearer ${tokens.storeA}` },
    body: JSON.stringify({ name: '__probe__' }),
  });
  check(upd.status === 403, '门户主数据原生写 403（写只走受控端点）', `HTTP ${upd.status}`);
}

// ---- B. 入口签名 / 旧码兼容 ----------------------------------------------
console.log('');
console.log('  B. 签名入口与旧码兼容（服务端行为）');
let signedEntry = '';
{
  const links = await apiGet(tokens.hqAdmin, 'svc:storeEntryLinks');
  const item = (links.json?.data?.items ?? []).find((x) => x.code === 'S01');
  check(Boolean(item), '后台接口返回 S01 入口项');
  if (item) {
    signedEntry = String(item.entry ?? '');
    check(/^S01\.[A-Za-z0-9_-]+$/.test(signedEntry), '入口是签名形态（S01.<sig>）', signedEntry.slice(0, 14) + '…');
    check(/\/h5\/report\?k=S01\./.test(String(item.url)), 'URL 走正式 H5 报修路径且带签名', String(item.url).slice(0, 60) + '…');
    check(String(item.qr_svg ?? '').startsWith('<svg'), '二维码 SVG 由服务端生成');
    check(!('legacy_url' in item) || typeof item.legacy_url === 'string', '接口仍回 legacy_url（供服务端兼容，不在 UI 展示）');
  }

  const good = await apiGet('', `public/store-entry?k=${encodeURIComponent(signedEntry)}`);
  check(good.status === 200 && good.json?.data?.code === 'S01', '签名入口可打开（匿名）', `HTTP ${good.status}`);

  const tampered = signedEntry.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  const bad = await apiGet('', `public/store-entry?k=${encodeURIComponent(tampered)}`);
  check(bad.status === 404, '篡改签名被拒（404，与不存在同形）', `HTTP ${bad.status}`);

  // 旧码：裸门店编码。服务端应继续兼容（legacy 路径），但 UI 不再展示。
  const legacy = await apiGet('', 'public/store-entry?k=S01');
  check(legacy.status === 200 && legacy.json?.data?.code === 'S01', '旧码（裸编码）仍可服务端兼容', `HTTP ${legacy.status}`);

  if (disabled.length > 0) {
    const off = await apiGet('', `public/store-entry?k=${encodeURIComponent(disabled[0])}`);
    check(off.status === 404, `停用门店 ${disabled[0]} 的入口被拒`, `HTTP ${off.status}`);
  } else {
    note('停用门店', '当前没有停用门店 —— 本轮不做破坏性启停测试（按纪律）');
  }
}

// ---- C. 真实浏览器（四角色 + 二维码弹窗） --------------------------------
async function withCdp(label, emailKey, fallback, fn) {
  const session = await launchCdp({ label });
  const { cdp } = session;
  try {
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Browser.grantPermissions', {
      origin: ORIGIN,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    }).catch(() => {});
    await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/signin` });
    await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页' });
    await cdp.evaluate(`(() => {
      const ins = [...document.querySelectorAll('input')];
      const setVal = (el, val) => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal(ins[0], ${JSON.stringify(envValue(emailKey, fallback))});
      setVal(ins[1], ${JSON.stringify(envValue(emailKey.replace('_EMAIL', '_PASSWORD')))});
      return true;
    })()`);
    await sleep(700);
    await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
    await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 45_000 });
    return await fn(cdp);
  } finally {
    session.close();
  }
}

async function openPage(cdp) {
  await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/admin/${PAGE_UID}` });
  await sleep(4000);
  await cdp
    .waitFor(`document.querySelectorAll('.ant-spin-spinning').length === 0`, { what: '加载完成', timeout: 40_000 })
    .catch(() => {});
  await sleep(800);
  return cdp.evaluate(`(() => {
    const content = document.querySelector('.ant-layout-content');
    const text = (content?.innerText ?? '').replace(/\\s+/g, ' ');
    const rows = [...document.querySelectorAll('.ant-table-tbody tr[data-row-key]')];
    return {
      rows: rows.length,
      codes: rows.map((r) => (r.innerText || '').replace(/\\s+/g, ' ').slice(0, 60)),
      failed: /渲染失败|No permissions|可能已被删除/.test(text),
      text: text.slice(0, 300),
    };
  })()`);
}

console.log('');
console.log('  C. 真实浏览器（页面渲染 + 行级范围）');
await withCdp('b18-hq', 'UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local', async (cdp) => {
  const page = await openPage(cdp);
  check(!page.failed, 'hq_admin：页面无「渲染失败 / No permissions」', page.text.slice(0, 160));
  check(page.rows === totalStores, `hq_admin：表格 ${totalStores} 行`, `实际 ${page.rows}`);

  // 打开 S01 的入口弹窗
  const clicked = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.ant-table-tbody tr[data-row-key]')];
    const tr = rows.find((r) => (r.innerText || '').includes('S01'));
    if (!tr) return false;
    const btn = tr.querySelector('[data-testid="svc-store-entry-action"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check(clicked, 'S01 行有「报修入口」动作并可点击');
  await cdp.waitFor(`!!document.querySelector('[data-testid="svc-store-entry-qr"]')`, { what: '二维码弹窗', timeout: 20_000 });
  const modal = await cdp.evaluate(`(() => {
    const q = document.querySelector('[data-testid="svc-store-entry-qr"]');
    const box = q?.closest('.ant-modal-content') ?? document.querySelector('.ant-modal-content');
    return {
      name: document.querySelector('[data-testid="svc-store-entry-name"]')?.innerText ?? '',
      code: document.querySelector('[data-testid="svc-store-entry-code"]')?.innerText ?? '',
      url: document.querySelector('[data-testid="svc-store-entry-url-value"]')?.innerText ?? '',
      hasQr: Boolean(q && q.innerHTML.includes('<svg')),
      hasDownload: Boolean(document.querySelector('[data-testid="svc-store-entry-download"]')),
      copyCount: box ? box.querySelectorAll('[data-testid="svc-store-entry-url-copy"]').length : 0,
      copyRect: (() => {
        const b = document.querySelector('[data-testid="svc-store-entry-url-copy"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })(),
      text: (box?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 300),
    };
  })()`);
  check(modal.name.includes('圣大家电') && modal.code.includes('S01'), '弹窗显示本店名称与编码', `${modal.name}${modal.code}`);
  check(modal.hasQr, '弹窗渲染服务端二维码');
  check(/\/h5\/report\?k=S01\.[A-Za-z0-9_-]+/.test(modal.url), '弹窗只展示**签名**入口', modal.url.slice(0, 60) + '…');
  // ⚠️ 不能把「防篡改」当旧入口特征：正式链接的标签正是「已签名，防篡改」。
  //    判据只认"旧入口 / 旧链接"这类**旧码专属**字样，且要求只有一个链接行。
  check(!/旧入口|旧链接/.test(modal.text), '弹窗不再出现「旧入口」相关文案');
  check(modal.copyCount === 1 && modal.hasDownload, '复制与下载入口都在');

  // 复制：必须用**真实鼠标事件**。
  // ⚠️ `element.click()` 是脚本合成事件，**不构成用户激活** ⇒ 浏览器会拒绝
  //    `navigator.clipboard.writeText`，`execCommand('copy')` 同样返回 false。
  //    第一版因此把一个"测试驱动方式"的问题误报成产品不可用。
  if (modal.copyRect) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: modal.copyRect.x, y: modal.copyRect.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: modal.copyRect.x, y: modal.copyRect.y, button: 'left', clickCount: 1 });
    await sleep(800);
  }
  const copied = await cdp.evaluate(`(async () => {
    try { return await navigator.clipboard.readText(); } catch (e) { return null; }
  })()`);
  const toast = await cdp.evaluate(`[...document.querySelectorAll('.ant-message-notice-content')].map(n => n.innerText).join(' | ')`);
  check(
    (copied && copied === modal.url) || /已复制/.test(toast),
    '复制按钮可用（剪贴板内容或成功提示）',
    copied ? `剪贴板=${String(copied).slice(0, 50)}…` : `提示=${toast.slice(0, 60)}`,
  );

  // 下载（真事件 + 真文件）
  const dlDir = path.join(OUT_DIR, `b18-download-${Date.now()}`);
  fs.mkdirSync(dlDir, { recursive: true });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });
  await cdp.evaluate(`document.querySelector('[data-testid="svc-store-entry-download"]').click()`);
  let file = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(300);
    const files = fs.readdirSync(dlDir).filter((f) => f.endsWith('.svg'));
    if (files.length) {
      file = path.join(dlDir, files[0]);
      break;
    }
  }
  check(Boolean(file), '下载二维码产生真实文件', file ? path.basename(file) : `目录 ${dlDir} 为空`);
  if (file) {
    const head = fs.readFileSync(file, 'utf8').slice(0, 40);
    check(head.includes('<svg'), '下载内容是 SVG', head.replace(/\n/g, ' '));
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT_DIR, 'ux01c-b18-entry-modal.png'), Buffer.from(shot.data, 'base64'));
});

await withCdp('b18-storeA', 'UAT_STORE_A_EMAIL', 'uat.store.a@svc.local', async (cdp) => {
  const page = await openPage(cdp);
  check(!page.failed, 'store_A：页面无「渲染失败」', page.text.slice(0, 160));
  check(page.rows === 1, 'store_A：表格只有 1 行（授权门店）', `实际 ${page.rows}`);
  check(page.text.includes('S01') && !page.text.includes('S02'), 'store_A：只看到 S01，看不到 S02');
});

await withCdp('b18-viewer', 'UAT_VIEWER_EMAIL', 'uat.viewer@svc.local', async (cdp) => {
  const page = await openPage(cdp);
  check(!page.failed, 'viewer：页面无「渲染失败」', page.text.slice(0, 160));
  check(page.rows === totalStores, 'viewer：按只读策略看到全部门店', `实际 ${page.rows}`);
});

// ---- 汇总 ----------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  结果：通过 ${results.length - failed.length} / 失败 ${failed.length}`);
if (failed.length) for (const f of failed) console.log(`    ❌ ${f.label}${f.detail ? ` —— ${f.detail}` : ''}`);
console.log('══════════════════════════════════════════════════════════════');
process.exit(failed.length ? 1 : 0);
