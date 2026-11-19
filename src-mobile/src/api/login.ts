/**
 * 登录页的错误文案（R2.2.1 §三）
 *
 * ===========================================================================
 * 这里**没有**任何"手机号 → 账号"的解析
 * ===========================================================================
 *   R2.2.1 曾实现过 `POST /api/publicLogin:resolve`：先把手机号翻成 username，
 *   再交给 NocoBase 原生 `auth:signIn`。原因是原生认证把查询写死成
 *   `$or:[{username},{email}]`（`plugin-auth/dist/server/actions/basic-auth.js:67`），
 *   不查 `users.phone`。
 *
 *   **该方案已被产品裁决撤销**，理由是要简单：以后新建销售人员账号时，
 *   **用户名直接设成手机号**即可 —— 原生认证本来就接受任意 username，
 *   一个 11 位数字串同样合法。于是：
 *     · 不需要解析接口，也就没有"匿名接口回答某号码是否存在"的枚举面；
 *     · 不需要为登录改 NocoBase 内核（那是冻结版本 2.2.15）；
 *     · 旧账号（username / email）完全不受影响。
 *   ⇒ 本模块只做一件事：**把失败的英文原文换成人话**。
 *
 * ===========================================================================
 * 为什么必须在这一层翻译，而不是指望服务端回中文
 * ===========================================================================
 *   `auth:signIn` 失败时 NocoBase 回的是
 *     `{"errors":[{"code":"INVALID_CREDENTIALS","message":"Invalid username or password"}]}`
 *   而 `api/http.ts` 的归一化规则是「服务端给了 message 就用它」——
 *   那条规则对**业务接口**是对的（本项目后端一直回中文），
 *   但认证接口的 message 是英文，直接展示就是 §三 明令禁止的
 *   「登录界面出现英文错误」。
 *   ⇒ 在调用方按 401 统一改写成中文，比去改 http 层的全局兜底安全得多
 *     （http 层那条兜底 401 文案是"登录已过期，请重新登录"，语义是"会话失效"，
 *      拿来当"密码错"会让人以为自己的登录莫名其妙过期了）。
 */
import { ApiError } from './http';

/** 登录失败唯一文案 —— §三 指定，逐字不得改写 */
export const LOGIN_FAILED_MESSAGE = '账号或密码不正确，请重新输入。';

/**
 * 把登录阶段的任何错误翻译成一句中文。
 *
 * 行为表：
 *   401（账号不存在 / 密码错 / 账号停用） → 「账号或密码不正确，请重新输入。」
 *   429（触发风控限流）                   → 「操作太频繁，请稍后再试。」
 *   网络不可达 / 超时                     → 「网络不可用，请检查网络后重试。」
 *   其他带中文 userMessage 的              → 原样展示
 *   其余                                  → 上面那条统一文案
 *
 * ⚠️ **不能**把所有错误都压成"账号或密码不正确"：
 *    网络断了、被限流了如果也这么说，用户会反复重输密码，
 *    而问题根本不在密码上。这两种必须说真话。
 *
 * ⚠️ 也接受**字符串**入参：`SessionProvider.loginError` 存的是 message 字符串
 *    （它已经把 Error 拆过了），而那条 message 可能正是 NocoBase 的英文原文
 *    —— 所以它同样必须过一遍翻译，不能因为"已经是字符串"就放行。
 */
export function describeLoginError(e: unknown): string {
  // 字符串入参：只有"看起来是中文人话"才原样用，含英文单词的一律换成统一文案
  if (typeof e === 'string') {
    const s = e.trim();
    if (!s) return LOGIN_FAILED_MESSAGE;
    return /[A-Za-z]{3,}/.test(s) ? LOGIN_FAILED_MESSAGE : s;
  }

  if (e instanceof ApiError) {
    if (e.isUnauthorized) return LOGIN_FAILED_MESSAGE;
    if (e.isRateLimited) return '操作太频繁，请稍后再试。';
    if (e.isNetworkError) return '网络不可用，请检查网络后重试。';
    // 服务端主动给的中文（本项目后端风格）优先用；含英文的不用
    if (e.userMessage && !/[A-Za-z]{3,}/.test(e.userMessage)) return e.userMessage;
    return LOGIN_FAILED_MESSAGE;
  }
  // 非 ApiError：一律按"登录失败"处理，绝不把 JS 异常原文抛给员工
  return LOGIN_FAILED_MESSAGE;
}
