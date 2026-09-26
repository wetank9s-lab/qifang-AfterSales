/**
 * 健康检查 action（全匿名，供容器探针与上线自检使用）
 *
 * 路径：GET /api/svc:health
 *   （NocoBase 自定义 action 的原生 URL 形式是 /api/<resource>:<action>，
 *     见 docs/DEVIATIONS.md DEV-10）
 *
 * 设计约束：
 *  - **不得泄露任何敏感信息**：不返回数据库连接串、不返回环境变量、不返回错误堆栈。
 *    数据库异常时只回 db:"error" + 一个稳定的错误分类码。
 *  - 供 docker healthcheck 调用，必须快：全部检查都是轻量查询。
 *  - 顶层字段保持扁平（db / sms / tasks），便于 shell 一行断言。
 */
import { ALL_COLLECTIONS, EXPECTED_TABLE_NAMES } from '../../collections';
import { DEFAULT_SETTINGS, ROLE_NATIVE_READ_RESOURCES, TASK_NAME } from '../../constants';
import { ROLE_SEEDS } from '../../seeds/roles';
import { STORE_SEEDS } from '../../seeds/stores';
import type { TaskHealthSnapshot, TaskRegistry } from '../../services/task-registry';

/** SLA 缓存所在的任务名（与定时任务同名） */
const SLA_SCAN_TASK_NAME = TASK_NAME.SLA_SCAN;

export interface HealthState {
  /** 插件 load() 是否完整走完 */
  ready: boolean;
  /** 已注册的 collection 数量 */
  registeredCollections: number;
  /** 已注册的 svc action 数量（Phase 2 起为 5：health/accept/transfer/cancel/timeline） */
  registeredSvcActions: number;
  /**
   * 已灌入内存 ACL 的业务角色数量（期望 4）。
   * 小于 4 说明"角色在库里但 ACL 无策略"——该角色名下用户会全量 403，
   * 是 Phase 2 最容易漏掉、又最难从日志里看出来的故障，所以单独记账并对外暴露。
   */
  rolesInAcl: number;
  /**
   * 已灌入内存 ACL 的「角色 × 资源授权」角色数（期望 4）。
   *
   * 与 rolesInAcl 是**两级不同的判定**，必须分开记账：
   *   rolesInAcl          —— strategy.actions（全局 action 名白名单）
   *   rolesResourcesInAcl  —— 资源级授权（逐资源放行）
   * 只灌第一级时，该角色在**每个**资源上都是
   * `403 {"errors":[{"message":"No permissions"}]}`（真机实测过），
   * 现象是"角色建好了、用户能登录，但后台每一张表都打不开"。
   */
  rolesResourcesInAcl: number;
  /**
   * **本进程** seed 时新建的角色数（只增不改，重启后为 0 属正常）。
   *
   * ⚠️ 与 settingsSeeded 同理，这只是个进程内记账，**不能**当作"角色是否在库里"的依据。
   *    对外暴露的是查库实时判定的 `rolesSeeded`（见 inspectBaselineSeeded）：
   *    基线数据可能由 install() / afterEnable() / 迁移 三条路径中的任意一条写入，
   *    拿"本进程新建数"对外报数会让探针在重启后长期显示 0 而误判"角色丢了"。
   */
  rolesSeededThisRun: number;
  /** **本进程** seed 时新建的门店数（同样只用于日志与排障） */
  storesSeededThisRun: number;
  /** 已注册的定时任务数量（Phase 1 为 0；Phase 8/9 起 > 0） */
  tasksRegistered: number;
  /**
   * **本进程内**是否执行过参数播种（install/afterEnable 置位）。
   * ⚠️ 这只是一个进程内记账标志，会随重启/热重载归零，
   *    **不能**直接当作"参数是否在库里"的依据对外暴露 ——
   *    /api/svc:health 的 settingsSeeded 字段改为查库实时判定（见 inspectSettingsSeeded）。
   */
  settingsSeeded: boolean;
  /**
   * 本次进程实际补写的集合元数据行数（0 = 稳态，无需补）。
   *
   * ⚠️ 刻意**不叫** `uiCollectionsRegistered` —— 那个名字在 payload 里指的是
   *   **实时查库**得到的"已注册集合数"（见 inspectUiCollectionMetadata）。
   *   两者同义不同源，同名会让人以为"启动时补了多少 = 现在有多少"。
   *   ⚠️ 与 settingsSeeded 同理：这是进程内记账，**不能**当作"元数据在不在"的依据。
   */
  uiCollectionsSyncedThisRun: number;
  /**
   * 本次进程实际补写的时间戳字段行数（0 = 稳态，无需补）。
   * 与 `uiCollectionsSyncedThisRun` 同一口径；对外判定用实时查库的 `uiTimestampFields`。
   */
  uiTimestampFieldsSyncedThisRun: number;
  /** 本次进程补写（补空值）的字段 `interface` 数（0 = 稳态，无需补） */
  uiFieldInterfacesRepaired: number;
  /** 插件加载完成时间（ISO） */
  loadedAt: string;
  /** 加载期捕获到的非阻塞错误信息（供排障，不含敏感数据） */
  lastError?: string;
}

/** 基线数据（门店 / 角色 / 角色策略）在库里的齐备情况 —— 全部查库实时判定 */
export interface BaselineSeeded {
  /** 门店种子是否已落库（≥2 家才算齐备：只有一家时 AT-03 恒真） */
  stores: boolean;
  /** 四个业务角色是否都在 roles 表里 */
  roles: boolean;
  /**
   * 四个角色是否都在 dataSourcesRoles 表里有 strategy 行。
   *
   * 单独记账的原因：这是唯一"roles 表有行、后台看得见角色，但该角色所有请求 403"
   * 的故障形态（RoleModel.writeToAcl 硬编码 withOutStrategy，strategy 只认这张表）。
   * 单看 roles 表会显示一切正常，所以必须单独判。
   */
  roleStrategies: boolean;
  /**
   * 四个角色是否都拿到了**资源级读取授权**（dataSourcesRolesResources 有行）。
   *
   * 为什么与 roleStrategies 分开判：
   *   这两级对应两种完全不同的故障，且**症状一模一样**（都是 403 No permissions）：
   *     · 缺 roleStrategies    → 该角色所有 action 都 403；
   *     · 缺 roleResources     → 策略有、action 名允许，但没有任何资源可访问，
   *                              于是每个资源的请求同样 403。
   *   只报一个字段时，运维看到 403 无法定位是哪一级缺的 —— 只能去翻库。
   */
  roleResources: boolean;
}

/** 依赖注入进来的运行时信息 */
export interface HealthRuntime {
  pluginVersion: string;
  /** 由插件在 load() 时写入的、可变的运行状态 */
  state: HealthState;
  /**
   * 定时任务运行状态登记处（Phase 8 / P8-A）。
   *
   * ⚠️ 可选：老测试/迁移路径可能只注入 `state`。缺省时 health 的 `tasks`
   *    退化为**旧的字符串口径**（`'ok' | 'skipped'`），而不是报错 ——
   *    探针接口**必须永远能回答"我健康吗"**，不能因为一个新字段缺失就 500。
   */
  tasks?: TaskRegistry;
  /**
   * SMS 重试积压/终态失败计数（Phase 8 / P8-B）。
   *
   * ⚠️ 设计成**回调**而不是直接注入服务，是为了让 health 保持"只读聚合"：
   *    契约 §4 要求 health **不是 Dashboard API** —— 这里只拿两个计数，
   *    拿不到就退化为 null，绝不抛错、绝不阻塞探针。
   */
  smsRetryStats?: (app: any) => Promise<SmsRetryStats | null>;
  /**
   * SLA overdue 聚合计数（Phase 8 / P8-C）。
   *
   * 🔴 本回调**只读缓存**，不跑扫描。
   *
   * 为什么不让 health 现算：
   *   health 是高频探针。现算有三个坏处 —— 浪费全表扫描、污染业务日志、
   *   以及"探针算一次 + 定时任务算一次"导致数字口径分裂。
   *   ⇒ 由**定时任务**周期性算出并缓存（`TaskRegistry.putFact`），
   *      health 读缓存；缓存为空（重启后还没到第一次 tick）就如实回 null。
   *
   * 同上：失败一律退化为 null，不阻塞探针。
   */
  slaStats?: (app: any) => Promise<SlaStats | null>;
}

/** Phase 8 / P8-B：SMS 重试可发现性（只回计数，不回内容） */
export interface SmsRetryStats {
  /** 仍处于 pending 且**已耗尽重试**（retry_count >= 上限）⇒ 终态失败、需人工介入 */
  terminalFailed: number;
  /** 仍处于 pending 且还能再重试的行数（当前积压） */
  retryPending: number;
}

/** Phase 8 / P8-C：三类 SLA overdue 的**当前事实**（只回计数） */
export interface SlaStats {
  /** 待门店受理超时（status=NEW 且 createdAt 早于 sla.accept_minutes） */
  acceptanceOverdue: number;
  /** 预计上门日期已过超时（DEV-71 日期语义 + sla.appointment_overdue_grace_minutes） */
  appointmentOverdue: number;
  /** 门店确认超时（WAIT_STORE_CONFIRM 且 submitted_at 早于 sla.store_confirm_hours） */
  storeConfirmOverdue: number;
}

/** 稳定错误分类码（不外泄原始错误文本） */
const DB_ERROR_CODES = {
  CONNECT_FAILED: 'DB_CONNECT_FAILED',
  QUERY_FAILED: 'DB_QUERY_FAILED',
} as const;

/**
 * 用 information_schema 统计本插件的表是否都已创建。
 * 表名来自代码常量（EXPECTED_TABLE_NAMES），不含任何外部输入，
 * 因此这里的 SQL 拼接是安全的（下方做了白名单二次断言）。
 */
async function inspectTables(app: any): Promise<{
  present: string[];
  missing: string[];
  errorCode?: string;
}> {
  const safeNames = EXPECTED_TABLE_NAMES.filter((n) => /^[a-z_][a-z0-9_]*$/.test(n));
  const inList = safeNames.map((n) => `'${n}'`).join(', ');

  const sql = `
    SELECT table_name AS name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN (${inList})
  `;

  try {
    const rows: Array<{ name: string }> = await app.db.sequelize.query(sql, { type: 'SELECT' });
    const present = rows.map((r) => r.name);
    return {
      present,
      missing: safeNames.filter((n) => !present.includes(n)),
    };
  } catch (err) {
    return { present: [], missing: safeNames, errorCode: DB_ERROR_CODES.QUERY_FAILED };
  }
}

/**
 * 参数种子是否已落库 —— **以数据库为准**，而不是读进程内标志。
 *
 * 为什么必须查库：`settingsSeeded` 只在 install()/afterEnable() 里被置位，语义是
 * "本进程是否执行过播种"。应用一旦重启/热重载，插件实例重建、标志归零，
 * 但参数其实好好躺在 service_settings 里 —— 此时若直接把标志回给探针，
 * 监控会长期看到 settingsSeeded=false 而误判"参数丢失"。
 * Phase 1 真机首次安装后即复现了这一点（库里 16 条，接口报 false），
 * 属于典型的观测性假阴性，因此这里按"默认键是否都在库里"如实判定。
 *
 * 判定口径：DEFAULT_SETTINGS 里的每一个 key 都能在表里查到 → true。
 * 走 NocoBase 仓库（ORM）而不是裸 SQL，避免再引一次表名/列名硬编码。
 */
async function inspectSettingsSeeded(app: any): Promise<boolean> {
  try {
    const repository = app?.db?.getRepository?.('serviceSettings');
    if (!repository || typeof repository.count !== 'function') return false;

    const keys = DEFAULT_SETTINGS.map((s) => s.key);
    if (keys.length === 0) return true;

    const found = await repository.count({ filter: { key: { $in: keys } } });
    return Number(found) === keys.length;
  } catch {
    // 表尚未 sync 完（首次安装中途）或查询异常 → 一律按"播种未完成"处理
    return false;
  }
}

/**
 * 后台数据表元数据是否已同步到 collection-manager 仓库（Phase 4-H）。
 *
 * 为什么需要一个独立探针（而不是只看 HTTP 200）：
 *   Phase 4-H 真机取证发现，本插件的 11 张表可以**接口全绿、后台全瞎**：
 *     · GET /api/serviceTickets:list → 200（运行期集合在，权限也对）
 *     · GET /api/dataSources/main/collections:list → 只有 users / roles 两行
 *   因为后台的"可选数据表"读的是 collection-manager 元数据仓库，不是运行期 db.collections。
 *   这条分叉不会产生任何报错，只能靠"逐表点名比对"发现 —— 所以这里返回 missing 清单，
 *   让运维一次看清是哪几张表没进后台。
 *
 * 与 inspectSettingsSeeded 同一口径：**查库实时判定**，不读进程内记账。
 */
async function inspectUiCollectionMetadata(app: any): Promise<{
  expected: number;
  registered: number;
  missing: string[];
}> {
  const expectedNames = EXPECTED_TABLE_NAMES.length;
  const runtimeNames = ALL_COLLECTIONS.map((c) => (c as { name: string }).name);
  const empty = { expected: expectedNames, registered: 0, missing: [...runtimeNames] };

  try {
    const repository = app?.db?.getRepository?.('collections');
    if (!repository || typeof repository.find !== 'function') return empty;

    const rows = await repository.find({
      filter: { name: { $in: runtimeNames } },
      fields: ['name'],
    });
    const registered = rows.map((r: any) => r.get('name') ?? r.name);
    return {
      expected: expectedNames,
      registered: registered.length,
      missing: runtimeNames.filter((n) => !registered.includes(n)),
    };
  } catch {
    // 仓库不可用 / 查询异常 → fail-closed，报"一张都没同步"
    return empty;
  }
}

/**
 * 自动时间戳字段（createdAt / updatedAt）的后台元数据齐备度（Phase 4-H / DEV-51）。
 *
 * 为什么单独判这一项：
 *   API 侧 `createdAt` 一直是可用的（ACL 白名单里就有它），但后台界面**选不到** ——
 *   NocoBase 会把 Sequelize 托管的时间戳从集合字段注册表里主动删除，
 *   而 db2cm 只 dump 字段注册表，于是元数据里根本没有这两行。
 *   后果是"工单列表排不出报修时间、事件时间线没有时间"，
 *   而**所有接口断言仍然全绿**（与 DEV-48 同型：测的那侧全绿、没测的那侧全瞎）。
 *
 * 判据：本插件的每张表都必须同时有 createdAt 与 updatedAt 两行元数据才算齐备。
 *   `expected` 用「表数 × 2」，所以新增一张表会自动把期望值顶上去，不需要改断言。
 */
const AUTO_TIMESTAMP_FIELD_NAMES = ['createdAt', 'updatedAt'] as const;

async function inspectUiTimestampFields(app: any): Promise<{
  expected: number;
  registered: number;
  missing: string[];
}> {
  const runtimeNames = ALL_COLLECTIONS.map((c) => (c as { name: string }).name);
  const expected = runtimeNames.length * AUTO_TIMESTAMP_FIELD_NAMES.length;
  const empty = {
    expected,
    registered: 0,
    missing: runtimeNames.flatMap((n) => AUTO_TIMESTAMP_FIELD_NAMES.map((f) => `${n}.${f}`)),
  };

  try {
    const repository = app?.db?.getRepository?.('fields');
    if (!repository || typeof repository.find !== 'function') return empty;

    const rows = await repository.find({
      filter: {
        collectionName: { $in: runtimeNames },
        name: { $in: AUTO_TIMESTAMP_FIELD_NAMES as unknown as string[] },
      },
      fields: ['collectionName', 'name'],
    });
    const have = new Set(rows.map((r: any) => `${r.get('collectionName')}::${r.get('name')}`));
    const missing = runtimeNames.flatMap((n) =>
      AUTO_TIMESTAMP_FIELD_NAMES.filter((f) => !have.has(`${n}::${f}`)).map((f) => `${n}.${f}`),
    );
    return { expected, registered: expected - missing.length, missing };
  } catch {
    // fail-closed：宁可报"看不全"，也不要在查不到时假装齐备
    return empty;
  }
}

/**
 * 字段 `interface` 的齐备度（Phase 4-H / DEV-52）。
 *
 * 为什么单独判这一项：
 *   `interface` 决定后台用哪个组件渲染这一列，以及**能不能被筛选/搜索**。
 *   本插件早期的字段助手只写了 `uiSchema.title`（只有 enumStr 写了 interface），
 *   于是元数据里 interface 为 null → flow-engine 把 `ticket_no`、`customer_mobile`
 *   这些列判为"不可用于 defaultFilter"（`defaultFilter-field-ineligible`），
 *   后台筛选区块里也选不到 —— 而**所有接口断言仍然全绿**（与 DEV-48 同型）。
 *
 * 判据：凡是代码里声明了 `interface` 的字段，元数据行里就**不能**为空。
 *   期望值是「所有集合里声明了 interface 的字段总数」，所以新增字段会自动抬高期望值。
 */
async function inspectUiFieldInterfaces(app: any): Promise<{
  expected: number;
  registered: number;
  missing: string[];
}> {
  const declared = new Map<string, string>();
  for (const collection of ALL_COLLECTIONS) {
    const c = collection as {
      name: string;
      fields?: Array<{ name?: string; interface?: string }>;
    };
    for (const field of c.fields ?? []) {
      if (field?.name && field?.interface) {
        declared.set(`${c.name}::${field.name}`, field.interface);
      }
    }
  }
  const expected = declared.size;
  const missingAll = () => [...declared.keys()].sort();

  try {
    const repository = app?.db?.getRepository?.('fields');
    if (!repository || typeof repository.find !== 'function') {
      return { expected, registered: 0, missing: missingAll() };
    }
    const collectionNames = [...new Set([...declared.keys()].map((k) => k.split('::')[0]))];
    const rows = await repository.find({
      filter: { collectionName: { $in: collectionNames } },
      fields: ['collectionName', 'name', 'interface'],
    });
    const missing: string[] = [];
    for (const row of rows) {
      const interfaceValue = row.get('interface');
      if (interfaceValue !== null && interfaceValue !== undefined && String(interfaceValue).trim() !== '') {
        continue;
      }
      const label = `${row.get('collectionName')}::${row.get('name')}`;
      if (declared.has(label)) missing.push(label);
    }
    return { expected, registered: expected - missing.length, missing };
  } catch {
    // fail-closed：查不到就报"全缺"，绝不在看不到的时候假装齐备
    return { expected, registered: 0, missing: missingAll() };
  }
}

/** 期望值取自代码常量，任何一处改动都会自动同步到这条判定上 */
const EXPECTED_STORE_CODES = STORE_SEEDS.map((s) => s.code);const EXPECTED_ROLE_NAMES = ROLE_SEEDS.map((r) => r.name);
/**
 * 门店齐备的最低及格线：**2 家**。
 * 只有一家门店时"门店用户看不到别家工单"这个断言恒真 —— 验收项 AT-03 等于没测。
 * 所以这里不是"有几家算几家"，而是"少于 2 家就不算齐备"。
 */
const MIN_STORES_FOR_ISOLATION = 2;

/**
 * 基线数据是否已落库 —— **以数据库为准**，与 inspectSettingsSeeded 同一口径。
 *
 * 为什么必须查库而不是读本进程的 seed 计数：
 *   基线数据的三条写入路径（install / afterEnable / migrations/20260920-baseline-seed）
 *   里，只有前两条会经过插件实例；已安装的实例走重启补种时**只有迁移**会跑，
 *   此时插件自己的 `*SeededThisRun` 恒为 0。若把 0 当作"没播过"对外报，
 *   运维会误判"门店/角色丢了"，而实际上它们好好躺在库里（Phase 2 真机实测如此）。
 *
 * 走 NocoBase 仓库（ORM）而不是裸 SQL，避免再引一次表名/列名硬编码。
 * 任一查询异常 → 该子项判 false（fail-closed：宁可报"不齐备"也不要假绿）。
 */
async function inspectBaselineSeeded(app: any): Promise<BaselineSeeded> {
  const result: BaselineSeeded = {
    stores: false,
    roles: false,
    roleStrategies: false,
    roleResources: false,
  };

  try {
    const storesRepository = app?.db?.getRepository?.('stores');
    const rolesRepository = app?.db?.getRepository?.('roles');
    const dsRolesRepository = app?.db?.getRepository?.('dataSourcesRoles');
    const dsResourcesRepository = app?.db?.getRepository?.('dataSourcesRolesResources');

    if (
      typeof storesRepository?.count !== 'function' ||
      typeof rolesRepository?.count !== 'function' ||
      typeof dsRolesRepository?.count !== 'function'
    ) {
      return result;
    }

    const [stores, roles, strategies] = await Promise.all([
      storesRepository.count({ filter: { code: { $in: EXPECTED_STORE_CODES } } }),
      rolesRepository.count({ filter: { name: { $in: EXPECTED_ROLE_NAMES } } }),
      dsRolesRepository.count({ filter: { roleName: { $in: EXPECTED_ROLE_NAMES } } }),
    ]);

    result.stores = Number(stores) >= MIN_STORES_FOR_ISOLATION;
    result.roles = Number(roles) === EXPECTED_ROLE_NAMES.length;
    result.roleStrategies = Number(strategies) === EXPECTED_ROLE_NAMES.length;

    // 资源级授权：必须"每个角色 × 每个资源"都有行，缺任意一条都算不齐备。
    // ⚠️ 判据是「行数 ≥ 角色数 × 资源数」而不是「≥ 1」：
    //    只有部分角色有行时，症状是"有些角色后台能打开、有些全 403"，
    //    用 ≥1 判会显示 true，恰好把最难排查的那种情况掩盖掉。
    // 老版本库（本字段引入前）这张表可能还没建 —— count 不可用即判 false，
    // 不让 health 接口因此 500（探针必须先能回答"我健康吗"）。
    if (typeof dsResourcesRepository?.count === 'function') {
      const rows = await dsResourcesRepository.count({
        filter: { roleName: { $in: EXPECTED_ROLE_NAMES } },
      });
      result.roleResources =
        Number(rows) >= EXPECTED_ROLE_NAMES.length * ROLE_NATIVE_READ_RESOURCES.length;
    }

    return result;
  } catch {
    return result;
  }
}

export function createHealthHandler(runtime: HealthRuntime) {
  return async function svcHealth(ctx: any, next: any): Promise<void> {
    const startedAt = Date.now();
    const { state } = runtime;

    // 沿用上游（nginx / 上游服务）传进来的 traceId，没有就现造一个，
    // 便于把 nginx access log 与应用日志串起来。
    const traceId = ctx.get?.('x-trace-id') || `hc-${Date.now().toString(36)}`;
    ctx.set?.('X-Trace-Id', traceId);

    // ---------------- 1. 数据库连通性 ----------------
    let dbStatus: 'ok' | 'error' = 'error';
    let dbErrorCode: string | undefined;
    try {
      await ctx.app.db.sequelize.authenticate();
      dbStatus = 'ok';
    } catch (err) {
      dbErrorCode = DB_ERROR_CODES.CONNECT_FAILED;
    }

    // ---------------- 2. 表结构 ----------------
    let tables = { present: [] as string[], missing: [] as string[] };
    if (dbStatus === 'ok') {
      const t = await inspectTables(ctx.app);
      tables = { present: t.present, missing: t.missing };
      if (t.errorCode) dbErrorCode = t.errorCode;
    }

    // ---------------- 2b. 种子数据（全部以库为准，见 inspectSettingsSeeded / inspectBaselineSeeded） ----------------
    // 只在表齐全时才查，避免首次安装中途的无谓异常
    const tablesReady = dbStatus === 'ok' && tables.missing.length === 0;
    const settingsSeeded = tablesReady ? await inspectSettingsSeeded(ctx.app) : false;
    const baselineSeeded: BaselineSeeded = tablesReady
      ? await inspectBaselineSeeded(ctx.app)
      : { stores: false, roles: false, roleStrategies: false, roleResources: false };

    // ---------------- 2c. 后台数据表元数据（Phase 4-H） ----------------
    // 与上面两条同一口径：查库实时判定。缺元数据 = 后台建不出区块，必须能被监控看见。
    const uiCollections = tablesReady
      ? await inspectUiCollectionMetadata(ctx.app)
      : { expected: EXPECTED_TABLE_NAMES.length, registered: 0, missing: [] as string[] };

    // ---------------- 2d. 后台时间戳字段元数据（Phase 4-H / DEV-51） ----------------
    const uiTimestampFields = tablesReady
      ? await inspectUiTimestampFields(ctx.app)
      : {
          expected: ALL_COLLECTIONS.length * 2,
          registered: 0,
          missing: [] as string[],
        };

    // ---------------- 2e. 后台字段 interface 齐备度（Phase 4-H / DEV-52） ----------------
    const uiFieldInterfaces = tablesReady
      ? await inspectUiFieldInterfaces(ctx.app)
      : { expected: 0, registered: 0, missing: [] as string[] };

    // ---------------- 3. 短信通道 ----------------
    // 只回通道名，不回任何密钥。mock 表示当前不会真实发短信。
    const smsProvider = String(ctx.app.env?.SMS_PROVIDER || process.env.SMS_PROVIDER || 'mock');

    // ---------------- 4. 定时任务（Phase 8 / P8-A：假字段转正） ----------------
    // ⚠️ 历史：Phase 1~7 这里是 `state.ready ? 'ok' : 'skipped'` —— 一个**假字段**，
    //    它只反映"插件 load 完了没"，**没有检查任何任务**。后果是最难排查的形态无解：
    //    "任务没跑 / 跑失败 / 跑了没命中" 从外部看一模一样。
    //
    // 现在 `tasks` 的**形状变了**（契约 §4 冻结）：从字符串变为**每个任务的运行快照**，
    // 且 `tasksOverall` 承担原来那个"一行断言"的角色（ok | skipped | attention）。
    // ⚠️ 这是一次**刻意的破坏性变更**，两条既有门禁（smoke-test / verify-plugin-load）
    //    同步改为断言 `tasksOverall`。理由：保留旧字段名但换语义会制造
    //    "断言还在过、含义已经不同"的静默欺骗，比改断言更危险。
    const tasksSnapshots: Record<string, TaskHealthSnapshot> = runtime.tasks
      ? runtime.tasks.snapshotAll()
      : {};
    const tasksAttention = runtime.tasks ? runtime.tasks.hasAttention() : false;
    const tasksOverall: 'ok' | 'skipped' | 'attention' = !state.ready
      ? 'skipped'
      : tasksAttention
        ? 'attention'
        : 'ok';

    // ---------------- 4b. SMS 重试可发现性（Phase 8 / P8-B） ----------------
    // ⚠️ 契约 §2 的出口是"**可发现**"，不接 webhook：HQ 后台/health 都能看到
    //    终态失败与积压。这里只回计数 —— 明细查询走 SmsLog 资源（已有 ACL）。
    let smsRetry: SmsRetryStats | null = null;
    if (tablesReady && typeof runtime.smsRetryStats === 'function') {
      try {
        smsRetry = await runtime.smsRetryStats(ctx.app);
      } catch {
        // 聚合失败**绝不能**让探针 500 —— 退化为 null，由上层按"未知"处理
        smsRetry = null;
      }
    }

    // ---------------- 4c. SLA overdue 聚合（Phase 8 / P8-C） ----------------
    // ⚠️ 契约 §4：health **不是 Dashboard API** —— 只回三个计数，不回工单明细。
    // 🔴 读的是**定时任务缓存的快照**，不在此处现算（理由见 HealthRuntime.slaStats 注释）。
    let sla: SlaStats | null = null;
    let slaScannedAt: string | null = null;
    if (tablesReady && runtime.tasks) {
      try {
        const cached = runtime.tasks.getFact<{
          acceptanceOverdue: number;
          appointmentOverdue: number;
          storeConfirmOverdue: number;
          scannedAt?: string;
        }>(SLA_SCAN_TASK_NAME);
        if (cached) {
          sla = {
            acceptanceOverdue: cached.value.acceptanceOverdue,
            appointmentOverdue: cached.value.appointmentOverdue,
            storeConfirmOverdue: cached.value.storeConfirmOverdue,
          };
          slaScannedAt = cached.value.scannedAt ?? cached.at;
        }
      } catch {
        sla = null;
      }
    }
    // 兼容注入式回调（测试/裁剪装配）；两条路径都不可用 ⇒ null
    if (sla === null && tablesReady && typeof runtime.slaStats === 'function') {
      try {
        sla = await runtime.slaStats(ctx.app);
      } catch {
        sla = null;
      }
    }

    const tablesOk = tables.missing.length === 0;
    // ⚠️ Phase 8：任务"有异常"**不**让整体 status 降级（仍是 ok / 200）。
    //    理由（契约 §4 + 用户对 P8-A 的明令）：**一个后台任务的失败，不该让容器探针
    //    判定"服务不健康"从而被编排系统重启** —— 那会把"任务故障"放大成"服务中断"。
    //    任务的健康是**独立信号**，由 `tasksOverall=attention` 与 `tasks.<name>` 明细表达。
    //    ⇒ 顶层 status 仍只回答"服务本身能不能服务请求"（DB / 表 / 插件就绪）。
    const status = dbStatus === 'ok' && tablesOk && state.ready ? 'ok' : 'degraded';

    const payload: Record<string, any> = {
      // —— 验收断言用得到的前三个字段（保持扁平）——
      db: dbStatus,
      sms: smsProvider,
      // ⚠️ Phase 8 起 `tasks` 从字符串变为**每任务运行快照**（契约 §4）。
      //    "一行断言"改由 `tasksOverall` 承担（ok | skipped | attention）。
      tasks: tasksSnapshots,
      // 一行断言入口：attention = 有任务运行过但最近一次不是 success（neverRan 不算）
      tasksOverall,

      // —— 排障补充信息（均非敏感）——
      status,
      plugin: '@local/service-ticket',
      version: runtime.pluginVersion,
      ready: state.ready,
      uptimeSeconds: Math.round(process.uptime()),
      tablesExpected: EXPECTED_TABLE_NAMES.length,
      tablesPresent: tables.present.length,
      missingTables: tables.missing,
      registeredCollections: state.registeredCollections,
      registeredSvcActions: state.registeredSvcActions,
      rolesInAcl: state.rolesInAcl,
      // 与 rolesInAcl 是两级判定（见 HealthState.rolesResourcesInAcl 的说明）：
      // 只有 rolesInAcl 有值而这里为 0，就是"角色建好了但后台每张表都 403"
      rolesResourcesInAcl: state.rolesResourcesInAcl,
      // —— 以下三个 Seeded 均为**查库实时判定**，与 settingsSeeded 同一口径 ——
      // 基线数据可能由 install / afterEnable / 迁移 三条路径写入，只有查库才不假阴性
      settingsSeeded,
      storesSeeded: baselineSeeded.stores,
      rolesSeeded: baselineSeeded.roles,
      // roles 有行但这里为 false = 该角色所有请求 403（strategy 只认 dataSourcesRoles）
      roleStrategiesSeeded: baselineSeeded.roleStrategies,
      // roleStrategies 为 true 而这里为 false = 策略齐了但资源级授权缺失，
      // 症状同样是每个资源 403（真机实测过，见 docs/DEVIATIONS.md DEV-23）
      roleResourcesSeeded: baselineSeeded.roleResources,
      // 进程内新建计数，仅供排障（重启后为 0 属正常，别拿它判"数据在不在"）
      rolesSeededThisRun: state.rolesSeededThisRun,
      storesSeededThisRun: state.storesSeededThisRun,
      // —— Phase 4-H：后台数据表元数据（查库实时判定）——
      // 这三个字段存在的唯一理由：**接口全绿但后台全瞎**是一种无报错的故障形态。
      // registered < expected（或 missing 非空）就意味着后台"选择数据表"里缺表。
      uiCollectionsExpected: uiCollections.expected,
      uiCollectionsRegistered: uiCollections.registered,
      missingUiCollections: uiCollections.missing,
      uiCollectionsSyncedThisRun: state.uiCollectionsSyncedThisRun,
      uiTimestampFieldsExpected: uiTimestampFields.expected,
      uiTimestampFieldsRegistered: uiTimestampFields.registered,
      missingUiTimestampFields: uiTimestampFields.missing,
      uiTimestampFieldsSyncedThisRun: state.uiTimestampFieldsSyncedThisRun,
      uiFieldInterfacesExpected: uiFieldInterfaces.expected,
      uiFieldInterfacesRegistered: uiFieldInterfaces.registered,
      missingUiFieldInterfaces: uiFieldInterfaces.missing,
      uiFieldInterfacesRepaired: state.uiFieldInterfacesRepaired,
      tasksRegistered: state.tasksRegistered,
      // —— Phase 8 / P8-B：SMS 重试可发现性（null = 聚合不可用，非 0）——
      // ⚠️ null 与 0 语义不同：0 是"确实没有失败"，null 是"这次没查到"。
      //    监控必须能区分，否则查不到会被读成"一切正常"。
      smsRetryPending: smsRetry ? smsRetry.retryPending : null,
      smsTerminalFailed: smsRetry ? smsRetry.terminalFailed : null,
      // —— Phase 8 / P8-C：三类 SLA overdue 当前事实（只回计数）——
      // ⚠️ 这三个值来自**定时任务缓存的快照**，不是本次请求现算的。
      //    缓存新鲜度见 `slaScannedAt`（null = 重启后还没跑过第一轮 ⇒ 三个计数也应为 null）。
      slaAcceptanceOverdue: sla ? sla.acceptanceOverdue : null,
      slaAppointmentOverdue: sla ? sla.appointmentOverdue : null,
      slaStoreConfirmOverdue: sla ? sla.storeConfirmOverdue : null,
      // 快照的扫描时刻（ISO）—— 让运维能判断"这个数字有多旧"，而不是盲信一个静态值
      slaScannedAt: slaScannedAt,
      loadedAt: state.loadedAt || null,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      traceId,
    };

    if (dbErrorCode) payload.dbErrorCode = dbErrorCode;
    if (state.lastError) payload.lastError = state.lastError;

    ctx.status = status === 'ok' ? 200 : 503;
    ctx.body = payload;

    // 探针调用频繁，成功时降级日志级别，避免刷满日志
    if (status === 'ok') {
      ctx.app.log.debug(`[svc:health] ok latency=${payload.latencyMs}ms trace=${traceId}`);
    } else {
      ctx.app.log.warn(
        `[svc:health] degraded status=${status} db=${dbStatus} missing=${tables.missing.join(',')} trace=${traceId}`,
      );
    }

    await next();
  };
}
