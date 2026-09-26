/**
 * 服务端入口。
 *
 * 为什么必须有 `export default`：
 *   NocoBase 加载插件时走 importModule(pkgName) → requireModule → 
 *     `m.__esModule ? m.default : m`
 *   esbuild 的 CJS 产物会带 __esModule 标记，因此 default 导出就是插件类本身。
 *
 * package.json 的 `main` 指向 ./dist/server/index.js，即本文件编译后的产物。
 *
 * 除插件类外还导出播种函数（seeds/apply.ts）：
 *   迁移产物（dist/server/migrations/*.js）是**独立打包**的，拿不到插件实例，
 *   而运维脚本 / 离线校验有时需要"只补种子、不启动应用"。
 *   把它挂在包根导出上，调用方 require('@local/service-ticket') 就能拿到，
 *   不必反向 import dist 内部文件（dist 里没有独立的 seeds/*.js）。
 */
import { ServiceTicketPlugin } from './plugin';
// ⚠️ 这三个必须**值导入**（不能只 `export { … } from`）：
//    `__p8RegisterProbe` 的函数体要真正调用它们。只做 re-export 声明的话，
//    函数体里没有同名绑定 —— 打包后就是 `ReferenceError: registerXxxJob is not defined`，
//    而构建**不会报错**（esbuild 不做跨文件符号解析）。
//    2026-09-26 实测踩到：断言红成"注册器抛错"，真因却是这里少了一个 import。
import { registerReviewExpiryJob } from './services/review-expiry-scheduler';
import { registerSmsRetryJob } from './services/sms-retry-scheduler';
import { registerSlaScanJob } from './services/sla-scan-scheduler';

export { ServiceTicketPlugin };
export default ServiceTicketPlugin;

// 表定义清单：离线校验脚本、以及"不起应用也要拿到 getFields()"的运维/取证脚本
// 都依赖它。不导出的话，调用方只能反向 import dist 内部文件（dist 里没有
// 独立的 collections/*.js），或者去抄一份表名 —— 两者都会漂移。
export { ALL_COLLECTIONS, EXPECTED_TABLE_NAMES } from './collections';

// `nativeReadFieldsOf` 是字段目录的唯一取法：离线校验用它算出期望白名单，
// 与播种同源 —— 杜绝"脚本里再抄一份字段清单"造成的两套算法漂移。
export {
  applyBaselineSeeds,
  seedSettings,
  seedStores,
  seedRoles,
  seedRoleResources,
  nativeReadFieldsOf,
  resolveMainDataSourceKey,
} from './seeds/apply';
export type {
  ApplySeedsDeps,
  ApplySeedsResult,
  RoleSeedCounts,
  SeedCounts,
  SeedLogger,
} from './seeds/apply';

export { ROLE_SEEDS, ROLE_SEED_COUNT, resourceSeedsOf, strategyOf } from './seeds/roles';
export type { RoleResourceSeed, RoleSeed } from './seeds/roles';
export { STORE_SEEDS, STORE_SEED_COUNT, STORE_CODE_PATTERN, toStoreRow } from './seeds/stores';

// 原生只读授权的两个常量：离线校验要用它们算出"资源级授权应有几行"
// （= 角色数 × 资源数）。从常量算而不是在脚本里再抄一份，改源码忘了改脚本时会立刻红。
export {
  NATIVE_READ_ALLOWLIST,
  NATIVE_READ_FIELD_DENY,
  ROLE_NATIVE_READ_ACTIONS,
  ROLE_NATIVE_READ_RESOURCES,
  nativeReadDenyFields,
} from './constants';

// 字段白名单的"受管"语义（Phase 2.1 整改项 4）：漂移对齐开关与比较函数。
//
// 为什么离线校验需要它们：光断言"白名单不含敏感列"是不够的 —— 真机上曾出现过
// `viewer/serviceTickets` 被测试探针改成 7 列仍在库里、而角色其余 31 行都正常的情况，
// 那种"单行漂移"只有把**完整期望集合**算出来逐行比对才能发现。
export { ACL_FIELDS_AUTOFIX_ENV, aclFieldsAutofixEnabled, sameFieldSet } from './constants';

// 脱敏归一化：离线校验与定向测试直接断言它（真机上出过一次
// "只读角色经 ticket.dataValues 拿到完整手机号"的事故，见 permission-service.toPlainRow）
export { toPlainRow, toPlainRows, maskMobileText } from './services/permission-service';

// 两个"对外拒绝语义"的错误类：离线校验要断言它们带的是**框架认识的**日志级别。
//
// 为什么值得导出：NocoBase 的 error-handler 用 `logMethods.includes(err.logLevel)`
// 决定级别，写错一个字符串（比如 'warning'）就静默回落成 'error' ——
// 于是"越权返回 404"又变成 error 日志，冒烟断言重新变红，而代码看着毫无问题。
// 这种"写错一个常量、行为退化、还不报错"的坑，只能用断言钉死。
export { NotFoundError, ForbiddenError } from './services/permission-service';

// ---------------------------------------------------------------------------
// Phase 8 / P8-B：**并发门的唯一测试缝**
// ---------------------------------------------------------------------------
/**
 * 把"原子取得短信重试资格"的 SQL 谓词单独导出。
 *
 * 为什么必须导出，而不是让脚本去 `new SmsService(...)`：
 *   ① `SmsService` 的构造依赖 `app.db` 与配置读缓存（`config.getInt`），
 *      在探针里重建一个只会得到**配置取不到的副本** —— 那验的是探针自己的错，
 *      不是线上会发生的竞争；
 *   ② 浏览器/CDP 那一路打不进这条 SQL（claim 只在 cron 任务里被调用，
 *      对外没有任何 HTTP 入口 —— 这是刻意的，见契约 §2.3"只做到可发现"）。
 *   于是导出**纯 SQL 谓词 + 参数**：脚本用 `app.db` 的**真实连接池**并发跑它，
 *   争的仍然是数据库里同一行的同一把条件更新 —— 与 `SmsService.claimForRetry`
 *   逐字节等价（`SmsService` 也调它，见 `sms-service.ts`）。
 *
 * ⚠️ 它不是"给业务用的接口"：没有 HTTP 出口、不改任何状态语义，
 *    只是把一条已经存在的 SQL 变成可被断言的对象。
 *    改 SQL 不需要同步改脚本 —— 脚本直接引用这里的产物。
 */
export { SMS_CLAIM_SQL, SMS_CLAIM_PARAMS, SMS_SEND_STATUS } from './constants';

/**
 * `appointmentOverdueFrom` —— DEV-71「预计上门日期」语义的**唯一实现**。
 *
 * 为什么门禁要从这里取，而不是在脚本里再写一遍 `+ grace*60000`：
 *   用户 2026-09-26 明令：**任何地方直接出现 `expected_visit_at + graceMs` 都视为实现错误**。
 *   如果脚本自己算一遍期望值，那脚本就成了**第二份实现** —— 两边一起错的时候
 *   永远对不上，而且对不上时会先怀疑脚本。让脚本引用同一函数：
 *     · 函数对了 ⇒ 断言验的是"它被接上了没有"（运行时那条路径）；
 *     · 函数错了 ⇒ 边界断言本身就该红，因为业务判断确实错了。
 *   脚本侧另有一组**字面量**断言（不引用本函数）钉死"以当地 23:59:59.999 为基准"
 *   这一条 —— 两者是不同的问题，不能互相替代。
 */
export { appointmentOverdueFrom } from './services/sla-scan-scheduler';

/**
 * 三个定时任务的注册器 + 重试轮次入口。
 *
 * 为什么导出：P8 的核心门禁之一是「任务重启/热重载不重复注册、且注册失败不致命」。
 *   该性质只在**注册函数面对一个没有 cronJobManager 的 app** 时才显形
 *   （必须只 warn + 返回 null，而不是抛错让 `plugin.load()` 失败）。
 *   没有出口就无法在真实产物上断言它 —— 只能靠读代码，而"读代码看着对"正是本项目
 *   反复吃亏的那一类（见 `docs/BACKLOG.md`）。
 */
export { registerReviewExpiryJob, runReviewExpirySweep } from './services/review-expiry-scheduler';
export { registerSmsRetryJob, runSmsRetrySweep } from './services/sms-retry-scheduler';
export { registerSlaScanJob, runSlaScan, slaPortFromServices } from './services/sla-scan-scheduler';
export { TASK_NAMES, TASK_RESULT, createTaskRegistry } from './services/task-registry';

// ---------------------------------------------------------------------------
// Phase 8：把"注册器面对坏 app 的降级行为"做成可断言的出口
// ---------------------------------------------------------------------------
/**
 * 供 P8 门禁（`scripts/verify-task-reliability.mjs` 的容器探针）调用的
 * **注册降级信号**。
 *
 * 为什么需要它 —— G1 是「重启/热重载不重复注册」，而它有一个**只有运行时
 * 才能显形**的孪生风险：若 `cronJobManager` 拿不到时 `plugin.load()` 直接抛错，
 * 整个应用起不来 —— 那"不重复注册"就成了空话（应用根本没起来）。
 * 三个 `register*Job` 都写了 `if (!manager) return null`，
 * 但**读代码看着对**正是本项目反复吃亏的那类判断。
 *
 * ⚠️ 必须放在 `index.ts`：esbuild 的 CJS 产物**只 re-export 入口文件**
 *    （`src/server/index.ts`）的具名导出 —— 写在 `plugin.ts` 里的话，
 *    `require(dist/server/index.js)` 拿不到（2026-09-26 实测踩到）。
 * ⚠️ 它不构造真实 app：探针传一个**没有 cronJobManager 的空对象**，
 *    断言三个注册器都不抛错且返回 null。这是降级路径的最小可断言形式。
 */
export const __p8RegisterProbe = {
  reviewExpiry: (app: any, deps: { services: any; logger: any }) =>
    registerReviewExpiryJob(app, deps),
  smsRetry: (app: any, deps: { services: any; logger: any }) => registerSmsRetryJob(app, deps),
  slaScan: (app: any, deps: { port: any; logger: any }) => registerSlaScanJob(app, deps),
};
