/**
 * 匿名资源 handler 的公共签名。
 *
 * 🔴 插件里 `ActionHandler` 被两个文件各自声明了一次（`actions/svc/_request.ts`
 *    与 `actions/svc/_http.ts` 的消费方），它们是两个**结构相同的独立类型**。
 *    `plugin.ts` 的 `impls` 表声明成字面量签名
 *    `Record<string, (ctx: any, next: () => Promise<void>) => Promise<void>>`，
 *    而 `resourcer.define()` 的 `actions` 又要求 `Record<string, 同一个字面量签名>`。
 *    把 `Record<string, ActionHandler>` 塞进去，TS 会判 TS2322 ——
 *    不是"结构不兼容"，而是**别名在交叉赋值时被当成了不透明对象类型**。
 *    ⇒ 这里直接写内联签名，与 `impls` 逐字一致，交叉赋值就通了。
 *    （这条踩过：2026-11 构建门禁 BUILD-TS-GATE-01 报的就是它。）
 *
 * ⚠️ 签名**必须**是两参数形态 `(ctx, next)`，且 `next` 不能是可选的（`?`）：
 *    `?` 会让这个键的推断类型变成 `(ctx: any, _next?: () => void) => Promise<void>`，
 *    而目标类型要求 `next` **必填** ⇒ 参数位置上是逆变的：
 *    "可选的 next" 不能赋给 "必填的 next"，整个 `impls` 对象在
 *    `resourcer.define()` 处报 TS2322（2026-11 实测，BUILD-TS-GATE-01）。
 *
 * 本文件只放类型、不含任何运行期逻辑 —— 原先它寄居在
 * `actions/public/login-account.ts` 里，那个文件随手机号登录方案一起撤销后，
 * 由 `progress-review.ts` 使用的类型必须有独立归属（R2.2.1 §一）。
 */
export type PublicActionHandler = (ctx: any, next: () => Promise<void>) => Promise<void>;
