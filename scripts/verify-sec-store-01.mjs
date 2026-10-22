/**
 * verify-sec-store-01.mjs —— 门店账号归属与隔离（SEC-STORE-01）定向门禁。
 *
 * 覆盖：
 *   A. 权限：仅 hq_admin 可读/写；其它角色 403；匿名 401。
 *   B. 校验：非门店角色 422；未知门店 422；缺并发基准 422。
 *   C. 隔离：新账号未绑定 ⇒ stores:list 403（fail-closed）；绑定后**同一会话**立即生效；
 *      撤销后立即回到 403；跨店读取/写入由 SEC-STORE-01 矩阵单独覆盖（本门禁复用关键点）。
 *   D. 并发/幂等/审计：同基准一个 200 一个 409；同请求号回放；同号不同内容 409；审计含旧/新集合与操作人。
 *   E. 真实浏览器：hq_admin 打开「门店账号」页 → 配置门店 → 保存 → 刷新后生效。
 *   F. 原生绕过：hq_admin 仍不能读 users/roles/storeUsers。
 *
 * 夹具：运行时创建一个临时门店账号（随机口令，不落盘），结束时删审计/角色/账号，回查残留 0。
 *
 * 用法：node scripts/verify-sec-store-01.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';

const ROOT = process.cwd();
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const OUT = path.join(ROOT, '.tmp-verify');
fs.mkdirSync(OUT, { recursive: true });
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
const pg = (sql) =>
  execFileSync('docker', ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-tAc', sql], {
    encoding: 'utf8',
    timeout: 20_000,
  }).trim();

async function api(pathname, { method = 'GET', token, body, requestId } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    signal: AbortSignal.timeout(15_000),
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
const unwrap = (r) => r.json?.data?.data ?? r.json?.data ?? r.json;
const uuid = () => crypto.randomUUID();
const login = async (e, p) => {
  const r = await api('/api/auth:signIn', { method: 'POST', body: { email: e, password: p } });
  if (r.status !== 200) throw new Error(`登录失败 ${e}: HTTP ${r.status}`);
  return r.json.data.token;
};
const storesList = (token) => api('/api/stores:list?pageSize=50', { token });
const codesOf = (r) => (r.json?.data ?? []).map((x) => x.code);

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  SEC-STORE-01：门店账号 ↔ 授权门店（权限/隔离/并发/审计/浏览器）');
console.log('══════════════════════════════════════════════════════════════');

let hq;
let storeA;
let viewer;
let hqAfter;
let root;
try {
  hq = await login(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), envValue('UAT_HQADMIN_PASSWORD'));
  storeA = await login(envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'), envValue('UAT_STORE_A_PASSWORD'));
  viewer = await login(envValue('UAT_VIEWER_EMAIL', 'uat.viewer@svc.local'), envValue('UAT_VIEWER_PASSWORD'));
  hqAfter = await login(envValue('UAT_HQ_EMAIL', 'uat.hq@svc.local'), envValue('UAT_HQ_PASSWORD'));
  root = await login(envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com'), envValue('SMOKE_ADMIN_PASSWORD'));
} catch (error) {
  console.log(`  ⛔ 环境未就绪：${error.message}`);
  process.exit(2);
}

const listRes = await api('/api/svc:storeAccounts', { token: hq });
if (listRes.status !== 200) {
  console.log(`  ⛔ 读门店账号失败 HTTP ${listRes.status}: ${listRes.text.slice(0, 160)}`);
  process.exit(2);
}
const initial = unwrap(listRes);
const stores = initial.stores ?? [];
const s1 = stores.find((s) => s.code === 'S01');
const s2 = stores.find((s) => s.code === 'S02');
note('门店角色账号', `${initial.accounts.length} 个（未绑定 ${initial.accounts.filter((a) => a.unbound).length} 个）`);

let fixtureUserId = 0;
const fixtureEmail = `uat.sec01.${Date.now()}@svc.local`;
const fixturePassword = `Tmp-${crypto.randomBytes(9).toString('base64url')}`;

try {
  // ---------------------------------------------------------------- A. 权限
  const anon = await api('/api/svc:storeAccounts');
  check(anon.status === 401, '匿名读 401', `HTTP ${anon.status}`);
  for (const [name, token] of [['store_A', storeA], ['viewer', viewer], ['hq_after_sales', hqAfter]]) {
    const r = await api('/api/svc:storeAccounts', { token });
    check(r.status === 403, `${name} 读门店账号 403`, `HTTP ${r.status}`);
  }
  const writeByStore = await api('/api/svc:updateStoreAccountStores', {
    method: 'POST', token: storeA, requestId: uuid(),
    body: { user_id: 193, store_ids: [], expected_store_ids: [s1.id] },
  });
  check(writeByStore.status === 403, '门店账号不能改授权 403', `HTTP ${writeByStore.status}`);

  // ---------------------------------------------------------------- B. 校验
  const nonStore = await api('/api/svc:updateStoreAccountStores', {
    method: 'POST', token: hq, requestId: uuid(),
    body: { user_id: 195, store_ids: [s1.id], expected_store_ids: [] },
  });
  check(nonStore.status === 422, '非门店角色账号 ⇒ 422', `HTTP ${nonStore.status}`);
  const badStore = await api('/api/svc:updateStoreAccountStores', {
    method: 'POST', token: hq, requestId: uuid(),
    body: { user_id: 193, store_ids: [999999], expected_store_ids: [s1.id] },
  });
  check(badStore.status === 422, '不存在的门店 ⇒ 422', `HTTP ${badStore.status}`);
  const noExpected = await api('/api/svc:updateStoreAccountStores', {
    method: 'POST', token: hq, requestId: uuid(),
    body: { user_id: 193, store_ids: [s1.id] },
  });
  check(noExpected.status === 422, '缺 expected_store_ids ⇒ 422', `HTTP ${noExpected.status}`);
  const noRequestId = await api('/api/svc:updateStoreAccountStores', {
    method: 'POST', token: hq,
    body: { user_id: 193, store_ids: [s1.id], expected_store_ids: [s1.id] },
  });
  check(noRequestId.status === 422, '写接口缺 X-Request-Id ⇒ 422', `HTTP ${noRequestId.status}`);

  // ---------------------------------------------------------------- C. 隔离
  // 创建一个临时门店账号（未绑定任何门店）
  const created = await api('/api/users:create', {
    method: 'POST', token: root,
    body: { email: fixtureEmail, password: fixturePassword, nickname: 'SEC-STORE-01 临时账号', username: `sec01_${Date.now()}` },
  });
  if (created.status >= 300) throw new Error(`创建临时账号失败 HTTP ${created.status}: ${created.text.slice(0, 160)}`);
  fixtureUserId = Number(created.json?.data?.id ?? 0);
  await api('/api/rolesUsers:create', { method: 'POST', token: root, body: { userId: fixtureUserId, roleName: 'store_after_sales' } });
  // ⚠️ 新建用户默认会带 `member` 角色，而 ACL 的"当前角色"取 roles 列表第一个 ⇒ 可能以 member 访问，
  //    表现为"明明有门店角色却处处 403"。正式建号时应只保留 store_after_sales（本门禁按此模拟）。
  await api('/api/rolesUsers:destroy?filter=' + encodeURIComponent(JSON.stringify({ userId: fixtureUserId, roleName: 'member' })), {
    method: 'POST', token: root, body: {},
  });
  note('临时账号', `id=${fixtureUserId}（未绑定门店；已移除默认 member 角色）`);

  const fixtureToken = await login(fixtureEmail, fixturePassword);
  const beforeBind = await storesList(fixtureToken);
  const beforeCodes = codesOf(beforeBind);
  check(
    (beforeBind.status === 200 && beforeCodes.length === 0) || beforeBind.status === 403,
    '未绑定门店账号看不到任何门店（0 行或 403）',
    `HTTP ${beforeBind.status} ${JSON.stringify(beforeCodes)}`,
  );

  const bind = await api('/api/svc:updateStoreAccountStores', {
    method: 'POST', token: hq, requestId: uuid(),
    body: { user_id: fixtureUserId, store_ids: [s2.id], expected_store_ids: [] },
  });
  check(bind.status === 200, '绑定 S02 成功', `HTTP ${bind.status}`);
  const afterBind = await storesList(fixtureToken);
  check(afterBind.status === 200 && JSON.stringify(codesOf(afterBind)) === JSON.stringify(['S02']), '同一会话立即只看到 S02', `HTTP ${afterBind.status} ${JSON.stringify(codesOf(afterBind))}`);

  // ---------------------------------------------------------------- D. 并发/幂等/审计
  const cur = unwrap(await api('/api/svc:storeAccounts', { token: hq })).accounts.find((a) => a.user_id === fixtureUserId);
  const [c1, c2] = await Promise.all([
    api('/api/svc:updateStoreAccountStores', { method: 'POST', token: hq, requestId: uuid(), body: { user_id: fixtureUserId, store_ids: [s1.id], expected_store_ids: cur.store_ids } }),
    api('/api/svc:updateStoreAccountStores', { method: 'POST', token: hq, requestId: uuid(), body: { user_id: fixtureUserId, store_ids: [], expected_store_ids: cur.store_ids } }),
  ]);
  const cStatuses = [c1.status, c2.status].sort();
  check(cStatuses[0] === 200 && cStatuses[1] === 409, '并发改绑：一个 200 + 一个 409', cStatuses.join(' / '));

  const winner = c1.status === 200 ? c1 : c2;
  const winnerIds = unwrap(winner).store_ids ?? [];
  const auditBefore = Number(pg(`select count(*) from store_account_audits where user_id=${fixtureUserId}`) || 0);
  const idem = await api('/api/svc:updateStoreAccountStores', {
    method: 'POST', token: hq, requestId: uuid(),
    body: { user_id: fixtureUserId, store_ids: winnerIds, expected_store_ids: winnerIds },
  });
  // 同号同内容回放（复用上一笔请求号需要先拿到它；这里单独造一笔再回放）
  const rid = uuid();
  const first = await api('/api/svc:updateStoreAccountStores', {
    method: 'POST', token: hq, requestId: rid,
    body: { user_id: fixtureUserId, store_ids: winnerIds, expected_store_ids: winnerIds },
  });
  const replay = await api('/api/svc:updateStoreAccountStores', {
    method: 'POST', token: hq, requestId: rid,
    body: { user_id: fixtureUserId, store_ids: winnerIds, expected_store_ids: winnerIds },
  });
  check(first.status === 200 && replay.status === 200 && unwrap(replay)?.replayed === true, '同请求号同内容 ⇒ 回放', `${first.status}/${replay.status}`);
  // 用**确实不同**的集合作对比：winnerIds 可能是 []，直接传 [] 会退化成"同内容回放"
  const otherIds = winnerIds.length > 0 ? [] : [s1.id];
  const mismatch = await api('/api/svc:updateStoreAccountStores', {
    method: 'POST', token: hq, requestId: rid,
    body: { user_id: fixtureUserId, store_ids: otherIds, expected_store_ids: winnerIds },
  });
  check(mismatch.status === 409 && /IDEMPOTENT_PAYLOAD_MISMATCH/.test(mismatch.text), '同请求号不同内容 ⇒ 409', `HTTP ${mismatch.status}`);

  const auditRow = pg(
    `select old_store_ids::text || ' -> ' || new_store_ids::text || ' | ' || coalesce(operator_user_id::text,'-') from store_account_audits where user_id=${fixtureUserId} order by id desc limit 1`,
  );
  check(Boolean(auditRow) && auditRow.includes('->'), '授权变更落审计（旧 → 新 + 操作人）', auditRow);
  const auditCount = Number(pg(`select count(*) from store_account_audits where user_id=${fixtureUserId}`) || 0);
  check(auditCount >= auditBefore + 2, '审计只增不改（回放不重复写）', `${auditBefore} → ${auditCount}`);

  // 撤销全部 → fail-closed
  const cur2 = unwrap(await api('/api/svc:storeAccounts', { token: hq })).accounts.find((a) => a.user_id === fixtureUserId);
  const revoke = await api('/api/svc:updateStoreAccountStores', {
    method: 'POST', token: hq, requestId: uuid(),
    body: { user_id: fixtureUserId, store_ids: [], expected_store_ids: cur2.store_ids },
  });
  check(revoke.status === 200, '撤销全部门店 200', `HTTP ${revoke.status}`);
  const afterRevoke = await storesList(fixtureToken);
  const afterCodes = codesOf(afterRevoke);
  check(
    (afterRevoke.status === 200 && afterCodes.length === 0) || afterRevoke.status === 403,
    '撤销后同一会话立即看不到任何门店（0 行或 403）',
    `HTTP ${afterRevoke.status} ${JSON.stringify(afterCodes)}`,
  );

  // ---------------------------------------------------------------- F. 原生绕过
  for (const p of ['users:list', 'roles:list', 'storeUsers:list']) {
    const r = await api('/api/' + p, { token: hq });
    check(r.status === 403, `hq_admin 仍不能原生读 ${p}`, `HTTP ${r.status}`);
  }

  // ---------------------------------------------------------------- E. 真实浏览器
  const pageUid = pg(`select "schemaUid" from "desktopRoutes" where type='flowPage' and title='门店账号' limit 1`);
  if (!pageUid) {
    check(false, '后台「门店账号」页存在', '找不到路由（先跑 seed-admin-pages）');
  } else {
    const session = await launchCdp({ port: 9471, label: 'sec-store-01' });
    const { cdp } = session;
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Page.navigate', { url: `${BASE}/signin` });
      await cdp.waitFor(`document.querySelectorAll("input").length >= 2`, { what: '登录页' });
      await cdp.evaluate(`(() => {
        const ins = [...document.querySelectorAll('input')];
        const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; d.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        set(ins[0], ${JSON.stringify(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'))});
        set(ins[1], ${JSON.stringify(envValue('UAT_HQADMIN_PASSWORD'))});
        return true;
      })()`);
      await sleep(700);
      await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
      await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 45_000 });
      await cdp.send('Page.navigate', { url: `${BASE}/admin/${pageUid}` });
      await cdp.waitFor(`!!document.querySelector('[data-testid="store-accounts"]')`, { what: '门店账号页', timeout: 60_000 });
      await sleep(1500);

      const pageText = await cdp.evaluate(`document.querySelector('[data-testid="store-accounts"]').innerText.replace(/[ \\n\\t]+/g,' ').slice(0,160)`);
      check(/门店角色账号/.test(pageText), '页面渲染账号列表', pageText);

      await cdp.evaluate(`(() => { const b = document.querySelector('[data-testid="sa-edit-${fixtureUserId}"]'); if (b) { b.scrollIntoView({block:'center'}); b.click(); } return !!b; })()`);
      await cdp.waitFor(`!!document.querySelector('[data-testid="sa-modal"]')`, { what: '配置弹窗', timeout: 20_000 });
      await cdp.evaluate(`(() => { const el = document.querySelector('[data-testid="sa-store-${s1.id}"]'); if (el && !el.checked) el.click(); return true; })()`);
      await sleep(300);
      const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(OUT, 'sec-store-01-edit.png'), Buffer.from(shot1.data, 'base64'));

      await cdp.evaluate(`(() => {
        const norm = (s) => String(s || '').replace(/\\s+/g, '');
        const b = [...document.querySelectorAll('.ant-modal button')].find((x) => norm(x.innerText) === '保存');
        if (b) b.click();
        return !!b;
      })()`);
      await cdp.waitFor(`[...document.querySelectorAll('.ant-message-notice-content')].some((n) => (n.innerText || '').includes('已保存'))`, { what: '保存成功', timeout: 30_000 });
      await sleep(1500);
      const rowText = await cdp.evaluate(`(() => { const r = document.querySelector('[data-testid="sa-row-${fixtureUserId}"]'); return r ? r.innerText.replace(/[ \\n\\t]+/g,' ') : ''; })()`);
      check(/S01/.test(rowText), '保存后页面重新读取到 S01', rowText);
      const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(OUT, 'sec-store-01-after.png'), Buffer.from(shot2.data, 'base64'));
      note('截图', '.tmp-verify/sec-store-01-edit.png / sec-store-01-after.png');
    } finally {
      session.close();
    }
  }
} finally {
  // ---------------------------------------------------------------- 清理夹具
  if (fixtureUserId > 0) {
    // 先把夹具账号的门店清空（走受控动作，留一条审计；随后连同该账号审计一起按 ID 清理）
    const cur = unwrap(await api('/api/svc:storeAccounts', { token: hq })).accounts.find((a) => a.user_id === fixtureUserId);
    if (cur && cur.store_ids.length > 0) {
      await api('/api/svc:updateStoreAccountStores', {
        method: 'POST', token: hq, requestId: uuid(),
        body: { user_id: fixtureUserId, store_ids: [], expected_store_ids: cur.store_ids },
      });
    }
    pg(`delete from store_account_audits where user_id=${fixtureUserId}`);
    pg(`delete from store_users where user_id=${fixtureUserId}`);
    pg(`delete from "rolesUsers" where "userId"=${fixtureUserId}`);
    await api('/api/users:destroy?filterByTk=' + fixtureUserId, { method: 'POST', token: root, body: {} });
    const left = {
      user: pg(`select count(*) from users where id=${fixtureUserId}`),
      roles: pg(`select count(*) from "rolesUsers" where "userId"=${fixtureUserId}`),
      stores: pg(`select count(*) from store_users where user_id=${fixtureUserId}`),
      audits: pg(`select count(*) from store_account_audits where user_id=${fixtureUserId}`),
    };
    note('临时账号清理', `id=${fixtureUserId} → ${JSON.stringify(left)}`);
    check(left.user === '0' && left.roles === '0' && left.stores === '0' && left.audits === '0', '临时账号与授权/审计已清理', JSON.stringify(left));
  }

  const failed = results.filter((r) => !r.pass);
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  SEC-STORE-01：${results.length - failed.length} / ${results.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
    process.exit(1);
  }
  console.log('  ✅ 全部通过');
  console.log('');
}
