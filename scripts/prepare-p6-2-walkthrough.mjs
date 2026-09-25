#!/usr/bin/env node
/**
 * prepare-p6-2-walkthrough.mjs —— 造两张「待门店确认」走查工单（P6-2 真人走查准备）
 * =============================================================================
 *
 * P6-2 的真人走查只需两条（用户 2026-09-25 拍板）：
 *   ① 一张 WAIT_STORE_CONFIRM 工单 → 确认成功 → 页面进入「待评价」，按钮消失。
 *   ② 一张 WAIT_STORE_CONFIRM 工单 → 驳回成功 → 页面回到「处理中」，按钮消失。
 *
 * 本脚本只做**准备**：走真实接口造两张工单（一张收费、一张不收费，覆盖
 * 「确认时金额输入框的两种显隐」），把 ticket_no 与账号打出来，**不删**。
 * 走查完成后由 `scripts/verify-store-review-write.mjs` 的 cleanupTicket 或手动清理。
 *
 * ⚠️ 为什么要"收费 + 不收费"各一张：
 *   确认模态框的金额输入框**只在 is_charged=true 时出现**（契约 O4/O5），
 *   真人走查要同时看到两种形态（收费 → 有金额框、可改额留痕；不收费 → 无金额框），
 *   否则「不收费不出现 0.00 输入框」这条用户特意点名的要求就没有人看过。
 *
 * 用法：
 *   node scripts/prepare-p6-2-walkthrough.mjs            # 造两张
 *   node scripts/prepare-p6-2-walkthrough.mjs --cleanup  # 删掉最近一次造的两张
 *
 * 退出码：0 成功 / 2 环境未就绪
 */
import { randomUUID } from 'node:crypto';

import {
  acceptAndDispatch,
  cleanupTicket,
  createScratchTicket,
  ensureFixtureJpeg,
  envValue,
  psqlRows,
  psqlScalar,
  runMain,
  signIn,
  smsSwitch,
  technicianSubmit,
  technicianUpload,
  tokenFromOutbox,
  twoSessions,
  STORE_EMAIL,
  HQ_EMAIL,
} from './technician-harness.mjs';

const CLEANUP = process.argv.includes('--cleanup');

// 造两张工单的标记（走查后按 tag 反查并删除）
const RUN_TAG = `P6-2-UAT-${randomUUID().slice(0, 6)}`;

async function buildOne({ tag, storeToken, hqToken, charged, amount }) {
  const { ticketId, ticketNo } = await createScratchTicket({
    tag,
    content: `P6-2 真人走查（${charged ? '收费' : '不收费'}），跑完请按 tag 清理`,
  });
  await acceptAndDispatch(ticketId, storeToken);

  const { token } = await tokenFromOutbox({ sessionToken: hqToken, ticketNo });
  if (!token) throw new Error(`工单 ${ticketNo} 取不到师傅 Token`);

  await technicianUpload(token, ensureFixtureJpeg(), {
    filename: `${tag}-onsite.jpg`,
    photoType: 'onsite',
  });

  const submit = await technicianSubmit(token, {
    service_result: 'resolved',
    service_note: `P6-2 ${tag} 走查说明`,
    is_charged: charged === true,
    reported_charge_amount: charged === true ? amount : null,
  });
  if (submit.status !== 200) {
    throw new Error(`师傅提交失败 HTTP ${submit.status} ${String(submit.body).slice(0, 200)}`);
  }

  const visitId = Number(
    psqlScalar(
      `SELECT id FROM service_visits WHERE ticket_id = ${ticketId} ORDER BY visit_no DESC LIMIT 1`,
    ),
  );
  return { tag, ticketId, ticketNo, visitId };
}

async function main() {
  const { store, hq } = await twoSessions();

  if (CLEANUP) {
    // ⚠️ RUN_TAG 每次运行都换新 randomUUID，`--cleanup` 按固定前缀 "P6-2-UAT-" 反查
    //    上一次（及历史上所有）走查工单，逐张用 cleanupTicket 精确删（照片/附件/事件/
    //    Visit 幂等行/sms/工单本体），不留孤儿。
    console.log('\n【清理】删除所有 "P6-2-UAT-" 前缀的走查工单 …');
    const ids = psqlRows(
      `SELECT id FROM service_tickets WHERE content LIKE '%P6-2-UAT-%' ORDER BY id`,
    ).map((r) => Number(r[0]));
    if (ids.length === 0) {
      console.log('  无命中工单。');
      return;
    }
    for (const id of ids) {
      const { filesDeleted, attachmentsDeleted } = cleanupTicket(id);
      console.log(`  工单 #${id}：删照片 ${filesDeleted} / 删附件 ${attachmentsDeleted}`);
    }
    console.log(`  共清理 ${ids.length} 张工单。`);
    return;
  }

  // 短信开关：取师傅 Token 需要 mock 发件箱有 technician_task 短信（sms.enabled 默认关）
  const sms = smsSwitch();
  if (sms.original !== 'true') {
    console.log(`【短信开关】临时开启 sms.enabled（原值 "${sms.original}"），造完恢复 …`);
    await sms.enable();
  }

  try {
    const charged = await buildOne({
      tag: `${RUN_TAG}-charged`,
      storeToken: store,
      hqToken: hq,
      charged: true,
      amount: 268.0,
    });
    const free = await buildOne({
      tag: `${RUN_TAG}-free`,
      storeToken: store,
      hqToken: hq,
      charged: false,
    });

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  P6-2 真人走查准备完成（两张工单已造好，待走查）');
    console.log('══════════════════════════════════════════════════════════════');
    console.log(`  门店账号  : ${STORE_EMAIL}（口令见 .env 的 UAT_STORE_A_PASSWORD）`);
    console.log(`  总部账号  : ${HQ_EMAIL}（口令见 .env 的 UAT_HQ_PASSWORD）`);
    console.log(`  后台入口  : http://localhost:8080/signin`);
    console.log('──────────────────────────────────────────────────────────────');
    console.log(`  走查①确认：工单 ${charged.ticketNo}（收费 ¥268.00）`);
    console.log(`    预期：详情里「技师回执」出现「确认服务」「驳回」→ 点确认 → 填金额`);
    console.log(`          （改额才要求填说明）→ 确认成功 → 工单进「待评价」，按钮消失。`);
    console.log(`  走查②驳回：工单 ${free.ticketNo}（不收费）`);
    console.log(`    预期：详情里「技师回执」→ 点驳回 → 填原因 → 驳回成功 → 工单回`);
    console.log(`          「处理中」，按钮消失，且可继续正常派工。`);
    console.log('──────────────────────────────────────────────────────────────');
    console.log(`  ⚠️ 走查完成后清理：node scripts/prepare-p6-2-walkthrough.mjs --cleanup`);
    console.log(`     （或记住 ticket id：charged=#${charged.ticketId} free=#${free.ticketId}）`);
    console.log('══════════════════════════════════════════════════════════════');
  } finally {
    sms.restore();
  }
}

await runMain({ name: 'P6-2 真人走查准备', main });
