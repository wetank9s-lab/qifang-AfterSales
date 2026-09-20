/**
 * 版本与镜像的**单一事实来源**
 *
 * 为什么需要这个文件（Phase 2.1 整改项 5）：
 *   Phase 0 锁的是 NocoBase v2.1.x，Phase 1 实际用了 `2.2.15-full-no-nginx`。
 *   这个变更本身可以接受，但如果只写在散文里，下一个阶段的人看到
 *   `docs/ASSUMPTIONS.md` 还写着 v2.1.x，很自然就会"顺手升一下版本" ——
 *   而 NocoBase 的小版本确实带过破坏性行为变更（`parseRequest` 的单次 split、
 *   `refreshIndexes()` 的静默丢弃、`error-handler` 的 logLevel 判定，
 *   本项目三个最难的坑全部来自框架内部实现细节）。
 *
 *   所以版本必须能被**断言**，而不是靠人记得：
 *     · compose 里写的镜像 tag        → verify-config.mjs 断言
 *     · 真机跑着的容器镜像            → smoke-test.mjs 断言
 *     · 插件声明的兼容范围            → verify-plugin-load.mjs 断言
 *   三者任一漂移都会立刻变红，而"升级 NocoBase"就变成一个必须显式改本文件、
 *   并在评审里被看见的动作 —— 这正是"未经单独 Change Request 不允许升级"的落地方式。
 *
 * ⚠️ 改本文件 = 发起一次版本变更，必须同时：
 *   ① 在 docs/DEVIATIONS.md 或 CHANGELOG.md 记录 CR 与理由；
 *   ② 重跑三套校验 + 100 路并发验收；
 *   ③ 复查 docs/PHASE-1.md / ASSUMPTIONS.md 里记录的框架行为是否仍然成立
 *      （尤其：parseRequest 单次 split、refreshIndexes 静默丢弃、
 *       error-handler 的 logLevel、getFields() 返回数组、fields 三态语义）。
 */

/**
 * 冻结的 NocoBase 镜像 tag。
 *
 * `-full-no-nginx` 变体是必需的：默认镜像自带 nginx 并监听 80，
 * 与本项目"nginx 独立容器"的架构冲突（见 docker-compose.yml 的注释）。
 */
export const NOCOBASE_IMAGE = 'nocobase/nocobase:2.2.15-full-no-nginx';

/** 冻结的 NocoBase 版本号（从镜像 tag 派生，供插件兼容范围断言使用） */
export const NOCOBASE_VERSION = NOCOBASE_IMAGE.slice(NOCOBASE_IMAGE.indexOf(':') + 1);

/** PostgreSQL 镜像 tag（同样冻结：备份/恢复与 psql 行为假设依赖它） */
export const POSTGRES_IMAGE = 'postgres:16';

/** 冻结日期与依据，写在断言输出里，方便一眼看出这条 pin 是什么时候定的 */
export const VERSION_PINNED_AT = '2026-09-20';
