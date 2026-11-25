import { Migration } from '@nocobase/database';

/**
 * R2.2.4-rc.4（2026-11-25）：把「施工阶段设置」后台页面**真正落库**。
 *
 * ===========================================================================
 * 为什么必须有这条迁移
 * ===========================================================================
 * 用户 §二 正式 P0 核查指令：「此前已经明确要求：暖通六阶段的标题、说明可以在
 * 管理后台随时修改，不需要版本管理。本轮发现 `StageSettingsModel` 在构建产物中
 * 命中 0 次。**先核查实际功能是否已有其他实现，不能仅凭字符串次数判断**。」
 *
 * 三层实测（2026-11-25，生产 `scqf_aftersales_candidate` + 生产真实接口）：
 *
 *   ① 接口层 —— `svc:archiveStageConfigGet` **HTTP 200**，返回 6 行：
 *        survey 现场勘察 / plan 方案确认 / pipe 管路施工 /
 *        device 设备安装 / test 调试运行 / accept 客户验收，`can_edit=true`
 *      ⇒ 读写能力**真实存在且可用**。
 *   ② 权限层 —— `store_sales` / `store_manager` / `store_after_sales`
 *      三个门店角色 `can_edit` 均为 **false**
 *      ⇒ 「仅授权管理员可编辑」**已满足**。
 *   ③ 路由层 —— 后台菜单 14 个业务页，**没有**「施工阶段设置」
 *      ⇒ 管理员**根本点不到这个功能**。
 *
 * 生产库逐表点名（`scripts/prod-stage-page-probe.sql`）：
 *   · `desktopRoutes` 查 `title LIKE '%施工%' OR '%阶段%'` **0 行**；
 *   · `flowModels` 查 `options->>'use' = 'StageSettingsModel'` **0 行**；
 *   · `rolesDesktopRoutes` 无对应授权；
 *   · `service_settings` 37 个键里**没有** `archive.hvac_stage_labels`
 *     ⇒ 从未写过配置，系统一直在用代码默认值（这也解释了"改不了"的观感）。
 *
 * 根因与「上门服务档案」同型：`stage-settings.tsx` 文件头写着
 * 「页面路由由 `scripts/seed-stage-settings-page.mjs` 播种」，而
 * **那个文件从来不存在**（`ls` 直接 No such file）——是幽灵引用。
 * 页面代码写在 `dist/client/index.js` 里（`StageSettingsModel` 13 次、
 * `buildStageSettingsModel` 4 次），只是库里从来没有注册过节点。
 *
 * ⚠️ 上一轮我报的「dist 命中 0 次」是**自己量错了目标文件**（查了 `client-v2`），
 *    已纠正。这条注释留在代码里，是为了下次不再用"字符串命中次数"当结论。
 *
 * ===========================================================================
 * 用户 §二 的七条要求 → 本迁移 + 既有代码 如何逐条满足
 * ===========================================================================
 *   ① 仅授权管理员可编辑
 *      → 写动作 `svc:archiveStageConfigSave` 要 `CAPABILITY.ADMIN`（仅 hq_admin）；
 *        **本迁移只授菜单给 `hq_admin` + 内置 `admin`**，其余角色连页面都看不到。
 *        （`root` 由 NocoBase 自己维护，本迁移不碰。）
 *   ② 六阶段名称和说明可分别修改
 *      → `StageSettingsModel` 每行两个独立输入框（`stage-name-*` / `stage-desc-*`）。
 *        本迁移不涉及。
 *   ③ 保存后移动端重新读取即显示新内容
 *      → 保存走 `service_settings` + `config.invalidate()`；移动端每次进档案页都读同一份配置。
 *        本迁移不涉及。
 *   ④ 继续使用既有阶段配置存储及接口
 *      → 存储键 `archive.hvac_stage_labels`（`STAGE_CONFIG_KEY`，`stage-config-service.ts:50`），
 *        接口 `svc:archiveStageConfigGet` / `archiveStageConfigSave`。
 *        **本迁移一行都没碰这两样**，也不写任何 `service_settings` 行 ——
 *        首次保存由管理员在页面上点，默认值仍来自代码常量。
 *   ⑤ 六阶段固定 code 与业务顺序不变
 *      → 顺序由 `ARCHIVE_STAGE_ORDER` 常量决定；页面不渲染增删按钮。本迁移不涉及。
 *   ⑥ 原有档案/照片/阶段状态与审核规则不变
 *      → 本迁移只往 `desktopRoutes` / `flowModels` / `rolesDesktopRoutes` 三张
 *        **平台元数据表**写行，不触碰 `service_archives` / `service_archive_stages` /
 *        `service_archive_photos` / `service_archive_events` 任何一行。
 *   ⑦ 不引入版本管理和新的配置体系
 *      → 没有草稿表、没有发布流程、没有第二份配置源。
 *
 * 「不得通过直接插入不完整的 `desktopRoutes` 记录制造假页面」——本迁移按
 * **真实页面的完整三件套**建：
 *     flowPage 路由（含 schemaUid + menuSchemaUid）
 *     → tabs 子路由（含 schemaUid）
 *     → BlockGridModel 宿主（subKey='grid'）
 *     → StageSettingsModel 卡片（parentId = 宿主 uid，subKey='items'）
 *   这个四层形态是**从生产现存的同类页面抄下来的**（见下方 BLOCK 注释），
 *   不是自己想的 —— 少一层就会"能进页面但空白"。
 *
 * ===========================================================================
 * 三条硬约束（改本文件前先读）
 * ===========================================================================
 * ① **不猜 UID**。生产与本地不同构。父分组、页面、Tab、区块全部按
 *    **title / 语义**在库里现查；分组查不到就抛错，绝不写死一个 uid 去赌。
 * ② **不覆盖旧迁移、不删已有节点**。只做 INSERT（已存在则跳过），
 *    不 UPDATE 既有页面、不 DELETE 任何行。
 * ③ **幂等**。重跑时页面/Tab/区块/授权都已存在 ⇒ 全部跳过，且**断言目标状态达成**。
 */

/** 页面的导航分组标题（`desktopRoutes.type='group'`）—— 与 `ADMIN_NAV_GROUP` 同值 */
const NAV_GROUP_TITLE = '售后工单';
/** 页面标题。⚠️ 必须与 `expected-sensitive-columns.mjs` 的 `REQUIRED_ADMIN_PAGES`、
 *  `menu-groups.ts` 的 `GROUP_ADMIN.pages`、`ROLE_MENU_MATRIX.hq_admin` 逐字一致 */
const PAGE_TITLE = '施工阶段设置';
const TAB_TITLE = '施工阶段设置';
const BLOCK_USE = 'StageSettingsModel';

/**
 * 授菜单的角色名单。
 *
 * 🔴 只有 `hq_admin`。
 *    · `store_sales` / `store_manager` / `store_after_sales` —— 服务端
 *      `archiveStageConfigSave` 要 `CAPABILITY.ADMIN`，他们既不能写，读也没业务价值；
 *      给菜单就是"点进去看一个只读的六行表"，属于 §三 禁止的"菜单与权限不一致"。
 *    · `hq_after_sales` / `viewer` —— 同上，不给。
 *    · 平台内置 `root` / `admin` / `member` —— NocoBase 自己维护，本迁移不碰；
 *      生产实测同类页（服务时效/短信通知/客户页面装修/门店账号）都只有
 *      `admin,hq_admin,member` 三个内置/管理角色，本页**照此对齐**才不突兀。
 *
 * ⚠️ `ROLE_MENU_MATRIX.hq_admin` 已含「施工阶段设置」，本名单是它的子集，
 *    两者由门禁 `verify-config` 交叉核对。
 */
const PAGE_ROLES = ['hq_admin'];

export default class extends Migration {
  on = 'afterLoad';

  async up(): Promise<void> {
    const app: any = (this as any).context?.app;
    const db: any = (this as any).context?.db ?? (this as any).db;
    const info = (m: string) => app?.log?.info?.(m);

    if (!db || typeof db.getRepository !== 'function') {
      throw new Error('[svc:stage-page] 无法取得 db（迁移上下文不完整），「施工阶段设置」页未建');
    }

    const routesRepo = db.getRepository('desktopRoutes');
    const modelsRepo = db.getRepository('flowModels');
    const grantsRepo = db.getRepository('rolesDesktopRoutes');

    const stats = { page: 0, route: 0, tab: 0, tabRoute: 0, root: 0, grid: 0, block: 0, grants: 0, skipped: 0, repaired: 0 };

    // ① 父分组：按 title 查，查不到就抛
    const groups = await routesRepo.find({ filter: { type: 'group', title: NAV_GROUP_TITLE } });
    const group = (groups ?? [])[0];
    if (!group) {
      throw new Error(
        `[svc:stage-page] 找不到导航分组「${NAV_GROUP_TITLE}」（desktopRoutes.type='group'）。` +
          '拒绝在未知结构上建页 —— 请先确认后台导航是否被改名或删除',
      );
    }
    const groupId = Number(group.id);

    // ② 页面（flowPage）
    //
    // 字段值逐个对齐生产同类页「服务时效」（id=392537261080576）：
    //   hideInMenu=f, enableTabs=f, enableHeader=f, displayTitle=t
    const existingPages = await routesRepo.find({ filter: { type: 'flowPage', title: PAGE_TITLE } });
    let page = (existingPages ?? [])[0];
    if (page) {
      stats.skipped += 1;
      info(`[svc:stage-page] 页面「${PAGE_TITLE}」已存在（id=${page.id}），跳过创建`);
    } else {
      // `id` 交给 ORM 的雪花字段（`desktopRoutes.id` 无 default、无 sequence，自拼会撞主键）
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
          enableTabs: false,
          enableHeader: false,
          displayTitle: true,
          // 与既有 14 个 flowPage 一致：缺它 ⇒ 从别的页点菜单切进来白屏
          // （`deactivateCurrentTab` 拿不到可挂载模型，`.mapSubModels` undefined）。
          options: { flowSurfaceMenuBindable: true },
        },
      });
      stats.page += 1;
      info(`[svc:stage-page] 已创建页面「${PAGE_TITLE}」id=${page.id} schemaUid=${pageUid}`);
    }

    const pageId = Number(page.id);
    const pageSchemaUid = String(page.schemaUid ?? '');

    // ③'' 幂等补齐 `flowSurfaceMenuBindable`（对隔离库里已建过的页也生效）
    {
      const opts = (page.options ?? {}) as Record<string, unknown>;
      if (opts.flowSurfaceMenuBindable !== true) {
        await routesRepo.update({
          filter: { id: pageId },
          values: { options: { ...opts, flowSurfaceMenuBindable: true } },
        });
        stats.repaired += 1;
        info(`[svc:stage-page] 已补齐 flowSurfaceMenuBindable（页面 id=${pageId}）`);
      } else {
        stats.skipped += 1;
      }
    }

    // -----------------------------------------------------------------------
    // ③'0 🔴 页面 schemaUid 必须有 `RouteModel` 门面行
    //
    // 与 202611251 完全同型（那边写了长注释，这里只留结论）：
    // 15 个既有 flowPage 的 schemaUid 在 `flowModels.uid` **都有一行**
    // `{"schema":{"use":"RouteModel"}}`；缺它 ⇒ 直接进 URL 正常、
    // 从别的页面点菜单切进来**白屏**（`n.mapSubModels is not a function`）。
    //
    // 这行不参与闭包树：不写 parentId、不写闭包行（生产上也没有）。
    // -----------------------------------------------------------------------
    {
      const routeModelRows = await modelsRepo.find({ filter: { uid: pageSchemaUid } });
      if ((routeModelRows ?? []).length > 0) {
        stats.skipped += 1;
        info(`[svc:stage-page] 页面门面 RouteModel 已存在（uid=${pageSchemaUid}），跳过`);
      } else {
        await modelsRepo.create({
          values: {
            uid: pageSchemaUid,
            name: pageSchemaUid,
            options: { schema: { use: 'RouteModel' } },
          },
        });
        stats.route = (stats.route ?? 0) + 1;
        info(`[svc:stage-page] 已创建页面门面 RouteModel（uid=${pageSchemaUid}）`);
      }
    }

    // -----------------------------------------------------------------------
    // ③ Tab 子路由 —— `enableTabs=false` 的单面板页面**不建**
    //
    // 本页 enableTabs=false，与生产上 8 个同类页面一致：没有 tabs 子路由，
    // 卡片/Grid 直接挂在**页面根模型**下。历史版本多建的那条同名假页签
    // 只报告、不删除（迁移不得 DELETE 既有行）。
    // -----------------------------------------------------------------------
    const existingTabs = await routesRepo.find({
      filter: { type: 'tabs', parentId: pageId, title: TAB_TITLE },
    });
    let tab = (existingTabs ?? [])[0];
    if (tab) {
      stats.skipped += 1;
      info(`[svc:stage-page] Tab「${TAB_TITLE}」已存在（id=${tab.id}），跳过`);
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
      info(`[svc:stage-page] 已创建 Tab「${TAB_TITLE}」id=${tab.id} schemaUid=${String(tab.schemaUid ?? '')}`);
    }
    /**
     * 🔴 2026-11-25 第七层修正（推翻上一轮结论）：15 个 flowPage **全部**都有
     * tabs 子路由（14 个各 1 个，我的门店工单 6 个），没有一个页面是 0 个。
     * 真实结构：flowPage.schemaUid ─RouteModel；tabs.schemaUid ─RouteModel +
     * BlockGridModel(subKey='grid') ─ 卡片(subKey='items')。
     * 浏览器实证：前端拿到页面根后按 **grid 的 uid** 发 findOne?subKey=grid，
     * 停在页面根 ⇒ 该请求不发出 ⇒ 卡片接口不调 ⇒ 正文空白。
     */
    const tabSchemaUid = String(tab?.schemaUid ?? '');
    if (!tabSchemaUid) {
      throw new Error('[svc:stage-page] Tab 缺少 schemaUid，无法建立区块宿主');
    }
    {
      const tabFacade = await modelsRepo.find({ filter: { uid: tabSchemaUid } });
      if ((tabFacade ?? []).length > 0) {
        stats.skipped += 1;
      } else {
        await modelsRepo.create({
          values: {
            uid: tabSchemaUid,
            name: tabSchemaUid,
            options: { schema: { use: 'RouteModel' } },
          },
        });
        stats.tabRoute = (stats.tabRoute ?? 0) + 1;
        info(`[svc:stage-page] 已创建 Tab 门面 RouteModel（uid=${tabSchemaUid}）`);
      }
    }

    // -----------------------------------------------------------------------
    // ③' 🔴 页面根模型（`RootPageModel`）—— 不建它，页面"能进但全空白"
    //
    // 2026-11-25 浏览器验收第二层根因。实证（隔离实例，有/无对照）：
    //   · 既有页 `flowModels:findOne?parentId=<schemaUid>&subKey=page` → **200**
    //   · 新建页 同一请求 → **204 No Content** ⇒ FlowSurface 拿不到页面根，
    //     整棵树渲染不出来：`table` 数 0、`ant-tabs-tabpane` 数 0、正文只剩菜单文字。
    //
    // 行形态（生产实测 14 个既有页无一例外）：
    //   uid = 随机 uid（**不等于** schemaUid）；name = 同 uid；
    //   options = { parentId:<页面 schemaUid>, subKey:'page', subType:'object',
    //               use:'RootPageModel',
    //               props:{ routeId, title, enableTabs, displayTitle, icon, enableHeader },
    //               stepParams:{ pageSettings:{ general:{…} } }, parent:<页面 schemaUid> }
    //
    // ⚠️ `parentId` 是页面 schemaUid（不是 desktopRoutes.id）；
    //    `props.routeId` 才是 desktopRoutes.id。两者写反都是"静默空白"。
    // -----------------------------------------------------------------------
    let rootParentUid = '';
    const existingRoots = await modelsRepo.find({
      // 同 202611251：`upsertModel` 不把 subKey 写进 options，
      // 只能用 `parentId + use` 定位本页的根模型（理由见那边的长注释）。
      filter: { 'options.parentId': String(page.schemaUid ?? ''), 'options.use': 'RootPageModel' },
    });
    if ((existingRoots ?? []).length > 0) {
      stats.skipped += 1;
      info(`[svc:stage-page] 页面根模型已存在（uid=${(existingRoots ?? [])[0]?.uid}），跳过`);
      rootParentUid = String((existingRoots ?? [])[0]?.uid ?? '');
    } else {
      const pageSchema = String(page.schemaUid ?? '');
      if (!pageSchema) {
        throw new Error('[svc:stage-page] 页面缺少 schemaUid，无法建根模型');
      }
      const rootUid = nanoid11();
      const pageProps = {
        routeId: pageId,
        title: PAGE_TITLE,
        enableTabs: false,
        displayTitle: true,
        icon: '',
        enableHeader: false,
      };
      await modelsRepo.upsertModel({
        uid: rootUid,
        name: rootUid,
        parentId: pageSchema,
        subKey: 'page',
        subType: 'object',
        use: 'RootPageModel',
        props: pageProps,
        stepParams: { pageSettings: { general: { ...pageProps } } },
        // 见 202611251：`parent` 与 `parentId` 必须同时写，否则切页白屏
        parent: pageSchema,
      });
      stats.root = (stats.root ?? 0) + 1;
      rootParentUid = rootUid;
      info(`[svc:stage-page] 已创建页面根模型 RootPageModel（uid=${rootUid}，parent=${pageSchema}，routeId=${pageId}）`);
    }

    // -----------------------------------------------------------------------
    // ④ 区块：**两层**，不是一层
    //
    // 🔴 生产实测（`scripts/prod-stage-page-probe2.sql` 的 B/D 段）：
    //    自定义卡片页面的真实结构是
    //
    //      tabs (schemaUid=wl5xn9esjj3)
    //        └─ BlockGridModel  (uid=618gfjoqvxk, options.parentId=wl5xn9esjj3, subKey='grid')
    //             └─ 卡片模型    (uid=...,        options.parentId=618gfjoqvxk, subKey='items')
    //
    //    即：Tab 直接子节点是 `BlockGridModel`，业务卡片挂在**Grid 的 uid** 下。
    //    `StoreWorkbenchModel` / `SmsCenterModel` / `PageThemeModel` 三个都在这一层。
    //
    //    ⚠️ rc.3 的档案页是**单层**（卡片直接挂 Tab），生产已验证能渲染 ——
    //       两种都能显示，但带卡片边框/标题的页面用的是两层形态。
    //       本页要的是"一张带标题的卡片"，故按两层建。
    // -----------------------------------------------------------------------
    const existingGrids = await modelsRepo.find({
      filter: { 'options.parentId': tabSchemaUid, 'options.use': 'BlockGridModel' },
    });
    let grid = (existingGrids ?? [])[0];
    if (grid) {
      stats.skipped += 1;
      info('[svc:stage-page] BlockGridModel 已存在，跳过');
      /**
       * 🔴 第九层根因（与 202611251 同型）：`subType` 必须是 **object**。
       *    生产 60 个 BlockGridModel 的 `subType` 全是 `object`；写成 `array`
       *    ⇒ 离开本页时 `subModels.grid.mapSubModels` 不是函数 ⇒ 整页白屏。
       *    就地 UPDATE，不删不重建。
       */
      if (String(grid?.options?.subType ?? '') !== 'object') {
        await modelsRepo.update({
          filter: { uid: grid.uid },
          values: { options: { ...(grid.options ?? {}), subType: 'object' } },
        });
        stats.repaired += 1;
        info(`[svc:stage-page] 已修正 BlockGridModel.subType → object（uid=${grid.uid}）`);
      }
    } else {
      if (!tabSchemaUid) {
        throw new Error('[svc:stage-page] 缺少区块宿主的父节点（Tab），无法挂载网格');
      }
      const gridUid = nanoid11();
      // ⚠️ `name` 列存的是**节点 uid 本身**，类名在 `use` 上。
      //    生产实测：`select uid, name, options->>'use'` 前两者相同。
      // ⚠️ `upsertModel` 返回的是**展开后的模型对象**（`nodesToModel`：
      //    `{ ...options, uid, subModels? }`），**不是** `{ uid }` 包装，
      //    也不是 Sequelize 实例（没有 `.get()`）。
      //    写成 `(grid as any).uid` 是唯一正确的读法。
      //    2026-11-25 实机报「BlockGridModel 缺少 uid」就是把它当实例读了 ——
      //    而离线桩返回的是带 uid 的行，又一次被桩掩盖。
      await modelsRepo.upsertModel({
        uid: gridUid,
        name: gridUid,
        parentId: tabSchemaUid,
        subKey: 'grid',
        // ⚠️ object，不是 array！生产 60/60 全是 object
        subType: 'object',
        use: 'BlockGridModel',
        props: {},
        decoratorProps: {},
        parent: tabSchemaUid,
      });
      grid = { uid: gridUid };
      stats.grid += 1;
      info(`[svc:stage-page] 已创建 BlockGridModel（uid=${gridUid}，parent=${tabSchemaUid}）`);
    }

    const existingBlocks = await modelsRepo.find({ filter: { 'options.use': BLOCK_USE } });
    if ((existingBlocks ?? []).length > 0) {
      stats.skipped += 1;
      info(`[svc:stage-page] 卡片 ${BLOCK_USE} 已存在（${existingBlocks.length} 个），跳过`);
    } else {
      const gridUid = String(grid?.uid ?? '');
      if (!gridUid) {
        throw new Error('[svc:stage-page] BlockGridModel 缺少 uid，无法挂载卡片');
      }
      const blockUid = nanoid11();
      await modelsRepo.upsertModel({
        uid: blockUid,
        name: blockUid,
        parentId: gridUid,
        subKey: 'items',
        subType: 'array',
        use: BLOCK_USE,
        props: {},
        decoratorProps: {},
        stepParams: {
          __flowSurfaceMeta: {
            // declaredKey 与播种脚本的 `svc-stage-settings-block` 保持同值
            declaredKey: 'svc-stage-settings-block',
          },
          cardSettings: { titleDescription: { title: PAGE_TITLE } },
        },
        flowRegistry: {},
      });
      stats.block += 1;
      info(`[svc:stage-page] 已创建卡片 ${BLOCK_USE}（uid=${blockUid}，parent=${gridUid}）`);
    }

    // ⑤ 角色授权：分组 + 页面 + Tab，只增不删
    //
    // 🔴 必须走原始 SQL：`rolesDesktopRoutes` 没有 id 列，
    //    `createdAt`/`updatedAt` 是 `NOT NULL` 且**无默认值**，
    //    主键是 `(desktopRouteId, roleName)`。
    //    显式写 `now()` + `ON CONFLICT DO NOTHING` 才能同时满足"能插"和"幂等"。
    //
    // 为什么三样都要授：`desktopRoutes:listAccessible` 按树裁剪，
    // 根分组没授权 ⇒ 整棵树返回 `[]`（rc.3 已吃过这个亏）。
    const sequelize = db.sequelize;
    if (!sequelize || typeof sequelize.query !== 'function') {
      throw new Error('[svc:stage-page] 无法取得 db.sequelize，角色授权无法写入');
    }

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
        const n = Number(affected ?? 0);
        if (n > 0) {
          stats.grants += 1;
          info(`[svc:stage-page] 已授权角色 ${roleName} → ${target.label}`);
        } else {
          stats.skipped += 1;
        }
      }
    }

    // -----------------------------------------------------------------------
    // ⑤' UI layout 绑定（`desktopRoutesUiLayouts`）—— 菜单能否出现的**真正闸门**
    //
    // 🔴 `desktopRoutes:listAccessible` 被 `@nocobase/plugin-ui-layout` 的
    //    preActionHandler（`addDesktopRouteLayoutFilter`）接管，实际请求带
    //    `?layout=admin-layout-model`，SQL 层加过滤 `{ "uiLayouts.uid": uid }`。
    //    ⇒ 没有 `desktopRoutesUiLayouts` 绑定的路由**在 SQL 层就被剪掉**，
    //      根本到不了后续角色裁剪。表现是：三张表全对得上、菜单就是不出现。
    //
    //    走 API 建页（`flowSurfaces:applyBlueprint`）时，
    //    plugin-ui-layout 的 `desktopRoutes:create` preActionHandler 会自动补；
    //    本迁移**直接写库**，绕过了那个钩子 ⇒ 必须自己补。
    //
    //    表结构：无 id 列、复合主键 (desktopRouteId, uiLayoutUid)、
    //    createdAt/updatedAt 为 NOT NULL 且无默认值 ⇒ 原始 SQL + now() + ON CONFLICT。
    // -----------------------------------------------------------------------
    const ADMIN_LAYOUT_UID = 'admin-layout-model';
    const layoutRows: any[] = await sequelize.query(
      `SELECT COUNT(*)::int AS n FROM "uiLayouts" WHERE uid = :uid AND enabled = true`,
      { replacements: { uid: ADMIN_LAYOUT_UID }, type: 'SELECT' as any },
    );
    const layoutCount = Number((Array.isArray(layoutRows) ? layoutRows[0] : layoutRows)?.n ?? 0);
    if (layoutCount < 1) {
      throw new Error(
        `[svc:stage-page] 找不到已启用的 uiLayout「${ADMIN_LAYOUT_UID}」。` +
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
    info(`[svc:stage-page] layout 绑定：新增 ${layoutBound} 条 → ${ADMIN_LAYOUT_UID}`);

    // ⑥ 落盘回查 —— 不信任上面的返回值，重新查一遍
    const verifyPages = await routesRepo.find({ filter: { type: 'flowPage', title: PAGE_TITLE } });
    if ((verifyPages ?? []).length !== 1) {
      throw new Error(
        `[svc:stage-page] 回查失败：页面「${PAGE_TITLE}」应有 1 条，实际 ${(verifyPages ?? []).length} 条`,
      );
    }
    const verifyTabs = await routesRepo.find({ filter: { type: 'tabs', parentId: pageId } });
    if ((verifyTabs ?? []).length < 1) {
      throw new Error('[svc:stage-page] 回查失败：页面下没有任何 Tab 子路由（前端按 tabs.schemaUid 找网格）');
    }
    /**
     * 🔴 页面门面回查 —— 缺它的表现：直接进 URL 正常，从别的页面点菜单切进来白屏
     * （`n.mapSubModels is not a function`）。只跑"打开 URL 截图"永远发现不了。
     */
    const verifyRouteModel = await modelsRepo.find({ filter: { uid: String(page.schemaUid ?? '') } });
    if ((verifyRouteModel ?? []).length !== 1) {
      throw new Error(
        `[svc:stage-page] 回查失败：页面门面 RouteModel 应有 1 条（uid=${String(page.schemaUid ?? '')}），` +
          `实际 ${(verifyRouteModel ?? []).length} 条。缺它 ⇒ 直达正常、点菜单切换白屏`,
      );
    }
    /**
     * 🔴 页面根模型回查 —— 缺 RootPageModel 的表现是"菜单有、页面全空白"，
     * 且 `flowModels:findOne?parentId=<schemaUid>&subKey=page` 回 204。
     * 把那个 204 提前到部署时暴露。
     */
    const verifyRoots = await modelsRepo.find({
      // ⚠️ 不带 `options.subKey` —— `upsertModel` 只把 subKey 写进闭包表的 `type`。
      filter: {
        'options.parentId': String(page.schemaUid ?? ''),
        'options.use': 'RootPageModel',
      },
    });
    if ((verifyRoots ?? []).length !== 1) {
      throw new Error(
        `[svc:stage-page] 回查失败：页面根模型 RootPageModel 应有 1 条（parent=${String(page.schemaUid ?? '')}），` +
          `实际 ${(verifyRoots ?? []).length} 条。缺它 ⇒ 页面能进但**全空白**（FlowSurface 拿不到页面根）`,
      );
    }
    /**
     * 🔴 网格回查 —— 盯住"卡片在库里但页面空白"。
     * 前端进页面后按 `parentId=<根模型 uid>&subKey=grid` 找 BlockGridModel，
     * 查不到就什么都不渲染。
     */
    const verifyGrids = await modelsRepo.find({
      filter: { 'options.parentId': tabSchemaUid, 'options.use': 'BlockGridModel' },
    });
    if ((verifyGrids ?? []).length !== 1) {
      throw new Error(
        `[svc:stage-page] 回查失败：Tab 下的 BlockGridModel 应有 1 条（parent=${tabSchemaUid}），` +
          `实际 ${(verifyGrids ?? []).length} 条。缺它 ⇒ 卡片挂上了但前端找不到网格、页面空白`,
      );
    }
    const verifyBlocks = await modelsRepo.find({ filter: { 'options.use': BLOCK_USE } });
    if ((verifyBlocks ?? []).length < 1) {
      throw new Error(`[svc:stage-page] 回查失败：卡片 ${BLOCK_USE} 不存在`);
    }
    /**
     * 卡片必须挂在**真实存在的父节点**下，否则 Flow Engine 挂不上，
     * 页面会"存在但空白" —— 那比不建更容易误导。
     */
    const blockParent = String((verifyBlocks ?? [])[0]?.options?.parentId ?? '');
    if (!blockParent) {
      throw new Error(`[svc:stage-page] 回查失败：卡片 ${BLOCK_USE} 缺少 options.parentId`);
    }
    const parentExists = await modelsRepo.find({ filter: { uid: blockParent } });
    if ((parentExists ?? []).length !== 1) {
      throw new Error(
        `[svc:stage-page] 回查失败：卡片父节点 ${blockParent} 在 flowModels 中不存在（Flow Engine 无法挂载）`,
      );
    }

    /**
     * 🔴 layout 绑定回查 —— **不要删**。
     * 覆盖不到的那一步就是会被漏掉的那一步：rc.3 的四张表回查全绿、
     * 菜单却不出现，漏的正是 `desktopRoutesUiLayouts`。
     * 按"逐个节点必须有绑定"断言，而不是"总数 > 0"。
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
        `[svc:stage-page] 回查失败：${unbound.length} 个节点没有绑定 uiLayout「${ADMIN_LAYOUT_UID}」` +
          `（id=${unbound.join(',')}）。缺这一步 ⇒ listAccessible 的 "uiLayouts.uid" 过滤会剪掉整棵子树`,
      );
    }

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
        `[svc:stage-page] 回查失败：授权应有 ${expectGrantRows} 条（${PAGE_ROLES.length} 角色 × ` +
          `${grantTargets.length} 节点），实际 ${actual} 条。缺失：${missing.join('，') || '（计数不符）'}`,
      );
    }
    if (!pageSchemaUid) {
      throw new Error('[svc:stage-page] 回查失败：页面 schemaUid 为空，FlowModel 树无法关联');
    }

    info(
      `[svc:stage-page] 完成：新增 页面 ${stats.page} / Tab ${stats.tab} / Grid ${stats.grid} / ` +
        `卡片 ${stats.block} / 授权 ${stats.grants}；跳过 ${stats.skipped} 项（已存在）。` +
        `页面 id=${pageId}；授权覆盖 ${PAGE_ROLES.length} 角色 × ${grantTargets.length} 节点 = ${expectGrantRows} 条`,
    );
  }
}

/**
 * 生成 11 位小写字母数字 **schemaUid** —— 与 NocoBase 自己的 uid 形态一致
 * （生产实测样例：`wl5xn9esjj3`、`dgubt2647no`、`orm5rz0ojnd`）。
 *
 * ⚠️ 只用于 `schemaUid` / `menuSchemaUid` / `flowModels.uid`，**不用于行主键 id**。
 */
function nanoid11(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
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
