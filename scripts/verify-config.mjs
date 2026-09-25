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
import { readDefaultSettingValueMap } from './expected-settings.mjs';

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

/**
 * UAT 临时口令是**唯一的合法例外**，必须收窄成白名单而不是放宽比对。
 *
 * 背景：`scripts/uat-accounts.mjs --create` 会把三个走查账号口令写进本机 `.env`
 * 的 `UAT_*_PASSWORD`。这三个键**绝不允许**进 `.env.example`——本仓库是公开仓库，
 * 写模板等于把后台口令一起公开。
 *
 * ⚠️ 所以这里不是"忽略 UAT_ 前缀"，而是逐一列出**确切键名**：
 * 若将来有人把 `UAT_STORE_C_PASSWORD` 或别的敏感键漏进 .env，
 * 上面的"键集合必须一致"照样会红。放宽到前缀匹配就等于把闸门拆了。
 */
const UAT_PASSWORD_KEYS = [
  'UAT_STORE_A_PASSWORD',
  'UAT_STORE_B_PASSWORD',
  'UAT_HQ_PASSWORD',
  // 验收用管理员口令（2026-09-23 加入）。
  //
  // ⚠️ 为什么必须在白名单里：这三个键**只在 .env 里实际赋值**，模板中刻意保持
  //    **注释形态**（`# SMOKE_ADMIN_PASSWORD=`），否则公开仓库就会带上真实口令。
  //    而本检查的语义是".env 的键必须在模板里出现"——注释不算"出现"，
  //    所以豁免是**设计上**需要的，不是绕过检查。
  //
  // ⚠️ 不要为了让它变绿而把模板里的注释删掉：下面的反向验证会因此报
  //    "完全找不到"并变红（那正是 2026-09-22 修掉的那个假绿）。
  'SMOKE_ADMIN_EMAIL',
  'SMOKE_ADMIN_PASSWORD',
];

check('.env 与 .env.example 的键集合一致（UAT 临时口令按白名单豁免）', () => {
  const keysOf = (t) =>
    t
      .split(/\r?\n/)
      .map((l) => /^([A-Z0-9_]+)=/.exec(l))
      .filter(Boolean)
      .map((m) => m[1]);
  // 读注释形式的键名也算：模板里以 `# UAT_XXX_PASSWORD=` 注释保留，便于走查时取消注释
  const exampleKeys = keysOf(envExample);
  const envKeys = keysOf(read('.env')).filter((k) => !UAT_PASSWORD_KEYS.includes(k));
  const onlyExample = exampleKeys.filter((k) => !envKeys.includes(k) && !UAT_PASSWORD_KEYS.includes(k));
  const onlyEnv = envKeys.filter((k) => !exampleKeys.includes(k));
  assert(
    onlyExample.length === 0,
    `.env.example 里的键在 .env 中不存在（模板未落地）：${onlyExample.join(', ') || '无'}`,
  );
  assert(
    onlyEnv.length === 0,
    `.env 里出现了 .env.example 没有的键：${onlyEnv.join(', ') || '无'}` +
      `（若确为新配置项，请补进模板；若是敏感键，请加进 UAT_PASSWORD_KEYS 白名单）`,
  );
  // 反向验证 A：白名单键在模板里必须**存在**，且必须是注释形态。
  //
  // ⚠️ 2026-09-22 修掉一个假绿：原实现用
  //      text.split(/\r?\n/).find(l => l.includes(k)) ?? ''
  //    来判断"是否被实际赋值"。但当该键**完全不存在**于模板时，find 返回 undefined
  //    → 落到 ?? '' → 空串上跑 /^\s*[A-Z0-9_]+=/ 得 false → **判定为"没泄露"**。
  //    实测三态：①键不存在 → []；②真泄露(改成赋值) → [k]；③注释保留 → []。
  //    ①与③不可区分 —— "读到空"被当成了"安全"。这正是工程铁律 10 说的最坏假绿：
  //    它不会误报，但会把"闸门其实已经不在模板里了"静默放过。
  //    所以现在把"存在且为注释形态"做成硬要求，缺一即红。
  const exampleLines = read('.env.example').split(/\r?\n/);
  const missing = [];
  const leaked = [];
  for (const k of UAT_PASSWORD_KEYS) {
    const line = exampleLines.find((l) => l.includes(k));
    if (line === undefined) {
      missing.push(k);
      continue;
    }
    // 注释形态：允许前导空白 + `#`，之后紧跟 `键=`，且等号后为空
    if (!/^\s*#\s*[A-Z0-9_]+=\s*$/.test(line)) leaked.push(k);
  }
  assert(
    missing.length === 0,
    `这些键在 .env.example 里**完全找不到**（白名单豁免就失去了"模板里留了坑位"的意义，` +
      `且原反向检查会因此假绿）：${missing.join(', ')}`,
  );
  assert(
    leaked.length === 0,
    `这些键在 .env.example 里不是"注释形态"，可能被**实际赋值**了` +
      `（会随公开仓库泄露口令）：${leaked.join(', ')}`,
  );
  return `${exampleKeys.length} 个模板键 + ${UAT_PASSWORD_KEYS.length} 个 UAT 临时口令（模板留注释坑位）`;
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
//  3.x 对外基址（PUBLIC_BASE_URL）—— 短信里那个链接的"根"
// ============================================================================
//
// 为什么这一组必须有**硬断言**而不是写在 .env 的注释里：
//   PUBLIC_BASE_URL 错了的表现是「Token 完全正确、短信也发送成功，
//   但师傅点进去是另一个系统（或根本打不开）」—— 业务链条上每一环都"成功"，
//   没有任何一处会报错。这类缺陷只能靠"拿配置去真的发一次请求"或
//   "与端口做交叉核对"来发现，写注释是挡不住的。
//
// 本组做**离线**交叉核对（不需要网络与 Docker）：端口、形态、前缀三件事。
// 真正"请求一次确认落到本实例"的联机闸门在
// `scripts/verify-technician-routing.mjs`（并入 uat-preflight）。

/** 从 .env 形态的文本里取某个键的值（未找到返回 undefined） */
const envValueOf = (text, key) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim();

/** 取 constants.ts 里某个 `export const X = { ... } as const;` 块的正文 */
const constantsBlock = (name) => {
  const start = constantsTs.indexOf(`export const ${name} = {`);
  assert(start >= 0, `constants.ts 里找不到 ${name} 定义（被改名？）`);
  const end = constantsTs.indexOf('} as const;', start);
  assert(end > start, `${name} 定义缺少结尾 "} as const;"`);
  return constantsTs.slice(start, end);
};

check('PUBLIC_BASE_URL 是绝对 http(s) 地址、只含 origin（无路径、无尾部斜杠）', () => {
  const raw = envValueOf(read('.env'), 'PUBLIC_BASE_URL');
  assert(raw, '.env 里缺少 PUBLIC_BASE_URL');
  assert(
    !raw.endsWith('/'),
    `PUBLIC_BASE_URL 末尾不能有斜杠（当前 "${raw}"）——` +
      '拼接出的链接会变成 https://x.com//t/<token>，与 nginx 的 location 不匹配',
  );

  let url;
  try {
    url = new URL(raw);
  } catch {
    assert(false, `PUBLIC_BASE_URL 不是合法绝对 URL："${raw}"（必须带协议，如 http://localhost:8080）`);
  }
  assert(
    url.protocol === 'http:' || url.protocol === 'https:',
    `PUBLIC_BASE_URL 协议必须是 http/https，当前 "${url.protocol}"`,
  );
  // URL('http://localhost') 的 pathname 是 '/', 带路径（如 http://x/svc）则是 '/svc'
  assert(
    url.pathname === '/',
    `PUBLIC_BASE_URL 只能到 origin，不能带路径（当前 "${url.pathname}"）——` +
      '代码会直接拼 `${BASE}/t/<token>`，带路径会把短链拼到子目录下',
  );
  return raw;
});

check('PUBLIC_BASE_URL 的端口与 NGINX_HTTP_PORT 一致（本地 8080 时最容易错的一处）', () => {
  // 这条是本次（Phase 5 P5-0）新增闸门的核心：两处各写一份端口，
  // 改了 nginx 没改基址（或反之）时，短信链接会指向另一个端口 ——
  // 本机 80 已被 CRMEB 占用，所以错了**往往还能连上别的服务**，
  // 表现是"点进去是另一个系统的页面"，比 404 更难察觉。
  const envText = read('.env');
  const raw = envValueOf(envText, 'PUBLIC_BASE_URL');
  const portRaw = envValueOf(envText, 'NGINX_HTTP_PORT');
  assert(raw && portRaw, '缺少 PUBLIC_BASE_URL 或 NGINX_HTTP_PORT');

  const httpPort = Number(portRaw);
  assert(Number.isInteger(httpPort) && httpPort > 0 && httpPort <= 65535, `NGINX_HTTP_PORT 非法：${portRaw}`);

  const url = new URL(raw);
  const basePort = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);

  assertEq(
    basePort,
    httpPort,
    'PUBLIC_BASE_URL 端口 / NGINX_HTTP_PORT',
  );
  return `均为 ${httpPort}`;
});

check('模板 .env.example 的 PUBLIC_BASE_URL 同样满足"无斜杠/无路径/端口一致"', () => {
  // 模板是 `gen-secret.mjs` 复制出来的那一份 —— 模板错了，新部署一上来就错。
  // 与 .env 用同一套判据（复用上面的规则，不各写一份）。
  const raw = envValueOf(envExample, 'PUBLIC_BASE_URL');
  const portRaw = envValueOf(envExample, 'NGINX_HTTP_PORT');
  assert(raw && portRaw, '.env.example 缺少 PUBLIC_BASE_URL 或 NGINX_HTTP_PORT');
  assert(!raw.endsWith('/'), `.env.example 的 PUBLIC_BASE_URL 末尾有斜杠："${raw}"`);

  const url = new URL(raw);
  assert(url.pathname === '/', `.env.example 的 PUBLIC_BASE_URL 带路径："${url.pathname}"`);
  const httpPort = Number(portRaw);
  const basePort = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  assertEq(basePort, httpPort, '.env.example：PUBLIC_BASE_URL 端口 / NGINX_HTTP_PORT');

  // 模板必须**明确写出**这条耦合规则（否则新机器上没人知道要同步改两处）
  assert(
    /PUBLIC_BASE_URL[\s\S]{0,400}?NGINX_HTTP_PORT|NGINX_HTTP_PORT[\s\S]{0,400}?PUBLIC_BASE_URL/.test(
      envExample,
    ),
    '.env.example 里没有把 PUBLIC_BASE_URL 与 NGINX_HTTP_PORT 的耦合关系写清楚（模板要教会使用者改一处要同步另一处）',
  );
  return `${raw} ↔ 端口 ${httpPort}`;
});

check('短链前缀与 Token 长度：constants.ts ↔ nginx 的 /t/ 段逐字一致', () => {
  // 这是 Phase 5 P5-0 引入的**第二个跨文件耦合**：
  //   · `TECHNICIAN_TOKEN.LINK_PATH`（短信链接前缀）
  //   · nginx 的短链 `location ~ ^/t/<...>{43}$`（短链路由 + token 形态）
  //   · nginx 三条 rewrite 里的 `{43}`（接口路径上的 token 形态）
  // 三者任一漂移，现象都是"链接点不开"或"接口 404"，而各自文件都"看起来对"。
  const tokenBlock = constantsBlock('TECHNICIAN_TOKEN');
  const linkPath = /LINK_PATH:\s*'([^']+)'/.exec(tokenBlock)?.[1];
  const length = Number(/LENGTH:\s*(\d+)/.exec(tokenBlock)?.[1]);
  assert(linkPath, 'TECHNICIAN_TOKEN.LINK_PATH 解析失败');
  assert(Number.isInteger(length) && length > 0, 'TECHNICIAN_TOKEN.LENGTH 解析失败');

  // LINK_PATH 形如 /t/ → 前缀（不含尾斜杠）应为 /t
  const prefix = linkPath.replace(/\/+$/, '');
  assert(prefix.startsWith('/'), `LINK_PATH 必须以 / 开头：${linkPath}`);

  // 取"短链 location"整块（从 `location ~ ^<prefix>/` 到下一个孤立的 `}` 行）。
  // 用整块再做包含式断言，而不是一次性写一个吞掉所有细节的大正则 ——
  // 后者在改动格式（换行/空格/注释）时会假红，且报错信息说不清到底缺什么。
  // `"?` 容忍正则被引号包裹（**必须**加引号，见下面那条独立断言）。
  const locStart = siteConf.search(
    new RegExp(`location\\s+~\\s+"?\\^${prefix.replace(/\//g, '\\/')}/`),
  );
  assert(
    locStart >= 0,
    `nginx 里找不到短链 location（期望形如 "location ~ ^${prefix}/<正则捕获>"）—— 短信链接会 404`,
  );
  const locEnd = siteConf.indexOf('\n    }', locStart);
  assert(locEnd > locStart, '短链 location 块解析失败（找不到收尾大括号）');
  const shortLinkBlock = siteConf.slice(locStart, locEnd);

  assert(
    shortLinkBlock.includes(`{${length}}`),
    `短链 location 里的 token 长度不是 {${length}}（应与 TECHNICIAN_TOKEN.LENGTH 一致）——` +
      `实际块：${shortLinkBlock.split('\n')[0]}`,
  );
  // 必须是 302/307，不能是 301（301 会被客户端长期缓存，H5 路径将来就改不动了）
  assert(
    /return\s+30[27]\s/.test(shortLinkBlock),
    '短链跳转必须使用 302/307 —— 301 会被浏览器长期缓存，将来 H5 路径改不动',
  );
  // 302 目标必须与 H5 侧真实路由前缀一致（否则短链跳到不存在的页面）
  const h5Prefix = /H5_PATH_PREFIX:\s*'([^']+)'/.exec(constantsBlock('TECHNICIAN_LINK'))?.[1];
  assert(h5Prefix, 'TECHNICIAN_LINK.H5_PATH_PREFIX 解析失败');
  assert(
    shortLinkBlock.includes(`return 302 ${h5Prefix}$`),
    `短链 302 目标与 TECHNICIAN_LINK.H5_PATH_PREFIX（"${h5Prefix}"）不一致`,
  );

  // `access_log off`：token 明文出现在请求行里，写访问日志等于把作业凭证落盘
  // （与"明文只活一次"的 Token 纪律冲突）。见 service.conf 该段注释。
  assert(
    /access_log\s+off\s*;/.test(shortLinkBlock),
    '短链 location 必须 access_log off（token 出现在 URI 里，写日志等于把凭证明文落盘）',
  );

  // ⚠️ 兜底 location 不能带 `^~`：带了会跳过正则匹配，导致**合法短链也 404**
  const fallback = /location\s+(\^~\s+)?\/t\/\s*\{/.exec(siteConf);
  assert(fallback, '缺少 /t/ 的兜底 location（畸形短链应直接 404，而不是落到 location / 被反代）');
  assert(
    !fallback[1],
    '兜底 location 不能写 `^~ /t/` —— `^~` 会让 nginx 跳过正则匹配，' +
      '于是 /t/{合法token} 也会落到这里回 404（合法短链反而打不开，且不报任何错）',
  );

  // 每条 rewrite 的**第一个**捕获组就是 token，长度必须都等于 TECHNICIAN_TOKEN.LENGTH。
  // ⚠️ 不能写 `[^\s"]*\{(\d+)\}` 取"最后一个 {n}" —— photos 那条尾部还有
  //    照片 ref 的 `{22}`，会被误当成 token 长度（实测报 [43,43,43,22]）。
  //    必须钉住"**紧跟 visits/ 的那个捕获组**"。
  const tokenLens = [
    ...siteConf.matchAll(/rewrite\s+"?\^\/api\/technician\/visits\/\(\[A-Za-z0-9_-\]\{(\d+)\}\)/g),
  ].map((m) => Number(m[1]));
  assertEq(tokenLens.length, 4, 'nginx 里 /api/technician/visits/ 的 rewrite 条数（get/files/submit/photos）');
  assert(
    tokenLens.every((n) => n === length),
    `rewrite 里的 token 长度 ${JSON.stringify(tokenLens)} 与 TECHNICIAN_TOKEN.LENGTH (${length}) 不一致`,
  );

  // photos 那条的**第二个**捕获组是照片 ref，长度必须等于 shared/photo-ref.ts 的
  // PHOTO_REF_LENGTH。两者不一致时**不重写**、请求原样到应用 → 404，
  // 与"照片不存在"同一个响应（不泄露信息），但师傅会看不到自己的照片 ——
  // 所以这条必须在静态层拦住。
  const photoRefSrc = read('nocobase/plugins/service-ticket/src/shared/photo-ref.ts');
  const refLen = Number(/PHOTO_REF_LENGTH\s*=\s*(\d+)/.exec(photoRefSrc)?.[1]);
  assert(Number.isInteger(refLen) && refLen > 0, 'PHOTO_REF_LENGTH 解析失败');
  const refLens = [
    ...siteConf.matchAll(
      /rewrite\s+"?\^\/api\/technician\/visits\/\(\[A-Za-z0-9_-\]\{\d+\}\)\/photos\/\(\[A-Za-z0-9_-\]\{(\d+)\}\)\$/g,
    ),
  ].map((m) => Number(m[1]));
  assertEq(refLens.length, 1, '受控读取照片的 rewrite 条数（应恰好 1 条）');
  assertEq(refLens[0], refLen, 'rewrite 里照片 ref 的长度 vs photo-ref.ts 的 PHOTO_REF_LENGTH');

  return `前缀 ${prefix}{${length}} → ${h5Prefix}（照片 ref {${refLen}}）`;
});

check('/api/technician/ 段必须显式 rewrite（裸 proxy_pass 会导致 404 + 误导性日志）', () => {
  // 这条守的是 Phase 5 开工时查出的真实缺陷：
  // 原先 `location ^~ /api/technician/` 只有裸 proxy_pass，而 NocoBase 的服务端形态是
  // `/api/<resource>:<action>` ⇒ `/api/technician/visits/xxx` 被当成 resourceName=technician
  // → "technician resource does not exist" → resourcerMiddleware 打一行日志后放行 → 404。
  // 「路由配了」与「路由没配」在响应上完全一样，所以只有静态断言能提前拦住。
  const m = /location\s+\^~\s+\/api\/technician\/\s*\{([\s\S]*?)\n\s{4}\}/.exec(siteConf);
  assert(m, '找不到 location ^~ /api/technician/ 段');
  const body = m[1];
  // ⚠️ **只数条数是不够的**：把 photos 那条误删、又手滑加了一条错的，
  //    条数照样对得上，断言全绿而路由已坏。因此这里断言**映射集合本身**
  //    （对外路径 → 内部 action）。集合比对不看顺序 —— 本项目铁律 2。
  const EXPECTED_ACTIONS = ['get', 'photo', 'submit', 'upload'];
  const actions = [...body.matchAll(/\/api\/technicianVisit:(\w+)\?token=\$1/g)]
    .map((x) => x[1])
    .sort();
  assertEq(
    actions.length,
    EXPECTED_ACTIONS.length,
    '/api/technician/ 段里的 rewrite 条数（每个 action 一条）',
  );
  // 集合比对用 JSON 串（`assertEq` 是严格 !==，数组永远不等 —— 这是
  // `assertEq` 的已知边界，别对数组用它）
  assert(
    JSON.stringify(actions) === JSON.stringify(EXPECTED_ACTIONS),
    `被 rewrite 的 action 集合（少一条 = 那条路由 404）：期望 ${JSON.stringify(EXPECTED_ACTIONS)}，实际 ${JSON.stringify(actions)}`,
  );
  // 每条 rewrite 的 pattern 都必须折 token 进 query，而不是留在路径上
  // （handler 用 `param('token')` 读取；留在路径上则 handler 取不到）
  assertEq(
    (body.match(/rewrite\s+"?\^\/api\/technician\/visits\//g) || []).length,
    EXPECTED_ACTIONS.length,
    'rewrite 行数',
  );
  return `${EXPECTED_ACTIONS.length} 条 rewrite（${EXPECTED_ACTIONS.join('/')}）`;
});

check('短链 302 段必须 absolute_redirect off（否则 Location 被改写成绝对地址）', () => {
  // 这条守的是 P5-0 联调时查出的真实缺陷（`nginx -t` 通过、静态看文件也正常）：
  // nginx 默认 `absolute_redirect on`，会把 `return 302 /h5/...` 的相对 Location
  // **改写为绝对地址**，主机名/端口取自**请求的 Host 头**。容器内实测得到
  // `Location: http://127.0.0.1/h5/technician/visit/...`（Host 是 127.0.0.1，端口 80 被省略）。
  // 后果：① 换域名/端口/上代理时跳转目标跟着变，与"外部契约稳定"相悖；
  //      ② 将来 TLS 在 nginx 终止时 80 段会生成 http:// 跳转（浏览器可能判降级）；
  //      ③ Location 由客户端可控的 Host 头决定 = 开放重定向面。
  // off 之后 Location 恒为相对路径 `/h5/technician/visit/{token}`，由浏览器按当前来源解析。
  // 在线判据见 scripts/verify-technician-routing.mjs 闸门 ①（它会如实变红）。
  const m = /location\s+~\s+"?\^\/t\/[\s\S]*?\{([\s\S]*?)\n\s{4}\}/.exec(siteConf);
  assert(m, '找不到短链正则 location 段');
  assert(
    /^\s*absolute_redirect\s+off\s*;/m.test(m[1]),
    '短链段缺少 `absolute_redirect off;` —— nginx 默认 on 会把 Location 改写成绝对地址',
  );
  return '绝对重定向已关闭，Location 保持相对路径';
});

check('nginx 里含 {n} 量词的正则必须加引号（否则配置直接解析失败）', () => {
  // 实测踩过：`location ~ ^/t/(?<name>[A-Za-z0-9_-]{43})$ {` 未加引号时，
  // nginx 的配置解析器把 `{43}` 里的 `{` 当成**块定界符**，
  // `nginx -t` 报 `pcre2_compile() failed: missing closing parenthesis`，
  // 而报错信息里显示的正则被**截断在 `{` 之前** —— 看起来像"正则写错了"，
  // 实际是"少了引号"。更麻烦的是：配置语法错误只在 reload/重启时暴露，
  // 静态看文件完全正常。
  //
  // 判据：`location ~` / `location ~*` / `rewrite` 后面的第一个 token
  // 若含 `{n}` 量词，必须以引号开头。
  const offenders = [];
  siteConf.split('\n').forEach((line, i) => {
    const m = /^\s*(?:location\s+~\*?\s+|rewrite\s+)(\S+)/.exec(line);
    if (!m) return;
    const pat = m[1];
    if (pat.startsWith('"') || pat.startsWith("'")) return;
    if (/\{\d+(,\d*)?\}/.test(pat)) offenders.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  assert(
    offenders.length === 0,
    `以下 nginx 正则含 {n} 量词但未加引号（nginx 会把 { 当块定界符 → nginx -t 失败）：\n         ${offenders.join('\n         ')}`,
  );
  return '全部已加引号';
});

check('nginx 的 client_max_body_size 必须大于应用宣称的单张照片上限（否则静默截断）', () => {
  // ---------------------------------------------------------------- DEV-76
  // 这是"**配置存在 ≠ 请求真的按预期穿透**"的又一个实例，与 P5-0 的
  // `absolute_redirect` 同源：两层各自都对，合起来是错的。
  //
  // 具体现象：应用层（`visit.photo_max_size_mb`，默认 5MB）会回一个带错误码的
  // JSON 413；而 nginx 的 `client_max_body_size` 若小于 5MB，请求**根本到不了
  // 应用层** —— 师傅收到的是 nginx 的 HTML 413，客户端解析不出错误码，
  // 用户看到"上传失败"却不知道要压到多少，只能反复重试同一张图。
  // 两层都"在工作"，只是内层永远收不到这种请求。
  //
  // 判据：nginx 的字节上限 **严格大于** 应用宣称的 MB 上限。
  //   相等也不行 —— multipart 有边界与头部开销，同样的"5MB 照片"
  //   编码后必然超过 5MB，等于把应用允许的照片卡在网关。
  //
  // ⚠️ 比较用的应用上限**从 constants.ts 的种子值读**，不在这里手写数字。
  //    手写会随种子漂移，红的理由与真实缺陷无关（假红灯）。
  //    另注：后台可以把 `visit.photo_max_size_mb` 调大，**调到 8MB 以上时
  //    必须同步调大 nginx** —— 这条静态闸门只能盯住种子的默认值。
  const m = /client_max_body_size\s+(\d+)\s*([kKmMgG])?/.exec(stripComments(mainConf));
  assert(
    m,
    `${NGINX_MAIN} 未设 client_max_body_size —— nginx 默认 1m，` +
      '比应用允许的任何照片都小，上传会在网关被静默截断',
  );
  const unit = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[String(m[2] ?? '').toLowerCase()] ?? 1;
  const nginxBytes = Number(m[1]) * unit;

  const appMb = Number(readDefaultSettingValueMap().get('visit.photo_max_size_mb'));
  assert(
    Number.isFinite(appMb) && appMb > 0,
    '读不到 visit.photo_max_size_mb 的种子值 —— 解析器与源码形态不匹配（比红灯更坏的假绿）',
  );
  const appBytes = appMb * 1024 * 1024;

  assert(
    nginxBytes > appBytes,
    `nginx client_max_body_size=${m[1]}${m[2] ?? ''}（${nginxBytes} 字节），` +
      `而应用宣称单张照片上限 ${appMb}MB（${appBytes} 字节）—— ` +
      '网关比应用更严，应用层的 413 JSON 信封永远不会被发出，' +
      '客户端只能拿到 nginx 的 HTML 错误页（没有错误码）',
  );
  return `nginx ${(nginxBytes / 1048576).toFixed(1)}MB > 应用 ${appMb}MB`;
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
  // 后台敏感列清单（单一事实来源）+ 后台页面播种脚本。
  // 与 verify-concurrency-phase2.mjs 同理：这两个文件**被删掉**之后，
  // 后台页面会静默消失、而所有 /api 断言照常全绿。存在性本身必须被断言。
  ['scripts/expected-sensitive-columns.mjs', 'file'],
  ['scripts/seed-admin-pages.mjs', 'file'],
  // H3 时效文案 / H6 按钮矩阵的唯一自动验证手段。它跑在浏览器里，
  // 除了这个脚本没有任何断言能覆盖它 —— 被删掉就等于退回"只能靠肉眼发现"。
  ['scripts/verify-client-logic.mjs', 'file'],
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
  // Phase 4 独立阶段报告：H 的降级交付记录与 I 的走查脚本都在里面。
  // 与 Phase 2 / Phase 3 同理 —— "写过又被删掉"会让该阶段结论失去可追溯出处。
  ['docs/PHASE-4.md', 'file'],
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
