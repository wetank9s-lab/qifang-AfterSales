#!/usr/bin/env node
/**
 * verify-ux-01c-store-profile.mjs —— 门店资料管理专项门禁（UX-01C-R7）
 *
 * ===========================================================================
 * 它证明什么（对应用户第七轮 §二~§五）
 * ===========================================================================
 *   A. 原生写入口对业务角色**全部拒绝**（update / create / destroy / upsert / bulkUpdate）；
 *   B. 受控接口：只有 hq_admin；字段白名单（code 不可写）；422 中文校验；
 *   C. 并发：同一 expected_value 两请求 ⇒ 200 + 409；只多一条审计；
 *   D. 幂等：同一 X-Request-Id 重试 ⇒ 回放、**不再写审计**；
 *   E. 恢复：scene=restore 再写一条审计（不回改历史）；
 *   F. 客户 H5：名称 / 电话 / 地址真实生效；电话为空 ⇒ null（不编造）；
 *   G. 启停：停用后签名入口 404 + 新报修被拒；**历史工单仍可查看**；恢复后原签名入口仍有效；
 *   H. 真实浏览器：hq_admin 编辑闭环（保存→刷新→重开）；422 提示；409 后重读；非管理员被拒；
 *   I. 重启后数据与审计仍在；
 *   J. 测试结束按 **ID** 精确清理夹具（T98 门店 + 它的工单 + 审计）。
 *
 * ⚠️ 夹具用独立 UAT 门店 `T98`（SQL 建、只在本门禁内存在），**绝不动真实 15 家门店**。
 *    SMS 保持 mock；本门禁不触发任何对外短信。
 *
 * 用法：node scripts/verify-ux-01c-store-profile.mjs
 * 退出码：0 通过 / 1 判据不满足 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SVC_BASE_URL } from './lib/base-url.mjs';
import { launchCdp, sleep, psql, psqlRows } from './verify-store-ui-primary-action.mjs';
import { cleanupTicket, psqlExec, psqlScalar } from './technician-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.tmp-verify');
const PAGE_UID = 'qbr4apqripv';
const ORIGIN = new URL(SVC_BASE_URL).origin;
const FIXTURE_CODE = 'T98';
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
  if (r.status !== 200) throw new Error(`${fallback} 登录失败 HTTP ${r.status}`);
  return (await r.json()).data.token;
}

const uuid = () => crypto.randomUUID();

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

async function apiPost(token, pathname, body, requestId = uuid()) {
  const r = await fetch(`${SVC_BASE_URL}/api/${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Request-Id': requestId,
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* noop */
  }
  return { status: r.status, json, text, requestId };
}

async function updateProfile(token, storeId, field, value, expected, { scene = 'update', requestId = uuid() } = {}) {
  return apiPost(
    token,
    `svc:updateStoreProfile?filterByTk=${storeId}`,
    expected === undefined ? { field, value, scene } : { field, value, expected_value: expected, scene },
    requestId,
  );
}

const auditCount = (storeId) =>
  Number(String(psqlScalar(`select count(*) from store_profile_audits where store_id=${storeId}`) ?? '0').trim());
const storeRow = (id) =>
  psqlRows(`select code,name,coalesce(contact_phone,'<null>'),coalesce(address,'<null>'),active::text from stores where id=${id}`)[0];

function publicEntryUrl(entry) {
  return `${SVC_BASE_URL}/api/public/store-entry?k=${encodeURIComponent(entry)}`;
}

function restartApp() {
  spawnSync('docker', ['compose', 'restart', 'app'], { cwd: ROOT, stdio: 'ignore' });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const r = spawnSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', 'svc-app'], { encoding: 'utf8' });
    if (String(r.stdout).trim() === 'healthy') {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  throw new Error('等待 svc-app healthy 超时');
}

// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  UX-01C-R7：门店资料管理（受控修改 + 审计 + 启停 + H5 生效）');
console.log('══════════════════════════════════════════════════════════════');

// ---- 0. 夹具门店（T98）---------------------------------------------------
let fixtureId = null;
let fixtureTicketId = null;
{
  const existing = psqlRows(`select id,name from stores where code='${FIXTURE_CODE}'`);
  if (existing.length > 0) {
    const [id, name] = existing[0];
    if (!String(name).startsWith('R7门店夹具')) {
      console.log(`  ⛔ ${FIXTURE_CODE} 已存在且不是本门禁夹具（name=${name}）—— 拒绝运行`);
      process.exit(2);
    }
    fixtureId = Number(id);
    psqlExec(`delete from store_profile_audits where store_id=${fixtureId}`);
    note('复用残留夹具', `#${fixtureId}（已清审计）`);
  } else {
    // ⚠️ psql `-c` 会在结果后面多打一行命令标签（`INSERT 0 1`），
    //    直接 Number(整段) 会得到 NaN —— 只取第一行。
    const raw = String(
      psqlScalar(
        `insert into stores (code,name,active,sort_order,contact_phone,address,created_at,updated_at)` +
          ` values ('${FIXTURE_CODE}','R7门店夹具',true,999,null,null,now(),now()) returning id`,
      ),
    ).trim();
    fixtureId = Number(raw.split(String.fromCharCode(10))[0].trim());
    if (!fixtureId) {
      console.log('  ⛔ 无法创建隔离门店夹具 —— 环境未就绪');
      process.exit(2);
    }
  }
  note('隔离门店夹具', `${FIXTURE_CODE} · id=${fixtureId}（仅本门禁使用，结束按 ID 清理）`);
}

const tokens = {};
try {
  tokens.hqAdmin = await login('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local');
  tokens.hq = await login('UAT_HQ_EMAIL', 'uat.hq@svc.local');
  tokens.storeA = await login('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local');
  tokens.viewer = await login('UAT_VIEWER_EMAIL', 'uat.viewer@svc.local');
} catch (error) {
  console.log(`  ⛔ ${String(error?.message ?? error)}`);
  process.exit(2);
}

try {
  // ---- A. 原生写入口收口 ------------------------------------------------
  console.log('');
  console.log('  A. 原生写入口：业务角色全部拒绝（不走受控接口就改不了）');
  {
    const before = storeRow(fixtureId);
    const roles = [
      ['hq_admin', tokens.hqAdmin],
      ['hq_after_sales', tokens.hq],
      ['store_A', tokens.storeA],
      ['viewer', tokens.viewer],
    ];
    for (const [role, token] of roles) {
      const upd = await apiPost(token, `stores:update?filterByTk=${fixtureId}`, { name: '__bypass__' });
      const del = await apiPost(token, `stores:destroy?filterByTk=${fixtureId}`, {});
      const cre = await apiPost(token, `stores:create`, { code: 'T99', name: '__bypass__' });
      const bulk = await apiPost(token, `stores:bulkUpdate?filter=${encodeURIComponent(JSON.stringify({ id: fixtureId }))}`, {
        values: { name: '__bypass__' },
      });
      check(
        upd.status === 403 && del.status === 403 && cre.status === 403 && (bulk.status === 403 || bulk.status === 404),
        `${role}：原生 update/destroy/create/bulkUpdate 全部被拒`,
        `update=${upd.status} destroy=${del.status} create=${cre.status} bulk=${bulk.status}`,
      );
    }
    const after = storeRow(fixtureId);
    check(JSON.stringify(before) === JSON.stringify(after), '绕过尝试后夹具门店未被改动', `${before.join('|')}`);
    const anon = await apiPost('', `stores:update?filterByTk=${fixtureId}`, { name: '__anon__' });
    check(anon.status === 401 || anon.status === 403, '匿名原生写被拒', `HTTP ${anon.status}`);
  }

  // ---- B. 受控读 + 权限 + 校验 -----------------------------------------
  console.log('');
  console.log('  B. 受控接口：权限 / 白名单 / 422 校验');
  {
    const hq = await apiGet(tokens.hqAdmin, `svc:storeProfile?filterByTk=${fixtureId}`);
    const store = hq.json?.data?.store;
    check(hq.status === 200 && store?.code === FIXTURE_CODE, 'hq_admin 读门店资料 200', `HTTP ${hq.status}`);
    check(
      store && JSON.stringify(Object.keys(store).sort()) === JSON.stringify(['active', 'address', 'code', 'contact_phone', 'id', 'name']),
      '读模型只回 4 个可编辑字段 + code',
      store ? Object.keys(store).sort().join(',') : '',
    );
    check(Array.isArray(hq.json?.data?.fields) && hq.json.data.fields.length === 4, '同时下发 4 个字段的规格（label/max）');

    for (const [role, token] of [['hq_after_sales', tokens.hq], ['store_A', tokens.storeA], ['viewer', tokens.viewer]]) {
      const r = await apiGet(token, `svc:storeProfile?filterByTk=${fixtureId}`);
      check(r.status === 403, `${role} 读门店资料 403`, `HTTP ${r.status}`);
      const w = await updateProfile(token, fixtureId, 'name', 'x', undefined);
      check(w.status === 403, `${role} 写门店资料 403`, `HTTP ${w.status}`);
    }

    const cases = [
      ['name', '', 'STORE_NAME_REQUIRED'],
      ['name', 'x'.repeat(65), 'STORE_NAME_TOO_LONG'],
      ['contact_phone', 'abc-def', 'STORE_PHONE_INVALID'],
      ['contact_phone', '1234', 'STORE_PHONE_INVALID'],
      ['address', 'x'.repeat(201), 'STORE_ADDRESS_TOO_LONG'],
      ['active', 'yes', 'STORE_ACTIVE_INVALID'],
    ];
    for (const [field, value, expectCode] of cases) {
      const r = await updateProfile(tokens.hqAdmin, fixtureId, field, value, undefined);
      const code = r.json?.errors?.[0]?.code;
      check(r.status === 422 && code === expectCode, `422：${field}=${String(value).slice(0, 12)} ⇒ ${expectCode}`, `HTTP ${r.status} code=${code}`);
    }
    const codeWrite = await updateProfile(tokens.hqAdmin, fixtureId, 'code', 'T97', undefined);
    check(
      codeWrite.status === 422 && codeWrite.json?.errors?.[0]?.code === 'STORE_CODE_READONLY',
      'code 不可写（422 STORE_CODE_READONLY）',
      `HTTP ${codeWrite.status}`,
    );
    const notWritable = await updateProfile(tokens.hqAdmin, fixtureId, 'sort_order', '1', undefined);
    check(notWritable.status === 422, '白名单外字段 422', `HTTP ${notWritable.status}`);
  }

  // ---- C. 正常修改 → 审计 → H5 生效 ------------------------------------
  console.log('');
  console.log('  C. 修改 / 审计 / 客户 H5 生效');
  let entryBefore = '';
  {
    const links = await apiGet(tokens.hqAdmin, 'svc:storeEntryLinks');
    const item = (links.json?.data?.items ?? []).find((x) => x.code === FIXTURE_CODE);
    check(Boolean(item), '后台接口能取到夹具门店入口');
    entryBefore = String(item?.entry ?? '');

    const n0 = auditCount(fixtureId);
    const upd = await updateProfile(tokens.hqAdmin, fixtureId, 'name', 'R7门店夹具-已改名', 'R7门店夹具');
    check(upd.status === 200 && upd.json?.data?.data?.value === 'R7门店夹具-已改名', '改名 200', `HTTP ${upd.status}`);
    check(storeRow(fixtureId)[1] === 'R7门店夹具-已改名', '库里名称已更新');
    check(auditCount(fixtureId) === n0 + 1, '新增一条审计', `${n0} → ${auditCount(fixtureId)}`);
    const audit = psqlRows(
      `select field,coalesce(old_value,'<null>'),coalesce(new_value,'<null>'),scene,coalesce(request_id,'') from store_profile_audits where store_id=${fixtureId} order by id desc limit 1`,
    )[0];
    check(audit[0] === 'name' && audit[1] === 'R7门店夹具' && audit[2] === 'R7门店夹具-已改名', '审计 old→new 正确', audit.join(' → '));

    const links2 = await apiGet(tokens.hqAdmin, 'svc:storeEntryLinks');
    const item2 = (links2.json?.data?.items ?? []).find((x) => x.code === FIXTURE_CODE);
    check(String(item2?.entry ?? '') === entryBefore, '改名**不影响**签名入口（entry 只依赖 code）', `${entryBefore.slice(0, 12)}…`);

    // 电话：设置 → H5 生效；清空 → null
    const p1 = await updateProfile(tokens.hqAdmin, fixtureId, 'contact_phone', '028-12345678', null);
    check(p1.status === 200, '设置对外电话（座机格式）200', `HTTP ${p1.status}`);
    let pub = await apiGet('', `public/store-entry?k=${encodeURIComponent(entryBefore)}`);
    check(pub.json?.data?.phone === '028-12345678', '客户 H5 读到真实电话', String(pub.json?.data?.phone));
    check(pub.json?.data?.name === 'R7门店夹具-已改名', '客户 H5 读到新名称', String(pub.json?.data?.name));

    const p2 = await updateProfile(tokens.hqAdmin, fixtureId, 'contact_phone', '', '028-12345678');
    check(p2.status === 200 && storeRow(fixtureId)[2] === '<null>', '清空电话 ⇒ 落库 NULL（不编造假号码）', storeRow(fixtureId)[2]);
    pub = await apiGet('', `public/store-entry?k=${encodeURIComponent(entryBefore)}`);
    check(pub.json?.data?.phone === null, '客户 H5 电话为空时返回 null', String(pub.json?.data?.phone));

    const a1 = await updateProfile(tokens.hqAdmin, fixtureId, 'address', '成都市高新区测试路 98 号', null);
    check(a1.status === 200, '设置地址 200', `HTTP ${a1.status}`);
    pub = await apiGet('', `public/store-entry?k=${encodeURIComponent(entryBefore)}`);
    check(pub.json?.data?.address === '成都市高新区测试路 98 号', '客户 H5 读到新地址', String(pub.json?.data?.address));

    // 恢复名称（scene=restore）→ 再写一条审计
    const n1 = auditCount(fixtureId);
    const restore = await updateProfile(tokens.hqAdmin, fixtureId, 'name', 'R7门店夹具', 'R7门店夹具-已改名', {
      scene: 'restore',
    });
    check(restore.status === 200, '恢复名称 200', `HTTP ${restore.status}`);
    const last = psqlRows(
      `select scene from store_profile_audits where store_id=${fixtureId} order by id desc limit 1`,
    )[0][0];
    check(auditCount(fixtureId) === n1 + 1 && last === 'restore', '恢复也留审计（scene=restore）', `scene=${last}`);
  }

  // ---- D. 并发 409 + 幂等 ----------------------------------------------
  console.log('');
  console.log('  D. 并发 409 与幂等（重复请求不产生额外审计）');
  {
    const n0 = auditCount(fixtureId);
    const before = storeRow(fixtureId)[1];
    const [a, b] = await Promise.all([
      updateProfile(tokens.hqAdmin, fixtureId, 'name', 'R7并发-A', before),
      updateProfile(tokens.hqAdmin, fixtureId, 'name', 'R7并发-B', before),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    check(statuses[0] === 200 && statuses[1] === 409, '两请求同 expected ⇒ 200 + 409', statuses.join(','));
    check(auditCount(fixtureId) === n0 + 1, '并发只多一条审计', `${n0} → ${auditCount(fixtureId)}`);
    const winner = storeRow(fixtureId)[1];
    check(winner === 'R7并发-A' || winner === 'R7并发-B', '库里是胜出请求的值', winner);

    // 幂等：同一 request id 重放同一笔
    const rid = uuid();
    const cur = storeRow(fixtureId)[1];
    const n1 = auditCount(fixtureId);
    const first = await updateProfile(tokens.hqAdmin, fixtureId, 'name', 'R7幂等-一次', cur, { requestId: rid });
    const second = await updateProfile(tokens.hqAdmin, fixtureId, 'name', 'R7幂等-一次', cur, { requestId: rid });
    check(first.status === 200 && second.status === 200, '同 request id 两次都 200', `${first.status}/${second.status}`);
    check(second.json?.data?.data?.replayed === true, '第二次标记为幂等回放（replayed=true）');
    check(auditCount(fixtureId) === n1 + 1, '幂等回放**不**新增审计', `${n1} → ${auditCount(fixtureId)}`);
  }

  // ---- E. 启停：新报修拒绝 / 历史工单仍可查 / 恢复后签名不变 -------------
  console.log('');
  console.log('  E. 停用与恢复（仅夹具门店）');
  let fixtureTicketNo = null;
  {
    // 先建一张夹具工单（启用状态）
    const tk = await fetch(`${SVC_BASE_URL}/api/public/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Request-Id': uuid() },
      body: JSON.stringify({
        k: entryBefore,
        ticket_type: 'repair',
        content: 'UX01C-R7 夹具：用于验证停用后历史工单仍可查看',
        customer_name: 'R7夹具客户',
        customer_mobile: '13800000004',
      }),
    });
    const tj = await tk.json().catch(() => null);
    fixtureTicketNo = tj?.data?.ticket_no ?? null;
    check((tk.status === 200 || tk.status === 201) && Boolean(fixtureTicketNo), '启用状态下可用签名入口建单', `HTTP ${tk.status}`);
    fixtureTicketId = Number(
      String(psqlScalar(`select id from service_tickets where ticket_no='${fixtureTicketNo}'`) ?? '').trim(),
    );

    const off = await updateProfile(tokens.hqAdmin, fixtureId, 'active', false, true);
    check(off.status === 200 && storeRow(fixtureId)[4] === 'false', '停用成功（active=false）', `HTTP ${off.status}`);
    const offAudit = psqlRows(
      `select old_value,new_value,scene from store_profile_audits where store_id=${fixtureId} and field='active' order by id desc limit 1`,
    )[0];
    check(JSON.stringify(offAudit) === JSON.stringify(['true', 'false', 'update']), '停用留审计 true→false', JSON.stringify(offAudit));

    const entry = await fetch(publicEntryUrl(entryBefore));
    check(entry.status === 404, '停用后签名入口 404（对外与不存在同形）', `HTTP ${entry.status}`);

    const blocked = await fetch(`${SVC_BASE_URL}/api/public/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Request-Id': uuid() },
      body: JSON.stringify({
        k: entryBefore,
        ticket_type: 'repair',
        content: 'UX01C-R7 夹具：停用后不应建单成功',
        customer_name: 'R7夹具客户',
        customer_mobile: '13800000005',
      }),
    });
    check(blocked.status >= 400, '停用后新报修被拒绝', `HTTP ${blocked.status}`);

    if (fixtureTicketId) {
      const tl = await apiGet(tokens.hqAdmin, `svc:timeline?filterByTk=${fixtureTicketId}`);
      check(tl.status === 200 && tl.json?.data?.ticket?.ticket_no === fixtureTicketNo, '停用后历史工单仍可查看', `HTTP ${tl.status}`);
    }

    const on = await updateProfile(tokens.hqAdmin, fixtureId, 'active', true, false, { scene: 'restore' });
    check(on.status === 200 && storeRow(fixtureId)[4] === 'true', '恢复启用成功', `HTTP ${on.status}`);
    const back = await fetch(publicEntryUrl(entryBefore));
    check(back.status === 200, '恢复后**原签名入口**仍然有效（码没变）', `HTTP ${back.status}`);
    const links3 = await apiGet(tokens.hqAdmin, 'svc:storeEntryLinks');
    const item3 = (links3.json?.data?.items ?? []).find((x) => x.code === FIXTURE_CODE);
    check(String(item3?.entry ?? '') === entryBefore, '恢复后 entry 与停用前一致');
  }

  // ---- F. 真实浏览器 ---------------------------------------------------
  console.log('');
  console.log('  F. 真实浏览器（hq_admin 编辑闭环 / 422 / 409 / 非管理员被拒）');
  {
    const session = await launchCdp({ label: 'r7-ui' });
    const { cdp } = session;
    try {
      const loginAs = async (emailKey, fallback) => {
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
        await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/admin/${PAGE_UID}` });
        await sleep(4500);
        await cdp.waitFor('document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length > 0', { what: '门店列表', timeout: 45_000 });
        await sleep(800);
      };
      const openProfile = async () => {
        const ok = await cdp.evaluate(`(() => {
          const tr = [...document.querySelectorAll('.ant-table-tbody tr[data-row-key]')].find((r) => r.innerText.includes('${FIXTURE_CODE}'));
          const b = tr?.querySelector('[data-testid="store-profile-action"]');
          if (b) { b.click(); return true; }
          return false;
        })()`);
        if (!ok) return false;
        await cdp.waitFor(`!!document.querySelector('[data-testid="store-profile-modal"]')`, { what: '门店资料弹窗', timeout: 20_000 });
        return true;
      };
      const setInput = async (testid, value) => {
        await cdp.evaluate(`(() => {
          const el = document.querySelector('[data-testid="${testid}"]');
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
          setter.call(el, ${JSON.stringify(value)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        await sleep(200);
      };
      const clickSave = async () => {
        const clicked = await cdp.evaluate(`(() => {
          const norm = (s) => String(s || '').replace(/\\s+/g, '');
          const b = [...document.querySelectorAll('.ant-modal button')].find((x) => norm(x.innerText) === '保存');
          if (b) { b.click(); return true; }
          return false;
        })()`);
        if (!clicked) throw new Error('找不到保存按钮');
      };
      const toastText = () =>
        cdp.evaluate(`[...document.querySelectorAll('.ant-message-notice-content')].map((n) => n.innerText).join(' | ')`);

      // --- hq_admin：正常编辑 ---
      await loginAs('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local');
      check(await openProfile(), 'hq_admin 能打开「门店资料」弹窗');
      // ⚠️ 期望值必须取**库里当前值**（前面 D 段已经改过名字）——
      //    写死早期值会让一条本来正确的实现被误判成红。
      const dbNow = storeRow(fixtureId);
      const dbName = dbNow[1];
      const dbPhone = dbNow[2] === '<null>' ? '' : dbNow[2];
      const dbAddress = dbNow[3] === '<null>' ? '' : dbNow[3];
      const dbActive = dbNow[4] === 'true';
      const shown = await cdp.evaluate(`(() => {
        const v = (id) => document.querySelector('[data-testid="' + id + '"]')?.value ?? null;
        const active = document.querySelector('[data-testid="store-profile-active"]');
        return {
          name: v('store-profile-name'),
          phone: v('store-profile-phone'),
          address: v('store-profile-address'),
          activeChecked: active ? active.checked : null,
          hasCodeText: /门店编码：T98/.test(document.querySelector('[data-testid="store-profile-modal"]')?.innerText || ''),
        };
      })()`);
      check(
        shown.name === dbName && shown.phone === dbPhone && shown.address === dbAddress && shown.activeChecked === dbActive,
        '弹窗显示真实当前值（名称/电话/地址/启用）',
        `UI=${JSON.stringify(shown)} DB=${JSON.stringify({ name: dbName, phone: dbPhone, address: dbAddress, active: dbActive })}`,
      );
      check(shown.hasCodeText, '弹窗显示只读门店编码');

      const newName = `R7浏览器改名-${Date.now().toString().slice(-6)}`;
      await setInput('store-profile-name', newName);
      await setInput('store-profile-phone', '400-800-1234');
      await setInput('store-profile-address', '成都市测试区浏览器路 7 号');
      await clickSave();
      try {
        await cdp.waitFor(
          `[...document.querySelectorAll('.ant-message-notice-content')].some((n) => (n.innerText || '').includes('已保存门店资料'))`,
          { what: '保存成功提示', timeout: 30_000 },
        );
      } catch (error) {
        const t = await toastText();
        const stillOpen = await cdp.evaluate(`!!document.querySelector('[data-testid="store-profile-modal"]')`);
        throw new Error(`${String(error?.message ?? error)}；提示=${t.slice(0, 200)}；弹窗仍开=${stillOpen}`);
      }
      await cdp.waitFor(`!document.querySelector('[data-testid="store-profile-modal"]')`, { what: '弹窗关闭', timeout: 20_000 });
      await sleep(1500);
      const rowText = await cdp.evaluate(`(() => {
        const tr = [...document.querySelectorAll('.ant-table-tbody tr[data-row-key]')].find((r) => r.innerText.includes('${FIXTURE_CODE}'));
        return (tr?.innerText || '').replace(/\\s+/g, ' ');
      })()`);
      check(rowText.includes(newName), '保存后页面立即显示新名称', rowText.slice(0, 100));
      check(storeRow(fixtureId)[1] === newName, '库里已更新（页面不是内存态）');

      // 重开确认
      check(await openProfile(), '保存后可重新打开弹窗');
      const shown2 = await cdp.evaluate(`(() => {
        const v = (id) => document.querySelector('[data-testid="' + id + '"]')?.value ?? null;
        return { name: v('store-profile-name'), phone: v('store-profile-phone'), address: v('store-profile-address') };
      })()`);
      check(shown2.name === newName && shown2.phone === '400-800-1234' && shown2.address === '成都市测试区浏览器路 7 号', '重开后显示数据库最新值', JSON.stringify(shown2));
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT_DIR, 'ux01c-r7-store-profile-modal.png'), Buffer.from(shot.data, 'base64'));

      // --- 422：名称清空 ---
      await setInput('store-profile-name', '');
      await clickSave();
      await cdp.waitFor(
        `[...document.querySelectorAll('.ant-message-notice-content')].some((n) => (n.innerText || '').includes('422'))`,
        { what: '422 提示', timeout: 30_000 },
      );
      const err422 = await toastText();
      check(/422/.test(err422) && /门店名称不能为空/.test(err422), '422 显示可理解的中文校验', err422.replace(/\s+/g, ' ').slice(0, 160));
      check(Boolean(await cdp.evaluate(`!!document.querySelector('[data-testid="store-profile-modal"]')`)), '422 后弹窗保持打开');
      // 取消关闭
      await cdp.evaluate(`(() => { const norm = (s) => String(s||'').replace(/\\s+/g,''); const b=[...document.querySelectorAll('.ant-modal button')].find(x=>norm(x.innerText)==='取消'); if(b)b.click(); return true; })()`);
      await sleep(600);
      await cdp.evaluate(`(() => { const norm = (s) => String(s||'').replace(/\\s+/g,''); const b=[...document.querySelectorAll('.ant-modal button')].find(x=>norm(x.innerText)==='放弃并关闭'); if(b)b.click(); return true; })()`);
      await sleep(800);

      // --- 409：弹窗内旧值 vs 外部已改 ---
      check(await openProfile(), '409 用例：打开弹窗（持有旧值）');
      const staleName = storeRow(fixtureId)[1];
      const ext = await updateProfile(tokens.hqAdmin, fixtureId, 'name', 'R7外部管理员改名', staleName);
      check(ext.status === 200, '另一管理员在弹窗打开期间改了名称', `HTTP ${ext.status}`);
      await setInput('store-profile-name', 'R7本地保存尝试');
      await clickSave();
      await cdp.waitFor(
        `[...document.querySelectorAll('.ant-message-notice-content')].some((n) => (n.innerText || '').includes('409'))`,
        { what: '409 提示', timeout: 30_000 },
      );
      const err409 = await toastText();
      check(/409/.test(err409) && /已被其他管理员修改/.test(err409), '409 提示"已被其他管理员修改"', err409.replace(/\s+/g, ' ').slice(0, 160));
      await cdp.waitFor(`!document.querySelector('[data-testid="store-profile-modal"]')`, { what: '409 后关闭弹窗', timeout: 20_000 });
      await sleep(1200);
      const rowAfter409 = await cdp.evaluate(`(() => {
        const tr = [...document.querySelectorAll('.ant-table-tbody tr[data-row-key]')].find((r) => r.innerText.includes('${FIXTURE_CODE}'));
        return (tr?.innerText || '').replace(/\\s+/g, ' ');
      })()`);
      check(rowAfter409.includes('R7外部管理员改名'), '409 后页面重新读取为外部值（不静默覆盖）', rowAfter409.slice(0, 100));

    } finally {
      session.close();
    }
  }

  // --- 非管理员：**独立会话**（同一会话已登录 hq_admin，跳 /signin 不会回到登录页）---
  {
    const session2 = await launchCdp({ label: 'r7-ui-store' });
    const { cdp } = session2;
    try {
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
        setVal(ins[0], ${JSON.stringify(envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'))});
        setVal(ins[1], ${JSON.stringify(envValue('UAT_STORE_A_PASSWORD'))});
        return true;
      })()`);
      await sleep(700);
      await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
      await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '门店账号登录', timeout: 45_000 });
      await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/admin/${PAGE_UID}` });
      await sleep(4500);
      await cdp.waitFor('document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length > 0', { what: '门店列表', timeout: 45_000 });
      const clickRes = await cdp.evaluate(`(() => {
        const tr = [...document.querySelectorAll('.ant-table-tbody tr[data-row-key]')].find((r) => r.innerText.includes('S01'));
        const b = tr?.querySelector('[data-testid="store-profile-action"]');
        if (!b) return 'no-button';
        b.click();
        return 'clicked';
      })()`);
      if (clickRes === 'clicked') {
        await sleep(1600);
        const t = await cdp.evaluate(`[...document.querySelectorAll('.ant-message-notice-content')].map((n) => n.innerText).join(' | ')`);
        const opened = await cdp.evaluate(`!!document.querySelector('[data-testid="store-profile-modal"]')`);
        check(/仅总部管理员/.test(t) && !opened, '非 hq_admin 点击被拒且不打开弹窗', t.slice(0, 120));
      } else {
        note('非管理员按钮', '门店账号页面没有该按钮（按角色隐藏）');
        check(true, '非 hq_admin 无法进入编辑（按钮不存在）');
      }
    } finally {
      session2.close();
    }
  }

  // ---- G. 重启后仍在 ---------------------------------------------------
  console.log('');
  console.log('  G. 重启后数据与审计仍在');
  {
    const before = storeRow(fixtureId);
    const n = auditCount(fixtureId);
    restartApp();
    const token = await login('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local');
    const after = storeRow(fixtureId);
    check(JSON.stringify(before) === JSON.stringify(after), '重启后门店资料保持', after.join('|'));
    check(auditCount(fixtureId) === n, '重启后审计条数不变', `${n}`);
    const r = await apiGet(token, `svc:storeProfile?filterByTk=${fixtureId}`);
    check(r.status === 200, '重启后受控读取仍可用', `HTTP ${r.status}`);
  }
} finally {
  // ---- H. 精确清理 -----------------------------------------------------
  console.log('');
  console.log('  H. 夹具清理（按 ID）');
  try {
    if (fixtureTicketId) {
      cleanupTicket(fixtureTicketId);
      note('已清理夹具工单', `#${fixtureTicketId}`);
    }
    // 可能还有其它以 T98 建的工单（异常路径留下的）
    const leftover = psqlRows(`select id from service_tickets where store_id=${fixtureId}`);
    for (const [id] of leftover) {
      cleanupTicket(Number(id));
      note('已清理残留夹具工单', `#${id}`);
    }
    psqlExec(`delete from store_profile_audits where store_id=${fixtureId}`);
    psqlExec(`delete from stores where id=${fixtureId} and code='${FIXTURE_CODE}'`);
    const leftAudit = Number(String(psqlScalar(`select count(*) from store_profile_audits where store_id=${fixtureId}`) ?? '0').trim());
    const leftStore = Number(String(psqlScalar(`select count(*) from stores where id=${fixtureId}`) ?? '0').trim());
    const leftTicket = Number(String(psqlScalar(`select count(*) from service_tickets where store_id=${fixtureId}`) ?? '0').trim());
    check(leftAudit === 0 && leftStore === 0 && leftTicket === 0, '夹具已按 ID 精确清理（门店/审计/工单）', `audit=${leftAudit} store=${leftStore} ticket=${leftTicket}`);
  } catch (error) {
    check(false, '夹具清理', String(error?.message ?? error).slice(0, 160));
  }
}

// ---- 汇总 ----------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  结果：通过 ${results.length - failed.length} / 失败 ${failed.length}`);
if (failed.length) for (const f of failed) console.log(`    ❌ ${f.label}${f.detail ? ` —— ${f.detail}` : ''}`);
console.log('══════════════════════════════════════════════════════════════');
process.exit(failed.length ? 1 : 0);
