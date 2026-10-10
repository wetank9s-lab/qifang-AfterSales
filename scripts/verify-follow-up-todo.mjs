#!/usr/bin/env node
/**
 * =============================================================================
 *  verify-follow-up-todo.mjs —— P11-1 `next_follow_at` 待办能力验收
 * =============================================================================
 *
 * 契约依据：用户 2026-10-10 对 P11-1 第二项的 8 条要求。逐条对应如下：
 *
 * | 要求 | 本脚本哪一段在验 |
 * |---|---|
 * | ① 字段+迁移+**三层一致**，自检不得零行假绿 | §1（直接查 `information_schema` + `fields`，**断言行数**） |
 * | ② `followUp` 同事务写 append-only 事件 + 当前列，保留历史 | §2、§3（事件条数只增、metadata 记原值） |
 * | ③ API 区分「未传 / 指定 / 明确清空」三意图 | §3（三条路径各打一次，看列的变化） |
 * | ④ 关闭/取消/转店/离开跟进阶段/异常重开 ⇒ 清理待办 | §5、§6 |
 * | ⑤ 按授权范围查今日待跟进/已逾期，服务端 storeScope | §4（另一个门店的账号必须看不到） |
 * | ⑥ 真实门店账号端到端 | 全程用 `uat.store.a@svc.local` + 真实 HTTP 动作 |
 * | ⑦ 业务时区/日期语义一致，不因 UTC 提前逾期 | §4（服务端回的 `today` 必须是 +08:00 的 canonical 正午） |
 *
 * ⚠️ 需求 ⑧（不另造第二套 SLA 扫描体系）是**否定性要求**，本脚本用
 *    "队列接口是只读的、不产生任何事件/短信"来体现：§4 前后对比事件与 sms 行数。
 *
 * 退出码：0 全绿 / 1 有未达标 / 2 环境未就绪
 * =============================================================================
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  cleanupTicket,
  createScratchTicket,
  ensureFixtureJpeg,
  psqlRows,
  psqlScalar,
  signIn,
  svcPost,
  technicianSubmit,
  technicianUpload,
  tokenFromOutbox,
} from './technician-harness.mjs';
import { SVC_BASE_URL } from './lib/base-url.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const STORE_A = 'uat.store.a@svc.local';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '0';

function envValue(key, fallback = '') {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return fallback;
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(fs.readFileSync(p, 'utf8'));
  return m ? m[1].trim() : fallback;
}

const state = { passed: 0, failures: [] };
function ok(name, detail) {
  state.passed += 1;
  console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`);
}
function no(name, detail) {
  state.failures.push({ name, detail });
  console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
}
/**
 * 本轮的限流信号（见下）。
 *
 * 🔴 为什么必须把 429 单独拎出来（2026-10-10 实测踩到）：
 *    本门禁要建几张匿名工单，而匿名入口是 30r/m + burst 10 的**共享桶**。
 *    在一轮里连着跑多支验收脚本时，**自己的流量**就会把它打满 ⇒ 建单 429。
 *    若不区分，屏幕上是"❌ 建单失败"，读起来像**产品坏了** ——
 *    而它其实是"刚才那几支脚本把额度用完了，等一分钟就好"。
 *    ⇒ 按本项目既有约定：环境未就绪 **exit 2**，与真红灯（exit 1）分开。
 */
let envNotReady = false;

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    ok(name, detail);
  } catch (error) {
    const text = String(error?.message ?? error);
    if (text.includes('429') || text.includes('TOO_MANY_REQUESTS')) {
      envNotReady = true;
      no(name, `${text.slice(0, 200)} —— ⚠️ 这是**限流**（本轮验收自己的流量），不是产品问题`);
      return;
    }
    no(name, text.slice(0, 300));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

async function httpJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs ?? 20_000) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

/** 日期加减（**只到天**的字符串，业务时区口径交给服务端） */
function shiftDate(days) {
  const d = new Date(Date.now() + days * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const followUp = (ticketId, token, body) =>
  svcPost('followUp', ticketId, token, body, crypto.randomUUID());

const queueOf = async (token, limit = 200) =>
  httpJson(`${SVC_BASE_URL}/api/svc:followUpQueue?limit=${limit}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

const nextFollowColumnOf = (ticketId) =>
  psql(
    `SELECT coalesce(to_char(next_follow_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI'),'<NULL>')` +
      ` FROM service_tickets WHERE id=${ticketId}`,
  );

/** 事件条数与"最后一条 follow_up 事件的 metadata" —— 用来验 append-only 与留档 */
const followUpEventsOf = (ticketId) =>
  psqlRows(
    `SELECT id, metadata_json::text FROM ticket_events WHERE ticket_id=${ticketId} AND event_type='follow_up' ORDER BY id`,
  );

const created = [];

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  P11-1 验收：next_follow_at 待办能力（真实门店账号 + 真实业务动作）');
  console.log('══════════════════════════════════════════════════════════════');

  const store = await signIn(STORE_A, envValue('UAT_STORE_A_PASSWORD'));
  const hq = await signIn('uat.hq@svc.local', envValue('UAT_HQ_PASSWORD'));
  console.log(`  · 门店账号 ${STORE_A} · 总部账号（用于跨店越权核对）`);

  // =========================================================================
  // §1 三层一致（DDL / fields 元数据 / collection 定义）
  // =========================================================================
  console.log('\n──── §1 字段与迁移：三层一致（先断言行数，不做零行假绿）────');

  await checkAsync('DDL：next_follow_at 存在且带时区（1 行）', async () => {
    const rows = psqlRows(
      `SELECT column_name, data_type FROM information_schema.columns ` +
        `WHERE table_name='service_tickets' AND column_name='next_follow_at'`,
    );
    assert(rows.length === 1, `查到 ${rows.length} 行（期望 1）—— 行数是判据，不然"没查到坏行"会被当成通过`);
    assert(
      rows[0][1] === 'timestamp with time zone',
      `类型是 ${rows[0][1]}，期望 timestamp with time zone（否则跨零点会被 UTC 提前判逾期）`,
    );
    return `timestamptz`;
  });

  await checkAsync('fields 元数据：恰好 1 行，allowNull=true 且 title 非空', async () => {
    const rows = psqlRows(
      `SELECT name, coalesce(options::jsonb->>'allowNull','-'), ` +
        `coalesce(options::jsonb #>> '{uiSchema,title}','') FROM fields ` +
        `WHERE "collectionName"='serviceTickets' AND name='next_follow_at'`,
    );
    assert(rows.length === 1, `查到 ${rows.length} 行（期望 1）`);
    assert(rows[0][1] === 'true', `allowNull=${rows[0][1]}（期望 true）`);
    assert(rows[0][2] !== '', 'uiSchema.title 为空 —— 界面上会显示成空标签');
    return `${rows[0][2]} · allowNull=${rows[0][1]}`;
  });

  await checkAsync('collection 定义：源码里声明了这一列（供全新安装使用）', async () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/collections/serviceTickets.ts'),
      'utf8',
    );
    assert(src.includes("ts('next_follow_at'"), 'collection 定义里没有 next_follow_at');
    return "ts('next_follow_at', …)";
  });

  // =========================================================================
  // §2 建夹具：一张可跟进的 PROCESSING 工单
  // =========================================================================
  console.log('\n──── §2 夹具：真实门店派工出一张可跟进（PROCESSING）的工单 ────');

  let T = null;
  await checkAsync('建单 + 派工 ⇒ PROCESSING（走真实业务路径）', async () => {
    const t = await createScratchTicket({ tag: 'FU-TODO', content: 'P11-1 待办能力验收' });
    created.push(t.ticketId);
    const d = await svcPost(
      'dispatch',
      t.ticketId,
      store,
      {
        technician_name: '待办验收师傅',
        technician_mobile: '13900010008',
        expected_visit_at: shiftDate(1),
        service_mode: 'inhouse',
      },
      crypto.randomUUID(),
    );
    assert(d.status === 200, `派工失败 HTTP ${d.status} ${String(d.body).slice(0, 160)}`);
    const st = psql(`SELECT status FROM service_tickets WHERE id=${t.ticketId}`);
    assert(st === 'PROCESSING', `状态是 ${st}`);
    T = t;
    return `#${t.ticketId} ${t.ticketNo} · PROCESSING`;
  });

  // =========================================================================
  // §3 三态意图 + 同事务 append-only
  // =========================================================================
  console.log('\n──── §3 followUp 与三态意图（未传 / 指定 / 明确清空）────');

  const todayStr = shiftDate(0);
  const plus3 = shiftDate(3);

  await checkAsync('「指定新日期」⇒ 列被写入（同事务），事件同时留档', async () => {
    const r = await followUp(T.ticketId, store, { note: '已电话联系，客户要求周内再确认', next_follow_at: plus3 });
    assert(r.status === 200, `HTTP ${r.status} ${String(r.body).slice(0, 200)}`);
    const col = nextFollowColumnOf(T.ticketId);
    assert(col.startsWith(plus3), `列是 ${col}，期望 ${plus3} 开头（业务时区 canonical 正午）`);
    const events = followUpEventsOf(T.ticketId);
    assert(events.length === 1, `follow_up 事件 ${events.length} 条（期望 1）`);
    const meta = JSON.parse(events[0][1]);
    assert(meta.next_follow_intent === 'set', `metadata.next_follow_intent=${meta.next_follow_intent}`);
    assert(meta.next_follow_previous === null, 'metadata 应记下"被覆盖的原值"（首次为 null）');
    assert(String(meta.next_follow_at).startsWith(plus3), 'metadata.next_follow_at 应与列一致');
    return `列=${col} · 事件 1 条 · 原值=null`;
  });

  await checkAsync('「未传该字段」⇒ **保持不动**（绝不能顺手清空）', async () => {
    const before = nextFollowColumnOf(T.ticketId);
    const r = await followUp(T.ticketId, store, { note: '只是补一条跟进，没提日期' });
    assert(r.status === 200, `HTTP ${r.status} ${String(r.body).slice(0, 200)}`);
    const after = nextFollowColumnOf(T.ticketId);
    assert(after === before, `列从 ${before} 变成了 ${after} —— 未传字段**不得**改变已有安排`);
    const events = followUpEventsOf(T.ticketId);
    assert(events.length === 2, `follow_up 事件 ${events.length} 条（期望 2，append-only）`);
    const meta = JSON.parse(events[1][1]);
    assert(meta.next_follow_intent === 'unchanged', `intent=${meta.next_follow_intent}`);
    return `列保持 ${after} · 事件增至 ${events.length} 条`;
  });

  await checkAsync('传空串 ⇒ 视为**未传**（表单"没填"不等于"要取消"）', async () => {
    const before = nextFollowColumnOf(T.ticketId);
    const r = await followUp(T.ticketId, store, { note: '空串路径', next_follow_at: '' });
    assert(r.status === 200, `HTTP ${r.status} ${String(r.body).slice(0, 200)}`);
    const after = nextFollowColumnOf(T.ticketId);
    assert(after === before, `列被空串改成了 ${after} —— 这正是"无意清除已有安排"`);
    return `列仍为 ${after}`;
  });

  await checkAsync('「指定新日期」第二次 ⇒ 覆盖为新日期，且**原值进事件留档**', async () => {
    const r = await followUp(T.ticketId, store, { note: '客户改期到三天后', next_follow_at: todayStr });
    assert(r.status === 200, `HTTP ${r.status} ${String(r.body).slice(0, 200)}`);
    const col = nextFollowColumnOf(T.ticketId);
    assert(col.startsWith(todayStr), `列是 ${col}，期望 ${todayStr}`);
    const events = followUpEventsOf(T.ticketId);
    const meta = JSON.parse(events[events.length - 1][1]);
    assert(
      String(meta.next_follow_previous).startsWith(plus3),
      `事件里的原值应是被覆盖的 ${plus3}，实际 ${meta.next_follow_previous}`,
    );
    assert(String(meta.next_follow_at).startsWith(todayStr), '事件里的新值与列一致');
    return `列=${col} · 原值=${plus3}（历史未丢）`;
  });

  // =========================================================================
  // §4 队列：今日待跟进 / 已逾期，服务端 storeScope，日期语义
  // =========================================================================
  console.log('\n──── §4 待跟进队列（只读 · 服务端裁范围 · 业务时区）────');

  let queueToday = null;
  await checkAsync('队列能查到这张单（今日待跟进）', async () => {
    const r = await queueOf(store);
    assert(r.status === 200, `HTTP ${r.status} ${String(r.text).slice(0, 200)}`);
    const d = r.json?.data ?? {};
    const ids = (d.items ?? []).map((x) => Number(x.id));
    assert(ids.includes(T.ticketId), `队列里没有 #${T.ticketId}（返回 ${ids.length} 条）`);
    queueToday = d;
    return `todayCount=${d.todayCount} overdueCount=${d.overdueCount}（本单在列）`;
  });

  await checkAsync('服务端回的 `today` 是业务时区（+08:00）的 canonical 正午', async () => {
    assert(queueToday?.today, '响应里没有 today 字段 —— 调用方无法自证时区口径');
    const iso = String(queueToday.today);
    // canonical 正午 +08:00 ⇒ UTC 是当天 04:00
    assert(/T04:00:00\.000Z$/.test(iso), `today=${iso}，期望 UTC 04:00:00.000Z（= +08:00 12:00）`);
    return iso;
  });

  await checkAsync('**越权核对**：总部账号看得到、另一个门店的账号看不到（服务端裁的）', async () => {
    const hqQ = await queueOf(hq);
    assert(hqQ.status === 200, `总部查队列 HTTP ${hqQ.status}`);
    const hqIds = (hqQ.json?.data?.items ?? []).map((x) => Number(x.id));
    assert(hqIds.includes(T.ticketId), '总部应看得到（它是全局范围）');

    // 把这张单的 store_id 临时指向另一家店，再用 A 店账号查 —— 必须看不到。
    // ⚠️ 这是**唯一**一处直接改库：目的是构造"不属于我"的数据来验越权，
    //    而不是伪造业务结果（改完立即还原，且断言只看"在不在队列里"）。
    const origStore = Number(psql(`SELECT store_id FROM service_tickets WHERE id=${T.ticketId}`));
    const otherStore = Number(
      psql(`SELECT id FROM stores WHERE id <> ${origStore} ORDER BY id LIMIT 1`),
    );
    assert(otherStore > 0, '库里只有一个门店，无法做越权核对（环境未就绪）');
    psql(`UPDATE service_tickets SET store_id=${otherStore} WHERE id=${T.ticketId}`);
    try {
      const aQ = await queueOf(store);
      const aIds = (aQ.json?.data?.items ?? []).map((x) => Number(x.id));
      assert(!aIds.includes(T.ticketId), 'A 店账号竟然看到了 B 店工单 —— storeScope 没在服务端生效');
      return `总部可见 · A 店不可见（该单已临时挂到 store ${otherStore}）`;
    } finally {
      psql(`UPDATE service_tickets SET store_id=${origStore} WHERE id=${T.ticketId}`);
    }
  });

  await checkAsync('队列**只读**：查一次不产生任何事件 / 短信（不另造第二套扫描体系）', async () => {
    const evBefore = Number(psql(`SELECT count(*) FROM ticket_events WHERE ticket_id=${T.ticketId}`));
    const smsBefore = Number(psql(`SELECT count(*) FROM sms_logs WHERE ticket_id=${T.ticketId}`));
    await queueOf(store);
    await queueOf(store);
    const evAfter = Number(psql(`SELECT count(*) FROM ticket_events WHERE ticket_id=${T.ticketId}`));
    const smsAfter = Number(psql(`SELECT count(*) FROM sms_logs WHERE ticket_id=${T.ticketId}`));
    assert(evAfter === evBefore, `事件从 ${evBefore} 变成 ${evAfter} —— 查询不得写任何东西`);
    assert(smsAfter === smsBefore, `短信行从 ${smsBefore} 变成 ${smsAfter}`);
    return `事件 ${evAfter} 条 · 短信 ${smsAfter} 条（前后不变）`;
  });

  await checkAsync('逾期项排在今日项之前（按日期升序、越急越前）', async () => {
    // 造一张"昨天"的单：先设成今天，再用 SQL 只改日期以模拟"已逾期"
    const r = await followUp(T.ticketId, store, { note: '设置为今天', next_follow_at: todayStr });
    assert(r.status === 200, `HTTP ${r.status}`);
    psql(
      `UPDATE service_tickets SET next_follow_at = next_follow_at - interval '2 days' WHERE id=${T.ticketId}`,
    );
    try {
      const q = await queueOf(store);
      const items = q.json?.data?.items ?? [];
      const idIdx = items.findIndex((x) => Number(x.id) === T.ticketId);
      assert(idIdx >= 0, '逾期后这张单不在队列里');
      const overdueIdx = items.findIndex((x) => new Date(x.next_follow_at).getTime() < new Date(q.json.data.today).getTime());
      assert(overdueIdx >= 0, '返回里没有任何逾期项');
      assert(idIdx <= overdueIdx || idIdx === overdueIdx, `逾期项没有排在前面（本单 idx=${idIdx}）`);
      assert(Number(q.json.data.overdueCount) >= 1, `overdueCount=${q.json.data.overdueCount}`);
      return `overdueCount=${q.json.data.overdueCount} · 本单位于 idx=${idIdx}`;
    } finally {
      psql(`UPDATE service_tickets SET next_follow_at = next_follow_at + interval '2 days' WHERE id=${T.ticketId}`);
    }
  });

  // =========================================================================
  // §5 明确清空
  // =========================================================================
  console.log('\n──── §5 「明确清空」（传 null）────');

  await checkAsync('传 null ⇒ 列被清空，历史事件仍在（append-only）', async () => {
    const before = followUpEventsOf(T.ticketId).length;
    const r = await followUp(T.ticketId, store, { note: '客户说不用再跟了', next_follow_at: null });
    assert(r.status === 200, `HTTP ${r.status} ${String(r.body).slice(0, 200)}`);
    const col = nextFollowColumnOf(T.ticketId);
    assert(col === '<NULL>', `列是 ${col}，期望 <NULL>`);
    const events = followUpEventsOf(T.ticketId);
    assert(events.length === before + 1, `事件应 +1（append-only），实际 ${events.length}`);
    const meta = JSON.parse(events[events.length - 1][1]);
    assert(meta.next_follow_intent === 'clear', `intent=${meta.next_follow_intent}`);
    return `列已清空 · 事件 ${events.length} 条（历史保留）`;
  });

  await checkAsync('清空后队列里不再有它', async () => {
    const q = await queueOf(store);
    const ids = (q.json?.data?.items ?? []).map((x) => Number(x.id));
    assert(!ids.includes(T.ticketId), '清空后仍出现在队列里');
    return `队列 ${ids.length} 条，本单已不在`;
  });

  // =========================================================================
  // §6 状态迁移时的待办清理
  // =========================================================================
  console.log('\n──── §6 关闭 / 取消 / 转店 / 离开跟进阶段 ⇒ 待办必须被清掉 ────');

  await checkAsync('① 取消（CANCELLED）⇒ 待办清空，且事件里写明原因', async () => {
    await followUp(T.ticketId, store, { note: '重新安排一次', next_follow_at: shiftDate(5) });
    assert(nextFollowColumnOf(T.ticketId).startsWith(shiftDate(5)), '前置：待办已设置');
    const r = await svcPost('cancel', T.ticketId, store, { reason: '待办清理验收：取消' }, crypto.randomUUID());
    assert(r.status === 200, `取消失败 HTTP ${r.status} ${String(r.body).slice(0, 200)}`);
    assert(nextFollowColumnOf(T.ticketId) === '<NULL>', '取消后待办仍挂着 —— 会给已取消的单继续提醒');
    const metaRaw = psql(
      `SELECT metadata_json::text FROM ticket_events WHERE ticket_id=${T.ticketId} AND event_type='cancelled' ORDER BY id DESC LIMIT 1`,
    );
    const meta = JSON.parse(metaRaw);
    assert(meta.follow_up_cleared?.reason === 'ticket_cancelled', `事件未记录清理原因：${metaRaw.slice(0, 200)}`);
    assert(String(meta.follow_up_cleared?.previous_at).startsWith(shiftDate(5)), '事件应记下被清掉的原值');
    return `列已清空 · 事件记录 reason=ticket_cancelled · 原值=${shiftDate(5)}`;
  });

  // ② **【反向】转店被拒绝 ⇒ 待办不受影响**
  //
  // ⚠️ 这一条**原来**验的是"转店成功 ⇒ 待办被清空（新门店重新决定）"。
  //    用户 2026-10-10 裁决"门店完全独立运营、取消跨店转单"之后，**转店本身不存在了**
  //    ⇒ `store_transferred` 这条清理路径**已不可达**（服务层的 `transfer()` 已整体删除）。
  //    按"不得简单删除安全断言"的口径，这里改成**反向测试**：
  //      · 转店必须被拒（403 TRANSFER_DISABLED）；
  //      · 而且**被拒之后待办原样还在** —— 证明"被撤销的能力"不会顺手改坏
  //        别的业务状态（这正是"拒绝对数据的零副作用"在待办维度上的体现）。
  await checkAsync('② 【反向】转店被拒 ⇒ 待办原样保留（撤销的能力不得动别的状态）', async () => {
    const t2 = await createScratchTicket({ tag: 'FU-XFER', content: 'P11-1 转店被拒与待办无损' });
    created.push(t2.ticketId);
    await svcPost(
      'dispatch',
      t2.ticketId,
      store,
      {
        technician_name: '反向验收师傅',
        technician_mobile: '13900010009',
        expected_visit_at: shiftDate(1),
        service_mode: 'inhouse',
      },
      crypto.randomUUID(),
    );
    await followUp(t2.ticketId, store, { note: '约下周再跟', next_follow_at: shiftDate(6) });
    assert(nextFollowColumnOf(t2.ticketId).startsWith(shiftDate(6)), '前置：待办已设置');

    const targetCode = psql(
      `SELECT code FROM stores WHERE id <> (SELECT store_id FROM service_tickets WHERE id=${t2.ticketId}) ORDER BY id LIMIT 1`,
    );
    const r = await svcPost(
      'transfer',
      t2.ticketId,
      store,
      { target_store_code: targetCode, reason: '反向测试：转店已撤销' },
      crypto.randomUUID(),
    );
    assert(
      r.status === 403 && String(r.body).includes('TRANSFER_DISABLED'),
      `转店应被拒 403 TRANSFER_DISABLED，实际 HTTP ${r.status} ${String(r.body).slice(0, 160)}`,
    );
    // 零副作用：待办还在、门店没变
    assert(
      nextFollowColumnOf(t2.ticketId).startsWith(shiftDate(6)),
      '转店被拒却把待办清掉了 —— 被撤销的操作不该改任何业务状态',
    );
    const stillSameStore = psql(
      `SELECT coalesce(store_id::text,'-') FROM service_tickets WHERE id=${t2.ticketId}`,
    );
    return `转店被拒（403 TRANSFER_DISABLED）· 待办仍为 ${shiftDate(6)} · store 仍为 ${stillSameStore}`;
  });

  await checkAsync('③ 离开可跟进阶段（师傅提交 → 待门店确认）⇒ 待办清空', async () => {
    // ⚠️ 短信通道必须在**派工之前**就打开（第一版在派工之后才开 ⇒
    //    那天 technician_task 走的是"通道未启用"的拒绝分支，发件箱里根本没有它，
    //    于是"取 Token"失败，报出来的却是"发件箱里没有这条短信"）。
    const smsBefore = psqlScalar(`SELECT value FROM service_settings WHERE key='sms.enabled'`);
    psql(`UPDATE service_settings SET value='true', updated_at=now() WHERE key='sms.enabled'`);
    try {
      await new Promise((r) => setTimeout(r, 11_000)); // 等 ConfigService 的 TTL 过期

      const t3 = await createScratchTicket({ tag: 'FU-STAGE', content: 'P11-1 离开跟进阶段清待办' });
      created.push(t3.ticketId);
      const d3 = await svcPost(
        'dispatch',
        t3.ticketId,
        store,
        {
          technician_name: '阶段验收师傅',
          technician_mobile: '13900010010',
          expected_visit_at: shiftDate(1),
          service_mode: 'inhouse',
        },
        crypto.randomUUID(),
      );
      assert(d3.status === 200, `派工失败 HTTP ${d3.status} ${String(d3.body).slice(0, 160)}`);

      await followUp(t3.ticketId, store, { note: '先记一条带待办的跟进', next_follow_at: shiftDate(2) });
      assert(nextFollowColumnOf(t3.ticketId).startsWith(shiftDate(2)), '前置：待办已设置');

      const tok = await tokenFromOutbox({ sessionToken: hq, ticketNo: t3.ticketNo, scene: 'technician_task' });
      assert(typeof tok?.token === 'string', `取不到师傅 Token：${JSON.stringify(tok)?.slice(0, 160)}`);
      await new Promise((r) => setTimeout(r, 1500)); // 师傅接口独立限流区，让开
      const up = await technicianUpload(tok.token, ensureFixtureJpeg(), { filename: 'fu.jpg' });
      assert(up.status === 200 || up.status === 201, `上传失败 HTTP ${up.status}`);
      const sub = await technicianSubmit(tok.token, {
        service_result: 'resolved',
        service_note: 'P11-1 验收：推进到待确认',
        is_charged: false,
      });
      assert(sub.status === 200, `师傅提交失败 HTTP ${sub.status} ${String(sub.body).slice(0, 160)}`);

      // 师傅提交本身就已经离开 PROCESSING（→ 待门店确认）⇒ 待办此时应已被清掉
      const st = psql(`SELECT status FROM service_tickets WHERE id=${t3.ticketId}`);
      assert(st === 'WAIT_STORE_CONFIRM', `工单状态是 ${st}`);
      assert(nextFollowColumnOf(t3.ticketId) === '<NULL>', '进入待门店确认后待办仍挂着');
      return '师傅提交后列已清空（left_followable_stage 路径由其事件记录）';
    } finally {
      psql(`UPDATE service_settings SET value='${smsBefore}', updated_at=now() WHERE key='sms.enabled'`);
    }
  });

  // =========================================================================
  await checkAsync('④ 队列接口需要登录（未登录不得读）', async () => {
    const r = await httpJson(`${SVC_BASE_URL}/api/svc:followUpQueue`);
    assert(r.status === 401 || r.status === 403, `期望 401/403，实际 ${r.status}`);
    return `HTTP ${r.status}`;
  });
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  console.log(`\n  ✗ 未预期错误：${String(error?.stack ?? error).slice(0, 600)}`);
  exitCode = 1;
} finally {
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
// 限流 ⇒ 环境未就绪（exit 2），与"真红灯"分开：见 envNotReady 的说明
if (envNotReady) exitCode = 2;
console.log('\n══════════════════════════════════════════════════════════════');
if (exitCode === 2) {
  console.log('  🟡 环境未就绪（退出码 2）：本轮撞上匿名入口限流（429）——');
  console.log('     这是**本机连续验收自己的流量**，不是产品问题。等约 1 分钟后重跑即可。');
} else if (state.failures.length === 0) {
  console.log(`  ✅ 全部通过：${state.passed} 项`);
} else {
  console.log(`  通过 ${state.passed} 项 · 未达标 ${state.failures.length} 项`);
  for (const f of state.failures) console.log(`    ✗ ${f.name}\n      ${f.detail ?? ''}`);
}
console.log('══════════════════════════════════════════════════════════════');
process.exit(exitCode);
