#!/usr/bin/env node
/**
 * _r2-lifecycle-drive.mjs —— R2：真跑一遍**完整业务生命周期**，造出库里缺失的状态
 *
 * ## 为什么必须"真跑"而不是改库
 *
 * 2026-11-16 查库事实：`service_tickets.status` 只有
 * `NEW / PROCESSING / CLOSED / CANCELLED`（外加 4 条脏数据 `new`）——
 * **`WAIT_STORE_CONFIRM` 与 `WAIT_FEEDBACK` 零行**，`service_visits.visit_status`
 * 也没有一条 `SUBMITTED`。用 SQL 直接把状态改成 `WAIT_STORE_CONFIRM` 就能"截图交差"，
 * 但那样截出来的界面是**假的**（没有回执 visit、没有确认事件、按钮可用性判据全对不上）。
 * ⇒ 用户要求"五种代表性状态"，只能通过**真实接口链路**把工单推到那里。
 *
 * ## ⚠️ 为什么不用夹具的 `tokenFromOutbox`
 *
 * 它按"`params.ticket_no` 匹配 + 从 `params.link` 正则取 43 位长 Token"来取凭证，
 * 而 2026-11-16 实测：**短信模板已改**（BE-03-SMS-TEMPLATE-02）——
 * `technician_task` 的 `params` 现在**只有 `{code}`**（22 位短码），
 * 既没有 `ticket_no` 也没有 `link`。用夹具会报"发件箱里没有该工单的短信"，
 * 读起来像"短信没发"，实际是**解析口径过期**。
 * ⇒ 本脚本按新口径取 `params.code`，并用 `filterByTk` 之外的方式核对归属
 *   （短码本身不含工单号，故用"取到后调接口读 ticket_no"来验证是这一张）。
 *
 * ## 纪律
 *   · 只走真实接口，不 SQL 改状态；
 *   · 建的工单**跑完不删**（它就是"五态详情"的取证对象），末尾给出清理命令；
 *   · 断言读**库里的真值**（psqlScalar），不只看接口回什么。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BASE_URL,
  STORE_EMAIL,
  acceptAndDispatch,
  createScratchTicket,
  ensureFixtureJpeg,
  envValue,
  http,
  makeChecker,
  psqlScalar,
  signIn,
  svcGet,
  svcPost,
  technicianSubmit,
  technicianUpload,
  ticketSnapshot,
  visitSnapshots,
} from './technician-harness.mjs';

const TAG = 'R2-LIFE';
const checker = makeChecker({ heading: 'R2 完整生命周期（造 5 态样本）' });

const STORE_PW = envValue('UAT_STORE_A_PASSWORD');
const HQ_PW = envValue('UAT_HQ_PASSWORD');
if (!STORE_PW || !HQ_PW) {
  console.error('环境未就绪：.env 缺少 UAT_STORE_A_PASSWORD / UAT_HQ_PASSWORD');
  process.exit(2);
}
const HQ_EMAIL = 'uat.hq@svc.local';

const statusOf = (id) =>
  String(psqlScalar(`SELECT status FROM service_tickets WHERE id = ${id}`));

/**
 * 取某场景最新一条短信的凭证。
 *
 * 🔴 **两种形态并存**（2026-11-16 实测，别只按一种写）：
 *   · `technician_task`（师傅任务）→ `params.code`，**22 位短码**（新模板，BE-03-SMS-TEMPLATE-02）；
 *   · `review_invite`（评价邀请）→ `params.link`（`…/f/<43 位长 Token>`）+ 带 `params.ticket_no`。
 *     ⚠️ 我第一版只认 `code` ⇒ 评价 Token"取不到"，读起来像"短信没发"，
 *        实际是**解析口径只覆盖了一半**。（同一个坑有两条腿。）
 *
 * 归属核对一律用"取到后调接口读回 ticket_no"——
 * 因为短码场景没有 ticket_no 字段，靠 params 匹配会漏。
 */
async function credentialFromOutbox(hqToken, scene, expectTicketNo) {
  const r = await http(`${BASE_URL}/api/svc:smsOutbox?since_seq=0&limit=300`, {
    headers: { Authorization: `Bearer ${hqToken}` },
  });
  if (r.status !== 200) throw new Error(`发件箱不可用 HTTP ${r.status}`);
  const items = (r.json?.data?.items ?? [])
    .filter((i) => i?.scene === scene)
    .sort((a, b) => Number(b.seq) - Number(a.seq));

  for (const it of items) {
    // ⓐ 直接给了凭证短码（technician_task 走这条）
    const code = it?.params?.code;
    if (code) {
      const probe = await http(`${BASE_URL}/api/technician/visits/${code}`);
      if (probe.status === 200 && String(probe.json?.data?.ticket_no ?? '') === String(expectTicketNo)) {
        return { cred: code, kind: 'short_code', seq: Number(it.seq), url: null };
      }
      continue;
    }
    // ⓑ 给了链接（review_invite 走这条）：从 params.link 里取最后一段
    const link = String(it?.params?.link ?? '');
    // 先按 params.ticket_no 快速筛（这条有该字段）
    if (String(it?.params?.ticket_no ?? '') !== String(expectTicketNo)) continue;
    const m = /\/([A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{43})$/.exec(link);
    if (m) {
      return { cred: m[1], kind: m[1].length === 43 ? 'long_token' : 'short_code', seq: Number(it.seq), url: link };
    }
  }
  return null;
}

/**
 * 把"本次造出的样本"按**状态**累积落盘（不覆盖其他状态的记录）。
 *
 * 为什么累积而不是覆盖：五态截图需要**每个状态各一张**代表单，
 * 而一次运行只能造出一个终态（脚本跑两次才有两个状态）。
 * 覆盖写入会让"上一次跑出的 WAIT_STORE_CONFIRM 样本"丢失。
 */
function recordSample(entry) {
  const file = path.join(process.cwd(), '.tmp-r2-lifecycle.json');
  let all = {};
  if (fs.existsSync(file)) {
    try { all = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { all = {}; }
  }
  // 兼容早期"单条对象"的写法
  if (all && all.ticketId && !all.byStatus) {
    all = { byStatus: { [all.finalStatus]: all } };
  }
  all.byStatus = all.byStatus ?? {};
  all.byStatus[entry.status] = entry;
  all.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}

/**
 * `STOP_AT=WAIT_STORE_CONFIRM` ⇒ 在师傅提交后**停下，不做门店确认**。
 *
 * 为什么需要：五态截图要求"**每个状态各有一张真实工单**"。
 * 一次跑到底只会留下最后一个状态（WAIT_FEEDBACK）的样本，
 * 而 `WAIT_STORE_CONFIRM` 是**中间态**——一旦确认就再也回不去了。
 * ⇒ 用一个开关把它停住，专门留一张该状态的取证对象。
 */
const STOP_AT = String(process.env.STOP_AT ?? '').trim();

async function main() {
  console.log('\n=== ① 建单 → 受理 → 派工（自有师傅，必须铸 Token 才能提交）===');
  const { ticketId, ticketNo } = await createScratchTicket({
    tag: TAG,
    content: '五态样本：洗衣机脱水时剧烈晃动',
  });
  console.log(`  样本工单 #${ticketId} ${ticketNo}`);

  const storeToken = await signIn(STORE_EMAIL, STORE_PW);
  await acceptAndDispatch(ticketId, storeToken);
  checker.check('派工后工单进入 PROCESSING', () => {
    const s = statusOf(ticketId);
    if (s !== 'PROCESSING') throw new Error(`实际 ${s}`);
    return s;
  });

  // 发件箱仅总部可用 ⇒ 用 hq 会话取短码
  const hqToken = await signIn(HQ_EMAIL, HQ_PW);
  const pick = await credentialFromOutbox(hqToken, 'technician_task', ticketNo);
  checker.check('从发件箱取到本单的师傅短码（22 位，新短信口径）', () => {
    if (!pick) throw new Error('没有匹配本单 ticket_no 的 technician_task 短码');
    return `seq=${pick.seq} code=${pick.cred}`;
  });
  if (!pick) { checker.summary(); process.exit(1); }

  console.log('\n=== ② 师傅上传现场照 + 提交回执 → WAIT_STORE_CONFIRM（库里原本零行）===');
  console.log(`  submit 前 visit: ${JSON.stringify(visitSnapshots(ticketId))}`);

  /*
   * 🔴 必须先传**现场照**（`photo_type=onsite`）再 submit：
   *    服务端权威校验 `countPhotos(visitId, undefined, PHOTO_TYPE.ONSITE) < 1`
   *    ⇒ 422 PHOTO_REQUIRED。只传"收费凭证/完工照"会被这条挡住（刻意如此）。
   */
  const jpeg = ensureFixtureJpeg();
  const upRes = await technicianUpload(pick.cred, jpeg, { filename: 'onsite.jpg', photoType: 'onsite' });
  console.log(`  上传现场照 HTTP ${upRes.status} body=${String(upRes.body ?? '').slice(0, 160)}`);
  checker.check('师傅上传现场照成功', () => {
    if (upRes.status !== 200 && upRes.status !== 201) throw new Error(`HTTP ${upRes.status}`);
    return String(upRes.status);
  });

  const submitRes = await technicianSubmit(pick.cred, {
    service_note: '更换洗衣机减震器并调平底脚，空载脱水测试无晃动',
    is_charged: false,
    service_result: 'resolved',
  });
  console.log(`  提交 HTTP ${submitRes.status} body=${String(submitRes.body ?? '').slice(0, 220)}`);
  checker.check('师傅提交回执返回 200', () => {
    if (submitRes.status !== 200) throw new Error(`HTTP ${submitRes.status}`);
    return '200';
  });

  console.log(`  submit 后 visit: ${JSON.stringify(visitSnapshots(ticketId))}`);
  checker.check('工单进入 WAIT_STORE_CONFIRM（库里此前 0 行）', () => {
    const s = statusOf(ticketId);
    if (s !== 'WAIT_STORE_CONFIRM') throw new Error(`实际 ${s}`);
    return s;
  });

  const visitId = Number(
    psqlScalar(`SELECT id FROM service_visits WHERE ticket_id = ${ticketId} ORDER BY visit_no DESC LIMIT 1`),
  );
  const visitStatus = String(psqlScalar(`SELECT visit_status FROM service_visits WHERE id = ${visitId}`));
  checker.check('对应 visit_status = SUBMITTED（库里此前 0 行）', () => {
    if (visitStatus !== 'SUBMITTED') throw new Error(`实际 ${visitStatus}`);
    return `${visitStatus} (visit #${visitId})`;
  });

  const tlWC = await svcGet('timeline', ticketId, storeToken);
  const wc = tlWC.json?.data ?? {};
  console.log(`  [WAIT_STORE_CONFIRM] store_name=${wc.store_name} can_write=${wc.can_write}`);
  checker.check('该状态详情带门店名（R2 服务端投影）', () => {
    if (wc.store_name !== '新都圣大家电') throw new Error(`实际 ${wc.store_name}`);
    return String(wc.store_name);
  });
  const vWC = await svcGet('visits', ticketId, storeToken);
  const submittedRow = (vWC.json?.data?.visits ?? []).find((v) => Number(v.id) === visitId);
  checker.check('详情 visits 里能找到待确认的那条回执', () => {
    if (!submittedRow) throw new Error('visits 里没有该回执');
    return `visit.id=${visitId} status=${submittedRow.visit_status}`;
  });

  console.log('\n=== ③ 门店确认 → WAIT_FEEDBACK（库里原本零行）===');
  if (STOP_AT === 'WAIT_STORE_CONFIRM') {
    console.log('  ⏸ STOP_AT=WAIT_STORE_CONFIRM ⇒ 停在此状态，不做门店确认（留作该态取证对象）');
    checker.summary();
    recordSample({ status: statusOf(ticketId), id: ticketId, ticketNo, visitId });
    console.log(`  该单：#${ticketId} ${ticketNo}（${statusOf(ticketId)}）`);
    process.exit(checker.state.failures.length ? 1 : 0);
  }
  const confirmRes = await svcPost('visitConfirm', visitId, storeToken, {}, crypto.randomUUID());
  console.log(`  确认 HTTP ${confirmRes.status} body=${String(confirmRes.body ?? '').slice(0, 220)}`);
  checker.check('门店确认回执返回 200', () => {
    if (confirmRes.status !== 200) throw new Error(`HTTP ${confirmRes.status}`);
    return '200';
  });
  checker.check('工单进入 WAIT_FEEDBACK（库里此前 0 行）', () => {
    const s = statusOf(ticketId);
    if (s !== 'WAIT_FEEDBACK') throw new Error(`实际 ${s}`);
    return s;
  });

  const tlWF = await svcGet('timeline', ticketId, storeToken);
  checker.check('该状态详情仍可正常读取', () => {
    const d = tlWF.json?.data;
    if (!d?.ticket?.id) throw new Error('timeline 没有返回 ticket');
    return `ticket.id=${d.ticket.id} store_name=${d.store_name}`;
  });

  console.log('\n=== ④ 客户评价 → CLOSED ===');
  const rvPick = await credentialFromOutbox(hqToken, 'review_invite', ticketNo);
  console.log(`  评价短码：${rvPick ? `已取到 seq=${rvPick.seq}` : '未取到（评价邀约短信可能未发）'}`);
  if (rvPick) {
    /*
     * 🔴 路径是 **`/api/public/reviews/<43 位长 Token>`**（复数 reviews）—— 不是
     *    `/api/public/review/<code>`。第一版写成单数 + 短码 ⇒ **404 Not Found**，
     *    读起来像"评价链接坏了"，实际是**路径写错**（nginx 只对 43 位 `{43}` 放行）。
     *    见 nginx/conf.d/service.conf 的 `rewrite "^/api/public/reviews/([A-Za-z0-9_-]{43})$"`。
     */
    const rv = await http(`${BASE_URL}/api/public/reviews/${rvPick.cred}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({
        rating: 5,
        comment: '[R2-LIFE] 上门很快，师傅专业',
        // 本次 `is_charged: false` ⇒ 收费核对只能是 not_applicable（枚举：match/mismatch/not_applicable）
        charge_match: 'not_applicable',
      }),
    });
    console.log(`  评价 HTTP ${rv.status} body=${String(rv.body ?? '').slice(0, 200)}`);
    checker.check('评价后工单进入 CLOSED', () => {
      const s = statusOf(ticketId);
      if (s !== 'CLOSED') throw new Error(`实际 ${s}`);
      return s;
    });
  } else {
    console.log('  ⚠️ 未取到评价短码 ⇒ 跳过（CLOSED 用库里既有样本，不记为失败）');
  }

  console.log('\n=== 汇总 ===');
  console.log(`  五态样本工单：#${ticketId} ${ticketNo}（最终 ${statusOf(ticketId)}）`);
  console.log(`  ⚠️ 该单**保留在库中**，作为五态详情截图的取证对象。`);
  console.log(`     清理：DELETE FROM ticket_events WHERE ticket_id=${ticketId}; ` +
    `DELETE FROM service_visits WHERE ticket_id=${ticketId}; DELETE FROM service_tickets WHERE id=${ticketId};`);
  // 把 id 落盘（按状态累积），供后续五态截图脚本使用
  recordSample({ status: statusOf(ticketId), id: ticketId, ticketNo, visitId });

  checker.summary();
  process.exit(checker.state.failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('\n脚本异常：', e?.stack ?? e?.message ?? e);
  process.exit(2);
});
