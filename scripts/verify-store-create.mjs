#!/usr/bin/env node
/**
 * verify-store-create.mjs —— **门店人工新建服务单**门禁（Phase 11 / P11-2 · 用户 B/C 段）
 * =============================================================================
 *
 * 用户的要求可以拆成四组，本文件的段落与它们一一对应：
 *
 *   ① **六类都能建**：维修 / 安装 / 调试保养 / 移机拆机 / 投诉 / 其他
 *      —— 每类都要核：字段落库、`status=NEW`、`source=staff`、归属本店、审计事件。
 *   ② **门店隔离**：`storeScope` 必须在**服务端**校验；门店角色不得为别家门店建单；
 *      "总部汇总查看权限**不**自动等于跨店创建权限"。
 *   ③ **与匿名面继续隔离**：不能因为内部 API 支持六类，就让匿名请求伪造安装/其他/紧急。
 *   ④ **不重引入已取消的东西**：不得重新出现"受理"步骤，不得恢复跨店转单。
 *
 * ===========================================================================
 * 为什么每一条都要有**双向**（正例 + 反例）
 * ===========================================================================
 * 这四组要求的共同特点是：**写错了都不会报错**。
 *   · 只验"六类能建"⇒ 漏掉"总部也能建"；
 *   · 只验"门店不能建别家"⇒ 漏掉"匿名能伪造安装"；
 *   · 只验"新建后是 NEW"⇒ 漏掉"事件里又塞了一个 ACCEPTED"。
 * ⇒ 凡是"某件事**不许**发生"的，都必须有一条**真的去尝试它**的反例断言。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';
import { storeEntryQuery } from './lib/store-entry-token.mjs';
import {
  EnvNotReady,
  assert,
  cleanupTicket,
  envValue,
  http,
  makeChecker,
  psqlRows,
  psqlScalar,
  runMain,
  signIn,
} from './technician-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = SVC_BASE_URL;

const STORE_A = 'S01';
const STORE_B = 'S02';

/** 六类（**手写**期望值，不从被测源码派生） */
const SIX_TYPES = [
  { value: 'repair', label: '维修' },
  { value: 'installation', label: '安装' },
  { value: 'maintenance', label: '调试保养' },
  { value: 'relocation', label: '移机拆机' },
  { value: 'complaint', label: '投诉' },
  { value: 'other', label: '其他' },
];

/** 匿名面**只允许**这两类 */
const PUBLIC_TYPES = ['repair', 'complaint'];

const created = [];

async function main() {
  const { check, checkAsync, summary } = makeChecker({ heading: '门店人工新建服务单' });

  const storePassword = envValue('UAT_STORE_A_PASSWORD');
  const storeBPassword = envValue('UAT_STORE_B_PASSWORD');
  const hqPassword = envValue('UAT_HQ_PASSWORD');
  if (!storePassword || !storeBPassword || !hqPassword) {
    throw new EnvNotReady('.env 缺 UAT_STORE_A/B_PASSWORD 或 UAT_HQ_PASSWORD —— 先跑 node scripts/uat-accounts.mjs --create');
  }
  const tokenA = await signIn('uat.store.a@svc.local', storePassword);
  const tokenB = await signIn('uat.store.b@svc.local', storeBPassword);
  const tokenHq = await signIn('uat.hq@svc.local', hqPassword);
  if (!tokenA || !tokenB || !tokenHq) throw new EnvNotReady('UAT 账号登录失败（口令可能已轮换）');

  const storeIdOf = (code) => Number(psqlScalar(`SELECT id FROM stores WHERE code='${code}'`));

  /** 发一次人工新建请求 */
  const post = async (token, body, { requestId = crypto.randomUUID(), withRequestId = true } = {}) =>
    http(`${BASE}/api/svc:createTicket`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(withRequestId ? { 'X-Request-Id': requestId } : {}),
      },
      body: JSON.stringify(body),
      timeout: 20000,
    });

  const codeOf = (r) => r.json?.errors?.[0]?.code;

  const mobile = (() => {
    let n = 0;
    return () => {
      n += 1;
      return `139${String(Date.now() + n * 613).slice(-8)}`;
    };
  })();

  // -------------------------------------------------------------------------
  console.log('\n── 1 六类都能建（门店角色 · 真 HTTP · 落库逐项核对） ──────────────');
  // -------------------------------------------------------------------------
  await checkAsync('① 六类各建一张：201 + 落库 ticket_type/source/status/归属/操作人 全部正确', async () => {
    const notes = [];
    for (const t of SIX_TYPES) {
      const requestId = crypto.randomUUID();
      const body = {
        store_code: STORE_A,
        ticket_type: t.value,
        content: `[P11-2] 六类人工新建走查：${t.value}`,
        customer_name: '人工新建走查',
        customer_mobile: mobile(),
        // 刻意**最少的字段**：只传必要项，证明"不同业务类型不必填不相关内容"
      };
      // eslint-disable-next-line no-await-in-loop
      const r = await post(tokenA, body, { requestId });
      assert(
        r.status === 201,
        `${t.label}（${t.value}）建单失败：HTTP ${r.status} ${String(r.body).slice(0, 200)}`,
      );
      // 响应形状：`{ ticket_no, store_name, store_code, ticket_id, ticket_type, status, created_at }`
      // ⚠️ 它**同时**是幂等记录里那份 `response_json`（同一个构造函数），
      //    所以重放拿到的形状与首次完全一致（下面有逐字节比对的断言）。
      const no = r.json?.data?.ticket_no;
      // 🔴 立刻登记：**用响应里的 ticket_id**，不等查库、不等后面的断言。
      //    2026-10-10 实录（与 DEV-134 同族）：早期几轮跑在"没回单号"那句断言上抛错，
      //    而登记发生在那之后的查库分支里 ⇒ 已经建出来的单**没有进清理清单**，
      //    库里留下 7 张 `[P11-2]` 脏单。
      //    ⇒ 纪律：**造出 id 的当场就登记**；能拿到 id 的任何来源（响应体 / 返回值）
      //      都比"稍后查库"更早、更可靠。
      if (Number.isFinite(Number(r.json?.data?.ticket_id))) {
        created.push(Number(r.json.data.ticket_id));
      }
      assert(no, `${t.label} 没有回单号：${String(r.body).slice(0, 200)}`);

      // ⚠️ `service_tickets` **没有**"创建人"列（实测：只有 `handler_user_id` = 处理人）。
      //    "谁建的"由 **created 事件**的 `operator_kind` / `operator_user_id` 承载 ——
      //    这是既有设计（下面会正面断言事件），不在这里编造一个不存在的列。
      const row = psqlRows(
        `SELECT t.id, t.ticket_type, t.source, t.status, t.store_id, t.urgent::text, ` +
          ` coalesce(t.handler_user_id::text,'<NULL>'), coalesce(t.service_address,'<NULL>'), ` +
          ` coalesce(t.appliance_category,'<NULL>'), coalesce(t.brand_model,'<NULL>') ` +
          `FROM service_tickets t WHERE t.ticket_no = '${String(no).replace(/'/g, "''")}'`,
      )[0];
      assert(row, `${t.label} 库里查不到 ${no}`);
      created.push(Number(row[0]));

      assert(row[1] === t.value, `${t.label} 落库 ticket_type=${row[1]}`);
      assert(row[2] === 'staff', `${t.label} 落库 source=${row[2]}，期望 staff（人工新建的唯一凭据）`);
      assert(row[3] === 'NEW', `${t.label} 落库 status=${row[3]}，期望 NEW（**不得**重新引入"受理"步骤）`);
      assert(Number(row[4]) === storeIdOf(STORE_A), `${t.label} 归属 store_id=${row[4]}，期望 ${STORE_A}`);
      assert(row[5] === 'false', `${t.label} urgent=${row[5]}，期望 false（未传即 false）`);
      assert(
        row[6] === '<NULL>',
        `${t.label} handler_user_id=${row[6]}，期望 NULL（新建的单还没有处理人）`,
      );
      assert(row[7] === '<NULL>', `${t.label} 未传服务地址却落库了 ${JSON.stringify(row[7])}`);
      assert(row[8] === '<NULL>', `${t.label} 未传家电类别却落库了 ${JSON.stringify(row[8])}`);
      assert(row[9] === '<NULL>', `${t.label} 未传品牌型号却落库了 ${JSON.stringify(row[9])}`);

      // 审计事件：operator_kind=staff + created_via=store_manual
      const events = psqlRows(
        `SELECT event_type, operator_kind, coalesce(operator_user_id::text,'<NULL>'), summary, ` +
          ` coalesce(metadata_json::text,'') FROM ticket_events ` +
          ` WHERE ticket_id = ${Number(row[0])} AND event_type = 'created'`,
      );
      assert(events.length === 1, `${t.label} created 事件有 ${events.length} 条，期望恰好 1 条`);
      const ev = events[0];
      assert(
        ev[1] === 'store',
        `${t.label} 事件 operator_kind=${ev[1]}，期望 store` +
          '（⚠️ 写成 OPERATOR_KIND.STAFF 时会静默落回 customer —— 这个键名不存在）',
      );
      assert(ev[2] !== '<NULL>', `${t.label} 事件里 operator_user_id 为空`);
      assert(
        String(ev[3]).includes('门店提交'),
        `${t.label} 事件 summary=${JSON.stringify(ev[3])} —— 门店建的短应写「门店提交」而不是「客户提交」`,
      );
      assert(
        String(ev[4]).includes('store_manual'),
        `${t.label} 事件 metadata 里没有 created_via=store_manual：${String(ev[4]).slice(0, 120)}`,
      );

      // 反向：事件里不得出现"受理"
      const accepted = Number(
        psqlScalar(`SELECT count(*) FROM ticket_events WHERE ticket_id = ${Number(row[0])} AND event_type = 'accepted'`),
      );
      assert(accepted === 0, `${t.label} 建单就产生了 accepted 事件 —— "受理"步骤被重新引入了`);

      notes.push(`${t.label}✓`);
    }
    return notes.join(' ');
  });

  // -------------------------------------------------------------------------
  console.log('\n── 2 门店隔离：服务端 storeScope 必须挡住跨店创建 ────────────────');
  // -------------------------------------------------------------------------
  await checkAsync('② 门店 A 为门店 B 建单 → 403 STORE_OUT_OF_SCOPE，且**不落库**', async () => {
    const before = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    const r = await post(tokenA, {
      store_code: STORE_B,
      ticket_type: 'repair',
      content: '[P11-2] 反向：门店 A 试图给门店 B 建单',
      customer_name: '越权走查',
      customer_mobile: mobile(),
    });
    assert(r.status === 403, `HTTP ${r.status}（期望 403）：${String(r.body).slice(0, 200)}`);
    assert(codeOf(r) === 'STORE_OUT_OF_SCOPE', `错误码是 ${codeOf(r)}，期望 STORE_OUT_OF_SCOPE`);
    const after = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    assert(after === before, `工单总数 ${before} → ${after} —— 越权请求竟然落库了`);
    return '403 STORE_OUT_OF_SCOPE · 0 增量';
  });

  await checkAsync('② **反向**：总部角色**没有**新建能力（"汇总查看 ≠ 跨店创建"）', async () => {
    const before = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    // 总部账号对**每一家**门店都试一遍：只要有一家能建，这条就红
    const allowed = [];
    for (const code of [STORE_A, STORE_B]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await post(tokenHq, {
        store_code: code,
        ticket_type: 'repair',
        content: `[P11-2] 反向：总部试图给 ${code} 建单`,
        customer_name: '总部越权走查',
        customer_mobile: mobile(),
      });
      if (r.status === 201) allowed.push(code);
      else assert(r.status === 403, `总部对 ${code} 得到 HTTP ${r.status}（期望 403）`);
    }
    assert(allowed.length === 0, `总部角色竟然建出了单：${allowed.join(', ')} —— 跨店创建权限被放开了`);
    const after = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    assert(after === before, `总部请求落库了：${before} → ${after}`);
    return '总部 2/2 门店均 403 · 0 增量';
  });

  await checkAsync('② 门店 B 反过来也不能给门店 A 建单（不是"单向挡"）', async () => {
    const r = await post(tokenB, {
      store_code: STORE_A,
      ticket_type: 'repair',
      content: '[P11-2] 反向：门店 B 试图给门店 A 建单',
      customer_name: '越权走查B',
      customer_mobile: mobile(),
    });
    assert(r.status === 403, `HTTP ${r.status}（期望 403）`);
    assert(codeOf(r) === 'STORE_OUT_OF_SCOPE', `错误码是 ${codeOf(r)}`);
    // 正向对照：B 给自己建是允许的（否则"403"可能只是"谁都不许"）
    const okSelf = await post(tokenB, {
      store_code: STORE_B,
      ticket_type: 'repair',
      content: '[P11-2] 正向对照：门店 B 给自己建单',
      customer_name: '正向对照B',
      customer_mobile: mobile(),
    });
    assert(okSelf.status === 201, `门店 B 给自己建单失败：HTTP ${okSelf.status} ${String(okSelf.body).slice(0, 160)}`);
    if (Number.isFinite(Number(okSelf.json?.data?.ticket_id))) {
      created.push(Number(okSelf.json.data.ticket_id));
    }
    const no = okSelf.json?.data?.ticket_no;
    const id = Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no = '${no}'`));
    if (id) created.push(id);
    return 'B→A 403 · B→B 201（正反对照）';
  });

  await checkAsync('② 未登录 / 缺 X-Request-Id 分别得到 401 / 422（不是 500）', async () => {
    const anon = await http(`${BASE}/api/svc:createTicket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({ store_code: STORE_A, ticket_type: 'repair', content: '匿名越权走查', customer_name: 'x', customer_mobile: mobile() }),
      timeout: 20000,
    });
    assert(anon.status === 401 || anon.status === 403, `未登录得到 HTTP ${anon.status}（期望 401/403）`);
    const noRid = await post(tokenA, { store_code: STORE_A, ticket_type: 'repair', content: '缺请求号走查', customer_name: 'x', customer_mobile: mobile() }, { withRequestId: false });
    assert(noRid.status === 422, `缺 X-Request-Id 得到 HTTP ${noRid.status}（期望 422）`);
    return `未登录 ${anon.status} · 缺请求号 422`;
  });

  await checkAsync('② 幂等：同 X-Request-Id 重放 → 200 + 同单号，且不新建', async () => {
    const requestId = crypto.randomUUID();
    const body = {
      store_code: STORE_A,
      ticket_type: 'maintenance',
      content: '[P11-2] 幂等走查：同请求号重放',
      customer_name: '幂等走查',
      customer_mobile: mobile(),
    };
    const first = await post(tokenA, body, { requestId });
    assert(first.status === 201, `首次 HTTP ${first.status}：${String(first.body).slice(0, 160)}`);
    if (Number.isFinite(Number(first.json?.data?.ticket_id))) {
      created.push(Number(first.json.data.ticket_id));
    }
    const no = first.json?.data?.ticket_no;
    const id = Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no = '${no}'`));
    if (id) created.push(id);

    const before = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    const second = await post(tokenA, body, { requestId });
    assert(second.status === 200, `重放 HTTP ${second.status}（期望 200，不是 201）`);
    assert(
      second.json?.data?.ticket_no === no,
      `重放拿到 ${JSON.stringify(second.json?.data?.ticket_no)}，期望 ${no}`,
    );
    const after = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    assert(after === before, `重放新建了工单：${before} → ${after}`);
    // 🔴 幂等的**定义**是"两次响应逐字节一致"，不是"单号相同"。
    //    第一版就是栽在这里：首次回嵌套 `{ticket,event,store}`、重放回扁平对象，
    //    单号一样却形状不同 —— 那叫"两次不同的响应"。
    assert(
      JSON.stringify(first.json?.data) === JSON.stringify(second.json?.data),
      `两次响应体不一致：首次 ${JSON.stringify(first.json?.data)} / 重放 ${JSON.stringify(second.json?.data)}`,
    );
    return `${no} 重放 · 工单数不变 · 两次响应体逐字节一致`;
  });

  /**
   * 🔴 用户裁决二 · 第 10 条："相同 Request-Id **不同内容**不得错误复用既有结果"。
   *
   * 这条比"同内容能重放"重要得多：只按 requestId 命中就回放，会让
   * "换了内容却复用同一个 requestId"的请求**根本没被创建**，而调用方看到"成功 + 单号"。
   * 那是**静默丢请求** —— 比报错危险。
   *
   * 判据必须**双向**：
   *   · 同 requestId + 改内容 ⇒ **409 `IDEMPOTENT_PAYLOAD_MISMATCH`** 且不新建；
   *   · 同 requestId + 原内容 ⇒ 仍然 200 回放（否则"防复用"就把幂等本身弄坏了）。
   */
  await checkAsync('② **反向**：同 Request-Id + 改内容 ⇒ 409 IDEMPOTENT_PAYLOAD_MISMATCH，且不新建', async () => {
    const requestId = crypto.randomUUID();
    const base = {
      store_code: STORE_A,
      ticket_type: 'repair',
      content: '[P11-2] 幂等复用反例：第一份内容',
      customer_name: '幂等反例',
      customer_mobile: mobile(),
    };
    const first = await post(tokenA, base, { requestId });
    assert(first.status === 201, `首次 HTTP ${first.status}`);
    const fid = Number(first.json?.data?.ticket_id);
    if (Number.isFinite(fid)) created.push(fid);
    const no = first.json?.data?.ticket_no;

    const before = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    // 三种"改了内容"的形态：改正文 / 改类型 / 改客户手机号
    //
    // ⚠️ **改门店不在这里**：它会被**门店范围校验先拦成 403 `STORE_OUT_OF_SCOPE`** ——
    //    那是对的，而且是更保守的顺序（越权者不该从幂等这条路里探出
    //    "某个 requestId 是否已被用过、用在哪家门店"）。
    //    所以"改门店"单独作为一条 403 断言放在下面。
    const mutations = [
      ['改正文', { ...base, content: '[P11-2] 幂等复用反例：**另一份**内容' }],
      ['改类型', { ...base, ticket_type: 'complaint' }],
      ['改手机号', { ...base, customer_mobile: mobile() }],
    ];
    const problems = [];
    for (const [label, body] of mutations) {
      // eslint-disable-next-line no-await-in-loop
      const r = await post(tokenA, body, { requestId });
      if (r.status !== 409 || codeOf(r) !== 'IDEMPOTENT_PAYLOAD_MISMATCH') {
        problems.push(`${label}: HTTP ${r.status} code=${codeOf(r)}（期望 409 IDEMPOTENT_PAYLOAD_MISMATCH）`);
      }
    }
    const after = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    assert(problems.length === 0, problems.join('；'));
    assert(after === before, `被拒的复用请求竟然落库了：${before} → ${after}`);

    // 反向的正向对照：原封不动地再发一次，仍须 200 回放同单号
    const again = await post(tokenA, base, { requestId });
    assert(again.status === 200, `原内容重放 HTTP ${again.status}（期望 200）`);
    assert(again.json?.data?.ticket_no === no, `原内容重放拿到 ${again.json?.data?.ticket_no}，期望 ${no}`);

    // 同 requestId + 改门店 ⇒ **403 越权优先**（不是 409）：判据落在"越权先于幂等"这条顺序上
    const crossStore = await post(tokenA, { ...base, store_code: STORE_B }, { requestId });
    assert(
      crossStore.status === 403 && codeOf(crossStore) === 'STORE_OUT_OF_SCOPE',
      `同 requestId 改门店得到 HTTP ${crossStore.status} code=${codeOf(crossStore)}；` +
        '期望 403 STORE_OUT_OF_SCOPE（门店范围校验必须**先于**幂等判定）',
    );

    return `${mutations.length} 种改法全部 409 且不新建；改门店 403（越权优先）；原内容仍 200 回放 ${no}`;
  });

  // -------------------------------------------------------------------------
  console.log('\n── 3 与匿名面继续隔离（用户明令：内部六类不得泄漏成客户选项）──');
  // -------------------------------------------------------------------------
  await checkAsync('③ **反向**：匿名接口提交内部类型（安装/其他）→ 422，且不落库', async () => {
    const before = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    const results = [];
    for (const value of SIX_TYPES.map((t) => t.value).filter((v) => !PUBLIC_TYPES.includes(v))) {
      // eslint-disable-next-line no-await-in-loop
      const r = await http(`${BASE}/api/public/tickets${storeEntryQuery(STORE_A)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
        body: JSON.stringify({
          store_code: STORE_A,
          ticket_type: value,
          content: `[P11-2] 反向：匿名伪造内部类型 ${value}`,
          customer_name: '匿名伪造型走查',
          customer_mobile: mobile(),
        }),
        timeout: 15000,
      });
      assert(r.status === 422, `匿名提交 ${value} 得到 HTTP ${r.status}（期望 422）`);
      assert(
        r.json?.errors?.[0]?.code === 'INVALID_TICKET_TYPE',
        `匿名提交 ${value} 的错误码是 ${r.json?.errors?.[0]?.code}`,
      );
      results.push(value);
    }
    const after = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    assert(after === before, `被拒的匿名请求落库了：${before} → ${after}`);
    return `${results.join('/')} 均 422 INVALID_TICKET_TYPE · 0 增量`;
  });

  await checkAsync('③ **反向**：匿名伪造 urgent=true 仍然无效（落库 false）', async () => {
    const r = await http(`${BASE}/api/public/tickets${storeEntryQuery(STORE_A)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({
        store_code: STORE_A,
        ticket_type: 'repair',
        content: '[P11-2] 反向：匿名伪造 urgent',
        customer_name: '匿名声称紧急走查',
        customer_mobile: mobile(),
        urgent: true,
      }),
      timeout: 15000,
    });
    assert(r.status === 201 || r.status === 200, `HTTP ${r.status}：${String(r.body).slice(0, 160)}`);
    const no = r.json?.data?.ticket_no;
    const row = psqlRows(
      `SELECT id, urgent::text FROM service_tickets WHERE ticket_no = '${String(no).replace(/'/g, "''")}'`,
    )[0];
    assert(row, `查不到 ${no}`);
    created.push(Number(row[0]));
    assert(row[1] === 'false', `匿名声称 urgent=true 竟然落库为 ${row[1]} —— 内部能力泄漏到客户面了`);
    return `${no} 落库 urgent=false`;
  });

  check(
    '③ 匿名面白名单在源码层仍是两类（`PUBLIC_TICKET_TYPE_VALUES`），未与六类合并',
    () => {
      // ⚠️ 不通过 `require('@local/service-ticket')` 取它：构建产物**只 re-export 了
      //    种子与少数常量**（`STORE_SEEDS` / `TICKET_TYPE_VALUES`），
      //    首次就是这么拿到 `undefined` 的。这里直接读源码 —— 判据要的是
      //    "两处定义没有合并"，源码就是它的唯一事实来源。
      const src = fs.readFileSync(
        path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/constants.ts'),
        'utf8',
      );
      const m = /export const PUBLIC_TICKET_TYPE_VALUES[^=]*=\s*\[([^\]]*)\]/.exec(src);
      assert(m, '解析不到 PUBLIC_TICKET_TYPE_VALUES');
      const names = m[1]
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => (/^TICKET_TYPE\.([A-Z_]+)$/.exec(x) || [])[1]);
      const values = names.map((n) => ({ REPAIR: 'repair', COMPLAINT: 'complaint' })[n] ?? n);
      assert(
        JSON.stringify(values) === JSON.stringify(PUBLIC_TYPES),
        `匿名白名单=${JSON.stringify(values)}，期望 ${JSON.stringify(PUBLIC_TYPES)}`,
      );
      // 内部六类：从同文件的 TICKET_TYPE 对象取，条数必须是 6
      const block = /export const TICKET_TYPE = \{([\s\S]*?)\} as const;/.exec(src)?.[1] ?? '';
      const keys = [...block.matchAll(/^\s*([A-Z_]+):\s*'/gm)].map((x) => x[1]);
      assert(keys.length === 6, `TICKET_TYPE 有 ${keys.length} 项，期望 6 项`);
      // 反向：两者**不能是同一个集合**（那正是"六类泄漏成客户选项"的形态）
      assert(
        values.length !== keys.length,
        '匿名白名单与内部六类长度相同 —— 六类可能已经泄漏成客户选项',
      );
      return `内部 ${keys.length} 类 / 匿名 ${values.length} 类（${values.join(',')}）`;
    },
  );

  // -------------------------------------------------------------------------
  console.log('\n── 4 不重引入已取消的东西 ──────────────────────────────────────');
  // -------------------------------------------------------------------------
  await checkAsync('④ 新建的单状态恒为 NEW，且**没有**任何 accepted 事件', async () => {
    const ids = created.filter(Boolean);
    if (ids.length === 0) throw new EnvNotReady('本轮没有可核对的样本单');
    const bad = psqlRows(
      `SELECT id, status FROM service_tickets WHERE id IN (${ids.join(',')}) AND status <> 'NEW'`,
    );
    assert(bad.length === 0, `这些单不是 NEW：${bad.map((r) => `${r[0]}=${r[1]}`).join(', ')}`);
    const accepted = Number(
      psqlScalar(
        `SELECT count(*) FROM ticket_events WHERE ticket_id IN (${ids.join(',')}) AND event_type = 'accepted'`,
      ),
    );
    assert(accepted === 0, `样本里出现了 ${accepted} 条 accepted 事件`);
    return `${ids.length} 张样本单全部 NEW · accepted 事件 0 条`;
  });

  await checkAsync('④ 跨店转单仍不可用（门店角色 → 403 TRANSFER_DISABLED）', async () => {
    const id = created.find(Boolean);
    if (!id) throw new EnvNotReady('缺样本单');
    const r = await http(`${BASE}/api/svc:transfer?filterByTk=${id}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
        'X-Request-Id': crypto.randomUUID(),
      },
      body: JSON.stringify({ target_store_id: storeIdOf(STORE_B), reason: '反向走查' }),
      timeout: 20000,
    });
    assert(r.status === 403, `HTTP ${r.status}（期望 403）：${String(r.body).slice(0, 160)}`);
    const code = r.json?.errors?.[0]?.code;
    assert(code === 'TRANSFER_DISABLED', `错误码是 ${code}，期望 TRANSFER_DISABLED`);
    return '403 TRANSFER_DISABLED';
  });

  // -------------------------------------------------------------------------
  console.log('\n── 5 字段按类型"够用即止"（不强迫填不相关内容） ──────────────────');
  // -------------------------------------------------------------------------
  await checkAsync('⑤ 投诉单只传三项也能建（无需故障类型/上门地址）', async () => {
    const r = await post(tokenA, {
      store_code: STORE_A,
      ticket_type: 'complaint',
      content: '[P11-2] 投诉只填三项走查',
      customer_name: '投诉走查',
      customer_mobile: mobile(),
    });
    assert(r.status === 201, `HTTP ${r.status}：${String(r.body).slice(0, 160)}`);
    if (Number.isFinite(Number(r.json?.data?.ticket_id))) created.push(Number(r.json.data.ticket_id));
    const no = r.json.data.ticket_no;
    const row = psqlRows(
      `SELECT id, coalesce(appliance_category,'<NULL>'), coalesce(service_address,'<NULL>'), coalesce(brand_model,'<NULL>') FROM service_tickets WHERE ticket_no = '${String(no).replace(/'/g, "''")}'`,
    )[0];
    created.push(Number(row[0]));
    assert(
      row[1] === '<NULL>' && row[2] === '<NULL>' && row[3] === '<NULL>',
      `投诉单被塞了不相关字段：${JSON.stringify(row)}`,
    );
    return `${no} 三项即可建单，其余列 NULL`;
  });

  await checkAsync('⑤ 安装单可带服务地址+家电类别，但**不**要求填维修结果类字段', async () => {
    const r = await post(tokenA, {
      store_code: STORE_A,
      ticket_type: 'installation',
      content: '[P11-2] 安装单带地址与机型走查',
      customer_name: '安装走查',
      customer_mobile: mobile(),
      service_address: '成都市新都区某小区1栋2单元303',
      appliance_category: 'air_conditioner',
      brand_model: '格力 KFR-35GW',
      urgent: true,
    });
    assert(r.status === 201, `HTTP ${r.status}：${String(r.body).slice(0, 160)}`);
    if (Number.isFinite(Number(r.json?.data?.ticket_id))) created.push(Number(r.json.data.ticket_id));
    const no = r.json.data.ticket_no;
    const row = psqlRows(
      `SELECT id, service_address, appliance_category, brand_model, urgent::text, status FROM service_tickets WHERE ticket_no = '${String(no).replace(/'/g, "''")}'`,
    )[0];
    created.push(Number(row[0]));
    assert(row[1] === '成都市新都区某小区1栋2单元303', `service_address=${JSON.stringify(row[1])}`);
    assert(row[2] === 'air_conditioner', `appliance_category=${row[2]}`);
    assert(row[3] === '格力 KFR-35GW', `brand_model=${row[3]}`);
    assert(row[4] === 'true', `员工设的 urgent=true 没落库（实际 ${row[4]}）`);
    assert(row[5] === 'NEW', `status=${row[5]}，期望 NEW`);
    return `${no} 地址/类别/型号/紧急全部落库 · status=NEW`;
  });

  await checkAsync('⑤ 反向：非法值被拒（家电类型越界 / urgent 传字符串 / 服务地址超长）', async () => {
    const cases = [
      [{ appliance_category: 'fridge' }, 'INVALID_APPLIANCE_CATEGORY', '家电类型越界'],
      [{ urgent: 'true' }, 'INVALID_URGENT', 'urgent 传字符串'],
      [{ service_address: '地'.repeat(201) }, 'INVALID_FIELD_LENGTH', '服务地址超长'],
      [{ brand_model: 'x'.repeat(65) }, 'INVALID_FIELD_LENGTH', '品牌型号超长'],
    ];
    const before = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    const problems = [];
    for (const [extra, expectCode, label] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const r = await post(tokenA, {
        store_code: STORE_A,
        ticket_type: 'repair',
        content: `[P11-2] 反向非法值走查：${label}`,
        customer_name: '非法值走查',
        customer_mobile: mobile(),
        ...extra,
      });
      if (r.status !== 422 || codeOf(r) !== expectCode) {
        problems.push(`${label}: HTTP ${r.status} code=${codeOf(r)}（期望 422 ${expectCode}）`);
      }
    }
    const after = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    assert(problems.length === 0, problems.join('；'));
    assert(after === before, `非法值请求落库了：${before} → ${after}`);
    return `${cases.length} 类非法值全部 422 且不落库`;
  });

  summary();
}

// ---------------------------------------------------------------------------
// 清理：**必然执行**（挂 runMain 的 cleanup，见 DEV-134）
// ---------------------------------------------------------------------------
function cleanup() {
  const ids = [...new Set(created.filter((n) => Number.isFinite(n) && n > 0))];
  if (ids.length === 0) {
    console.log('  · 无需清理');
    return;
  }
  let removed = 0;
  for (const id of ids) {
    try {
      if (Number(psqlScalar(`SELECT count(*) FROM service_tickets WHERE id = ${id}`)) === 0) continue;
      cleanupTicket(id);
      removed += 1;
    } catch (error) {
      console.log(`  ⚠️ 清理工单 ${id} 失败：${error?.message}`);
    }
  }
  const left = ids.filter((id) => Number(psqlScalar(`SELECT count(*) FROM service_tickets WHERE id = ${id}`)) > 0);
  console.log(
    left.length === 0
      ? `  · 已清理本轮自建工单 ${removed} 张（回查残留 0）`
      : `  ⚠️ 清理后仍残留 ${left.length} 张（id=${left.join(',')}）`,
  );
}

await runMain({ name: '门店人工新建服务单 · 六类 / 隔离 / 审计', main, cleanup });

if (SVC_TLS_INSECURE) {
  /* 自签演练证书：base-url.mjs 已打印过提示 */
}
