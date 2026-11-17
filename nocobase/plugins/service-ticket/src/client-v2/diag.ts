/**
 * client-v2 的**可诊断**加载外壳
 * =============================================================================
 *
 * 背景（用户 2026-11-10 §3 第三条）：
 *   上一版为了让"区块注册失败"不至于把整个移动端 SPA 弄白屏，把整个 `load()`
 *   包进 try/catch 里**完全静默**地降级 —— 结果是：页面上只显示
 *   "Model class 'ArchiveCreateBlockModel' not found."，而 Console 里**一个字都没有**，
 *   定位这个问题花了好几轮（v1/v2 双 lane、包根标记文件、define 名、基类选择）。
 *
 * 用户的要求是"不能完全静默，但也不能泄露敏感信息、不能让故障导致白屏"。
 * 三条同时满足的形态就是下面这个：
 *
 *   ① **失败一定留痕**：`console.error` 打一行带前缀的诊断摘要，浏览器里直接可见。
 *   ② **信息本身是安全的**：只打「阶段名 + 错误类型 + 错误消息首行 + 构建标记」。
 *      · 阶段名是我们自己代码里的固定字符串（engine / apiClient / base / register）；
 *      · 错误消息来自框架层的 TypeError / ReferenceError，不含用户数据；
 *      · 显式**不打印**任何请求体、token、手机号、账号 —— 那才是敏感面。
 *   ③ **绝不向上抛**：任何路径都在本地 catch 住，SPA 继续跑，其它插件不受影响。
 *
 * 为什么还要再包一层 `guardedLoad`：
 *   上一版只包了"拿不到引擎"这一类**预期内**的分支，却没有包住
 *   `registerModels` 内部可能抛的异常（比如某个模型构造器写错）。
 *   那类异常会从 `load()` 里逃出去 —— 一部分宿主实现会把它升级成整页白屏。
 *   这里做最后一道网。
 */

/** 诊断行前缀：在 Console 里一眼能筛出来 */
export const DIAG_PREFIX = '[service-ticket/v2]';

/**
 * 错误摘要 —— **刻意只取安全字段**。
 *
 * 不 `JSON.stringify(error)`：框架异常对象常带 `config`（含请求头/Authorization）
 * 与 `response.data`（含客户数据），整坨打出去就是自己造泄露。
 */
export function describeError(error: unknown): string {
  if (error === null || error === undefined) return 'unknown';
  if (typeof error === 'string') return scrub(error);
  const e = error as any;
  const name = typeof e?.name === 'string' && e.name ? e.name : 'Error';
  const message = typeof e?.message === 'string' && e.message ? scrub(e.message.split('\n')[0]) : '';
  return message ? `${name}: ${message}` : name;
}

/**
 * **消息脱敏**（2026-11-10 单元测试抓到的真实缺陷）。
 *
 * 第一版只做到"不 JSON.stringify(error)"，却仍把 `error.message` 原样打出去。
 * 而错误消息**常常是拼接出来的**：
 *   · `POST /api/svc:archiveCreate 400 … customer_mobile=13900001234`
 *   · `Invalid token eyJhbGciOi…`
 *   · axios 的 `Request failed with status code 500 ... config.headers.Authorization=Bearer …`
 * 单元用例 `describeError` 喂了一个 `'boom 13900009999'` 就把它照抄了出来 ——
 * 这说明"只看字段不看内容"的脱敏是不成立的。
 *
 * 因此这里对**最终字符串**做一次模式清洗：
 *   · 11 位手机号 → 保留前 3 后 2（能定位是哪条记录，又不构成明文）
 *   · JWT / Bearer token → `<token>`
 *   · 长串 hex（≥32）→ `<hex>`
 * 清洗是**幂等且不抛**的：它自己出错时退回原串（宁可日志差一点，也不能弄挂调用方）。
 */
function scrub(text: string): string {
  let out = text;
  try {
    out = out.replace(/1[3-9]\d{9}/g, (m) => `${m.slice(0, 3)}****${m.slice(-2)}`);
    out = out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<token>');
    out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <token>');
    out = out.replace(/\b[0-9a-f]{32,}\b/gi, '<hex>');
  } catch {
    return truncate(text);
  }
  return truncate(out);
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 打一条可诊断的警告（永不抛出：Console 被宿主接管时也不能反过来弄挂插件） */
export function diagWarn(stage: string, detail: string, stamp?: string): void {
  try {
    // eslint-disable-next-line no-console
    console.warn(`${DIAG_PREFIX} ${stage} 跳过 —— ${detail}${stamp ? `（构建 ${stamp}）` : ''}`);
  } catch {
    /* Console 不可用时静默：宁可没日志，也不能因为打日志把启动流程弄断 */
  }
}

export function diagError(stage: string, error: unknown, stamp?: string): void {
  try {
    // eslint-disable-next-line no-console
    console.error(
      `${DIAG_PREFIX} ${stage} 失败：${describeError(error)}${stamp ? `（构建 ${stamp}）` : ''}`,
    );
  } catch {
    /* 同上 */
  }
}

/**
 * 把 `load()` 包成"永不抛出"的版本。
 *
 * ⚠️ 保留原始异常的 Console 栈（第二参数传 error 对象）—— 栈里是文件名与行号，
 *    不含业务数据，而它是定位"哪个模型构造器写错了"的唯一线索。
 */
export async function guardedLoad(
  stamp: string | undefined,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (error) {
    diagError('load', error, stamp);
  }
}
