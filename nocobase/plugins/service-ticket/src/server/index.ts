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
