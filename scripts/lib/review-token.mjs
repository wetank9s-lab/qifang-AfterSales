/**
 * review-token.mjs —— 从 **mock 短信发件箱** 里取出客户评价链接的明文 Token
 * =============================================================================
 *
 * 为什么需要这个模块（而不是在某份脚本里内联三行正则）
 * -----------------------------------------------------------------------------
 * 评价链接只发到客户手机，短信正文**刻意不进库**（它含评价 Token 明文），
 * 本机 mock 通道下只存在于内存发件箱 `svc:smsOutbox`。
 * ⇒ "以真实客户身份提交评价"这一步，必须先从发件箱里把链接取出来。
 *
 * 🔴 2026-10-09 这条判据红过一次，而红的是**验证器自己**：
 *    内联版本读的是 `it.content ?? it.body ?? it.text`，
 *    但发件箱条目给的是 **`preview`（短信正文）** 与 **`params.link`** ——
 *    三个字段**一个都不存在** ⇒ 恒定取到 `''` ⇒ 断言**永远绿不了**。
 *    而它的失败文案写的是"形态变了吗？核对 REVIEW_TOKEN"，
 *    读起来非常像"产品没发评价短信"，会把排障方向整个带偏
 *    （事实上产品发了，发件箱里就躺着那条 `/f/<43字符>`）。
 *
 * ⇒ 按铁律 ⑤：验证器自己也会错，且错得比产品更隐蔽 ——
 *    所以这里把判据抽成**唯一实现**，并由
 *    `scripts/verify-outbox-review-token-selftest.mjs` 用**双向 fixture** 钉住，
 *    消费方一律 import，不得再内联一份。
 *
 * 判据为什么是"先看正文、再看 params.link"
 * -----------------------------------------------------------------------------
 * `preview` 是**客户真正会收到的那条短信**，是这条断言的语义对象；
 * `params.link` 是渲染前的结构化字段，作为兜底（万一正文被脱敏/截断）。
 * 反过来的顺序会让"正文里根本没链接、只有结构化字段里有"这种形态悄悄通过 ——
 * 那是**客户点不到链接**的形态，必须判红。
 *
 * @module scripts/lib/review-token
 */

/** `/f/<token>` 的形态：字母数字 + `-` `_`，至少 20 位（实测 43 位，这里取宽松下界） */
export const REVIEW_LINK_TOKEN_RE = /\/f\/([A-Za-z0-9_-]{20,})/;

/** 评价邀约的场景名（与 `SMS_SCENE.REVIEW_INVITE` 一致，此处刻意不 import 服务端代码） */
export const REVIEW_INVITE_SCENE = 'review_invite';

function tokenFrom(text) {
  const m = REVIEW_LINK_TOKEN_RE.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/**
 * 从发件箱条目里取出评价 Token。
 *
 * 只认 `scene === 'review_invite'` 的条目：发件箱里还会有派工/取消等其它场景，
 * 若某个场景的正文里也出现 `/f/`，不筛场景就会**取到错的 Token**
 * （评价接口对错误 Token 只会 404 —— 又是一次"看起来像产品没发"）。
 *
 * @param {Array<object>} items `svc:smsOutbox` 的 `data.items`
 * @returns {string|null} 明文 Token；取不到返回 null
 */
export function reviewTokenFromOutbox(items, options = {}) {
  // 🔴 必须**按工单号认领**，不能"取第一条 review_invite"就完事。
  //
  //    发件箱是**累积**的：本次之前跑过的邀请仍然躺在里面（真实通道没有这个接口，
  //    但本机 mock 的内存发件箱跨越多次运行）。取第一条 ⇒ 拿到的是**上一次**那枚 Token，
  //    它属于**另一张工单** ⇒ 评价提交 404，而失败现象看起来又是
  //    "产品没发评价短信" —— 与 DEV-105 完全同型的第二次复发。
  //
  //    2026-10-09 的实测触发：一枚旧 Token 因安全处置被吊销后仍在发件箱里，
  //    若不按工单号认领，后续每一次验收都会撞上它。
  const wantTicketNo = options.ticketNo == null ? null : String(options.ticketNo);
  for (const it of items ?? []) {
    if (String(it?.scene ?? '') !== REVIEW_INVITE_SCENE) continue;
    // 指定了工单号就必须**严格相等**；条目没有 ticket_no 字段 ⇒ 跳过（fail-closed）
    if (wantTicketNo !== null && String(it?.params?.ticket_no ?? '') !== wantTicketNo) continue;
    const token =
      tokenFrom(it?.preview) ??
      tokenFrom(it?.content) ??
      tokenFrom(it?.body) ??
      tokenFrom(it?.text) ??
      tokenFrom(it?.params?.link);
    if (token) return token;
  }
  return null;
}

/**
 * 取不到 Token 时**给人看**的原因。
 *
 * 刻意把两种失败分开：
 *   ① 发件箱里根本没有 review_invite ⇒ 问题在"为什么没发"；
 *   ② 有 review_invite、但正文/link 里没有 /f/<token> ⇒ 问题在"形态变了"。
 * 合成一句话的结果就是 2026-10-09 那次：一句猜谜，把人引向产品。
 */
export function explainMissingReviewToken(items, options = {}) {
  const list = items ?? [];
  const wantTicketNo = options.ticketNo == null ? null : String(options.ticketNo);
  const invites = list.filter(
    (it) =>
      String(it?.scene ?? '') === REVIEW_INVITE_SCENE &&
      (wantTicketNo === null || String(it?.params?.ticket_no ?? '') === wantTicketNo),
  );
  const allInvites = list.filter((it) => String(it?.scene ?? '') === REVIEW_INVITE_SCENE);
  const scope = wantTicketNo === null ? '' : `工单 ${wantTicketNo} 的 `;
  if (!invites.length) {
    // 指定了工单号却一条都没匹配上 ⇒ 明确报出"发件箱里有的邀请属于哪些工单"，
    // 免得下一个人又去查"产品是不是没发短信"
    const scenes = [...new Set(list.map((it) => String(it?.scene ?? '-')))].join(', ') || '无';
    const owned = [...new Set(allInvites.map((it) => String(it?.params?.ticket_no ?? '-')))].join(', ');
    return (
      `发件箱 ${list.length} 条里没有 ${scope}scene=${REVIEW_INVITE_SCENE}` +
      `（出现的场景：${scenes}` +
      (allInvites.length ? `；已有的邀请属于工单：${owned}` : '') +
      '）'
    );
  }
  const fields = invites.map((it) => Object.keys(it ?? {}).join('/')).join(' | ');
  return (
    `${invites.length} 条 ${scope}${REVIEW_INVITE_SCENE} 的正文与 params.link 里都没有 /f/<token> ` +
    `（条目实际字段：${fields || '空'}）`
  );
}
