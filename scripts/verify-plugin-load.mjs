#!/usr/bin/env node
/**
 * verify-plugin-load.mjs —— 离线「插件可加载 + 生命周期 + 健康检查」验证
 *
 * 为什么需要它：
 *   Phase 1 的验收要等 Docker 起来才能做，但"插件到底能不能被 NocoBase 加载"这一环
 *   完全可以在本机先验证掉，避免上线时才发现包名解析、导出形态、ACL 写法这些问题。
 *
 * 做法（关键 —— 复刻容器里的真实解析布局）：
 *   在系统临时目录下搭一个假应用：
 *     <tmp>/app/node_modules/@local/service-ticket/   ← 拷贝真实构建产物
 *     <tmp>/app/node_modules/@nocobase/server/        ← 桩：只提供 Plugin 基类
 *     <tmp>/app/node_modules/@nocobase/database/      ← 桩：只提供 defineCollection
 *     <tmp>/app/node_modules/@nocobase/utils/         ← 桩：只提供 koaMulter（P5-1 上传用）
 *   然后以 <tmp>/app 为解析根 require('@local/service-ticket')。
 *   这与 docker-compose 把插件挂进 node_modules/@local 的机制完全一致，
 *   因此"能通过"就等价于"容器里 package 解析不会出问题"。
 *
 *   ⚠️ 产物 require 的**每一个**外部模块都必须在这里有桩，否则整包解析失败。
 *      而失败后的表现很坑：后续遍历型断言会在空集合上"通过"（假绿）。
 *      因此本脚本在第 1 节之后**fail-fast**，见那里的守卫注释。
 *
 * 验证项：
 *   1) 包名可解析 + __esModule/default 导出形态正确（NocoBase 的 requireModule 语义）
 *   2) new Plugin(app, options) 可实例化
 *   3) load() 注册 11 张表、注册 /api/svc:health、开放匿名白名单
 *   4) 健康检查返回 {db:'ok', sms:'mock', tasks:'ok'}，HTTP 200
 *   5) 表缺失时降级为 503 + missingTables（监控能发现）
 *   6) install() 只增不改地写入 16 项参数种子
 *
 * 用法：node scripts/verify-plugin-load.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_INDEXES, indexSignature } from './expected-indexes.mjs';
import { NOCOBASE_IMAGE, NOCOBASE_VERSION } from './expected-versions.mjs';
import {
  parseDefaultSettingKeys,
  readDefaultSettingKeys as readDefaultSettingKeysImpl,
  CONSTANTS_TS_PATH,
} from './expected-settings.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BUILT_PLUGIN_DIR = path.join(ROOT, 'storage', 'plugins', '@local', 'service-ticket');

/**
 * 原生**写**动作（含 import/move/query 这类副作用动作）。
 *
 * 存在的理由：资源级只读授权的断言不能只写
 *   `row.name === 'list' || row.name === 'get'`
 * —— 那样一旦新增只读动作（DEV-65 的 `view`）就会把**正确**实现判红，
 * 而放宽成"任意 action 都行"又会把写后门放进来。
 * 所以拆成两条：① 必须在 ROLE_NATIVE_READ_ACTIONS 里声明；
 *              ② 不得命中本名单。本名单是**否命题**，新增只读动作无需改它。
 *
 * 依据 docs/API.md §6「状态类变更 ❌ 禁止直调原生 update」与 DEV-22。
 */
const WRITE_ACTIONS = new Set([
  'create',
  'update',
  'destroy',
  'export',
  'import',
  'move',
  'query',
]);

/**
 * 期望的只读动作集合 —— **从插件常量派生**，不手抄（DEV-65）。
 *
 * 手抄的 32 / "2 个 action：list/get" 是本次 26 项假红的元凶：源常量加了 `view`
 * 之后，断言仍按旧的 2 个动作算，于是把**正确**的 3 动作实现判成"行数不符"。
 * `ROLE_NATIVE_READ_ACTIONS` 是单一事实来源，这里只做一次推导。
 *
 * fallback 仅在插件模块读不出来时使用（例如构建产物缺失），
 * 值必须与 constants.ts 保持一致；不一致会被下面"派生自插件常量"的断言抓到。
 */
const READ_ACTIONS_FALLBACK = ['view', 'list', 'get'];

/**
 * 解析当前期望的只读动作集（**每次调用时求值**，不能提前算）。
 *
 * `rawModule` 是函数内 `let`，在插件 require 成功后才被赋值；若在本文件顶层
 * 就把它算成常量，永远只会拿到 fallback —— 那又是一个"看着在派生、实际写死"的假象。
 */
function readActions() {
  try {
    const mod = rawModule?.ROLE_NATIVE_READ_ACTIONS;
    if (Array.isArray(mod) && mod.length > 0) return [...mod];
  } catch {
    /* 插件尚未构建：退回 fallback，由专门的断言报出漂移 */
  }
  return [...READ_ACTIONS_FALLBACK];
}

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];

function check(title, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  ✅ ${title}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures.push({ title, message: err.message });
    console.log(`  ❌ ${title} — ${err.message}`);
  }
}

async function checkAsync(title, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  ✅ ${title}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures.push({ title, message: err.message });
    console.log(`  ❌ ${title} — ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// 搭假应用
// ---------------------------------------------------------------------------
function scaffold() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-plugin-verify-'));
  const appDir = path.join(tmp, 'app');
  const nm = path.join(appDir, 'node_modules');

  // ① 拷贝真实产物
  const target = path.join(nm, '@local', 'service-ticket');
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(BUILT_PLUGIN_DIR, target, { recursive: true });

  // ② 桩 @nocobase/server —— 只保留本插件真正用到的 Plugin 基类契约
  const serverStub = path.join(nm, '@nocobase', 'server');
  fs.mkdirSync(serverStub, { recursive: true });
  fs.writeFileSync(
    path.join(serverStub, 'package.json'),
    JSON.stringify({ name: '@nocobase/server', version: '0.0.0-stub', main: 'index.js' }, null, 2),
  );
  fs.writeFileSync(
    path.join(serverStub, 'index.js'),
    `'use strict';
// 仅实现本插件依赖的 Plugin 契约：app / options / state / db / log
class Plugin {
  constructor(app, options) {
    this.app = app;
    this.options = options || {};
    this.state = {};
  }
  get name() { return this.options.name; }
  get db() { return this.app.db; }
  get log() { return this.app.log; }
  async beforeLoad() {}
  async load() {}
  async install() {}
  async afterEnable() {}
}
module.exports = { Plugin };
`,
  );

  // ③ 桩 @nocobase/database —— defineCollection 只是标识函数，返回原对象
  const dbStub = path.join(nm, '@nocobase', 'database');
  fs.mkdirSync(dbStub, { recursive: true });
  fs.writeFileSync(
    path.join(dbStub, 'package.json'),
    JSON.stringify({ name: '@nocobase/database', version: '0.0.0-stub', main: 'index.js' }, null, 2),
  );
  fs.writeFileSync(
    path.join(dbStub, 'index.js'),
    `'use strict';
function defineCollection(options) { return options; }
/**
 * 迁移基类。
 * 真实实现（@nocobase/database/lib/migration.js）只提供 context / db / sequelize 与空的 up()/down()；
 * 本插件产物里的迁移 stub 形如 \`class extends Migration { on='afterLoad'; async up(){} }\`，
 * 所以桩必须让 extends 成立，且构造参数里带 {db, app}（application.loadMigrations 就是这么 new 的）。
 */
class Migration {
  constructor(context) { this.context = context || {}; this.name = ''; }
  get db() { return this.context.db; }
  get sequelize() { return this.context.db && this.context.db.sequelize; }
  async up() {}
  async down() {}
}
module.exports = { defineCollection, Migration, Database: class Database {}, default: class Database {} };
`,
  );

  // ④ 桩 @nocobase/utils —— 本插件用到 `koaMulter`（P5-1 的照片上传）。
  //
  // 为什么必须补这个桩：假应用是"复刻容器里的解析布局"，而 `@nocobase/utils`
  // 在 `scripts/build-plugin.mjs` 的 EXTERNALS 里（被 `@nocobase/*` 匹配），
  // 因此产物里是 `require('@nocobase/utils')`。真机容器里它有真实实现，
  // 假应用里没有桩 → `require('@local/service-ticket')` 直接抛
  // `Cannot find module '@nocobase/utils'` → **整个插件加载失败**，
  // 而失败表现是后面几十条断言在"0 张表"上继续"通过"（见下方 fail-fast 守卫）。
  //
  // ⚠️ 这个桩**只负责"模块能被解析"**，不实现 multipart 解析 ——
  //    本脚本不做请求级验证（那是 verify-technician-upload.mjs 的活）。
  //    别在这里把它写成"看起来像真的"实现，那会制造"验过了"的错觉。
  const utilsStub = path.join(nm, '@nocobase', 'utils');
  fs.mkdirSync(utilsStub, { recursive: true });
  fs.writeFileSync(
    path.join(utilsStub, 'package.json'),
    JSON.stringify({ name: '@nocobase/utils', version: '0.0.0-stub', main: 'index.js' }, null, 2),
  );
  fs.writeFileSync(
    path.join(utilsStub, 'index.js'),
    `'use strict';
// 只有"被 require 到"这一件事需要成立；调用行为不在本脚本的验证范围内。
function koaMulter() {
  return { single: () => async (_ctx, next) => (typeof next === 'function' ? next() : undefined) };
}
module.exports = { koaMulter };
`,
  );

  // ④b 桩 multer —— 产物直接 `require('multer')` 取 `memoryStorage`。
  //    同 ④：只为"能被解析"，不模拟解析行为。
  const multerStub = path.join(nm, 'multer');
  fs.mkdirSync(multerStub, { recursive: true });
  fs.writeFileSync(
    path.join(multerStub, 'package.json'),
    JSON.stringify({ name: 'multer', version: '0.0.0-stub', main: 'index.js' }, null, 2),
  );
  fs.writeFileSync(
    path.join(multerStub, 'index.js'),
    `'use strict';
function memoryStorage() { return { _handleFile(_req, _file, cb) { cb(null, {}); }, _removeFile(_req, _file, cb) { cb(null); } }; }
function diskStorage() { return memoryStorage(); }
function multer() { return { single: () => (_req, _res, next) => next(), array: () => (_req, _res, next) => next() }; }
multer.memoryStorage = memoryStorage;
multer.diskStorage = diskStorage;
module.exports = multer;
`,
  );

  // ⑤ 解析锚点
  fs.writeFileSync(path.join(appDir, 'anchor.cjs'), '// resolution anchor\n');

  return { tmp, appDir };
}

// ---------------------------------------------------------------------------
// 假 app / ctx
// ---------------------------------------------------------------------------

/**
 * 从源码常量里读出参数种子的 key 列表。
 *
 * 为什么不直接写死 16 个 key：那样"参数清单"就有了第二份副本，
 * 改源码忘了改脚本会双双"绿"掉。这里只做一次正则扫描，源文件始终是唯一事实来源。
 */
/**
 * 从 constants.ts 的 `DEFAULT_SETTINGS` 里读出全部参数键 —— **实现已抽到共享模块**。
 *
 * ⚠️ 为什么必须支持 `key: SOME_CONST.X` 形态（Phase 5 开工时实测踩过）：
 *   把 `visit.photo_max_count` 等键提为 `TECHNICIAN_SETTING_KEY.*` 常量，是为了让
 *   **播种处与 handler 读取处共用同一份键名**（否则改了播种的键、handler 还在读旧键，
 *   表现为"接口永远回退到兜底值"，不报错）。但解析器原先只认 `key: '字面量'`，
 *   于是**同一个 DEFAULT_SETTINGS** 被数成两个数：
 *     真实播种 17 项（代码正确） vs 解析出 14 项（少了 3 个常量引用）
 *   → 4 条断言立刻变红，而红灯**全在解析器身上**。这类"过期期望"比没有断言更糟：
 *   它训练人忽略红灯，下次真正的漂移就被淹没了（工程铁律 2）。
 *
 *   `smoke-test.mjs` 里曾有一份**完全一样**的拷贝，同一时刻一起变瞎 ——
 *   所以两处现在共用 `scripts/expected-settings.mjs`，只此一份。
 */
const readDefaultSettingKeys = () => readDefaultSettingKeysImpl(CONSTANTS_TS_PATH);

/**
 * 从源码常量里读出 `svc` 资源上的 action 集合。
 *
 * 为什么不把数量写死在断言里（Phase 4 的真实教训）：
 *   Phase 3 时本脚本写死了「6 个 action」，Phase 4 一加 5 个动作（派工三动作 +
 *   两个 mock-only 探针），离线校验立刻亮 4 个红灯 —— 而**代码是对的，红灯全在
 *   脚本自己身上**。这类"过期期望"比没有断言更糟：它训练人忽略红灯，
 *   下次真正的漂移就会被淹没（工程铁律 2）。
 *
 *   所以这里改成从唯一事实来源推导：
 *     · `Object.values(SVC_ACTION)`               → 资源上应有的**全部** action
 *     · `AUTHENTICATED_SVC_ACTIONS`（引用键名）    → 其中必须走 loggedIn 的那些
 *   两者都是从 constants.ts 现读的，加/删动作时断言自动跟随，
 *   而"资源真正暴露了几个"仍由真机/桩的实际注册结果说话。
 *
 * 解析口径：只认 `  KEY: 'value',` 这种**两空格缩进 + 引号字面量**的属性行。
 *   刻意不用宽泛的 `/(\w+):\s*'([^']+)'/`：SVC_ACTION 的注释里出现了
 *   `` `acl.allow(...)` `` 之类的说明文字，宽松正则会把它们当成员。
 */
function readSvcActionSets() {
  const file = path.join(
    ROOT,
    'nocobase',
    'plugins',
    'service-ticket',
    'src',
    'server',
    'constants.ts',
  );
  const src = fs.readFileSync(file, 'utf8');

  const actionBlock = /export const SVC_ACTION\s*=\s*\{[\s\S]*?\n\}\s*as const;/.exec(src);
  assert(actionBlock, '未能在 constants.ts 中定位 SVC_ACTION');
  const pairs = [...actionBlock[0].matchAll(/^ {2}([A-Z][A-Z0-9_]*): '([^']+)',$/gm)].map((m) => [
    m[1],
    m[2],
  ]);
  assert(pairs.length >= 2, `SVC_ACTION 里没解析出 action（拿到 ${pairs.length} 个）`);
  const byKey = new Map(pairs);
  const all = pairs.map(([, value]) => value);
  assert(new Set(all).size === all.length, `SVC_ACTION 存在重复值：${all.join(',')}`);

  const authBlock = /export const AUTHENTICATED_SVC_ACTIONS[\s\S]*?\n\];/.exec(src);
  assert(authBlock, '未能在 constants.ts 中定位 AUTHENTICATED_SVC_ACTIONS');
  const authenticated = [...authBlock[0].matchAll(/SVC_ACTION\.([A-Z][A-Z0-9_]*)/g)].map((m) => {
    const value = byKey.get(m[1]);
    // 引用了一个不存在的键，说明常量被改坏了 —— 这正是该红的地方
    assert(value, `AUTHENTICATED_SVC_ACTIONS 引用了未知的 SVC_ACTION.${m[1]}`);
    return value;
  });
  assert(
    authenticated.length > 0 && authenticated.length < all.length,
    `AUTHENTICATED_SVC_ACTIONS 应严格小于全部 action（${authenticated.length}/${all.length}）`,
  );

  // health / guardQuota 是刻意**匿名可达**的两个（guardQuota 靠共享密钥自守）
  const anonymous = all.filter((value) => !authenticated.includes(value));

  return { all, authenticated, anonymous };
}

/**
 * 构造一个**最小可用**的 ctx，用来直接调用 svc action handler。
 *
 * 为什么可以这么简陋：`_http.ts` 里的 `ok` / `fail` 只做三件事 ——
 * 置 `ctx.withoutDataWrapping`、`ctx.status`、`ctx.body`。而 `traceId()`
 * 需要 `ctx.get`，参数解析需要 `ctx.action.params`。给齐这三样就够断言响应了，
 * 不需要把 Koa 整个搬进来（那会让这条离线校验变成"复刻框架"而不是"验证业务闸门"）。
 */
function makeActionCtx(values = {}) {
  return {
    set() {},
    get() {
      return undefined;
    },
    action: { params: { values } },
  };
}

/**
 * 取某个 action 的 handler 函数。
 *
 * ⚠️ 桩与真实实现的返回形态**不同**，这里必须兼容两者：
 *   真实 `Resource.getAction()` 返回 handler 函数本身；
 *   本脚本的桩返回 `{ name, handler }`（见 makeFakeApp 的 define 注释 ——
 *   桩需要额外提供"这个 action 到底可不可达"的信息，所以包了一层）。
 *   写成 `getAction(x)()` 会在桩里炸成 "is not a function"，
 *   而那个报错与"闸门失效"完全是两回事，极易被误读。
 */
function actionHandlerOf(resource, action) {
  const got = resource.getAction(action);
  const handler = typeof got === 'function' ? got : got?.handler;
  assert(
    typeof handler === 'function',
    `取不到 ${action} 的 handler（拿到 ${typeof got}），无法验证它的闸门`,
  );
  return handler;
}

/**
 * 列出迁移产物并**按文件名排序**。
 *
 * 必须显式排序：umzug 是按文件名字典序执行的，而 `fs.readdirSync` 的顺序
 * 依赖文件系统（NTFS 上通常接近字典序，但这是实现细节，不是契约）。
 * 不排序时，"基线先于补种"这类顺序断言会变得时灵时不灵。
 */
function readMigrationFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.js') && !name.endsWith('.map'))
    .sort();
}

/** 各表种子行 + 判重口径（与 plugin.ts / seeds 的 findOne filter 一一对应）。
 *
 * ⚠️ 表名清单必须与源码实际调用的 `getRepository()` 完全一致：
 *   桩对**未登记**的表是抛错的（`assert(spec, ...)`），这是刻意的 ——
 *   早期版本少了 dataSourcesRolesResources，结果 seedRoles 在循环前就抛、
 *   而 health 的 inspectBaselineSeeded 又把它 try/catch 吞成"全部 false"，
 *   于是"库里有 15 家门店"却对外报 storesSeeded=false。
 *   桩缺表 → 报错是好事；报错被吞掉才是灾难，所以这里宁可多登记、不可少登记。
 *
 * 真机表结构（2026-09-20 从容器内 psql 取证）：
 *   dataSourcesRolesResources        (id, dataSourceKey, roleName, name, usingActionsConfig)
 *   dataSourcesRolesResourcesActions (id, name, fields jsonb, scopeId, rolesResourceId)
 * 注意父表**没有** actions 列 —— actions 是 hasMany 关联，写到子表。
 */
const REPO_SPECS = {
  serviceSettings: { seedsKey: 'seededSettings' },
  stores: { seedsKey: 'seededStores' },
  roles: { seedsKey: 'seededRoles' },
  dataSourcesRoles: { seedsKey: 'seededDsRoles' },
  dataSourcesRolesResources: {
    seedsKey: 'seededDsResources',
    /** 复刻真实 ORM 的 hasMany 写入：嵌套 values 落到子表，父表不留这一列 */
    childTable: 'dataSourcesRolesResourcesActions',
  },
  dataSourcesRolesResourcesActions: { seedsKey: 'seededDsResourceActions' },
};

/**
 * 复刻 ORM 的 filter 语义：**AND** + 支持 `{ $in: [...] }`。
 *
 * 只比较 filter 里出现的键，其余键不参与（与 Sequelize 一致）。
 * 早期版本是逐表写 matches，于是"filter 里多一个键"就静默匹配不上 ——
 * 而真机 ORM 是 AND 语义。桩失真比没有桩更危险，所以这里统一成通用匹配。
 */
function matchFilter(row, filter) {
  if (!filter) return true;
  for (const [key, cond] of Object.entries(filter)) {
    const value = row?.[key];
    if (cond && typeof cond === 'object' && Array.isArray(cond.$in)) {
      if (!cond.$in.includes(value)) return false;
    } else if (cond === null) {
      // 保真 SQL 语义：NULL 列匹配 IS NULL。真库上 "roleName": null 会被 NocoBase
      // 编译成 `roleName IS NULL`（已用 REST 实测），而桩里如果按 `value !== null`
      // 判，缺键的行（undefined）就漏网 —— 无主行清理的断言将假绿。
      if (value !== null && value !== undefined) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function makeFakeApp(options = {}) {
  const { presentTables } = options;
  const collections = new Map();
  const repos = new Map();
  const appHandlers = new Map();

  /**
   * 通用内存仓库。桩必须与真实行为一致的四点：
   *   1) getRepository 对**任意**已登记表都可调用（Phase 2 起还会用到 stores / roles /
   *      dataSourcesRoles / dataSourcesRolesResources）；
   *   2) findOne 的 filter 是真过滤，不是"永远返回第一条" —— 否则"只增不改"的断言会假绿；
   *   3) count 支持 `{ key: { $in: [...] } }` —— health 的 *Seeded 靠它查库实时判定；
   *   4) **嵌套 hasMany 会落到子表**（dataSourcesRolesResources.actions → Actions 表），
   *      并且父行拿到一个非空 id —— 真实 snowflakeId 由应用层生成、无 DB 默认值，
   *      子表的 rolesResourceId 必须能指回它，否则资源级授权是"写了但判不到"。
   *
   *   5) **id 不与预置行撞号**。早期 idSeq 从 0 起，于是新建的第 1 行会拿到
   *      `id = 1`，与 options 里预置的 `{ id: 1 }` 撞车 —— 断言于是能"看到"
   *      一个 id=3 的父行，却分不清它是预置的无主行还是本轮新建的正常行。
   *      真实 snowflakeId 单调且全局唯一，桩必须同样保证唯一，否则
   *      "清理有没有误删 / 有没有真删"这类按 id 判定的断言全是噪声。
   */
  let idSeq = 0;
  for (const spec of Object.values(REPO_SPECS)) {
    for (const row of options[spec.seedsKey] || []) {
      if (typeof row?.id === 'number' && row.id > idSeq) idSeq = row.id;
    }
  }

  function repository(name) {
    if (!repos.has(name)) {
      const spec = REPO_SPECS[name];
      assert(spec, `假应用没有为 ${name} 准备仓库桩`);
      const rows = [...(options[spec.seedsKey] || [])];
      repos.set(name, {
        rows,
        calls: { findOne: 0, create: 0, created: [], update: 0, updated: [], destroy: 0 },
        async findOne({ filter }) {
          this.calls.findOne += 1;
          return rows.find((r) => matchFilter(r, filter)) || null;
        },
        async find({ filter } = {}) {
          if (!filter) return [...rows];
          return rows.filter((r) => matchFilter(r, filter));
        },
        async create({ values }) {
          this.calls.create += 1;
          this.calls.created.push(values);
          const row = { ...values };
          if (spec.childTable && Array.isArray(row.actions)) {
            const children = row.actions;
            delete row.actions;
            row.id = row.id ?? (idSeq += 1);
            const childRepo = repository(spec.childTable);
            for (const child of children) {
              await childRepo.create({ values: { ...child, rolesResourceId: row.id } });
            }
          }
          rows.push(row);
          return { ...row };
        },
        async update({ filter, values }) {
          this.calls.update += 1;
          this.calls.updated.push({ filter, values });
          const targets = rows.filter((r) => matchFilter(r, filter));
          for (const row of targets) Object.assign(row, values);
          return targets.length;
        },
        /**
         * 删除匹配的行并返回条数（真实 repository.destroy 的语义与返回值）。
         *
         * 为什么桩必须有它：无主资源授权行的清理是**唯一**一处"播种会删库里的行"
         * 的逻辑（其余一律只增不改）。没有 destroy 桩，"清理真的发生了吗、
         * 有没有误删正常行"这两件事在离线阶段就无法证伪 —— 而误删权限行
         * 的表现是"某角色突然 403"，属于上线后最难倒查的一类。
         */
        async destroy({ filter }) {
          this.calls.destroy = (this.calls.destroy || 0) + 1;
          const kept = rows.filter((r) => !matchFilter(r, filter));
          const removed = rows.length - kept.length;
          rows.length = 0;
          rows.push(...kept);
          return removed;
        },
        async count({ filter } = {}) {
          if (!filter) return rows.length;
          // 保真：真实 ORM 的 count 支持任意条件组合 + $in，与 find 同一套语义。
          // 早期只认 `filter.key`，于是"门店/角色是否齐备"这类按 code/name 判定的
          // 断言会静默走错分支（永远返回全表行数），属于典型的桩失真。
          return rows.filter((r) => matchFilter(r, filter)).length;
        },
      });
    }
    return repos.get(name);
  }

  const app = {
    log: makeLogger(),
    _handlers: appHandlers,

    /** Phase 2 用到的 afterLoad 钩子入口 */
    on(event, handler) {
      if (!appHandlers.has(event)) appHandlers.set(event, []);
      appHandlers.get(event).push(handler);
      return this;
    },

    db: {
      collections,
      hasCollection: (n) => collections.has(n),
      getCollection: (n) => collections.get(n),
      /**
       * 复刻 NocoBase 的 `collection(fields)`：定义会被 DataBase 加工后注册。
       *
       * ⚠️ 这里必须同时复刻**两个入口的形状差异**（真机取证，2026-09-20）：
       *
       *   · `collection.model.rawAttributes` —— **Sequelize 的权威属性表**，
       *     是 `nativeReadFieldsOf()` 真正读的那个入口。它的键 = ACL `fields`
       *     白名单要比对的字符串；包含自动注入的 id / createdAt / updatedAt
       *     （**camelCase**，与真机一致），以及 belongsTo 的**外键列**
       *     （store_id / ticket_id / store_confirmed_by …），
       *     **不含**关联名。
       *
       *   · `collection.getFields()` —— 真机返回的是**数组**
       *     （@nocobase/database/lib/collection.js: `[...this.fields.values()]`），
       *     元素是字段实例，含关联名（store / handler）、不含外键列。
       *
       * 为什么必须让桩也保持"数组"这个形状（而不是改名→定义的映射）：
       *   早先的桩把 getFields() 做成**名字映射**，于是 `Object.keys()` 能拿到正确
       *   名字，离线 51 项全绿；而真机上 `Object.keys(数组)` 得到的是
       *   ["0","1",…,"32"] 这种数字索引 —— 白名单会变成垃圾，接口静默丢列。
       *   两边**字段数量还都是 33**，数量巧合把形状差异彻底掩盖了。
       *   桩与真机同形，这个缺陷在离线阶段就会被暴露。
       *
       * 外键列名**必须取声明的 foreignKey**，不能按 `${name}_id` 推导：
       *   serviceVisits.store_confirmer 的 foreignKey 是 store_confirmed_by。
       */
      collection(definition) {
        if (collections.has(definition.name)) throw new Error(`collection ${definition.name} 已存在`);
        const declared = Array.isArray(definition.fields) ? definition.fields : [];

        const attrs = {
          id: { name: 'id', type: 'bigInt' },
          createdAt: { name: 'createdAt', type: 'date' },
          updatedAt: { name: 'updatedAt', type: 'date' },
        };
        const fieldList = [
          { name: 'id', type: 'bigInt' },
          { name: 'createdAt', type: 'date' },
          { name: 'updatedAt', type: 'date' },
        ];

        for (const field of declared) {
          if (!field?.name) continue;
          const isAssoc = /^(belongsTo|hasMany|hasOne|belongsToMany)$/.test(String(field.type));

          if (!isAssoc) {
            attrs[field.name] = field;
            fieldList.push({ name: field.name, type: field.type });
            continue;
          }

          // 关联字段：getFields() 里出现关联名；rawAttributes 里出现外键列。
          // 只有 belongsTo 的外键落**本表**（hasMany/hasOne 的外键在对端），
          // 本插件当前全部是 belongsTo。
          fieldList.push({ name: field.name, type: field.type });
          if (field.type === 'belongsTo' && field.foreignKey) {
            attrs[field.foreignKey] = { name: field.foreignKey, type: 'bigInt' };
          }
        }

        const stored = {
          ...definition,
          model: { rawAttributes: attrs },
          getFields: () => fieldList,
        };
        collections.set(definition.name, stored);
        return stored;
      },
      getRepository: repository,
      sequelize: {
        async authenticate() {},
        async query() {
          return presentTables.map((name) => ({ name }));
        },
      },
    },

    resourcer: {
      _defined: new Map(),
      /** 记录 resourcer 级中间件与其排序声明（Phase 2 起用于断言 storeScope 的挂载位置） */
      _used: [],
      /**
       * ⚠️ 桩必须复刻 Resource 构造函数的两件真实行为，否则会漏掉真实缺陷：
       *
       * ① **就地合并全局 handler**：真实实现（resourcer/lib/resource.js）里有一句
       *    `for (const [name, handler] of resourcer.getRegisteredHandlers()) { actions[name] = handler }`，
       *    它写回的是**调用方传入的那个 actions 对象**。所以插件里 define() 之后再
       *    `Object.keys(actions).length` 得到的是"全部原生 action + 自己的"，不是自己的数量。
       *    早期桩只存 def，导致这个计数缺陷在离线全绿、上真机才发现（health 报 104 个）。
       * ② **only 反选出 except**：`except = keys(actions) - only`，最终 this.actions 只留白名单内，
       *    getAction() 对 except 命中者抛 "not allowed"、对不存在者抛 "does not exist"。
       *    第 ② 条正是"原生 CRUD 是否真的被挡在门外"的判定依据，必须能真实触发。
       */
      _globalActionNames: ['list', 'get', 'create', 'update', 'destroy', 'export', 'import', 'move', 'query'],
      define(def) {
        const { actions = {}, only = [], except = [] } = def;

        for (const name of this._globalActionNames) {
          if (!actions[name]) actions[name] = async () => {};
        }

        let excludes = [];
        if (except.length > 0) excludes = [...except];
        else if (only.length > 0) excludes = Object.keys(actions).filter((n) => !only.includes(n));

        const effective = {};
        for (const [name, handler] of Object.entries(actions)) {
          if (!excludes.includes(name)) effective[name] = handler;
        }

        const record = {
          name: def.name,
          type: def.type,
          options: def,
          only,
          except: excludes,
          /** 合并后的全量（含原生 handler）—— 用于断言"计数没有被它污染" */
          allActions: actions,
          /** 最终对外暴露的 action（真实 Resource.this.actions） */
          actions: effective,
          getExcept() {
            return excludes;
          },
          getAction(action) {
            if (excludes.includes(action)) throw new Error(`${action} action is not allowed`);
            if (!Object.prototype.hasOwnProperty.call(effective, action)) {
              throw new Error(`${action} action does not exist`);
            }
            return { name: action, handler: effective[action] };
          },
        };

        this._defined.set(def.name, record);
        return record;
      },
      use(middleware, useOptions = {}) {
        this._used.push({ middleware, options: useOptions });
        return this;
      },
      /**
       * ⚠️ 必须与真实 NocoBase 行为一致：ResourceManager.getResource() 在资源
       * 不存在时是 `throw new Error('<name> resource does not exist')`，
       * 而**不是**返回 undefined/null。
       * 早期版本这里写成 `return this._defined.get(name) || null`，
       * 结果掩盖了 registerHealthAction 里的真实缺陷（用 getResource 做存在性判断），
       * 离线 24 项全绿、真机一启动就 503。桩失真比没有桩更危险。
       */
      getResource(name) {
        if (!this._defined.has(name)) throw new Error(`${name} resource does not exist`);
        return this._defined.get(name);
      },
      isDefined(name) {
        return this._defined.has(name);
      },
      removeResource(name) {
        return this._defined.delete(name);
      },
    },

    dataSourceManager: {
      dataSources: new Map([['main', { key: 'main', options: { key: 'main' } }]]),
    },

    acl: {
      /** [resource, action, condition]，condition 缺省为 'public'（与真实 AllowManager 一致） */
      allowed: [],
      _roles: new Map(),
      allow(resource, action, condition) {
        this.allowed.push([resource, action, condition || 'public']);
      },
      getRole(name) {
        return this._roles.get(name);
      },
      /**
       * 复刻真实 ACLRole 的最小契约：strategy 可读可写。
       * `define()` 在真实实现里是 roles.set(name, new ACLRole()) —— **整体替换**，
       * 这里保持一致，才能验证"已存在时不重新 define"这条防覆盖规则。
       */
      define({ role: roleName, strategy }) {
        const role = {
          name: roleName,
          strategy: strategy || null,
          defineCount: 1,
          setStrategy(value) {
            this.strategy = value;
          },
          getStrategy() {
            return this.strategy;
          },
        };
        this._roles.set(roleName, role);
        return role;
      },
    },
  };

  return { app, repository, repos };
}

function makeLogger() {
  const noop = () => {};
  const logger = { info: noop, debug: noop, warn: noop, error: noop, trace: noop };
  logger.child = () => logger;
  return logger;
}

function makeFakeContext(app) {
  const headers = {};
  return {
    app,
    state: {},
    status: undefined,
    body: undefined,
    get: () => undefined,
    set: (k, v) => {
      headers[k] = v;
    },
    _headers: headers,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const EXPECTED_COLLECTIONS = [
  'stores',
  'storeUsers',
  'serviceTickets',
  'serviceVisits',
  'serviceVisitPhotos',
  'ticketEvents',
  'smsLogs',
  'dailySequences',
  'apiGuards',
  'idempotencyRecords',
  'serviceSettings',
];

/** 与 collections/index.ts 的 EXPECTED_TABLE_NAMES 对齐：驼峰 → 下划线复数 */
const toTableName = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  插件离线验证：@local/service-ticket（Phase 1）');
  console.log('══════════════════════════════════════════════════════════════');

  if (!fs.existsSync(path.join(BUILT_PLUGIN_DIR, 'dist', 'server', 'index.js'))) {
    console.error('  ✗ 未找到构建产物，请先执行：node scripts/build-plugin.mjs');
    process.exit(1);
  }

  const { tmp, appDir } = scaffold();
  console.log(`  临时应用目录：${tmp}`);
  console.log('');

  const requireFromApp = createRequire(path.join(appDir, 'anchor.cjs'));

  // ---------------------------------------------------------------- 1. 包解析
  console.log('【1】包解析与导出形态');
  let rawModule = null;
  check('require(\'@local/service-ticket\') 可解析（等同容器内 node_modules 挂载）', () => {
    rawModule = requireFromApp('@local/service-ticket');
    assert(rawModule, 'require 返回空');
    return 'ok';
  });

  let PluginClass = null;
  check('NocoBase 的 requireModule 语义可取到插件类（__esModule → default）', () => {
    assert(rawModule.__esModule === true, '__esModule 不为 true，NocoBase 会拿到 module 对象');
    assert(typeof rawModule.default === 'function', 'default 不是函数');
    PluginClass = rawModule.__esModule ? rawModule.default : rawModule;
    return PluginClass.name || '(匿名类)';
  });

  check('同时提供具名导出 ServiceTicketPlugin', () => {
    assert(typeof rawModule.ServiceTicketPlugin === 'function', '缺少具名导出');
    assert(rawModule.ServiceTicketPlugin === rawModule.default, '具名导出与 default 不一致');
    return 'ok';
  });

  check('package.json main 指向 ./dist/server/index.js，且兼容范围覆盖冻结版本', () => {
    const pkg = requireFromApp('@local/service-ticket/package.json');
    assert(pkg.main === './dist/server/index.js', `main=${pkg.main}`);
    // supportedVersions 与冻结 tag 从 expected-versions.mjs 取，不在这里硬编码 '2.x'：
    // 硬编码的表现是"升级了 NocoBase、pin 也改了，但这行断言照样绿"。
    const supported = pkg.nocobase?.supportedVersions || [];
    const major = NOCOBASE_VERSION.split('.')[0];
    assert(
      supported.some((v) => String(v).startsWith(major)),
      `supportedVersions=${JSON.stringify(supported)} 未覆盖冻结版本 ${NOCOBASE_VERSION}`,
    );
    return `v${pkg.version} / 支持 ${supported.join(',')} / 冻结 ${NOCOBASE_IMAGE}`;
  });

  // ---------------------------------------------------------------- 守卫
  // ⚠️ **fail-fast，而不是继续跑**。
  //
  // 真实踩过（P5-1）：产物里新增了 `require('@nocobase/utils')`，而假应用没有
  // 对应桩 → 上面第 1 条就失败。当时脚本**继续往下跑**，于是后面一批
  // **遍历型**断言在"0 张表 / 0 个索引字段"上原地"通过"：
  //     ✅ 全部集合都启用了 underscored — **0 张表**均 underscored: true
  //     ✅ 索引字段名全部为下划线小写 — **0 个索引字段**
  //     ✅ 每张表的字段都有 name 且无重复 — ok
  // 这正是本项目最怕的假绿（铁律 10：**"读到空"是最坏的假绿**）——
  // 它会让一次"插件完全加载不起来"的故障，在报告里看起来只红了 1 条。
  //
  // 所以这里直接中止：先修 require 失败（看 scaffold() 里少桩了哪个模块），
  // 再看真正的断言结果。**宁可响亮地停在第 4 条**，也不要 40 条假绿。
  if (!rawModule || typeof rawModule !== 'object') {
    console.log('');
    console.log('  ⛔ 插件产物无法被解析（require 失败）—— 后续断言会在空集合上退化成假绿，故中止。');
    console.log('     多半是产物 require 了假应用未提供桩的模块，见本文件 scaffold() 的说明。');
    console.log('');
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }

  // ---------------------------------------------------------------- 2. 实例化 + load()
  console.log('');
  console.log('【2】生命周期 load()');

  const presentTables = EXPECTED_COLLECTIONS.map(toTableName);
  const { app: fakeApp } = makeFakeApp({ presentTables });

  let plugin = null;
  await checkAsync('new Plugin(app, options) 可实例化', () => {
    plugin = new PluginClass(fakeApp, {
      name: 'service-ticket',
      packageName: '@local/service-ticket',
      enabled: true,
    });
    assert(plugin, '实例为空');
    return 'ok';
  });

  await checkAsync('load() 无异常完成', async () => {
    await plugin.load();
    return 'ok';
  });

  check(`注册了 ${EXPECTED_COLLECTIONS.length} 张表`, () => {
    assert(
      fakeApp.db.collections.size === EXPECTED_COLLECTIONS.length,
      `实际 ${fakeApp.db.collections.size} 张：${[...fakeApp.db.collections.keys()].join(', ')}`,
    );
    return [...fakeApp.db.collections.keys()].join(', ');
  });

  check('集合名与 docs/DATA-MODEL.md 一致', () => {
    const missing = EXPECTED_COLLECTIONS.filter((n) => !fakeApp.db.collections.has(n));
    assert(missing.length === 0, `缺少：${missing.join(', ')}`);
    return 'ok';
  });

  check('集合名 → 表名映射与 EXPECTED_TABLE_NAMES 自洽', () => {
    const derived = EXPECTED_COLLECTIONS.map(toTableName);
    assert(
      JSON.stringify(derived) === JSON.stringify(presentTables),
      `推导结果 ${derived.join(',')} 与清单 ${presentTables.join(',')} 不一致`,
    );
    return presentTables.join(', ');
  });

  // ---- 命名策略（Phase 1 真机踩坑后的回归防线，见 docs/DEVIATIONS.md DEV-14） ----
  check('全部集合都启用了 underscored（表名/时间戳落库为下划线）', () => {
    const offenders = [];
    for (const [name, options] of fakeApp.db.collections) {
      if (options.underscored !== true) offenders.push(name);
    }
    assert(
      offenders.length === 0,
      `未开启 underscored：${offenders.join(', ')} —— NocoBase 默认会建成驼峰表名/驼峰时间戳列，` +
        `与 docs/DATA-MODEL.md、EXPECTED_TABLE_NAMES、scripts/smoke-test.mjs 全部对不上`,
    );
    return `${fakeApp.db.collections.size} 张表均 underscored: true`;
  });

  check('没有 collection 绕过 defineAppCollection 直接调 defineCollection', () => {
    const dir = path.join(ROOT, 'nocobase', 'plugins', 'service-ticket', 'src', 'server', 'collections');
    const offenders = [];
    const scanned = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.ts') || f === '_helpers.ts') continue;
      scanned.push(f);
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      if (/\bdefineCollection\s*\(/.test(src)) offenders.push(f);
    }
    assert(offenders.length === 0, `以下文件直接使用了 defineCollection：${offenders.join(', ')}`);
    return `${scanned.length} 个 collection 文件已检查`;
  });

  check('索引字段名全部为下划线小写（与 underscored 后的实际列名一致）', () => {
    const offenders = [];
    let total = 0;
    for (const [name, options] of fakeApp.db.collections) {
      for (const idx of options.indexes || []) {
        for (const f of idx.fields || []) {
          const key = typeof f === 'string' ? f : f?.name;
          if (!key) continue;
          total += 1;
          if (key !== key.toLowerCase()) offenders.push(`${name}.${key}`);
        }
      }
    }
    assert(
      offenders.length === 0,
      `索引字段含大写，生成 SQL 后会因列名不匹配报 42703 undefined_column：${offenders.join(', ')}`,
    );
    return `${total} 个索引字段`;
  });

  check('没有集合使用 NocoBase 核心已占用的保留名', () => {
    // NocoBase 核心（plugin-system-settings / plugin-acl / plugin-users 等）已定义这些集合，
    // 插件若重名，registerCollections() 的 hasCollection() 会判"已存在"而**静默跳过注册**，
    // 随后写参数会打到核心表上报 `column systemSettings.key does not exist`。
    const RESERVED = ['systemSettings', 'users', 'roles', 'attachments', 'collections', 'fields'];
    const offenders = RESERVED.filter((n) => fakeApp.db.collections.has(n));
    assert(
      offenders.length === 0,
      `以下集合名与 NocoBase 核心冲突，会被静默跳过：${offenders.join(', ')}`,
    );
    return `已比对 ${RESERVED.length} 个保留名`;
  });

  check('每张表的字段都有 name 且无重复', () => {
    for (const [name, options] of fakeApp.db.collections) {
      const fields = options.fields || [];
      assert(fields.length > 0, `${name} 没有字段`);
      const seen = new Set();
      for (const f of fields) {
        assert(f && typeof f.name === 'string' && f.name.length > 0, `${name} 存在无名字段`);
        assert(!seen.has(f.name), `${name}.${f.name} 重复定义`);
        seen.add(f.name);
      }
    }
    return 'ok';
  });

  check('唯一约束关键项存在（ticket_no / access_token_hash / feedback_token_hash）', () => {
    const t = fakeApp.db.collections.get('serviceTickets');
    const v = fakeApp.db.collections.get('serviceVisits');
    const hasUnique = (options, field) =>
      (options.fields || []).some((f) => f.name === field && f.unique === true);
    assert(hasUnique(t, 'ticket_no'), 'serviceTickets.ticket_no 未设 unique');
    assert(hasUnique(t, 'feedback_token_hash'), 'serviceTickets.feedback_token_hash 未设 unique');
    assert(hasUnique(v, 'access_token_hash'), 'serviceVisits.access_token_hash 未设 unique');
    return 'ok';
  });

  check('smsLogs 有 (provider, biz_id) 复合唯一索引（回执幂等）', () => {
    const sms = fakeApp.db.collections.get('smsLogs');
    const found = (sms.indexes || []).some(
      (ix) =>
        ix.unique === true &&
        ix.fields.length === 2 &&
        ix.fields.includes('provider') &&
        ix.fields.includes('biz_id'),
    );
    assert(found, '未找到 (provider, biz_id) 唯一索引');
    return 'ok';
  });

  // ---- 索引声明清单守卫（Phase 1 真机踩坑后的回归防线，见 docs/DEVIATIONS.md DEV-16 / DEV-17） ----
  check('collection 级索引声明与 expected-indexes.mjs 清单逐条一致（不多不少）', () => {
    // 真机教训（DEV-16）：NocoBase 的 collection.refreshIndexes() 会把「列尚未注册到 model」
    // 的声明式索引**静默丢弃** —— 不报错、不告警，表照样建出来，只有索引没了。
    // 因此真机侧由 ensureIndexes() 兜底补建、smoke-test.mjs 落地核对；
    // 离线侧则在这里守住「源码里到底声明了哪些索引」，防止有人顺手删掉一条声明后，
    // 真机清单跟着一起「绿」掉 —— 清单与声明同时缺失，是这个坑最恶性的马甲形态。
    const tableToCollection = new Map();
    for (const name of EXPECTED_COLLECTIONS) tableToCollection.set(toTableName(name), name);

    const normalize = (fields) =>
      (fields || []).map((f) => (typeof f === 'string' ? f : f?.name)).filter(Boolean);

    /** @type {Map<string, Map<string, {unique: boolean, order: string}>>} */
    const declared = new Map();
    for (const [table, collectionName] of tableToCollection) {
      const options = fakeApp.db.collections.get(collectionName);
      assert(options, `未注册 collection ${collectionName}`);
      const bySig = new Map();
      for (const idx of options.indexes || []) {
        const cols = normalize(idx.fields);
        bySig.set(indexSignature(cols), { unique: idx.unique === true, order: cols.join(', ') });
      }
      declared.set(table, bySig);
    }

    const problems = [];
    let checked = 0;

    // ① 清单要求的每一条 collection 级索引，源码里都必须声明
    for (const [table, items] of Object.entries(EXPECTED_INDEXES)) {
      const bySig = declared.get(table);
      if (!bySig) {
        problems.push(`${table}: 清单里有该表，但插件未注册同名 collection`);
        continue;
      }
      for (const item of items) {
        if (item.from !== 'collection') continue; // 字段级 unique 不落 indexes 数组
        checked += 1;
        const hit = bySig.get(indexSignature(item.columns));
        if (!hit) {
          problems.push(
            `${table}(${item.columns.join(', ')})${item.unique ? ' UNIQUE' : ''}: 清单要求但源码未声明`,
          );
        } else if (item.unique === true && hit.unique !== true) {
          problems.push(`${table}(${item.columns.join(', ')}): 清单要求唯一，源码声明为非唯一`);
        }
      }
    }

    // ② 反向：源码声明的也不许多出清单之外（防「清单漏登记」造成保护盲区）
    for (const [table, bySig] of declared) {
      const listed = new Set(
        (EXPECTED_INDEXES[table] || [])
          .filter((i) => i.from === 'collection')
          .map((i) => indexSignature(i.columns)),
      );
      for (const [sig, meta] of bySig) {
        if (!listed.has(sig)) {
          problems.push(
            `${table}(${meta.order}): 源码已声明但清单未登记 —— 请同步 expected-indexes.mjs 与 docs/DATA-MODEL.md §13`,
          );
        }
      }
    }

    assert(problems.length === 0, `索引声明与清单不一致：\n      - ${problems.join('\n      - ')}`);
    return `${checked} 条 collection 级索引逐条对齐`;
  });

  check('无重复同义索引声明（同一列集合只声明一次，见 DEV-17）', () => {
    const dupes = [];
    for (const [name, options] of fakeApp.db.collections) {
      const seen = new Map();
      for (const idx of options.indexes || []) {
        const cols = (idx.fields || [])
          .map((f) => (typeof f === 'string' ? f : f?.name))
          .filter(Boolean);
        const sig = indexSignature(cols);
        if (seen.has(sig)) dupes.push(`${name}(${cols.join(', ')}) 重复声明 ${seen.get(sig) + 1} 次`);
        seen.set(sig, (seen.get(sig) || 0) + 1);
      }
    }
    assert(dupes.length === 0, `存在重复索引声明：${dupes.join('; ')}`);
    return 'ok';
  });

  check('注册了 resource svc 且含全部已声明 action', () => {
    const svc = fakeApp.resourcer.getResource('svc');
    assert(svc, '未注册 resource svc');
    // 期望集合来自 constants.ts（单一事实来源），不在此处复写数量：
    // guardQuota（Phase 3-E）与派工三动作 + 两个 mock-only 探针（Phase 4）同挂在 svc 上，
    // 它们走不同的 ACL 条件，但**资源归属**都是 svc。
    const { all } = readSvcActionSets();
    for (const name of all) {
      assert(typeof svc.actions?.[name] === 'function', `${name} action 不是函数`);
    }
    return all.map((n) => `/api/svc:${n}`).join(', ');
  });

  check('svc 资源用 only 收敛：原生 CRUD 一律不在其中（默认拒绝）', () => {
    // Resource 构造时会把 resourcer 上所有全局 handler（list/create/update/destroy…）
    // 先合并进 actions，再由 only 反选出 except。不收敛的后果是
    // /api/svc:update 这类原生写接口直接可用 —— 绕过状态机与事件时间线。
    const svc = fakeApp.resourcer.getResource('svc');
    const { all } = readSvcActionSets();
    // 比**集合**而非顺序：NocoBase 内部对 only 做过排序/去重，
    // 逐位比较会在升级时无故变红（工程铁律 2）。
    const actual = [...new Set(svc.only || [])].sort();
    const expected = [...new Set(all)].sort();
    assert(
      JSON.stringify(actual) === JSON.stringify(expected),
      `only 集合与 SVC_ACTION 不一致：\n         实际 ${JSON.stringify(actual)}\n         期望 ${JSON.stringify(expected)}`,
    );
    for (const native of ['list', 'get', 'create', 'update', 'destroy', 'export', 'import']) {
      assert(!svc.only.includes(native), `only 里混入了原生 action：${native}`);
    }
    return `only=[${svc.only.join(', ')}]`;
  });

  check('action 名全部为单段（多段名在 NocoBase 不可达，见 DEV-18）', () => {
    // parseRequest 对 /api/<a>:<b>:<c> 只 split(":") 一次，第三段被静默丢弃 →
    // `svc:tickets:accept` 会解析成 action=tickets 并落到 404。
    const svc = fakeApp.resourcer.getResource('svc');
    const offenders = svc.only.filter((n) => n.includes(':') || n.includes('/'));
    assert(offenders.length === 0, `action 名含分隔符：${offenders.join(', ')}`);
    return svc.only.join(', ');
  });

  check('匿名白名单恰好 11 条，且不存在第 12 条', () => {
    // 这条断言的价值在**逐条枚举**而不是数个数：
    // acl.allow(x, y) 不传第三个参数时默认就是 'public' ——
    // 一次手滑写成 acl.allow('svc','cancel') 就能让任意人取消任意工单，
    // 而"多了一条 public"只看数量是看不出来的（除非本来就在数）。
    //
    // 期望值（Phase 7 后）：
    //   svc:health             —— 运维探针，无业务数据
    //   svc:guardQuota         —— 限流额度诊断；ACL 匿名但 handler 校验 X-Svc-Diag-Key，
    //                             key 缺失/不符一律 404（fail-closed），见 DEV-28
    //   publicStore:list       —— Phase 3-A 门店下拉（只回 code/name）
    //   publicTicket:create    —— Phase 3-B 客户匿名报修（四类守卫 + 幂等 + 频控）
    //   technicianVisit:get    —— Phase 5 师傅读取作业上下文（Token 即凭证）
    //   technicianVisit:upload —— Phase 5 师傅上传照片
    //   technicianVisit:submit —— Phase 5 师傅提交完工
    //   technicianVisit:photo  —— Phase 5 师傅**受控读取**自己那单的照片（P5-1）
    //   publicReview:get       —— Phase 7 客户打开评价页（一次性 Token 即凭证）
    //   publicReview:submit    —— Phase 7 客户提交评价（**会推进核心状态**）
    //   publicReview:sweepProbe —— Phase 7 **探针**：手动触发一轮评价超时扫描。
    //                             非业务接口，只给门禁/排障用；能力上限是"把已到期的
    //                             WAIT_FEEDBACK 关掉"（幂等 no-op），**只回计数**、
    //                             不回任何客户数据。自带自毁闸：短信通道非 mock ⇒ 404。
    //                             （存在的理由：让门禁触发与 cron 任务**完全相同**的
    //                              代码路径，而不是门禁自己写一份 SQL 谓词。）
    //
    // ⚠️ 后六条是**本清单里唯一"匿名且能读到工单内容、能写数据"**的一组。
    //    ACL 只负责"这一步不用登录"，鉴权全在 handler 里
    //    （师傅：401 TOKEN_INVALID；评价：Token 形状 + hash 命中，统一 404）。
    //    新增/删除这里的任一条，都必须同时改本断言 + `ANONYMOUS_RESOURCE_SHAPES`。
    //
    //    为什么照片读取也走这里而不是 NocoBase 的 `/files/`：后者是**登录态**
    //    受控端点，把匿名师傅塞进去等于"让匿名请求通过登录校验"。
    //    挂在同一资源下还有一个好处：与上传/提交共用同一套认证与同一个限流区。
    //
    //    ⚠️ 为什么评价**读也要单列**（而不是只列 submit）：GET 会返回
    //    `confirmed_charge_amount`（门店收费事实）。它不返回 id/手机号，
    //    但它是"任一持有合法 Token 的人都能读到的业务数据"，
    //    因此必须像其它匿名读端点一样被逐条声明、而不是被当成"读不算暴露面"。
    const pub = fakeApp.acl.allowed.filter(([, , cond]) => cond === 'public');
    const actual = pub.map(([r, a]) => `${r}:${a}`).sort();
    const expected = [
      'publicReview:get',
      'publicReview:submit',
      'publicReview:sweepProbe',
      'publicStore:list',
      'publicTicket:create',
      'svc:guardQuota',
      'svc:health',
      'technicianVisit:get',
      'technicianVisit:photo',
      'technicianVisit:submit',
      'technicianVisit:upload',
    ];
    assert(
      JSON.stringify(actual) === JSON.stringify(expected),
      `匿名白名单为 ${JSON.stringify(actual)}，期望恰好 ${JSON.stringify(expected)} —— ` +
        '多一条少一条都要先解释清楚"它是给谁用的、怎么自守"，再改这条断言',
    );
    return actual.join(', ');
  });

  check('匿名资源形态：public* 只读/只建、technicianVisit 只 get/upload/submit/photo、publicReview 只 get/submit/sweepProbe，原生 CRUD 不可达', () => {
    // 与 svc 同样用真实 Resource.getAction() 回读，而不是只看我们传进去的 only。
    // 匿名资源比 svc 更值得钉死：它**不要登录态**，
    // 一旦 only 写漏（比如把 list 之外的 create 漏进去），
    // 就是"公网上可以直接建/删数据"。
    const shapes = [
      { resource: 'publicStore', allowed: ['list'] },
      { resource: 'publicTicket', allowed: ['create'] },
      // Phase 5：三个 action 都匿名。**`list` 必须不可达** ——
      // 它一旦可达就是"不登录枚举全部 Visit"，连带暴露 access_token_hash。
      { resource: 'technicianVisit', allowed: ['get', 'upload', 'submit', 'photo'] },
      // Phase 7：评价。**`list` 必须不可达** ——
      // 它一旦可达就是"匿名枚举全部评价"，连带暴露 feedback_token_hash
      // 与客户的 rating/review_comment。
      { resource: 'publicReview', allowed: ['get', 'submit', 'sweepProbe'] },
    ];
    const native = ['list', 'get', 'create', 'update', 'destroy', 'export', 'import'];

    for (const { resource, allowed } of shapes) {
      const res = fakeApp.resourcer.getResource(resource);
      assert(res, `未注册 resource ${resource}`);
      assert(
        res.only?.length === allowed.length,
        `${resource}.only 应为 ${allowed.length} 条，实际 ${JSON.stringify(res.only)}`,
      );
      for (const name of allowed) {
        let detail = null;
        try {
          res.getAction(name);
        } catch (err) {
          detail = err.message;
        }
        assert(detail === null, `${resource}:${name} 不可达：${detail}`);
      }
      const leaked = native.filter((n) => !allowed.includes(n) && res.only.includes(n));
      assert(leaked.length === 0, `${resource} 暴露了原生 action：${leaked.join(', ')}`);
      // `list` 单独再钉一次：technicianVisit / publicReview 都不带它，
      // 但 publicStore 也不带 —— 这类"枚举型" action 是匿名资源上
      // 最危险的单个动作，值得独立成一条断言。
      // ⚠️ publicTicket 的 allowed 里**没有** get/list，但 `list` 也不在其中，
      //    所以这里用"除 publicStore 外一律不许有 list"表达：
      //    publicStore 本来就是为了"下拉"而存在的枚举接口（只回 code/name）。
      if (resource !== 'publicStore') {
        assert(
          !res.only.includes('list'),
          `${resource} 暴露了 list —— 匿名枚举，最危险的一条`,
        );
      }
    }
    return 'publicStore:list + publicTicket:create + technicianVisit:get/upload/submit/photo + publicReview:get/submit/sweepProbe';
  });

  check('对外拒绝类错误带框架认识的 logLevel（否则越权 404 会记成 error 级）', () => {
    // 背景（真机踩过）：
    //   @nocobase/plugin-error-handler 兜住异常后**一定会写一条日志**，级别这样定：
    //     const logMethods = ['trace','debug','info','warn','error'];
    //     getLogMethod(err) => logMethods.includes(err?.logLevel) ? err.logLevel : 'error'
    //   中间件层抛出的 NotFoundError/ForbiddenError 会直接落到它手里，于是
    //   "越权 get 他店 → 404"（docs/API.md §0 明文要求的行为）在日志里变成
    //   {"level":"error","message":"工单 10 不存在"} —— 应用日志被预期噪声淹没，
    //   "无 error 日志"这条运维断言直接失效（冒烟第 4 项曾因此变红）。
    //
    // 两个必须钉死的点：
    //   1) 级别必须是框架**认识**的字符串。写成 'warning' 这种，includes() 为 false
    //      → 静默回落成 'error'，行为退化且不报错 —— 只有断言能抓住。
    //   2) 级别不能是 'error'。NotFoundError 用 'debug'（404 是刻意不可区分的
    //      对外语义，正常陈旧书签/刷新已删工单都会产生，不能当信号）；
    //      ForbiddenError 用 'warn'（401/403 指向权限错配或在被试探，值得看一眼）。
    const FRAMEWORK_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];
    const NotFound = rawModule.NotFoundError;
    const Forbidden = rawModule.ForbiddenError;
    assert(typeof NotFound === 'function', '未导出 NotFoundError（离线校验无法钉级别）');
    assert(typeof Forbidden === 'function', '未导出 ForbiddenError（离线校验无法钉级别）');

    const cases = [
      ['NotFoundError', new NotFound(), 404, 'debug'],
      ['ForbiddenError(能力不足)', new Forbidden('NO_CAPABILITY', 'x'), 403, 'warn'],
      ['ForbiddenError(未登录)', new Forbidden('UNAUTHENTICATED', 'x'), 401, 'warn'],
    ];
    for (const [label, err, status, level] of cases) {
      assert(err.status === status, `${label}.status=${err.status}，期望 ${status}`);
      assert(err.statusCode === status, `${label}.statusCode=${err.statusCode}，期望 ${status}`);
      assert(
        FRAMEWORK_LEVELS.includes(err.logLevel),
        `${label}.logLevel=${JSON.stringify(err.logLevel)} 不是框架认识的级别 ` +
          `（${FRAMEWORK_LEVELS.join('/')}）—— error-handler 会静默回落成 error`,
      );
      assert(
        err.logLevel !== 'error',
        `${label}.logLevel 不能是 'error'：预期内的拒绝若记成 error 级，` +
          '"app 日志无 error"这条运维断言就失去意义',
      );
      assert(err.logLevel === level, `${label}.logLevel=${err.logLevel}，期望 ${level}`);
    }
    return 'NotFound=404/debug, Forbidden=401|403/warn';
  });

  check('每个自定义 Error 类都在 statusOf() 里有分支（否则静默变 500）', () => {
    // ---------------------------------------------------------------- DEV-75
    // 这条断言来自一个**潜伏了两个阶段**的真实缺陷：
    //   `statusOf()` 是按 `instanceof` 分支的，而 `VisitValidationError`
    //   一直**没有**对应分支（`_http.ts` 顶部 import 了它，却从未使用）。
    //   于是 `VisitService`/`PhotoService` 抛出的每一类业务拒绝
    //   都会被映射成 `500 INTERNAL_ERROR`：
    //     张数超限应为 422 PHOTO_LIMIT_REACHED → 实得 500
    //     非图片应为 415 UNSUPPORTED_IMAGE    → 实得 500
    //     超大应为 413 PHOTO_TOO_LARGE        → 实得 500
    //   它为什么难被发现：**不报错、不崩、不记 error**，只是状态码不对。
    //   旧断言也全都是绿的 —— 因为此前没有任何用例把 `VisitValidationError`
    //   经 HTTP action 打出来（改派那条路上的业务拒绝抛的是 `ValidationError`）。
    //
    // 为什么做成**结构性**断言而不是补一个用例：
    //   补用例只能证明"今天这 6 个类接线正确"。下一个新增错误类照样能静默 500。
    //   这里改成"枚举 → 比对"：源码里**每一个** `export class *Error extends`
    //   都必须能在 `statusOf()` 里找到 `instanceof`。新增类忘了接线 → 立刻变红。
    //
    // ⚠️ 断言必须能被反向证明（本项目铁律 8）。因此末尾带自检：
    //    给解析器喂一份"多了一个未接线错误类"的合成源码，它**必须**报出来。
    //    自检不通过 = 这条闸门是假绿。
    const servicesDir = path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/services');
    const httpPath = path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/actions/svc/_http.ts');

    const collectDeclared = (sources) => {
      const found = new Set();
      for (const text of sources) {
        const re = /export\s+class\s+(\w+Error)\s+extends\s+\w+/g;
        let m;
        while ((m = re.exec(text)) !== null) found.add(m[1]);
      }
      return found;
    };
    // 只取 `statusOf()` 的函数体 —— 文件里别处也可能出现 `instanceof`，
    // 取全文会把"注释里提到过这个名字"误当成"接了线"。
    const collectMapped = (httpSource) => {
      const start = httpSource.indexOf('export function statusOf(');
      assert(start >= 0, '在 _http.ts 里找不到 statusOf() —— 断言本身失效了，请先修脚本');
      const body = httpSource.slice(start, httpSource.indexOf('\n}', start));
      const found = new Set();
      const re = /instanceof\s+(\w+Error)/g;
      let m;
      while ((m = re.exec(body)) !== null) found.add(m[1]);
      return { found, body };
    };

    assert(fs.existsSync(servicesDir), `找不到 ${servicesDir}`);
    const serviceSources = fs
      .readdirSync(servicesDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => fs.readFileSync(path.join(servicesDir, f), 'utf8'));
    const declared = collectDeclared(serviceSources);
    const { found: mapped } = collectMapped(fs.readFileSync(httpPath, 'utf8'));

    // 自检：合成一份"含未接线错误类"的源码，解析器必须报出来（防这条断言假绿）
    const synthetic = collectDeclared(['export class GhostError extends Error {}']);
    const syntheticMapped = collectMapped('export function statusOf(e){ if (e instanceof RateLimitedError) {} \n}').found;
    const ghostMissed = [...synthetic].filter((n) => !syntheticMapped.has(n));
    assert(
      ghostMissed.length === 1 && ghostMissed[0] === 'GhostError',
      '自检失败：解析器认不出"新增但未接线"的错误类 —— 这条断言无法变红，等于没有断言',
    );

    assert(
      declared.size > 0,
      '一个自定义 Error 类都没扫到 —— 解析规则与源码形态不匹配（比"全绿"更坏的假绿）',
    );
    const missing = [...declared].filter((n) => !mapped.has(n)).sort();
    assert(
      missing.length === 0,
      `${missing.join(', ')} 没有 statusOf() 分支 —— 它们抛出时会被静默映射成 500。` +
        '请在 actions/svc/_http.ts 的 statusOf() 里补 `instanceof` 分支' +
        '（status 由错误实例自带，别按 code 二次判定）',
    );
    return `${declared.size} 个错误类全部接线（${[...declared].sort().join(', ')}）`;
  });

  check('除 health/guardQuota 外的全部业务 action 走 loggedIn（要求登录，而不是匿名放行）', () => {
    // loggedIn 与 public 的差别是安全关键：public 会让 auth 中间件 skipCheck()
    // 直接跳过 token 校验（isPublic 只认 'public' 条件），
    // 于是既没有登录态、也没有 ctx.state.currentUser ——
    // 服务层 resolveActor 会 401，但 ACL 已整体放行，等于把接口挂在公网上等人打。
    //
    // 期望集合 = AUTHENTICATED_SVC_ACTIONS（源码常量），而不是手抄一份名单：
    // 手抄的那份在 Phase 4 加动作时立刻过期，且过期方向恰好是"漏保护新接口"。
    const loggedIn = fakeApp.acl.allowed.filter(([, , cond]) => cond === 'loggedIn');
    const actions = loggedIn.filter(([r]) => r === 'svc').map(([, a]) => a).sort();
    const { authenticated } = readSvcActionSets();
    assert(
      JSON.stringify(actions) === JSON.stringify([...authenticated].sort()),
      `loggedIn 集合与 AUTHENTICATED_SVC_ACTIONS 不一致：\n         实际 ${JSON.stringify(actions)}\n         期望 ${JSON.stringify([...authenticated].sort())}`,
    );
    for (const [, , cond] of loggedIn) {
      assert(cond !== 'public', 'loggedIn 白名单里混进了 public');
    }
    // 反向也要钉死：health / guardQuota 必须在白名单里**匿名可达**，
    // 否则监控探活会 401、并发预检拿不到本机额度。
    for (const [, a, cond] of fakeApp.acl.allowed.filter(([r]) => r === 'svc')) {
      if (!authenticated.includes(a)) {
        assert(cond === 'public', `${a} 既不是 loggedIn 也不是 public（cond=${cond}）`);
      }
    }
    return actions.join(', ');
  });

  check('门店隔离中间件已挂载，且声明在 acl 之后', () => {
    const used = fakeApp.resourcer._used;
    assert(used.length === 1, `resourcer 级中间件数量 ${used.length}，期望 1`);
    const [entry] = used;
    assert(typeof entry.middleware === 'function', '中间件不是函数');
    assert(entry.options.group === 'store-scope', `group=${entry.options.group}`);
    // 顺序不能靠注册先后碰运气：NocoBase 用 Toposort 排序，
    // ACL 中间件是以 {group:'acl', after:'auth'} 挂的，所以这里必须 after:'acl'。
    assert(entry.options.after === 'acl', `after=${entry.options.after}`);
    return "group=store-scope after=acl";
  });

  check('load() 后健康状态为 ready', () => {
    assert(plugin.healthState.ready === true, 'ready 不为 true');
    assert(plugin.healthState.registeredCollections === EXPECTED_COLLECTIONS.length, '计数不符');
    const { all } = readSvcActionSets();
    assert(
      plugin.healthState.registeredSvcActions === all.length,
      `svc action 数 ${plugin.healthState.registeredSvcActions}，期望 ${all.length}（= SVC_ACTION 成员数）`,
    );
    assert(plugin.healthState.rolesInAcl === 4, `ACL 角色数 ${plugin.healthState.rolesInAcl}`);
    return `loadedAt=${plugin.healthState.loadedAt}`;
  });

  // ---------------------------------------------------------------- 3. 健康检查
  console.log('');
  console.log('【3】健康检查 GET /api/svc:health');

  const healthHandler = fakeApp.resourcer.getResource('svc').actions.health;

  await checkAsync('返回 200 且 db=ok / sms=mock / tasksOverall=ok（Phase 8 起口径）', async () => {
    const ctx = makeFakeContext(fakeApp);
    await healthHandler(ctx, async () => {});
    assert(ctx.status === 200, `status=${ctx.status}`);
    assert(ctx.body.db === 'ok', `db=${ctx.body.db}`);
    assert(ctx.body.sms === 'mock', `sms=${ctx.body.sms}`);
    // ⚠️ Phase 8 / P8-A：`tasks` 已从字符串转为**每任务运行快照对象**（契约 §4）。
    //    注意 `makeFakeContext` 的桩不含 services.tasks，因此快照可能为空对象 ——
    //    这里断言的是"字段形状变了"，不是"任务一定跑过"（那需要真实运行态）。
    assert(ctx.body.tasksOverall === 'ok', `tasksOverall=${ctx.body.tasksOverall}`);
    assert(
      ctx.body.tasks && typeof ctx.body.tasks === 'object',
      `tasks 应为对象，实际 ${typeof ctx.body.tasks}`,
    );
    assert(ctx.body.status === 'ok', `status=${ctx.body.status}`);
    return JSON.stringify({
      db: ctx.body.db,
      sms: ctx.body.sms,
      tasksOverall: ctx.body.tasksOverall,
    });
  });

  await checkAsync('health 新增 Phase 8 可发现性字段（smsRetry / sla*）存在', async () => {
    const ctx = makeFakeContext(fakeApp);
    await healthHandler(ctx, async () => {});
    // ⚠️ 字段必须存在（值可为 null = "本次没查到"）。
    //    null 与 0 语义不同：0 是"确实没有失败"，null 是"这次没查到" ——
    //    监控必须能区分，否则查不到会被读成"一切正常"。
    for (const key of [
      'smsRetryPending',
      'smsTerminalFailed',
      'slaAcceptanceOverdue',
      'slaAppointmentOverdue',
      'slaStoreConfirmOverdue',
    ]) {
      assert(key in ctx.body, `health 缺少字段 ${key}`);
    }
    return 'smsRetryPending / smsTerminalFailed / sla* ×3 均在';
  });

  await checkAsync('表数量统计正确（11/11，无缺失）', async () => {
    const ctx = makeFakeContext(fakeApp);
    await healthHandler(ctx, async () => {});
    assert(ctx.body.tablesExpected === 11, `tablesExpected=${ctx.body.tablesExpected}`);
    assert(ctx.body.tablesPresent === 11, `tablesPresent=${ctx.body.tablesPresent}`);
    assert(ctx.body.missingTables.length === 0, `missing=${ctx.body.missingTables.join(',')}`);
    return '11/11';
  });

  await checkAsync('settingsSeeded 以数据库为准（进程重启后不假阴性）', async () => {
    // 场景 A：模拟"应用重启后" —— 进程内标志归零，但库里的参数一条不少
    const allKeys = readDefaultSettingKeys();
    const { app: restartedApp } = makeFakeApp({
      presentTables,
      seededSettings: allKeys.map((key, i) => ({ key, value: String(i) })),
    });
    const restartedPlugin = new PluginClass(restartedApp, {
      name: 'service-ticket',
      packageName: '@local/service-ticket',
      enabled: true,
    });
    await restartedPlugin.load();
    restartedPlugin.healthState.settingsSeeded = false; // 重启后必然归零
    const ctxA = makeFakeContext(restartedApp);
    await restartedApp.resourcer.getResource('svc').actions.health(ctxA, async () => {});
    assert(
      ctxA.body.settingsSeeded === true,
      `库里有 ${allKeys.length} 条参数却报 settingsSeeded=${ctxA.body.settingsSeeded}（假阴性）`,
    );

    // 场景 B：库里一条都没有 → 必须报 false
    const { app: emptyApp } = makeFakeApp({ presentTables });
    const emptyPlugin = new PluginClass(emptyApp, {
      name: 'service-ticket',
      packageName: '@local/service-ticket',
      enabled: true,
    });
    await emptyPlugin.load();
    const ctxB = makeFakeContext(emptyApp);
    await emptyApp.resourcer.getResource('svc').actions.health(ctxB, async () => {});
    assert(ctxB.body.settingsSeeded === false, `库里没有参数却报 ${ctxB.body.settingsSeeded}`);

    // 场景 C：库里有 —— 但少了一条 → 必须报 false（"全部默认键都在"才算齐）
    const { app: partialApp } = makeFakeApp({
      presentTables,
      seededSettings: allKeys.slice(0, -1).map((key) => ({ key, value: '1' })),
    });
    const partialPlugin = new PluginClass(partialApp, {
      name: 'service-ticket',
      packageName: '@local/service-ticket',
      enabled: true,
    });
    await partialPlugin.load();
    const ctxC = makeFakeContext(partialApp);
    await partialApp.resourcer.getResource('svc').actions.health(ctxC, async () => {});
    assert(ctxC.body.settingsSeeded === false, `少了 1 条却报 ${ctxC.body.settingsSeeded}`);

    return `库中齐全→true / 0 条→false / 少 1 条→false`;
  });

  await checkAsync('stores/roles/roleStrategies 三个 Seeded 以库为准（迁移补种后不假阴性）', async () => {
    // 期望值直接取自构建产物导出的常量 —— 不在脚本里再抄一份门店编码/角色名，
    // 否则改源码忘了改脚本会双双"绿"掉（与 readDefaultSettingKeys 同一原则）。
    const storeCodes = rawModule.STORE_SEEDS.map((s) => s.code);
    const roleNames = rawModule.ROLE_SEEDS.map((r) => r.name);
    assert(storeCodes.length >= 2, `门店种子只有 ${storeCodes.length} 家，AT-03 会恒真`);
    assert(roleNames.length === 4, `角色种子 ${roleNames.length} 个，期望 4`);

    // 资源级授权的期望行数同样取自构建产物（4 角色 × 4 资源 = 16）
    const readResources = rawModule.ROLE_NATIVE_READ_RESOURCES;
    assert(
      Array.isArray(readResources) && readResources.length > 0,
      'ROLE_NATIVE_READ_RESOURCES 没导出或为空',
    );
    const expectedResourceRows = roleNames.length * readResources.length;
    const seedResourceRows = roleNames.flatMap((roleName) =>
      readResources.map((name) => ({ roleName, dataSourceKey: 'main', name })),
    );

    const withPlugin = async (app) => {
      const p = new PluginClass(app, {
        name: 'service-ticket',
        packageName: '@local/service-ticket',
        enabled: true,
      });
      await p.load();
      return p;
    };

    // 场景 A：基线数据由**迁移**写入，插件本进程一个都没播过（真机实际形态）
    const { app: migApp } = makeFakeApp({
      presentTables,
      seededSettings: readDefaultSettingKeys().map((key) => ({ key, value: '1' })),
      seededStores: storeCodes.map((code) => ({ code, name: code })),
      seededRoles: roleNames.map((name) => ({ name })),
      seededDsRoles: roleNames.map((name) => ({ roleName: name, dataSourceKey: 'main' })),
      seededDsResources: seedResourceRows,
    });
    const migPlugin = await withPlugin(migApp);
    assert(migPlugin.healthState.storesSeededThisRun === 0, '本进程不该播过种（场景前提不成立）');

    const ctxA = makeFakeContext(migApp);
    await migApp.resourcer.getResource('svc').actions.health(ctxA, async () => {});
    assert(ctxA.body.storesSeeded === true, `库里 ${storeCodes.length} 家门店却报 ${ctxA.body.storesSeeded}`);
    assert(ctxA.body.rolesSeeded === true, `4 个角色都在库里却报 ${ctxA.body.rolesSeeded}`);
    assert(
      ctxA.body.roleStrategiesSeeded === true,
      `4 条策略都在库里却报 ${ctxA.body.roleStrategiesSeeded}`,
    );
    assert(
      ctxA.body.roleResourcesSeeded === true,
      `库里 ${expectedResourceRows} 条资源级授权却报 ${ctxA.body.roleResourcesSeeded}`,
    );
    assert(ctxA.body.storesSeededThisRun === 0, '本进程计数应为 0（重启后归零属正常）');

    // 场景 B：roles 表有行、dataSourcesRoles **缺行** —— 这是"角色全员 403"的形态，
    // rolesSeeded 会显示齐备，只有 roleStrategiesSeeded 能把它暴露出来。
    const { app: noStrategyApp } = makeFakeApp({
      presentTables,
      seededSettings: readDefaultSettingKeys().map((key) => ({ key, value: '1' })),
      seededStores: storeCodes.map((code) => ({ code, name: code })),
      seededRoles: roleNames.map((name) => ({ name })),
      // 刻意不写 seededDsRoles
    });
    await withPlugin(noStrategyApp);
    const ctxB = makeFakeContext(noStrategyApp);
    await noStrategyApp.resourcer.getResource('svc').actions.health(ctxB, async () => {});
    assert(ctxB.body.rolesSeeded === true, `roles 表有行，rolesSeeded 应为 true，实际 ${ctxB.body.rolesSeeded}`);
    assert(
      ctxB.body.roleStrategiesSeeded === false,
      'roles 有行但缺 strategy 却报齐备 —— 该角色名下用户会全量 403，探针必须能发现',
    );

    // 场景 C：策略齐、**资源级授权缺一半** —— 这是"部分角色后台能打开、部分全 403"的形态。
    // 判据必须用「行数 ≥ 角色数 × 资源数」，用 ≥1 判会显示 true，把最难查的那种情况盖住。
    const halfRows = seedResourceRows.slice(0, Math.floor(seedResourceRows.length / 2));
    const { app: halfApp } = makeFakeApp({
      presentTables,
      seededSettings: readDefaultSettingKeys().map((key) => ({ key, value: '1' })),
      seededStores: storeCodes.map((code) => ({ code, name: code })),
      seededRoles: roleNames.map((name) => ({ name })),
      seededDsRoles: roleNames.map((name) => ({ roleName: name, dataSourceKey: 'main' })),
      seededDsResources: halfRows,
    });
    await withPlugin(halfApp);
    const ctxHalf = makeFakeContext(halfApp);
    await halfApp.resourcer.getResource('svc').actions.health(ctxHalf, async () => {});
    assert(ctxHalf.body.roleStrategiesSeeded === true, '场景前提不成立：策略应当齐备');
    assert(
      ctxHalf.body.roleResourcesSeeded === false,
      `资源级授权只有 ${halfRows.length}/${expectedResourceRows} 条却报齐备 —— 缺的那一半角色会全量 403`,
    );

    // 场景 D：门店只有 1 家 —— 必须报 false，否则 AT-03（门店隔离）恒真
    const { app: singleStoreApp } = makeFakeApp({
      presentTables,
      seededStores: [{ code: storeCodes[0], name: '唯一门店' }],
      seededRoles: roleNames.map((name) => ({ name })),
      seededDsRoles: roleNames.map((name) => ({ roleName: name, dataSourceKey: 'main' })),
    });
    await withPlugin(singleStoreApp);
    const ctxD = makeFakeContext(singleStoreApp);
    await singleStoreApp.resourcer.getResource('svc').actions.health(ctxD, async () => {});
    assert(
      ctxD.body.storesSeeded === false,
      '只有 1 家门店时报了齐备 —— 门店隔离验收（AT-03）会恒真',
    );

    return '齐全→true / 缺 strategy→false / 资源授权缺半→false / 仅 1 家门店→false';
  });

  await checkAsync('响应不含敏感信息（无连接串/密码/堆栈）', async () => {
    const ctx = makeFakeContext(fakeApp);
    await healthHandler(ctx, async () => {});
    const text = JSON.stringify(ctx.body);
    for (const token of ['password', 'CHANGE_ME', 'postgres://', 'stack', 'secret']) {
      assert(!text.toLowerCase().includes(token.toLowerCase()), `响应中出现敏感片段：${token}`);
    }
    return 'ok';
  });

  await checkAsync('缺表时降级为 503 并列出 missingTables（监控可发现）', async () => {
    const { app: brokenApp } = makeFakeApp({ presentTables: ['stores', 'store_users'] });
    const brokenPlugin = new PluginClass(brokenApp, {
      name: 'service-ticket',
      packageName: '@local/service-ticket',
      enabled: true,
    });
    await brokenPlugin.load();
    const ctx = makeFakeContext(brokenApp);
    await brokenApp.resourcer.getResource('svc').actions.health(ctx, async () => {});
    assert(ctx.status === 503, `status=${ctx.status}`);
    assert(ctx.body.status === 'degraded', `status=${ctx.body.status}`);
    assert(ctx.body.missingTables.length === 9, `missing=${ctx.body.missingTables.length}`);
    return `missing=${ctx.body.missingTables.length}`;
  });

  await checkAsync('数据库不可达时 db=error 且不抛异常', async () => {
    const { app: downApp } = makeFakeApp({ presentTables: [] });
    downApp.db.sequelize.authenticate = async () => {
      throw new Error('connection refused to postgres://user:pass@host/db');
    };
    const p = new PluginClass(downApp, {
      name: 'service-ticket',
      packageName: '@local/service-ticket',
      enabled: true,
    });
    await p.load();
    const ctx = makeFakeContext(downApp);
    await downApp.resourcer.getResource('svc').actions.health(ctx, async () => {});
    assert(ctx.status === 503, `status=${ctx.status}`);
    assert(ctx.body.db === 'error', `db=${ctx.body.db}`);
    assert(ctx.body.dbErrorCode === 'DB_CONNECT_FAILED', `code=${ctx.body.dbErrorCode}`);
    // 原始错误文本绝不能外泄
    assert(!JSON.stringify(ctx.body).includes('postgres://'), '错误信息泄露了连接串');
    return ctx.body.dbErrorCode;
  });

  // ---------------------------------------------------------------- 4. 参数种子
  console.log('');
  console.log('【4】参数种子 install()');

  check('参数种子键解析器：认得常量引用，且解析不到时硬失败（防"静默少算 → 假红灯"）', () => {
    // 铁律 8 用在**校验器自己**身上：本轮踩过的坑是"解析器把 17 项读成 14 项"，
    // 于是 4 条断言报了与代码无关的红灯。若不给解析器配一条能变红的自检，
    // 下一次同样的少算会再次伪装成"代码没写好"。
    const withConst = [
      "export const K = {",
      "  A: 'a.one',",
      "  B: 'b.two',",
      '} as const;',
      'export const DEFAULT_SETTINGS = [',
      "  { key: 'lit.zero', value: '0' },",
      '  { key: K.A, value: \"1\" },',
      '  { key: K.B, value: \"2\" },',
      '];',
    ].join('\n');
    const parsed = parseDefaultSettingKeys(withConst);
    assert(
      JSON.stringify(parsed) === JSON.stringify(['lit.zero', 'a.one', 'b.two']),
      `常量引用必须被解析成真实键值（顺序也要保持），实际 ${JSON.stringify(parsed)}`,
    );

    // 引用一个不存在的常量成员 → 必须抛错，而不是静默少算
    const dangling = withConst.replace('key: K.B', 'key: MISSING.C');
    let threw = null;
    try {
      parseDefaultSettingKeys(dangling);
    } catch (err) {
      threw = err.message;
    }
    assert(threw, '引用了不存在的常量成员时解析器必须硬失败，否则就是静默少算');
    assert(
      threw.includes('MISSING.C'),
      `报错信息里应指明是哪个引用解析不到，实际：${threw}`,
    );
    return '常量引用可解析 + 悬空引用硬失败';
  });

  await checkAsync('首次安装写入全部参数种子', async () => {
    const { app: seedApp, repos } = makeFakeApp({ presentTables });
    const p = new PluginClass(seedApp, {
      name: 'service-ticket',
      packageName: '@local/service-ticket',
      enabled: true,
    });
    await p.load();
    await p.install();
    const created = repos.get('serviceSettings').calls.created;
    const expectedKeys = readDefaultSettingKeys();
    assert(
      created.length === expectedKeys.length,
      `写入 ${created.length} 项，期望 ${expectedKeys.length} 项`,
    );
    assert(p.healthState.settingsSeeded === true, 'settingsSeeded 不为 true');
    const keys = created.map((v) => v.key);
    assert(keys.includes('feedback.low_score_threshold'), '缺少低分阈值键');
    assert(keys.includes('sla.accept_minutes'), '缺少 SLA 受理时效键');
    return `${keys.length} 项`;
  });

  await checkAsync('已存在的参数不被覆盖（只增不改）', async () => {
    const { app: seedApp, repos } = makeFakeApp({
      presentTables,
      // 模拟运营已在后台把低分阈值改成 1
      seededSettings: [{ key: 'feedback.low_score_threshold', value: '1' }],
    });
    const p = new PluginClass(seedApp, {
      name: 'service-ticket',
      packageName: '@local/service-ticket',
      enabled: true,
    });
    await p.load();
    await p.install();
    const created = repos.get('serviceSettings').calls.created;
    const expectedCount = readDefaultSettingKeys().length - 1;
    assert(
      created.length === expectedCount,
      `写入 ${created.length} 项，期望 ${expectedCount} 项`,
    );
    assert(
      !created.some((v) => v.key === 'feedback.low_score_threshold'),
      '覆盖了已存在的参数',
    );
    return '跳过 1 项';
  });

  await checkAsync('参数写入失败不阻断启动（记为 lastError）', async () => {
    const { app: badApp } = makeFakeApp({ presentTables });
    // 只让"参数表"这一路失败，门店/角色种子仍走正常桩 ——
    // 否则三个种子全崩，lastError 会被后写的错误盖掉，测不出"参数失败"本身。
    const original = badApp.db.getRepository;
    badApp.db.getRepository = (name) => {
      if (name === 'serviceSettings') {
        return {
          async findOne() {
            throw new Error('relation "service_settings" does not exist');
          },
        };
      }
      return original(name);
    };
    const p = new PluginClass(badApp, {
      name: 'service-ticket',
      packageName: '@local/service-ticket',
      enabled: true,
    });
    await p.load();
    await p.install(); // 不应抛错
    assert(p.healthState.settingsSeeded === false, 'settingsSeeded 应为 false');
    assert(
      p.healthState.lastError === 'SEED_SETTINGS_FAILED',
      `lastError=${p.healthState.lastError}`,
    );
    return '已降级为告警';
  });

  // ---------------------------------------------------------------- 4b. Phase 2 种子
  console.log('');
  console.log('【4b】Phase 2 种子：门店 + 角色');

  const newPlugin = (app) =>
    new PluginClass(app, {
      name: 'service-ticket',
      packageName: '@local/service-ticket',
      enabled: true,
    });

  await checkAsync('首次安装写入门店种子（≥2 家，否则 AT-03 恒真）', async () => {
    const { app: seedApp, repos } = makeFakeApp({ presentTables });
    const p = newPlugin(seedApp);
    await p.load();
    await p.install();

    const created = repos.get('stores').calls.created;
    assert(
      created.length >= 2,
      `门店种子只有 ${created.length} 家 —— 一家门店时"门店用户看不到别家工单"恒真，等于没测`,
    );

    // 字段必须与 collections/stores.ts 严格对齐：多写一个不存在的列会在真机上报 42703
    const allowedColumns = new Set(['code', 'name', 'active', 'sort_order', 'contact_phone']);
    for (const row of created) {
      for (const key of Object.keys(row)) {
        assert(allowedColumns.has(key), `stores 行含未知列 ${key} —— 真机会报 column does not exist`);
      }
      assert(
        typeof row.code === 'string' && /^S\d{2,3}$/.test(row.code),
        `门店编码不合规：${row.code}`,
      );
      assert(row.name && row.sort_order !== undefined && row.active === true, `门店行不完整：${row.code}`);
    }
    const codes = created.map((r) => r.code);
    assert(new Set(codes).size === codes.length, '门店编码有重复');
    assert(
      p.healthState.storesSeededThisRun === created.length,
      `storesSeededThisRun=${p.healthState.storesSeededThisRun}`,
    );
    return `${created.length} 家 / ${codes.join(',')}`;
  });

  await checkAsync('门店种子只增不改（已存在的 code 不重复写）', async () => {
    const { app: seedApp, repos } = makeFakeApp({
      presentTables,
      seededStores: [{ code: 'S01', name: '运营改过的门店名（不许被覆盖）' }],
    });
    const p = newPlugin(seedApp);
    await p.load();
    await p.install();

    const created = repos.get('stores').calls.created;
    assert(!created.some((r) => r.code === 'S01'), '覆盖了已存在的门店（S01）');
    assert(created.length >= 1, '其余门店应当仍被写入');
    return `跳过 S01，新增 ${created.length} 家`;
  });

  await checkAsync('角色种子同时写 roles / dataSourcesRoles / 资源级授权（缺一即该角色全员 403）', async () => {
    const { app: seedApp, repos } = makeFakeApp({ presentTables });
    const p = newPlugin(seedApp);
    await p.load();
    await p.install();

    const roleRows = repos.get('roles').calls.created;
    const dsRows = repos.get('dataSourcesRoles').calls.created;

    assert(roleRows.length === 4, `roles 表写入 ${roleRows.length} 条，期望 4`);
    assert(dsRows.length === 4, `dataSourcesRoles 写入 ${dsRows.length} 条，期望 4`);

    // roles.title 有唯一约束：四个中文名必须互不相同，否则真机 create 直接报 23505
    const titles = roleRows.map((r) => r.title);
    assert(new Set(titles).size === 4, `角色中文名有重复：${titles.join(', ')}`);

    const roleNames = roleRows.map((r) => r.name).sort();
    assert(
      JSON.stringify(roleNames) ===
        JSON.stringify(['hq_admin', 'hq_after_sales', 'store_after_sales', 'viewer']),
      `角色名不符：${roleNames.join(', ')}`,
    );

    for (const row of dsRows) {
      assert(row.dataSourceKey === 'main', `dataSourceKey=${row.dataSourceKey}`);
      const actions = row.strategy?.actions;
      assert(Array.isArray(actions) && actions.length > 0, `${row.roleName} 的 strategy 为空`);
    }

    // ---- 资源级授权（判定的第二级）----
    // 缺这一级的现象是"角色有策略、用户能登录，但每个资源都 403 No permissions"，
    // 真机实测过，所以必须把行数钉死成「角色数 × 资源数」，而不是 ≥1。
    const readResources = rawModule.ROLE_NATIVE_READ_RESOURCES;
    const expectedResources = 4 * readResources.length;
    const resourceRows = repos.get('dataSourcesRolesResources').calls.created;
    assert(
      resourceRows.length === expectedResources,
      `资源级授权写入 ${resourceRows.length} 条，期望 ${expectedResources}（4 角色 × ${readResources.length} 资源）`,
    );

    const parentRows = repos.get('dataSourcesRolesResources').rows;
    for (const row of parentRows) {
      assert(
        row.usingActionsConfig === true,
        `${row.roleName}/${row.name} 的 usingActionsConfig 应为 true（否则 strategy 兜底放开更多）`,
      );
      assert(row.id, `${row.roleName}/${row.name} 没有 id —— 子表 FK 无从指回，授权等于没写`);
      assert(
        !('actions' in row),
        `${row.roleName}/${row.name} 把 hasMany 的 actions 当列写进了父表 —— 真机无此列，会报 42703`,
      );
      assert(
        !Object.keys(row).some((k) => ['createdAt', 'updatedAt'].includes(k)),
        '不要手写 createdAt/updatedAt，交给 ORM',
      );
    }

    // 子表：每条资源授权都要有对应的 action 行，且 FK 指得回父行
    const actionRows = repos.get('dataSourcesRolesResourcesActions').rows;
    assert(
      actionRows.length === expectedResources * readActions().length,
      `action 子表 ${actionRows.length} 行，期望 ${expectedResources * readActions().length}` +
        `（每条资源授权 ${readActions().length} 个 action：${readActions().join('/')}）`,
    );
    const parentIds = new Map(parentRows.map((r) => [r.id, r]));
    const actionNames = new Set();
    for (const row of actionRows) {
      assert(
        parentIds.has(row.rolesResourceId),
        `action 行 ${row.name} 的 rolesResourceId=${row.rolesResourceId} 指不到任何资源授权行`,
      );
      assert(Array.isArray(row.fields), 'fields 应为数组（真机列类型 jsonb）');
      actionNames.add(row.name);
    }
    assert(
      JSON.stringify([...actionNames].sort()) === JSON.stringify([...readActions()].sort()),
      `子表的 action 名应为 ${readActions().join('/')}，实际 ${[...actionNames].join(',')}`,
    );

    /**
     * 字段白名单的**名字来源**断言（2026-09-20 新增，来自一次真机缺陷）。
     *
     * 必须钉住三件事，否则同一个缺陷会以三种不同的伪装再回来：
     *   ① 不得出现**纯数字**成员。
     *      伪装：`nativeReadFieldsOf` 误用 `Object.keys(collection.getFields())`，
     *      而真机 getFields() 返回**数组** → 白名单变成 ["0","1",…,"32"]，
     *      接口 200 但业务列全丢。此断言是这个坑唯一可靠的离线哨兵。
     *   ② 必须是**属性名**而非列名：含 createdAt/updatedAt（camelCase）、
     *      且**不含** created_at/updated_at（snake_case）。
     *      伪装：改用 information_schema 之类的"列名"来源，白名单里的
     *      created_at 永远匹配不上 ORM 属性，时间列静默消失。
     *   ③ 必须含**外键列**（store_id），且**不含关联名**（store）。
     *      伪装：白名单取自 getFields()，于是有 store 没有 store_id ——
     *      门店隔离（AT-03）靠 store_id 断言，会直接做成瞎验收。
     */
    const ticketParents = parentRows.filter((r) => r.name === 'serviceTickets');
    assert(ticketParents.length > 0, '没有 serviceTickets 的资源授权行，字段白名单断言无事可做');
    const ticketParentIds = new Set(ticketParents.map((r) => r.id));
    const ticketActionFields = actionRows
      .filter((r) => ticketParentIds.has(r.rolesResourceId))
      .map((r) => r.fields);
    for (const fields of ticketActionFields) {
      const numeric = fields.filter((f) => /^\d+$/.test(String(f)));
      assert(
        numeric.length === 0,
        `serviceTickets 白名单里出现数字索引 ${numeric.slice(0, 5).join(',')} —— ` +
          '这是把 getFields()（真机返回**数组**）当成名字映射去 Object.keys() 的典型症状；' +
          '应改用 collection.model.rawAttributes',
      );
      assert(
        fields.includes('createdAt') && fields.includes('updatedAt'),
        `serviceTickets 白名单缺少 createdAt/updatedAt（属性名），实际前 5 项：${fields.slice(0, 5).join(',')}`,
      );
      assert(
        !fields.includes('created_at') && !fields.includes('updated_at'),
        'serviceTickets 白名单里出现 snake_case 时间列 —— 白名单要比对的是**属性名**，' +
          'created_at 永远匹配不上 ORM 属性，时间列会静默消失',
      );
      assert(
        fields.includes('store_id'),
        'serviceTickets 白名单缺少外键列 store_id —— 门店隔离（AT-03）靠它断言，缺了等于验收做瞎',
      );
      for (const assoc of ['store', 'handler', 'feedback_visit']) {
        assert(
          !fields.includes(assoc),
          `serviceTickets 白名单里出现关联名 ${assoc} —— 白名单比对的是属性名，关联名应排除`,
        );
      }
    }

    // ---- 字段级授权（判定的第三级，最容易漏）----
    // NocoBase 的 `beforeGrantAction`: `fields` 是**数组**时按白名单裁剪响应，
    // 并强制补 id/createdAt/updatedAt。所以 `fields: []` 的真实语义不是"不限制"，
    // 而是"只给 3 个系统字段" —— 真机实测门店角色的 list 只回 {id,createdAt,updatedAt}。
    // 反过来 `fields: null` 是"整行下发"，会把 token 哈希一并发出去。
    // 两边的坑都踩过，所以这里必须钉住"非空 + 不含敏感列"。
    const denyByResource = rawModule.NATIVE_READ_FIELD_DENY;
    assert(denyByResource, 'NATIVE_READ_FIELD_DENY 没有导出，字段级断言无法进行');
    for (const row of actionRows) {
      const parent = parentIds.get(row.rolesResourceId);
      assert(
        Array.isArray(row.fields) && row.fields.length > 0,
        `${parent.roleName}/${parent.name}:${row.name} 的 fields 为空数组 —— ` +
          'NocoBase 会把它裁剪成只剩 id/createdAt/updatedAt，接口返回 200 但业务列全没了',
      );
      const deny = denyByResource[parent.name] || [];
      const leaked = row.fields.filter((f) => deny.includes(f));
      assert(
        leaked.length === 0,
        `${parent.roleName}/${parent.name}:${row.name} 的字段白名单里出现敏感列 ${leaked.join(',')}`,
      );
      // 白名单必须真的含业务列，否则等于另一个形态的空壳
      assert(
        row.fields.some((f) => f !== 'id' && f !== 'createdAt' && f !== 'updatedAt'),
        `${parent.roleName}/${parent.name}:${row.name} 只授权了系统字段`,
      );
    }
    const ticketFields = actionRows.find((r) => parentIds.get(r.rolesResourceId)?.name === 'serviceTickets')?.fields || [];
    return (
      `roles 4 / 策略 4 / 资源授权 ${resourceRows.length} / action 行 ${actionRows.length}` +
      ` / serviceTickets 字段 ${ticketFields.length} 个（已排除 ${(denyByResource.serviceTickets || []).length} 个敏感列）`
    );
  });

  await checkAsync('角色策略只含 view/list/get（写操作必须走 /api/svc，见 API.md §6）', async () => {
    const { app: seedApp, repos } = makeFakeApp({ presentTables });
    const p = newPlugin(seedApp);
    await p.load();
    await p.install();

    const forbidden = ['create', 'update', 'destroy', 'export', 'import', 'importXlsx'];
    for (const row of repos.get('dataSourcesRoles').calls.created) {
      for (const action of row.strategy.actions) {
        assert(
          !forbidden.includes(action),
          `${row.roleName} 的策略里出现写/导出 action：${action} —— 原生写接口会绕过状态机`,
        );
      }
      assert(
        row.strategy.actions.includes('view'),
        `${row.roleName} 的策略缺少 view（list/get 都是 view 的别名）`,
      );
    }
    return '4 个角色均仅 view/list/get';
  });

  await checkAsync('角色已存在的策略不被覆盖（只增不改）', async () => {
    const { app: seedApp, repos } = makeFakeApp({
      presentTables,
      seededRoles: [{ name: 'viewer', title: '运营改过的名字' }],
      seededDsRoles: [{ roleName: 'viewer', dataSourceKey: 'main' }],
    });
    const p = newPlugin(seedApp);
    await p.load();
    await p.install();

    const roleRows = repos.get('roles').calls.created;
    const dsRows = repos.get('dataSourcesRoles').calls.created;
    assert(roleRows.length === 3, `roles 新建 ${roleRows.length} 条，期望 3`);
    assert(dsRows.length === 3, `dataSourcesRoles 新建 ${dsRows.length} 条，期望 3`);
    assert(!roleRows.some((r) => r.name === 'viewer'), '覆盖了已存在的角色 viewer');
    return '跳过 viewer';
  });

  await checkAsync('字段白名单三类修正：null / [] / 漂移都会对齐，缺的 action 行会被补', async () => {
    // 真机事故形态（2026-09-20 三态实测取到的确切语义）：
    //   fields = []   → beforeGrantAction 会补成 [id, createdAt, updatedAt]，
    //                   接口 200 但业务列全空；
    //   fields = null → **不做字段级过滤，整行下发**，实测 list 直接回出
    //                   feedback_token_hash / _expires_at / _used_at；
    //   fields = 非空但与期望不一致 → **配置漂移**（典型来源：测试探针残留、
    //                   后台误改）。Phase 2 真机上 `viewer/serviceTickets`
    //                   就被探针改成 7 列并留在了库里，旧逻辑"非空数组不碰"
    //                   等于把测试残留固化成线上权限 —— Phase 2.1 整改项 4 处理它。
    // 另有一种：授权行在、但某个 action 行被后台 `roles:update` 删掉了 ——
    // 资源授权用 usingActionsConfig=true 时不会回退到 strategy，该 action 直接 403。
    const { app: seedApp, repos } = makeFakeApp({
      presentTables,
      seededDsResources: [
        { id: 1, roleName: 'viewer', dataSourceKey: 'main', name: 'serviceTickets' },
        { id: 2, roleName: 'viewer', dataSourceKey: 'main', name: 'smsLogs' },
        { id: 3, roleName: 'viewer', dataSourceKey: 'main', name: 'ticketEvents' },
      ],
      seededDsResourceActions: [
        { id: 11, rolesResourceId: 1, name: 'list', fields: [] }, // ← 空壳，待修正
        { id: 12, rolesResourceId: 1, name: 'get', fields: null }, // ← 整行下发（泄露），待修正
        // 漂移样本：非空数组但与期望白名单不一致（真机上就是探针残留的形态）
        { id: 13, rolesResourceId: 2, name: 'list', fields: ['id', 'provider'] },
        { id: 14, rolesResourceId: 2, name: 'get', fields: ['id', 'provider'] },
        // rolesResourceId=3 故意**一行都没有**：list/get 都该被补出来
      ],
    });
    const p = newPlugin(seedApp);
    await p.load();
    await p.install();

    const actions = seedApp.db.getRepository('dataSourcesRolesResourcesActions').rows;
    const byId = new Map(actions.map((r) => [r.id, r]));

    assert(
      Array.isArray(byId.get(11).fields) && byId.get(11).fields.length > 0,
      'fields=[] 没有被修正 —— 该角色后台列表会只剩 id/createdAt/updatedAt',
    );
    assert(
      byId.get(11).fields.includes('content'),
      `修正后的白名单里没有业务列 content：${byId.get(11).fields.slice(0, 5).join(',')}…`,
    );

    // ---- fields=null：最危险的一种，必须被纠正为白名单 ----
    const nullFixed = byId.get(12)?.fields;
    assert(
      Array.isArray(nullFixed) && nullFixed.length > 0,
      'fields=null 没有被修正 —— 它会整行下发，把 feedback_token_hash 一起发出去',
    );
    assert(
      nullFixed.includes('content'),
      `fields=null 修正后缺业务列 content：${(nullFixed || []).slice(0, 5).join(',')}…`,
    );

    // ---- 漂移（非空但不等于期望）必须被对齐 ----
    // 断言"等于期望白名单"而不是"被改动过"：只有逐字相等才能证明对齐目标正确。
    // 期望值直接取插件导出的 nativeReadFieldsOf（与播种同源），不在脚本里另算一份 ——
    // 两套算法迟早漂移，而漂移的表现就是这条断言时红时绿。
    const desiredSms = rawModule.nativeReadFieldsOf(seedApp.db, 'smsLogs');
    for (const id of [13, 14]) {
      assert(
        JSON.stringify(byId.get(id).fields) === JSON.stringify(desiredSms),
        `漂移未被对齐（id=${id}）：现存 ${JSON.stringify(byId.get(id).fields)}，` +
          `期望 ${desiredSms.length} 列 —— 测试残留/后台误改会被永久固化进线上权限`,
      );
    }

    // ---- 缺失的 action 行必须被补出来（否则该 action 恒 403）----
    const ticketEventRows = actions.filter((r) => r.rolesResourceId === 3);
    assert(
      ticketEventRows.length === rawModule.ROLE_NATIVE_READ_ACTIONS.length,
      `rolesResourceId=3 的 action 行补出 ${ticketEventRows.length} 条，期望 ` +
        `${rawModule.ROLE_NATIVE_READ_ACTIONS.length}（${rawModule.ROLE_NATIVE_READ_ACTIONS.join('/')}）——` +
        '缺行时该 action 在 usingActionsConfig=true 下不会回退到 strategy，请求恒 403',
    );

    const deny = rawModule.NATIVE_READ_FIELD_DENY.serviceTickets || [];
    for (const id of [11, 12]) {
      assert(
        !byId.get(id).fields.some((f) => deny.includes(f)),
        `修正后的白名单带上了敏感列：${byId.get(id).fields.filter((f) => deny.includes(f)).join(',')}`,
      );
    }
    const numeric = byId.get(11).fields.filter((f) => /^\d+$/.test(String(f)));
    assert(numeric.length === 0, `修正后的白名单出现数字索引：${numeric.slice(0, 5).join(',')}`);

    return (
      `改动 ${repos.get('dataSourcesRolesResourcesActions').calls.update} 行（null/空数组/漂移），` +
      `补建 ${ticketEventRows.length} 个缺失 action 行`
    );
  });

  await checkAsync('逃生开关：SVC_ACL_FIELDS_AUTOFIX=0 时漂移保留，但 null/[] 仍然被纠正', async () => {
    // 为什么要有这个开关，以及为什么它**不能**管 null/[]：
    //   漂移对齐会覆盖库里的既有取值，所以必须留一条"我知道我在做什么"的路径
    //   （例如临时给某角色放开一列排查线上问题）。
    //   但 null（整行下发、泄露 token 哈希）与 []（空壳）是**漏洞**，不是配置 ——
    //   任何开关都不该能把漏洞留着。
    const prev = process.env.SVC_ACL_FIELDS_AUTOFIX;
    process.env.SVC_ACL_FIELDS_AUTOFIX = '0';
    try {
      const { app: seedApp } = makeFakeApp({
        presentTables,
        seededDsResources: [
          { id: 1, roleName: 'viewer', dataSourceKey: 'main', name: 'smsLogs' },
          { id: 2, roleName: 'viewer', dataSourceKey: 'main', name: 'serviceTickets' },
        ],
        seededDsResourceActions: [
          { id: 21, rolesResourceId: 1, name: 'list', fields: ['id', 'provider'] },
          { id: 22, rolesResourceId: 2, name: 'list', fields: null },
        ],
      });
      const p = newPlugin(seedApp);
      await p.load();
      await p.install();

      const rows = seedApp.db.getRepository('dataSourcesRolesResourcesActions').rows;
      const byId = new Map(rows.map((r) => [r.id, r]));

      assert(
        JSON.stringify(byId.get(21).fields) === JSON.stringify(['id', 'provider']),
        `开关关闭时漂移仍被覆盖：${JSON.stringify(byId.get(21).fields)}`,
      );
      const fixedNull = byId.get(22)?.fields;
      assert(
        Array.isArray(fixedNull) && fixedNull.length > 0 && fixedNull.includes('content'),
        'fields=null 在关闭自动对齐时没有被纠正 —— 漏洞不该受开关保护',
      );
      return '漂移保留 / null 已纠正';
    } finally {
      if (prev === undefined) delete process.env.SVC_ACL_FIELDS_AUTOFIX;
      else process.env.SVC_ACL_FIELDS_AUTOFIX = prev;
    }
  });

  await checkAsync('四个业务角色 × 4 资源共 32 条 action 行，字段白名单与期望同集合', async () => {
    // 这条是 Phase 2.1 整改项 4 的收口断言。
    //
    // 为什么必须"整表逐行比对"而不是"不含敏感列就行"：
    //   真机上 `viewer/serviceTickets` 曾被探针改成 7 列 —— 那 7 列**不含**敏感列、
    //   接口也回业务列，所有"安全检查"都能过；但它与其余 30 条 action 行不一致，
    //   意味着"谁有权看哪些列"这件事在库里**没有单一事实来源**。
    //   只有把期望集合算出来逐行比对，这种"单行漂移"才会变红。
    //
    // 为什么比**集合**而不是逐位比较（真机取证，2026-09-20）：
    //   NocoBase 会在 `list` 动作上重排 `fields`（`get` 行保持原序、`list` 行被重排，
    //   集合完全相同）。逐位比较于是把 16 条 `list` 行永远判成"漂移"。
    //   ACL 的 fields 本就是集合语义（顺序只影响 SELECT 列序，不影响鉴权），
    //   所以断言也按集合比 —— 7 列残留这类真漂移照样会被抓住。
    //
    // 期望值取插件导出的 nativeReadFieldsOf（与播种同源）——
    //   在脚本里另算一份会引入第二套算法，而两套算法漂移的表现就是这条断言时红时绿。
    const { app: seedApp } = makeFakeApp({ presentTables });
    const p = newPlugin(seedApp);
    await p.load();
    await p.install();

    const resourceRows = seedApp.db.getRepository('dataSourcesRolesResources').rows;
    const actionRows = seedApp.db.getRepository('dataSourcesRolesResourcesActions').rows;
    // 期望值一律取自构建产物导出的常量（与播种同源）——
    //   手写角色名/资源名会引入第二套事实来源，改写源码后这里静默变绿。
    const expectedRoles = rawModule.ROLE_SEEDS.map((r) => r.name);
    const expectedResources = rawModule.ROLE_NATIVE_READ_RESOURCES;

    assert(
      resourceRows.length === expectedRoles.length * expectedResources.length,
      `资源授权 ${resourceRows.length} 行，期望 ${expectedRoles.length * expectedResources.length}`,
    );
    const expectedActions = rawModule.ROLE_NATIVE_READ_ACTIONS;
    assert(
      actionRows.length === expectedRoles.length * expectedResources.length * expectedActions.length,
      `action 行 ${actionRows.length} 条，期望 ` +
        `${expectedRoles.length * expectedResources.length * expectedActions.length}`,
    );

    const resourceNameOf = new Map(resourceRows.map((r) => [r.id, r.name]));
    // 角色 × 资源 都要覆盖到；任一组合缺失都是"该角色对那张表 403"
    const seen = new Set(resourceRows.map((r) => `${r.roleName}/${r.name}`));
    for (const role of expectedRoles) {
      for (const res of expectedResources) {
        assert(seen.has(`${role}/${res}`), `缺失资源授权：${role}/${res}（该角色对此资源恒 403）`);
      }
    }

    const expectedByResource = new Map(
      expectedResources.map((res) => [res, rawModule.nativeReadFieldsOf(seedApp.db, res)]),
    );
    const byActionName = new Map();
    for (const row of actionRows) {
      const res = resourceNameOf.get(row.rolesResourceId);
      const want = expectedByResource.get(res);
      assert(want, `action 行指向未知资源：rolesResourceId=${row.rolesResourceId}`);
      assert(
        rawModule.sameFieldSet(row.fields, want),
        `字段白名单与期望不同集合：${res}:${row.name} 现存 ${JSON.stringify(row.fields)}，` +
          `期望 ${want.length} 列 —— 逐行一致是"谁有权看哪些列"的唯一事实来源`,
      );
      // 只读动作白名单**从常量取**，不再硬编码 'list'/'get' 两个名字 ——
      //   硬编码会在新增只读动作（DEV-65 的 `view`）时把正确实现判红，
      //   而改完硬编码又不会有任何东西保证"新加的那个确实是只读的"。
      //   下面另有一条**独立的**写动作黑名单断言负责后者，两者职责分开。
      assert(
        expectedActions.includes(row.name),
        `资源级授权出现未在 ROLE_NATIVE_READ_ACTIONS 中声明的 action：${res}:${row.name}`,
      );
      assert(
        !WRITE_ACTIONS.has(row.name),
        `资源级授权出现**写** action：${res}:${row.name} —— 绕过状态机（docs/API.md §6 / DEV-22）`,
      );
      const numeric = (row.fields || []).filter((f) => /^\d+$/.test(String(f)));
      assert(numeric.length === 0, `${res}:${row.name} 白名单含数字索引：${numeric.slice(0, 5).join(',')}`);
      byActionName.set(`${res}:${row.name}`, row.fields.length);
    }

    // 抽样报出四张表的列数，便于一眼看出"某张表列数明显偏小 = 疑似漂移"
    const sizes = expectedResources.map((res) => `${res}=${expectedByResource.get(res).length}`).join(' ');
    // 行数**从常量算**（角色 × 资源 × 只读动作），不写死 ——
    //   写死 32 会在只读动作集变化时报出误导性的"行数不符"，
    //   而真正该报的其实是上面的逐行断言（哪一行不对）。
    return (
      `${actionRows.length} 条 action 行（${expectedRoles.length} 角色 × ` +
      `${expectedResources.length} 资源 × ${expectedActions.length} 只读动作：` +
      `${expectedActions.join('/')}）全部与期望白名单同集合（${sizes}）`
    );
  });

  await checkAsync('无主资源授权行（roleName 为空）会被清理，且不误删正常角色行', async () => {
    // 这条守的是 Phase 2.1 整改项 4 的另一半：**行数可判定**。
    //
    // 真机取证（2026-09-20，见 docs/DEVIATIONS.md DEV-27）：
    //   `roles.resources` 是 hasMany(sourceKey:'name', foreignKey:'roleName')，
    //   而"替换关联"在无外键约束时是靠 `UPDATE ... SET roleName = NULL` 把旧行脱钩 ——
    //   于是每调一次 `POST /api/roles:update`（或后台保存角色）就**多 4 条无主行**。
    //   实测：一次调用把孤儿行从 7 条变成 11 条。
    //
    // 为什么必须清理而不是"留着反正 ACL 不读"：
    //   它们让"重新部署后授权配置一致"退化成不可判定 ——
    //   库里同时有"正确行"和 N 条垃圾时，"行数对不对"这个问题没有答案。
    //
    // 为什么必须同时断言"不误删"：本文件其余地方一律只增不改，
    //   清理是唯一的删除路径；一旦筛选条件写宽（比如误按 dataSourceKey 匹配），
    //   表现就是"某角色资源授权被删 → 该角色全员 403"，且要等用户投诉才会发现。
    const { app: seedApp, repos } = makeFakeApp({
      presentTables,
      seededDsResources: [
        // 正常行：4 个角色 × 1 个资源（不要求齐全，本断言只关心"谁被删"）
        { id: 1, roleName: 'store_after_sales', dataSourceKey: 'main', name: 'serviceTickets' },
        { id: 2, roleName: 'viewer', dataSourceKey: 'main', name: 'serviceTickets' },
        // 无主行：roleName 为 NULL / 空串 —— 一次 roles:update 的典型残留
        { id: 3, roleName: null, dataSourceKey: 'main', name: 'serviceTickets' },
        { id: 4, roleName: null, dataSourceKey: 'main', name: 'serviceVisits' },
        { id: 5, roleName: '', dataSourceKey: 'main', name: 'ticketEvents' },
      ],
      seededDsResourceActions: [
        { id: 11, rolesResourceId: 1, name: 'list', fields: ['id'] },
        { id: 12, rolesResourceId: 2, name: 'list', fields: ['id'] },
        // 无主父行下的 action 行 —— 必须被连带删除，否则变成悬挂数据
        { id: 13, rolesResourceId: 3, name: 'list', fields: ['id'] },
        { id: 14, rolesResourceId: 3, name: 'get', fields: ['id'] },
        { id: 15, rolesResourceId: 4, name: 'list', fields: null },
        { id: 16, rolesResourceId: 5, name: 'list', fields: [] },
      ],
    });

    const p = newPlugin(seedApp);
    await p.load();
    await p.install();

    const resourceRows = seedApp.db.getRepository('dataSourcesRolesResources').rows;
    const actionRows = seedApp.db.getRepository('dataSourcesRolesResourcesActions').rows;

    const orphansLeft = resourceRows.filter(
      (r) => r.roleName === null || r.roleName === undefined || r.roleName === '',
    );
    assert(
      orphansLeft.length === 0,
      `仍有 ${orphansLeft.length} 条无主行未被清理（id=${orphansLeft.map((r) => r.id).join(',')}）`,
    );

    // 正常角色行必须原样保留（roleName + 资源名都不变）
    const kept = new Set(resourceRows.map((r) => `${r.roleName}/${r.name}`));
    for (const key of ['store_after_sales/serviceTickets', 'viewer/serviceTickets']) {
      assert(kept.has(key), `清理误删了正常授权行：${key}`);
    }

    // 无主父行下的 action 行也要一并消失（本文件唯一会删子表的地方）。
    //   按**具体的预置 action 行 id** 判定，不按 rolesResourceId —— 因为新建的父行
    //   会占用新的 id，用 rolesResourceId 判会在"父行 id 被复用"时给出错误结论。
    const orphanActionIds = [13, 14, 15, 16];
    const aliveOrphanActions = actionRows.filter((r) => orphanActionIds.includes(r.id));
    assert(
      aliveOrphanActions.length === 0,
      `无主父行下的 action 行未连带删除：${aliveOrphanActions.map((r) => r.id).join(',')}`,
    );
    // 正常父行的 action 行不受影响
    assert(
      actionRows.some((r) => r.id === 11) && actionRows.some((r) => r.id === 12),
      '正常授权行的 action 行被误删',
    );

    // 返回值必须如实上报（部署日志靠它体现"这次删过库里的行"）
    const removed = repos.get('dataSourcesRolesResources').calls.destroy;
    assert(removed > 0, 'destroy 从未被调用，说明清理逻辑走的是别的分支');

    return `清理无主行 3 条 + 连带 action 行 3 条，正常行 2 条与它们的 action 行均保留`;
  });

  await checkAsync('取不到字段目录时必须抛错，绝不静默退化成"整行下发"', async () => {
    // 这条守的是一个**安全回归**：nativeReadFieldsOf 若在拿不到字段清单时
    // 返回 null/undefined，写进库里的就是"不限制字段" —— 实测 list 会整行下发，
    // 把 feedback_token_hash / access_token_hash 一起送出去。
    // 所以"取不到"必须是**抛错**（播种失败、health 记 lastError），
    // 而不是"降级继续"。回归哨兵：把 collection 的 model 摘掉。
    const { app: seedApp } = makeFakeApp({ presentTables });
    const p = newPlugin(seedApp);
    await p.load();

    const collection = seedApp.db.getCollection('serviceTickets');
    assert(collection?.model?.rawAttributes, '桩没有提供 model.rawAttributes，断言无法进行');

    const saved = collection.model;
    collection.model = undefined;
    try {
      let threw = false;
      try {
        rawModule.nativeReadFieldsOf(seedApp.db, 'serviceTickets');
      } catch {
        threw = true;
      }
      assert(
        threw,
        'rawAttributes 不可用时 nativeReadFieldsOf 没有抛错 —— 它会返回 undefined，' +
          '落库后等价于 fields:null（整行下发，泄露 token 哈希）',
      );
    } finally {
      collection.model = saved;
    }

    // 反向哨兵：正常情形下必须拿到**非空且不含纯数字**的属性名清单，
    // 否则上面的 catch 可能只是"永远抛错"，等于断言空转。
    const names = rawModule.nativeReadFieldsOf(seedApp.db, 'serviceTickets');
    assert(Array.isArray(names) && names.length > 10, `正常路径只拿到 ${names?.length} 个字段`);
    assert(
      !names.some((n) => /^\d+$/.test(String(n))),
      `正常路径的白名单含数字索引：${names.slice(0, 5).join(',')}`,
    );
    return `取不到即抛错；正常路径 ${names.length} 个属性（含 store_id=${names.includes('store_id')}）`;
  });

  await checkAsync('四个角色都灌进了内存 ACL，且 hq_admin 带 allowConfigure', async () => {
    const { app: seedApp } = makeFakeApp({ presentTables });
    const p = newPlugin(seedApp);
    await p.load();

    assert(p.healthState.rolesInAcl === 4, `rolesInAcl=${p.healthState.rolesInAcl}`);
    for (const name of ['store_after_sales', 'hq_after_sales', 'hq_admin', 'viewer']) {
      const role = seedApp.acl.getRole(name);
      assert(role, `ACL 里没有角色 ${name}`);
      const strategy = role.getStrategy();
      assert(strategy, `${name} 没有 strategy —— 该角色名下用户所有请求都会 403`);
      assert(
        JSON.stringify(strategy.actions) === JSON.stringify(['view', 'list', 'get']),
        `${name} 的 actions=${JSON.stringify(strategy.actions)}`,
      );
    }
    assert(seedApp.acl.getRole('hq_admin').getStrategy().allowConfigure === true, 'hq_admin 缺 allowConfigure');
    assert(
      seedApp.acl.getRole('viewer').getStrategy().allowConfigure === false,
      'viewer 不应有 allowConfigure',
    );
    return 'rolesInAcl=4';
  });

  await checkAsync('afterLoad 能把被外部覆盖的角色策略补回来（不覆盖已有策略）', async () => {
    const { app: reloadApp } = makeFakeApp({ presentTables });
    const p = newPlugin(reloadApp);
    await p.load();

    // 模拟"plugin-acl 在我们之后重新 define 了角色"：ACLRole 重建 → strategy 丢失。
    // 真机上的表现是"能登录、但列表全空/全部无权限"，从日志里几乎看不出来，
    // 所以必须有一步 afterLoad 回灌兜底。
    const rebuilt = reloadApp.acl.define({ role: 'viewer' });
    assert(rebuilt.getStrategy() === null, '前置条件不成立：新 define 的角色应为空策略');

    const handlers = reloadApp._handlers.get('afterLoad') || [];
    assert(handlers.length === 1, `afterLoad 处理器注册了 ${handlers.length} 个，期望 1`);
    await handlers[0]();

    assert(rebuilt.getStrategy() !== null, 'afterLoad 之后角色策略仍为空');
    assert(p.healthState.rolesInAcl === 4, `回灌后 rolesInAcl=${p.healthState.rolesInAcl}`);

    // 已有策略必须原样保留（运营在后台调过的不许被部署冲掉）
    const custom = reloadApp.acl.define({ role: 'hq_after_sales', strategy: { actions: ['view'] } });
    await handlers[0]();
    assert(
      JSON.stringify(custom.getStrategy().actions) === JSON.stringify(['view']),
      '覆盖了已有策略',
    );
    return '补空不覆盖';
  });

  check('NATIVE_READ_ALLOWLIST 只含只读动作，且资源集合与 storeScope 受管资源一致', () => {
    const readBlock = (file, regex, label) => {
      const src = fs.readFileSync(path.join(ROOT, 'nocobase', 'plugins', 'service-ticket', 'src', 'server', file), 'utf8');
      const hit = regex.exec(src);
      assert(hit, `未能在 ${file} 中定位 ${label}`);
      return hit[0];
    };

    const allowlistSrc = readBlock(
      'constants.ts',
      /export const NATIVE_READ_ALLOWLIST[\s\S]*?\n\];/,
      'NATIVE_READ_ALLOWLIST',
    );
    const entries = [...allowlistSrc.matchAll(/\[\s*'([^']+)'\s*,\s*\[([^\]]*)\]\s*\]/g)].map((m) => [
      m[1],
      [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]),
    ]);
    assert(entries.length >= 4, `只解析出 ${entries.length} 条白名单`);

    for (const [resource, actions] of entries) {
      assert(actions.length > 0, `${resource} 的 action 列表为空`);
      for (const action of actions) {
        assert(
          actions.every((a) => !WRITE_ACTIONS.has(a)),
          `${resource} 声明了写 action：${action} —— 白名单只允许只读动作 ` +
            `（${readActions().join('/')}；plugin.ts 会在启动期抛错）`,
        );
      }
    }

    const scopeSrc = readBlock(
      'middleware/store-scope.ts',
      /const SCOPED_RESOURCES: Record<[^>]*> = \{[\s\S]*?\n\};/,
      'SCOPED_RESOURCES',
    );
    const scoped = [...scopeSrc.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*\{\s*via:/gm)].map(
      (m) => m[1],
    );
    assert(scoped.length >= 4, `只解析出 ${scoped.length} 个受管资源`);

    const allowed = entries.map(([r]) => r).sort();
    const scopedSorted = [...scoped].sort();
    assert(
      JSON.stringify(allowed) === JSON.stringify(scopedSorted),
      `白名单 ${allowed.join(',')} 与受管资源 ${scopedSorted.join(',')} 不一致 —— ` +
        '差的那些会让门店用户直接读到别家的数据',
    );
    return `${entries.length} 个资源 / 仅 list,get`;
  });

  // ---------------------------------------------------------------- 4c. 资源形态 + 迁移
  console.log('');
  console.log('【4c】svc 资源形态自检 + 基线数据迁移');

  check('svc 资源形态：全部已声明 action 可达、原生 CRUD 一律不可达', () => {
    // 用真实 Resource.getAction() 的语义回读资源 —— 这是唯一能确认
    // "only 白名单真的生效了"的手段（而不是只看我们传进去的 only 数组）。
    const svc = fakeApp.resourcer.getResource('svc');
    const { all } = readSvcActionSets();

    for (const name of all) {
      let detail = null;
      try {
        svc.getAction(name);
      } catch (err) {
        detail = err.message;
      }
      assert(detail === null, `已声明的 action「${name}」不可达：${detail}`);
    }

    const forbidden = ['list', 'get', 'create', 'update', 'destroy', 'export', 'import', 'move', 'query'];
    for (const name of forbidden) {
      let reachable = true;
      try {
        svc.getAction(name);
      } catch {
        reachable = false;
      }
      assert(
        !reachable,
        `原生 action「${name}」竟然可达 —— 这是绕过状态机与事件时间线的后门（docs/API.md §6）`,
      );
    }

    return `${all.length} 可达 / ${forbidden.length} 原生被 except 拦住`;
  });

  check('registeredSvcActions 计数不含被合并进来的原生 handler（真机曾谎报 104 个）', () => {
    // Resource 构造函数会**就地**把 resourcer 上全部全局 handler 合并进调用方传入的
    // actions 对象（resourcer/lib/resource.js: `actions[name] = handler`）。
    // 若在 define() 之后再数 Object.keys(actions)，health 会报"104 个 svc action"，
    // 同事按它核对接口清单会直接对不上。
    const svc = fakeApp.resourcer.getResource('svc');
    const { all } = readSvcActionSets();
    const expected = all.length;
    const merged = Object.keys(svc.allActions).length;
    const exposed = Object.keys(svc.actions).length;

    assert(
      merged > expected,
      `桩没有复刻"就地合并全局 handler"的行为（合并后仅 ${merged} 个，期望 > ${expected}），这条断言会变成空转`,
    );
    assert(
      plugin.healthState.registeredSvcActions === expected,
      `计数 ${plugin.healthState.registeredSvcActions}，期望 ${expected}（= SVC_ACTION 成员数，被 contamination 了？）`,
    );
    assert(exposed === expected, `实际对外暴露 ${exposed} 个 action，期望 ${expected}`);
    return `声明 ${expected} / 合并后 ${merged} / 实际暴露 ${exposed}`;
  });

  await checkAsync('自检真的会拦：only 白名单被去掉时 load() 必须失败（防断言空转）', async () => {
    const { app: brokenApp } = makeFakeApp({ presentTables });
    const originalDefine = brokenApp.resourcer.define.bind(brokenApp.resourcer);
    // 模拟"有人改坏了 define 的 only 白名单"这一种宿主/代码回归
    brokenApp.resourcer.define = (def) => originalDefine({ ...def, only: undefined, except: undefined });

    const p = new PluginClass(brokenApp, {
      name: 'service-ticket',
      packageName: '@local/service-ticket',
      enabled: true,
    });

    let thrown = null;
    try {
      await p.load();
    } catch (err) {
      thrown = err;
    }

    assert(thrown, 'only 被去掉后 load() 竟然没抛错 —— 说明形态自检是空转的');
    assert(
      /原生 action/.test(thrown.message),
      `抛出的不是预期错误：${thrown.message}`,
    );
    return thrown.message.slice(0, 48) + '…';
  });

  await checkAsync('迁移产物落在 NocoBase 真正会扫描的目录（放错位置会被静默忽略）', () => {
    // 复刻 Plugin.getPluginBasePath() : dirname(dirname(require.resolve(pkg)))
    // 再拼 'server/migrations'。放错位置时 NocoBase 不报错、迁移就是不跑，
    // 所以必须用它的算法反推目录，而不是我们自己约定一个路径。
    const entry = fs.realpathSync(requireFromApp.resolve('@local/service-ticket'));
    const basePath = path.dirname(path.dirname(entry));
    const expectedDir = path.resolve(basePath, 'server', 'migrations');

    assert(
      fs.existsSync(expectedDir),
      `NocoBase 会去找的目录不存在：${expectedDir}（产物应在 <包根>/dist/server/migrations）`,
    );

    const files = readMigrationFiles(expectedDir);
    assert(files.length >= 1, `${expectedDir} 里没有任何 .js 迁移`);

    // 命名必须以日期前缀开头且整体可排序 —— umzug 就是按文件名字典序跑的，
    // 名字不带头部日期时间时顺序会退化成"字母序"，基线可能跑到补种后面去
    for (const name of files) {
      assert(
        /^\d{8,14}-[a-z0-9-]+\.js$/.test(name),
        `${name} 不符合 <日期>-<描述>.js 命名（umzug 按字典序执行，顺序会失控）`,
      );
    }

    return `${path.relative(basePath, expectedDir)} → ${files.join(', ')}`;
  });

  await checkAsync('追加迁移：已发布的基线迁移不动，新增授权迁移排在其后（可单独补齐旧实例）', async () => {
    const entry = fs.realpathSync(requireFromApp.resolve('@local/service-ticket'));
    const migrationsDir = path.resolve(path.dirname(path.dirname(entry)), 'server', 'migrations');
    const files = readMigrationFiles(migrationsDir);

    assert(files.length >= 2, `只有 ${files.length} 个迁移 —— 资源级授权应当由追加的迁移补齐`);
    const baselineIdx = files.findIndex((n) => n.includes('baseline-seed'));
    const grantsIdx = files.findIndex((n) => n.includes('role-resource-grants'));
    assert(baselineIdx >= 0, `找不到基线补种迁移（现有：${files.join(', ')}）`);
    assert(grantsIdx >= 0, `找不到资源授权迁移（现有：${files.join(', ')}）`);
    assert(
      baselineIdx < grantsIdx,
      `执行顺序不对：资源授权依赖角色与策略已存在，必须排在基线补种之后（${files.join(' < ')}）`,
    );

    // 模拟"旧实例"：基线迁移早已被 umzug 记为完成（不会再跑），库里
    // 有 roles + dataSourcesRoles，但**没有**资源级授权行。
    const storeCodes = rawModule.STORE_SEEDS.map((s) => s.code);
    const roleNames = rawModule.ROLE_SEEDS.map((r) => r.name);
    const { app: legacyApp } = makeFakeApp({
      presentTables,
      seededSettings: readDefaultSettingKeys().map((key) => ({ key, value: '1' })),
      seededStores: storeCodes.map((code) => ({ code, name: code })),
      seededRoles: roleNames.map((name) => ({ name })),
      seededDsRoles: roleNames.map((name) => ({ roleName: name, dataSourceKey: 'main' })),
    });
    assert(
      legacyApp.db.getRepository('dataSourcesRolesResources').rows.length === 0,
      '场景前提不成立：旧实例不该有资源级授权行',
    );

    /**
     * ⚠️ 必须先把插件 load() 一遍：迁移的 `on = 'afterLoad'` 本身就意味着
     * "collection 已注册、表已 sync"，而 nativeReadFieldsOf() 正是靠
     * db.getCollection(...).getFields() 枚举字段白名单的。
     * 裸 app 上跑迁移会直接取不到字段目录 —— 那是**假**失败（真机不可能这样启动）。
     * 这一步也让"迁移依赖插件注册的 collection"这条前置条件显式可见。
     */
    const legacyPlugin = new PluginClass(legacyApp, {
      name: 'service-ticket',
      packageName: '@local/service-ticket',
      enabled: true,
    });
    await legacyPlugin.load();

    // 只跑追加的那个迁移 —— 这正是真机上会发生的唯一动作
    const mod = requireFromApp(path.join(migrationsDir, files[grantsIdx]));
    const MigrationClass = mod && mod.__esModule ? mod.default : mod;
    await new MigrationClass({ app: legacyApp, db: legacyApp.db, plugin: null }).up();

    const readResourceCount = rawModule.ROLE_NATIVE_READ_RESOURCES.length;
    const readActionCount = rawModule.ROLE_NATIVE_READ_ACTIONS.length;
    const grants = legacyApp.db.getRepository('dataSourcesRolesResources');
    const actions = legacyApp.db.getRepository('dataSourcesRolesResourcesActions');
    assert(
      grants.rows.length === 4 * readResourceCount,
      `旧实例补出 ${grants.rows.length} 条资源授权，期望 ${4 * readResourceCount}`,
    );
    assert(
      actions.rows.length === 4 * readResourceCount * readActionCount,
      `旧实例补出 ${actions.rows.length} 条 action 行，期望 ${4 * readResourceCount * readActionCount}` +
        `（4 角色 × ${readResourceCount} 资源 × ${readActionCount} 只读动作：` +
        `${rawModule.ROLE_NATIVE_READ_ACTIONS.join('/')}）`,
    );

    // 补完必须能通过 health 的"以库为准"判定 —— 否则补了也等于没补
    const ctx = makeFakeContext(legacyApp);
    await legacyApp.resourcer.getResource('svc').actions.health(ctx, async () => {});
    assert(
      ctx.body.roleResourcesSeeded === true,
      `补种后 roleResourcesSeeded 仍为 ${ctx.body.roleResourcesSeeded}`,
    );

    return `${files[baselineIdx]} → ${files[grantsIdx]}；旧实例补出授权 ${grants.rows.length} 条 / action ${actions.rows.length} 条`;
  });

  await checkAsync('迁移 up() 能在空库上补齐基线数据（旧实例重启不补种的唯一解）', async () => {
    const entry = fs.realpathSync(requireFromApp.resolve('@local/service-ticket'));
    const migrationsDir = path.resolve(path.dirname(path.dirname(entry)), 'server', 'migrations');
    const files = readMigrationFiles(migrationsDir);

    const { app: migApp } = makeFakeApp({ presentTables });
    let totalCreated = 0;

    // 同"追加迁移"那条：迁移依赖插件已注册的 collection（字段白名单要枚举）
    await new PluginClass(migApp, {
      name: 'service-ticket',
      packageName: '@local/service-ticket',
      enabled: true,
    }).load();

    for (const file of files) {
      // 与 NocoBase 的 importModule → requireModule 完全同构：绝对路径 + __esModule 取 default
      const mod = requireFromApp(path.join(migrationsDir, file));
      const MigrationClass = mod && mod.__esModule ? mod.default : mod;
      assert(typeof MigrationClass === 'function', `${file} 没导出迁移类（NocoBase 取不到 default）`);

      const instance = new MigrationClass({ app: migApp, db: migApp.db, plugin: null });
      assert(
        instance.on === 'afterLoad',
        `${file} 的 on=${instance.on}，期望 afterLoad（表建好之后才写数据）`,
      );
      await instance.up();

      // 再跑一次：umzug 不会重跑，但幂等语义必须成立（只增不改）
      const before = migApp.db.getRepository('stores').rows.length;
      await instance.up();
      assert(
        migApp.db.getRepository('stores').rows.length === before,
        '第二次执行 up() 重复插入 —— 幂等破坏',
      );
      totalCreated += before;
    }

    const counts = {
      参数: migApp.db.getRepository('serviceSettings').rows.length,
      门店: migApp.db.getRepository('stores').rows.length,
      角色: migApp.db.getRepository('roles').rows.length,
      数据源角色: migApp.db.getRepository('dataSourcesRoles').rows.length,
      资源授权: migApp.db.getRepository('dataSourcesRolesResources').rows.length,
      授权action: migApp.db.getRepository('dataSourcesRolesResourcesActions').rows.length,
    };
    const settingKeys = readDefaultSettingKeys().length;
    const readResourceCount = rawModule.ROLE_NATIVE_READ_RESOURCES.length;
    const readActionCount = rawModule.ROLE_NATIVE_READ_ACTIONS.length;
    assert(counts.参数 === settingKeys, `参数 ${counts.参数} 项，期望 ${settingKeys}`);
    assert(counts.门店 >= 2, `门店 ${counts.门店} 家（<2 家则 AT-03 恒真）`);
    assert(counts.角色 === 4, `角色 ${counts.角色} 个，期望 4`);
    assert(counts.数据源角色 === 4, `dataSourcesRoles ${counts.数据源角色} 行，期望 4`);
    // 迁移路径与 install 路径必须写出**完全相同**的授权形态，否则"重启补种"和
    // "首次安装"会产出两种不同的权限世界（这是最难查的一类漂移）
    assert(
      counts.资源授权 === 4 * readResourceCount,
      `资源授权 ${counts.资源授权} 行，期望 ${4 * readResourceCount}`,
    );
    assert(
      counts.授权action === 4 * readResourceCount * readActionCount,
      `授权 action ${counts.授权action} 行，期望 ${4 * readResourceCount * readActionCount}` +
        `（4 角色 × ${readResourceCount} 资源 × ${readActionCount} 只读动作：` +
        `${rawModule.ROLE_NATIVE_READ_ACTIONS.join('/')}）`,
    );

    return Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(' / ');
  });

  // ---------------------------------------------------------------- 4d. Phase 4 探针闸门
  console.log('');
  console.log('【4d】Phase 4 探针（tokenCheck / smsOutbox）的两道闸');

  await checkAsync('探针自带生产环境自毁闸：短信通道不是 mock 时返回 404（而不是 403）', async () => {
    // 为什么这两条要在**离线**验，而不是只靠真机冒烟：
    //   `tokenCheck` / `smsOutbox` 存在的唯一理由是让"改派后旧 Token 立即失效"
    //   这条硬门槛能在 HTTP 层被证明（Token 明文只在短信里，库里只有 sha256，
    //   没有取回通道就无从发起校验）。也就是说它们**必然**要在生产环境里被删掉 ——
    //   而"删掉"必须由 `sms.provider` 自动完成，不能指望部署时有人记得。
    //   真机上验这一条要把 sms.provider 改成 aliyun、等 10s 缓存过期、再改回来
    //   （还要再等一次），既慢又会在中途留下"通道配错"的状态。
    //   这里直接构造该分支，快、确定、且不会污染任何运行环境。
    const svc = fakeApp.resourcer.getResource('svc');
    const { sms, permissions } = plugin.services;

    assert((await sms.isMockChannel()) === true, '默认通道不是 mock —— 前提不成立，本断言会变成空转');

    // 只替换"操作者解析"这一环：本断言要证的是 assertMockChannel 那一段，
    // 与 Actor 解析解耦后，404 就一定来自自毁闸，而不是别的校验碰巧回了个 404。
    const originalResolve = permissions.resolveActor;
    const originalIsMock = sms.isMockChannel;
    try {
      permissions.resolveActor = async () => ({
        userId: 1,
        roles: ['hq_admin'],
        platformRoles: [],
        storeIds: [],
        raw: {},
      });

      sms.isMockChannel = async () => false;
      for (const action of ['tokenCheck', 'smsOutbox']) {
        const ctx = makeActionCtx(action === 'tokenCheck' ? { token: 'x' } : {});
        await actionHandlerOf(svc, action)(ctx, async () => {});
        assert(ctx.status === 404, `${action} 的 HTTP 状态：期望 404，实际 ${ctx.status}`);
        assert(
          ctx.body?.errors?.[0]?.code === 'NOT_FOUND',
          `${action} 的错误码：期望 NOT_FOUND，实际 ${JSON.stringify(ctx.body)}`,
        );
      }

      // 反向对照：mock 通道下必须**不是** 404。少了这一步，上面那条断言
      // 在"接口根本没挂上"时也能通过 —— 典型的空转。
      sms.isMockChannel = originalIsMock;
      const mockCtx = makeActionCtx({ token: 'x' });
      await actionHandlerOf(svc, 'tokenCheck')(mockCtx, async () => {});
      assert(
        mockCtx.status !== 404,
        'mock 通道下 tokenCheck 也返回 404 —— 说明接口压根不可达，"非 mock 返回 404"这条断言是空转',
      );
    } finally {
      sms.isMockChannel = originalIsMock;
      permissions.resolveActor = originalResolve;
    }
    return '非 mock → 两个探针均 404 NOT_FOUND；mock → 可达';
  });

  await checkAsync('探针是总部专属：非特权角色一律 403，且先于自毁闸判定', async () => {
    // 顺序很重要：如果自毁闸在能力校验**之前**，那么"是否存在这个接口"
    // 就会先于身份被回答 —— 一个门店账号也能探测到它有/没有。
    const svc = fakeApp.resourcer.getResource('svc');
    const { permissions } = plugin.services;
    const originalResolve = permissions.resolveActor;
    try {
      permissions.resolveActor = async () => ({
        userId: 9,
        roles: ['viewer'],
        platformRoles: [],
        storeIds: [],
        raw: {},
      });
      for (const action of ['tokenCheck', 'smsOutbox']) {
        const ctx = makeActionCtx({ token: 'x' });
        await actionHandlerOf(svc, action)(ctx, async () => {});
        assert(
          ctx.status === 403,
          `${action} 对只读角色应回 403，实际 ${ctx.status}（403 才是"存在但你没权限"）`,
        );
        assert(
          ctx.body?.errors?.[0]?.code === 'FORBIDDEN',
          `${action} 的错误码：期望 FORBIDDEN，实际 ${JSON.stringify(ctx.body)}`,
        );
      }
    } finally {
      permissions.resolveActor = originalResolve;
    }
    return 'viewer → 403 FORBIDDEN（探针不是匿名可达的）';
  });

  // ---------------------------------------------------------------- 5. 幂等重载
  console.log('');
  console.log('【5】热重载幂等性');

  await checkAsync('load() 重复调用不抛 "collection 已存在"', async () => {
    const { app: reloadApp } = makeFakeApp({ presentTables });
    const p = new PluginClass(reloadApp, {
      name: 'service-ticket',
      packageName: '@local/service-ticket',
      enabled: true,
    });
    await p.load();
    await p.load();
    assert(reloadApp.db.collections.size === 11, `集合数 ${reloadApp.db.collections.size}`);
    return 'ok';
  });

  // ---------------------------------------------------------------- 清理
  fs.rmSync(tmp, { recursive: true, force: true });

  // ---------------------------------------------------------------- 汇总
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  if (failures.length === 0) {
    console.log(`  ✅ 全部通过：${passed} 项`);
    console.log('══════════════════════════════════════════════════════════════');
    console.log('');
    process.exit(0);
  } else {
    console.log(`  ❌ 失败 ${failures.length} 项 / 通过 ${passed} 项`);
    for (const f of failures) console.log(`     - ${f.title}: ${f.message}`);
    console.log('══════════════════════════════════════════════════════════════');
    console.log('');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[verify-plugin-load] 脚本异常：');
  console.error(err);
  process.exit(1);
});
