/**
 * 家电门店售后服务平台 —— 核心业务插件（服务端）
 *
 * 这是整个系统**唯一**的后端业务扩展点（开发文档 §6 / docs/PHASE-0.md 的能力矩阵）：
 * 不额外起 Node 服务、不改 NocoBase 核心代码、不引入付费插件。
 *
 * 生命周期（依据 NocoBase 2.2.x 源码 plugin-manager）：
 *   pm.load():  ① 对每个插件 await plugin.beforeLoad()
 *               ② 对每个插件 await plugin.loadCollections()  （扫描 <basePath>/server/collections 目录）
 *               ③ 对每个插件 await plugin.load()
 *               → 之后 App.load() 若带 {sync:true} 会执行 db.sync()
 *   pm.install(): 先 db.sync()，再逐个 await plugin.install()
 *
 * 因此：**在 load() 里注册的 collection，会在紧随其后的 db.sync() 阶段被建表**；
 *      需要落种子数据的逻辑放在 install()（首次安装）与 afterEnable()（后台启用插件）。
 *
 * 各阶段职责（Phase 2 起全量接线）：
 *   load()      —— ① 11 张表 ② 服务层工厂（含 GuardService）③ svc 资源与 6 个 action
 *                  ④ 匿名客户资源 publicStore / publicTicket（Phase 3）
 *                  ⑤ 匿名白名单 + 已登录白名单 ⑥ 门店隔离中间件 ⑦ 索引对账
 *   install()   —— 首次安装：参数种子 + 门店种子 + 角色种子
 *   afterEnable()—— 后台启用：同上（幂等，只增不改）
 *   afterLoad   —— 索引对账 + 角色回灌内存 ACL（见 registerIndexReconciliation）
 */
import { Plugin } from '@nocobase/server';

import { ALL_COLLECTIONS, EXPECTED_TABLE_NAMES } from './collections';
import { CREATED_AT_COLUMN, UPDATED_AT_COLUMN } from './collections/_helpers';
import {
  ANONYMOUS_ACTIONS,
  AUTHENTICATED_SVC_ACTIONS,
  NATIVE_READ_ALLOWLIST,
  PKG_NAME,
  PUBLIC_ACTION,
  PUBLIC_RESOURCE,
  ROLE_NATIVE_READ_ACTIONS,
  ROLE_NATIVE_READ_RESOURCES,
  SVC_ACTION,
  SVC_ACTION_VALUES,
  TECHNICIAN_ACTION,
  TECHNICIAN_RESOURCE,
} from './constants';
import { createHealthHandler, type HealthState } from './actions/public/health';
import { createPublicStoreHandler } from './actions/public/store';
import { createPublicTicketHandler } from './actions/public/ticket';
import { createTechnicianActionHandlers } from './actions/technician/visit';
import { createGuardQuotaHandler } from './actions/svc/guard-quota';
import { createTicketActionHandlers } from './actions/svc/ticket';
import { createDispatchActionHandlers } from './actions/svc/dispatch';
import { createVisitReviewHandlers } from './actions/svc/visit-review';
import {
  createStoreScopeMiddleware,
  NATIVE_FORBIDDEN_RESOURCE_NAMES,
  SCOPED_RESOURCE_NAMES,
} from './middleware/store-scope';
import { createServices, type Services } from './services';
import { ROLE_SEEDS, strategyOf, type RoleSeed } from './seeds/roles';
import {
  seedRoles as seedRolesRows,
  seedRoleResources as seedRoleResourcesRows,
  seedSettings as seedSettingsRows,
  seedStores as seedStoresRows,
  resolveMainDataSourceKey,
} from './seeds/apply';
import { ensureIndexes } from './ensure-indexes';

/** 与 package.json 保持一致；health 接口会回显，便于确认线上跑的是哪一版 */
const PLUGIN_VERSION = '1.0.0';

/**
 * 允许经原生接口读取的 action 白名单（NATIVE_READ_ALLOWLIST 只许出现这些）。
 *
 * ⚠️ 单一事实来源是 `constants.ts` 的 `ROLE_NATIVE_READ_ACTIONS`（DEV-65）。
 * 这里**从常量派生**，不要手抄 —— 抄写成 `list/get` 会在启动期把 `view` 判成
 * "非只读 action" 直接抛错，插件起不来（这正是 Phase 4-I 走查期踩到的坑：
 * 表格区块的前端 ACL 探针用的动作名是 `view`，缺它则整块表格被剪掉不渲染）。
 */
const NATIVE_READ_ONLY_ACTIONS = new Set(ROLE_NATIVE_READ_ACTIONS);

/**
 * 禁止出现在读取白名单里的**写** action（否命题断言）。
 *
 * 只断言"不在写名单"而不枚举"在只读名单"，是为了让新增只读动作（如 `view`）
 * 无需回头改自检；而写动作一旦混入依然是启动即失败 —— 那才是真的安全边界。
 */
const FORBIDDEN_READ_ACTIONS = new Set(['create', 'update', 'destroy', 'export', 'import', 'move', 'query']);

/**
 * 原生写 action 清单（启动期自检用）。
 *
 * 这些名字来自 resourcer 的全局 handler（NocoBase 启动时注册的通用 CRUD：
 * list/get/create/update/destroy/export/import/move/query…）。
 * Resource 构造函数会把缺失的全局 handler **补进** actions（`if (!actions[name])`），
 * 若不靠 `only` 反选，`/api/svc:update`、`/api/svc:destroy` 就会直接挂到业务资源上 ——
 * 等于给工单开了一个绕过状态机与事件时间线的后门（docs/API.md §6）。
 *
 * 之所以逐个探测而不是"断言 actions 数量等于 N"：
 *   全局 handler 的清单随 NocoBase 版本变化，数量断言会在升级时无故失败；
 *   而"某个原生写 action 可达"才是真正要拦的安全问题。
 */
const FORBIDDEN_SVC_ACTIONS = [
  'list',
  'get',
  'create',
  'update',
  'destroy',
  'export',
  'import',
  'move',
  'query',
];

/**
 * 匿名资源的形态自检配置（见 assertResourceShape）。
 *
 * `forbidden` 是"除自己声明的那一个 action 之外，全部原生的写/读入口"：
 *   · publicStore  声明 `list`  → 禁止 get/create/update/destroy/export/import/move/query
 *   · publicTicket 声明 `create` → 禁止 list/get/update/destroy/export/import/move/query
 *
 * ⚠️ 这两个资源是**匿名可达**的，所以"多挂一个 action"的后果比 svc 资源更严重：
 *    svc 上的原生 action 至少要登录（ACL loggedIn），而匿名资源一旦挂上
 *    `/api/publicTicket:update`，任何人不带 token 就能改工单 ——
 *    这正是"必须靠启动期自检而不是靠评审"的场景。
 */
/**
 * 匿名资源的**形状表**（Phase 3 起，Phase 5 扩为多 action）。
 *
 * 每一项回答三个问题：注册哪个资源、**恰好**开哪些 action、哪些必须不可达。
 * `forbidden` 不是"顺手写几个名字"，而是 `only` 白名单的唯一净效果：
 * 一旦失效，就是"公网上可以直接 list/update/destroy 数据"。
 *
 * ⚠️ 本表与 `ANONYMOUS_ACTIONS`（ACL 侧）必须同步：
 *    ACL 放行了但资源上没有该 action → 404 且白名单里明明有它（最难排）；
 *    资源上有但 ACL 没放行 → 403，现象是"接口存在却永远调不通"。
 *    `registerAnonymousResources()` 会在启动期双向自检。
 */
const ANONYMOUS_RESOURCE_SHAPES: Array<{
  resource: string;
  /** 恰好允许的 action（**数组**：Phase 5 起有资源带多个 action） */
  allowed: string[];
  /** 必须**不可达**的原生 action（回读 `Resource.getAction()` 验证） */
  forbidden: string[];
}> = [
  {
    resource: PUBLIC_RESOURCE.STORE,
    allowed: [PUBLIC_ACTION.STORE_LIST],
    forbidden: ['get', 'create', 'update', 'destroy', 'export', 'import', 'move', 'query'],
  },
  {
    resource: PUBLIC_RESOURCE.TICKET,
    allowed: [PUBLIC_ACTION.TICKET_CREATE],
    forbidden: ['list', 'get', 'update', 'destroy', 'export', 'import', 'move', 'query'],
  },
  {
    // Phase 5：师傅作业接口。三个 action 都匿名（Token 即凭证），
    // **真正的鉴权在 handler 里**（见 actions/technician/_auth.ts）。
    resource: TECHNICIAN_RESOURCE.VISIT,
    allowed: [
      TECHNICIAN_ACTION.GET,
      TECHNICIAN_ACTION.UPLOAD,
      TECHNICIAN_ACTION.SUBMIT,
      // P5-1：受控读取单张照片。**它不是"多开一个读接口"那么简单** ——
      // 照片本体在私有目录里，除了这一条通路之外没有任何 URL 能读到它，
      // 所以这个 action 的属主校验（照片属于本 token 的 Visit）是照片的
      // 最后一道门。加到本表就必须同步 `verify-plugin-load.mjs` 的匿名白名单。
      TECHNICIAN_ACTION.PHOTO,
    ],
    // ⚠️ 尤其要挡住 `list`：它一旦可达就是"匿名枚举所有 Visit"，
    //    连带把 access_token_hash 与工单关联关系一起暴露。
    forbidden: ['list', 'create', 'update', 'destroy', 'export', 'import', 'move', 'query'],
  },
];

/**
 * 把师傅 action 模块的返回值摊成 `资源:动作 → handler` 的扁平表。
 *
 * 为什么要摊平而不是像 public 那样手写两个键：
 *   师傅资源有 3 个 action，手写就等于把 action 名单**再抄一遍** ——
 *   而名字的真正来源是 `TECHNICIAN_ACTION`。抄一遍的后果是"新增一个 action 时
 *   只改了常量、忘了加注册"，或者相反。这里由 handler 模块的键驱动，名单只有一份。
 *
 * 形状表仍是权威：`registerPublicResources()` 会双向自检
 * "形状表声明的都有 handler + 有 handler 的都进了形状表"。
 */
function mapTechnicianHandlers(
  handlers: Record<string, (ctx: any, next: () => Promise<void>) => Promise<void>>,
): Record<string, (ctx: any, next: () => Promise<void>) => Promise<void>> {
  const mapped: Record<string, (ctx: any, next: () => Promise<void>) => Promise<void>> = {};
  for (const [actionName, handler] of Object.entries(handlers)) {
    mapped[`${TECHNICIAN_RESOURCE.VISIT}:${actionName}`] = handler;
  }
  return mapped;
}

/**
 * "自动时间戳"字段的后台元数据规格（Phase 4-H 新增，见 DEV-51）。
 *
 * 照抄 NocoBase 核心集合 `users` 的形状（`fields` 表里 name/type/interface/options
 * 逐项对齐），这样客户端拿到的 interface 与核心集合一致，渲染组件一定有。
 *
 * 为什么必须由我们补（根因，@nocobase/database/lib/collection.js:478）：
 *   ```js
 *   if (this.model.options.timestamps !== false) {
 *     let timestampsFields = ["createdAt", "updatedAt", "deletedAt"];
 *     if (this.underscored) timestampsFields = timestampsFields.map(snakeCase);
 *     if (timestampsFields.includes(field.columnName())) {
 *       this.fields.delete(name);   // ← 把时间戳从字段注册表里摘掉
 *       return;
 *     }
 *   }
 *   ```
 *   NocoBase 认为"时间戳归 Sequelize 托管，不该作为可选字段暴露"，于是**主动删除**。
 *   而本插件所有集合都经 defineAppCollection 开了 `underscored: true`，
 *   于是 `createdAt` / `updatedAt` 在我们的集合里**根本不出现在字段表中**。
 *
 * 为什么"声明式补上"这条路走不通：
 *   `CollectionRepository.db2cm()` 遍历的是 `collection.fields`（字段注册表，
 *   collection-repository.js:159）——而上面那段代码正是在**它之前**把字段删掉的，
 *   所以无论怎么写 collection 定义都到不了元数据。而且 db2cm 还有"存在即返回"早退，
 *   集合行写过一次就不再更新。
 *
 * 不补的后果（Phase 4-H 实测）：
 *   · 后台建区块时 `createdAt` 被校验器判为 unknown field —— 工单列表**排不出"报修时间"**；
 *   · `ticketEvents` 除 `createdAt` 外没有任何声明式时间字段 ——
 *     "事件时间线"变成**没有时间的线**，而 I 走查第 6 条恰恰要求"全过程按序可见"。
 *   注意 API 侧一直是好的（ACL 白名单里就有 createdAt），**只有后台界面看不见** ——
 *   这是"接口测试全绿、界面不可用"的又一个实例（与 DEV-48 同型）。
 */
const AUTO_TIMESTAMP_FIELD_META: Array<{
  name: string;
  type: string;
  interface: string;
  title: string;
  /** 真实 DB 列名。underscored 下 Sequelize 把 createdAt 映射到 created_at */
  column: string;
}> = [
  {
    name: 'createdAt',
    type: 'date',
    interface: 'createdAt',
    title: '{{t("Created at")}}',
    column: CREATED_AT_COLUMN,
  },
  {
    name: 'updatedAt',
    type: 'date',
    interface: 'updatedAt',
    title: '{{t("Last updated at")}}',
    column: UPDATED_AT_COLUMN,
  },
];

export class ServiceTicketPlugin extends Plugin {
  /**
   * 运行期状态。
   * 刻意做成普通对象而不是依赖 app 单例，方便 /api/svc:health 直接读取，
   * 也方便 Phase 2 起的定向测试注入假状态。
   */
  private healthState: HealthState = {
    ready: false,
    registeredCollections: 0,
    registeredSvcActions: 0,
    rolesInAcl: 0,
    rolesResourcesInAcl: 0,
    rolesSeededThisRun: 0,
    storesSeededThisRun: 0,
    tasksRegistered: 0,
    settingsSeeded: false,
    uiCollectionsSyncedThisRun: 0,
    uiTimestampFieldsSyncedThisRun: 0,
    uiFieldInterfacesRepaired: 0,
    loadedAt: '',
  };

  /**
   * 服务层实例（Config / Sequence / Event / Permission / Ticket）。
   *
   * 由 createServices() 统一构造 —— 这些服务之间有依赖
   * （TicketService 需要 EventService + SequenceService），
   * 集中一处构造才能在编译期发现"漏传依赖导致事件没写"这类静默缺陷。
   * 见 services/index.ts 顶部注释。
   */
  private services!: Services;

  /**
   * 索引对账监听器是否已挂到 app 上。
   * app.reload() 会重跑 load()，用这个标志避免重复注册（对账本身幂等，但重复注册会刷日志）。
   */
  private indexReconciliationWired = false;

  /** 门店隔离中间件是否已挂上（同上，避免热重载重复叠加） */
  private storeScopeWired = false;

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /**
   * beforeLoad：本插件当前不需要在 collection 同步之前做任何事。
   * 保留覆写是为了留出明确的位置给后续阶段的启动前置准备。
   */
  async beforeLoad(): Promise<void> {
    this.app.log.debug(`[${PKG_NAME}] beforeLoad`);
  }

  /**
   * load：注册表结构 + 服务层 + 接口 + 权限 + 隔离中间件。
   * 注意执行顺序 —— 先把表建好，再挂接口，最后开权限，任何一步抛错都会阻断启动
   * （这是刻意的：宁可启动失败，也不要带着半套表结构对外服务）。
   *
 * ⚠️ 顺序是**有依赖**的，不要重排：
 *   registerCollections   → registerServices 需要 collection 已声明
 *   registerServices      → registerSvcResource / registerStoreScope 需要 services
 *   registerSvcResource   → registerAuthenticatedActions 引用 svc 资源上的 action 名
 *   registerPublicResources → 依赖 services（频控/幂等都在 GuardService 上）
 *   registerAuthenticatedActions → 必须在 registerStoreScope 之前，
 *                          否则隔离中间件先抛 403/404，掩盖了"ACL 到底放没放行"
 */
async load(): Promise<void> {
  this.registerCollections();
  this.registerServices();
  this.registerSvcResource();
  this.registerPublicResources();
  this.registerAcl();
  this.registerAuthenticatedActions();
  this.registerStoreScope();
  this.registerRoles();
  this.registerIndexReconciliation();

    // Phase 2 尚无定时任务；Phase 8/9 接入后这里是真实数量
    this.healthState.tasksRegistered = 0;
    this.healthState.loadedAt = new Date().toISOString();
    this.healthState.ready = true;

    this.app.log.info(
      `[${PKG_NAME}] 已加载：${ALL_COLLECTIONS.length} 张表 / ` +
        `期望表名 ${EXPECTED_TABLE_NAMES.length} 个 / ` +
        `svc action ${this.healthState.registeredSvcActions} 个 / ` +
        `匿名资源 ${ANONYMOUS_RESOURCE_SHAPES.length} 个（action ${ANONYMOUS_RESOURCE_SHAPES.reduce(
          (n, s) => n + s.allowed.length,
          0,
        )} 个）/ ` +
        `角色 ${this.healthState.rolesInAcl} 个（含资源授权 ${this.healthState.rolesResourcesInAcl} 个）/ ` +
        `v${PLUGIN_VERSION}`,
    );
  }

  /** install：首次安装（容器第一次启动）时落种子数据 */
  async install(): Promise<void> {
    await this.applySeeds('install');
  }

  /** afterEnable：后台手工启用/重新启用插件时补种（不覆盖已有值） */
  async afterEnable(): Promise<void> {
    await this.applySeeds('afterEnable');

    // 后台启用插件这条路径不会触发 app 的 afterLoad（那时应用早就加载完了），
    // 但启用前 NocoBase 会先 db.sync()，所以这里同样需要做一次索引对账。
    await this.reconcileIndexes('afterEnable');
  }

  /**
   * 播种基线数据的**唯一入口**（install / afterEnable 共用）。
   *
   * 三者关系（改动时务必一起看）：
   *   · 本方法        —— install / afterEnable 路径，**分级**上报：
   *                     每部分各自 try/catch，失败只记 healthState.lastError 不抛错。
   *                     理由：这两条路径每次启动都可能再走一次（afterEnable），
   *                     参数/门店缺失属于"可修复的配置问题"，让整个应用起不来代价更大。
   *   · applyBaselineSeeds()（seeds/apply.ts）—— 同样的三步，但**全有或全无**、失败抛出。
   *                     供 migrations/20260920-baseline-seed.ts 使用（一次性迁移必须严格）。
   *   · 本方法与 applyBaselineSeeds 的**顺序必须一致**：参数 → 门店 → 角色。
   *     门店先于角色：角色只是"能力"，门店是"数据范围"的锚点；
   *     先有门店，赋权与验收（AT-03）才有对象可指。
   */
  private async applySeeds(phase: string): Promise<void> {
    const operator = `plugin:${phase}`;

    await this.seedSettings(operator);
    await this.seedStores(operator);
    await this.seedRoles(operator);
  }

  /** 播种用的公共依赖：db / app（取数据源 key）/ 日志 / 环境变量覆盖 */
  private seedDeps(operator: string) {
    return {
      db: this.db,
      app: this.app,
      logger: this.app.log,
      operator,
      env: process.env,
    };
  }

  // -------------------------------------------------------------------------
  // 内部实现：表结构与服务层
  // -------------------------------------------------------------------------

  /**
   * 注册全部 collection。
   *
   * 幂等保护：应用热重载（app.reload()）会重新走一遍 load()，
   * 若 collection 已存在则跳过，避免 "Collection already defined" 抛错。
   */
  private registerCollections(): void {
    let registered = 0;

    for (const options of ALL_COLLECTIONS) {
      const name = (options as { name: string }).name;

      if (this.hasCollection(name)) {
        this.app.log.debug(`[${PKG_NAME}] collection "${name}" 已存在，跳过注册`);
        registered += 1;
        continue;
      }

      this.db.collection(options);
      registered += 1;
    }

    this.healthState.registeredCollections = registered;
  }

  /** db 上是否存在该 collection（兼容不同版本的判定入口） */
  private hasCollection(name: string): boolean {
    const db: any = this.db;
    if (typeof db.hasCollection === 'function') {
      return !!db.hasCollection(name);
    }
    if (db.collections && typeof db.collections.has === 'function') {
      return db.collections.has(name);
    }
    // 兜底：拿不到判定方法时按"不存在"处理，交给 db.collection() 自身去报错
    return false;
  }

  /**
   * 构造服务层实例。
   *
   * onConfigWarn 挂到 healthState.lastError：参数表缺键/类型不对属于配置问题，
   * 不该让接口 500，但必须让运维能从 /api/svc:health 一眼看到"配置读崩过"。
   */
  private registerServices(): void {
    this.services = createServices(this.db, {
      logger: this.app.log,
      onConfigWarn: (message: string) => {
        this.healthState.lastError = 'CONFIG_WARN';
        this.app.log.warn(`[${PKG_NAME}] 参数读取异常：${message}`);
      },
    });

    this.app.log.debug(`[${PKG_NAME}] 服务层已就绪：config / sequences / events / permissions / tickets`);
  }

  // -------------------------------------------------------------------------
  // 内部实现：接口（action）
  // -------------------------------------------------------------------------

  /**
   * 注册 svc 资源上的全部 action。
   *
   * URL 形态（原生）：`/api/svc:<action>`，例：
   *   GET  /api/svc:health
   *   POST /api/svc:accept?filterByTk=<id>
   *   POST /api/svc:transfer?filterByTk=<id>
   *   POST /api/svc:cancel?filterByTk=<id>
   *   GET  /api/svc:timeline?filterByTk=<id>
   *   POST /api/svc:dispatch?filterByTk=<id>     （M3 首次派工，Phase 4）
   *   POST /api/svc:reassign?filterByTk=<id>     （M4 改派，Phase 4）
   *   POST /api/svc:reschedule?filterByTk=<id>   （M5 改约，Phase 4）
   *   POST /api/svc:tokenCheck                   （探针，仅 mock 短信通道可达）
   *   GET  /api/svc:smsOutbox                    （探针，仅 mock 短信通道可达）
   * 对外的斜杠形态 `/api/svc/tickets/:id/<action>` 由 nginx 内部重写过来
   * （见 nginx/conf.d/service.conf 与 docs/DEVIATIONS.md DEV-18）。
   *
   * ⚠️ 为什么 action 名是**单段**的（accept 而不是 tickets:accept）：
   *   NocoBase 的 parseRequest 对 `/api/<a>:<b>:<c>` 只做一次 split(":")
   *   （@nocobase/resourcer/lib/utils.js），第三段会被静默丢弃，
   *   随后 getAction('tickets') 抛 "action does not exist" 并落到 404。
   *   详见 constants.ts 的 SVC_ACTION 注释。
   *
   * ⚠️ 为什么要传 `only`：
   *   Resource 构造时会把 resourcer 上**所有全局 action handler**（list/create/
   *   update/destroy/export/import…）先合并进 actions，再由 `only` 反选出 except 名单。
   *   不传 only，`/api/svc:update`、`/api/svc:destroy` 这类原生 CRUD 会直接挂到 svc 资源上 ——
   *   等于给业务资源开了一个绕过状态机的后门。这里显式收敛为白名单（默认拒绝）。
   */
  private registerSvcResource(): void {
    const resourcer: any = this.app.resourcer;

    // 若同名 resource 已存在（热重载），先移除再重新定义，保证 handler 引用的是最新闭包。
    //
    // ⚠️ 这里**不能**用 resourcer.getResource('svc') 做存在性判断：
    //    NocoBase 的 ResourceManager.getResource() 在资源不存在时是 `throw new Error(...)`，
    //    而不是返回 undefined（见 @nocobase/resourcer/lib/resourcer.js）。
    //    用 `?.` 只能防方法本身为 undefined，拦不住方法**内部**抛错 ——
    //    首次安装时该异常会一路冒泡到 PluginManager.load()，导致插件加载失败、应用停在 503。
    // 正确入口是 isDefined(name)（内部就是 resources.has(name)，不抛错）。
    if (this.isResourceDefined(resourcer, 'svc') && typeof resourcer.removeResource === 'function') {
      resourcer.removeResource('svc');
    }

    const actions: Record<string, any> = {
      [SVC_ACTION.HEALTH]: createHealthHandler({
        pluginVersion: PLUGIN_VERSION,
        state: this.healthState,
      }),
      // 限流额度只读诊断：ACL 走 public，但 handler 自身校验 X-Svc-Diag-Key，
      // 密钥不对一律 404（见 actions/svc/guard-quota.ts 与 DEV-30）。
      [SVC_ACTION.GUARD_QUOTA]: createGuardQuotaHandler({
        services: this.services,
        logger: this.app.log,
      }),
    };

    const ticketHandlers = createTicketActionHandlers({
      services: this.services,
      logger: this.app.log,
    });
    // Phase 4：派工三动作 + 两个"仅 mock 通道存在"的验收探针
    const dispatchHandlers = createDispatchActionHandlers({
      services: this.services,
      logger: this.app.log,
    });
    // Phase 6 · P6-0：门店审核读模型（I11）+ 私有照片受控读取（I14）
    const visitReviewHandlers = createVisitReviewHandlers({
      services: this.services,
      logger: this.app.log,
    });
    const handlerSets: Array<Record<string, any>> = [
      ticketHandlers,
      dispatchHandlers,
      visitReviewHandlers,
    ];

    for (const actionName of AUTHENTICATED_SVC_ACTIONS) {
      const handler = handlerSets
        .map((set) => set[actionName])
        .find((candidate) => typeof candidate === 'function');
      if (typeof handler !== 'function') {
        // 宁可启动失败：少一个 handler 意味着某个业务接口会莫名 404，
        // 而不是明确报错 —— 这种"半套接口"最难排障。
        throw new Error(`[${PKG_NAME}] svc action handler 缺失：${actionName}`);
      }
      actions[actionName] = handler;
    }

    // ⚠️ 名单必须在 resourcer.define() **之前**取。
    //
    //   Resource 构造函数会就地合并 resourcer 上的全部全局 handler 到**调用方传入的
    //   actions 对象**（@nocobase/resourcer/lib/resource.js 构造函数里那句
    //   `actions[name] = handler`，是写回原对象而不是拷贝）。
    //   实测：define() 之后再 `Object.keys(actions).length` 得到 104 ——
    //   原生 CRUD 等都混了进来，拿它当"已注册 svc action 数"会让
    //   /api/svc:health 谎报接口数量（同事按它核对接口清单会直接对不上）。
    //   `only` 白名单对最终生效的 this.actions 是有效的，被污染的只是这个入参对象。
    const declaredActions = Object.keys(actions);

    resourcer.define({
      name: 'svc',
      type: 'single',
      actions,
      only: [...SVC_ACTION_VALUES],
    });

    this.healthState.registeredSvcActions = declaredActions.length;
    this.assertResourceShape(resourcer, 'svc', declaredActions, FORBIDDEN_SVC_ACTIONS);

    this.app.log.debug(
      `[${PKG_NAME}] 已注册 svc action：${declaredActions
        .map((name) => `/api/svc:${name}`)
        .join(', ')}`,
    );
  }

  /**
   * 注册**匿名客户接口**资源（Phase 3）。
   *
   * URL 形态（原生）：`/api/<resource>:<action>`
   *   GET  /api/publicStore:list      ← 对外 `GET  /api/public/stores`
   *   POST /api/publicTicket:create   ← 对外 `POST /api/public/tickets`
   * 对外路径由 nginx 重写（见 nginx/conf.d/service.conf 的 /api/public/ 段与 DEV-18）。
   *
   * ⚠️ 为什么**不能**直接用 `stores` / `tickets` 这种核心资源名：
   *    那些名字已属于 NocoBase 核心的 `stores`/`tickets` collection，
   *    define() 会整体替换掉核心资源的定义 —— 后台列表、ACL 资源级授权、
   *    storeScope 中间件的受管资源集合会同时失效，而且**不会报任何错**。
   *    这里刻意用 `publicStore` / `publicTicket` 这种"单数 + 业务名"，
   *    与 NocoBase 自身的 `public*` 命名习惯也不冲突（核心无同名资源）。
   *
   * ⚠️ action 名用 `list` / `create`（**恰好是全局 handler 名**）是安全的：
   *    NocoBase 的 Resource 构造顺序是
   *      `for (const [name, handler] of resourcer.getRegisteredHandlers()) if (!actions[name]) actions[name] = handler`
   *    （见 @nocobase/resourcer/lib/resource.js）—— 全局 handler 只**填补空缺**，
   *    define() 传入的 handler 优先。真机已核实（2.2.15）。
   *
   * `type: 'single'`：这两个资源都不带 `:id` 路径段，与 svc 一致。
   */
  private registerPublicResources(): void {
    const resourcer: any = this.app.resourcer;

    // 实现表：`${resource}:${action}` → handler。
    // Phase 5 起一个资源可以有多个 action，因此键从"资源名"细化为"资源:动作"。
    const impls: Record<string, (ctx: any, next: () => Promise<void>) => Promise<void>> = {
      [`${PUBLIC_RESOURCE.STORE}:${PUBLIC_ACTION.STORE_LIST}`]: createPublicStoreHandler({
        services: this.services,
        logger: this.app.log,
      }),
      [`${PUBLIC_RESOURCE.TICKET}:${PUBLIC_ACTION.TICKET_CREATE}`]: createPublicTicketHandler({
        services: this.services,
        logger: this.app.log,
      }),
      // Phase 5：师傅作业三动作。它们与 public* 共用同一套注册/自检路径 ——
      // 刻意**不**另开一条注册分支：两套注册逻辑迟早漂移，
      // 而漂移的表现是"某个匿名资源的多 action 之一没进 only 白名单"。
      ...mapTechnicianHandlers(
        createTechnicianActionHandlers({
          db: this.app.db,
          services: this.services,
          logger: this.app.log,
        }),
      ),
    };

    for (const shape of ANONYMOUS_RESOURCE_SHAPES) {
      const { resource, allowed, forbidden } = shape;

      // 先做**双向**一致性自检，再 define。
      //
      // ① 形状表声明的每个 action 都必须有实现 —— 少一个意味着
      //    "ACL 放行了 A、资源上只有 B"，现象是接口 404 但白名单里明明有它；
      // ② 反方向：实现表里属于本资源的 action 也必须都进 allowed ——
      //    少写一个就是"handler 写好了、但永远不会被调用"，
      //    同样不报错，只是那个接口静默 404。
      // 两种都宁可启动失败（与 registerSvcResource 同一取舍）。
      const missing = allowed.filter((a) => typeof impls[`${resource}:${a}`] !== 'function');
      if (missing.length > 0) {
        throw new Error(
          `[${PKG_NAME}] 匿名资源 ${resource} 缺少 handler：${missing.join(', ')}`,
        );
      }
      const owned = Object.keys(impls)
        .filter((k) => k.startsWith(`${resource}:`))
        .map((k) => k.slice(resource.length + 1));
      const undeclared = owned.filter((a) => !allowed.includes(a));
      if (undeclared.length > 0) {
        throw new Error(
          `[${PKG_NAME}] 匿名资源 ${resource} 的 handler 未进形状表（将永远不可达）：${undeclared.join(
            ', ',
          )}`,
        );
      }

      // 热重载（app.reload()）会重跑 load()，先摘掉同名资源再重定义，
      // 保证 handler 闭包指向最新一份 services（与 registerSvcResource 同一理由）。
      if (this.isResourceDefined(resourcer, resource) && typeof resourcer.removeResource === 'function') {
        resourcer.removeResource(resource);
      }

      const actions: Record<string, any> = {};
      for (const actionName of allowed) actions[actionName] = impls[`${resource}:${actionName}`];
      const declared = Object.keys(actions);

      resourcer.define({
        name: resource,
        type: 'single',
        actions,
        only: [...allowed],
      });

      this.assertResourceShape(resourcer, resource, declared, forbidden);
    }

    this.app.log.debug(
      `[${PKG_NAME}] 已注册匿名资源：${ANONYMOUS_RESOURCE_SHAPES.flatMap((s) =>
        s.allowed.map((a) => `/api/${s.resource}:${a}`),
      ).join(', ')}`,
    );
  }

  /**
   * 资源形态自检（启动期，跑在 define() 之后）。
   *
   * 守的是两件只有"回读资源"才能确认的事：
   *   ① 声明的 action **确实**可达 —— 少一个意味着某个业务接口会莫名 404，
   *      而不是启动时报错，属于最难排障的一类缺陷；
   *   ② `forbidden` 里的 action **确实**不可达 —— 这是 `only` 白名单唯一的净效果，
   *      一旦失效就是"任何人都能绕过状态机改工单"（svc）或
   *      "匿名可以读写任意资源"（public*），必须在启动期拦住。
   *
   * 判定手段：Resource.getAction(name) 在 name 命中 except 时抛
   *   `${name} action is not allowed`，不在 actions 里时抛 `${name} action does not exist`
   * （见 resourcer/lib/resource.js）。两者都算"不可达"，所以用 try/catch 统一收敛。
   *
   * ⚠️ 这里刻意**抛错**而不是告警：svc 是全部写操作的唯一入口，
   *    public* 是**不带任何认证**的入口，两处都没有"降级可用"这回事。
   */
  private assertResourceShape(
    resourcer: any,
    resourceName: string,
    declaredActions: string[],
    forbiddenActions: string[],
  ): void {
    if (!resourcer || typeof resourcer.getResource !== 'function') {
      return;
    }

    let resource: any;
    try {
      resource = resourcer.getResource(resourceName);
    } catch (error) {
      throw new Error(
        `[${PKG_NAME}] ${resourceName} 资源未定义成功：${(error as Error)?.message}`,
      );
    }

    // 宿主没提供 getAction（非标准 resourcer / 测试桩）时**跳过**而不是报错：
    // 这条自检是加固手段，不该因为宿主缺少一个可选入口就让应用起不来。
    // 与 isResourceDefined() 的兜底策略一致：拿不到判定手段时按"未知"处理。
    if (typeof resource?.getAction !== 'function') {
      this.app.log.warn(
        `[${PKG_NAME}] resourcer 未提供 getAction，${resourceName} 资源形态自检已跳过（仅影响启动自检）`,
      );
      return;
    }

    const reachable = (name: string): boolean => {
      try {
        resource.getAction(name);
        return true;
      } catch {
        return false;
      }
    };

    for (const name of declaredActions) {
      if (!reachable(name)) {
        throw new Error(
          `[${PKG_NAME}] ${resourceName} 资源缺少已声明的 action「${name}」：` +
            '该业务接口会返回 404 而不是启动失败，请检查 resourcer.define 的 only 白名单',
        );
      }
    }

    for (const name of forbiddenActions) {
      if (reachable(name)) {
        throw new Error(
          `[${PKG_NAME}] ${resourceName} 资源意外暴露了原生 action「${name}」：` +
            'svc 上它会绕过状态机与事件时间线（docs/API.md §6）；' +
            '匿名资源上它等于把读写入口挂到公网上。请检查 resourcer.define 的 only 白名单是否被改动',
        );
      }
    }
  }

  /**
   * resource 是否已定义 —— **不抛错**的存在性判定。
   *
   * 优先级：
   *   1) isDefined(name)  ：NocoBase 官方入口（resources.has(name)），2.2.15 已具备
   *   2) resources.has()  ：直接问内部 Map
   *   3) getResource 包 try/catch ：最老的版本兜底
   *   4) 都拿不到 → 返回 false，交给 define() 自行覆盖（define 内部是 Map.set，天然幂等）
   */
  private isResourceDefined(resourcer: any, name: string): boolean {
    if (!resourcer) return false;

    if (typeof resourcer.isDefined === 'function') {
      return !!resourcer.isDefined(name);
    }

    if (resourcer.resources && typeof resourcer.resources.has === 'function') {
      return !!resourcer.resources.has(name);
    }

    if (typeof resourcer.getResource === 'function') {
      try {
        return !!resourcer.getResource(name);
      } catch {
        return false;
      }
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // 内部实现：权限（ACL）
  // -------------------------------------------------------------------------

  /**
   * 开放**匿名**访问权限。
   *
   * NocoBase 的 ACL 语义（源码 @nocobase/acl/lib/acl.js + allow-manager.js）：
   *   acl.allow(resource, action) 等价于 skip(resource, action, 'public')，
   *   第三个参数缺省为 'public'，而 'public' 是 AllowManager 里注册的**恒真**条件。
   *   命中后 allowManager.aclMiddleware 设置 ctx.permission.skip = true，
   *   从而**完全跳过登录态与角色校验**；同时 auth 中间件的 skipCheck() 也会读到
   *   isPublic() === true 而跳过 token 校验。
   *
   * 因此这份白名单是"对外暴露面"的唯一事实来源，
   * 必须与 docs/API.md §0 严格一致（每多一条都要单独评审）。
   */
  private registerAcl(): void {
    const acl: any = (this.app as any).acl;

    if (!acl || typeof acl.allow !== 'function') {
      // 极端情况：权限插件未启用。此时绝不能"降低安全要求"继续跑，
      // 而是记录错误 —— health 接口会因此返回 tasks/ready 异常，被监控发现。
      this.healthState.lastError = 'ACL_UNAVAILABLE';
      this.app.log.error(`[${PKG_NAME}] app.acl 不可用，匿名白名单未生效，请检查 @nocobase/plugin-acl 是否启用`);
      return;
    }

    for (const [resource, action] of ANONYMOUS_ACTIONS) {
      acl.allow(resource, action);
      this.app.log.debug(`[${PKG_NAME}] 开放匿名访问：${resource}:${action}`);
    }
  }

  /**
   * 已登录白名单：svc 上的业务 action 只要求"登录"，不要求任何业务角色。
   *
   * 用 `acl.allow(resource, action, 'loggedIn')`（NocoBase 内置的 allow 条件名，
   * 定义在 @nocobase/acl/lib/allow-manager.js：`ctx => ctx.state.currentUser`）。
   * NocoBase 自己在 plugin-acl 里就是这么放行 `users:setDefaultRole` / `roles:check` 的。
   *
   * 这里的关键是理解它与 `acl.allow(resource, action)`（public）的差别：
   *
   *   public   → isPublic() === true → auth 中间件 skipCheck() 直接跳过 token 校验，
   *              ctx.state.currentUser **不会被赋值**，ACL 也整体跳过。
   *              拿它来放行业务接口 = 匿名可调，且服务层拿不到操作者。**不可接受**。
   *
   *   loggedIn → isPublic() 只对 'public' 条件返回 true（见 AllowManager.isPublic 实现），
   *              因此 auth 中间件**照常**校验 token：
   *                · 无 token → 401 EMPTY_TOKEN（"Unauthenticated. Please sign in to continue."）
   *                · 有 token → ctx.auth.check() 赋值 currentUser
   *              随后 ACL 中间件里 loggedIn 条件为真 → permission.skip = true，
   *              跳过**粗粒度角色矩阵**。
   *
   * 为什么粗粒度放行是对的：ACL 的粒度是「资源 × action」，**没有数据维度**，
   * 更不知道"这条工单属于哪个门店"。把四项写进每个角色的 strategy 只会导致
   * "加了新 action 忘了改四个角色 → 线上 403"这类同步缺陷。
   * 真正的判定由两层完成，且两层都是 fail-closed：
   *   · storeScope 中间件（框架层）—— 数据范围裁剪与原生接口拦截；
   *   · PermissionService（对象级）—— CAPABILITY 矩阵 + 门店归属 + 越权即 404。
   * 判定失败的结果是"什么也看不到"（scope=none / 403），不是"那就放开"。
   */
  private registerAuthenticatedActions(): void {
    const acl: any = (this.app as any).acl;
    if (!acl || typeof acl.allow !== 'function') return;

    for (const actionName of AUTHENTICATED_SVC_ACTIONS) {
      if (!SVC_ACTION_VALUES.includes(actionName)) {
        // 常量自相矛盾时宁可启动失败：白名单里出现了 svc 资源上不存在的 action，
        // 说明有人改了常量但没同步 —— 继续跑会得到"接口 404 但 ACL 放行"的诡异状态。
        throw new Error(`[${PKG_NAME}] AUTHENTICATED_SVC_ACTIONS 含未注册的 action：${actionName}`);
      }
      acl.allow('svc', actionName, 'loggedIn');
      this.app.log.debug(`[${PKG_NAME}] 开放已登录访问：svc:${actionName}`);
    }

    this.assertNativeReadAllowlist();
  }

  /**
   * 原生读取白名单的一致性校验（启动期自检，纯静态、不查库）。
   *
   * 守的是两类最容易出现的漂移：
   *   ① NATIVE_READ_ALLOWLIST 里混进了写 action（update/create/destroy/export/import）
   *      —— 一旦放行就能绕过状态机改数据，属于必须启动即失败的问题；
   *   ② 白名单的资源集合与 storeScope 的受管资源集合不一致
   *      —— 少了一份隔离：新加的资源漏了 storeScope，门店用户就能读到别家的数据。
   *      第 ② 类只告警不抛错（可能是有意为之的过渡期），但必须留下痕迹。
   */
  private assertNativeReadAllowlist(): void {
    for (const [resource, actions] of NATIVE_READ_ALLOWLIST) {
      for (const action of actions) {
        if (FORBIDDEN_READ_ACTIONS.has(action)) {
          throw new Error(
            `[${PKG_NAME}] NATIVE_READ_ALLOWLIST 含写 action：${resource}:${action}；` +
              '写操作必须走 /api/svc action（docs/API.md §6）',
          );
        }
      }
    }

    // 各角色的资源级授权**必须**是 NATIVE_READ_ALLOWLIST 的子集。
    // 反向漂移的后果比"漏授权"严重得多：写 action 一旦被授予某个角色，
    // 就绕过了 storeScope 的只读字段守卫（守卫只在中间件里拦，ACL 先放行才轮到它），
    // 等于给"直接改 status"开了后门。所以这里启动即失败，不留告警。
    // 注意：判据是**写名单**（否命题），不是"必须在 list/get 里"——
    // 后者会把 `view` 这类只读探针动作误杀（DEV-65）。
    for (const action of ROLE_NATIVE_READ_ACTIONS) {
      if (FORBIDDEN_READ_ACTIONS.has(action)) {
        throw new Error(
          `[${PKG_NAME}] ROLE_NATIVE_READ_ACTIONS 含写 action：${action}；` +
            '各业务角色只应被授予只读动作（view/list/get，docs/API.md §6）',
        );
      }
    }

    const unknown = ROLE_NATIVE_READ_RESOURCES.filter(
      (resource) => !NATIVE_READ_ALLOWLIST.some(([name]) => name === resource),
    );
    if (unknown.length > 0) {
      throw new Error(
        `[${PKG_NAME}] ROLE_NATIVE_READ_RESOURCES 含 NATIVE_READ_ALLOWLIST 之外的资源：` +
          unknown.join(', '),
      );
    }

    const allowed = new Set(NATIVE_READ_ALLOWLIST.map(([resource]) => resource));
    const scoped = new Set(SCOPED_RESOURCE_NAMES);
    const unscoped = [...allowed].filter((name) => !scoped.has(name));

    if (unscoped.length > 0) {
      this.healthState.lastError = 'ALLOWLIST_DRIFT';
      this.app.log.warn(
        `[${PKG_NAME}] 原生读取白名单中的资源没有门店隔离：${unscoped.join(', ')}；` +
          '请同步 middleware/store-scope.ts 的 SCOPED_RESOURCES',
      );
    }

    // ③ 同一资源不得同时出现在"允许原生读"与"整资源封禁"两张表里。
    //    二者语义相反：真出现时"哪条生效"取决于中间件与 ACL 的先后 ——
    //    是一个只在特定请求上才暴露的静默状态，因此宁可**启动即失败**。
    const forbidden = new Set(NATIVE_FORBIDDEN_RESOURCE_NAMES);
    const contradictory = [...allowed].filter((name) => forbidden.has(name));
    if (contradictory.length > 0) {
      throw new Error(
        `[${PKG_NAME}] 资源同时出现在 NATIVE_READ_ALLOWLIST 与 NATIVE_FORBIDDEN_RESOURCES：` +
          `${contradictory.join(', ')}；两张表语义相反，必须只保留一个`,
      );
    }

    // ④ 照片表**必须**被整资源封禁（docs/SECURITY.md §2.3 的硬要求）。
    //    为什么把它写成断言而不是"靠常量里那一行"：
    //      2026-09-25 P6-0 实测发现"不在白名单里"**并不等于**不可读 ——
    //      ACL 会回退到角色 strategy，门店角色照样 `GET /api/serviceVisitPhotos:list` 拿到 200
    //      并整行下发 storage_key。把"必须封"写成启动断言，
    //      任何"为了后台好看点"把它从封禁表里拿掉的改动都会立刻启动失败。
    if (!forbidden.has('serviceVisitPhotos')) {
      throw new Error(
        `[${PKG_NAME}] serviceVisitPhotos 必须出现在 middleware/store-scope.ts 的 ` +
          'NATIVE_FORBIDDEN_RESOURCES 中（该表含 storage_key，只能经 /api/svc 业务端点读取）',
      );
    }
  }

  /**
   * 挂载门店隔离中间件（框架层）。
   *
   * 位置很关键 —— 必须**在 ACL 中间件之后**：
   *   · NocoBase 在 MainDataSource.init() 里以 `{group:'acl', after:'auth'}` 挂了 ACL；
   *   · 而所有 resourcer 级中间件最终由 Action.getHandlers() 拼成
   *     `[...resourcer.getMiddlewares(), ...action.middlewares, ...preActionHandlers, handler]`，
   *     也就是说它们运行在 resourcerMiddleware 解析完 ctx.action **之后**、
   *     业务 handler **之前**（见 @nocobase/resourcer/lib/action.js）。
   *   · 用 `after:'acl'` 声明依赖，顺序就由 Toposort 保证，而不是靠注册先后碰运气。
   *
   * 放在 preActionHandlers 之前同样重要：NocoBase 的 checkQueryPermission 等
   * 前置钩子会读 params.filter，我们注入的范围条件必须先落进去。
   */
  private registerStoreScope(): void {
    if (this.storeScopeWired) return;

    const resourcer: any = this.app.resourcer;
    if (!resourcer || typeof resourcer.use !== 'function') {
      this.healthState.lastError = 'STORE_SCOPE_UNAVAILABLE';
      this.app.log.error(`[${PKG_NAME}] app.resourcer.use 不可用，门店隔离中间件未生效`);
      return;
    }

    resourcer.use(createStoreScopeMiddleware(this.db, this.services, { logger: this.app.log }), {
      group: 'store-scope',
      after: 'acl',
    });

    this.storeScopeWired = true;
    this.app.log.info(
      `[${PKG_NAME}] 门店隔离中间件已挂载（受管资源：${SCOPED_RESOURCE_NAMES.join(', ')}）`,
    );
  }

  // -------------------------------------------------------------------------
  // 内部实现：角色
  // -------------------------------------------------------------------------

  /**
   * 把四个业务角色灌进**内存 ACL**（不写库）。
   *
   * 为什么要在 load() 里做一次、在 afterLoad 里再做一次：
   *   NocoBase 载入角色的路径不止一条 —— plugin-acl 的 writeRolesToACL() 会遍历
   *   roles 表逐个 writeToAcl({withOutStrategy:true})，而 strategy 的注入在
   *   DataSourcesRolesModel.writeToAcl() 里。两条路径的先后顺序取决于插件加载顺序，
   *   出现"角色存在但 ACL 里没有 strategy"时，该角色名下的用户所有请求都是 403 ——
   *   现象是"能登录、但列表全空/全部无权限"，极难从日志看出来。
   *   所以在 load() 与 afterLoad 各兜一次：**只补空，不覆盖**已有策略。
   *
   * "只补空"的语义很重要：运营在后台调整过角色策略后，重新部署插件不应把它冲掉。
   */
  private registerRoles(): void {
    const acl: any = (this.app as any).acl;
    if (!acl || typeof acl.define !== 'function') {
      this.healthState.lastError = 'ACL_UNAVAILABLE';
      return;
    }

    let ready = 0;
    for (const seed of ROLE_SEEDS) {
      if (this.applyRoleToAcl(acl, seed)) ready += 1;
    }
    this.healthState.rolesInAcl = ready;
  }

  /** 单个角色灌内存 ACL；返回该角色在 ACL 中是否已有策略 */
  private applyRoleToAcl(acl: any, seed: RoleSeed): boolean {
    try {
      const existing = typeof acl.getRole === 'function' ? acl.getRole(seed.name) : undefined;
      // 注意：acl.define() 会**整体替换** roles Map 里的同名角色，
      // 因此已存在时绝不重新 define —— 那会抹掉运营在后台配好的资源级权限。
      const role = existing || acl.define({ role: seed.name });

      const current = typeof role.getStrategy === 'function' ? role.getStrategy() : role.strategy;
      if (current) return true;

      role.setStrategy({ ...strategyOf(seed), allowConfigure: seed.allowConfigure });
      return true;
    } catch (error) {
      this.app.log.error(
        `[${PKG_NAME}] 角色 ${seed.name} 灌入 ACL 失败：${(error as Error)?.message}`,
      );
      return false;
    }
  }

  /**
   * 角色种子落库（roles 表 + dataSourcesRoles 表）+ 回灌内存 ACL。
   *
   * 实现已收敛到 seeds/apply.ts 的 seedRoles()（三处调用共用一份代码，
   * 避免"只给其中一条路径加了 dataSourcesRoles 写入"这类漂移 →
   * 现象是某个角色全员 403）。这里只负责：分级上报 + 写库后立刻刷内存 ACL。
   *
   * 为什么写完库要显式 registerRoles()：
   *   不依赖 NocoBase 的 DB 钩子是否被触发，部署完立即生效、不必重启。
   */
  private async seedRoles(operator: string): Promise<void> {
    try {
      const counts = await seedRolesRows(this.seedDeps(operator));

      this.healthState.rolesSeededThisRun = counts.created;
      this.app.log.info(
        `[${PKG_NAME}] 角色种子（${operator}）：新建 ${counts.created} 个，` +
          `跳过（已存在）${counts.skipped} 个`,
      );
    } catch (error) {
      this.healthState.lastError = 'SEED_ROLES_FAILED';
      this.app.log.error(`[${PKG_NAME}] 写入角色种子失败：${(error as Error)?.message}`);
      return;
    }

    // 库里写完立刻回灌内存 ACL
    this.registerRoles();
    await this.registerRoleResources();
  }

  // -------------------------------------------------------------------------
  // 内部实现：资源级授权 → 内存 ACL
  // -------------------------------------------------------------------------

  /**
   * 主数据源的 key（dataSourcesRoles.dataSourceKey）。
   *
   * 薄封装，实现在 seeds/apply.ts —— 播种与回灌必须用**同一个** key，
   * 各写一份取法迟早会出现"种子写到 main、回灌去查别的键"这种静默错位。
   */
  private mainDataSourceKey(): string {
    return resolveMainDataSourceKey(this.app);
  }

  /**
   * 取**运行时真正参与判定**的 ACL 实例。
   *
   * 为什么不能只认 `app.acl`：
   *   NocoBase 的判定发生在 dataSource 的 ACL 上（plugin-data-source-manager 的
   *   `appendDataToRolesCheck` 用的是 `dataSource.acl`），而角色策略/资源授权的
   *   官方回灌入口 `DataSourcesRolesModel.writeToAcl({ acl })` 收到的也是它。
   *   在主数据源场景下两者通常是同一个对象，但这是**实现细节、不是契约** ——
   *   本插件不赌它，而是把两个实例都取出来（去重）分别回灌一次，代价可忽略。
   */
  private runtimeAcls(): any[] {
    const out: any[] = [];
    const push = (acl: any) => {
      if (acl && typeof acl.define === 'function' && !out.includes(acl)) out.push(acl);
    };

    push((this.app as any).acl);

    try {
      const manager = (this.app as any).dataSourceManager;
      const dataSources = manager?.dataSources;
      if (dataSources && typeof dataSources.get === 'function') {
        push(dataSources.get(this.mainDataSourceKey())?.acl);
      }
    } catch {
      // 数据源管理器不可用：只回灌 app.acl
    }

    return out;
  }

  /**
   * 把**资源级授权**灌入内存 ACL（原生接口 per-resource 读取权限的第二级判定）。
   *
   * 为什么这一级必须存在（一次真机事故的结论）：
   *   NocoBase 的判定链是两级，缺一不可：
   *     ① strategy.actions（dataSourcesRoles.strategy）—— 全局 action 名白名单；
   *     ② 资源级授权（dataSourcesRolesResources + ...Actions）—— 逐资源放行。
   *   只写 ① 时，任何资源都匹配不到 ② 的条目，于是**每个资源的请求都是**
   *   `403 {"errors":[{"message":"No permissions"}]}`。真机现象是：
   *   docs/API.md §6 声明「后台列表/详情读取 ✅ 允许」，而四个业务角色
   *   连自己的工单列表都打不开 —— 且因为 403 是 fail-closed，
   *   它看起来"很安全"，很容易被当成预期行为而漏掉。
   *
   * 实现方式：**复用 NocoBase 官方的回灌入口**，不自己拼 grantAction。
   *   `DataSourcesRolesModel.writeToAcl({ acl })` 会
   *     ① role.setStrategy(dataSourcesRoles.strategy)
   *     ② 查 dataSourcesRolesResources（按 roleName + dataSourceKey）
   *        逐个 role.grantAction(`${resource}:${action}`)
   *   自己拼的话，就得跟着 NocoBase 版本同步 strategy 的字段语义、
   *   资源级的 scope/fields 处理规则 —— 那是必然漂移的重复实现。
   *
   * 幂等：grantAction 是覆盖式赋值，setStrategy 写的是库里的值，重复调用无副作用。
   * 只读、不写库：库里的行由 seeds/apply.ts 的 seedRoles() 负责。
   */
  private async registerRoleResources(): Promise<void> {
    const acls = this.runtimeAcls();
    if (acls.length === 0) {
      this.app.log.warn(`[${PKG_NAME}] 取不到 ACL 实例，角色资源授权未回灌`);
      return;
    }

    const db: any = (this.app as any).db;
    let repository: any;
    try {
      repository = db?.getRepository?.('dataSourcesRoles');
    } catch {
      repository = undefined;
    }
    if (!repository) {
      // 首次安装的很早期：表还没建好。启动期的 DataSourceModel.loadIntoACL()
      // 会在数据源加载时补上，不需要在这里报错。
      this.app.log.debug(`[${PKG_NAME}] dataSourcesRoles 尚不可读，跳过资源授权回灌`);
      return;
    }

    const dataSourceKey = this.mainDataSourceKey();
    let applied = 0;

    /**
     * 资源授权行数按角色读一次 —— 这个查询存在的唯一理由是**让计数不假绿**。
     *
     * `writeToAcl()` 在 dataSourcesRolesResources 里查不到该角色的行时是
     * **静默空转**（不抛错、不日志），所以只按"调用没抛错"计数会报出一个
     * 实际上什么都没灌的 `rolesResourcesInAcl=4`。
     * 而 health 的 `roleResourcesSeeded`（查库）又能正常报 true，
     * 两个字段一起看就会得出"库里有、也灌了"的错误结论 —— 这类假绿最误事。
     *
     * 另外，本进程的 afterLoad 早于迁移执行（@nocobase/server 的 upgrade() 时序：
     * 插件 afterLoad → pm.upgrade() → migrator.afterLoad.up() → restart()），
     * 所以"补种迁移刚写完、这一轮还没灌上"这个中间态必然出现，
     * 此时 applied=0 是**正确且可诊断**的信号：库里有、内存没灌，重启即消解。
     */
    let grantsRepository: any;
    try {
      grantsRepository = db?.getRepository?.('dataSourcesRolesResources');
    } catch {
      grantsRepository = undefined;
    }

    for (const seed of ROLE_SEEDS) {
      try {
        const grants =
          typeof grantsRepository?.count === 'function'
            ? Number(
                await grantsRepository.count({
                  filter: { roleName: seed.name, dataSourceKey },
                }),
              )
            : 0;

        if (!grants) {
          this.app.log.debug(
            `[${PKG_NAME}] 角色 ${seed.name} 在 ${dataSourceKey} 上还没有资源级授权行，跳过回灌`,
          );
          continue;
        }

        const model = await repository.findOne({
          filter: { roleName: seed.name, dataSourceKey },
        });
        if (!model || typeof model.writeToAcl !== 'function') continue;

        for (const acl of acls) {
          await model.writeToAcl({ acl });
        }
        applied += 1;
      } catch (error) {
        // 单个角色失败不阻断其余角色：某个角色的资源授权缺失只影响该角色的后台可用性，
        // 而它的数据范围判定（PermissionService）不依赖 ACL，仍照常 fail-closed。
        this.app.log.warn(
          `[${PKG_NAME}] 角色 ${seed.name} 的资源授权回灌失败：${(error as Error)?.message}`,
        );
      }
    }

    this.healthState.rolesResourcesInAcl = applied;
  }

  /**
   * 写入门店种子（占位清单，待开发文档 E-03 正式清单替换，见 docs/DEVIATIONS.md DEV-21）。
   *
   * 实现见 seeds/apply.ts 的 seedStores()。语义：**按 code 只增不改** ——
   * code 会印在门店二维码上，一经使用不可变更；改名/停用请走后台，
   * 不会因为重新部署被覆盖回去。
   *
   * 失败不阻断启动（与 seedSettings 一致）：门店缺失只影响 H5 下拉与赋权，
   * 属于可修复的配置问题；让整个应用起不来代价更大。
   */
  private async seedStores(operator: string): Promise<void> {
    try {
      const counts = await seedStoresRows(this.seedDeps(operator));

      this.healthState.storesSeededThisRun = counts.created;
      this.app.log.info(
        `[${PKG_NAME}] 门店种子（${operator}）：新建 ${counts.created} 家，` +
          `跳过（已存在）${counts.skipped} 家`,
      );
    } catch (error) {
      this.healthState.lastError = 'SEED_STORES_FAILED';
      this.app.log.error(`[${PKG_NAME}] 写入门店种子失败：${(error as Error)?.message}`);
    }
  }

  /**
   * 注册索引对账（必须在 db.sync() 之后跑）。
   *
   * 为什么要挂在 app 的 `afterLoad` 事件上，而不是直接写在 load() 里：
   *   load() 只负责"声明"collection，真正建表是紧随其后的 db.sync()。
   *   application.js 的时序是
   *     emitAsync('beforeLoad') → pm.load()（= 各插件 load()）→ db.sync() → emitAsync('afterLoad')
   *   所以 afterLoad 是**唯一**既保证表已建好、又在每次启动都会触发的位置。
   *
   * 为什么不能指望 NocoBase 自己建全索引：见 ensure-indexes.ts 顶部注释（DEV-16）。
   *
   * 顺带在同一个位置回灌一次角色 ACL：此时所有插件（含 plugin-acl）都已加载完毕，
   * 是"覆写内存 ACL"最安全的时间点。
   */
  private registerIndexReconciliation(): void {
    if (this.indexReconciliationWired) return;
    this.indexReconciliationWired = true;

    const emitter: any = this.app;

    if (typeof emitter.on !== 'function') {
      // 非标准宿主（单元测试/离线桩）。索引对账是加固手段，不该因此阻断启动。
      this.app.log.warn(`[${PKG_NAME}] app.on 不可用，索引对账未注册`);
      return;
    }

    emitter.on('afterLoad', async () => {
      this.registerRoles();
      await this.repairSettings('afterLoad');
      await this.repairRoleResources('afterLoad');
      await this.registerRoleResources();
      await this.reconcileIndexes('afterLoad');
      // ⚠️ 刻意排在最后：上面四项是"业务能不能跑"的前提（角色/权限/参数/索引），
      //    而这一项只影响"后台能不能搭页面"。放在前面时，一旦它抛错就会把
      //    后面的关键自愈整条链跳过 —— 离线校验脚本正是这样把它抓出来的
      //    （verify-plugin-load 的假应用没有 collections 仓库桩）。
      //    新增的、非关键的步骤一律追加在末尾，别插队。
      await this.ensureAdminCollections('afterLoad');
    });
  }

  /**
   * 启动期**同步后台数据表元数据**（Phase 4-H 新增）。
   *
   * 解决的是什么问题：
   *   Phase 4-H 要在后台用 NocoBase 原生区块做"我的门店工单 / 全量工单 / 工单详情"，
   *   而后台的"可选数据表"来自
   *     GET /api/dataSources/main/collections:list
   *   —— 它读的是 **collection-manager 元数据仓库**（PG 的 "collections" / "fields"），
   *   不是运行期的 `db.collections`。两者在这次真机取证里是**分叉**的：
   *     · 本插件的 11 张表在运行期都在（业务接口、ACL、字段白名单全部正常）；
   *     · 元数据仓库里 **一行都没有**（只有 install 期产生的 users / roles 两行）；
   *     · 后果：后台"选择数据表"下拉里一张业务表都没有 → 区块建不出来，
   *       而**所有接口断言仍然全绿**。这正是本项目最忌讳的"接口全绿、后台全瞎"。
   *
   * 为什么不能只靠 `uiManageable`：
   *   `plugin-data-source-main` 的同步时机是
   *     afterEnablePlugin / afterInstall / afterUpgrade
   *   对一个**早已安装**的实例，前两条都不会再走；而"插件升级"不是每次启动都发生。
   *   与 repairSettings（DEV-46）完全同构的机制缺口：**新增的东西到不了旧实例**。
   *   所以这里在 afterLoad 上再兜一次，保证"只要进程起来，元数据就是齐的"。
   *
   * 为什么"每次启动写一遍"绝对安全：
   *   `CollectionRepository.db2cm()` 的第一句就是
   *     if (await this.findOne({ filter: { name: collectionName } })) return;
   *   即**存在即返回**，不更新、不覆盖。所以：
   *     · 稳态下本方法只做 N 次 findOne，新增 0 行；
   *     · 运营在后台改过的字段标题 / 界面配置**不会**被部署冲掉
   *       （与 seeds/ 的"只增不改"纪律一致）。
   *
   * 失败语义（刻意与 repairSettings 一致）：
   *   不阻断启动，但把 `uiCollectionsSyncedThisRun` 置 0 并记 lastError ——
   *   因为"后台建不出区块"是必须被人发现的故障，不能静默降级。
   */
  private async ensureAdminCollections(phase: string): Promise<void> {
    /**
     * ⚠️ `getRepository` 本身也可能**抛错**而不是返回 undefined ——
     *    宿主里没有声明 `collections` 这个 collection 时（例如离线校验用的假应用），
     *    NocoBase 的 RepositoryManager 会直接 throw。
     *    所以这里必须包一层：不然一个"锦上添花"的同步会把整条 afterLoad 链打断，
     *    连角色策略自愈都跑不到（真机上这就是"后台页面没搭好，结果连权限都没了"）。
     */
    let repository: any;
    try {
      repository = (this.db as any).getRepository?.('collections');
    } catch (error) {
      repository = undefined;
    }

    // 仓库不存在 = 宿主没有 plugin-data-source-main（例如离线校验用的假应用）。
    //
    // 为什么这里是 warn 而不是 error：这**不是本插件出了问题**，而是"宿主不提供这项能力"，
    //   而离线桩本来就属于这种情况。用 error 会把校验日志刷红，让"启动期无 error 级输出"
    //   这条运维断言失去可信度。
    // 那"真机上缺了它"怎么被发现？靠数据而不是靠日志级别：
    //   · healthState.lastError = UI_COLLECTIONS_UNAVAILABLE 会出现在 /api/svc:health
    //   · uiCollectionsSyncedThisRun 保持 0
    //   · smoke-test §4e 断言 registered === expected → 变红
    // 留痕的义务由**可断言的字段**承担，而不是由一个容易被忽略的日志级别承担。
    if (!repository || typeof repository.db2cmCollections !== 'function') {
      this.healthState.uiCollectionsSyncedThisRun = 0;
      this.healthState.lastError = 'UI_COLLECTIONS_UNAVAILABLE';
      this.app.log.warn(
        `[${PKG_NAME}] collections 仓库不可用（db2cmCollections 缺失）：` +
          '后台数据表元数据未同步，管理界面将看不到业务表',
      );
      return;
    }

    try {
      const names = ALL_COLLECTIONS.map((options) => (options as { name: string }).name);
      // db2cm 内部走 `database.getCollection(name)`，对未定义的集合会抛错而不是跳过，
      // 所以先按"运行期是否真的存在"过滤一遍。
      const present = names.filter((name) => this.hasCollection(name));

      if (present.length !== names.length) {
        const missing = names.filter((name) => !this.hasCollection(name));
        this.app.log.warn(
          `[${PKG_NAME}] 元数据同步（${phase}）：有 ${missing.length} 张表未在运行期注册，将跳过：${missing.join(', ')}`,
        );
      }

      const before = await repository.count({ filter: { name: { $in: present } } });
      await repository.db2cmCollections(present);
      const after = await repository.count({ filter: { name: { $in: present } } });

      // ⚠️ 记"本次补写的行数"而不是"现存行数" —— 后者是稳态下的 11，
      //   与"这次启动干了什么"无关，会让排障误判（见 HealthState 的注释）。
      // 用 += 而不是 = ：afterLoad 在本进程内可能执行多次（首次补完、末次补 0），
      // 覆盖式赋值会把"这次启动真的修了什么"抹成 0。
      this.healthState.uiCollectionsSyncedThisRun += Math.max(0, after - before);

      // 只有真的补了行才告警 —— 稳态下每启动一次刷一行"无事发生"会淹掉真实告警
      if (after > before) {
        this.app.log.warn(
          `[${PKG_NAME}] 后台数据表元数据自愈（${phase}）：补写 ${after - before} 张表` +
            '（已存在的表一律不覆盖。通常是本阶段新增的表在旧实例上尚无元数据行）',
        );
      }
    } catch (error) {
      this.healthState.uiCollectionsSyncedThisRun = 0;
      this.healthState.lastError = 'UI_COLLECTIONS_SYNC_FAILED';
      this.app.log.error(
        `[${PKG_NAME}] 后台数据表元数据同步（${phase}）失败：${(error as Error)?.message}`,
      );
      return;
    }

    // 集合行就位以后才能补字段行（fields.collectionName 是指向 collections.name 的外键）
    await this.ensureAutoTimestampFields(phase);
    await this.ensureFieldInterfaces(phase);
  }

  /**
   * 启动期**自愈**字段的 `interface` 元数据（Phase 4-H 新增，见 DEV-52）。
   *
   * 为什么需要：`interface` 决定后台用哪个组件渲染这一列，以及**它能不能被筛选/搜索**。
   *   而本插件早期的字段助手只写了 `uiSchema.title`，没有写 `interface`
   *   （只有 enumStr 写了）→ 元数据里 interface 为 null →
   *   flow-engine 直接把这些列判为"不可用于 defaultFilter"
   *   （`defaultFilter-field-ineligible`），后台筛选区块里也选不到它们。
   *
   * 为什么必须自愈而不能只改代码：
   *   与 DEV-46/DEV-51 同一个机制缺口 —— `db2cm()` 是**存在即返回**，
   *   集合元数据行早就写进库了，改代码不会让旧实例的元数据跟着变。
   *
   * 纪律（**只补空、绝不覆盖**）：
   *   只在当前值为 null / 空字符串时写入声明值。运营在后台手工调整过的
   *   interface（例如把某列从 input 改成 textarea）**不会**被部署冲掉。
   *   这与 repairSettings 的"按 key 只增不改"同一口径：自愈的职责是补洞，不是覆盖。
   *
   * 失败语义：同 ensureAutoTimestampFields —— 不阻断启动，记 lastError（可被断言发现）。
   */
  private async ensureFieldInterfaces(phase: string): Promise<void> {
    let repository: any;
    try {
      repository = (this.db as any).getRepository?.('fields');
    } catch {
      repository = undefined;
    }
    if (!repository || typeof repository.update !== 'function') {
      this.healthState.uiFieldInterfacesRepaired = 0;
      if (!this.healthState.lastError) {
        this.healthState.lastError = 'UI_FIELDS_REPOSITORY_UNAVAILABLE';
      }
      return;
    }

    try {
      // 1) 代码里的声明是唯一事实来源：从集合定义里读出 (表, 字段) → interface
      const declared = new Map<string, string>();
      const names: string[] = [];
      for (const collection of ALL_COLLECTIONS) {
        const c = collection as {
          name: string;
          fields?: Array<{ name?: string; interface?: string }>;
        };
        if (!this.hasCollection(c.name)) continue;
        names.push(c.name);
        for (const field of c.fields ?? []) {
          if (field?.name && field?.interface) {
            declared.set(`${c.name}::${field.name}`, field.interface);
          }
        }
      }

      // 2) 现有元数据行（一次性取回，避免 N 次往返）
      const rows: any[] = await repository.find({
        filter: { collectionName: { $in: names } },
        fields: ['key', 'collectionName', 'name', 'interface'],
      });

      // 3) 只挑"空洞"：interface 为 null / 空 且代码里确实声明了
      const repairs: Array<{ key: any; interface: string; label: string }> = [];
      for (const row of rows) {
        const current = row.get('interface');
        if (current !== null && current !== undefined && String(current).trim() !== '') continue;
        const label = `${row.get('collectionName')}::${row.get('name')}`;
        const wanted = declared.get(label);
        if (wanted) repairs.push({ key: row.get('key'), interface: wanted, label });
      }

      if (repairs.length === 0) {
        this.healthState.uiFieldInterfacesRepaired = 0;
        return;
      }

      for (const repair of repairs) {
        await repository.update({
          filterByTk: repair.key,
          values: { interface: repair.interface },
        });
      }

      this.healthState.uiFieldInterfacesRepaired += repairs.length;
      this.app.log.warn(
        `[${PKG_NAME}] 后台字段 interface 元数据自愈（${phase}）：补写 ${repairs.length} 个字段 ` +
          `（只补空值，不覆盖已有值。缺 interface 会导致这些列在后台无法被筛选）`,
      );
    } catch (error) {
      this.healthState.uiFieldInterfacesRepaired = 0;
      this.healthState.lastError = 'UI_FIELD_INTERFACES_SYNC_FAILED';
      this.app.log.error(
        `[${PKG_NAME}] 后台字段 interface 元数据自愈（${phase}）失败：${(error as Error)?.message}`,
      );
    }
  }

  /**
   * 启动期**自愈**自动时间戳字段的后台元数据（Phase 4-H 新增，见 DEV-51）。
   *
   * 为什么需要：NocoBase 会把 Sequelize 托管的 `createdAt` / `updatedAt` 从集合的
   *   字段注册表里**主动删除**（根因与完整推导见文件上方 AUTO_TIMESTAMP_FIELD_META 的注释），
   *   而 `db2cm` 只 dump 字段注册表 —— 于是这两列在后台界面里"存在但选不到"。
   *
   * 纪律（与 repairSettings / ensureAdminCollections 一致）：
   *   **按 (collectionName, name) 只增不改**。已存在的行一律跳过，
   *   运营在后台调过的字段标题、显示配置不会被部署冲掉。
   *   `fields` 集合自带 `UNIQUE(collectionName, name)` 索引（见
   *   plugin-data-source-main 的 collections/fields.js），所以就算并发启动也不会写重。
   *
   * 失败语义：与 ensureAdminCollections 同构 —— 不阻断启动，但把
   *   `uiTimestampFieldsSyncedThisRun` 置 0 并记 lastError，让"后台排不出时间列"
   *   这件事**有可断言的痕迹**，而不是静默降级。
   */
  private async ensureAutoTimestampFields(phase: string): Promise<void> {
    let repository: any;
    try {
      repository = (this.db as any).getRepository?.('fields');
    } catch {
      repository = undefined;
    }

    if (!repository || typeof repository.create !== 'function') {
      this.healthState.uiTimestampFieldsSyncedThisRun = 0;
      // 只在尚未因更严重的原因失败时记录，避免覆盖掉 collections 同步的具体错因
      if (!this.healthState.lastError) {
        this.healthState.lastError = 'UI_FIELDS_REPOSITORY_UNAVAILABLE';
      }
      this.app.log.warn(
        `[${PKG_NAME}] fields 仓库不可用：后台将选不到"报修时间/事件时间"（createdAt/updatedAt）`,
      );
      return;
    }

    try {
      const names = ALL_COLLECTIONS.map((options) => (options as { name: string }).name).filter(
        (name) => this.hasCollection(name),
      );

      // 一次把两类行的现状读回来，避免 N×2 次 findOne（11 张表 = 22 次往返）
      const existing: any[] = await repository.find({
        filter: {
          collectionName: { $in: names },
          name: { $in: AUTO_TIMESTAMP_FIELD_META.map((f) => f.name) },
        },
        fields: ['collectionName', 'name', 'sort'],
      });

      const have = new Set(existing.map((row) => `${row.get('collectionName')}::${row.get('name')}`));

      // 新行的 sort 排在该集合现有字段之后 —— 否则时间戳会插到工单号前面
      const maxSortOf = new Map<string, number>();
      for (const row of existing) {
        const key = String(row.get('collectionName'));
        maxSortOf.set(key, Math.max(maxSortOf.get(key) ?? 0, Number(row.get('sort')) || 0));
      }
      // 已有行的 sort 也要参与（上面只查了两类时间戳行），单独取一次全量 sort
      const allSorts: any[] = await repository.find({
        filter: { collectionName: { $in: names } },
        fields: ['collectionName', 'sort'],
      });
      for (const row of allSorts) {
        const key = String(row.get('collectionName'));
        maxSortOf.set(key, Math.max(maxSortOf.get(key) ?? 0, Number(row.get('sort')) || 0));
      }

      const pending: Array<Record<string, any>> = [];
      for (const collectionName of names) {
        let sort = maxSortOf.get(collectionName) ?? 0;
        for (const spec of AUTO_TIMESTAMP_FIELD_META) {
          if (have.has(`${collectionName}::${spec.name}`)) continue;
          sort += 1;
          pending.push({
            name: spec.name,
            type: spec.type,
            interface: spec.interface,
            collectionName,
            sort,
            options: {
              // 列名必须是**真实列**：underscored 下 Sequelize 把 createdAt 映射到 created_at。
              // 写成交错的大小写会让按列取数的路径（排序 / 原生 SQL）打空。
              field: spec.column,
              uiSchema: {
                type: 'datetime',
                title: spec.title,
                'x-component': 'DatePicker',
                'x-component-props': { dateFormat: 'YYYY-MM-DD' },
                'x-read-pretty': true,
              },
            },
          });
        }
      }

      if (pending.length === 0) {
        // 稳态：什么都不做、什么都不打日志（否则每次启动一行"无事发生"会淹掉真实告警）
        this.healthState.uiTimestampFieldsSyncedThisRun = 0;
        return;
      }

      await repository.create({ values: pending });

      this.healthState.uiTimestampFieldsSyncedThisRun += pending.length;
      this.app.log.warn(
        `[${PKG_NAME}] 后台时间戳字段元数据自愈（${phase}）：补写 ${pending.length} 行 ` +
          `（覆盖 ${names.length} 张表；已存在的行一律不覆盖）`,
      );
    } catch (error) {
      this.healthState.uiTimestampFieldsSyncedThisRun = 0;
      this.healthState.lastError = 'UI_TIMESTAMP_FIELDS_SYNC_FAILED';
      this.app.log.error(
        `[${PKG_NAME}] 后台时间戳字段元数据自愈（${phase}）失败：${(error as Error)?.message}`,
      );
    }
  }

  /**
   * 启动期**自愈**参数种子（Phase 4 新增）。
   *
   * 为什么需要它（真实事故，不是假想）：
   *   Phase 4 给 DEFAULT_SETTINGS 加了 `sms.enabled`（短信就绪开关）。
   *   而 `seedSettings` 只在 install() / afterEnable() 里跑 —— 对一个**早已安装**
   *   的实例，这两条路径都不会再走。结果是：
   *     · 库里永远没有 `sms.enabled` 这一行；
   *     · health 的 `settingsSeeded` 恒为 false（那个标志只在播种函数成功时才置位）；
   *     · 真机冒烟因此亮起一个与业务无关的红灯。
   *   这不是"忘了改迁移"，而是**机制缺口**：只要"新增一个参数"这件事
   *   不能自动到达旧实例，那么每一个 Phase 都会重演一次。
   *
   * 为什么是自愈而不是再写一个迁移：
   *   与 repairRoleResources 完全同构的理由（见该方法的注释）——迁移被 umzug
   *   按文件名一次性记录，**跑过就不会再跑**；而"新参数不存在于旧实例"这件事
   *   在迁移之后照样会发生（下个阶段再加一个参数就又来一次）。
   *   更关键的是**时序**：`app.load()` 触发本钩子，`pm.upgrade()` 才跑迁移
   *   （见本文件顶部时序说明），所以 afterLoad 自愈比同内容的迁移**更早生效**，
   *   迁移会退化成纯冗余。与其多一份维护点，不如只留这一处。
   *
   * 为什么"每次启动写一遍"是安全的：
   *   `seedSettings()` 的语义是**按 key 只增不改** —— 已存在的键一律跳过，
   *   运营在后台调过的值不会被部署冲掉。稳态下它只做 17 次 findOne，新增 0 行。
   *
   * 顺带修正了 `settingsSeeded` 的语义：它现在表示"参数种子已就绪"（含自愈），
   *   而不是"本次进程恰好走过 install/afterEnable"。前者是能被断言的数据事实，
   *   后者取决于进程历史 —— 用后者做验收断言正是上面那次假红灯的根因。
   *
   * 失败不阻断启动（只记 lastError 并告警）：参数缺失最坏只影响阈值默认值，
   *   而 ConfigService 对每个键都有代码侧兜底，让应用起不来代价更大。
   */
  private async repairSettings(phase: string): Promise<void> {
    try {
      const counts = await seedSettingsRows(this.seedDeps(`plugin:${phase}:repair`));

      this.healthState.settingsSeeded = true;

      // 只在确实补了东西时打日志 —— 每次启动都刷一行"无事发生"会淹没真实告警
      if (counts.created > 0) {
        this.app.log.warn(
          `[${PKG_NAME}] 参数种子自愈（${phase}）：补写 ${counts.created} 项缺失参数` +
            '（已存在的键一律不覆盖 —— 通常是本阶段新增的参数在旧实例上尚无对应行）',
        );
      }
    } catch (error) {
      this.healthState.settingsSeeded = false;
      this.healthState.lastError = 'SEED_SETTINGS_FAILED';
      this.app.log.error(`[${PKG_NAME}] 参数种子自愈（${phase}）失败：${(error as Error)?.message}`);
    }
  }

  /**
   * 启动期**自愈**资源级授权的 `fields` 取值与漂移。
   *
   * 为什么不能只靠迁移修：
   *   补种迁移（migrations/20260920-role-resource-grants.ts）由 umzug 按文件名
   *   一次性记录，**跑过就不会再跑**。而"库里存着不安全取值"这件事可以在迁移
   *   之后继续产生 —— 最典型的是运维在后台用 `roles:update` 调整过授权
   *   （该接口在 actions 里不带 fields 时会落成 `null` 或列默认值 `[]`）。
   *   实测语义：
   *     fields = null → list 整行下发，**含 feedback_token_hash / access_token_hash**
   *     fields = []   → 只回 id/createdAt/updatedAt（空壳）
   *   两者都不是可用状态，且都不会自己变好。
   *
   * **第三类：漂移**（Phase 2.1 整改项 4 新增）。
   *   非空数组但与期望白名单逐字不同 —— 真机上的实例是取证探针把 `viewer` 的
   *   `serviceTickets` 改成 7 列，而旧逻辑"非空数组不碰"，于是**测试残留被固化**。
   *   现口径：字段白名单是安全边界，由代码单一事实来源决定，漂移即对齐
   *   （理由与 DEV-19 / DEV-22 一致：不接受后台手工维护安全边界）。
   *   逃生开关 `SVC_ACL_FIELDS_AUTOFIX=0` 可关闭这一类，但 `null`/`[]` 永远纠正。
   *
   * 为什么放在 afterLoad 而不是 load：
   *   需要读 `collection.model.rawAttributes` 才能算出白名单，
   *   而模型要到 db.sync() 之后才建好 —— afterLoad 是既保证模型就绪、
   *   又每次启动都会触发的位置。
   *
   * 失败不阻断启动（只记 healthState.lastError 并告警）：
   *   自愈是加固手段。修不动时最坏结果是"维持现状"，
   *   而 registerRoleResources() 之后照常按库里的值回灌，
   *   现象与修复前一致，不会因为自愈本身把应用弄挂。
   */
  private async repairRoleResources(phase: string): Promise<void> {
    try {
      const counts = await seedRoleResourcesRows(this.seedDeps(`plugin:${phase}:repair`));

      // 只在确实补/修/对齐/清理了东西时打日志 —— 每次启动都刷一行"无事发生"会淹没真实告警
      if (counts.created > 0 || counts.repaired > 0 || (counts.orphansRemoved ?? 0) > 0) {
        const realigned = counts.realigned ?? 0;
        const orphans = counts.orphansRemoved ?? 0;
        this.app.log.warn(
          `[${PKG_NAME}] 资源级授权自愈（${phase}）：补建 ${counts.created} 条资源授权行，` +
            `修正 ${counts.repaired} 行不安全的字段白名单（null/空数组）` +
            (realigned > 0 ? `，其中 ${realigned} 行为漂移对齐（与代码期望白名单不一致）` : '') +
            (orphans > 0
              ? `；清理 ${orphans} 条无主行（roleName 为空，由 roles:update 关联替换产生，见 DEV-27）`
              : '') +
            '；分别对应"这些资源对业务角色 403"与"接口丢列、泄露 token 哈希、或权限配置漂移"三类静默缺陷',
        );
      }
    } catch (error) {
      this.healthState.lastError = 'SEED_ROLE_RESOURCES_FAILED';
      this.app.log.error(
        `[${PKG_NAME}] 资源级授权自愈（${phase}）失败：${(error as Error)?.message}`,
      );
    }
  }

  /**
   * 核对并补齐声明式索引。
   *
   * 失败时**抛错**，与 load() 里"宁可启动失败，也不要带着半套表结构对外服务"的原则一致：
   * 丢的不是普通索引 —— sms_logs.unique(provider, biz_id) 是短信回执幂等的唯一手段，
   * service_visit_photos.unique(file_id) 是"同一文件不得挂两次"的兜底。
   * 这类索引缺失属于数据完整性问题，必须让部署方在启动阶段就看到。
   */
  private async reconcileIndexes(phase: string): Promise<void> {
    const result = await ensureIndexes(this.app, this.app.log);

    if (!result.applicable) {
      return;
    }

    if (result.created > 0) {
      this.app.log.warn(
        `[${PKG_NAME}] 索引对账（${phase}）补齐了 ${result.created} 条 NocoBase 未下发的索引：` +
          result.createdDetail.join('；'),
      );
    }

    if (result.failures.length > 0) {
      this.healthState.lastError = 'ENSURE_INDEXES_FAILED';
      throw new Error(
        `[${PKG_NAME}] 索引对账（${phase}）失败 ${result.failures.length} 条：${result.failures.join('；')}`,
      );
    }
  }

  /**
   * 写入 serviceSettings 参数种子（**只属于 install / afterEnable 路径**）。
   *
   * 实现见 seeds/apply.ts 的 seedSettings()（含 .env 覆盖逻辑：
   * 同名环境变量 DEFAULT_SETTINGS[].envKey 优先于代码默认值，
   * 这样首次上线可以一次部署到位，不必进后台手工配）。
   *
   * 三条原则：
   *  1) **只增不改**：已存在的键一律跳过，运营在后台调过的值不会被安装脚本冲掉。
   *  2) 支持 .env 覆盖（见上）。
   *  3) **失败不阻断启动**：参数缺失只影响阈值默认值，不该让整个应用起不来；
   *     失败信息写进 healthState.settingsSeeded / lastError，由 /api/svc:health 暴露。
   *
   * ⚠️ 本方法**不是**参数落库的唯一路径：`repairSettings()` 会在每次启动的
   *    afterLoad 上做同一件事（幂等），那才是"新增参数能到达旧实例"的保证。
   *    这里保留它，是因为 install/afterEnable 是**首次**写入的语义位置 ——
   *    全新实例上先由这里写入，后续版本新增的键再由 self-heal 补。
   */
  private async seedSettings(operator: string): Promise<void> {
    try {
      const counts = await seedSettingsRows(this.seedDeps(operator));

      this.healthState.settingsSeeded = true;
      this.app.log.info(
        `[${PKG_NAME}] 参数种子（${operator}）：新增 ${counts.created} 项，` +
          `跳过（已存在）${counts.skipped} 项`,
      );
    } catch (error) {
      this.healthState.settingsSeeded = false;
      this.healthState.lastError = 'SEED_SETTINGS_FAILED';
      this.app.log.error(`[${PKG_NAME}] 写入参数种子失败：${(error as Error)?.message}`);
    }
  }
}

export default ServiceTicketPlugin;
