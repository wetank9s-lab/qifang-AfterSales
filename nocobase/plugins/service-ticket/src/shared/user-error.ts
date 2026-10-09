/**
 * user-error.ts —— **服务端错误 → 门店员工看到的文案**（唯一实现）
 * =============================================================================
 *
 * 为什么这个文件必须存在（2026-10-10，P11-0 真实浏览器验收抓出 DEV-109）
 * -----------------------------------------------------------------------------
 * 门店同事在两种界面上会撞到服务端拒绝：
 *   · `ticket-store-review.tsx` —— 审核技师回执（确认 / 驳回）
 *   · `primary-action.tsx`      —— 处理 / 跟进 / 转店 / 取消 / 电话解决
 *
 * 修复前：`primary-action.tsx` 只有一个 `errorText()`，把服务端 code 直接
 * 拼在中文后面（`工单当前不是「待门店确认」，无法确认（TICKET_NOT_REVIEWABLE）`）；
 * `ticket-store-review.tsx` 另有一份冲突码白名单，但那份名单**漏了服务端实际
 * 会抛的大多数码** —— 服务端 `StateConflictError` 一共 11 个码，白名单只列了 4 个，
 * 而出现频次最高的 `TICKET_NOT_REVIEWABLE`（4 处）根本不在里面。
 *
 * ⇒ 两处各写一份、还都不全，正是"同一个坑长出两条腿"。这里收敛成**唯一实现**。
 *
 * 判据为什么是 **HTTP 409**，而不是再维护一份码表
 * -----------------------------------------------------------------------------
 * 码表的下场已经看到了：服务端新增一个码，客户端不知道 ⇒ 员工看到原始码。
 * 而在这个系统里 **409 有唯一来源** —— `actions/svc/_http.ts` 的 `statusOf()`：
 *      `error instanceof StateConflictError → { status: 409 }`
 * 语义就是"你要改的那个状态已经不是你了"，对门店员工只有一种有意义的解释：
 * **有人先处理了，界面已刷新到最新状态**。
 *
 * 剩下一个 409 例外 `IDEMPOTENT_REPLAY_UNAVAILABLE`（同一幂等号重放但首次响应
 * 未缓存），它的话术同样是"已处理过 / 请刷新"，归到同一类不会误导。
 *
 * ⚠️ 这条不适用于**客户侧**（匿名 H5）：客户的 409 语义不同（`DUPLICATE_TICKET`
 * 是"你已经报过同样的单"、`REVIEW_ALREADY_SUBMITTED` 是"评价已提交"），
 * 那里另有自己的文案，不要把这个模块塞过去。
 *
 * 为什么 409 要带 `refresh`
 * -----------------------------------------------------------------------------
 * 员工看到的旧画面还在说"待确认"，而服务端已经推进了 —— 只弹一句中文、
 * 不刷新，员工会**再点一次**，于是又撞一次 409。所以冲突的正确动作是
 * "说清 + 把它看到的界面拉到最新"，二者缺一不可。
 */

/** 错误 → 门店员工文案 + 是否该把界面刷新到最新状态 */
export interface UserError {
  /** 给员工看的话。**中文、可读、不含原始错误码** */
  text: string;
  /** true ⇒ 冲突（状态已被他人改变），调用方应当重拉数据 */
  refresh: boolean;
}

/** 从各种形态的错误对象里取 HTTP 状态码（axios 与裸对象都要能取到） */
function statusOf(error: any): number {
  const raw = error?.response?.status ?? error?.status ?? error?.response?.statusCode;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 从各种形态的错误对象里取服务端信封里的 code / message */
function payloadOf(error: any): { code: string; message: string } {
  const payload = error?.response?.data ?? error?.data ?? {};
  const first = payload?.errors?.[0];
  return {
    code: String(first?.code ?? payload?.code ?? ''),
    message: String(
      first?.message ?? payload?.message ?? error?.message ?? '操作失败',
    ),
  };
}

/**
 * 把服务端拒绝翻译成门店员工能懂的话。
 *
 * 判据顺序是刻意的：**先看状态码，再看有没有中文 message**。
 *   · 409 ⇒ 冲突话术（不看具体码 —— 码表会漏，状态码不会）
 *   · 其余（422 校验、403 无权限…）⇒ 服务端给的中文原样回显；
 *     只有当它**没有给中文**时才退到通用文案 —— 绝不把原始码当主要文案。
 */
export function userErrorOf(error: any): UserError {
  const { code, message } = payloadOf(error);
  const status = statusOf(error);

  if (status === 409) {
    return { text: '该服务单的状态已被其他人员处理，已刷新最新状态', refresh: true };
  }

  // 服务端给了中文 ⇒ 原样用（那是业务裁决，比通用文案信息量大）。
  // `code` 只作为**次要**信息保留在括号里；一旦连中文都没有，就不许只剩一个码。
  const hasChinese = /[\u4e00-\u9fa5]/.test(message);
  if (hasChinese) return { text: code ? `${message}（${code}）` : message, refresh: false };
  if (status === 403) return { text: '你没有执行该操作的权限', refresh: false };
  if (status === 422) return { text: '提交的内容未通过校验，请检查后重试', refresh: false };
  if (status === 429) return { text: '操作过于频繁，请稍后再试', refresh: false };
  if (status >= 500) return { text: '服务暂时不可用，请稍后重试', refresh: false };
  return { text: '操作失败，请稍后重试', refresh: false };
}
