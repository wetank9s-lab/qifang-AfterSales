/**
 * 基线数据播种 —— **唯一**的种子落库实现。
 *
 * 为什么要把播种逻辑从 plugin.ts 抽出来：
 *   同一个播种动作有三条触发路径，它们必须写完全相同的数据：
 *     ① install()      —— 全新安装（容器首次启动，NocoBase 自动 install）
 *     ② afterEnable()  —— 后台手工启用/重新启用插件
 *     ③ migrations/    —— **已安装实例**的补种（见下）
 *   三条路径各写一份实现，迟早在某一次改动后漂移（比如只给其中一条加了
 *   dataSourcesRoles 的写入），而漂移的表现是"某个角色全员 403"这类极难排查的现象。
 *   因此这里把实现收敛成一份，plugin.ts 与 migration 都只做"调用 + 上报"。
 *
 * 为什么"已安装实例"必须靠 migration 而不能靠 install()/afterEnable()：
 *   NocoBase 的 PluginManager.upgrade()（每次 `nocobase start` 都会跑，日志里
 *   的 "run upgrade"）里对已安装插件**不会再调 install()**：
 *       if (!plugin.isPreset && !plugin.installed) { await plugin.install(); }
 *   所以「插件上一版就装好了、这一版才新增种子」这种情况，重启容器永远不会补种 ——
 *   现象是 /api/svc:health 里 rolesSeeded / storesSeeded 恒为 0，门店隔离验收（AT-03）
 *   因为没有门店与角色而**恒真**（测了等于没测）。migration 由 umzug 记录在
 *   `migrations` 表里，恰好满足"在旧实例上只执行一次"。
 *
 * 幂等语义：**只增不改**。
 *   已存在的行一律跳过 —— 运营在后台调过的参数值、改过的门店名、配过的角色策略
 *   都不会因为重新部署被覆盖回去。
 *
 * 失败语义：**本模块只抛错，不吞错**，由调用方决定策略：
 *   · plugin.ts 的 install()/afterEnable() 路径吞错并记 healthState.lastError
 *     （与 seedSettings 的历史约定一致：配置缺失不该让应用起不来）；
 *   · migration 路径**抛出**（一个被 umzug 记录为"已完成"的迁移如果静默失败，
 *     基线数据永远不会补上，且不会有第二次机会 —— 宁可部署失败）。
 */
import {
  DEFAULT_SETTINGS,
  aclFieldsAutofixEnabled,
  nativeReadDenyFields,
  sameFieldSet,
  type SettingSeed,
} from '../constants';
import { ROLE_SEEDS, strategyOf } from './roles';
import { STORE_SEEDS, toStoreRow } from './stores';

/** 极简日志接口：只用到这三/四个方法，避免为了类型引入 @nocobase/logger */
export interface SeedLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
}

export interface SeedCounts {
  /** 本次新建行数 */
  created: number;
  /** 已存在而跳过的行数 */
  skipped: number;
  /**
   * 把**不安全的已有行**改回可用状态的行数（当前只有资源级授权的 `fields`）。
   *
   * 单独计数而不是并进 created/skipped：
   *   它是"既有数据被改动"，与"新增/跳过"是三种不同的部署事实。
   *   混在一起会让日志出现"跳过 32 行"却看不出其中有 24 行的 fields 被改写 ——
   *   而"这次部署改了线上既有数据"恰恰是运维最需要立刻知道的。
   */
  repaired: number;
  /**
   * 其中属于第 ④ 类（"漂移对齐"）的行数 —— 即原先是非空数组、但与期望白名单不一致，
   * 被强制改回期望值的行。
   *
   * 为什么必须与 `repaired` 分开报：
   *   `null` / `[]` 是**漏洞**（前者泄露凭证、后者接口失去意义），修它们是止血；
   *   而"非空但不一致"是**配置漂移**（典型来源：测试探针残留、后台误改），
   *   修它会覆盖库里的既有取值 —— 风险与语义都不同，运维必须能区分。
   *   这也正是 Phase 2.1 整改项 4 要解决的问题：不能让测试残留永久固化。
   */
  realigned?: number;
  /**
   * 被删除的**无主（孤儿）资源授权行**数 —— `roleName` 为 NULL / 空串的行。
   *
   * 为什么这类行必须清掉，而不是"留着无害"：
   *   1) 它们永远不会被 NocoBase 的 ACL 加载（加载路径按 `roleName` 查），
   *      所以它们是纯粹的垃圾 —— 但会随每次 `roles:update` 增长（实测一次 +4 行）。
   *   2) 更要命的是它们让"重新部署后配置一致"**无法被断言**：
   *      库里同时存在"viewer 的正确 4 行"和 N 行无主垃圾时，
   *      "行数对不对"这个问题就不再可判定，验收只能退化成"至少有一条看起来是对的"。
   *
   * 成因（真机取证，2026-09-20）：`roles.resources` 在 NocoBase 里是
   *   `hasMany(dataSourcesRolesResources, sourceKey:'name', foreignKey:'roleName')`，
   *   而**替换关联**的实现是 `UPDATE ... SET roleName = NULL`（把旧行"脱钩"）
   *   再插入新行 —— 库里没有 `roleName` 的外键约束，于是旧行被永久留成无主行。
   *   触发方式：后台角色管理保存、或 `POST /api/roles:update` 带 `resources` 载荷。
   *   见 docs/DEVIATIONS.md DEV-27。
   */
  orphansRemoved?: number;
}

/** 角色种子的计数：除角色本体外，还要单独报资源级授权的增量 */
export interface RoleSeedCounts extends SeedCounts {
  /** dataSourcesRolesResources 的增量（每个角色 × 每个资源一条） */
  resources: SeedCounts;
}

export interface ApplySeedsResult {
  settings: SeedCounts;
  stores: SeedCounts;
  roles: RoleSeedCounts;
  /** strategy 实际落到的数据源 key（roles 与 dataSourcesRoles 都要用） */
  dataSourceKey: string;
}

export interface ApplySeedsDeps {
  /** NocoBase 的 db（Database 实例）。用 any 是为了让离线校验桩能传最小对象 */
  db: any;
  /** 取主数据源 key 用；缺失时回退常量 'main' */
  app?: any;
  logger?: SeedLogger;
  /** 写入 updated_by / 日志里标识触发者 */
  operator?: string;
  /** 允许用环境变量覆盖参数默认值；默认 process.env */
  env?: Record<string, string | undefined>;
}

/**
 * 主数据源的 key（dataSourcesRoles.dataSourceKey）。
 *
 * 之所以不写死 'main'：dataSources 表的 key 是数据且在后台可见，
 * 万一部署时改了 key，写死的常量会让策略静默落到一个不存在的键上（→ 该角色全员 403）。
 * 取不到时才回退到 NocoBase 的默认约定值。
 */
export function resolveMainDataSourceKey(app: any): string {
  try {
    const manager = app?.dataSourceManager;
    const dataSources = manager?.dataSources;
    if (dataSources && typeof dataSources.get === 'function') {
      const main = dataSources.get('main');
      const key = main?.options?.key ?? main?.key;
      if (key) return String(key);
    }
  } catch {
    // 忽略：回退默认值
  }
  return 'main';
}

/**
 * 写入 serviceSettings 参数种子。
 *
 * 支持 .env 覆盖：同名环境变量（SettingSeed.envKey）优先于代码默认值，
 * 这样首次上线可以一次部署到位，不必进后台手工配。
 */
export async function seedSettings(deps: ApplySeedsDeps): Promise<SeedCounts> {
  const { db, operator = 'system' } = deps;
  const env = deps.env ?? process.env;
  const repository = db.getRepository('serviceSettings');

  let created = 0;
  let skipped = 0;

  for (const seed of DEFAULT_SETTINGS as SettingSeed[]) {
    const existing = await repository.findOne({ filter: { key: seed.key } });
    if (existing) {
      skipped += 1;
      continue;
    }

    const fromEnv = seed.envKey ? env[seed.envKey] : undefined;
    const value =
      fromEnv !== undefined && fromEnv !== null && String(fromEnv).trim() !== ''
        ? String(fromEnv).trim()
        : seed.value;

    await repository.create({
      values: {
        key: seed.key,
        value,
        value_type: seed.valueType,
        description: seed.description,
        updated_by: operator,
      },
    });
    created += 1;
  }

  return { created, skipped, repaired: 0 };
}

/**
 * 写入门店种子（占位清单，待开发文档 E-03 正式清单替换，见 docs/DEVIATIONS.md DEV-21）。
 *
 * 为什么 Phase 2 就要有真实门店行：
 *   验收项 AT-03（门店隔离）必须**两家以上**门店才能证伪 ——
 *   只有一家门店时"门店用户看不到别家工单"恒真，测了等于没测。
 *
 * 语义：**按 code 只增不改**。code 会印在门店二维码上，一经使用不可变更；
 *   改名/停用请走后台，不会因为重新部署被覆盖回去。
 */
export async function seedStores(deps: ApplySeedsDeps): Promise<SeedCounts> {
  const { db } = deps;
  const repository = db.getRepository('stores');

  let created = 0;
  let skipped = 0;

  for (const seed of STORE_SEEDS) {
    const existing = await repository.findOne({ filter: { code: seed.code } });
    if (existing) {
      skipped += 1;
      continue;
    }

    await repository.create({ values: toStoreRow(seed) });
    created += 1;
  }

  return { created, skipped, repaired: 0 };
}

/**
 * 取 collection 的属性名清单（= ACL `fields` 白名单要比对的字符串）。
 *
 * ⚠️ 只用 `collection.model.rawAttributes`，**不用** `collection.getFields()`。
 *    这是真机取证（.probe/fieldname-sources.cjs，2026-09-20）的直接结论：
 *
 *      · `getFields()` 返回的是**数组**（@nocobase/database/lib/collection.js:
 *        `getFields() { return [...this.fields.values()]; }`），
 *        元素是字段实例。用 `Object.keys()` 取名字会得到 ["0","1",…,"32"]
 *        ——一串数字索引，写成白名单后接口会静默丢列。这个坑之所以危险，
 *        是因为它不报错：`fields: ["0",…]` 与 `fields: []` 都表现为"业务列不见了"。
 *
 *      · 即使正确取到 `.name`，getFields() 给的也是**关联名**（store / handler /
 *        feedback_visit）而**不含外键列**（store_id / handler_user_id /
 *        feedback_visit_id）、也不含 id / createdAt / updatedAt。
 *        拿它当白名单，list 就会丢掉 store_id —— 而门店隔离（AT-03）正是
 *        靠 store_id 断言的，等于把验收做瞎。
 *
 *      · `rawAttributes` 是 Sequelize 的权威属性表，键就是属性名，
 *        与 ACL 匹配的字符串完全一致（NocoBase 自己的 beforeGrantAction
 *        判断 createdAt/updatedAt 用的也是这个入口）。
 *
 *    返回 null 表示"取不到"，由调用方抛错 —— 绝不退化成"不限制字段"。
 */
function columnNamesOf(collection: any): string[] | null {
  const raw = collection?.model?.rawAttributes;
  if (raw && typeof raw === 'object') {
    const keys = Object.keys(raw);
    if (keys.length > 0) return keys;
  }
  return null;
}

/**
 * 取某资源在原生只读接口上允许下发的字段清单。
 *
 * 语义（真机三态实测，见 seedRoleResources 的注释）：
 *   NocoBase 的 action 授权带一个 `fields` 数组，**数组 = 白名单**（并强制补
 *   id/createdAt/updatedAt），**null = 不做字段级过滤（整行下发）**，
 *   **[] = 只给 id/createdAt/updatedAt**。我们要的是"整列减去敏感列"，所以显式枚举。
 *
 * 枚举不出来时**抛错**、不退化成 null：
 *   null 的语义是"整行下发"，会静默把 feedback_token_hash / access_token_hash
 *   一起发出去 —— 一个安全回归绝不该以"变量取不到"的方式悄悄发生。
 *   抛错会让播种失败（install 路径记 healthState.lastError，迁移路径直接失败），
 *   两种都是"看得见"的失败。
 */
export function nativeReadFieldsOf(db: any, resource: string): string[] {
  const collection = db?.getCollection?.(resource);
  const names = columnNamesOf(collection);

  if (!names || names.length === 0) {
    throw new Error(
      `[seeds] 取不到 ${resource} 的字段目录（collection.model.rawAttributes 不可用）；` +
        '拒绝以"不限制字段"的方式写入资源级授权 —— 那会把 token 哈希一并下发',
    );
  }

  const deny = new Set(nativeReadDenyFields(resource));
  const allowed = names.filter((name) => !deny.has(name));

  if (allowed.length === 0) {
    throw new Error(`[seeds] ${resource} 过滤后没有任何可下发字段，授权会变成空壳`);
  }

  return allowed;
}

/**
 * 资源级授权（dataSourcesRolesResources + ...Actions）—— 判定的**第二级**。
 *
 * 为什么单独成一个函数（而不是内联在 seedRoles 里）：
 *   它是**可独立追加**的一部分。迁移一旦被 umzug 记录为"已完成"就不可再改
 *   （改内容不会重跑，改文件名会重复执行），所以"给已安装实例补数据"只能靠
 *   **追加新迁移**。资源级授权是在 baseline-seed 迁移发布之后才补的，
 *   因此它需要一个只补这一块的迁移入口 —— 复用同一个实现，避免两条路径漂移。
 *
 * 为什么必须有这一级（一次真机事故的结论）：
 *   NocoBase 的判定是两级：① dataSourcesRoles.strategy.actions（全局 action 名白名单）
 *   ② dataSourcesRolesResources（逐资源放行）。只写 ① 的现象是
 *   "角色在后台看得见、用户能登录，但每个资源都 403 No permissions"。
 *
 * 幂等：按 (roleName, dataSourceKey, name) 查重后只增不改。
 *   运营在后台调过的授权（比如单独给某角色多放一张表）不会被部署冲掉。
 *
 * **唯一的例外是"修正不安全的 fields 取值"**（见下面的 repair 分支）。
 *   真机三态实测（.probe/fields-semantics.mjs，2026-09-20）给出的确切行为：
 *
 *     fields = null  → list 返回**整行 36 个键**，含 feedback_token_hash /
 *                      feedback_token_expires_at / feedback_token_used_at
 *                      ⇒ 真实的安全漏洞，不是"少几个字段"的问题
 *     fields = []    → list 返回 3 个键（id/createdAt/updatedAt）
 *                      ⇒ 静默空壳：HTTP 200，业务列一个都没有
 *     fields = 白名单 → 返回 33 个业务列 + 自动补的 createdAt/updatedAt，
 *                      敏感列不在其中 ⇒ 目标状态
 *
 *   前两种取值都不是运营的**有意配置**（一种泄露凭证、一种把接口做成空壳），
 *   因此被当作"已知的错误默认值"纠正为本次算出的白名单。
 *   只有**非空数组**（运营自定义的白名单）一律不碰。
 */
export async function seedRoleResources(
  deps: ApplySeedsDeps & { dataSourceKey?: string },
): Promise<SeedCounts> {
  const { db } = deps;
  const dataSourceKey = deps.dataSourceKey ?? resolveMainDataSourceKey(deps.app);
  const dsResourcesRepository = db.getRepository('dataSourcesRolesResources');
  const dsActionsRepository = db.getRepository('dataSourcesRolesResourcesActions');

  // 先清无主行，再补齐 —— 顺序不能反。
  //   反过来的话，本轮补出来的行可能是"上一轮被 roles:update 脱钩"的那一批，
  //   无主行与本轮新行同时存在于同一次播种里，"补了几条"就说不清了。
  const orphansRemoved = await removeOrphanResourceRows(deps, dsResourcesRepository, dsActionsRepository);

  let created = 0;
  let skipped = 0;
  let repaired = 0;
  let realigned = 0;

  for (const seed of ROLE_SEEDS) {
    for (const resource of seed.resources) {
      // 字段白名单按资源算一次（与角色无关），结果对所有角色一致
      const allowedFields = nativeReadFieldsOf(db, resource.resource);
      const actions = resource.actions.map((name) => ({ name, fields: allowedFields }));

      const resourceExisting = await dsResourcesRepository.findOne({
        filter: { roleName: seed.name, dataSourceKey, name: resource.resource },
      });

      if (resourceExisting) {
        skipped += 1;
        // ---- 修正不安全取值（null = 整行下发会泄露 token；[] = 空壳）+ 对齐漂移 ----
        const fix = await repairUnsafeActionFields(deps, dsActionsRepository, resourceExisting, actions);
        repaired += fix.total;
        realigned += fix.realigned;
        continue;
      }

      // 用嵌套 values 一次写入 resource + 其 actions：
      // NocoBase 的 hasMany 关联（foreignKey = rolesResourceId）会一并落库，
      // 且 dataSourcesRolesResources.id 是 snowflakeId（应用层生成，无 DB 默认值），
      // 只有走 repository 才会被正确赋值 —— 手写原生 INSERT 必须自己造 id。
      await dsResourcesRepository.create({
        values: {
          roleName: seed.name,
          dataSourceKey,
          name: resource.resource,
          usingActionsConfig: resource.usingActionsConfig,
          actions,
        },
      });
      created += 1;
    }
  }

  return { created, skipped, repaired, realigned, orphansRemoved };
}

/**
 * 删除**无主**的资源授权行（`roleName` 为 NULL / 空串）及其 action 行。
 *
 * 为什么要动"删除"这把刀（本文件其余地方一律"只增不改"）：
 *   无主行不是任何人的配置 —— 后台的角色管理页根本表达不出"一条不属于任何角色的授权"，
 *   它只能由 `roles:update` 的关联替换副作用产生（`SET roleName = NULL`，见 SeedCounts
 *   的 orphansRemoved 注释与 DEV-27）。因此它和 `fields=null` 属于同一类：
 *   **是坏数据，不是配置**，不该享受"只增不改"的保护。
 *
 * 为什么必须**连带删 action 行**：
 *   库里 `dataSourcesRolesResourcesActions.rolesResourceId → dataSourcesRolesResources.id`
 *   没有外键约束（实测 `pg_constraint` 只有主键），所以删父行不会级联；
 *   留下 action 行就会变成"指向不存在父行"的悬挂数据，越积越多。
 *
 * 安全边界：只删 `roleName` 为空/ NULL 的行。
 *   运营在后台新建的自定义角色、以及给它配的授权行**一律不碰** ——
 *   那些行的 `roleName` 非空，不在本函数的筛选范围内。
 *
 * 缺 repository 能力（如离线校验的最小桩）时静默跳过：本函数是**自愈**，不是断言。
 *   真正的"零无主行"断言在冒烟测试里对着真库跑（scripts/smoke-test.mjs）。
 */
async function removeOrphanResourceRows(
  deps: ApplySeedsDeps,
  dsResourcesRepository: any,
  dsActionsRepository: any,
): Promise<number> {
  if (typeof dsResourcesRepository?.find !== 'function' || typeof dsResourcesRepository?.destroy !== 'function') {
    return 0;
  }

  // 分两次查，不用 `$in: [null, '']`：
  //   SQL 的 `IN (NULL, '')` **匹配不到 NULL**（NULL 与任何值比较都是 unknown），
  //   所以合在一起写会把真正的 NULL 行漏掉 —— 而 NULL 恰恰是主要那一种。
  const orphans: any[] = [];
  for (const filter of [{ roleName: null }, { roleName: '' }]) {
    for (const row of (await dsResourcesRepository.find({ filter })) || []) orphans.push(row);
  }
  if (orphans.length === 0) return 0;

  const ids = orphans.map((row) => readField(row, 'id')).filter((id) => id !== undefined && id !== null);
  if (ids.length === 0) return 0;

  if (typeof dsActionsRepository?.destroy === 'function') {
    await dsActionsRepository.destroy({ filter: { rolesResourceId: { $in: ids } } });
  }
  const removed = await dsResourcesRepository.destroy({ filter: { id: { $in: ids } } });

  const names = orphans.map((row) => `${readField(row, 'dataSourceKey')}/${readField(row, 'name')}`).join(', ');
  deps.logger?.warn?.(
    `[seeds] 清理无主资源授权行 ${removed ?? ids.length} 条（roleName 为空，永远不会被 ACL 加载）：${names}`,
  );
  return typeof removed === 'number' ? removed : ids.length;
}

/**
 * 取字段值：兼容 Sequelize Model 实例（.get）与纯对象桩 */
function readField(row: any, key: string): any {
  return typeof row?.get === 'function' ? row.get(key) : row?.[key];
}

/**
 * 漂移日志里的差异摘要：**逐元素集合差**，而不是只报长度。
 *
 * 为什么必须报集合差：
 *   真机上出现过"现存 33 列 ≠ 期望 33 列"——长度完全相同、顺序也看着正常，
 *   只报长度的话这条日志等于没说（运维无法判断是该信任代码还是该查后台）。
 *   而漂移的两种典型形态（多一列 / 少一列 / 顺序不同）对应的处置完全不同：
 *     · 多出列 → 有人在后台加过列（要查是谁、加的对不对）
 *     · 缺少列 → 接口会静默丢列（业务可见的缺陷）
 *     · 仅顺序不同 → NocoBase 自身对 fields 做过规范化，属噪声
 *   因此这里把三种形态分开报，让一条日志就能定性。
 */
function diffSummary(actual: string[], want: string[]): string {
  const extra = actual.filter((f) => !want.includes(f));
  const missing = want.filter((f) => !actual.includes(f));
  if (extra.length === 0 && missing.length === 0) {
    // 长度相同、元素集合相同 —— 那差异只可能是顺序
    return '；两者元素集合相同，仅顺序不同（NocoBase 侧规范化）';
  }
  const parts: string[] = [];
  if (extra.length > 0) parts.push(`多出 [${extra.join(',')}]`);
  if (missing.length > 0) parts.push(`缺少 [${missing.join(',')}]`);
  return `；${parts.join('，')}`;
}

/**
 * 把已有的 action 行修成"可用且不泄露"的状态。
 *
 * 做**四类**修正，前三类是把接口从静默错误里救回来，第四类是本次 Phase 2.1 新增的：
 *   ① 补齐缺失的 action 行。
 *      `dataSourcesRolesResources` 有行、但 Actions 子表里少了某条 —— 成因是
 *      NocoBase 后台 UI 的 `roles:update` 可以只提交部分 action（或提交空数组）。
 *      此时该 action 匹配不到资源级条目 → 请求 403 No permissions。
 *      之所以必须补：本插件给这些资源写的是 `usingActionsConfig: true`
 *      （只用 actions 里列的，不用 strategy 兜底），少一行就是少一个权限，
 *      且报错发生在 ACL 层、日志里只有一句 "No permissions"，极难倒查。
 *   ② 修正不安全的 `fields` 取值 —— 详见 seedRoleResources 的注释与真机三态实测：
 *        null → 整行下发（**泄露 feedback_token_hash / access_token_hash**）
 *        []   → 只给 id/createdAt/updatedAt（空壳，业务列全丢）
 *   ③（与 ② 同属"不安全取值"，一并处理，见下）
 *   ④ **漂移对齐**：`fields` 是非空数组、但与期望白名单不一致 → 改回期望值。
 *
 * 第 ④ 类的由来（真实事故，不是假设）：
 *   Phase 2 真机验收时，取证探针把 `viewer` 的 `serviceTickets` 两条 action 行改成
 *   了 7 列，而旧逻辑对"非空数组"一律不碰（动机是"不覆盖运营配置"）。
 *   结果：**测试残留被永久固化进线上权限**，报告只能写"与其余角色不一致"。
 *   结论（与 DEV-19 / DEV-22 同一条理由）：字段白名单是安全边界，
 *   不接受后台手工配置，一律由代码单一事实来源决定 —— 漂移即对齐。
 *
 * ⚠️ 逃生开关只管第 ④ 类：`SVC_ACL_FIELDS_AUTOFIX=0` 时跳过对齐，
 *    但第 ① ② ③ 类**永远执行** —— 那是漏洞，不是配置。
 *
 * 返回值：{ total, realigned } —— total = 被改动的行数（含补建行 + 纠正行 + 对齐行）。
 *   "本次部署改动了线上既有数据"必须能从日志里看出来，且能分清是止血还是纠漂移。
 */
async function repairUnsafeActionFields(
  deps: ApplySeedsDeps,
  dsActionsRepository: any,
  resourceRow: any,
  desiredActions: Array<{ name: string; fields: string[] }>,
): Promise<{ total: number; realigned: number }> {
  if (typeof dsActionsRepository?.find !== 'function') return { total: 0, realigned: 0 };

  const roleResourceId = readField(resourceRow, 'id');
  const label = `${readField(resourceRow, 'roleName')}/${readField(resourceRow, 'name')}`;
  const env = deps.env ?? process.env;
  const autofix = aclFieldsAutofixEnabled(env);
  let total = 0;
  let realigned = 0;

  const rows = await dsActionsRepository.find({ filter: { rolesResourceId: roleResourceId } });
  const existingNames = new Set((rows || []).map((row: any) => readField(row, 'name')));

  // ---- ① 补齐缺失的 action 行（不受逃生开关影响）----
  if (typeof dsActionsRepository.create === 'function') {
    for (const desired of desiredActions) {
      if (existingNames.has(desired.name)) continue;
      await dsActionsRepository.create({
        values: { name: desired.name, fields: desired.fields, rolesResourceId: roleResourceId },
      });
      total += 1;
      deps.logger?.warn?.(
        `[seeds] 资源授权缺少 action 行，已补：${label}:${desired.name}（原先该 action 会 403）`,
      );
    }
  }

  // ---- ②③④ 修正 / 对齐 fields ----
  if (typeof dsActionsRepository.update !== 'function') return { total, realigned };

  for (const row of rows || []) {
    const fields = readField(row, 'fields');
    const name = readField(row, 'name');
    const desired = desiredActions.find((a) => a.name === name);
    if (!desired) continue;

    const isUnsafe = fields === null || fields === undefined || (Array.isArray(fields) && fields.length === 0);
    // 集合比较（忽略顺序）：NocoBase 会在 `list` 动作上重排 fields，
    // 逐位比较会把这次重排判成漂移，导致每次启动都重写 16 行并刷 16 条 warn
    // —— 详见 constants.sameFieldSet 的注释。
    const isDrifted = !isUnsafe && Array.isArray(fields) && !sameFieldSet(fields, desired.fields);

    if (isDrifted && !autofix) {
      // 显式关掉了对齐：只在 debug 里留痕，避免每次启动都刷 warn
      deps.logger?.debug?.(
        `[seeds] 字段白名单与期望不一致但已关闭自动对齐（${ACL_FIELDS_AUTOFIX_ENV}=0）：` +
          `${label}:${name} 现存 ${fields.length} 列，期望 ${desired.fields.length} 列`,
      );
      continue;
    }

    if (!isUnsafe && !isDrifted) continue; // 已与期望一致

    await dsActionsRepository.update({
      filter: { id: readField(row, 'id') },
      values: { fields: desired.fields },
    });
    total += 1;
    if (isDrifted) realigned += 1;

    const reason = isDrifted
      ? `漂移（现存 ${fields.length} 列 ≠ 期望 ${desired.fields.length} 列` +
        diffSummary(fields as string[], desired.fields) +
        '）'
      : fields === null || fields === undefined
        ? '不限制字段（泄露凭证列）'
        : '空数组（空壳）';
    deps.logger?.warn?.(
      `[seeds] 修正字段白名单：${label}:${name} 原为 ${reason} → ${desired.fields.length} 个字段`,
    );
  }

  return { total, realigned };
}

/**
 * 角色种子落库（roles 表 + dataSourcesRoles 表 + dataSourcesRolesResources(+Actions) 表）。
 *
 * 必须写**这几张**表，缺一不可 —— 这是 NocoBase 自身机制的坑：
 *   · roles             —— 角色本体（name/title/description/snippets/allowConfigure），
 *                          后台"角色管理"页读它；用户赋角色靠 rolesUsers 关联到它。
 *   · dataSourcesRoles  —— **strategy 的权威来源**。
 *     证据：plugin-acl 的 RoleModel.writeToAcl() 写 strategy 的分支被硬编码成
 *     `withOutStrategy: true`（dist/server/model/RoleModel.js），
 *     真正调用 role.setStrategy() 的是
 *     DataSourcesRolesModel.writeToAcl()（plugin-data-source-manager）。
 *     只写 roles 表 → 角色在后台看得见，但 ACL 无策略 → 该角色所有请求 403。
 *   · dataSourcesRolesResources(+Actions) —— **资源级授权**（见 seedRoleResources）。
 *     缺这一级的现象是"角色有策略、能登录，但每个资源的请求都是
 *     403 {"errors":[{"message":"No permissions"}]}"。
 *
 * NocoBase 的链路（plugin-data-source-manager）：
 *   DataSourceModel.loadIntoACL()（**启动期**逐个角色）
 *     → DataSourcesRolesModel.writeToAcl()
 *          → 查 dataSourcesRolesResources（按 roleName + dataSourceKey）
 *               → RoleResourceModel.writeToACL() → role.grantAction(`${resource}:${action}`)
 * 所以只要库里这一级存在，重启后会由 NocoBase 自动灌进 ACL；
 * 本插件另外在写完后主动回灌一次（见 plugin.ts 的 registerRoleResources），
 * 让部署**立即**生效、不必等重启。
 *
 * 注意 roles.strategy 这一列**照着写**，但它只用于"库里自解释"：
 *   读取路径一律 withOutStrategy，真正生效的是 dataSourcesRoles。
 *
 * 幂等：各表都按"业务唯一键"查重后只增不改，运营在后台调过的授权不会被冲掉。
 */
export async function seedRoles(
  deps: ApplySeedsDeps & { dataSourceKey?: string },
): Promise<RoleSeedCounts> {
  const { db } = deps;
  const dataSourceKey = deps.dataSourceKey ?? resolveMainDataSourceKey(deps.app);
  const rolesRepository = db.getRepository('roles');
  const dsRolesRepository = db.getRepository('dataSourcesRoles');

  let created = 0;
  let skipped = 0;

  for (const seed of ROLE_SEEDS) {
    const existing = await rolesRepository.findOne({ filter: { name: seed.name } });

    if (!existing) {
      await rolesRepository.create({
        values: {
          name: seed.name,
          title: seed.title,
          description: seed.description,
          allowConfigure: seed.allowConfigure,
          snippets: seed.snippets,
          strategy: strategyOf(seed),
          default: false,
          hidden: false,
        },
      });
      created += 1;
    } else {
      skipped += 1;
    }

    const dsExisting = await dsRolesRepository.findOne({
      filter: { roleName: seed.name, dataSourceKey },
    });

    if (!dsExisting) {
      await dsRolesRepository.create({
        values: {
          roleName: seed.name,
          dataSourceKey,
          strategy: strategyOf(seed),
        },
      });
    }
  }

  // 资源级授权复用同一个实现（与本文件末尾的独立迁移入口共用，杜绝两条路径漂移）
  const resources = await seedRoleResources({ ...deps, dataSourceKey });

  // repaired 由资源级授权那一层上报（角色/策略本身没有"需要纠正的历史取值"），
  // 这里透传上去，调用方才能从一次 seedRoles 的返回值里看到"改过哪些既有行"。
  // realigned（漂移对齐）同属 resources.repaired 的一个子集，单独透传便于区分"止血"与"纠漂移"。
  // orphansRemoved（清无主行）同样透传：它是"删了库里的行"，必须能在部署日志里一眼看到。
  return {
    created,
    skipped,
    repaired: resources.repaired,
    realigned: resources.realigned,
    orphansRemoved: resources.orphansRemoved,
    resources,
  };
}

/**
 * 一次性播完基线数据。
 *
 * 顺序：参数 → 门店 → 角色。
 *   门店先于角色：角色只是"能力"，门店是"数据范围"的锚点；
 *   先有门店，赋权与验收（AT-03）才有对象可指。
 *
 * 任一子步骤抛错即整体抛出（不做部分成功）：
 *   调用方据此把 healthState.lastError 设成明确的 SEED_*_FAILED，
 *   而不是"看不到任何错误但数据没进去"。
 */
export async function applyBaselineSeeds(deps: ApplySeedsDeps): Promise<ApplySeedsResult> {
  const operator = deps.operator ?? 'system';
  const dataSourceKey = resolveMainDataSourceKey(deps.app);

  const settings = await seedSettings({ ...deps, operator });
  const stores = await seedStores({ ...deps, operator });
  const roles = await seedRoles({ ...deps, operator, dataSourceKey });

  deps.logger?.info?.(
    `[seeds] 基线数据（${operator}）：参数新增 ${settings.created}/跳过 ${settings.skipped}；` +
      `门店新增 ${stores.created}/跳过 ${stores.skipped}；` +
      `角色新增 ${roles.created}/跳过 ${roles.skipped}；` +
      `资源授权新增 ${roles.resources.created}/跳过 ${roles.resources.skipped}/修正 ${roles.resources.repaired}` +
      (roles.resources.realigned
        ? `（其中漂移对齐 ${roles.resources.realigned} 行）`
        : '') +
      (roles.resources.orphansRemoved
        ? `（另清理无主行 ${roles.resources.orphansRemoved} 行）`
        : '') +
      `（数据源 ${dataSourceKey}）`,
  );

  return { settings, stores, roles, dataSourceKey };
}
