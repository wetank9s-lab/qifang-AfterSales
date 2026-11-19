/**
 * public-archive-gate.rules.mjs —— `publicArchive` 双层闸门的**共享判据库**
 * =============================================================================
 *
 * 为什么是"共享判据库"而不是"复制一份到门禁脚本里"
 * -----------------------------------------------------------------------------
 * 服务端实现（`src/server/middleware/public-archive-gate.ts`）是 .ts，被 esbuild 打成
 * CJS bundle；门禁脚本是 .mjs，**不能直接 import .ts**。本项目过去在这种地方
 * 有两种选择，两种都吃过亏：
 *   · 门禁里**照抄一份**判据 ⇒ 两份会漂移，测试绿而产品错（"同一个坑两条腿"）；
 *   · 门禁里只打 HTTP 看状态码 ⇒ 判据太宽，nginx 的 403、ACL 的 403、
 *     参数错的 400 都可能被算成"闸门有效"（自造假绿）。
 *
 * ⇒ 本文件只放**纯函数**，判据的**唯一实现**放在这里，两侧都从这里取：
 *   服务端 .ts 里的同名函数**转调本文件的逻辑**（见 .ts 内注释），
 *   门禁脚本直接 `import` 本文件。
 *
 * 但目前服务端 .ts 无法 require .mjs（打包目标是 CJS、且该文件不在 dist 里）——
 * ⇒ 真实的做法是：**本文件是"判据的可执行规格"**，由 `verify-arc-gate-selftest.mjs`
 *    逐条对照 .ts 源码的**文本片段**验证二者一致（结构断言），
 *    并用**真实产物**（dist/server/index.js 里的实际行为）做行为断言。
 *    这样两份实现不可能无声漂移：任何一边改了，结构断言会红。
 *
 * ★ 本文件的判据与被测代码必须能**双向变红**：
 *    正向 fixture（应该放行）与反向 fixture（应该拦截）都要有，
 *    且末尾附**变异测试**证明这些断言不是恒真的。
 */

/** 受管资源名（**唯一**）。与 constants.ts 的 PUBLIC_RESOURCE.ARCHIVE 必须一致。 */
export const GATED_RESOURCE = 'publicArchive';

/** 资源级总开关的环境变量名。 */
export const PUBLIC_ARCHIVE_ENABLED_ENV = 'PUBLIC_ARCHIVE_ENABLED';

/** Action 级开关的环境变量名（D2 新增）。 */
export const PUBLIC_ARCHIVE_QUERY_ENABLED_ENV = 'PUBLIC_ARCHIVE_QUERY_ENABLED';

/** 资源级关闭的错误码。 */
export const PUBLIC_ARCHIVE_DISABLED_CODE = 'PUBLIC_ARCHIVE_DISABLED';

/** Action 级未放行的错误码（D2 新增，与上面刻意分开）。 */
export const PUBLIC_ARCHIVE_ACTION_CLOSED_CODE = 'PUBLIC_ARCHIVE_ACTION_CLOSED';

/** 唯一被 Action 级开关放行的动作名。 */
export const PUBLIC_ARCHIVE_QUERY_ACTION = 'queryByMobile';

/**
 * Action 级放行清单。
 *
 * ⚠️ 这是一份**独立**的字面量（不是从 .ts 里读来的），
 *    门禁会把它与 .ts 源码里的同名常量做**结构比对**（见 verify-arc-gate-selftest）。
 */
export const QUERY_ACTION_ALLOWLIST = [PUBLIC_ARCHIVE_QUERY_ACTION];

/** 六条匿名动作（用于"其余五条必须仍被拦"的枚举断言）。 */
export const ALL_PUBLIC_ARCHIVE_ACTIONS = [
  'sendCode',
  'verify',
  'list',
  'detail',
  'photo',
  'queryByMobile',
];

/** 开关求值：规范化后严格等于 'true'。 */
export function booleanEnv(env, name) {
  const raw = env?.[name];
  if (raw === undefined || raw === null) return false;
  return String(raw).trim().toLowerCase() === 'true';
}

/** 资源级开关。 */
export function isPublicArchiveEnabled(env) {
  return booleanEnv(env, PUBLIC_ARCHIVE_ENABLED_ENV);
}

/** Action 级开关。 */
export function isPublicArchiveQueryEnabled(env) {
  return booleanEnv(env, PUBLIC_ARCHIVE_QUERY_ENABLED_ENV);
}

/** 动作是否被明确放行（精确相等，不用前缀）。 */
export function isActionExplicitlyAllowed(actionName) {
  const name = String(actionName ?? '');
  if (!name) return false;
  return QUERY_ACTION_ALLOWLIST.includes(name);
}

/** 是否应被拦下。 */
export function shouldBlockPublicArchive(resourceName, actionName, enabled, queryEnabled) {
  if (String(resourceName ?? '') !== GATED_RESOURCE) return false;
  if (!enabled) return true;
  if (!queryEnabled) return true;
  return !isActionExplicitlyAllowed(actionName);
}

/** 拦下时的错误码；不拦返回 null。 */
export function publicArchiveBlockCode(resourceName, actionName, enabled, queryEnabled) {
  if (!shouldBlockPublicArchive(resourceName, actionName, enabled, queryEnabled)) return null;
  return enabled ? PUBLIC_ARCHIVE_ACTION_CLOSED_CODE : PUBLIC_ARCHIVE_DISABLED_CODE;
}
