#!/usr/bin/env node
/**
 * =============================================================================
 *  verify-sms-pending-recovery.mjs —— B-16 验收：`pending` 孤儿回收
 * =============================================================================
 *
 * 契约依据：用户 2026-10-10 裁决「先关闭 B-16：建立短信 outbox pending 恢复机制，
 * **保证并发安全、重试可控、失效 Token 不重发**，并针对**事务提交后进程退出**
 * 等故障窗口提供**真实验证**」。
 *
 * -----------------------------------------------------------------------------
 * 这份验收刻意**不用"断言数量"代替真实业务验收**（用户明令）
 * -----------------------------------------------------------------------------
 * 它做的是一件很难伪造的事：**让应用在"事务已提交、短信还没发"的那一刻
 * 真的退出进程**（`svc:faultInject` 的第二个开关 + `process.exit(86)`），
 * 然后重启、让回收机制去收敛。下面是它依次核对的事实：
 *
 *   A. 故障窗口真的被制造出来了
 *      · 派工 HTTP 调用**断开**（进程没了）；
 *      · 库里该工单留下 **两条 `send_status='pending'`** 的 SmsLog；
 *      · 工单/Visit 的业务结果**已经生效**（提交过的就是提交了）；
 *      · **一条短信都没发出去**（发件箱里没有这张单）。
 *
 *   B. 年龄守卫：**年轻的孤儿不许动**
 *      · 未超龄时跑一轮回收 ⇒ `scanned = 0`。
 *        （这是"不抢正在发送中的行"那条守卫 —— 抢了就会给客户发第二遍。）
 *
 *   C. 分诊四象限（全部走**真实业务状态**，不是构造出来的假数据）
 *      | 场景 | 业务状态 | 期望 |
 *      |---|---|---|
 *      | A 客户派工通知 | 仍是那一次有效派工 | **补发**（发件箱可见 + params 与正常路径一致） |
 *      | A 师傅作业链接 | 明文已随进程丢失 | **不重发** + `TOKEN_LOST` |
 *      | B 客户派工通知 | visit 已被改派取代 | **不重发** + `STALE`（发出去是过期信息） |
 *      | B 师傅作业链接 | 凭据已失效（visit 非 ASSIGNED） | **不重发** + `TOKEN_INVALID` |
 *
 *   D. 并发安全：两轮回收**同时**发 ⇒ 每条孤儿只被发一次
 *   E. 幂等：再跑一轮 ⇒ 不再产生任何发送
 *
 * -----------------------------------------------------------------------------
 * ⚠️ 关于"把 created_at 回拨"（唯一一处人工构造，必须说清）
 * -----------------------------------------------------------------------------
 * 回收的年龄下限是 **5 分钟**、cron 也是 5 分钟。若不回拨，本脚本要么 sleep 5 分钟以上，
 * 要么靠等 cron tick —— 后者是"猜时机"，正是本项目反复吃亏的形状。
 * 回拨 `created_at` 等价于"这次崩溃发生在 6 分钟前"，**不改任何判定逻辑**：
 * 被验的仍是"回收到一条超龄 pending 时它做了什么"。
 * ⚠️ 与之相对，**A/B 的业务状态全部来自真实业务动作**（真派工、真改派），
 *    没有一条是直接写库造出来的。
 *
 * 退出码：0 全部通过 / 1 有未达标 / 2 环境未就绪
 * =============================================================================
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { SVC_BASE_URL, SVC_SCHEME } from './lib/base-url.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const STORE_EMAIL = 'uat.store.a@svc.local';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '0';

function envValue(key) {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return '';
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(fs.readFileSync(p, 'utf8'));
  return m ? m[1].trim() : '';
}

const SIGN_SECRET = envValue('SIGN_SECRET');
const STORE_PASSWORD = envValue('UAT_STORE_A_PASSWORD');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 断言框架（与其它门禁同一输出形状）
// ---------------------------------------------------------------------------
const state = { passed: 0, failures: [] };
function ok(name, detail) {
  state.passed += 1;
  console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`);
}
function no(name, detail) {
  state.failures.push({ name, detail });
  console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
}
async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    ok(name, detail);
  } catch (error) {
    no(name, String(error?.message ?? error).slice(0, 300));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------
function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}
function psqlRows(sql) {
  return psql(sql)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.split('|'));
}
function setSetting(key, value) {
  psql(`UPDATE service_settings SET value='${value}', updated_at=now() WHERE key='${key}'`);
}

async function httpJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（例如 502 页面）*/
  }
  return { status: res.status, json, text };
}

async function signIn(email, password) {
  const r = await httpJson(`${SVC_BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const token = r.json?.data?.token;
  if (!token) throw new Error(`登录失败 ${email}：HTTP ${r.status} ${r.text.slice(0, 160)}`);
  return token;
}

function svcPost(action, ticketId, token, body, extraHeaders = {}) {
  return httpJson(`${SVC_BASE_URL}/api/svc:${action}?filterByTk=${ticketId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Request-Id': crypto.randomUUID(),
      ...extraHeaders,
    },
    body: JSON.stringify(body ?? {}),
  });
}

/** 共享密钥闸的验收设施（faultInject / smsRecoverySweep） */
function diagPost(action, token, body, extraHeaders = {}) {
  return httpJson(`${SVC_BASE_URL}/api/svc:${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Svc-Diag-Key': SIGN_SECRET,
      ...extraHeaders,
    },
    body: JSON.stringify(body ?? {}),
  });
}

async function outboxItems(hq) {
  const r = await httpJson(`${SVC_BASE_URL}/api/svc:smsOutbox?since_seq=0&limit=200`, {
    headers: { Authorization: `Bearer ${hq}` },
  });
  const items = r.json?.data?.items ?? [];
  // 🔴 前置自检：本文件用 `biz_id` 做"精确归属"（哪条发件箱条目来自哪个 SmsLog）。
  //    接口把 provider 的 `bizId` 映射成 **snake_case 的 `biz_id`** 输出。
  //    第一版这里读了 `item.bizId` ⇒ 恒为 undefined ⇒ 所有"按 bizId 归属"的断言
  //    都变成"0 条"，而失败文案却说"没收到补发"——**把排障方向带到了产品身上**。
  //    ⇒ 一旦有条目却没有 `biz_id` 字段，就直接判红并说明是接口形状变了，
  //      不让"字段改名"伪装成"业务失败"。
  if (items.length > 0) {
    const withBizId = items.filter((i) => typeof i?.biz_id === 'string' && i.biz_id !== '');
    assert(
      withBizId.length > 0,
      `发件箱条目缺少 biz_id 字段（接口形状变了？）—— 实测 keys=${JSON.stringify(
        Object.keys(items[0] ?? {}),
      )}`,
    );
  }
  return items;
}

async function waitHealthy(timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${SVC_BASE_URL}/api/svc:health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (r.status === 200) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(2000);
  }
  return false;
}

function restartApp() {
  execFileSync('docker', ['compose', 'restart', 'app'], { cwd: ROOT, encoding: 'utf8' });
}

/** 造一张一次性工单（走真实匿名入口） */
async function createTicket(tag) {
  const mobile = `137${String(Date.now()).slice(-8)}`;
  const r = await httpJson(`${SVC_BASE_URL}/api/public/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
    body: JSON.stringify({
      store_code: 'S01',
      ticket_type: 'repair',
      content: `[B16 验收] ${tag}`,
      customer_name: 'B16验收',
      customer_mobile: mobile,
      privacy_agreed: true,
    }),
  });
  const ticketNo = r.json?.data?.ticket_no;
  assert(ticketNo, `匿名建单失败 HTTP ${r.status} ${r.text.slice(0, 160)}`);
  const id = Number(psql(`SELECT id FROM service_tickets WHERE ticket_no='${ticketNo}'`));
  assert(id > 0, `反查不到 ticket id（${ticketNo}）`);
  return { ticketId: id, ticketNo, mobile };
}

/** 派工（在注入开启时，这一句会让**服务端进程退出**） */
function dispatch(ticketId, token, note) {
  return svcPost(
    'dispatch',
    ticketId,
    token,
    {
      technician_name: 'B16师傅',
      technician_mobile: '13900010001',
      expected_visit_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      service_mode: 'inhouse',
      note: note ?? null,
    },
  ).catch((error) => ({ status: 0, error: String(error?.message ?? error) }));
}

const smsRowsOf = (ticketId) =>
  psqlRows(
    `SELECT scene, send_status, coalesce(error_code,'-') FROM sms_logs` +
      ` WHERE ticket_id=${ticketId} ORDER BY id`,
  );

/**
 * 取该工单的 **pending 行**（孤儿），返回 `{id, scene, bizId}`。
 *
 * 🔴 为什么一律**按 id / biz_id 定位**，而不是按 (ticket, scene) 取"最新一条"：
 *    本门禁里同一个 (工单, scene) 会存在**多行** —— 例如 D 段的 `reassign`
 *    会为同一张单再产生一组 `technician_task` / `dispatch_update`（走正常路径发出）。
 *    按"最新一条"断言，读到的其实是**改派那条**，于是把"孤儿没被重发"
 *    误判成"被重发了"（本门禁第一版就这么错了一次）。
 *    ⇒ 先捕获孤儿的行 id，之后**每一行孤立地看**。
 */
const pendingRowsOf = (ticketId) =>
  psqlRows(
    `SELECT id, scene, biz_id FROM sms_logs` +
      ` WHERE ticket_id=${ticketId} AND send_status='pending' ORDER BY id`,
  ).map((r) => ({ id: Number(r[0]), scene: r[1], bizId: r[2] }));

/** 一行孤儿的**完整结局**（状态 | 原因码 | 原因 —— 排障要能直接看到原因） */
const rowOutcomeOf = (id) =>
  psql(
    `SELECT coalesce(send_status,'-') || ' | ' || coalesce(error_code,'-') || ' | ' ||` +
      ` coalesce(error_message,'-') FROM sms_logs WHERE id=${id}`,
  );
const statusOfRow = (id) => psql(`SELECT coalesce(send_status,'-') FROM sms_logs WHERE id=${id}`);
const codeOfRow = (id) => psql(`SELECT coalesce(error_code,'-') FROM sms_logs WHERE id=${id}`);

/** 把该工单的 pending 行"变老"（理由见文件头的红线说明） */
function backdatePending(ticketId, minutes = 6) {
  psql(
    `UPDATE sms_logs SET created_at = now() - interval '${minutes} minutes',` +
      ` updated_at = now() - interval '${minutes} minutes'` +
      ` WHERE ticket_id=${ticketId} AND send_status='pending'`,
  );
}

function cleanupTicket(ticketId) {
  psql(
    `DELETE FROM sms_logs WHERE ticket_id=${ticketId};
     DELETE FROM service_visit_photos WHERE visit_id IN (SELECT id FROM service_visits WHERE ticket_id=${ticketId});
     DELETE FROM service_visits WHERE ticket_id=${ticketId};
     DELETE FROM ticket_events WHERE ticket_id=${ticketId};
     DELETE FROM service_tickets WHERE id=${ticketId};`,
  );
}

const created = [];
/** sms.enabled 的原值（finally 里必须**如实还原**，不能猜） */
let origSms = null;

// ---------------------------------------------------------------------------

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  B-16 验收：短信 outbox `pending` 孤儿回收');
  console.log('  （真实故障窗口：事务提交后进程退出 → 重启 → 回收收敛）');
  console.log('══════════════════════════════════════════════════════════════');

  if (!SIGN_SECRET) throw new Error('环境未就绪：.env 里取不到 SIGN_SECRET（诊断闸需要它）');
  if (!STORE_PASSWORD) throw new Error('环境未就绪：.env 里取不到 UAT_STORE_A_PASSWORD');

  const store = await signIn(STORE_EMAIL, STORE_PASSWORD);
  const hq = await signIn('uat.hq@svc.local', envValue('UAT_HQ_PASSWORD'));
  console.log(`  · 门店账号 ${STORE_EMAIL} · 总部账号（读发件箱与诊断闸）`);

  origSms = psql(`SELECT value FROM service_settings WHERE key='sms.enabled'`);
  setSetting('sms.enabled', 'true');
  console.log(`  · 打开 sms.enabled（原值 ${origSms}），等待 11s 让配置缓存过期…`);
  await sleep(11_000);

  // =======================================================================
  // 【A】制造真实故障窗口：事务提交后进程退出
  // =======================================================================
  console.log('\n──── A. 真实故障窗口：事务提交后、flush 之前进程退出 ────');

  const A = await createTicket('A');
  created.push(A.ticketId);

  await checkAsync('打开「提交后退出」注入（与 C23 是**独立**开关）', async () => {
    const r = await diagPost('faultInject', store, { smsCrashAfterCommit: true });
    assert(r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
    assert(r.json?.data?.smsCrashAfterCommit === true, `响应未确认：${r.text.slice(0, 160)}`);
    return 'smsCrashAfterCommit=true';
  });

  await checkAsync('派工调用**真的断开**（进程退出了）', async () => {
    const r = await dispatch(A.ticketId, store, 'B16-A');
    // 进程退出 ⇒ 连接被重置 / 无响应。任何 200 都说明注入没生效。
    assert(r.status === 0 || r.status >= 500, `期望连接断开，实际 HTTP ${r.status}`);
    return `HTTP ${r.status === 0 ? '连接断开' : r.status}（${String(r.error ?? '').slice(0, 60)}）`;
  });

  /** A 段的孤儿行（崩溃后立即捕获，后续全部断言按 id / bizId 定位） */
  let orphanA = [];
  await checkAsync('库里留下两条 `pending` 的 SmsLog（业务已提交，短信没发）', async () => {
    const rows = smsRowsOf(A.ticketId);
    assert(rows.length === 2, `期望 2 条 SmsLog，实际 ${rows.length}：${JSON.stringify(rows)}`);
    const scenes = rows.map((r) => r[0]).sort();
    assert(
      JSON.stringify(scenes) === JSON.stringify(['dispatch_customer', 'technician_task']),
      `scene 不是那一对：${JSON.stringify(scenes)}`,
    );
    const notPending = rows.filter((r) => r[1] !== 'pending');
    assert(notPending.length === 0, `有非 pending 行：${JSON.stringify(notPending)}`);
    orphanA = pendingRowsOf(A.ticketId);
    assert(orphanA.length === 2, `捕获到的孤儿行数 ${orphanA.length}`);
    return rows.map((r) => `${r[0]}=pending`).join(' · ');
  });

  await checkAsync('业务结果**已经生效**（提交过的就是提交了）', async () => {
    const st = psql(`SELECT status FROM service_tickets WHERE id=${A.ticketId}`);
    const vs = psql(
      `SELECT visit_status FROM service_visits WHERE ticket_id=${A.ticketId} ORDER BY id DESC LIMIT 1`,
    );
    assert(st === 'PROCESSING', `工单状态期望 PROCESSING，实际 ${st}`);
    assert(vs === 'ASSIGNED', `visit 期望 ASSIGNED，实际 ${vs}`);
    return `ticket=PROCESSING · visit=ASSIGNED`;
  });

  await checkAsync('一条短信都没发出去（发件箱里没有这张单）', async () => {
    const items = await outboxItems(hq);
    const mine = items.filter((i) => i?.params?.ticket_no === A.ticketNo);
    assert(mine.length === 0, `发件箱里竟有 ${mine.length} 条：${JSON.stringify(mine.map((m) => m.scene))}`);
    return `发件箱 ${items.length} 条，其中本单 0 条`;
  });

  // ---- 重启，让进程回来（并关掉注入）----
  console.log('  · 重启应用…');
  restartApp();
  assert(await waitHealthy(), '重启后应用未在超时内就绪');
  console.log('  · 应用已就绪');
  await checkAsync('关掉「提交后退出」注入（重启后开关已随进程复位，显式确认一次）', async () => {
    const r = await diagPost('faultInject', store, { smsCrashAfterCommit: false });
    assert(r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
    assert(r.json?.data?.smsCrashAfterCommit === false, `响应未确认：${r.text.slice(0, 160)}`);
    return 'smsCrashAfterCommit=false';
  });

  // =======================================================================
  // 【B】年龄守卫：年轻的孤儿不许动
  // =======================================================================
  console.log('\n──── B. 年龄守卫：未超龄的 pending **不许被抢**（否则会给客户发第二遍）────');

  await checkAsync('刚产生的 pending（未超龄）**不被认领**', async () => {
    const r = await diagPost('smsRecoverySweep', store, {});
    assert(r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 200)}`);
    // ⚠️ 这里**不**断言 `scanned === 0`：库里可能还躺着**历史**孤儿
    //    （DEV-108 留下的那批 pending），它们本来就该被回收。
    //    判据只看"**本单这两行**有没有被动过" —— 那才是年龄守卫要保证的事。
    const stillPending = pendingRowsOf(A.ticketId);
    assert(
      stillPending.length === 2,
      `本单的 pending 行从 2 变成 ${stillPending.length}：${JSON.stringify(stillPending)}`,
    );
    return `本单 2 行仍是 pending（年龄守卫生效）`;
  });

  // =======================================================================
  // 【C】分诊：补发 / 不重发（四种结局）
  // =======================================================================
  console.log('\n──── C. 分诊：能无损重建的补发 · 含一次性凭据的绝不重发 ────');

  backdatePending(A.ticketId);
  const control = await createTicket('control');
  created.push(control.ticketId);
  await checkAsync('对照组：正常派工（用于核对"重建出来的载荷"与正常路径一致）', async () => {
    const r = await dispatch(control.ticketId, store, 'B16-control');
    assert(r.status === 200, `正常派工失败 HTTP ${r.status} ${r.text.slice(0, 160)}`);
    const items = await outboxItems(hq);
    const mine = items.filter((i) => i?.params?.ticket_no === control.ticketNo);
    const cust = mine.find((m) => m.scene === 'dispatch_customer');
    assert(cust, `对照组发件箱里没有 dispatch_customer：${JSON.stringify(mine.map((m) => m.scene))}`);
    return `对照组 dispatch_customer 已发出`;
  });

  const sweepC = await checkAsync('第一轮回收：客户通知**补发**、师傅链接**不重发**', async () => {
    const r = await diagPost('smsRecoverySweep', store, {});
    assert(r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 200)}`);
    const d = r.json?.data ?? {};
    assert(Number(d.scanned) >= 2, `只扫到 ${d.scanned} 条，期望 ≥2`);
    assert(Number(d.resent) === 1, `补发条数期望 1，实际 ${d.resent}`);
    assert(Number(d.terminal) >= 1, `判定不发条数期望 ≥1，实际 ${d.terminal}`);
    return `scanned=${d.scanned} 认领=${d.claimed} 补发=${d.resent} 判定不发=${d.terminal}`;
  });

  /** 客户通知那行 / 师傅链接那行（从捕获的孤儿里按 scene 挑，id 精确） */
  const custA = orphanA.find((o) => o.scene === 'dispatch_customer');
  const techA = orphanA.find((o) => o.scene === 'technician_task');

  await checkAsync('客户通知那行已推进到 accepted', async () => {
    assert(custA, '没捕获到 dispatch_customer 孤儿行');
    const st = statusOfRow(custA.id);
    assert(st !== 'pending', '仍是 pending（没被处理）');
    assert(st === 'accepted', `期望 accepted，实际「${rowOutcomeOf(custA.id)}」`);
    return `log=${custA.id} accepted`;
  });

  await checkAsync('客户**真的收到**了补发（按 bizId 精确归属，恰好 1 条）', async () => {
    assert(custA, '没捕获到 dispatch_customer 孤儿行');
    const items = await outboxItems(hq);
    const mine = items.filter((i) => i?.biz_id === custA.bizId);
    assert(mine.length === 1, `按 bizId=${custA.bizId} 期望 1 条，实际 ${mine.length}`);
    return `发件箱 1 条（bizId=${custA.bizId}）`;
  });

  await checkAsync('重建的载荷与正常路径**逐字段一致**（不是"长得像"）', async () => {
    const items = await outboxItems(hq);
    const a = items.find((i) => i?.biz_id === custA?.bizId);
    const c = items.find(
      (i) => i?.params?.ticket_no === control.ticketNo && i.scene === 'dispatch_customer',
    );
    assert(a && c, '两边都要有 dispatch_customer');
    // 与业务相关的字段必须一致；ticket_no 天然不同（不同工单）
    const pick = (o) => ({
      store: o.params.store,
      label: o.params.label,
      technician: o.params.technician,
      expected: o.params.expected,
    });
    assert(
      JSON.stringify(pick(a)) === JSON.stringify(pick(c)),
      `载荷不一致：补发=${JSON.stringify(pick(a))} / 正常=${JSON.stringify(pick(c))}`,
    );
    return `store/label/technician/expected 全一致：${JSON.stringify(pick(c))}`;
  });

  await checkAsync('师傅作业链接**不重发**，原因码为「明文已丢失」', async () => {
    assert(techA, '没捕获到 technician_task 孤儿行');
    const st = statusOfRow(techA.id);
    const code = codeOfRow(techA.id);
    assert(st !== 'pending', '仍是 pending（没被处理）');
    assert(st === 'rejected', `期望 rejected（判定不发的终态），实际「${rowOutcomeOf(techA.id)}」`);
    assert(
      code === 'SMS_PENDING_ORPHAN_TOKEN_LOST',
      `期望 SMS_PENDING_ORPHAN_TOKEN_LOST，实际「${rowOutcomeOf(techA.id)}」`,
    );
    return `log=${techA.id} rejected · ${code}`;
  });

  await checkAsync('师傅那条**确实没进发件箱**（没有把死链接发给真人）', async () => {
    assert(techA, '没捕获到 technician_task 孤儿行');
    const items = await outboxItems(hq);
    const mine = items.filter((i) => i?.biz_id === techA.bizId);
    assert(mine.length === 0, `按 bizId 竟出现 ${mine.length} 条`);
    return `bizId=${techA.bizId} 0 条`;
  });

  // =======================================================================
  // 【D】业务状态变了 ⇒ 过期通知不发
  // =======================================================================
  console.log('\n──── D. 业务状态已改变：过期通知**不发**（发了就是给客户假信息）────');

  const B = await createTicket('B');
  created.push(B.ticketId);
  await diagPost('faultInject', store, { smsCrashAfterCommit: true });
  await dispatch(B.ticketId, store, 'B16-B');
  restartApp();
  assert(await waitHealthy(), '重启后应用未在超时内就绪');
  await diagPost('faultInject', store, { smsCrashAfterCommit: false });

  let orphanB = [];
  await checkAsync('B 的故障窗口同样留下两条 pending', async () => {
    const rows = smsRowsOf(B.ticketId).filter((r) => r[1] === 'pending');
    assert(rows.length === 2, `期望 2 条 pending，实际 ${rows.length}：${JSON.stringify(rows)}`);
    orphanB = pendingRowsOf(B.ticketId);
    return `2 条 pending（log id ${orphanB.map((o) => o.id).join(' / ')}）`;
  });

  await checkAsync('改派（真实业务动作）⇒ 旧的 visit 被取代', async () => {
    const r = await svcPost('reassign', B.ticketId, store, {
      technician_name: 'B16师傅2',
      technician_mobile: '13900010002',
      expected_visit_at: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
      service_mode: 'inhouse',
      reason: 'B16 验收：让旧派工过期',
    });
    assert(r.status === 200, `改派失败 HTTP ${r.status} ${r.text.slice(0, 200)}`);
    const superseded = psql(
      `SELECT count(*) FROM service_visits WHERE ticket_id=${B.ticketId} AND visit_status='SUPERSEDED'`,
    );
    assert(Number(superseded) >= 1, '旧 visit 没有被置为 SUPERSEDED');
    return `旧 visit=SUPERSEDED（${superseded} 条）`;
  });

  backdatePending(B.ticketId);
  await checkAsync('回收：两条孤儿都**不补发**，原因是 STALE / TOKEN_INVALID', async () => {
    const r = await diagPost('smsRecoverySweep', store, {});
    assert(r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 200)}`);
    const d = r.json?.data ?? {};

    const custB = orphanB.find((o) => o.scene === 'dispatch_customer');
    const techB = orphanB.find((o) => o.scene === 'technician_task');
    assert(custB && techB, `捕获的孤儿 scene 不对：${JSON.stringify(orphanB)}`);

    // ⚠️ 按**行 id** 断言，不按 (ticket, scene) 取最新 ——
    //    上面的 `reassign` 已经为同一张单产生了**新的** technician_task 行（正常发出）。
    const custSt = statusOfRow(custB.id);
    const custCode = codeOfRow(custB.id);
    assert(custSt === 'rejected', `客户通知期望 rejected，实际「${rowOutcomeOf(custB.id)}」`);
    assert(
      custCode === 'SMS_PENDING_ORPHAN_STALE',
      `客户通知期望 STALE（visit 已被取代 ⇒ 通知过期），实际「${rowOutcomeOf(custB.id)}」`,
    );

    const techSt = statusOfRow(techB.id);
    const techCode = codeOfRow(techB.id);
    assert(techSt === 'rejected', `师傅链接期望 rejected，实际「${rowOutcomeOf(techB.id)}」`);
    assert(
      techCode === 'SMS_PENDING_ORPHAN_TOKEN_INVALID',
      `师傅链接期望 TOKEN_INVALID（凭据已失效），实际「${rowOutcomeOf(techB.id)}」`,
    );
    return `log${custB.id}=${custCode} · log${techB.id}=${techCode}（本轮 resent=${d.resent}）`;
  });

  await checkAsync('B 的**孤儿**一条都没进发件箱（改派正常发出的那条不算）', async () => {
    const items = await outboxItems(hq);
    const leaked = items.filter((i) => orphanB.some((o) => o.bizId === i?.biz_id));
    assert(
      leaked.length === 0,
      `按孤儿 bizId 竟匹配到 ${leaked.length} 条：${JSON.stringify(leaked.map((m) => m.scene))}`,
    );
    return `孤儿 bizId 命中 0 条（发件箱共 ${items.length} 条，均来自正常业务路径）`;
  });

  // =======================================================================
  // 【E】并发安全 + 幂等
  // =======================================================================
  console.log('\n──── E. 并发安全（两轮同时跑，每条只发一次）· 幂等（再跑不再发）────');

  const C = await createTicket('C');
  created.push(C.ticketId);
  await diagPost('faultInject', store, { smsCrashAfterCommit: true });
  await dispatch(C.ticketId, store, 'B16-C');
  restartApp();
  assert(await waitHealthy(), '重启后应用未在超时内就绪');
  await diagPost('faultInject', store, { smsCrashAfterCommit: false });
  backdatePending(C.ticketId);

  const orphanC = pendingRowsOf(C.ticketId);
  await checkAsync('两轮回收**同时**发出 ⇒ 补发总数恰好 1（没有重复发）', async () => {
    const custC = orphanC.find((o) => o.scene === 'dispatch_customer');
    assert(custC, `没捕获到 C 的 dispatch_customer 孤儿：${JSON.stringify(orphanC)}`);
    const [r1, r2] = await Promise.all([
      diagPost('smsRecoverySweep', store, {}),
      diagPost('smsRecoverySweep', store, {}),
    ]);
    assert(r1.status === 200 && r2.status === 200, `两轮都要 200：${r1.status}/${r2.status}`);
    const resent = Number(r1.json?.data?.resent ?? 0) + Number(r2.json?.data?.resent ?? 0);
    const claimed = Number(r1.json?.data?.claimed ?? 0) + Number(r2.json?.data?.claimed ?? 0);
    // ⚠️ 判据看的是**实际发出去了几条**（外部副作用），不是"谁抢到了"：
    //    两个 worker 各发一次的话 resent 会变成 2 —— 数据库再正确也救不回来。
    assert(
      resent === 1,
      `本单补发总数据期望 1，实际 ${resent}（claimed 合计 ${claimed}）`,
    );
    const items = await outboxItems(hq);
    const mine = items.filter((i) => i?.biz_id === custC.bizId);
    assert(mine.length === 1, `按 bizId 期望 1 条，实际 ${mine.length}`);
    return `resent 合计=1 · 发件箱 1 条（claimed 合计=${claimed}）`;
  });

  await checkAsync('再跑一轮 ⇒ 不再产生任何发送（幂等）', async () => {
    const custC = orphanC.find((o) => o.scene === 'dispatch_customer');
    const r = await diagPost('smsRecoverySweep', store, {});
    assert(r.status === 200, `HTTP ${r.status}`);
    const d = r.json?.data ?? {};
    assert(Number(d.resent) === 0, `又补发了 ${d.resent} 条（不幂等）`);
    const items = await outboxItems(hq);
    const mine = items.filter((i) => i?.biz_id === custC?.bizId);
    assert(mine.length === 1, `发件箱变成 ${mine.length} 条`);
    return `resent=0 · 发件箱仍是 1 条`;
  });

  await checkAsync('诊断闸形态正确：不带共享密钥一律 404（不是 403/401）', async () => {
    const r = await httpJson(`${SVC_BASE_URL}/api/svc:smsRecoverySweep`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${store}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert(r.status === 404, `期望 404（语义唯一：对外就是没有这个接口），实际 ${r.status}`);
    return 'HTTP 404';
  });
}

// ---------------------------------------------------------------------------

let exitCode = 0;
try {
  await main();
} catch (error) {
  console.log(`\n  ✗ 未预期错误：${String(error?.stack ?? error).slice(0, 600)}`);
  exitCode = 1;
} finally {
  // 清理：注入开关复位 + sms.enabled 如实还原 + 自建工单按 id 精确删除（绝不用范围条件）
  try {
    if (origSms !== null) setSetting('sms.enabled', origSms);
    console.log(`  · sms.enabled 已还原：true → ${origSms}`);
  } catch (error) {
    console.log(`  · sms.enabled 还原失败：${String(error?.message ?? error).slice(0, 120)}`);
  }
  for (const id of created) {
    try {
      cleanupTicket(id);
    } catch (error) {
      console.log(`  · 清理 ticket #${id} 失败：${String(error?.message ?? error).slice(0, 120)}`);
    }
  }
  console.log(`  · 已清理本次自建工单 ${created.map((c) => `#${c}`).join(' / ') || '（无）'}`);
}

if (exitCode === 0 && state.failures.length > 0) exitCode = 1;
console.log('\n══════════════════════════════════════════════════════════════');
if (state.failures.length === 0) {
  console.log(`  ✅ 全部通过：${state.passed} 项`);
} else {
  console.log(`  通过 ${state.passed} 项 · 未达标 ${state.failures.length} 项`);
  for (const f of state.failures) console.log(`    ✗ ${f.name}\n      ${f.detail ?? ''}`);
}
console.log('══════════════════════════════════════════════════════════════');
process.exit(exitCode);
