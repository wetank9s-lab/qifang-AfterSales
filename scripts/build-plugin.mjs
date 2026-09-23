#!/usr/bin/env node
/**
 * build-plugin.mjs —— 编译自研插件到「可被 NocoBase 加载」的形态
 *
 * 产物（关键！路径必须与 NocoBase 的插件发现机制一致）：
 *   storage/plugins/@local/service-ticket/
 *     ├── package.json                    ← main 指向 ./dist/server/index.js
 *     └── dist/server/index.js            ← esbuild 打包后的 CJS bundle
 *
 * 为什么是这两个位置：
 *   1) NocoBase 启动时扫描 `storage/plugins`（@nocobase/utils 的 DEFAULT_PLUGIN_STORAGE_PATH），
 *      发现形如 npm 包的目录即视为插件，配合 APPEND_PRESET_BUILT_IN_PLUGINS 自动启用；
 *   2) 装载插件时执行 require('@local/service-ticket')，
 *      因此 docker-compose 把本目录同时挂到 app 容器的 node_modules/@local/ 下。
 *
 * 为什么用 .mjs 而不是 .ts：Docker 镜像里没有 TS 工具链，也不需要在镜像内构建。
 * 本脚本在宿主机跑一次，产物直接挂进容器，构建快、镜像干净。
 *
 * 用法：node scripts/build-plugin.mjs [--watch] [--minify]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
const SRC_PLUGIN_DIR = path.join(ROOT, 'nocobase', 'plugins', 'service-ticket');
const SRC_ENTRY = path.join(SRC_PLUGIN_DIR, 'src', 'server', 'index.ts');
const SRC_PACKAGE_JSON = path.join(SRC_PLUGIN_DIR, 'package.json');
/** 迁移源目录（每个文件一个 entry，产物名与源同名 .js） */
const SRC_MIGRATIONS_DIR = path.join(SRC_PLUGIN_DIR, 'src', 'server', 'migrations');
/** 客户端入口（Phase 4-H 新增） */
const SRC_CLIENT_ENTRY = path.join(SRC_PLUGIN_DIR, 'src', 'client', 'index.ts');

const OUT_PLUGIN_DIR = path.join(ROOT, 'storage', 'plugins', '@local', 'service-ticket');
const OUT_ENTRY = path.join(OUT_PLUGIN_DIR, 'dist', 'server', 'index.js');
/**
 * 迁移产物目录。
 *
 * ⚠️ 位置是由 NocoBase 的代码决定的，不能随意改：
 *   Plugin.loadMigrations() → resolve(getPluginBasePath(pkg), 'server/migrations')
 *   getPluginBasePath(pkg)  → dirname(dirname(require.resolve(pkg)))
 *   而 package.json 的 main 是 ./dist/server/index.js，
 *   所以真实路径 = <包根>/dist/server/migrations（官方 plugin-acl 同样如此）。
 *   放到 <包根>/server/migrations 会被**静默忽略** —— 没有报错，迁移就是不跑。
 */
const OUT_MIGRATIONS_DIR = path.join(OUT_PLUGIN_DIR, 'dist', 'server', 'migrations');

/**
 * 客户端产物路径（Phase 4-H 新增）。
 *
 * ⚠️ 路径同样由 NocoBase 决定，不能改：
 *   @nocobase/server/lib/plugin-manager/options/resource.js 里
 *     PLUGIN_CLIENT_ENTRY_FILES = { client: 'dist/client/index.js', ... }
 *     PLUGIN_CLIENT_MARKER_FILES = { client: 'client.js', ... }
 *   后台 SPA 会调 `GET /api/pm:listEnabled`，拿到每个启用插件的
 *     url = `/static/plugins/<包名>/dist/client/index.js`
 *   然后**无条件**去加载它 —— 服务端 `listEnabledPlugins()` 只在文件存在时追加
 *   `?hash=`，**不做存在性过滤**。所以缺这个文件 = 前端 404 = 整个后台 "App error"。
 *
 * 标记文件 `client.js`（包根）只在 lane='client-v2' 的 `hasClientEntry()` 里被读，
 * 但一并产出以保持与核心插件同构（核心插件包里两者都有）。
 */
const OUT_CLIENT_ENTRY = path.join(OUT_PLUGIN_DIR, 'dist', 'client', 'index.js');
const OUT_CLIENT_MARKER = path.join(OUT_PLUGIN_DIR, 'client.js');

const NODE_WORKSPACE = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.workbuddy',
  'binaries',
  'node',
  'workspace',
);

const argv = process.argv.slice(2);
const WATCH = argv.includes('--watch');
const MINIFY = argv.includes('--minify');

// ---------------------------------------------------------------------------
// 定位 esbuild（兼容「全局可用」与「隔离 workspace 内安装」两种情况）
// ---------------------------------------------------------------------------
function loadEsbuild() {
  const candidates = [
    () => require('esbuild'),
    () => require(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild')),
    () => require(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild', 'lib', 'main.js')),
  ];
  const errors = [];
  for (const load of candidates) {
    try {
      const mod = load();
      if (mod && typeof mod.build === 'function') return mod;
    } catch (err) {
      errors.push(err.message);
    }
  }
  console.error('[build-plugin] 找不到 esbuild。请先安装：');
  console.error(`  cd "${NODE_WORKSPACE}" && npm install esbuild`);
  console.error('已尝试的路径错误：\n  ' + errors.join('\n  '));
  process.exit(1);
}

/**
 * 外置依赖清单，直接照抄 NocoBase 自己的 EXTERNAL 列表
 * （@nocobase/server/lib/plugin-manager/constants.js）。
 *
 * 语义：这些包由宿主应用提供，**绝不能打进插件产物**。
 * 一旦被打进去，会出现「两份 @nocobase/database 实例」导致
 * collection 注册到错误的 Database 对象上，并且启动时静默失效。
 */
const EXTERNALS = [
  '@nocobase/*',
  // @nocobase/cache
  'cache-manager',
  // @nocobase/database
  'sequelize',
  'umzug',
  'async-mutex',
  // @nocobase/evaluators
  '@formulajs/formulajs',
  'mathjs',
  // @nocobase/logger
  'winston',
  'winston-daily-rotate-file',
  // koa
  'koa',
  '@koa/cors',
  '@koa/router',
  'multer',
  '@koa/multer',
  'koa-bodyparser',
  'koa-static',
  'koa-send',
  // react（Phase 6 起会有前端，先声明好）
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-router',
  'react-router-dom',
  // antd
  'antd',
  'antd-style',
  '@ant-design/icons',
  '@ant-design/cssinjs',
  // i18n
  'i18next',
  'react-i18next',
  // formily
  '@formily/antd-v5',
  '@formily/core',
  '@formily/react',
  '@formily/json-schema',
  '@formily/path',
  '@formily/validator',
  '@formily/shared',
  '@formily/reactive',
  '@formily/reactive-react',
  // utils
  'dayjs',
  'mysql2',
  'pg',
  'pg-hstore',
  'sqlite3',
  'supertest',
  'axios',
  '@emotion/css',
  'ahooks',
  'lodash',
  'china-division',
  'jsonwebtoken',
];

// ---------------------------------------------------------------------------
// 预检
// ---------------------------------------------------------------------------
function preflight() {
  const problems = [];

  if (!fs.existsSync(SRC_ENTRY)) problems.push(`缺少插件入口：${SRC_ENTRY}`);
  if (!fs.existsSync(SRC_PACKAGE_JSON)) problems.push(`缺少 package.json：${SRC_PACKAGE_JSON}`);
  // 客户端入口缺失是"后台打不开"级别的故障，直接在预检拦住，别等部署完才发现
  if (!fs.existsSync(SRC_CLIENT_ENTRY)) {
    problems.push(
      `缺少客户端入口：${SRC_CLIENT_ENTRY}` +
        '（NocoBase 会无条件加载 dist/client/index.js，缺了后台直接 App error）',
    );
  }

  if (fs.existsSync(SRC_PACKAGE_JSON)) {
    const pkg = JSON.parse(fs.readFileSync(SRC_PACKAGE_JSON, 'utf8'));
    if (!pkg.name) problems.push('package.json 缺少 name');
    if (!pkg.main) problems.push('package.json 缺少 main');
    // 这两条是踩过的坑：包名前缀必须在 PLUGIN_PACKAGE_PREFIX 白名单里，
    // defaultEnabled/supportedVersions 影响后台是否默认启用。
    if (pkg.name && !pkg.name.startsWith('@local/')) {
      problems.push(`package.json name 必须以 @local/ 开头（当前 ${pkg.name}）`);
    }
    if (pkg.main !== './dist/server/index.js') {
      problems.push(`package.json main 应为 ./dist/server/index.js（当前 ${pkg.main}）`);
    }
    if (!pkg.nocobase?.supportedVersions?.includes('2.x')) {
      problems.push('package.json nocobase.supportedVersions 应包含 "2.x"');
    }
  }

  if (problems.length) {
    console.error('[build-plugin] 预检失败：');
    for (const p of problems) console.error('  ✗ ' + p);
    process.exit(1);
  }
}

/**
 * 迁移文件命名预检。
 *
 * umzug 按**文件名字典序**决定迁移的执行顺序（app.loadMigrations 里
 * migrations[m.on].push，createMigrator 再按 name 排）。名字不以时间戳开头时，
 * 顺序就变成随机的字母序 —— 比如 `seed-baseline.ts` 会排在 `20260920-*.ts` **之前**，
 * 于是"补种基线数据"可能跑在"建表迁移"前面而失败。
 * 这类问题只在特定文件集合下才暴露，属于必须靠约定挡住的坑，所以放在预检里。
 */
function preflightMigrations() {
  const problems = [];

  for (const file of collectMigrationSources()) {
    const name = path.basename(file);
    if (!/^\d{8,14}-[a-z0-9-]+\.ts$/.test(name)) {
      problems.push(
        `迁移文件名不符合「时间戳-描述.ts」约定：${name}` +
          '（必须以 8 位以上日期开头，否则执行顺序不可控）',
      );
    }
  }

  if (problems.length) {
    console.error('[build-plugin] 迁移预检失败：');
    for (const p of problems) console.error('  ✗ ' + p);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------
async function buildOnce(esbuild) {
  fs.mkdirSync(path.dirname(OUT_ENTRY), { recursive: true });

  const startedAt = Date.now();

  const result = await esbuild.build({
    entryPoints: [SRC_ENTRY],
    outfile: OUT_ENTRY,
    bundle: true,
    platform: 'node',
    format: 'cjs', // 宿主用 require() 装载，必须是 CJS
    target: ['node20'], // NocoBase 2.2.x 镜像内的 Node 版本
    sourcemap: true,
    minify: MINIFY,
    external: EXTERNALS,
    // 保留类名与函数名：NocoBase 日志里出现的插件类名可读，便于排障
    keepNames: true,
    metafile: true,
    logLevel: 'warning',
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
    },
    banner: {
      js: '/* 家电门店售后服务平台 @local/service-ticket —— 由 scripts/build-plugin.mjs 生成，请勿手工修改 */',
    },
  });

  // 同步 package.json（NocoBase 靠它识别插件、确定入口、读取版本号）
  const pkgRaw = fs.readFileSync(SRC_PACKAGE_JSON, 'utf8');
  JSON.parse(pkgRaw); // 语法校验，坏 JSON 会让应用启动直接失败
  fs.writeFileSync(path.join(OUT_PLUGIN_DIR, 'package.json'), pkgRaw, 'utf8');

  // 迁移（独立 entry，必须在主产物之后：两者共用 dist 目录）
  const migrations = await buildMigrations(esbuild);

  // 客户端（Phase 4-H）。缺它 = 后台 SPA 直接 "App error"，所以这里不是"可选步骤"。
  const client = await buildClient(esbuild);

  return { result, ms: Date.now() - startedAt, migrations, client };
}

/**
 * 收集迁移源文件。
 *
 * 只收直接子文件（不递归）：NocoBase 的 loadMigrations 用的就是 `glob("${dir}/*.{js,ts}")`，
 * 子目录里的文件它根本看不见。构建侧与加载侧必须用同一套规则，否则会出现
 * "文件编出来了、应用却没跑" —— 这类不一致没有任何日志提示，只能靠这里对齐。
 */
function collectMigrationSources() {
  if (!fs.existsSync(SRC_MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(SRC_MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .sort()
    .map((name) => path.join(SRC_MIGRATIONS_DIR, name));
}

/** 构建迁移（每个源文件独立打包成同名 .js） */
async function buildMigrations(esbuild) {
  const entryPoints = collectMigrationSources();
  if (entryPoints.length === 0) return { count: 0 };

  fs.mkdirSync(OUT_MIGRATIONS_DIR, { recursive: true });

  await esbuild.build({
    entryPoints,
    outdir: OUT_MIGRATIONS_DIR,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    sourcemap: true,
    minify: MINIFY,
    external: EXTERNALS,
    keepNames: true,
    logLevel: 'warning',
    banner: {
      js: '/* 家电门店售后服务平台 @local/service-ticket 迁移 —— 由 scripts/build-plugin.mjs 生成，请勿手工修改 */',
    },
  });

  return { count: entryPoints.length };
}

// ---------------------------------------------------------------------------
// 客户端构建（Phase 4-H）
// ---------------------------------------------------------------------------

/**
 * 生成 UMD 包装。
 *
 * 为什么必须自己包一层：
 *   esbuild 不产出 UMD（只有 iife / cjs / esm）。而 NocoBase 后台是 requirejs(AMD)
 *   加载插件客户端的 —— 核心插件的产物都是长这样的 UMD：
 *     !function(e,t){ "object"==typeof exports&&...?module.exports=t(require(...)):
 *       "function"==typeof define&&define.amd?define([...],t):... }(this, function(){...})
 *   直接把 esbuild 的 CJS 产物丢上去，浏览器里没有 module/exports/require，直接报错。
 *
 * 为什么不在 AMD 分支里直接用 requirejs 的局部 require：
 *   局部 require 只能同步取"已加载"的模块，取不到就抛；一旦某个外部依赖没被核心包
 *   预先加载，报错会发生在**很深的调用栈里**，而且很难判断缺的是哪个模块。
 *   这里改成显式依赖数组 + 白名单 require：
 *     · 依赖写进 define([...])，requirejs 会负责加载/等待；
 *     · 局部 __require 只认这张表，遇到未声明的 id 立刻抛出**带上模块名**的错误。
 *   把"取不到"变成一个响亮的、可定位的失败（项目铁律 3）。
 *
 * 依赖清单来自 esbuild 产物的 metafile，即"这个 bundle 实际 require 了哪些外部模块"
 *   —— 而不是在这里再手抄一份清单。手抄的清单迟早与代码漂移，然后表现为运行时炸。
 */
function buildUmdWrapper(externalDeps) {
  const params = externalDeps.map((_, i) => `__dep${i}`);
  const mapEntries = externalDeps.map((id, i) => `${JSON.stringify(id)}: __dep${i}`);

  return {
    banner:
      '/* 家电门店售后服务平台 @local/service-ticket 客户端 —— 由 scripts/build-plugin.mjs 生成，请勿手工修改 */\n' +
      ';(function (root, factory) {\n' +
      "  'use strict';\n" +
      "  if (typeof define === 'function' && define.amd) {\n" +
      `    define(${JSON.stringify(externalDeps)}, function (${params.join(', ')}) {\n` +
      `      var __deps = { ${mapEntries.join(', ')} };\n` +
      '      var __require = function (id) {\n' +
      '        if (Object.prototype.hasOwnProperty.call(__deps, id)) return __deps[id];\n' +
      "        throw new Error('[service-ticket/client] 未在 AMD 依赖里声明的外部模块: ' + id);\n" +
      '      };\n' +
      '      var module = { exports: {} };\n' +
      '      var exports = module.exports;\n' +
      '      factory(__require, module, module.exports);\n' +
      '      return module.exports;\n' +
      '    });\n' +
      "  } else if (typeof module === 'object' && module.exports) {\n" +
      '    factory(require, module, module.exports);\n' +
      '  } else {\n' +
      "    throw new Error('[service-ticket/client] 不支持的模块环境');\n" +
      '  }\n' +
      "})(typeof self !== 'undefined' ? self : this, function (require, module, exports) {\n",
    footer: '\n});\n',
  };
}

/** 构建客户端 bundle（AMD/UMD） */
async function buildClient(esbuild) {
  if (!fs.existsSync(SRC_CLIENT_ENTRY)) {
    return { built: false, reason: `缺少客户端入口：${SRC_CLIENT_ENTRY}` };
  }

  fs.mkdirSync(path.dirname(OUT_CLIENT_ENTRY), { recursive: true });

  // 第一遍：只为拿到"实际用到了哪些外部模块"，据此生成 define 的依赖数组。
  // 用 write:false 让它只产出 metafile，不落盘。
  //
  // ⚠️ 这一遍的**编译语义必须与第二遍完全一致**，否则 metafile 描述的是"另一个程序"。
  //    踩过的坑（2026-09-22，页面报 App error）：
  //      probe 漏了 `jsx: 'automatic'` 和 `define`，于是 esbuild 不注入
  //      `react/jsx-runtime`；而第二遍有这个选项、产物里真的 require 了它。
  //      结果 define([...]) 只有 5 个依赖、bundle 却 require 第 6 个 →
  //      白名单 __require 抛 "未在 AMD 依赖里声明的外部模块: react/jsx-runtime"，
  //      **整个后台白屏**。而所有 /api 断言照样全绿（错误只在浏览器侧编译产物里）。
  //    教训：只要两遍构建的"输入语义"可能不同，就必须把选项抽成同一份对象。
  // 构建标记：注入到客户端产物里，真人在 Console 一眼就能确认
  // 「浏览器跑的是不是我刚构建的这一版」。
  // Phase 4-I 第三轮「详情 404」之所以拖了整轮，就是因为**没人能回答这个问题**
  //   （自动化探针每次全新 profile → 永远拿最新产物 → 永远绿；
  //    真人浏览器可能被 /static/plugins/ 的长缓存粘住 → 一直跑旧代码，
  //    而修复前后 Console 里的动作清单**一字不差**）。
  // ⚠️ 必须放在 clientBuildOptions 里，**与产物构建同源** —— probe 那一遍也要注入，
  //    否则两遍构建的产物语义不同（DEV-60：AMD 依赖数组漏声明就是这么来的）。
  const clientBuildStamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  console.log(`  · 客户端产物构建标记：${clientBuildStamp}`);

  const clientBuildOptions = {
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: ['es2020'],
    external: EXTERNALS,
    logLevel: 'warning',
    // React 及其生态在浏览器侧靠 process.env.NODE_ENV 分支，
    // 不 define 会在运行时抛 "process is not defined"。
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      __SVC_CLIENT_BUILD__: JSON.stringify(clientBuildStamp),
    },
    jsx: 'automatic',
  };

  const probe = await esbuild.build({
    ...clientBuildOptions,
    entryPoints: [SRC_CLIENT_ENTRY],
    write: false,
    metafile: true,
  });

  const imports = probe.metafile?.outputs?.[Object.keys(probe.metafile.outputs)[0]]?.imports || [];
  const externalDeps = imports
    .filter((imp) => imp.external)
    .map((imp) => imp.path)
    // metafile 里同一条外部依赖可能出现多次（不同 kind），去重并排序保证产物可复现
    .filter((id, i, arr) => arr.indexOf(id) === i)
    .sort();

  const umd = buildUmdWrapper(externalDeps);

  const result = await esbuild.build({
    ...clientBuildOptions,
    entryPoints: [SRC_CLIENT_ENTRY],
    outfile: OUT_CLIENT_ENTRY,
    sourcemap: true,
    minify: MINIFY,
    keepNames: true,
    metafile: true,
    banner: { js: umd.banner },
    footer: { js: umd.footer },
  });

  // 包根标记文件：与核心插件同构（Node 侧 require('<pkg>/client') 也能解析到）
  fs.writeFileSync(
    OUT_CLIENT_MARKER,
    "module.exports = require('./dist/client/index.js');\n",
    'utf8',
  );

  return { built: true, result, externalDeps };
}

// ---------------------------------------------------------------------------
// 产物自检
// ---------------------------------------------------------------------------

/** 产物自检：文件存在、导出形态正确（决定 NocoBase 能否取到 default） */
function verifyOutput() {
  const problems = [];

  if (!fs.existsSync(OUT_ENTRY)) {
    problems.push(`产物不存在：${OUT_ENTRY}`);
  } else {
    const code = fs.readFileSync(OUT_ENTRY, 'utf8');

    // NocoBase 用 `m.__esModule ? m.default : m` 取插件类。
    // esbuild 的 CJS 产物形态是：__toCommonJS(__export(...)) → 自带 __esModule 与 default 取值器。
    if (!/module\.exports\s*=\s*__toCommonJS\(/.test(code)) {
      problems.push('产物未走 __toCommonJS 包装，require 拿不到插件类');
    }
    if (!/__esModule/.test(code)) {
      problems.push('产物缺少 __esModule 标记，NocoBase 会把整个 module 对象当成插件类');
    }
    if (!/\bdefault\s*:\s*\(\)\s*=>/.test(code)) {
      problems.push('产物缺少 default 导出取值器');
    }
    if (!/ServiceTicketPlugin\s*=\s*class/.test(code)) {
      problems.push('产物中未发现 ServiceTicketPlugin 插件类');
    }
    // 被外置的依赖不允许出现内联实现
    if (/function\s+defineCollection\s*\(/.test(code)) {
      problems.push('疑似把 @nocobase/database 打进了产物（会破坏 collection 注册到正确的 Database 实例）');
    }
    if (!/require\("@nocobase\/database"\)/.test(code)) {
      problems.push('产物未以外部依赖方式引用 @nocobase/database');
    }
  }

  const outPkg = path.join(OUT_PLUGIN_DIR, 'package.json');
  if (!fs.existsSync(outPkg)) problems.push(`产物缺少 package.json：${outPkg}`);

  // ---- 客户端产物 ----
  // 这组断言存在的理由：客户端产物缺失**不会**让任何接口变红、也不会让构建报错，
  // 它只会让后台整页白给（真机复现过）。必须有一侧把它变成红灯。
  if (!fs.existsSync(OUT_CLIENT_ENTRY)) {
    problems.push(
      `客户端产物不存在：${OUT_CLIENT_ENTRY}` +
        '（后台 SPA 会请求 /static/plugins/@local/service-ticket/dist/client/index.js，404 即 App error）',
    );
  } else {
    const code = fs.readFileSync(OUT_CLIENT_ENTRY, 'utf8');
    if (!/define\.amd/.test(code)) {
      problems.push('客户端产物缺少 define.amd 分支，requirejs 无法注册该模块');
    }
    if (!/typeof define === 'function'/.test(code)) {
      problems.push('客户端产物不是 UMD 包装（缺少 typeof define === \'function\' 判定）');
    }
    if (!/未在 AMD 依赖里声明的外部模块/.test(code)) {
      problems.push('客户端产物缺少未声明依赖的报错分支（外部依赖白名单被绕过）');
    }
    if (!/__esModule/.test(code)) {
      problems.push('客户端产物缺少 __esModule，NocoBase 取不到 default 导出的插件类');
    }
    if (!/ServiceTicketClient/.test(code)) {
      problems.push('客户端产物中未发现 ServiceTicketClient 插件类');
    }
    if (!/require\("@nocobase\/client"\)/.test(code)) {
      problems.push('客户端产物未以外部依赖方式引用 @nocobase/client');
    }
    // React 必须外置：内联一份 React 会让 hooks 报 "Invalid hook call"，
    // 而且症状是"页面能开、一交互就崩"，非常难定位。
    if (/react\.development\.js|Invalid hook call/.test(code) || /function\s+createElement\s*\(/.test(code)) {
      problems.push('疑似把 React 打进了客户端产物（必须作为外部依赖，否则 hooks 会失效）');
    }
  }

  if (!fs.existsSync(OUT_CLIENT_MARKER)) {
    problems.push(`缺少客户端标记文件：${OUT_CLIENT_MARKER}` + '（核心插件包里都有这个文件）');
  }

  // ---- 迁移产物 ----
  // 数量必须与源一致：少一个 = 某个迁移永远不跑（且不一定报错），
  // 多一个 = dist 里残留了已删除源的旧产物（会在下次部署时被 umzug 当成新迁移执行）。
  const sources = collectMigrationSources();
  const built = fs.existsSync(OUT_MIGRATIONS_DIR)
    ? fs
        .readdirSync(OUT_MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.js') && !name.endsWith('.map'))
    : [];

  if (sources.length !== built.length) {
    problems.push(
      `迁移产物数量与源不一致：源 ${sources.length} 个 / 产物 ${built.length} 个` +
        `（产物目录：${path.relative(ROOT, OUT_MIGRATIONS_DIR)}）`,
    );
  }

  for (const source of sources) {
    const expected = path.basename(source, '.ts') + '.js';
    if (!built.includes(expected)) {
      problems.push(`迁移未生成产物：${expected}`);
      continue;
    }
    const code = fs.readFileSync(path.join(OUT_MIGRATIONS_DIR, expected), 'utf8');
    // loadMigrations 走 importModule → requireModule → `m.__esModule ? m.default : m`
    if (!/module\.exports\s*=\s*__toCommonJS\(/.test(code) || !/\bdefault\s*:\s*\(\)\s*=>/.test(code)) {
      problems.push(`迁移产物 ${expected} 不是带 default 导出的 CJS 形态，NocoBase 取不到迁移类`);
    }
    if (!/require\("@nocobase\/database"\)/.test(code)) {
      problems.push(`迁移产物 ${expected} 未以外部依赖方式引用 @nocobase/database（Migration 基类）`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  console.log('[build-plugin] 预检 …');
  preflight();
  preflightMigrations();

  const esbuild = loadEsbuild();

  // 清理旧产物，避免残留的旧文件被误加载
  if (fs.existsSync(path.join(OUT_PLUGIN_DIR, 'dist'))) {
    fs.rmSync(path.join(OUT_PLUGIN_DIR, 'dist'), { recursive: true, force: true });
  }

  if (WATCH) {
    const ctx = await esbuild.context({
      entryPoints: [SRC_ENTRY],
      outfile: OUT_ENTRY,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: ['node20'],
      sourcemap: true,
      external: EXTERNALS,
      keepNames: true,
      logLevel: 'info',
    });
    await ctx.watch();

    const migrationEntryPoints = collectMigrationSources();
    if (migrationEntryPoints.length > 0) {
      const migrationCtx = await esbuild.context({
        entryPoints: migrationEntryPoints,
        outdir: OUT_MIGRATIONS_DIR,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: ['node20'],
        sourcemap: true,
        external: EXTERNALS,
        keepNames: true,
        logLevel: 'info',
      });
      await migrationCtx.watch();
    }

    console.log('[build-plugin] watch 模式已启动，Ctrl+C 退出');
    return;
  }

  console.log('[build-plugin] 编译中 …');
  const { result, ms, migrations, client } = await buildOnce(esbuild);

  const problems = verifyOutput();
  if (problems.length) {
    console.error('[build-plugin] 产物自检失败：');
    for (const p of problems) console.error('  ✗ ' + p);
    process.exit(1);
  }

  const sizeKb = (fs.statSync(OUT_ENTRY).size / 1024).toFixed(1);
  const inputs = Object.keys(result.metafile?.inputs || {}).length;

  console.log('');
  console.log('  ✅ 插件构建成功');
  console.log(`     源文件数   : ${inputs}`);
  console.log(`     产物       : ${path.relative(ROOT, OUT_ENTRY)} (${sizeKb} KB)`);
  console.log(`     插件包     : ${path.relative(ROOT, path.join(OUT_PLUGIN_DIR, 'package.json'))}`);
  if (migrations.count > 0) {
    console.log(
      `     迁移       : ${migrations.count} 个 → ${path.relative(ROOT, OUT_MIGRATIONS_DIR)}`,
    );
  }
  if (client.built) {
    const clientKb = (fs.statSync(OUT_CLIENT_ENTRY).size / 1024).toFixed(1);
    console.log(
      `     客户端     : ${path.relative(ROOT, OUT_CLIENT_ENTRY)} (${clientKb} KB)` +
        ` · 外部依赖 ${client.externalDeps.length} 个`,
    );
  } else {
    console.log(`     客户端     : ⚠️ 未构建 —— ${client.reason}`);
  }
  console.log(`     耗时       : ${ms} ms`);
  console.log('');
  // ⚠️ 这一步**必须是 restart**（DEV-74 的血案）：
  //   服务端下发给浏览器的产物 URL 带 `?hash=`，该 hash = sha256(产物 **mtime** + APP_KEY +
  //   插件 version + appVersion + salt)[:8] —— **但结果被 `PackageUrls.items` 进程内缓存**。
  //   只跑 `docker compose up -d` 时容器**已经在运行**，配置没变 ⇒ Compose 认为无事可做、
  //   **不会重启进程** ⇒ 服务端继续下发**重建前的旧 hash** ⇒ 浏览器那个 URL 的缓存键没变
  //   ⇒ 即使产物已经换新，浏览器也永远拿不到（这正是"详情 404"拖了整轮的机制）。
  console.log('  下一步（**必做**，否则浏览器永远拿不到这一版产物）：');
  console.log('     docker compose restart app     # 必须"重启"；`up -d` 不会重启已运行的容器');
  console.log('     复核：node scripts/verify-bundle-delivery.mjs');
  console.log('     （原因：下发的 ?hash= 由产物 mtime 算出，却被服务进程缓存 —— 见 DEV-74）');
  console.log('');
}

main().catch((err) => {
  console.error('[build-plugin] 构建失败：');
  console.error(err);
  process.exit(1);
});
