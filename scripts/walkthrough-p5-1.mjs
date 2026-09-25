#!/usr/bin/env node
/**
 * walkthrough-p5-1.mjs —— 真实 H5 走查的**准备**与**复核**（P5-1 证据④）
 * =============================================================================
 *
 * 这个脚本**不是**断言矩阵 —— Token 矩阵、上传矩阵、submit 原子性各有专脚本。
 * 它只回答一件事，而且是自动化**不能**替代的那件事：
 *
 *     用一个**真实短信形状**的链接（`/t/{token}`），在**真实浏览器**里
 *     走完 打开 → 看上下文 → 传照片 → 提交，之后数据库里到底发生了什么？
 *
 * 所以拆成两个子命令，中间**夹着人的操作**：
 *
 *   node scripts/walkthrough-p5-1.mjs setup     # 造一张真单 + 真派工 → 打印短链
 *   ……（人在浏览器里点完）……
 *   node scripts/walkthrough-p5-1.mjs verify    # 复核浏览器**真的**写进去了什么
 *
 * -----------------------------------------------------------------------------
 * 为什么 `verify` 里也有断言（而不是只打印）
 * -----------------------------------------------------------------------------
 * 走查的价值在于"**浏览器那条路径**真的写进了库"。若只打印，一次"页面上看着
 * 成功了、库里其实没动"会被读成通过 —— 那是假绿。所以这里断言：
 *   · Visit 推进到 SUBMITTED、`token_used_at` 已置、`submitted_at` 非空
 *   · Ticket 到 WAIT_STORE_CONFIRM（**且不是** CLOSED —— P5-1 的停止线）
 *   · 事件里恰好出现一条 `technician_submitted`
 *   · 照片：库里 ≥1 行，且私有目录**确有**文件、公共可服务目录**没有**
 *   · 同一 Token 再 GET → 401、再 submit → 401（闭环两头都关上）
 *
 * ⚠️ 它**不删除**走查工单 —— 证据要能被复核。要复位库请用
 *    `node scripts/uat-reset-baseline.mjs`（那会把库恢复到 4 张基线单）。
 *
 * 用法 / 退出码：0 通过 / 1 真红灯 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  ROOT,
  BASE_URL,
  PUBLIC_BASE_URL,
  assert,
  eq,
  psqlScalar,
  psqlRows,
  twoSessions,
  createScratchTicket,
  acceptAndDispatch,
  tokenFromOutbox,
  smsSwitch,
  technicianGet,
  technicianSubmit,
  privateFileExists,
  publicFileExists,
  publicPhotoFiles,
  visitSnapshots,
  ticketSnapshot,
  eventRows,
  photoRows,
  runMain,
  EnvNotReady,
} from './technician-harness.mjs';

const STATE_FILE = path.join(ROOT, '.tmp-verify', 'evidence', 'walkthrough-state.json');
const TAG = 'P5-1走查';

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    throw new EnvNotReady(
      `找不到走查状态文件（${STATE_FILE}）—— 先跑 \`node scripts/walkthrough-p5-1.mjs setup\``,
    );
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

// =============================================================================
//  setup —— 造一张真单，派工，把**真实短信里的那枚 Token** 打出来
// =============================================================================
async function setup() {
  const { store, hq } = await twoSessions();
  const sms = smsSwitch();

  try {
    // 派工要发短信才有 Token 可取（发件箱是取 Token 的唯一真实来源）
    await sms.enable();

    const ticket = await createScratchTicket({
      tag: TAG,
      content: '不走查用：P5-1 真实浏览器闭环（照片 + 回执）',
    });
    await acceptAndDispatch(ticket.ticketId, store, {
      technician_name: '王师傅',
      technician_mobile: '13900010001',
      service_mode: 'manufacturer',
      provider_name: 'P5-1走查厂家',
    });
    const { token, seq, matches } = await tokenFromOutbox({
      sessionToken: hq,
      ticketNo: ticket.ticketNo,
    });

    const visitId = Number(
      psqlScalar(
        `SELECT id FROM service_visits WHERE ticket_id = ${ticket.ticketId} ORDER BY visit_no DESC LIMIT 1`,
      ),
    );

    const shortLink = `${PUBLIC_BASE_URL}/t/${token}`;
    const internalPath = `/h5/technician/visit/${token}`;

    console.log('');
    console.log('  ┌── 走查夹具已就绪（请在**真实浏览器**里打开下面的链接）');
    console.log(`  │ 工单号     ${ticket.ticketNo}（id=${ticket.ticketId}）`);
    console.log(`  │ Visit      id=${visitId}`);
    console.log(`  │ Token      ${token}`);
    console.log(`  │ 短信 seq   ${seq}（该工单 ${matches} 条 technician_task）`);
    console.log(`  │ 短链（用这个） ${shortLink}`);
    console.log(`  │ 302 之后落在   ${internalPath}`);
    console.log('  └─ 走查动作：打开 → 核对最小上下文 → 传 1~2 张照片 → 填回执 → 提交');
    console.log('     提交后页面应显示「已提交，等待门店确认」；再看一眼刷新后是否仍显示同一句。');
    console.log('');
    console.log('  走查前状态（复核时用来对比）：');
    console.log(`    Visit : ${visitSnapshots(ticket.ticketId)[0] ?? '(无)'}`);
    console.log(`    Ticket: ${ticketSnapshot(ticket.ticketId)}`);
    console.log(`    事件  : ${eventRows(ticket.ticketId).length} 条`);

    saveState({
      ticketId: ticket.ticketId,
      ticketNo: ticket.ticketNo,
      visitId,
      token,
      shortLink,
      internalPath,
      smsSeq: seq,
      createdAt: new Date().toISOString(),
      preEventCount: eventRows(ticket.ticketId).length,
      prePhotoCount: photoRows(ticket.ticketId).length,
    });
    console.log(`\n  状态已存：${path.relative(ROOT, STATE_FILE)}`);
    console.log('');
  } finally {
    const r = sms.restore();
    console.log(`  · 短信开关已复位：${r.note}`);
  }
}

// =============================================================================
//  verify —— 复核"浏览器真的写进去了什么"
// =============================================================================
async function verify() {
  const state = loadState();
  const { ticketId, visitId, token, ticketNo } = state;

  console.log('');
  console.log(`  复核对象：${ticketNo}（ticket_id=${ticketId} / visit_id=${visitId}）`);
  console.log(`  走查前事件数：${state.preEventCount} · 走查前照片数：${state.prePhotoCount}`);
  console.log('');

  // ---- ① Visit：状态 / 回执字段 / Token 消费 ----
  const v = psqlRows(
    `SELECT visit_status, store_confirm_status, coalesce(service_result,'-'),` +
      ` coalesce(service_note,'-'), is_charged::text, coalesce(reported_charge_amount::text,'-'),` +
      ` (token_used_at IS NOT NULL)::text, coalesce(submitted_at::text,'-')` +
      ` FROM service_visits WHERE id = ${visitId}`,
  )[0];
  assert(v, `查不到 visit_id=${visitId}`);
  const [visitStatus, confirmStatus, result, note, charged, amount, used, submittedAt] = v;

  console.log('  【Visit】');
  console.log(`    状态            ${visitStatus}`);
  console.log(`    门店确认状态    ${confirmStatus}`);
  console.log(`    处理结果        ${result}`);
  console.log(`    处理说明        ${note}`);
  console.log(`    是否收费        ${charged} / 金额 ${amount}`);
  console.log(`    Token 已消费    ${used}`);
  console.log(`    提交时间        ${submittedAt}`);
  console.log('');

  assert(visitStatus === 'SUBMITTED', `Visit 应为 SUBMITTED，实际 ${visitStatus} —— 浏览器里的提交没落到库`);
  assert(used === 'true', 'token_used_at 未置位 —— 一次性失效没生效');
  assert(submittedAt !== '-', 'submitted_at 为空 —— 回执字段没写回');
  assert(result !== '-', 'service_result 为空 —— 回执字段没写回');
  assert(note !== '-', 'service_note 为空 —— 回执字段没写回');
  // 收费口径自洽：收费必须有正金额；不收费必须为 NULL（不得留残留值）
  const chargeSane = charged === 'true' ? amount !== '-' && Number(amount) > 0 : amount === '-';
  assert(chargeSane, `收费口径不一致：is_charged=${charged} 但金额=${amount}`);

  // ---- ② Ticket：必须停在 WAIT_STORE_CONFIRM ----
  const t = psqlRows(
    `SELECT status, coalesce(completed_at::text,'-'), coalesce(reviewed_at::text,'-')` +
      ` FROM service_tickets WHERE id = ${ticketId}`,
  )[0];
  console.log('  【Ticket】');
  console.log(`    状态          ${t[0]}`);
  console.log(`    completed_at  ${t[1]}`);
  console.log(`    reviewed_at   ${t[2]}`);
  console.log('');
  eq(t[0], 'WAIT_STORE_CONFIRM', 'Ticket 状态');
  assert(t[0] !== 'CLOSED', 'Ticket 不得到 CLOSED —— P5-1 的停止线');
  assert(t[1] === '-', 'completed_at 不该被写（工单未完成）');

  // ---- ③ 事件：恰好一条 technician_submitted ----
  const events = eventRows(ticketId);
  const submitted = events.filter((e) => e[0] === 'technician_submitted');
  console.log('  【TicketEvent】');
  for (const e of events) console.log(`    ${e[0]} | ${e[1]} → ${e[2]} | visit=${e[3]} | ${e[4]}`);
  console.log('');
  eq(submitted.length, 1, 'technician_submitted 事件条数（**不得**有第二条）');
  assert(
    Number(submitted[0][3]) === visitId,
    `事件挂的 visit_id=${submitted[0][3]} 与本次走查的 visit_id=${visitId} 不一致`,
  );
  eq(events.length, state.preEventCount + 1, '事件总数（走查只应 +1）');

  // ---- ④ 照片：库里可见 + 私有目录有文件 + 公共目录没有 ----
  const photos = photoRows(ticketId);
  console.log('  【照片】');
  for (const p of photos) {
    const key = String(p[3]);
    const inPrivate = privateFileExists(key);
    const inPublic = publicFileExists(key);
    // 真的打一次公共静态路径（对标 PHASE-5 §6.3："不是'没试过'，是真的打一次"）
    const publicProbe = await fetch(`${BASE_URL}/storage/uploads/${key}`);
    console.log(
      `    id=${p[0]} type=${p[2]} mime=${p[4]} size=${p[5]}` +
        ` 私有=${inPrivate} 公共文件=${inPublic} 公共 HTTP=${publicProbe.status}`,
    );
  }
  console.log(`    公共可服务目录里现有的图片（应只有后台 logo）：${JSON.stringify(publicPhotoFiles())}`);
  console.log('');
  assert(photos.length >= 1, '库里 0 张照片 —— 浏览器里的上传没落库');
  for (const p of photos) {
    const key = String(p[3]);
    assert(privateFileExists(key), `私有目录缺少照片文件：${key}`);
    // ⚠️ 判据落到**本次这个 key** 上（不是"公共目录里有没有图片"）
    assert(!publicFileExists(key), `本次照片出现在公共可服务目录里：${key}`);
    const probe = await fetch(`${BASE_URL}/storage/uploads/${key}`);
    const probeType = probe.headers.get('content-type') ?? '';
    assert(
      [401, 403, 404].includes(probe.status),
      `公共静态路径返回了意外状态 HTTP ${probe.status}：/storage/uploads/${key}`,
    );
    // 判据是"**取不到图片内容**"，不是死磕某个状态码：
    // nginx 把 `/storage/uploads/` 反代给应用（故意不 alias 到磁盘），
    // 所以匿名请求得到 401 —— 那是**正确**行为，不是缺陷。
    assert(
      !probeType.startsWith('image/'),
      `公共静态路径返回了图片内容（Content-Type: ${probeType}）：/storage/uploads/${key}`,
    );
  }

  // ---- ⑤ 闭环两头：同一 Token 再进 / 再提交都必须 401 ----
  const again = await technicianGet(token);
  const resubmit = await technicianSubmit(token, {
    service_result: 'resolved',
    service_note: '走查复核：重放不应成功',
    is_charged: false,
  });
  console.log('  【闭环收口】');
  console.log(`    再次 GET      ${again.status} ${again.json?.errors?.[0]?.code ?? ''}`);
  console.log(`    再次 submit   ${resubmit.status} ${resubmit.json?.errors?.[0]?.code ?? ''}`);
  console.log('');
  eq(again.status, 401, '走查后同一 Token 的 GET');
  eq(again.json?.errors?.[0]?.code, 'TOKEN_INVALID', '走查后同一 Token 的错误码');
  eq(resubmit.status, 401, '走查后同一 Token 的 submit');
  eq(resubmit.json?.errors?.[0]?.code, 'TOKEN_INVALID', '走查后同一 Token 的 submit 错误码');

  // 重放之后事件数**不得**再变（否则"用后即焚"是假的）
  eq(eventRows(ticketId).length, events.length, '重放后事件总数');

  console.log('  ✅ 真实浏览器闭环成立：浏览器写进库的四样（Visit/Ticket/Token/Event）全部到位，');
  console.log('     且同一 Token 事后不可再进、不可再提交。');
  console.log('');
}

/**
 * ⚠️ 这里**不**用 harness 的 `runMain`。
 *    它的口径是"任何异常都算环境未就绪（退出码 2）"，而本脚本必须区分：
 *      · 环境问题（取不到 Token / 状态文件缺失）→ 2
 *      · 断言失败（浏览器没写进库 / Token 事后还能用）→ **1，真红灯**
 *    混在一起会把"产品坏了"报成"环境没准备好"，而这正是铁律 9 要防的事。
 */
try {
  const cmd = process.argv[2];
  console.log('\n=== P5-1 真实 H5 走查 ===');
  if (cmd === 'setup') await setup();
  else if (cmd === 'verify') await verify();
  else {
    console.log('\n  用法：node scripts/walkthrough-p5-1.mjs <setup|verify>\n');
    process.exit(2);
  }
} catch (error) {
  if (error instanceof EnvNotReady) {
    console.log(`\n  🟡 环境未就绪（退出码 2）：${error.message}\n`);
    process.exit(2);
  }
  console.log(`\n  ❌ 真红灯（退出码 1）：${error?.message ?? error}\n`);
  process.exit(1);
}

