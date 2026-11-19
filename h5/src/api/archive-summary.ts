/**
 * `archive-summary.ts` —— 客户侧「查进度」里的**档案摘要**读接口（R2.2.1 第十一条）。
 *
 * ===========================================================================
 * 为什么不新写一个接口
 * ===========================================================================
 * 服务端**早就有** `publicArchive:queryByMobile`（ARC-V1 / R0-CHG-01），
 * 它是一个已经定型的、"只凭手机号"的匿名读，安全边界写在
 * `services/archive-query-service.ts` 的 `queryByMobileSummary()` 里：
 *   · 只匹配 `visibility = published` 的档案（草稿不出现）；
 *   · 输出裁剪到最小摘要：`{ 门店名 + 档案大类 + 进度 }`，
 *     **没有任何可定位到个人的字段**（无姓名、无地址、无手机号明文、无档案号）；
 *   · 服务端强制双维度限流（IP + 手机号），并对响应设 `Cache-Control: no-store`。
 *
 * ⇒ 本轮**复用**它，不新增匿名入口。理由不是省事：项目里每多一条"只凭手机号"
 *   的读，就多一处可能"不小心多给了字段"的实现，而漂移的方向通常是放宽。
 *   `archive-query-service.ts` 的注释已经明确写了这条纪律。
 *
 * ===========================================================================
 * 边界（不得越过）
 * ===========================================================================
 *   · **不放宽匿名权限**：调用的是既有公开动作，没有改任何白名单。
 *   · **不改安全策略**：限流、验证码、短信正文一概不动。
 *   · 失败**不猜测**：429 要说"太频繁"，网络错误要说"网络异常"，
 *     绝不把失败渲染成"您没有档案"——那会让客户以为自己数据丢了。
 */
import { ApiError, request } from './http';

/** 一条档案的最小摘要（**字段与后端投影逐字对应**） */
export interface ArchiveSummaryItem {
  archive_type: string;
  archive_type_label: string;
  progress: string;
  progress_label: string;
}

/** 按门店分组 */
export interface ArchiveSummaryGroup {
  store_id: number;
  store_name: string;
  archives: ArchiveSummaryItem[];
}

export interface ArchiveSummary {
  mobile_masked: string;
  groups: ArchiveSummaryGroup[];
  total: number;
}

/**
 * 路径说明：**直接打 `/api/publicArchive:queryByMobile`**，不走 `/api/public/…`。
 *   `/api/public/` 那一段是**显式枚举**的 rewrite 白名单（`nginx/conf.d/service.conf`），
 *   没有这条路径就把请求挡在 nginx 外。而 `h5/public/archive.html` 用的正是
 *   这条直连形态、且已经在跑 —— 沿用同一条，避免"两处页面两种路径"。
 */
const ENDPOINT = '/api/publicArchive:queryByMobile';

export async function fetchArchiveSummary(
  mobile: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ArchiveSummary> {
  const data = await request<ArchiveSummary>(ENDPOINT, {
    method: 'POST',
    body: { mobile },
    fetchImpl: options.fetchImpl,
  });
  return {
    mobile_masked: String(data?.mobile_masked ?? ''),
    groups: Array.isArray(data?.groups) ? data.groups : [],
    total: Number(data?.total ?? 0),
  };
}

/**
 * 把接口错误翻成**客户能懂且不误导**的一句话。
 *
 * ⚠️ 这里的措辞与 R2.2.1 第十三条的八条错误码口径一致：
 *    400/422 → 手机号格式；429 → 太频繁；其余 → 稍后再试。
 *    「没有档案」**不是错误**，它是 `total === 0` 的成功响应，
 *    绝不能被渲染成红色错误文案。
 */
/**
 * 错误码 → 客户能看懂的一句话。
 *
 * 🔴 这张表与员工端 `src-mobile/src/components/qf/states.tsx` 的 `ERROR_CODE_TEXT`
 *    **是同一批码、同一套口径**。为什么没做成共享模块：`h5/` 与 `src-mobile/`
 *    是两个独立构建（两套 vite、两套 tsconfig），为了一个字符串表去搭跨包引用，
 *    会把构建拓扑搞复杂 —— 代价远大于收益。所以用**门禁**代替共享：
 *    `scripts/verify-error-i18n.mjs` 会同时读两个文件，比对两边的 `title` 逐字相同。
 *
 * ⚠️ 客户侧与员工侧**故意不同**的地方：`message`。
 *    员工看的是「请联系总部管理员在门店账号管理里绑定」，
 *    客户看「请直接联系门店前台」就够了 —— 把内部管理动作讲给客户听是噪音，
 *    而且会暴露后台结构。
 */
export function archiveSummaryErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const code = String((error as ApiError).code ?? '');
    // 与员工端 ERROR_CODE_TEXT 的 title 对齐（门禁逐字比对）
    if (code === 'ARCHIVE_QUERY_BAD_MOBILE') return '手机号格式不正确，请检查后重试';
    if (code === 'ARCHIVE_QUERY_RATE_LIMITED' || error.status === 429) return '查询过于频繁，请稍后再试';
    if (code === 'ARCHIVE_QUERY_UNAVAILABLE') return '服务暂时不可用，请稍后再试，或直接到门店前台查验';
    if (code === 'NETWORK_ERROR') return '网络异常，请检查网络后重试';
    // 服务端已给中文就用它；**不印英文原文**（第 13 条）
    const msg = String(error.message || '');
    if (msg && !/^[\x00-\x7F]*$/.test(msg)) return msg;
    return '查询失败，请稍后再试';
  }
  return '查询失败，请稍后再试';
}
