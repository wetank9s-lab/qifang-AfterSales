/**
 * 迁移：补写「角色 × 资源」级授权（dataSourcesRolesResources + ...Actions）。
 *
 * 为什么是**追加一个迁移**、而不是改上一个：
 *   umzug 用「文件名」在主库的 `migrations` 表里记录执行状态。
 *   上一个迁移 `20260920-baseline-seed` 已经在本机实例上执行过并被记为完成，
 *   此时**改它的内容不会重跑**（umzug 只认名字），改文件名则会变成"两个迁移都跑"。
 *   所以"给已安装实例再补一批数据"的唯一正规做法就是**追加一个新迁移**。
 *   命名 `20260920-role-resource-grants` 按字典序排在 `20260920-baseline-seed` 之后
 *   （'b' < 'r'），保证 baseline 先行 —— 资源授权依赖角色与策略已存在。
 *
 * 为什么这一级数据会"漏"：
 *   第一版的 seedRoles() 只写了 roles + dataSourcesRoles，
 *   而 NocoBase 的权限判定是**两级**：
 *     ① strategy.actions                      —— 全局 action 名白名单
 *     ② dataSourcesRolesResources(+Actions)   —— 逐资源放行
 *   只写 ① 的现象是：角色在后台看得见、用户能登录、策略也查得到，
 *   但**每个资源的请求都是** 403 {"errors":[{"message":"No permissions"}]}。
 *   真机取证：四个业务角色连自己的工单列表都打不开（docs/API.md §6 声明允许读取）。
 *   因为是 fail-closed，它看起来"很安全"，最容易被人当成预期行为而长期漏掉。
 *
 * 为什么顺序上不能指望插件的 afterLoad 钩子（**已被后续实现超越，保留作为背景**）：
 *   @nocobase/server 的 app.upgrade() 实测时序（node_modules 内取证）：
 *     … → pm.initOtherPlugins() → **app.load()（插件 afterLoad 钩子在这跑）**
 *       → pm.upgrade() → migrator.afterLoad.up()（**迁移在这跑**）→ restart()
 *   即插件的 afterLoad 早于本迁移执行。第一版实现里，插件那一轮的 ACL 回灌
 *   读不到尚不存在的授权行（applied 会是 0，health 的 rolesResourcesInAcl=0）。
 *   两个信号一起看即可定位：roleResourcesSeeded=true 而 rolesResourcesInAcl=0
 *   = "库里有了、内存还没灌"，属正常中间态，重启（本迁移之后必然发生）即消解。
 *
 * ⚠️ 现状（2026-09-20 起）：插件 afterLoad 会**先自愈再回灌**（见 plugin.ts 的
 *   repairRoleResources），所以上述"0 的中间态"已不再出现 —— afterLoad 自己就会
 *   补建缺失的授权行。本迁移因此退化为**冗余保险**：对"迁移已记录完成、
 *   但授权行被后续误删"的实例，真正兜底的是 afterLoad 的自愈，而不是它。
 *   保留本迁移的理由是它对"全新实例的首次 upgrade"仍然有效且无副作用。
 *
 * 幂等：seedRoleResources() 按 (roleName, dataSourceKey, name) 查重后只增不改，
 *   手滑重跑不会产生重复行，也不会覆盖运营在后台调过的授权；
 *   但会**修正不安全的 fields 取值**（null = 整行下发泄露 token、[] = 空壳），
 *   见 seeds/apply.ts 的 repairUnsafeActionFields。
 *
 * 失败语义：**抛出**。被 umzug 记为完成的迁移若静默失败就再无机会补上数据。
 */
import { Migration } from '@nocobase/database';

import { seedRoleResources } from '../seeds/apply';

export default class extends Migration {
  /** 表已建好、插件已加载完毕之后执行 */
  on = 'afterLoad';

  async up(): Promise<void> {
    const app: any = (this as any).context?.app;
    const db: any = (this as any).context?.db ?? (this as any).db;

    if (!db || typeof db.getRepository !== 'function') {
      throw new Error(
        '[service-ticket/migration] 无法取得 db（迁移上下文不完整），角色资源级授权未写入',
      );
    }

    try {
      const result = await seedRoleResources({
        db,
        app,
        logger: {
          info: (m: string) => app?.log?.info?.(m),
          warn: (m: string) => app?.log?.warn?.(m),
          error: (m: string) => app?.log?.error?.(m),
        },
        operator: 'migration:20260920-role-resource-grants',
      });

      app?.log?.info?.(
        `[service-ticket] 角色资源级授权迁移完成：新增 ${result.created} 条，跳过 ${result.skipped} 条，` +
          `修正不安全字段白名单 ${result.repaired} 行` +
          (result.orphansRemoved ? `，清理无主行 ${result.orphansRemoved} 行` : '') +
          '（已存在的授权未被覆盖）',
      );
    } catch (error) {
      throw new Error(
        `[service-ticket/migration] 角色资源级授权写入失败：${(error as Error)?.message}。` +
          '该迁移已被记录为执行过，若要让其重跑，需从 migrations 表删除对应记录',
      );
    }
  }
}
