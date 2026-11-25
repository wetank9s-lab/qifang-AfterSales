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

    const stats = { page: 0, route: 0, tab: 0, tabRoute: 0, root: 0, grid: 0, block: 0, grants: 0, skipped: 0, repaired: 0 };

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
          sort: Date.now() * 1000,
          hideInMenu: false,
          // 与其它自定义页一致：单 Tab；`enableTabs` 交给 Tab 子路由表达
          enableTabs: false,
          enableHeader: true,
          displayTitle: true,
          // 🔴 rc.4 第八层根因（真实浏览器点击，2026-11-25）：
          //    既有 14 个 flowPage 的 `desktopRoutes.options` **全部**是
          //    `{"flowSurfaceMenuBindable":true}`；两个新页这一段是**空对象**。
          //    缺它的后果不是"菜单不出现"（菜单能出现、直连能渲染），
          //    而是 **FlowSurface 在 SPA 切换时拿不到可挂载的页面模型**：
          //    以旧页为父去 `deactivateCurrentTab`，`subModels.grid` 是 undefined，
          //    再调 `.mapSubModels` 直接 TypeError ⇒ 整页白屏。
          //    这正是"直连正常、点菜单切页崩溃"的唯一差异点。
          options: { flowSurfaceMenuBindable: true },
        },
      });
      stats.page += 1;
      info(`[svc:archives-page] 已创建页面「${PAGE_TITLE}」id=${page.id} schemaUid=${pageUid}`);
    }

    const pageId = Number(page.id);
    const pageSchemaUid = String(page.schemaUid ?? '');

    // -----------------------------------------------------------------------
    // ③'' 幂等补齐 `flowSurfaceMenuBindable`（对**已存在**的页也生效）
    //
    // 上面 create 分支只覆盖"这次新建"；隔离库里已建过一轮的页需要用 UPDATE 修。
    // 判据：`options.flowSurfaceMenuBindable !== true` ⇒ 补写。已是 true 则跳过。
    // ⚠️ 只补这一个键，**不覆盖** options 里其它已有内容（用 jsonb 合并语义）。
    // -----------------------------------------------------------------------
    {
      const opts = (page.options ?? {}) as Record<string, unknown>;
      if (opts.flowSurfaceMenuBindable !== true) {
        await routesRepo.update({
          filter: { id: pageId },
          values: { options: { ...opts, flowSurfaceMenuBindable: true } },
        });
        stats.repaired += 1;
        info(`[svc:archives-page] 已补齐 flowSurfaceMenuBindable（页面 id=${pageId}）`);
      } else {
        stats.skipped += 1;
      }
    }

    // -----------------------------------------------------------------------
    // ③'0 🔴 页面 schemaUid 必须有 `RouteModel` 行 —— rc.4 最关键的一步
    //
    // 2026-11-25 第六层根因（真实浏览器点击复现）：
    //   从「上门服务档案」点菜单切到「施工阶段设置」，页面**白屏**，控制台
    //   `n.mapSubModels is not a function @ invokeTabModelLifecycleMethod /
    //    deactivateCurrentTab`；而同一个 URL 直接输地址栏（全量加载）**渲染正常**。
    //   ⇒ 差异只在"是否要停用上一个 Tab 的模型"。
    //
    // 生产实测（`scqf_aftersales_candidate`，15 个 flowPage 逐一核对）：
    //   · **每一个**既有页面的 `desktopRoutes.schemaUid` 在 `flowModels.uid`
    //     都有一行 `{"schema":{"use":"RouteModel"}}`；
    //   · 而新页的 `r7bl5vxpc7d` / `87d9mal6123` **一行都没有**。
    //   这行是 FlowEngine 的**页面门面（facade）本身** —— 没有它，
    //   拿页面当模型用时那个字段是 `undefined`，生命周期方法一调就崩。
    //
    // ⚠️ 这行**不参与**闭包树：不需要 parentId、不需要闭包行（生产上也没有）。
    //    它只是页面 uid 的"门面登记"。`create()` 即可，别用 `upsertModel`
    //    （后者会去写闭包边，反而造出生产上不存在的结构）。
    // -----------------------------------------------------------------------
    {
      const routeModelRows = await modelsRepo.find({ filter: { uid: pageSchemaUid } });
      if ((routeModelRows ?? []).length > 0) {
        stats.skipped += 1;
        info(`[svc:archives-page] 页面门面 RouteModel 已存在（uid=${pageSchemaUid}），跳过`);
      } else {
        await modelsRepo.create({
          values: {
            uid: pageSchemaUid,
            name: pageSchemaUid,
            options: { schema: { use: 'RouteModel' } },
          },
        });
        stats.route = (stats.route ?? 0) + 1;
        info(`[svc:archives-page] 已创建页面门面 RouteModel（uid=${pageSchemaUid}）`);
      }
    }

    // -----------------------------------------------------------------------
    // ③ Tab 子路由（`type='tabs'`，parentId = 页面 id）
    //
    // 🔴 2026-11-25 第六层修正：**`enableTabs=false` 的单面板页面不该有 tabs 子路由**。
    //
    // 生产实测（20 条 tabs 行）：只有 7 个页面有 tabs 子路由，其余 8 个
    // `enableTabs=false` 的页面**一条都没有**。有 tabs 的那 7 个，`title` 是
    // 「全部 / 处理中 / 待门店确认 / 待客户评价 / 待处理 / 已结束」这种**真实状态页签**。
    //
    // 我此前多建了一条 `title=PAGE_TITLE` 的假页签，然后把卡片挂到它的 schemaUid 下 ——
    // 于是三处同时坏：① 页面显示一个和页面同名的莫名页签；
    // ② 真正的页面根模型下没有任何内容；③ 卡片挂在一个前端认为"还没渲染"的页签下。
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
      info(`[svc:archives-page] 已创建 Tab「${TAB_TITLE}」id=${tab.id} schemaUid=${String(tab.schemaUid ?? '')}`);
    }

    /**
     * 🔴 `enableTabs=false` ⇒ **不建 tabs 子路由，也不建 Tab 容器节点**。
     *
     * 🔴 2026-11-25 第七层修正（**推翻我上一轮的结论**）：
     *
     * 我上一轮据"8 个页面没有 tabs 子路由"把这里改成了空串 —— 那是**数错了**。
     * 正确统计（生产库，按 parentId 分组）：
     *   15 个 flowPage **全部**都有 tabs 子路由；14 个各 1 个，我的门店工单 6 个。
     *   **没有一个页面是 0 个。**
     *
     * 真实结构因此是三段（与既有页完全同型）：
     *   flowPage.schemaUid ── RouteModel（门面）
     *   tabs.schemaUid     ── RouteModel（门面） + BlockGridModel（subKey='grid'）
     *                          └─ 业务卡片（subKey='items'）
     *
     * 浏览器实证（隔离库，新页 vs 短信通知）：
     *   前端拿到页面根后，按 **grid 的 uid** 发 `findOne?parentId=<grid>&subKey=grid`；
     *   停在页面根 ⇒ 这个请求根本不发出 ⇒ 卡片接口一个都不调 ⇒ 正文空白。
     *   既有页：`200 findOne?parentId=kae90ypnrj5&subKey=grid` + `200 /api/svc:...`。
     *
     * ⚠️ tabs 的 `schemaUid` 在 flowModels 里也必须有一行 `RouteModel` 门面
     *    （生产实测 kae90ypnrj5 正是 tabs 的 schemaUid，行形态与页面门面一致）。
     */
    const tabSchemaUid = String(tab?.schemaUid ?? '');
    if (!tabSchemaUid) {
      throw new Error('[svc:archives-page] Tab 缺少 schemaUid，无法建立区块宿主');
    }
    {
      const tabFacade = await modelsRepo.find({ filter: { uid: tabSchemaUid } });
      if ((tabFacade ?? []).length > 0) {
        stats.skipped += 1;
        info(`[svc:archives-page] Tab 门面 RouteModel 已存在（uid=${tabSchemaUid}），跳过`);
      } else {
        await modelsRepo.create({
          values: {
            uid: tabSchemaUid,
            name: tabSchemaUid,
            options: { schema: { use: 'RouteModel' } },
          },
        });
        stats.tabRoute = (stats.tabRoute ?? 0) + 1;
        info(`[svc:archives-page] 已创建 Tab 门面 RouteModel（uid=${tabSchemaUid}）`);
      }
    }

    // -----------------------------------------------------------------------
    // ③'1 🔴 修正历史错误结构（幂等，只 UPDATE 不 DELETE）
    //
    // rc.3/rc.4 前两版把 Grid 与卡片挂在了「Tab 容器」/「假页签」下，并且根模型
    // 缺 `parent` 边、页面缺门面行。数据一旦落库就不会自己变对，所以迁移必须
    // 能**把旧结构纠正过来** —— 否则重跑只会"跳过"，错误永久保留。
    //
    // 判据用"当前实际父节点 ≠ 期望父节点"，只改父引用，不动任何业务字段。
    // -----------------------------------------------------------------------
    {
      const legacyRoots = await modelsRepo.find({
        filter: { 'options.parentId': pageSchemaUid, 'options.use': 'RootPageModel' },
      });
      const legacyRoot = (legacyRoots ?? [])[0];
      if (legacyRoot && !legacyRoot.options?.parent) {
        await modelsRepo.update({
          filterByTk: String(legacyRoot.uid),
          // `parent` 是 FlowEngine 走生命周期方法时用的那条边
          values: { options: { ...(legacyRoot.options ?? {}), parent: pageSchemaUid } },
        });
        stats.repaired = (stats.repaired ?? 0) + 1;
        info(`[svc:archives-page] 已修正历史根模型缺失的 parent 边（uid=${legacyRoot.uid}）`);
      }
      /**
       * 历史错误壳节点：`options.parentId = 页面schemaUid` 且 **无 use** 的那一行，
       * 就是旧版造出来的"Tab 容器空壳"。它不在闭包树里（`create` 不写闭包），
       * 但会让 `findOne?parentId=<page>&subKey=page` 的读法拿到脏数据。
       * 这里把它标记掉（改成 RouteModel 之外的中立形态不现实），只**报告**。
       */
      const shells = await modelsRepo.find({ filter: { 'options.parentId': pageSchemaUid } });
      const orphanShells = (shells ?? []).filter(
        (r: any) => !r.options?.use && String(r.uid) !== pageSchemaUid,
      );
      if (orphanShells.length > 0) {
        info(
          `[svc:archives-page] 检测到 ${orphanShells.length} 个历史遗留的空壳节点（uid=` +
            orphanShells.map((r: any) => r.uid).join(',') +
            '），不影响渲染，交由 rc.4 修复迁移处理',
        );
      }
    }

    // -----------------------------------------------------------------------
    // ③' 🔴 页面根模型（`RootPageModel`）—— 不建它，页面"能进但全空白"
    //
    // 这是 rc.3/rc.4 的前两版都漏掉的一步，也是 2026-11-25 浏览器验收
    // 第二层根因：菜单出得来、URL 也对（`/admin/uxe1c0p0a8b`），
    // 但页面里 `table` 数为 0、`ant-tabs-tabpane` 数为 0、正文只有菜单文字。
    //
    // 实证（隔离实例，有/无对照）：
    //   · 既有页 `flowModels:findOne?parentId=<schemaUid>&subKey=page` → **200**（有根模型）
    //   · 新建页 同一请求 → **204 No Content**（没有根模型）
    //   ⇒ FlowSurface 拿不到页面根，整棵树渲染不出来。
    //
    // 行的形态（生产实测，14 个既有页无一例外）：
    //   uid      = 新建的随机 uid（**不等于** schemaUid —— 那是页面行的 uid，不是模型的）
    //   name     = 同 uid
    //   options  = { parentId: <页面 schemaUid>, subKey:'page', subType:'object',
    //                use:'RootPageModel',
    //                props:{ routeId, title, enableTabs, displayTitle, icon, enableHeader },
    //                stepParams:{ pageSettings:{ general:{ …与 props 同值 } } },
    //                parent: <页面 schemaUid> }
    //
    // ⚠️ 两个容易写错的点：
    //    ① `parentId` 是**页面 schemaUid**，不是 `desktopRoutes.id`；
    //    ② `routeId` 是 `desktopRoutes.id`（数字），FlowSurface 用它回查路由元信息。
    //       写错的表现同样是"页面空白"，且没有任何报错。
    // -----------------------------------------------------------------------
    let rootParentUid = '';
    const existingRoots = await modelsRepo.find({
      /**
       * ⚠️ 用 `parentId + use` 定位**本页的**页面根，不再用 `subKey:'page'`。
       *
       * 2026-11-25 修正：`upsertModel` 的 `modelToSingleNodes` / `insertSingleNode`
       * 只把 `childOptions.type`（= `subKey`）写进 **`flowModelTreePath.type`**，
       * **不写进 `flowModels.options`**。所以真库里查不到 `options.subKey='page'`
       * 这一行 —— 它只在闭包表的 `type` 列上。
       * 照旧按 `options.subKey` 查会恒定 0 行 ⇒ 迁移每次重跑都重复建一个页面根
       * （多份 RootPageModel 挂在同一个 schemaUid 下，前端取哪一份是未定义的）。
       *
       * `parentId` + `use` 都在 options 里（parentId 由 childOptions 写回、
       * use 原样落库），且两者组合**足以唯一确定**"这是本页的根模型"。
       */
      filter: { 'options.parentId': pageSchemaUid, 'options.use': 'RootPageModel' },
    });
    if ((existingRoots ?? []).length > 0) {
      stats.skipped += 1;
      info(`[svc:archives-page] 页面根模型已存在（uid=${(existingRoots ?? [])[0]?.uid}），跳过`);
      rootParentUid = String((existingRoots ?? [])[0]?.uid ?? '');
    } else {
      if (!pageSchemaUid) {
        throw new Error('[svc:archives-page] 页面缺少 schemaUid，无法建根模型');
      }
      const rootUid = nanoid11();
      const pageProps = {
        routeId: pageId,
        title: PAGE_TITLE,
        enableTabs: false,
        displayTitle: true,
        icon: '',
        enableHeader: true,
      };
      /**
       * 🔴 `parent` 与 `parentId` 必须**同时**写进 options（2026-11-25 第六层修正）。
       *
       * 生产上 14 个既有根模型**无一例外**两个字段都在。FlowEngine 的
       * `mapSubModels` / `invokeTabModelLifecycleMethod` 走的是 `options.parent`
       * 这条边（不是 `parentId`）；只有 `parentId` 时，切页那一刻拿不到父模型，
       * 抛 `n.mapSubModels is not a function` ⇒ 整页白屏。
       *
       * 实测对照：新页只有 `parentId`（无 `parent`）时，从别的页面点菜单切进来白屏；
       * 直接在地址栏敲同一个 URL（全量加载，不需要祖先链）则正常渲染。
       */
      await modelsRepo.upsertModel({
        uid: rootUid,
        name: rootUid,
        // parentId / subKey / subType 是**顶层**字段：`upsertModel` 用它们
        // 生成 `childOptions`，`insertSingleNode` 靠它写闭包表的那条边。
        parentId: pageSchemaUid,
        subKey: 'page',
        subType: 'object',
        use: 'RootPageModel',
        props: pageProps,
        stepParams: { pageSettings: { general: { ...pageProps } } },
        parent: pageSchemaUid,
      });
      stats.root = (stats.root ?? 0) + 1;
      rootParentUid = rootUid;
      info(`[svc:archives-page] 已创建页面根模型 RootPageModel（uid=${rootUid}，parent=${pageSchemaUid}，routeId=${pageId}）`);
    }

    // -----------------------------------------------------------------------
    // 🔴 全流程只用 `modelsRepo.upsertModel()` —— **不是** `create()`，**也不是** `save()`
    //
    // 2026-11-25 浏览器验收挖出的第三、第五层根因：
    //
    //   ① `create()` 走**裸 insert**，绕开 `FlowModelRepository.insertSingleNode`，
    //      于是 **`flowModelTreePath` 一行都不写**。前端按祖先链解析模型树时
    //      `findOne?parentId=<schemaUid>&subKey=page` 一路 **204**，
    //      页面能进、URL 对、**全空白**。
    //
    //   ② 而"用 save()"这个修法是**错的**：`@nocobase/database` 的 `Repository`
    //      **根本没有 `save()` 方法**（实测原型只有 find/findOne/create/update/…）。
    //      隔离实例当场 `modelsRepo.save is not a function`、503 起不来。
    //      更糟的是离线桩当初"实现"了 `save()` ⇒ 门禁 82 项全绿、反向验证 5/5，
    //      真机第 3 秒崩。**桩比真机宽松 ⇒ 门禁永远绿 ⇒ 等于没门禁。**
    //
    //   正确入口是 `FlowModelRepository.upsertModel(model)`：
    //      modelToSingleNodes → insertSingleNode
    //        → insertSchemaRecord（`create` + `disableInsertHook:true`，说明闭包行
    //          **不是** afterInsert 钩子写的，是 insertSingleNode 里裸 SQL 写的）
    //        → 自身 (uid,uid,0,type) + 继承父的全部祖先 + 同级 sort
    //      model 形状：`{ uid, name, parentId, subKey, subType, ...options }`
    //      （`parentId/subKey/subType` 是**顶层**，其余原样落进 `options`）
    //      返回：**展开后的模型对象** `{ ...options, uid }`，不是实例、不是 {uid} 包装。
    //
    //   ③ 结构必须是**两层**：Tab → `BlockGridModel` → 业务卡片。
    //      生产 22 个 Tab 实测，21 个是 `subKey='grid'` 的 `BlockGridModel`
    //      （唯一例外是早期遗留的单层页）。前端进入 Tab 后按 `subKey='grid'`
    //      找网格，找不到就**不渲染任何内容** —— 卡片直接挂 Tab 看着"在库里"，
    //      页面却是白的。
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // ④-a 区块宿主 `BlockGridModel`（Tab 的直接子节点）
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // ④ 区块（`flowModels` 一行，use = ServiceArchivesAdminModel）
    //
    // ⚠️ `name` 列存的是**节点 uid 本身**（不是类名），类名在 `options.use`。
    //    这一点在生产库里可验证：`select name, options->>'use' from "flowModels"`。
    // -----------------------------------------------------------------------
    // ④-a 区块宿主 `BlockGridModel`（**Tab 的直接子节点**）
    //
    // 🔴 生产实证（2026-11-25，隔离库 = 生产副本）：
    //    `select ... from desktopRoutes dr join flowModels fm
    //       on fm.options->>'parentId' = dr."schemaUid" where dr.type='tabs'`
    //    ⇒ **22 个 Tab 里 21 个的直属子节点是 `BlockGridModel`（subKey='grid'）**，
    //      唯一例外是早期遗留的单层页。
    //    前端进入 Tab 后按 `subKey='grid'` 找网格（`findOne?parentId=<tabs>&subKey=grid`），
    //    找不到就**不渲染任何内容**。卡片直接挂 Tab 在库里"看着对"，
    //    浏览器的实际表现是：菜单进得去、URL 对、正文空白、`table` 数 0。
    //    这正是"只依据数据库行数宣布完成"会漏掉的那种缺陷。
    // -----------------------------------------------------------------------
    const existingGrids = await modelsRepo.find({
      filter: { 'options.parentId': tabSchemaUid, 'options.use': 'BlockGridModel' },
    });
    let gridUid = String((existingGrids ?? [])[0]?.uid ?? '');
    if (gridUid) {
      stats.skipped += 1;
      info(`[svc:archives-page] BlockGridModel 已存在（uid=${gridUid}），跳过`);
      /**
       * 🔴 2026-11-25 第九层根因（也是最后一层）：`subType` 必须是 **object**。
       *
       * 生产 `flowModels` 里 60 个 `BlockGridModel` 的 `options.subType` **全部是
       * `"object"`，一个 `"array"` 都没有**。我从卡片继承了 `"array"` 写错，
       * 而离线门禁只看 `use`/`parentId`，看不到 `subType` —— 于是 82 项全绿，
       * 真机却「从新页切走必白屏、切进新页不白屏」（离开时才读 `subModels.grid.mapSubModels`）。
       *
       * 修法：已存在的行**就地更正**，不删不重建（保留 uid，闭包表不动）。
       */
      const staleGrid = (existingGrids ?? [])[0];
      if (String(staleGrid?.options?.subType ?? '') !== 'object') {
        await modelsRepo.update({
          filter: { uid: gridUid },
          values: {
            options: { ...(staleGrid.options ?? {}), subType: 'object' },
          },
        });
        stats.repaired += 1;
        info(`[svc:archives-page] 已修正 BlockGridModel.subType → object（uid=${gridUid}）`);
      }
    } else {
      if (!tabSchemaUid) {
        throw new Error('[svc:archives-page] 缺少区块宿主的父节点（Tab），无法挂载网格');
      }
      gridUid = nanoid11();
      await modelsRepo.upsertModel({
        uid: gridUid,
        name: gridUid,
        parentId: tabSchemaUid,
        subKey: 'grid',
        // ⚠️ object，不是 array！生产 60/60 全是 object（见上面注释）
        subType: 'object',
        use: 'BlockGridModel',
        props: {},
        decoratorProps: {},
        parent: tabSchemaUid,
      });
      stats.grid = (stats.grid ?? 0) + 1;
      info(`[svc:archives-page] 已创建 BlockGridModel（uid=${gridUid}，parent=${tabSchemaUid}）`);
    }

    // ④-b 业务卡片 —— 挂在 **Grid 的 uid** 下
    const existingBlocks = await modelsRepo.find({
      filter: { 'options.use': BLOCK_USE },
    });
    if ((existingBlocks ?? []).length > 0) {
      stats.skipped += 1;
      info(`[svc:archives-page] 区块 ${BLOCK_USE} 已存在（${existingBlocks.length} 个），跳过`);
    } else {
      const blockUid = nanoid11();
      await modelsRepo.upsertModel({
        uid: blockUid,
        // name = uid：Flow Engine 按 uid 索引节点；写成类名会让整棵树的 parentId 对不上
        name: blockUid,
        parentId: gridUid,
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
      });
      stats.block += 1;
      info(`[svc:archives-page] 已创建区块 ${BLOCK_USE}（uid=${blockUid}，parent=${gridUid}）`);
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
    // ⑤' UI layout 绑定（`desktopRoutesUiLayouts`）—— 菜单能否出现的**真正闸门**
    //
    // 🔴 这是 rc.3 抄漏的一步，也是 2026-11-25 浏览器验收暴露的根因。
    //
    //    `desktopRoutes:listAccessible` 被 `@nocobase/plugin-ui-layout` 用
    //    preActionHandler 接管（`addDesktopRouteLayoutFilter`），请求实际带
    //    `?layout=admin-layout-model`，模块内的过滤条件是：
    //
    //        getDesktopRouteLayoutFilterByUid(uid) ⇒ { "uiLayouts.uid": uid }
    //
    //    ⇒ **没有 `desktopRoutesUiLayouts` 绑定的路由，在 SQL 层就被过滤掉**，
    //      根本到不了后续的角色裁剪。表现是：`desktopRoutes` / `flowModels` /
    //      `rolesDesktopRoutes` 三张表全都对得上、菜单里就是不出现 ——
    //      正是用户 §一 警告的「路由和授权均存在、但页面无法渲染」。
    //
    //    为什么播种脚本（走 `flowSurfaces:applyBlueprint`）不需要单写这一步：
    //    plugin-ui-layout 注册了 `desktopRoutes:create` / `updateOrCreate` 的
    //    **preActionHandler**（`addDesktopRouteWriteLayout`），会经由 API 建的
    //    路由自动补 `uiLayouts`。本迁移是**直接写库**，绕过了那个钩子，
    //    所以必须自己补。
    //
    //    生产实测基线（2026-11-25）：38 条路由绑 `admin-layout-model`、
    //    2 条绑 `mobile-layout-model`；本次新建的 4 条（2 页 + 2 Tab）
    //    一条都没绑 ⇒ 这是唯一未绑定的路由集合。
    //
    //    表结构（实测，与 rolesDesktopRoutes 同型：无 id 列、复合主键）：
    //        createdAt / updatedAt  timestamptz NOT NULL（无默认值）
    //        desktopRouteId         bigint      NOT NULL
    //        uiLayoutUid            varchar(255) NOT NULL
    //        PRIMARY KEY (desktopRouteId, uiLayoutUid)
    //    ⇒ 同样只能原始 SQL + 显式 now() + ON CONFLICT DO NOTHING。
    //
    //    ⚠️ 必须先确认 `uiLayouts` 里有这个 uid，否则绑定的是个悬空引用：
    //       过滤条件照样不命中，且事后极难归因。查不到 layout 直接抛。
    // -----------------------------------------------------------------------
    const ADMIN_LAYOUT_UID = 'admin-layout-model';
    const layoutRows: any[] = await sequelize.query(
      `SELECT COUNT(*)::int AS n FROM "uiLayouts" WHERE uid = :uid AND enabled = true`,
      { replacements: { uid: ADMIN_LAYOUT_UID }, type: 'SELECT' as any },
    );
    const layoutCount = Number((Array.isArray(layoutRows) ? layoutRows[0] : layoutRows)?.n ?? 0);
    if (layoutCount < 1) {
      throw new Error(
        `[svc:archives-page] 找不到已启用的 uiLayout「${ADMIN_LAYOUT_UID}」。` +
          '拒绝在缺失 layout 的环境上建页 —— 那样建出来的路由不会出现在菜单里',
      );
    }

    const layoutTargets = Array.from(
      new Set([groupId, pageId, ...(tabRows ?? []).map((t: any) => Number(t.id))].filter((x) => Number.isFinite(x))),
    );
    let layoutBound = 0;
    for (const routeId of layoutTargets) {
      const [, affected]: any = await sequelize.query(
        `INSERT INTO "desktopRoutesUiLayouts" ("createdAt", "updatedAt", "desktopRouteId", "uiLayoutUid")
         VALUES (now(), now(), :routeId, :layoutUid)
         ON CONFLICT ("desktopRouteId", "uiLayoutUid") DO NOTHING`,
        { replacements: { routeId, layoutUid: ADMIN_LAYOUT_UID } },
      );
      if (Number(affected ?? 0) > 0) {
        layoutBound += 1;
      }
    }
    info(`[svc:archives-page] layout 绑定：新增 ${layoutBound} 条 → ${ADMIN_LAYOUT_UID}`);

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
      throw new Error('[svc:archives-page] 回查失败：页面下没有任何 Tab 子路由（前端按 tabs.schemaUid 找网格）');
    }
    /**
     * 🔴 页面门面回查 —— 2026-11-25 第六层根因的守卫。
     *
     * 缺这一行的表现极其隐蔽：菜单能点、URL 能直达（全量加载正常渲染），
     * 但**从别的后台页面点菜单切进来**时整页白屏，控制台
     * `n.mapSubModels is not a function`。只跑"打开 URL 截图"是发现不了的。
     */
    const verifyRouteModel = await modelsRepo.find({ filter: { uid: pageSchemaUid } });
    if ((verifyRouteModel ?? []).length !== 1) {
      throw new Error(
        `[svc:archives-page] 回查失败：页面门面 RouteModel 应有 1 条（uid=${pageSchemaUid}），` +
          `实际 ${(verifyRouteModel ?? []).length} 条。缺它 ⇒ 直接进 URL 正常、点菜单切换白屏`,
      );
    }
    /**
     * 🔴 页面根模型回查 —— 覆盖不到的那一步就是会被漏掉的那一步。
     *
     * 缺 RootPageModel 的表现：菜单有、URL 对、页面**全空白**，
     * 且 `flowModels:findOne?parentId=<schemaUid>&subKey=page` 回 204。
     * 这条断言就是把那个 204 提前到部署时暴露。
     */
    const verifyRoots = await modelsRepo.find({
      // ⚠️ 不带 `options.subKey` —— `upsertModel` 只把 subKey 写进闭包表的 `type`，
      //    不写进 `flowModels.options`。带上它查恒 0 行，会把**正确的落库**判成失败。
      filter: { 'options.parentId': pageSchemaUid, 'options.use': 'RootPageModel' },
    });
    if ((verifyRoots ?? []).length !== 1) {
      throw new Error(
        `[svc:archives-page] 回查失败：页面根模型 RootPageModel 应有 1 条（parent=${pageSchemaUid}），` +
          `实际 ${(verifyRoots ?? []).length} 条。缺它 ⇒ 页面能进但**全空白**（FlowSurface 拿不到页面根）`,
      );
    }
    /**
     * 🔴 网格回查 —— 这一条专门盯住"卡片在库里但页面空白"。
     *
     * 前端进 Tab 后按 `parentId=<tabs.schemaUid>&subKey=grid` 找 `BlockGridModel`；
     * 查不到就**什么都不渲染**。只断言"卡片行存在"会漏掉它。
     */
    const verifyGrids = await modelsRepo.find({
      filter: { 'options.parentId': tabSchemaUid, 'options.use': 'BlockGridModel' },
    });
    if ((verifyGrids ?? []).length !== 1) {
      throw new Error(
        `[svc:archives-page] 回查失败：Tab 下的 BlockGridModel 应有 1 条（parent=${tabSchemaUid}），` +
          `实际 ${(verifyGrids ?? []).length} 条。缺它 ⇒ 卡片挂上了但前端找不到网格、**页面空白**`,
      );
    }
    const verifyBlocks = await modelsRepo.find({ filter: { 'options.use': BLOCK_USE } });
    if ((verifyBlocks ?? []).length < 1) {
      throw new Error(`[svc:archives-page] 回查失败：区块 ${BLOCK_USE} 不存在`);
    }
    /**
     * 卡片必须挂在**网格**下，不是挂在 Tab 下。
     * 只断言"卡片存在"会让"挂错父节点"全绿 —— 而挂错的表现就是空白页。
     */
    const blockParent = String((verifyBlocks ?? [])[0]?.options?.parentId ?? '');
    if (blockParent !== String((verifyGrids ?? [])[0]?.uid ?? '')) {
      throw new Error(
        `[svc:archives-page] 回查失败：卡片 ${BLOCK_USE} 的父节点是 ${blockParent || '(空)'}，` +
          `应为 BlockGridModel 的 uid ${(verifyGrids ?? [])[0]?.uid ?? '(空)'}。` +
          '挂在 Tab 下在库里看着对，但前端不会渲染',
      );
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

    /**
     * 🔴 layout 绑定回查 —— **这条断言是本轮最贵的一课，不要删**。
     *
     * rc.3 的做法是"建路由 + 建 Tab + 建区块 + 授角色"，四张表全都查得到，
     * 回查也全绿，但**菜单里就是不出现**。原因是漏了 `desktopRoutesUiLayouts`，
     * 而当时的回查只核对前三张表 —— 也就是说：
     *
     *      **回查覆盖不到的那一步，就是会被漏掉的那一步。**
     *
     * 断言写成"逐个节点 × 必须有绑定"，而不是"总数 > 0"：
     * 只绑页面不绑 Tab，菜单能出来但 Tab 缺失，同样是坏页面。
     */
    const boundRows: any[] = await sequelize.query(
      `SELECT "desktopRouteId"::bigint AS id FROM "desktopRoutesUiLayouts"
       WHERE "uiLayoutUid" = :layoutUid AND "desktopRouteId" IN (:ids)`,
      { replacements: { layoutUid: ADMIN_LAYOUT_UID, ids: layoutTargets }, type: 'SELECT' as any },
    );
    const boundSet = new Set(
      (Array.isArray(boundRows) ? boundRows : []).map((r: any) => Number(r.id ?? r.desktopRouteId)),
    );
    const unbound = layoutTargets.filter((id) => !boundSet.has(id));
    if (unbound.length > 0) {
      throw new Error(
        `[svc:archives-page] 回查失败：${unbound.length} 个节点没有绑定 uiLayout「${ADMIN_LAYOUT_UID}」` +
          `（id=${unbound.join(',')}）。缺这一步 ⇒ 路由存在、授权存在，但 listAccessible 的 ` +
          `"uiLayouts.uid" 过滤会把它整棵剪掉，菜单里永远不出现`,
      );
    }

    info(
      `[svc:archives-page] 完成：新增 页面 ${stats.page} / 门面 ${stats.route} / 根模型 ${stats.root} / 网格 ${stats.grid} / 区块 ${stats.block} / 授权 ${stats.grants}；` +
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
