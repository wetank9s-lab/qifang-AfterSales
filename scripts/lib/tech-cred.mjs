/**
 * tech-cred.mjs —— 从 **mock 短信发件箱** 里取出师傅作业入口凭据的唯一实现
 * =============================================================================
 *
 * 为什么需要这个模块（而不是"再内联三行正则"）
 * -----------------------------------------------------------------------------
 * 本项目铁律 ④：**同一段解析逻辑出现两次 = 同一个坑有两条腿**。
 *
 * 🔴 2026-11-13 实测到的既成事实：仓里本来就有**两份**"
 *    从发件箱取师傅 Token"的实现，而且其中一份**已经过期**：
 *    `technician-harness.mjs` 的 `tokenFromOutbox()` 只在 `params.link` 上匹配
 *    **43 位**长 Token，而本机实际形态早已变成：
 *
 *        { scene: 'technician_task', params: { code: 'gYF1M9qsbGhFbSuD4q8nyA' },
 *          preview: '…请点击链接查看并处理：https://sh.scqfls.cn/p/t/gYF1M9qsbGhFbSuD4q8nyA' }
 *
 *    即 **22 位短码 + `params.code`**，`params.link` 根本不存在。
 *    ⇒ 那份实现**恒取到 null**，而它的失败文案写的是"确认派工成功且通道为 mock"，
 *      读起来像"产品没发短信" —— 但实测 `sms_logs` 三条全 `accepted`、
 *      入口 `302` 可用。**这是验证器落后于产品，不是产品缺陷**（铁律 ⑤）。
 *
 *    后来 `h5-visual-evidence.mjs` 里补了一份正确实现（作为私有函数）。
 *    本轮要做录屏脚本，**绝不能**再抄第三份 —— 所以提升到这里：
 *    一个实现、两个消费方（证据脚本 + 录屏脚本），以后要改只改一处。
 *
 * ===========================================================================
 * 解析口径（与 `lib/review-token.mjs` 同构，顺序有语义）
 * ===========================================================================
 *   ① 先读 `preview` —— 那是师傅**真正会收到的那条短信**，是这条断言的语义对象；
 *   ② 再兜底结构化字段（`params.code` / `params.link`）；
 *   ③ 形态同时接受 22 位短码与 43 位长 Token（两种入口 nginx 都接了）。
 *
 *   顺序反过来会让"正文里根本没链接、只有结构化字段里有"这种形态悄悄通过 ——
 *   那是**师傅点不到链接**的形态，必须判红。
 *
 * ===========================================================================
 * 认领判据：`biz_id`，不是 `params.ticket_no`
 * ===========================================================================
 *   ⚠️ `technician_task` 条目**没有** `params.ticket_no` 字段
 *      （只有 `biz_id: 'technician_task-<ticketId>-<visitId>-<rand>'`）。
 *      按不存在的字段过滤 ⇒ 恒定空集 ⇒ 又变成"产品没发短信"式的假红。
 *      ⇒ 用 `biz_id` 里的 ticketId 段认领（这是本工单的唯一归属证据）。
 *
 * @module scripts/lib/tech-cred
 */

/** `/p/t/<token>` 形态：字母数字 + `-` `_`，至少 16 位（实测短码 22 / 长 Token 43，取宽松下界） */
export const TECH_ENTRY_RE = /\/p\/t\/([A-Za-z0-9_-]{16,})/;

/**
 * 从一条发件箱条目里解析出师傅入口凭据。
 *
 * @param {object} it 发件箱条目（`{ scene, biz_id, preview, params }`）
 * @returns {string|null} 凭据（短码或长 Token），取不到返回 null
 */
export function techCredFromEntry(it) {
  const fromText = (s) => TECH_ENTRY_RE.exec(String(s ?? ''))?.[1] ?? null;
  return (
    fromText(it?.preview) ??
    fromText(it?.content) ??
    fromText(it?.body) ??
    fromText(it?.text) ??
    (String(it?.params?.code ?? '').length >= 16 ? String(it.params.code) : null) ??
    fromText(it?.params?.link)
  );
}

/**
 * 在发件箱条目数组里认领**属于本工单**的某场景凭据。
 *
 * 纯函数（不接受 `http` / 不做轮询）—— 轮询与网络由调用方负责，
 * 这样它才能被 fixture 直接喂样例数据做**双向**单测：
 *   · 正例：`biz_id` 属于本工单 + `preview` 带短码 ⇒ 必须取到；
 *   · 反例：`biz_id` 属于**别的**工单 ⇒ 必须取不到（防止"取到最新一条"的错单）。
 *
 * @param {object[]} items 发件箱条目
 * @param {object} opts
 * @param {number} opts.ticketId 本工单 id（`biz_id` 认领键）
 * @param {string} [opts.scene='technician_task'] 场景名
 * @returns {{token:string, seq:number, matches:number}|null}
 */
export function pickTechCred(items, { ticketId, scene = 'technician_task' } = {}) {
  const mine = (items ?? [])
    .filter((i) => String(i?.scene ?? '') === scene)
    .filter((i) => {
      const m = new RegExp(`^${scene}-(\\d+)-`).exec(String(i?.biz_id ?? ''));
      return m ? Number(m[1]) === Number(ticketId) : false;
    })
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  for (const it of mine.reverse()) {
    const tok = techCredFromEntry(it);
    if (tok) return { token: tok, seq: Number(it.seq), matches: mine.length };
  }
  return null;
}
