import { Migration } from '@nocobase/database';

import { seedRoles } from '../seeds/apply';

/**
 * ARC-V1 / A1（2026-11-09）：补种两个档案模块业务角色
 * `store_sales`（门店销售）与 `store_manager`（门店负责人）。
 *
 * ===========================================================================
 * 为什么必须用 migration，而不是"重启一下就有了"
 * ===========================================================================
 * 种子只在三条路径上跑：`install()` / `afterEnable()` / 本目录的 migration。
 * NocoBase 的 `PluginManager.upgrade()` 对**已安装**插件**不会再调 install()**
 * （`if (!plugin.isPreset && !plugin.installed) await plugin.install()`）。
 * 本实例的插件早在 2026-09 就装好了 ⇒ 只改常量 + 重建 + 重启，角色**永远不会**落库。
 *
 * 而那个失败是**静默**的：用户在后台看不到新角色 → 没法把账号绑上去 →
 * `normalizeRoles()` 得到的角色列表里没有 `store_sales` → `scopeOf()` 判 none →
 * "能登录、菜单也在、但一条数据都看不到"。日志里只说"数据范围 none"，看不出根因。
 *
 * ===========================================================================
 * 为什么调 `seedRoles()` 而不是自己 INSERT
 * ===========================================================================
 * 落一个可用角色要写**三处**（`roles` / `dataSourcesRoles` / 内存 ACL），少一处表现不同：
 *   · 只写 `roles`：后台看得见角色，但 ACL 无 strategy ⇒ 所有 action 403；
 *   · 漏了 `dataSourcesRoles`：`RoleModel.writeToAcl()` 对 strategy 是
 *     `withOutStrategy: true` 硬编码，strategy 只能由 `DataSourcesRolesModel` 写入；
 *   · 漏了内存 ACL：必须重启才生效，而重启又会让人误以为"刚才那次没成功"。
 * `seedRoles()` 是这三处的唯一实现（install / afterEnable / migration 共用），
 * 自己再写一份必然漂移。
 *
 * 幂等：`seedRoles()` 的语义是**只增不改** —— 已存在的角色与策略一律跳过，
 * 运营在后台调过的内容不会被这次迁移冲掉。因此本迁移重复执行也安全
 * （虽然 umzug 只会跑一次）。
 *
 * 不做 down()：角色一旦被账号引用就不能删（`rolesUsers` 有外键），
 * 而"删角色"本身也不是一次数据迁移能安全承诺的事。需要撤销时走后台界面。
 */
export default class extends Migration {
  /**
   * 🔴 2026-11-11 R0-FREEZE 修复：本行此前**漏写**（其余 23 条迁移都写了）。
   *
   * 为什么必须有（不是风格问题）：本迁移要 `seedRoles()` 往 `roles` /
   * `dataSourcesRoles` 写数据，而这两张表由插件的 `loadCollections` 建。
   * 默认时机（`on = undefined`）会在**表建好之前**执行 ⇒ 全新库上直接报
   * "relation 不存在"，角色一条都补不出来；旧实例则连迁移都跑不完。
   * 门禁断言 `instance.on === 'afterLoad'` 正是为拦这个（它确实拦住了）。
   */
  on = 'afterLoad';

  async up(): Promise<void> {
    const app: any = (this as any).context?.app;
    const db: any = (this as any).context?.db ?? (this as any).db;

    if (!db || typeof db.getRepository !== 'function') {
      throw new Error(
        '[migration 202611091] 无法取得 db（迁移上下文不完整），ARC-V1 角色未写入',
      );
    }

    const counts = await seedRoles({
      app,
      db,
      operator: 'migration:202611091-arc-v1-roles',
    });

    console.log(
      `[migration 202611091] ARC-V1 角色补种：新建 ${counts.created} / 跳过 ${counts.skipped}`,
    );

    // ---- 回读自证：不要相信返回值，去库里看一眼 ----
    // 这条纪律来自 DEV-208：迁移"声称成功"但索引实际不存在，且没有任何报错。
    const [rows] = (await db.sequelize.query(
      `SELECT name FROM roles WHERE name IN ('store_sales','store_manager') ORDER BY name`,
    )) as unknown as [Array<{ name: string }>];
    const names = (rows ?? []).map((r) => r.name);
    console.log(`[migration 202611091] roles 表实际含：${names.join(', ') || '(无)'}`);

    if (!names.includes('store_sales') || !names.includes('store_manager')) {
      throw new Error(
        `[migration 202611091] 角色回读失败：期望 store_sales/store_manager，实际 [${names.join(',')}]`,
      );
    }
  }
}
