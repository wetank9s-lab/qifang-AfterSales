/**
 * build-stamp.ts —— 客户端产物的**构建标记**（回答"浏览器到底跑的是哪一版"）
 * =============================================================================
 *
 * 为什么需要它（Phase 4-I 第三轮「详情 404」拖了整整一轮的直接原因）：
 *
 *   那一轮的僵局是「**自动化全绿** + **真人仍报 404**」。两边都拿不出对方能反驳的证据：
 *     · 自动化：每次都用**全新 Chrome profile**（空缓存）→ 永远拿到服务端最新产物 → 永远绿；
 *     · 真人：浏览器**持久 profile** + 服务端 `/static/plugins/` 的 7 天长缓存
 *       （且产物 URL 不含内容哈希）→ 可能一直跑**几小时前的旧产物**。
 *   而当时的 Console 里**没有任何东西能区分这两者** ——
 *   `已注册客户端动作：A, B, C…` 这行在修复前后**一字不差**。
 *
 *   于是"到底谁在跑旧代码"变成了只能靠猜的问题，而猜是这一轮最贵的成本。
 *
 * 这个常量的作用就是把那件事变成**可以直接观察的事实**：
 *   每次构建由构建脚本注入一个时间戳（esbuild `define`），启动时打到 Console。
 *   真人只要看一眼 Console 就知道自己跑的是不是最新的那一版产物。
 *
 * ⚠️ 注入方式与离线断言的关系：
 *   `build-plugin.mjs` 的 `clientBuildOptions.define` 里会注入 `__SVC_CLIENT_BUILD__`
 *   （与产物构建**共用同一份选项对象**，见 DEV-60 的教训）。
 *   而 `verify-client-logic.mjs` 这类离线编译走的是另一套 esbuild 选项、不注入它 ——
 *   所以这里必须用 `typeof` 守卫兜底，**不能**直接引用（否则离线断言会因
 *   `__SVC_CLIENT_BUILD__ is not defined` 而红，那是"探针自己造出来的红灯"）。
 */
declare const __SVC_CLIENT_BUILD__: string | undefined;

/** 构建时注入的时间戳；未注入（离线编译）时为 `dev`。 */
export const CLIENT_BUILD_STAMP: string =
  typeof __SVC_CLIENT_BUILD__ !== 'undefined' ? String(__SVC_CLIENT_BUILD__) : 'dev';

/**
 * 启动时往 Console 打的一行。**故意用 `info` 而不是 `debug`**：
 * Chrome DevTools 默认会把 `debug`/Verbose 级别过滤掉，
 * 而这一行恰恰是要让**不熟悉 DevTools 的走查人**能看见的。
 */
export const CLIENT_BUILD_LINE =
  `[service-ticket] 客户端产物构建 ${CLIENT_BUILD_STAMP}` +
  '（若这个时间明显早于本次修复，说明浏览器仍在跑旧产物 → Ctrl+Shift+R 强制刷新）';
