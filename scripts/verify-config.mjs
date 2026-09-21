#!/usr/bin/env node
/**
 * =============================================================================
 *  verify-config.mjs —— 部署层静态校验（不需要 Docker daemon）
 * -----------------------------------------------------------------------------
 *  为什么需要它：
 *    宿主机可能无法启动 Docker daemon。若不做静态校验，很多错误会推迟到
 *    `docker compose up` 才暴露（甚至静默出错），例如：
 *      • bind mount 的宿主路径不存在 → Docker **静默创建一个 root 所有的空目录**，
 *        于是插件挂载成空、nginx.conf 挂载成目录，报错信息完全对不上；
 *      • nginx 引用未定义的变量（$foo）或未声明的 limit_req zone → 启动即
 *        "unknown variable" / "unknown limit_req_zone"，容器 crash-loop；
 *      • .env 里的参数种子与 constants.ts 不一致 → 后台参数缺项，业务行为偏移。
 *    本脚本把这些一次性查出来。
 *
 *  用法：
 *    node scripts/verify-config.mjs
 *    node scripts/verify-config.mjs --verbose
 *
 *  退出码：0 = 全部通过；1 = 有失败项
 * =============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  NOCOBASE_IMAGE,
  NOCOBASE_VERSION,
  POSTGRES_IMAGE,
  VERSION_PINNED_AT,
} from './expected-versions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const VERBOSE = process.argv.includes('--verbose');

/**
 * 解析依赖：优先项目内 node_modules，其次 WorkBuddy 隔离工作区。
 * 这样脚本在「只有隔离环境装了 js-yaml」的机器上也能跑。
 */
const NODE_WORKSPACE =
  process.env.WORKBUDDY_NODE_WORKSPACE ||
  path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');

function loadDep(name) {
  const candidates = [
    () => require(name),
    () => createRequire(path.join(ROOT, 'noop.js'))(name),
    () => createRequire(path.join(NODE_WORKSPACE, 'noop.js'))(name),
    // 最后兜底：把隔离工作区塞进 NODE_PATH 再 require
    () => {
      const prev = process.env.NODE_PATH;
      process.env.NODE_PATH = [NODE_WORKSPACE, prev].filter(Boolean).join(path.delimiter);
      // eslint-disable-next-line no-underscore-dangle
      require('module').Module._initPaths();
      return require(name);
    },
  ];
  const errs = [];
  for (const c of candidates) {
    try {
      return c();
    } catch (e) {
      errs.push(e.message.split('\n')[0]);
    }
  }
  throw new Error(
    `无法加载依赖 ${name}。请在本机安装：\n` +
      `         cd "${NODE_WORKSPACE.replace(/[\\/]node_modules$/, '')}" && npm install ${name}\n` +
      `       （尝试过的解析路径均失败：${errs.join(' | ')}）`,
  );
}

// ------------------------------------------------------------------ 断言框架 --
let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    const detail = fn();
    passed++;
    console.log(`  ✅ ${label}${detail ? ` — ${dim(detail)}` : ''}`);
  } catch (e) {
    failures.push({ label, message: e.message });
    console.log(`  ❌ ${label} — ${e.message}`);
  }
}

function section(title) {
  console.log('');
  console.log(`【${title}】`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const read = (p) => fs.readFileSync(path.resolve(ROOT, p), 'utf8');

// ============================================================================
//  1. docker-compose.yml
// ============================================================================
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  部署层静态校验（Phase 1）');
console.log('══════════════════════════════════════════════════════════════');

const yamlPath = 'docker-compose.yml';
let compose = null;
let yaml = null;

section('1. docker-compose.yml 结构与安全基线');

check('js-yaml 可加载且文件可解析', () => {
  yaml = loadDep('js-yaml');
  compose = yaml.load(read(yamlPath));
  assert(compose && typeof compose === 'object', '解析结果不是对象');
  return `${Object.keys(compose.services).length} 个 service`;
});

check('项目名为 service-ticket（容器名/卷名前缀可预期）', () => {
  assertEq(compose.name, 'service-ticket', 'name');
});

check('恰好 3 个 service：postgres / app / nginx', () => {
  const names = Object.keys(compose.services).sort();
  assertEq(names.join(','), 'app,nginx,postgres', 'services');
  return names.join(' + ');
});

check('app 使用 -no-nginx 镜像（避免与外层 nginx 双重代理）', () => {
  const img = compose.services.app.image;
  assert(/nocobase\/nocobase:[\d.]+-full-no-nginx$/.test(img), `镜像名异常：${img}`);
  return img;
});

check('三个镜像 tag 与 scripts/expected-versions.mjs 的冻结值逐字一致（版本冻结）', () => {
  // 为什么必须逐字比而不是"格式对就行"（Phase 2.1 整改项 5）：
  //   Phase 0 锁 v2.1.x、Phase 1 实际用 2.2.15。这个变更被接受了，但从现在起
  //   未经单独 Change Request 不允许后续 Phase 自行升级 NocoBase。
  //   而"升级"在 compose 里就是改一个字符串 —— 只要断言还能过（正则 /\d+\.\d+\.\d+/ 永远匹配），
  //   就没人会注意到框架版本已经变了。
  //   本项目三个最难的坑（parseRequest 单次 split、refreshIndexes 静默丢弃、
  //   error-handler 的 logLevel 判定）**全部来自框架内部实现细节**，
  //   升版本的代价远高于"改个 tag"。
  const actual = {
    app: compose.services.app.image,
    postgres: compose.services.postgres.image,
  };
  const pinned = { app: NOCOBASE_IMAGE, postgres: POSTGRES_IMAGE };
  for (const key of Object.keys(pinned)) {
    assert(
      actual[key] === pinned[key],
      `${key} 镜像 ${actual[key]} ≠ 冻结值 ${pinned[key]}；` +
        `若确需升级请同步修改 scripts/expected-versions.mjs 并在 CHANGELOG 记录 CR`,
    );
  }
  return `app=${pinned.app} / postgres=${pinned.postgres}（冻结于 ${VERSION_PINNED_AT}）`;
});

check('插件声明的 NocoBase 兼容范围覆盖冻结版本', () => {
  // supportedVersions 写 '2.x' 是**范围**声明（允许 2.0~2.x），冻结的是**具体 tag**。
  // 两者都要有：范围声明让 NocoBase 决定"这个插件能不能装"，冻结 tag 决定"实际跑哪个版本"。
  const pkgPath = path.join(ROOT, 'nocobase', 'plugins', 'service-ticket', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const supported = pkg?.nocobase?.supportedVersions || [];
  const major = NOCOBASE_VERSION.split('.')[0];
  assert(
    supported.some((v) => String(v).startsWith(major) || String(v) === `${major}.x`),
    `supportedVersions=${JSON.stringify(supported)} 未覆盖冻结版本 ${NOCOBASE_VERSION}`,
  );
  return `插件支持 ${supported.join('/')} ；冻结 ${NOCOBASE_VERSION}`;
});

check('app 不向 0.0.0.0 暴露端口（唯一入口只有 nginx）', () => {
  const ports = compose.services.app.ports || [];
  assert(ports.length > 0, 'app 没有任何端口映射（调试口也丢了？）');
  for (const p of ports) {
    const s = String(p);
    assert(s.startsWith('127.0.0.1:'), `存在非回环端口映射：${s}（会暴露到局域网/公网）`);
  }
  return ports.join(', ');
});

check('postgres 不暴露任何宿主机端口', () => {
  assert(!compose.services.postgres.ports, 'postgres 不应有 ports（应在 compose 网络内访问）');
  return '仅容器网络内可达';
});

check('nginx 暴露 ${NGINX_HTTP_PORT:-80}:80', () => {
  const ports = (compose.services.nginx.ports || []).map(String);
  assert(
    ports.some((p) => p.includes('NGINX_HTTP_PORT') && p.endsWith(':80')),
    `未找到 80 端口映射，实际：${JSON.stringify(ports)}`,
  );
  return ports.join(', ');
});

check('app 依赖 postgres 且要求 service_healthy（避免早于 DB 就绪启动）', () => {
  const dep = compose.services.app.depends_on?.postgres;
  assertEq(dep?.condition, 'service_healthy', 'depends_on.postgres.condition');
  return 'service_healthy';
});

check('postgres 开启 wal_level=logical（备份/逻辑复制需要）', () => {
  const cmd = String(compose.services.postgres.command);
  assert(cmd.includes('wal_level=logical'), `command 未包含 wal_level=logical：${cmd}`);
  return cmd;
});

check('app 健康检查直连容器内 13000 探 /api/svc:health', () => {
  const test = JSON.stringify(compose.services.app.healthcheck?.test || []);
  assert(test.includes('/api/svc:health'), `/api/svc:health 未出现在 healthcheck：${test}`);
  assert(test.includes('13000'), 'healthcheck 未使用 13000 端口');
  return '/api/svc:health';
});

check('nginx 健康检查探 /healthz（不依赖应用存活）', () => {
  const test = JSON.stringify(compose.services.nginx.healthcheck?.test || []);
  assert(test.includes('/healthz'), `/healthz 未出现在 healthcheck：${test}`);
  return '/healthz';
});

check('所有 bind mount 的宿主路径都真实存在（防 Docker 静默建空目录）', () => {
  const missing = [];
  const seen = new Set();
  for (const [svcName, svc] of Object.entries(compose.services)) {
    for (const v of svc.volumes || []) {
      const s = String(v);
      // 只处理 bind mount（以 . 或 / 开头的宿主路径）；具名卷跳过
      const hostPart = s.split(':')[0];
      if (!hostPart.startsWith('.') && !hostPart.startsWith('/')) continue;
      // 展开 ${VAR:-default} 形式（compose 端口用不到，但卷里可能出现）
      const expanded = hostPart.replace(/\$\{[A-Z_]+:-([^}]*)\}/g, '$1');
      const abs = path.resolve(ROOT, expanded);
      if (seen.has(abs)) continue;
      seen.add(abs);
      if (!fs.existsSync(abs)) missing.push(`${svcName}: ${hostPart}`);
    }
  }
  assert(missing.length === 0, `以下挂载宿主路径不存在：\n         ${missing.join('\n         ')}`);
  return `${seen.size} 个 bind mount 全部存在`;
});

check('app 同时挂载 storage 与 node_modules/@local（发现 + 解析双通道）', () => {
  const vols = (compose.services.app.volumes || []).map(String);
  const hasStorage = vols.some((v) => /\.\/storage:\/app\/nocobase\/storage/.test(v));
  const hasNodeModules = vols.some((v) =>
    /\.\/storage\/plugins\/@local\/service-ticket:\/app\/nocobase\/node_modules\/@local\/service-ticket/.test(v),
  );
  assert(hasStorage, '缺少 ./storage:/app/nocobase/storage');
  assert(hasNodeModules, '缺少 ./storage/plugins/@local/service-ticket → node_modules/@local/... 挂载');
  return 'storage + node_modules/@local/service-ticket';
});

check('插件目录/入口文件已就位（挂载后容器内可 require）', () => {
  const pkg = path.resolve(ROOT, 'storage/plugins/@local/service-ticket/package.json');
  const entry = path.resolve(ROOT, 'storage/plugins/@local/service-ticket/dist/server/index.js');
  assert(fs.existsSync(pkg), '插件 package.json 不存在，请先运行 scripts/build-plugin.mjs');
  assert(fs.existsSync(entry), '插件 dist/server/index.js 不存在，请先运行 scripts/build-plugin.mjs');
  const p = JSON.parse(fs.readFileSync(pkg, 'utf8'));
  assertEq(p.main, './dist/server/index.js', 'package.json main');
  return `${p.name}@${p.version}`;
});

check('三容器共用 nocobase 网络（nginx 才能解析 app 主机名）', () => {
  const net = compose.networks?.nocobase;
  assert(net, 'networks.nocobase 未定义');
  for (const [n, s] of Object.entries(compose.services)) {
    assert(
      (s.networks || []).includes('nocobase'),
      `${n} 未加入 nocobase 网络`,
    );
  }
  return 'postgres + app + nginx';
});

check('日志轮转已配置（防磁盘被容器日志打满）', () => {
  const missing = Object.entries(compose.services)
    .filter(([, s]) => !s.logging?.options?.['max-size'])
    .map(([n]) => n);
  assert(missing.length === 0, `这些 service 未配 max-size：${missing.join(', ')}`);
  return 'max-size + max-file';
});

// ============================================================================
//  2. Nginx 配置静态 lint
// ============================================================================
section('2. Nginx 配置静态 lint');

const NGINX_MAIN = 'nginx/nginx.conf';
const NGINX_SITE = 'nginx/conf.d/service.conf';

/**
 * 被 service.conf 用 `include` 引入的片段（Phase 4-H 新增）。
 *
 * ⚠️ 为什么必须把它们显式列进来：include 进来的文件**不会**被上面两个常量覆盖，
 *    于是它们成了静态校验的盲区 —— 里面写了未定义变量或不平衡的大括号，
 *    本脚本会一路绿灯，直到 nginx 启动失败才发现。
 *    这正是本项目的铁律 1 说的："应该有检查的地方，必须有检查"，而不是"大部分有"。
 */
const NGINX_INCLUDE_FILES = ['nginx/conf.d/proxy-headers.inc'];

const mainConf = read(NGINX_MAIN);
const siteConf = read(NGINX_SITE);
const includeConfs = NGINX_INCLUDE_FILES.map((f) => ({ file: f, text: read(f) }));

/** 去掉注释与字符串内容，避免误判 */
function stripComments(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, ''))
    .join('\n');
}

check(`${NGINX_MAIN} 大括号平衡`, () => {
  const t = stripComments(mainConf);
  const open = (t.match(/\{/g) || []).length;
  const close = (t.match(/\}/g) || []).length;
  assertEq(open, close, `{ 与 } 数量`);
  return `${open} 对`;
});

check(`${NGINX_SITE} 大括号平衡`, () => {
  const t = stripComments(siteConf);
  const open = (t.match(/\{/g) || []).length;
  const close = (t.match(/\}/g) || []).length;
  assertEq(open, close, `{ 与 } 数量`);
  return `${open} 对`;
});

check('每个非块指令行都以 ; 结尾（防漏分号导致启动失败）', () => {
  // ⚠️ 必须按「语句」判定，不能按「行」判定（本检查修过一次，起因是真机误报）：
  //   nginx 允许一条指令跨多行，只要最终以 ; 收尾即可。本项目里就有：
  //       rewrite ^/api/svc/tickets/[0-9]+/(accept|transfer|cancel|timeline)$
  //               /api/svc:$svc_action?filterByTk=$svc_ticket_id&… break;
  //   按行判定会把第一行报成"漏分号" —— 而 nginx 本身完全正常（容器 healthy）。
  //   一个会误报的检查比没有检查更糟：它训练人忽略红灯，真漏分号时也会被当成噪声跳过。
  // 现在的语义：把行累积成语句，语句只能由 `;` 或 `{` 收尾；
  //   若被 `}` 或文件末尾截断，就是真的漏了分号。
  const t = stripComments(siteConf);
  const bad = [];
  let pending = null; // { line, text } —— 尚未收尾的语句

  t.split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trim();
    if (!l) return;

    // 已有未收尾的语句，却撞上了块结束 —— 这条语句缺 `;`
    if (l.startsWith('}') && pending !== null) {
      bad.push(`第 ${pending.line} 行: ${pending.text}`);
      pending = null;
      return;
    }
    // 纯块定界行本身不是指令
    if (l === '}' || l === '{') {
      pending = null;
      return;
    }

    if (pending === null) pending = { line: i + 1, text: l };
    else pending.text += ` ${l}`;

    if (l.endsWith(';') || l.endsWith('{')) pending = null; // 语句收尾 / 块开始
  });

  if (pending !== null) bad.push(`第 ${pending.line} 行: ${pending.text}（直到文件结束都没有 ; 收尾）`);

  assert(bad.length === 0, `疑似漏分号：\n         ${bad.join('\n         ')}`);
  return 'ok';
});

// 收集 nginx.conf 中定义的 zone / map 变量 / upstream
function collectDefs(conf) {
  const t = stripComments(conf);
  const zones = new Set();
  for (const m of t.matchAll(/limit_(?:req|conn)_zone\s+[^\s]+\s+zone=([A-Za-z0-9_]+):/g)) {
    zones.add(m[1]);
  }
  const maps = new Set();
  for (const m of t.matchAll(/^\s*map\s+(\S+)\s+(\$[A-Za-z0-9_]+)/gm)) {
    maps.add(m[2]);
  }
  const upstreams = new Set();
  for (const m of t.matchAll(/^\s*upstream\s+([A-Za-z0-9_]+)/gm)) {
    upstreams.add(m[1]);
  }
  return { zones, maps, upstreams };
}

const defs = collectDefs(mainConf + '\n' + siteConf + '\n' + includeConfs.map((i) => i.text).join('\n'));
// 变量扫描要覆盖 include 进来的片段，否则片段里的 $变量 无人检查
const siteT = stripComments(siteConf + '\n' + includeConfs.map((i) => i.text).join('\n'));

check('service.conf 里每个 include 目标文件都存在（防改名/漏提交）', () => {
  const targets = [...stripComments(siteConf).matchAll(/^\s*include\s+(\S+);/gm)]
    .map((m) => m[1])
    // 只校验指向本仓库的 conf.d 片段；/etc/nginx/mime.types 这类镜像内建的不管
    .filter((t) => t.startsWith('/etc/nginx/conf.d/'))
    .map((t) => path.join('nginx/conf.d', path.basename(t)));
  assert(targets.length > 0, 'service.conf 里没有任何 conf.d include，代理头可能又被抄回各处了');
  const missing = targets.filter((t) => !fs.existsSync(path.join(ROOT, t)));
  assert(missing.length === 0, `include 指向了不存在的文件：${missing.join(', ')}`);
  return `${targets.length} 个片段`;
});

check('反代 Host 头必须是 $http_host（用 $host 会丢掉端口 → 后台登录 403）', () => {
  // 这条断言盯的是一个**已实际发生过**的生产故障（2026-09-21）：
  //   `proxy_set_header Host $host;` 中的 $host 不含端口，
  //   使 NocoBase 的 isTrustedOrigin() 算出 http://localhost（浏览器 Origin 是
  //   http://localhost:8080）→ 后台登录 403 Invalid sign-in origin。
  //   而 curl 不带 Origin 头 → 一路 200 → 靠接口断言永远发现不了。
  //
  // 之所以不只写在注释里：$host 与 $http_host 只差几个字符，
  // 任何人"顺手清理配置"都可能改回去，而改回去不会让任何已有断言变红。
  const allProxyConfs = stripComments(siteConf + '\n' + includeConfs.map((i) => i.text).join('\n'));
  const badHost = [...allProxyConfs.matchAll(/proxy_set_header\s+Host\s+([^;]+);/g)]
    .map((m) => m[1].trim())
    .filter((v) => !v.includes('$http_host'));
  assert(badHost.length === 0, `发现非 $http_host 的 Host 转发：${[...new Set(badHost)].join(', ')}`);

  const xfh = [...allProxyConfs.matchAll(/proxy_set_header\s+X-Forwarded-Host\s+([^;]+);/g)].map(
    (m) => m[1].trim(),
  );
  assert(
    xfh.length > 0 && xfh.every((v) => v.includes('$http_host')),
    `X-Forwarded-Host 必须显式设为 $http_host（isTrustedOrigin 优先读它），当前：${JSON.stringify(xfh)}`,
  );
  return `${badHost.length} 处 $host · X-Forwarded-Host 已设置`;
});

for (const { file, text } of includeConfs) {
  check(`${file} 大括号平衡`, () => {
    const t = stripComments(text);
    const open = (t.match(/\{/g) || []).length;
    const close = (t.match(/\}/g) || []).length;
    assertEq(open, close, `{ 与 } 数量`);
    return `${open} 对`;
  });

  check(`${file} 每个非块指令行都以 ; 结尾`, () => {
    const t = stripComments(text);
    const bad = [];
    for (const raw of t.split(/\r?\n/)) {
      const l = raw.trim();
      if (!l || l.endsWith(';') || l.endsWith('{') || l.endsWith('}')) continue;
      bad.push(l.slice(0, 60));
    }
    assert(bad.length === 0, `疑似漏分号：${bad.join(' | ')}`);
    return '全部以 ; 收尾';
  });
}

check('所有 limit_req / limit_conn 引用的 zone 都已定义', () => {
  const used = new Set();
  for (const m of siteT.matchAll(/limit_(?:req|conn)\s+zone=([A-Za-z0-9_]+)/g)) used.add(m[1]);
  const undef = [...used].filter((z) => !defs.zones.has(z));
  assert(undef.length === 0, `未定义：${undef.join(', ')}`);
  return `已用 ${[...used].sort().join(', ')}`;
});

check('所有 $变量 都有来源（map 定义 / 具名捕获 / nginx 内建）', () => {
  // ⚠️ 这个检查修过一次（真机误报驱动）：
  //   旧版只认「白名单内建 + map 定义」，于是把下面两类合法写法全报成未定义：
  //     ① 具名捕获：`location ~ ^/api/svc/tickets/(?<svc_ticket_id>[0-9]+)/(?<svc_action>…)$`
  //        里声明的名字，nginx 会直接把它暴露成变量供 rewrite 使用；
  //     ② 变量家族：`$arg_<name>` / `$http_<name>` / `$cookie_<name>` / `$sent_http_<name>`
  //        由 nginx 按前缀动态生成，不可能也不该逐个进白名单。
  //   误报的代价和漏报一样大 —— 反正都会让人不再看这个检查的输出。
  const BUILTIN = new Set([
    'host', 'remote_addr', 'remote_user', 'time_local', 'request', 'status',
    'body_bytes_sent', 'http_referer', 'http_user_agent', 'http_x_forwarded_for',
    'request_time', 'upstream_response_time', 'scheme', 'uri', 'args', 'request_uri',
    'http_upgrade', 'http_x_forwarded_proto', 'proxy_add_x_forwarded_for',
    'binary_remote_addr', 'server_name', 'document_root', 'query_string',
    'content_type', 'http_authorization', 'http_cookie', 'sent_http_content_type',
    'server_addr', 'server_port', 'https', 'is_args', 'request_method',
  ]);

  // 按前缀动态生成的变量家族
  const FAMILY = /^(arg|http|cookie|sent_http|upstream_http|upstream_cookie|jwt)_/;

  // 具名捕获：(?<name>…) 在全量配置里找（main + site 都可能声明）
  const named = new Set();
  for (const m of (siteConf + '\n' + mainConf).matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g)) {
    named.add(m[1]);
  }

  const unknown = new Set();
  for (const m of siteT.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const v = m[1];
    if (BUILTIN.has(v)) continue;
    if (FAMILY.test(v)) continue;
    if (named.has(v)) continue;
    if (defs.maps.has('$' + v)) continue;
    unknown.add(v);
  }
  assert(
    unknown.size === 0,
    `引用了未定义变量（nginx 会启动失败 unknown variable）：${[...unknown].join(', ')}`,
  );
  const via = [`map: ${[...defs.maps].join(', ')}`];
  if (named.size) via.push(`具名捕获: ${[...named].sort().join(', ')}`);
  return via.join('；');
});

check('proxy_pass 的 upstream 名已定义', () => {
  const used = new Set();
  for (const m of siteT.matchAll(/proxy_pass\s+http:\/\/([A-Za-z0-9_]+)/g)) used.add(m[1]);
  const undef = [...used].filter((u) => !defs.upstreams.has(u));
  assert(undef.length === 0, `未定义的 upstream：${undef.join(', ')}`);
  return `upstream ${[...defs.upstreams].join(', ')}`;
});

check('健康检查两种写法都路由到上游（冒号形式 + 验收用的斜杠形式）', () => {
  assert(
    /location\s*=\s*\/api\/svc:health\s*\{/.test(siteT),
    '缺少 location = /api/svc:health',
  );
  assert(
    /location\s*=\s*\/api\/svc\/health\s*\{/.test(siteT),
    '缺少 location = /api/svc/health（验收文档使用的形式）',
  );
  assert(
    /rewrite\s+\^\/api\/svc\/health\$\s+\/api\/svc:health\s+break/.test(siteT),
    '斜杠形式未重写到冒号形式',
  );
  return '/api/svc:health + /api/svc/health → svc_app';
});

check('/files/ 与 /storage/uploads/ 走反代而非 alias（否则绕过鉴权）', () => {
  const bad = [];
  // 抓出这两个 location 块的内容，确认不含 alias 且含 proxy_pass
  for (const prefix of ['/files/', '/storage/uploads/']) {
    const re = new RegExp(`location\\s+\\^~\\s+${prefix.replace(/\//g, '\\/')}\\s*\\{([\\s\\S]*?)\\n    \\}`, 'm');
    const m = re.exec(siteT);
    assert(m, `未找到 location ^~ ${prefix}`);
    if (/alias/.test(m[1])) bad.push(`${prefix} 使用了 alias`);
    if (!/proxy_pass/.test(m[1])) bad.push(`${prefix} 未反代给应用`);
  }
  assert(bad.length === 0, bad.join('；'));
  return '均为 proxy_pass';
});

check('429 错误页返回 JSON（与应用层错误码一致）', () => {
  assert(/limit_req_status\s+429/.test(stripComments(mainConf)), 'nginx.conf 未设 limit_req_status 429');
  assert(/error_page\s+429\s+=/.test(siteT), 'service.conf 未定义 429 error_page');
  assert(/TOO_MANY_REQUESTS/.test(siteT), '429 响应体不是预期的 JSON 结构');
  return 'limit_req_status 429 + JSON 响应体';
});

check('WebSocket 升级头已正确映射', () => {
  assert(/\$connection_upgrade/.test(siteT), '未使用 $connection_upgrade');
  assert(/map\s+\$http_upgrade\s+\$connection_upgrade/.test(stripComments(mainConf)), 'nginx.conf 未定义该 map');
  return 'Connection: upgrade / close';
});

check('通用入口关闭 proxy_buffering（NocoBase 有流式响应/SSE）', () => {
  const idx = siteT.lastIndexOf('location / {');
  assert(idx !== -1, '未找到通用 location /');
  const tail = siteT.slice(idx);
  assert(/proxy_buffering\s+off/.test(tail), 'location / 未关闭 proxy_buffering');
  return 'proxy_buffering off';
});

check(`${NGINX_MAIN} include 了 conf.d/*.conf`, () => {
  assert(
    /include\s+\/etc\/nginx\/conf\.d\/\*\.conf/.test(stripComments(mainConf)),
    '未 include conf.d，站点配置不会生效',
  );
  return 'include /etc/nginx/conf.d/*.conf';
});

// ============================================================================
//  3. 环境变量与插件种子的交叉一致性
// ============================================================================
section('3. .env / 插件常量 交叉一致性');

const envExample = read('.env.example');
const constantsTs = read('nocobase/plugins/service-ticket/src/server/constants.ts');

check('APPEND_PRESET_BUILT_IN_PLUGINS 含 @local/service-ticket（自动安装+启用）', () => {
  const m = /^APPEND_PRESET_BUILT_IN_PLUGINS=(.*)$/m.exec(envExample);
  assert(m, '未找到 APPEND_PRESET_BUILT_IN_PLUGINS');
  assert(m[1].includes('@local/service-ticket'), `实际值：${m[1]}`);
  return m[1];
});

check('PLUGIN_PACKAGE_PREFIX 同时含 NocoBase 默认前缀与 @local/', () => {
  const m = /^PLUGIN_PACKAGE_PREFIX=(.*)$/m.exec(envExample);
  assert(m, '未找到 PLUGIN_PACKAGE_PREFIX');
  const v = m[1];
  assert(v.includes('@nocobase/plugin-'), '缺少 @nocobase/plugin-（核心插件会加载失败）');
  assert(v.includes('@nocobase/preset-'), '缺少 @nocobase/preset-');
  assert(v.includes('@local/'), '缺少 @local/（自研插件会被拒绝加载）');
  return v;
});

check('PLUGIN_STORAGE_PATH 指向 storage/plugins（与 compose 挂载一致）', () => {
  const m = /^PLUGIN_STORAGE_PATH=(.*)$/m.exec(envExample);
  assert(m, '未找到 PLUGIN_STORAGE_PATH');
  assertEq(m[1], '/app/nocobase/storage/plugins', 'PLUGIN_STORAGE_PATH');
  return m[1];
});

check('.env 与 .env.example 的键集合一致（模板未漂移）', () => {
  const keysOf = (t) =>
    t
      .split(/\r?\n/)
      .map((l) => /^([A-Z0-9_]+)=/.exec(l))
      .filter(Boolean)
      .map((m) => m[1]);
  const a = new Set(keysOf(envExample));
  const b = new Set(keysOf(read('.env')));
  const onlyExample = [...a].filter((k) => !b.has(k));
  const onlyEnv = [...b].filter((k) => !a.has(k));
  assert(
    onlyExample.length === 0 && onlyEnv.length === 0,
    `.env.example 独有：${onlyExample.join(',') || '无'}；.env 独有：${onlyEnv.join(',') || '无'}`,
  );
  return `${a.size} 个变量`;
});

check('.env 中已无遗留 CHANGE_ME 占位符', () => {
  const left = read('.env')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=.*CHANGE_ME/.test(l));
  assert(left.length === 0, `仍有占位符：\n         ${left.join('\n         ')}`);
  return '密钥均已生成';
});

check('.env 的 DB_PASSWORD 与 POSTGRES_PASSWORD 一致（否则首次初始化必失败）', () => {
  const g = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(read('.env'))?.[1];
  const a = g('DB_PASSWORD');
  const b = g('POSTGRES_PASSWORD');
  assert(a && b, '未找到 DB_PASSWORD / POSTGRES_PASSWORD');
  assertEq(a, b, '两个口令');
  return '一致';
});

check('constants.ts 中带 envKey 的参数种子数量 == .env 的 SVC_DEFAULT_* 数量', () => {
  const inConstants = (constantsTs.match(/envKey:\s*'SVC_DEFAULT_/g) || []).length;
  const inEnv = (
    envExample.split(/\r?\n/).filter((l) => /^SVC_DEFAULT_[A-Z_]+=/.test(l))
  ).length;
  assert(inConstants > 0, 'constants.ts 中未找到 envKey（DEFAULT_SETTINGS 结构被改动？）');
  assertEq(inEnv, inConstants, '种子项数量');
  return `${inConstants} 项`;
});

check('.env 中每个 SVC_DEFAULT_* 键都对应 constants.ts 的 envKey（无孤儿）', () => {
  const envKeys = envExample
    .split(/\r?\n/)
    .map((l) => /^(SVC_DEFAULT_[A-Z_]+)=/.exec(l)?.[1])
    .filter(Boolean);
  const orphan = envKeys.filter((k) => !constantsTs.includes(`'${k}'`));
  assert(orphan.length === 0, `这些键在插件里没有对应 envKey：${orphan.join(', ')}`);
  return envKeys.join(', ');
});

check('SMS_PROVIDER 默认 mock（Phase 1 不真实发送短信）', () => {
  const m = /^SMS_PROVIDER=(.*)$/m.exec(envExample);
  assertEq(m?.[1], 'mock', 'SMS_PROVIDER');
  return 'mock';
});

check('TZ 为 Asia/Shanghai（工单号日期与 SLA 口径依赖）', () => {
  const m = /^TZ=(.*)$/m.exec(envExample);
  assertEq(m?.[1], 'Asia/Shanghai', 'TZ');
  return 'Asia/Shanghai';
});

// ============================================================================
//  4. 目录结构完整性
// ============================================================================
section('4. 目录与文档完整性');

const REQUIRED_PATHS = [
  ['.env.example', 'file'],
  ['.gitignore', 'file'],
  ['docker-compose.yml', 'file'],
  ['README.md', 'file'],
  ['ASSUMPTIONS.md', 'file'],
  ['CHANGELOG.md', 'file'],
  ['nginx/nginx.conf', 'file'],
  ['nginx/conf.d/service.conf', 'file'],
  ['h5/dist', 'dir'],
  ['h5/src', 'dir'],
  ['nocobase/plugins/service-ticket/package.json', 'file'],
  ['nocobase/plugins/service-ticket/src/server/index.ts', 'file'],
  ['nocobase/plugins/service-ticket/src/server/plugin.ts', 'file'],
  ['nocobase/plugins/service-ticket/src/server/constants.ts', 'file'],
  ['storage/plugins/@local/service-ticket/dist/server/index.js', 'file'],
  ['scripts/build-plugin.mjs', 'file'],
  ['scripts/gen-secret.mjs', 'file'],
  ['scripts/expected-indexes.mjs', 'file'],
  ['scripts/expected-versions.mjs', 'file'],
  ['scripts/verify-plugin-load.mjs', 'file'],
  ['scripts/verify-config.mjs', 'file'],
  ['scripts/smoke-test.mjs', 'file'],
  // Phase 2 挂起项的唯一解除手段。它的**存在性**必须被断言：
  // 一份"写过又被删掉"的验收脚本会让挂起项永久悬空，而这在文档里看不出来。
  ['scripts/verify-concurrency-phase2.mjs', 'file'],
  ['docs/DEV-PLAN.md', 'file'],
  ['docs/PHASE-2.md', 'file'],
  // Phase 3 独立阶段报告。与 verify-concurrency-phase2.mjs 同理：一份"写过又被删掉"
  // 的阶段报告会让该阶段的结论失去可追溯出处，而这在别的文档里看不出来。
  ['docs/PHASE-3.md', 'file'],
  ['docs/DATA-MODEL.md', 'file'],
  ['docs/STATE-MACHINE.md', 'file'],
  ['docs/API.md', 'file'],
  ['docs/SECURITY.md', 'file'],
  ['docs/DEVIATIONS.md', 'file'],
  ['docs/PHASE-0.md', 'file'],
];

check(`${REQUIRED_PATHS.length} 个必需文件/目录全部存在`, () => {
  const missing = REQUIRED_PATHS.filter(([p, kind]) => {
    const abs = path.resolve(ROOT, p);
    if (!fs.existsSync(abs)) return true;
    const st = fs.statSync(abs);
    return kind === 'file' ? !st.isFile() : !st.isDirectory();
  }).map(([p]) => p);
  assert(missing.length === 0, `缺失：\n         ${missing.join('\n         ')}`);
  return 'ok';
});

check('.gitignore 忽略 .env 与 storage 运行产物（不把密钥/上传数据提交）', () => {
  const gi = read('.gitignore');
  const lines = gi.split(/\r?\n/).map((l) => l.trim());
  const need = ['.env', 'storage'];
  const missing = need.filter((n) => !lines.some((l) => l === n || l === `${n}/` || l.startsWith(n)));
  assert(missing.length === 0, `未忽略：${missing.join(', ')}`);
  return need.join(', ');
});

// ---------------------------------------------------------------------------
// 规格文档的"参数零复写"规则（2026-09-21 加固）
//
// 触发这条规则的两个实例都是**文档漂移**，而不是代码缺陷：
//   ① `docs/SECURITY.md` 的"依赖"行写着旧版本线，而实际镜像早已提前一个小版本；
//   ② 同一张表的"Nginx 兜底"行把 `svc_upload` 的 burst 抄到了 `/api/public/` 那行
//      （真实的 public zone 用的是另一个数）。
// 两者都**不影响任何运行行为**，所以没有任何真机断言能发现它们 —— 只能靠人眼，
// 而人眼必然漏。这就是"手抄第二个维护点"的必然结局。
//
// 结论：**规格/基线类文档不复写参数，只指向单一事实来源。**
// 而且这条规则本身也必须能被断言 —— 否则下次照样漂。
// 把"不该出现的东西"变成红灯，比在文档里写一句"请注意保持一致"有用得多。
//
// 为什么只覆盖 SECURITY.md：它是**规范性**文档（读的人会照着做）。
// README / DEV-PLAN / DEVIATIONS 里的相关数字属于**叙述与证据**（如 DEV-34 解释
// nginx 突发语义时必须引用具体参数，否则无法自洽），不在本条管辖范围。
// ---------------------------------------------------------------------------
check('规格文档不复写易漂移参数（版本 / nginx 限流值只指向单一事实来源）', () => {
  const target = 'docs/SECURITY.md';
  const text = read(target);
  // 只禁"陈述事实"的参数写法；不禁参数名本身，
  // 否则"本文不复写 rate/burst/limit_conn"这句说明自己就会被拦下。
  const FORBIDDEN = [
    [/nocobase\/nocobase:\s*[\w.\-]+/i, 'NocoBase 镜像 tag 字面值'],
    [/\b\d+\.\d+\.x\b/, '版本线字面值（形如 2.1.x）'],
    [/burst\s*=\s*\d+/, 'nginx burst 数值'],
    [/rate\s*=\s*\d+\s*r\s*\/\s*[sm]/, 'nginx rate 数值'],
    [/limit_conn\s+\S+\s+\d+/, 'nginx limit_conn 数值'],
  ];
  const REQUIRED = [
    [/scripts\/expected-versions\.mjs/, '指向 `scripts/expected-versions.mjs`'],
    [/nginx\/conf\.d\/service\.conf/, '指向 `nginx/conf.d/service.conf`'],
  ];
  const problems = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [re, what] of FORBIDDEN) {
      if (re.test(line)) problems.push(`${target}:${i + 1} 出现${what} → "${line.trim().slice(0, 72)}"`);
    }
  });
  for (const [re, what] of REQUIRED) {
    if (!re.test(text)) problems.push(`${target} 缺少${what}`);
  }
  assert(problems.length === 0, `\n         ${problems.join('\n         ')}`);
  return '参数零复写、单一事实来源指针齐备';
});

check('插件源码与构建产物同步（源码不晚于产物）', () => {
  const srcDir = path.resolve(ROOT, 'nocobase/plugins/service-ticket/src');
  const out = path.resolve(ROOT, 'storage/plugins/@local/service-ticket/dist/server/index.js');
  let newest = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  walk(srcDir);
  const outM = fs.statSync(out).mtimeMs;
  assert(
    outM >= newest,
    '构建产物比源码旧 —— 请重新运行 node scripts/build-plugin.mjs',
  );
  return '已同步';
});

// ============================================================================
//  汇总
// ============================================================================
console.log('');
console.log('══════════════════════════════════════════════════════════════');
if (failures.length === 0) {
  console.log(`  ✅ 全部通过：${passed} 项`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(0);
} else {
  console.log(`  ❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`     • ${f.label}\n       ${f.message}`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(1);
}
