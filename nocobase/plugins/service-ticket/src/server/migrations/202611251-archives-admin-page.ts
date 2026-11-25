import { Migration } from '@nocobase/database';

/**
 * R2.2.4-rc.3（2026-11-25）：把「上门服务档案」后台页面**真正落库**。
 *
 * ===========================================================================
 * 为什么必须有这条迁移（生产 P0 的根因）
 * ===========================================================================
 * 用户线上反馈：「腾讯云 NocoBase 电脑后台看不到上门服务档案菜单，
 *               也没有明确的档案管理入口」。
 *
 * 只读核查（2026-11-25，生产 `scqf_aftersales_candidate`）逐项结果：
 *   · `desktopRoutes` 共 36 行，`type='flowPage'` 的 15 个，**逐个点名没有**
 *     「上门服务档案」；
 *   · `flowModels` 2171 行，`ServiceArchivesAdminModel` 出现 **0** 次
 *     （同法对照：`StoreWorkbenchModel` / `HqWorkbenchBlockModel` /
 *      `HistoricalArchivesBlockModel` 都在）⇒ 连区块模型都没有；
 *   · `rolesDesktopRoutes` 八个角色全部不含该页；
 *   · `desktopRoutes:listAccessible` 实测：平台超管返回 14 个叶子页，
 *     **逐条核对无**「上门服务档案」；
 *   ⇒ 属"页面和路由**根本不存在**"，不是角色授权、不是缓存、不是菜单分组。
 *
 * 为什么它会不存在：页面历来靠 `scripts/seed-admin-pages.mjs` **手工播种**，
 * 而生产的 42 条迁移里**没有任何一条**负责建后台页面。也就是说这个页面
 * 代码写了、本地跑过、但从没在生产执行过 —— 而它不会报错，只是菜单里少一项。
 * 用户 §五 明令：「菜单/页面模型/角色关系须用**新增幂等迁移**或等效受控配置变更」
 * ⇒ 本迁移就是那一次受控变更。
 *
 * ===========================================================================
 * 三条硬约束（改本文件前先读）
 * ===========================================================================
 * ① **不猜 UID**。生产与本地不同构（实测：总部售后工作台 生产 `qke3hyq3v92`、
 *    本地 `zku15hcn09u`）。所以父分组、页面、Tab、区块全部按 **title / 语义**
 *    在库里现查；查不到就抛错，**绝不**写死一个本地 uid 去赌。
 * ② **不覆盖旧迁移、不删已有节点**。本迁移只做 INSERT（已存在则跳过），
 *    不 UPDATE 既有页面、不 DELETE 任何行。
 *    唯一例外：`档案移动测试` 那条 2026-11 排查留下的孤儿路由**不在这里动** ——
 *    用户 §五 明写"不删已有菜单节点"，清理由运维在后台自行处理。
 * ③ **幂等**。重跑时：页面已存在 ⇒ 跳过建页；Tab / 区块已存在 ⇒ 跳过；
 *    角色授权已存在 ⇒ 跳过。每一步都打印"新增 N / 跳过 M"，并**断言**
 *    "重跑后目标状态必须达成"，避免"跑完了但其实什么都没写"。
 *
 * ===========================================================================
 * 为什么区块直接写成 `ServiceArchivesAdminModel`
 * ===========================================================================
 * 播种脚本的两步法（先建宿主 `markdown` 区块 → 再把 `use` 改成
 * `ServiceArchivesAdminModel`）是为了绕开 blueprint 校验器对自定义区块的限制。
 * 但那是**走 `flowSurfaces:applyBlueprint` 这条路**才需要的规避手段；
 * 本迁移是直接写 `flowModels` 行，一次写成终态即可，少一步中间态、少一次失败点。
 *
 * ⚠️ 区块的 `options` 必须带 `parentId`（指向页面 Tab 的 uid）、`subKey`、`subType`，
 *    否则 Flow Engine 挂不上父节点 —— 页面会"存在但空白"，比不建更容易误导。
 */

/** 页面的导航分组标题（`desktopRoutes.type='group'`）—— 与 `ADMIN_NAV_GROUP` 同值 */
const NAV_GROUP_TITLE = '售后工单';
/** 页面标题。⚠️ 与 `ROLE_MENU_MATRIX`、`expected-sensitive-columns.mjs` 逐字一致 */
const PAGE_TITLE = '上门服务档案';
const TAB_TITLE = '上门服务档案';
const BLOCK_TITLE = '上门服务档案';
const BLOCK_USE = 'ServiceArchivesAdminModel';

/**
 * 角色 → 是否授予该菜单。
 *
 * 🔴 名单 = **服务端真正认的档案读角色**，不多一个、不少一个。
 *
 * 用户 2026-11-25 裁决（§三「菜单显示、页面路由、业务 API 权限必须一致」）：
 *   原 `ROLE_MENU_MATRIX` 里 `store_after_sales` 也登记了「上门服务档案」，
 *   但 `ARCHIVE_ADMIN_LIST_ROLES` / `ARCHIVE_READ_ROLES` 都**不含**它
 *   ⇒ 菜单能点开、列表接口 403。那是"给了一个点不进去的入口"，
 *   比不给更糟：用户会以为权限没生效。
 *   ⇒ 裁决为**只给真有权限的 4 个角色**，并同步修掉矩阵里的那一条。
 *
 *   · `store_sales`  —— 本店新增 + 允许的修改（`ARCHIVE_WRITE_ROLES`）
 *   · `store_manager` —— 本店只读
 *   · `hq_after_sales` / `hq_admin` —— 按原范围跨店只读（`ARCHIVE_HQ_READ_ROLES`）
 *   · `store_after_sales` —— **不给**：它只有工单四表权限，不是档案读角色
 *   · `viewer` —— 不给（用户 2026-11-09：「viewer 不自动获得档案读取权限」）
 *   · 平台内置 `root` / `admin` / `member` —— 由 NocoBase 自己维护，本迁移不碰；
 *     `archiveAdminList` 已用 `ARCHIVE_ADMIN_LIST_ROLES` 里的字面量放行超管。
 *
 * ⚠️ 这个数组必须与 `constants.ts` 的 `ARCHIVE_ADMIN_LIST_ROLES`（去掉 root/admin）
 *    保持一致。断言写在 ⑤ 段之后的注释里 —— 门禁 `verify-config` 会核对矩阵，
 *    而这里靠"名单同源"的注释 + 回查断言兜底。
 */
const PAGE_ROLES = ['store_sales', 'store_manager', 'hq_admin', 'hq_after_sales'];

export default class extends Migration {
  /**
   * `afterLoad` 而不是默认时机：
   *   `flowModels` / `desktopRoutes` 由 NocoBase 插件建表，
   *   默认时机会在这些表还不存在时执行（SQLite 桩上尤其明显）。
   */
  on = 'afterLoad';

  async up(): Promise<void> {
    const app: any = (this as any).context?.app;
    const db: any = (this as any).context?.db ?? (this as any).db;
    const info = (m: string) => app?.log?.info?.(m);

    if (!db || typeof db.getRepository !== 'function') {
      throw new Error('[svc:archives-page] 无法取得 db（迁移上下文不完整），后台档案页未建');
    }

    const routesRepo = db.getRepository('desktopRoutes');
    const modelsRepo = db.getRepository('flowModels');
    const grantsRepo = db.getRepository('rolesDesktopRoutes');

    const stats = { page: 0, tab: 0, block: 0, grants: 0, skipped: 0 };

    // -----------------------------------------------------------------------
    // ① 父分组：按 title 查，查不到就抛（不猜 id，也不"顺手新建一个分组"）
    //
    //    不新建分组的理由：新建分组会产生第二条同义导航，而 `rolesDesktopRoutes`
    //    对旧分组的历史授权不会自动迁过去 —— 结果是"两个售后工单组、其中一个是空的"。
    // -----------------------------------------------------------------------
    const groups = await routesRepo.find({ filter: { type: 'group', title: NAV_GROUP_TITLE } });
    const group = (groups ?? [])[0];
    if (!group) {
      throw new Error(
        `[svc:archives-page] 找不到导航分组「${NAV_GROUP_TITLE}」（desktopRoutes.type='group'）。` +
          '拒绝在未知结构上建页 —— 请先确认后台导航是否被改名或删除',
      );
    }
    const groupId = Number(group.id);

    // -----------------------------------------------------------------------
    // ② 页面（flowPage）。已存在 ⇒ 复用，**不改**已有行的任何字段。
    // -----------------------------------------------------------------------
    const existingPages = await routesRepo.find({
      filter: { type: 'flowPage', title: PAGE_TITLE },
    });
    let page = (existingPages ?? [])[0];

    if (page) {
      stats.skipped += 1;
      info(`[svc:archives-page] 页面「${PAGE_TITLE}」已存在（id=${page.id}），跳过创建`);
    } else {
      // ②' `id` 交给 ORM 的雪花字段生成。
      //
      // 🔴 实测（生产 `desktopRoutes`）：`id bigint`，**既没有 column_default、也没有 sequence**。
      //    它由字段 `SnowflakeIdField` 在 `beforeValidate` / `beforeSave` 钩子里调
      //    `app.snowflakeIdGenerator.generate()` 填入（见
      //    `@nocobase/database/lib/fields/snowflake-id-field.js` 的 `init()`）。
      //    ⇒ 只用 `repo.create()`（走 ORM 钩子），**绝不自己拼 id**：
      //      雪花是 41 位毫秒 + 机器位 + 序列位，自己拼的值一旦落进已用区间，
      //      会在**下一次有人建页**时才撞主键 —— 那种错最难归因。
      //
      // `schemaUid` 则相反，必须自己给：它是 flow-engine 树的根索引，
      // 留空会让页面"能进但空白"。
      const pageUid = nanoid11();
      page = await routesRepo.create({
        values: {
          type: 'flowPage',
          title: PAGE_TITLE,
          parentId: groupId,
          schemaUid: pageUid,
          menuSchemaUid: nanoid11(),
          // sort 用**毫秒时间戳**：与生产既有行的量级一致（1.79e15），
          // 且天然排在最后 —— 新页排在「日常业务」末尾，不打乱一线习惯的顺序。
          sort: Date.now() * 1000,
          hideInMenu: false,
          // 与其它自定义页一致：单 Tab；`enableTabs` 交给 Tab 子路由表达
          enableTabs: false,
          enableHeader: true,
          displayTitle: true,
        },
      });
      stats.page += 1;
      info(`[svc:archives-page] 已创建页面「${PAGE_TITLE}」id=${page.id} schemaUid=${pageUid}`);
    }

    const pageId = Number(page.id);
    const pageSchemaUid = String(page.schemaUid ?? '');

    // -----------------------------------------------------------------------
    // ③ Tab 子路由（`type='tabs'`，parentId = 页面 id）
    //
    // NocoBase 的 flowPage 必须挂至少一个 Tab，否则进页面报
    // "target page must contain at least one tab"。
    // -----------------------------------------------------------------------
    const existingTabs = await routesRepo.find({
      filter: { type: 'tabs', parentId: pageId, title: TAB_TITLE },
    });
    let tab = (existingTabs ?? [])[0];
    if (tab) {
      stats.skipped += 1;
      info(`[svc:archives-page] Tab「${TAB_TITLE}」已存在（id=${tab.id}），跳过`);
    } else {
      tab = await routesRepo.create({
        values: {
          type: 'tabs',
          title: TAB_TITLE,
          parentId: pageId,
          schemaUid: nanoid11(),
          sort: Date.now() * 1000,
          hideInMenu: false,
          enableTabs: true,
          enableHeader: false,
          displayTitle: false,
        },
      });
      stats.tab += 1;
      info(`[svc:archives-page] 已创建 Tab「${TAB_TITLE}」id=${tab.id}`);
    }
    const tabSchemaUid = String(tab.schemaUid ?? '');

    // -----------------------------------------------------------------------
    // ④ 区块（`flowModels` 一行，use = ServiceArchivesAdminModel）
    //
    // ⚠️ `name` 列存的是**节点 uid 本身**（不是类名），类名在 `options.use`。
    //    这一点在生产库里可验证：`select name, options->>'use' from "flowModels"`。
    // -----------------------------------------------------------------------
    const existingBlocks = await modelsRepo.find({
      filter: { 'options.use': BLOCK_USE },
    });
    if ((existingBlocks ?? []).length > 0) {
      stats.skipped += 1;
      info(`[svc:archives-page] 区块 ${BLOCK_USE} 已存在（${existingBlocks.length} 个），跳过`);
    } else {
      if (!tabSchemaUid) {
        throw new Error('[svc:archives-page] Tab 缺少 schemaUid，无法挂载区块');
      }
      const blockUid = nanoid11();
      await modelsRepo.create({
        values: {
          uid: blockUid,
          // name = uid：Flow Engine 按 uid 索引节点；写成类名会让整棵树的 parentId 对不上
          name: blockUid,
          options: {
            parentId: tabSchemaUid,
            subKey: 'items',
            subType: 'array',
            use: BLOCK_USE,
            props: {},
            decoratorProps: {},
            stepParams: {
              __flowSurfaceMeta: {
                // declaredKey 是"这一块是干什么的"的稳定标识；
                // 与播种脚本里的 `svc-archives-block` 保持同值，便于两条路互相对照。
                declaredKey: 'svc-archives-block',
                title: BLOCK_TITLE,
              },
            },
          },
        },
      });
      stats.block += 1;
      info(`[svc:archives-page] 已创建区块 ${BLOCK_USE}（uid=${blockUid}，parent=${tabSchemaUid}）`);
    }

    // -----------------------------------------------------------------------
    // ⑤ 角色授权（rolesDesktopRoutes）。只增不删。
    //
    // 🔴 这一张必须走**原始 SQL**，不能用 `grantsRepo.create()`。实测表结构：
    //      rolesDesktopRoutes
    //        createdAt      timestamptz NOT NULL   ← **无默认值**
    //        updatedAt      timestamptz NOT NULL   ← **无默认值**
    //        desktopRouteId bigint      NOT NULL
    //        roleName       varchar(255) NOT NULL
    //        PRIMARY KEY (desktopRouteId, roleName)   ← **复合主键，没有 id 列**
    //
    //    踩点记录：第一次探测用 ORM 心智模型写了 `id` 列，直接被 PG 拒；
    //    随后 `insert` 又被 `createdAt` 的 NOT NULL 拒（Failing row 的 id 位是 null，
    //    正说明这表根本没 id）。ORM 层会不会自动补时间戳取决于模型定义，
    //    而迁移要跨 SQLite 桩 / PG 两种方言，**不猜**才是稳的
    //    ⇒ 显式写 `now()`，并把"已存在"交给 `ON CONFLICT DO NOTHING` + 主键。
    //
    //    `ON CONFLICT DO NOTHING` 同时承担幂等：重跑时命中主键即静默跳过，
    //    不需要先 SELECT 再 INSERT（那是两次往返 + 竞态窗口）。
    //    但它"跳过"时不告诉影响行数 ⇒ 下面的回查才是判据，不靠返回计数。
    // -----------------------------------------------------------------------
    const sequelize = db.sequelize;
    if (!sequelize || typeof sequelize.query !== 'function') {
      throw new Error('[svc:archives-page] 无法取得 db.sequelize，角色授权无法写入');
    }

    /**
     * 🔴 授权必须覆盖**三样**，少一样菜单都出不来（2026-11-25 隔离预演 + 生产实测踩到）：
     *
     *   ① **分组节点**（`type='group'`）：`desktopRoutes:listAccessible` 是按树裁剪的，
     *      根分组没授权 ⇒ 整棵树返回 `[]`。生产实测：`store_sales` / `store_manager`
     *      各只有 2 条授权（都指向一个孤儿节点），**没有分组授权**
     *      ⇒ `listAccessible` 直接 `{"data":[]}`，他们连「售后工单」这一组都看不见。
     *   ② **页面**（`type='flowPage'`）。
     *   ③ **页面的 Tab**（`type='tabs'`，parentId = 页面 id）：只授页面不授 Tab，
     *      菜单能出来但点进去 Tab 缺 —— `scripts/seed-admin-pages.mjs` 的
     *      `subtreeIdsOf()` 注释里写着同一件事："整棵子树，与平台默认行为一致"。
     *
     * ⚠️ 分组授权是**给这个角色开放整组**吗？不是。
     *    NocoBase 的菜单树要求祖先节点可达；分组本身不产页面、不带业务接口。
     *    用户 §三 禁止的是"通过开放**资源或父级菜单全部子路由**来修导航"——
     *    这里只授权分组自身 + 本页子树，**不动该分组下任何其它页面**。
     */
    const tabRows = await routesRepo.find({ filter: { type: 'tabs', parentId: pageId } });
    const grantTargets: Array<{ routeId: number; label: string }> = [
      { routeId: groupId, label: `分组「${NAV_GROUP_TITLE}」` },
      { routeId: pageId, label: `页面「${PAGE_TITLE}」` },
      ...(tabRows ?? []).map((t: any) => ({
        routeId: Number(t.id),
        label: `Tab「${String(t.title ?? '')}」`,
      })),
    ];

    for (const roleName of PAGE_ROLES) {
      for (const target of grantTargets) {
        const [, affected]: any = await sequelize.query(
          `INSERT INTO "rolesDesktopRoutes" ("createdAt", "updatedAt", "desktopRouteId", "roleName")
           VALUES (now(), now(), :routeId, :roleName)
           ON CONFLICT ("desktopRouteId", "roleName") DO NOTHING`,
          { replacements: { routeId: target.routeId, roleName } },
        );
        // PG 返回影响行数；0 表示已存在（幂等跳过）。拿不到影响行数时不报错，
        // 由 ⑥ 的回查统一定案 —— 那才是唯一可信的判据。
        const n = Number(affected ?? 0);
        if (n > 0) {
          stats.grants += 1;
          info(`[svc:archives-page] 已授权角色 ${roleName} → ${target.label}`);
        } else {
          stats.skipped += 1;
        }
      }
    }

    // -----------------------------------------------------------------------
    // ⑥ 落盘回查 —— 不信任上面的返回值，重新查一遍
    //
    // 铁律：迁移"跑成功"不等于"数据在"。这里逐项断言目标状态真的达成，
    // 任何一项不成立就抛错（被 umzug 记为完成的迁移若静默失败就再无机会补上）。
    // -----------------------------------------------------------------------
    const verifyPages = await routesRepo.find({ filter: { type: 'flowPage', title: PAGE_TITLE } });
    if ((verifyPages ?? []).length !== 1) {
      throw new Error(
        `[svc:archives-page] 回查失败：页面「${PAGE_TITLE}」应有 1 条，实际 ${(verifyPages ?? []).length} 条`,
      );
    }
    const verifyTabs = await routesRepo.find({ filter: { type: 'tabs', parentId: pageId } });
    if ((verifyTabs ?? []).length < 1) {
      throw new Error('[svc:archives-page] 回查失败：页面下没有任何 Tab 子路由');
    }
    const verifyBlocks = await modelsRepo.find({ filter: { 'options.use': BLOCK_USE } });
    if ((verifyBlocks ?? []).length < 1) {
      throw new Error(`[svc:archives-page] 回查失败：区块 ${BLOCK_USE} 不存在`);
    }
    /**
     * 授权回查必须**逐个目标 × 逐个角色**核对，不能只看"页面那一条"。
     *
     * 为什么：第一版只查了 `desktopRouteId = pageId`，于是"页面授了、Tab 没授、
     * 分组没授"这种半成品也能全绿 —— 而它的真实表现是**菜单根本不出现**。
     * 那正是 2026-11-25 生产上 `store_sales` / `store_manager` 的现状
     * （2 条授权、都指向孤儿节点、没有分组授权 ⇒ `listAccessible` 返回 `[]`）。
     */
    const expectGrantRows = PAGE_ROLES.length * grantTargets.length;
    const verifyGrants = await grantsRepo.find({
      filter: {
        desktopRouteId: { $in: grantTargets.map((t) => t.routeId) },
        roleName: { $in: PAGE_ROLES },
      },
    });
    const actual = (verifyGrants ?? []).length;
    if (actual !== expectGrantRows) {
      const missing: string[] = [];
      for (const roleName of PAGE_ROLES) {
        for (const target of grantTargets) {
          const hit = (verifyGrants ?? []).some(
            (g: any) => Number(g.desktopRouteId) === target.routeId && String(g.roleName) === roleName,
          );
          if (!hit) missing.push(`${roleName}→${target.label}`);
        }
      }
      throw new Error(
        `[svc:archives-page] 回查失败：授权应有 ${expectGrantRows} 条（${PAGE_ROLES.length} 角色 × ` +
          `${grantTargets.length} 节点），实际 ${actual} 条。缺失：${missing.join('，') || '（计数不符）'}`,
      );
    }
    if (!pageSchemaUid) {
      throw new Error('[svc:archives-page] 回查失败：页面 schemaUid 为空，FlowModel 树无法关联');
    }

    info(
      `[svc:archives-page] 完成：新增 页面 ${stats.page} / Tab ${stats.tab} / 区块 ${stats.block} / 授权 ${stats.grants}；` +
        `跳过 ${stats.skipped} 项（已存在）。页面 id=${pageId}；授权覆盖 ${PAGE_ROLES.length} 角色 × ` +
        `${grantTargets.length} 节点 = ${expectGrantRows} 条`,
    );
  }
}

/**
 * 生成 11 位小写字母数字 **schemaUid** —— 与 NocoBase 自己的 uid 形态一致
 * （生产实测样例：`tujyw08ec1d`、`qke3hyq3v92`、`ypcok9wxzys`）。
 *
 * ⚠️ 它只用于 `schemaUid` / `menuSchemaUid`，**不用于行主键 id**。
 *    行主键由 ORM 的雪花字段生成（理由见 ② 段注释：`desktopRoutes.id`
 *    既无默认值也无 sequence，自己拼一个会与后续新建页面撞主键）。
 *
 * ⚠️ 不使用 `crypto.randomUUID()`：带横杠、36 位，Flow Engine 的 uid 校验会拒。
 * ⚠️ 不用 `Math.random` 拼纯时间戳：同一毫秒内建两个节点会撞 uid，
 *    而 `schemaUid` 在 flow-engine 里被当作树的根索引。
 */
function nanoid11(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  // 用 crypto 强随机；Node 22 的 globalThis.crypto 一定有
  const bytes = new Uint8Array(11);
  const c: any = (globalThis as any).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < 11; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
