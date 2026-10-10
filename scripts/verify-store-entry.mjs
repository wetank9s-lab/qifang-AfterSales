#!/usr/bin/env node
/**
 * verify-store-entry.mjs —— P11-1「15 家门店独立报修入口」验收门禁
 * =============================================================================
 *
 * 覆盖用户 2026-10-10 下达的第 1~10 条要求中可自动化的部分：
 *   req 1  15 家门店各有稳定、唯一的链接与二维码；后台授权人员能复制/下载
 *   req 2  入口经**服务端验证**（HMAC 签名），不靠可改写的 `store=` / body / 隐藏字段
 *   req 3  客户进入即看到正确门店名（页面侧由 H5 页断言，见下）
 *   req 4  提交时服务端重新校验入口与门店启用状态；伪造 body 的 store_code/store_id 被拒或忽略
 *   req 5  保留旧 `?store=S01` 兼容入口，但**如实标注**无签名保护（provenance=legacy）
 *   req 6  停用门店不得创建新单；既有工单/审计不受影响
 *   req 7  链接/二维码用实际对外地址，不含容器内部端口或后台地址
 *   req 8  **用真实浏览器逐一解码** 15 张二维码，核对链接唯一、门店名准确
 *   req 9  直接调 API / 篡改 body / 篡改入口 / 失效链接 / 停用门店 / 旧码兼容 / S01·S02 隔离
 *   req 10 跨店转移在服务端一律不可用（本脚本只做**存在性**复核，
 *          完整矩阵在 `verify-reassign-contract.mjs` / 转单撤销的专项门禁里）
 *
 * ===========================================================================
 * 判据纪律（本项目反复吃亏的三条，这里逐条对应）
 * ===========================================================================
 * ① **断言必须会变红**：所有纯函数判据都跑 `--selftest`，
 *    并且用**变异测试**证明 fixture 有牙齿（把源码改坏 ⇒ fixture 必须红）。
 *    没有这一层的"我写了断言"只是打印。
 *
 * ② **判据要落到精确字段**，不用宽泛的字符串包含：
 *    · 不判 "url 里有没有 'localhost'"（本地开发入口**就是** localhost，
 *      那样判会在本机自造假红）；判 `url` 的 origin **逐字等于**
 *      `PUBLIC_H5_BASE_URL || PUBLIC_BASE_URL` 的 origin，并**另外**断言
 *      它不含容器内部端口（13000）与后台路径（/admin）。
 *
 * ③ **二维码必须真的被解出来**（req 8），不是在 Node 里把 `url` 和
 *    "我以为编进去的字符串"比一遍 —— 那种做法在二维码生成器坏掉时**照样全绿**。
 *    这里用**真实 Chromium** 把 SVG 渲染成像素，再用 jsQR（独立实现）解码回文本，
 *    逐张与 API 返回的 `url` 比对。
 *
 * 用法：
 *   node scripts/verify-store-entry.mjs              # 完整验收
 *   node scripts/verify-store-entry.mjs --selftest   # 只跑纯函数 fixture + 变异测试
 * 退出码：0 全部通过 / 1 有未达标项 / 2 环境未就绪或**验收器自身**异常
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { SVC_BASE_URL, SVC_SCHEME, SVC_BASE_URL_PORT, SVC_TLS_INSECURE } from './lib/base-url.mjs';
import {
  EnvNotReady,
  cleanupTicket,
  errorCodeOf,
  errorMessageOf,
  http,
  psqlExec,
  psqlRows,
  psqlScalar,
  runMain,
  signIn,
  envValue,
} from './technician-harness.mjs';
import { storeEntryToken, storeEntryQuery } from './lib/store-entry-token.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, '.tmp-verify');
const SERVICE_CONF = path.join(ROOT, 'nginx', 'conf.d', 'service.conf');
const NODE_WORKSPACE = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.workbuddy',
  'binaries',
  'node',
  'workspace',
);
const SELFTEST_ONLY = process.argv.includes('--selftest');
const NO_BURST_OVERRIDE = process.argv.includes('--no-burst-override');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '0';

const BASE = SVC_BASE_URL;
const ADMIN_EMAIL = envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com');
const ADMIN_PASSWORD = envValue('SMOKE_ADMIN_PASSWORD', '');
const STORE_A_EMAIL = 'uat.store.a@svc.local';
const STORE_B_EMAIL = 'uat.store.b@svc.local';

// ---------------------------------------------------------------------------
// 验收期临时放宽 nginx 的**匿名区突发额度**（跑完/异常退出都会还原）
// ---------------------------------------------------------------------------
/**
 * 为什么必须动它（沿用 `verify-review-loop.mjs` 的既有结论）：
 *   本门禁在几十秒内要从**同一个 IP**（本机 127.0.0.1）发出几十个
 *   `/api/public/*` 请求，而 nginx 给匿名区配的是 `rate=30r/m burst=10`
 *   （见 nginx/nginx.conf）。生产里每个客户有各自的公网 IP、天然不共享桶 ——
 *   门禁的流量形态**本就不该**走对客突发额度。
 *
 * ⚠️ 首跑实录（2026-10-10）：§3 起整段变成 `429 TOO_MANY_REQUESTS`，
 *    屏幕读法是"篡改入口没被拒绝""停用门店没被拦住"——**十四条假红灯**，
 *    而产品其实一条都没错。这正是"环境未就绪被误读成产品坏了"的经典形态。
 *
 * ⚠️ 做法：**临时改 + 跑完还原**。绝不放宽 `rate=30r/m`（那是对客承诺），
 *    只放宽 burst（突发容量）。`--no-burst-override` 可关闭，用于观察真实限流下的行为。
 *
 * ⚠️ 这里**只放行 nginx 那一层**：应用层还有自己的 `security.ip_minute_limit`
 *    计数器（30/分钟，落在 `api_guards` 表里，与 nginx 是**两道独立**的闸）。
 *    本门禁的匿名请求总数在 20 上下，正常情况下不会碰它；真碰到了会以
 *    `RATE_LIMITED` 出现 —— 那种情况按"环境未就绪"报（见下面的 note429）。
 */
const GATE_BURST = '2000';
const ORIGINAL_CONF = fs.existsSync(SERVICE_CONF) ? fs.readFileSync(SERVICE_CONF, 'utf8') : null;

function dockerCompose(args) {
  return execFileSync('docker', ['compose', ...args], { cwd: ROOT, encoding: 'utf8' });
}

let burstRaised = false;
function raisePublicBurst() {
  if (NO_BURST_OVERRIDE || !ORIGINAL_CONF) return;
  const patched = ORIGINAL_CONF.replace(/(limit_req zone=svc_public burst=)\d+/, `$1${GATE_BURST}`);
  if (patched === ORIGINAL_CONF) return;
  try {
    fs.writeFileSync(SERVICE_CONF, patched);
    dockerCompose(['exec', '-T', 'nginx', 'nginx', '-s', 'reload']);
    burstRaised = true;
    console.log(`  · 验收期临时把 /api/public/ 的 burst 调到 ${GATE_BURST}（跑完自动还原）`);
  } catch (e) {
    console.log(`  · burst 临时调大失败（继续跑，可能会看到 429）：${e.message}`);
    restorePublicBurst();
  }
}
function restorePublicBurst() {
  if (!ORIGINAL_CONF) return;
  try {
    if (fs.readFileSync(SERVICE_CONF, 'utf8') !== ORIGINAL_CONF) {
      fs.writeFileSync(SERVICE_CONF, ORIGINAL_CONF);
      dockerCompose(['exec', '-T', 'nginx', 'nginx', '-s', 'reload']);
      console.log('  · 已还原 nginx burst 与限流配置');
    }
  } catch (e) {
    console.error(`  ⚠️ 还原 nginx 配置失败，请手工检查 nginx/conf.d/service.conf：${e.message}`);
  }
}
process.on('exit', restorePublicBurst);
process.on('SIGINT', () => {
  restorePublicBurst();
  process.exit(2);
});

/**
 * 遇到限流就把本轮标记成"环境未就绪"。
 *
 * 为什么要**单独**拎出来（项目里已经吃过两次）：
 *   被限流时所有断言都会拿到 429，于是每一条都变红 —— 看起来像"产品全线崩溃"。
 *   真实情况是"刚才那支脚本把这分钟的额度用完了"。
 *   ⇒ 按既有约定：环境未就绪 **exit 2**，与真红灯（exit 1）分开报。
 */
let sawRateLimit = false;
function note429(status, body) {
  const text = String(body ?? '');
  if (status === 429 || text.includes('TOO_MANY_REQUESTS') || text.includes('RATE_LIMITED')) {
    sawRateLimit = true;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 结果收集
// ---------------------------------------------------------------------------
const state = { passed: 0, failures: [] };
function ok(name, detail = '') {
  state.passed += 1;
  console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`);
}
function no(name, detail = '') {
  state.failures.push({ name, detail });
  console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function section(no_, title) {
  console.log(`\n── ${no_} ${title} ${'─'.repeat(Math.max(4, 66 - title.length))}`);
}

// ---------------------------------------------------------------------------
// esbuild 加载**产品的真实实现**（判据不抄第二份）
// ---------------------------------------------------------------------------
function loadRealModule(relPath, exportNames) {
  const req = createRequire(import.meta.url);
  let esbuild = null;
  for (const load of [
    () => req('esbuild'),
    () => req(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild')),
    () => req(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild', 'lib', 'main.js')),
  ]) {
    try {
      esbuild = load();
      break;
    } catch {
      /* 试下一个 */
    }
  }
  if (!esbuild) throw new EnvNotReady('找不到 esbuild —— 无法加载产品实现（环境未就绪）');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tag = relPath.replace(/[^a-zA-Z0-9]/g, '_');
  const entry = path.join(OUT_DIR, `${tag}.entry.ts`);
  const outfile = path.join(OUT_DIR, `${tag}.cjs`);
  const abs = path.join(ROOT, 'nocobase', 'plugins', 'service-ticket', 'src', 'server', relPath).replace(/\\/g, '/');
  fs.writeFileSync(entry, `export { ${exportNames.join(', ')} } from '${abs}';\n`, 'utf8');
  esbuild.buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    logLevel: 'warning',
  });
  return req(outfile);
}

const entryMod = () => loadRealModule('services/store-entry.ts', ['signStoreEntry', 'verifyStoreEntry', 'resolveStoreEntry', 'STORE_ENTRY_PROVENANCE']);
const urlMod = () => loadRealModule('services/public-url.ts', ['publicBaseUrlOf', 'isNonPublicBase']);

// ===========================================================================
// §0 --selftest：纯函数 fixture + **变异测试**
// ===========================================================================
/**
 * 为什么 fixture 必须配变异测试（项目铁律 1 + 5）：
 *   fixture 全绿只说明"当前实现对得上我写的期望"。
 *   若我的期望本身是错的（比如把"坏签名回落 legacy"当成了正确行为），
 *   fixture 也会全绿 —— 而它保护的东西恰恰是错的。
 *   ⇒ 必须证明"把实现改坏 ⇒ fixture 变红"。
 *     每一处变异都对应一条**真实可能犯的错**，不是随便挑一行删掉。
 */
const FIXTURE_SECRET = 'fixture-secret-0123456789';

function entryFixture(mod) {
  const { signStoreEntry, verifyStoreEntry, resolveStoreEntry, STORE_ENTRY_PROVENANCE } = mod;
  const cases = [];

  const goodS01 = signStoreEntry('S01', FIXTURE_SECRET);
  const goodS02 = signStoreEntry('S02', FIXTURE_SECRET);

  // ---- 接受：合法签名入口 ----
  cases.push({
    name: 'accept · 合法签名入口解析为 signed',
    want: 'ok',
    run: () => {
      const r = resolveStoreEntry(goodS01, FIXTURE_SECRET);
      return r.ok && r.code === 'S01' && r.provenance === STORE_ENTRY_PROVENANCE.SIGNED;
    },
  });
  // ---- 接受：旧二维码形态（裸编码）----
  cases.push({
    name: 'accept · 旧入口（裸门店编码）解析为 legacy',
    want: 'ok',
    run: () => {
      const r = resolveStoreEntry('S01', FIXTURE_SECRET);
      return r.ok && r.code === 'S01' && r.provenance === STORE_ENTRY_PROVENANCE.LEGACY;
    },
  });
  // ---- 拒绝：门店编码被改写（req 2 的核心）----
  cases.push({
    name: 'reject · 门店编码被改写（S01 的签名挂到 S02）',
    want: 'ok',
    run: () => {
      const forged = `S02.${goodS01.split('.')[1]}`;
      const r = resolveStoreEntry(forged, FIXTURE_SECRET);
      return !r.ok && r.error === 'INVALID_STORE_ENTRY' && verifyStoreEntry(forged, FIXTURE_SECRET) === null;
    },
  });
  // ---- 拒绝：坏签名**不得回落** legacy（回落 = 签名形同虚设）----
  cases.push({
    name: 'reject · 坏签名不得回落成 legacy',
    want: 'ok',
    run: () => {
      const r = resolveStoreEntry('S01.AAAAAAAAAAAAAAAAAAAAAA', FIXTURE_SECRET);
      return !r.ok && r.error === 'INVALID_STORE_ENTRY';
    },
  });
  // ---- 拒绝：空值 ----
  cases.push({
    name: 'reject · 空入口 → MISSING_STORE_ENTRY',
    want: 'ok',
    run: () => {
      const a = resolveStoreEntry('', FIXTURE_SECRET);
      const b = resolveStoreEntry(undefined, FIXTURE_SECRET);
      const c = resolveStoreEntry('   ', FIXTURE_SECRET);
      return (
        !a.ok && a.error === 'MISSING_STORE_ENTRY' &&
        !b.ok && b.error === 'MISSING_STORE_ENTRY' &&
        !c.ok && c.error === 'MISSING_STORE_ENTRY'
      );
    },
  });
  // ---- 拒绝：畸形形态（分隔符在首/尾、非法字符、超长、签名长度差一位）----
  cases.push({
    name: 'reject · 畸形入口（.开头 / .结尾 / 路径穿越 / 非法字符 / 超长编码 / 签名长度差一位）',
    want: 'ok',
    run: () => {
      const bad = [
        '.abc',
        'S01.',
        'S01...',
        '../etc/passwd',
        'S01/../../x',
        'x'.repeat(64),
        'S 01',
        'S0 1',
        // 签名长度**必须**恰好 22：短一位 / 长一位都不能放过
        'S01.AAAAAAAAAAAAAAAAAAAAA',
        'S01.AAAAAAAAAAAAAAAAAAAAAAA',
      ];
      return bad.every((v) => {
        const r = resolveStoreEntry(v, FIXTURE_SECRET);
        return !r.ok;
      });
    },
  });
  // ---- 归一化：前后空白被 trim 后再判定（**刻意行为**，不是漏网）----
  //
  // ⚠️ 本用例的来源是一次**验收器自己的错误**，值得留在这里：
  //    第一版 fixture 把 `'S01\n'` 列进了"必须拒绝"，结果它被接受 ⇒ fixture 报红。
  //    核查后确认**是期望写错了**：`resolveStoreEntry` 第一行就是 `String(raw).trim()`，
  //    这是刻意的归一化（URL 参数常带杂空白，`?k=S01%0A` 与 `?k=S01` 应当同义），
  //    而且它不构成任何安全缺口 —— trim 之后仍必须命中合法编码或合法签名。
  //    ⇒ 把它从"拒绝"改成"接受并归一化"，把行为**写进断言**，
  //      而不是悄悄删掉用例（删掉就等于这个行为再也没人看着）。
  cases.push({
    name: 'normalize · 前后空白被 trim 后按同一形态解析（S01\\n / " S01 " → legacy S01）',
    want: 'ok',
    run: () => {
      const r1 = resolveStoreEntry('S01\n', FIXTURE_SECRET);
      const r2 = resolveStoreEntry('  S01  ', FIXTURE_SECRET);
      return (
        r1.ok && r1.code === 'S01' && r1.provenance === STORE_ENTRY_PROVENANCE.LEGACY &&
        r2.ok && r2.code === 'S01' && r2.provenance === STORE_ENTRY_PROVENANCE.LEGACY
      );
    },
  });
  // ---- 拒绝：密钥缺失时不得验过任何签名（fail-closed）----
  //
  // ⚠️ 这里必须用**空密钥签出来的**入口，而不是"拿别的密钥签的入口"。
  //    第一版写成 `resolveStoreEntry(goodS01, '')`（goodS01 是用真密钥签的）——
  //    那个用例在守卫被删掉之后**依然是红的**（签名本来就不匹配），
  //    于是变异测试如实报告"M1 没有变红"。看起来像 fixture 没牙齿，
  //    实际是**这条用例根本没在测那个守卫**。
  //    真正要防的场景是：攻击者自己用空密钥签一个 S02 的入口。
  //    只有"空密钥签的入口必须被拒"这一条，才能把那条守卫钉住。
  cases.push({
    name: 'reject · 空密钥签出来的入口必须被拒绝（fail-closed，防止人人可伪造入口）',
    want: 'ok',
    run: () => {
      // 空密钥**能签出串**（signStoreEntry 只校验编码形态）——这正是危险所在
      const emptySigned = signStoreEntry('S01', '');
      const r = resolveStoreEntry(emptySigned, '');
      // 顺带钉住"拿真密钥签的入口在空密钥下也验不过"（同一道门的两侧）
      const r2 = resolveStoreEntry(goodS01, '');
      return !r.ok && r.error === 'INVALID_STORE_ENTRY' && !r2.ok && r2.error === 'INVALID_STORE_ENTRY';
    },
  });
  // ---- 稳定性：同门店同密钥 → 恒定（已印出的二维码不能因重启失效）----
  cases.push({
    name: 'stable · 同门店同密钥签名恒定；不同门店签名不同；换密钥签名随之改变',
    want: 'ok',
    run: () => {
      const a = signStoreEntry('S01', FIXTURE_SECRET);
      const b = signStoreEntry('S01', FIXTURE_SECRET);
      const c = signStoreEntry('S02', FIXTURE_SECRET);
      const d = signStoreEntry('S01', FIXTURE_SECRET + 'x');
      return a === goodS01 && a === b && a !== c && a !== d;
    },
  });
  // ---- 签名长度与字符集（与 `?k=` 的 URL 形态、与文档口径一致）----
  cases.push({
    name: 'shape · 入口形如 <code>.<22 位 base64url>',
    want: 'ok',
    run: () => /^S01\.[A-Za-z0-9_-]{22}$/.test(goodS01) && /^S02\.[A-Za-z0-9_-]{22}$/.test(goodS02),
  });

  return cases;
}

function urlFixture(mod) {
  const { publicBaseUrlOf, isNonPublicBase } = mod;
  const cases = [
    {
      name: 'base · 只配 PUBLIC_BASE_URL → 用它',
      want: 'ok',
      run: () => publicBaseUrlOf({ PUBLIC_BASE_URL: 'https://svc.example.com' }) === 'https://svc.example.com',
    },
    {
      name: 'base · PUBLIC_H5_BASE_URL 优先于 PUBLIC_BASE_URL',
      want: 'ok',
      run: () =>
        publicBaseUrlOf({
          PUBLIC_H5_BASE_URL: 'https://h5.example.com',
          PUBLIC_BASE_URL: 'https://api.example.com',
        }) === 'https://h5.example.com',
    },
    {
      name: 'base · 尾部斜杠被去掉（否则拼出 //h5/report）',
      want: 'ok',
      run: () => publicBaseUrlOf({ PUBLIC_BASE_URL: 'https://svc.example.com///' }) === 'https://svc.example.com',
    },
    {
      name: 'base · 都没配 → 返回空串（调用方必须按"拼不出链接"处理）',
      want: 'ok',
      run: () => publicBaseUrlOf({}) === '',
    },
    {
      name: 'nonpublic · localhost / 环回 / 私网 / 非标准端口 一律判"不适合印出去"',
      want: 'ok',
      run: () => {
        const bad = [
          'http://localhost:8080',
          'http://127.0.0.1',
          'http://10.0.0.5',
          'http://192.168.1.10',
          'http://172.16.3.4',
          'http://svc.example.com:13000',
          'http://svc.example.com:8080',
          '',
          'not-a-url',
        ];
        return bad.every((u) => isNonPublicBase(u) === true);
      },
    },
    {
      name: 'nonpublic · 正常对外域名（https / 默认端口 / 80 / 443）判为可用',
      want: 'ok',
      run: () =>
        ['https://svc.example.com', 'https://svc.example.com:443', 'http://svc.example.com:80'].every(
          (u) => isNonPublicBase(u) === false,
        ),
    },
  ];
  return cases;
}

/** 每种变异：`{ id, file, from, to, why }` —— 改坏它，对应 fixture 必须变红 */
const MUTATIONS = [
  {
    id: 'M1',
    file: 'services/store-entry.ts',
    from: 'if (!secret) return null; // 密钥缺失 ⇒ 无法验证 ⇒ fail-closed（不放行任何签名）',
    // ⚠️ 变异必须**真的改变行为**。第一版写成 `... return null; void 0; // MUTATED` ——
    //    那是个**空操作**（守卫还在），变异测试因此报"M1 没有变红"。
    //    假红/假绿的来源不只是产品代码，验收器自己写的变异同样会错 ——
    //    这一行就是那条纪律的现场证据：变异测试必须先自证"变异真的生效"。
    to: '// MUTATED: 空密钥守卫被整条删除（fail-closed 失效）',
    why: '删掉"空密钥不放行"⇒ "空密钥签出来的入口必须被拒绝"那条 fixture 必须红',
  },
  {
    id: 'M2',
    file: 'services/store-entry.ts',
    from: "      : { ok: false, error: 'INVALID_STORE_ENTRY' };",
    to: "      : { ok: true, code: text.slice(0, text.indexOf(SEPARATOR)), provenance: STORE_ENTRY_PROVENANCE.LEGACY };",
    why: '让坏签名回落成 legacy ⇒ "不得回落"那条 fixture 必须红',
  },
  {
    id: 'M3',
    file: 'services/store-entry.ts',
    from: '.update(`store-entry:${code}`)',
    to: ".update('store-entry:')",
    why: '签名不再绑定门店编码 ⇒ "改门店编码必须拒绝"与"不同门店签名不同"必须红',
  },
  {
    id: 'M4',
    file: 'services/public-url.ts',
    from: 'return normalize(env.PUBLIC_H5_BASE_URL) || normalize(env.PUBLIC_BASE_URL);',
    to: 'return normalize(env.PUBLIC_BASE_URL) || normalize(env.PUBLIC_H5_BASE_URL);',
    why: '两个基址的优先级被调换 ⇒ "PUBLIC_H5_BASE_URL 优先"那条 fixture 必须红',
  },
  {
    id: 'M5',
    file: 'services/public-url.ts',
    from: "if (port && port !== '80' && port !== '443') return true;",
    to: 'return false; // MUTATED: 端口判定被移除',
    why: '不再拒绝内部端口 ⇒ "非标准端口判为不可用"那条 fixture 必须红',
  },
];

/**
 * 跑一组 fixture；`label` 用于输出。返回失败的用例名数组。
 * ⚠️ 用例**捕获异常也算失败**（抛错不是"通过"）——否则实现坏成崩溃时会假绿。
 */
function runFixture(cases, label) {
  const failed = [];
  for (const c of cases) {
    let pass;
    try {
      pass = c.run() === true;
    } catch (error) {
      pass = false;
      c.error = String(error?.message ?? error);
    }
    if (!pass) failed.push(c.name);
  }
  if (label) {
    console.log(`  [${label}] ${cases.length - failed.length}/${cases.length} 通过`);
    for (const f of failed) console.log(`      ✗ ${f}`);
  }
  return failed;
}

function runSelftest() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  P11-1 门店入口 fixture（正向：期望全绿）');
  console.log('══════════════════════════════════════════════════════════════');

  const eMod = entryMod();
  const uMod = urlMod();
  const entryCases = entryFixture(eMod);
  const urlCases = urlFixture(uMod);
  const f1 = runFixture(entryCases, 'store-entry');
  const f2 = runFixture(urlCases, 'public-url');

  if (f1.length || f2.length) {
    console.log('\n  ❌ fixture 红 —— 产品实现与期望不符（这不是变异，是**真红灯**）');
    return 1;
  }
  console.log('\n  正向 fixture 全绿。');

  // ---- 变异测试：证明 fixture 有牙齿 ----
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  变异测试（把实现改坏 ⇒ 对应 fixture 必须变红）');
  console.log('══════════════════════════════════════════════════════════════');
  let mutationFaults = 0;
  const mutDir = path.join(OUT_DIR, 'mutations');
  fs.rmSync(mutDir, { recursive: true, force: true });
  fs.mkdirSync(mutDir, { recursive: true });

  for (const m of MUTATIONS) {
    const srcPath = path.join(ROOT, 'nocobase', 'plugins', 'service-ticket', 'src', 'server', m.file);
    const original = fs.readFileSync(srcPath, 'utf8');
    // ⚠️ 本仓库文件是 **CRLF**：`\n` 拼的多行锚点永远匹配不上（项目已知坑）。
    //    这里逐条锚点统一做行尾对齐后再比对，避免"以为改了其实没改"
    //    —— 那种情况下变异测试会报"fixture 依然全绿"，看起来像 fixture 没牙齿，
    //    实际是变异根本没生效（**验收器自己造出来的假红**）。
    const norm = (s) => s.replace(/\r\n/g, '\n');
    const hasFrom = norm(original).includes(norm(m.from));
    const hasTo = norm(original).includes(norm(m.to));
    if (hasTo && hasTo !== hasFrom) {
      console.log(`  ⏸ ${m.id} 跳过：源码里已经是被变异后的内容（上次变异未还原？）`);
      continue;
    }
    if (!hasFrom) {
      console.log(
        `  ✗ ${m.id} 锚点未命中（${m.file}）—— **变异没有生效**，本轮不能据此宣布 fixture 有效。\n` +
          `      锚点：${JSON.stringify(m.from.slice(0, 90))}\n` +
          `      这属于验收器自身缺陷：请先修锚点再重跑。`,
      );
      mutationFaults += 1;
      continue;
    }
    const mutated = norm(original).replace(norm(m.from), norm(m.to));
    const tmpFile = path.join(mutDir, `${m.id}-${m.file.replace(/[^a-zA-Z0-9]/g, '_')}`);
    fs.writeFileSync(tmpFile, mutated, 'utf8');

    // 编译这份**变异后的**源码，跑同一组 fixture
    const mod = compileFrom(mutDir, m.id, tmpFile, m.file);    const cases = m.file.includes('public-url') ? urlFixture(mod) : entryFixture(mod);
    const failed = runFixture(cases, null);

    if (failed.length === 0) {
      console.log(`  ✗ ${m.id} fixture **没有变红** —— 说明这些断言抓不住这类错误（${m.why}）`);
      mutationFaults += 1;
    } else {
      console.log(`  ✓ ${m.id} fixture 如期变红（${failed.length} 条）—— ${m.why}`);
    }
  }

  if (mutationFaults) {
    console.log(`\n  ❌ ${mutationFaults} 处变异测试未达标 —— fixture 的牙齿不齐，不能据此宣布通过`);
    return 1;
  }
  console.log('\n  ✅ fixture + 变异测试全部达标。');
  return 0;
}

/**
 * 把「已经变异过的源码文件」编译成 CJS 并 require（用于变异测试）。
 *
 * @param dir          变异产物的暂存目录
 * @param tag          变异编号（M1…），用于产物命名
 * @param mutatedFile  **变异后的那份源码**的绝对路径（由调用方写出来，不在这里重算 ——
 *                     重算过一次、算错了命名，报的是 ENOENT 而不是"fixture 没牙齿"，
 *                     与本文件反复强调的"验收器自己造出来的故障"同型）
 * @param which        原始相对路径（如 `services/store-entry.ts`），用于定位同目录兄弟文件
 */
function compileFrom(dir, tag, mutatedFile, which) {
  const req = createRequire(import.meta.url);
  const esbuild = (() => {
    for (const load of [
      () => req('esbuild'),
      () => req(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild')),
      () => req(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild', 'lib', 'main.js')),
    ]) {
      try {
        return load();
      } catch {
        /* 下一个 */
      }
    }
    throw new EnvNotReady('找不到 esbuild —— 无法编译变异源码');
  })();

  // 变异文件是原始 TS 的副本 ⇒ 需要它自己的相对依赖（`node:crypto` 等）仍能解析。
  // 做法：把副本放到**与原文件同目录**下（临时名 `.tomut-*`），编完立刻删除 ——
  // 这样解析路径与原文件完全一致，不会因挪目录而炸；
  // 用 `.tomut-` 前缀 + `finally` 删除，避免残留文件被下一次构建当成源码收进去。
  const srcDir = path.dirname(path.join(ROOT, 'nocobase', 'plugins', 'service-ticket', 'src', 'server', which));
  const sibling = path.join(srcDir, `.tomut-${tag}-${path.basename(which)}`);
  fs.copyFileSync(mutatedFile, sibling);
  const entry = path.join(dir, `${tag}.entry.ts`);
  const outfile = path.join(dir, `${tag}.cjs`);
  fs.writeFileSync(entry, `export * from '${sibling.replace(/\\/g, '/')}';\n`, 'utf8');
  try {
    esbuild.buildSync({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: ['node20'],
      logLevel: 'silent',
    });
  } finally {
    fs.rmSync(sibling, { force: true });
  }
  return req(outfile);
}

// ===========================================================================
// §1 后台接口：链接 + 二维码（req 1 / req 7）
// ===========================================================================
let ADMIN_TOKEN = null;

async function adminGet(pathname) {
  return http(`${BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
}

/**
 * 打**匿名**接口，并把限流当成"环境未就绪"抛出去。
 *
 * ⚠️ 这一层是必需的、不是保险：不加它，被限流时 §3~§5 的每一条断言都会拿到 429
 *    并各自变红 —— 屏幕上出现的是"篡改入口没被拒绝""停用门店没被拦住"，
 *    而这两件事其实都做得对。**假红灯比假绿更消耗信任**：它让人去改本来正确的代码。
 */
async function pub(url, opts) {
  const r = await http(url, opts);
  if (note429(r.status, r.body)) {
    throw new EnvNotReady(
      `匿名接口被限流（HTTP ${r.status} ${String(r.body).slice(0, 80)}）—— ` +
        '本分钟的匿名额度已被用掉。这不是产品结论：请等一分钟后重跑本项，' +
        '或先跑完其它门禁再单独跑它（见 GATE_BURST 的注释）。',
    );
  }
  return r;
}

const EXPECTED_ITEM_KEYS = [
  'active',
  'code',
  'entry',
  'legacy_url',
  'name',
  'qr_filename',
  'qr_svg',
  'url',
];

async function main() {
  if (!ADMIN_PASSWORD) {
    throw new EnvNotReady('.env 缺 SMOKE_ADMIN_PASSWORD —— 无法登录管理员（本仓库为公开仓库，口令不入库）');
  }
  // 匿名区的突发额度必须先放宽，否则 §3 起会整段变成 429 假红灯（见 GATE_BURST 的注释）
  raisePublicBurst();

  ADMIN_TOKEN = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!ADMIN_TOKEN) throw new EnvNotReady(`管理员 ${ADMIN_EMAIL} 登录失败（口令可能已轮换）`);

  const dbStores = psqlRows('SELECT code, name, active FROM stores ORDER BY code').map((r) => ({
    code: r[0],
    name: r[1],
    active: r[2] === 't',
  }));

  // -------------------------------------------------------------- 匿名可达性
  section('1.1', '鉴权：未登录不得取门店入口（req 1「授权人员」）');
  {
    const r = await http(`${BASE}/api/svc/store-entry`);
    if (r.status === 401 || r.status === 403) ok(`未登录访问 /api/svc/store-entry → ${r.status}`);
    else no('未登录访问 /api/svc/store-entry 未被拒绝', `HTTP ${r.status} ${String(r.body).slice(0, 140)}`);
  }

  // ---------------------------------------------------- 管理员取全量链接与二维码
  section('1.2', '管理员取回全部门店入口（req 1）');
  const listed = await adminGet('/api/svc/store-entry');
  if (listed.status !== 200) {
    no('GET /api/svc/store-entry 未成功', `HTTP ${listed.status} ${String(listed.body).slice(0, 200)}`);
    return;
  }
  const payload = listed.json?.data ?? {};
  const items = Array.isArray(payload.items) ? payload.items : [];

  if (items.length === dbStores.length && items.length > 0) {
    ok(`入口条数与库中门店数一致（${items.length} 家）`);
  } else {
    no('入口条数与库中门店数不一致', `接口 ${items.length} / 库 ${dbStores.length}`);
  }
  if (items.length === 15) ok('恰好 15 家门店各有入口（req 1 的字面要求）');
  else no(`门店入口不是 15 家（${items.length}）`, 'req 1 明文要求 15 家');

  // ---- 逐条字段与形状 ----
  const shapeProblems = [];
  for (const item of items) {
    const keys = Object.keys(item).sort();
    if (JSON.stringify(keys) !== JSON.stringify(EXPECTED_ITEM_KEYS)) {
      shapeProblems.push(`${item.code}: 字段集为 ${keys.join(',')}`);
      continue;
    }
    if (!new RegExp(`^${item.code}\\.[A-Za-z0-9_-]{22}$`).test(item.entry)) {
      shapeProblems.push(`${item.code}: entry 形态不符（${item.entry}）`);
    }
    if (!String(item.qr_svg).startsWith('<svg')) shapeProblems.push(`${item.code}: qr_svg 不是 SVG`);
    if (item.qr_filename !== `${item.code}-report-qr.svg`) {
      shapeProblems.push(`${item.code}: qr_filename=${item.qr_filename}`);
    }
    const db = dbStores.find((s) => s.code === item.code);
    if (!db) shapeProblems.push(`${item.code}: 库中没有这家门店`);
    else if (db.name !== item.name) shapeProblems.push(`${item.code}: 名称与库不一致（${item.name} ≠ ${db.name}）`);
    if (db && db.active !== item.active) shapeProblems.push(`${item.code}: active 与库不一致`);
  }
  if (shapeProblems.length === 0) ok(`每条入口的字段集 / entry 形态 / SVG / 文件名 / 名称 与库一致（${items.length} 条）`);
  else no('入口字段与形状不合格', shapeProblems.slice(0, 6).join('；'));

  // ---- 链接严格等于 对外基址 + H5 路由（req 7）----
  const baseFromEnv = (envValue('PUBLIC_H5_BASE_URL') || envValue('PUBLIC_BASE_URL') || '').replace(/\/+$/, '');
  if (payload.base_url === baseFromEnv) {
    ok(`base_url 与 PUBLIC_H5_BASE_URL/PUBLIC_BASE_URL 一致（${baseFromEnv}）`);
  } else {
    no('base_url 与对外基址配置不一致', `接口 ${payload.base_url} / 配置 ${baseFromEnv}`);
  }

  const urlProblems = [];
  for (const item of items) {
    const expected = `${baseFromEnv}/h5/report?k=${encodeURIComponent(item.entry)}`;
    if (item.url !== expected) urlProblems.push(`${item.code}: url=${item.url}（期望 ${expected}）`);
    const legacyExpected = `${baseFromEnv}/h5/report?k=${item.code}`;
    if (item.legacy_url !== legacyExpected) urlProblems.push(`${item.code}: legacy_url=${item.legacy_url}`);
  }
  if (urlProblems.length === 0) ok('每条的 url 与 legacy_url 逐字等于"对外基址 + /h5/report?k=…"');
  else no('链接与对外基址拼接规则不符', urlProblems.slice(0, 4).join('；'));

  // ---- 🔴 不得含内部端口 / 后台地址（req 7）----
  //  ⚠️ 判据刻意**不**写"不许出现 localhost"：本机对外入口就是 localhost（nginx 8080），
  //     那样判会在本机自造假红。真正要挡住的是**容器内部端口**与**后台路径** ——
  //     它们在任何环境下都是错的（客户扫到一个打不开的地址）。
  const leakProblems = [];
  // svg 是图形，不含文本 URL；这里只对全部 url / legacy_url 扫。
  for (const item of items) {
    for (const value of [item.url, item.legacy_url]) {
      for (const banned of [':13000', '/admin', 'host.docker.internal']) {
        if (String(value).includes(banned)) leakProblems.push(`${item.code}: ${banned}`);
      }
    }
  }
  if (leakProblems.length === 0) ok('全部链接不含内部端口（:13000）/ 后台路径（/admin）/ 容器主机名');
  else no('链接里出现了不该外发的地址', [...new Set(leakProblems)].slice(0, 5).join('；'));

  // ---- 唯一性（req 1「稳定、唯一」）----
  const uniq = (key) => new Set(items.map((i) => i[key])).size;
  if (uniq('entry') === items.length && uniq('url') === items.length && uniq('qr_svg') === items.length) {
    ok('entry / url / 二维码图像三者两两唯一');
  } else {
    no('入口不唯一', `entry ${uniq('entry')} / url ${uniq('url')} / svg ${uniq('qr_svg')}，应为 ${items.length}`);
  }

  // ---- 稳定：连续两次取回的 entry 必须完全相同（印出去的码不能漂）----
  {
    const again = await adminGet('/api/svc/store-entry');
    const items2 = again.json?.data?.items ?? [];
    const map1 = new Map(items.map((i) => [i.code, i.entry]));
    const drift = items2.filter((i) => map1.get(i.code) !== i.entry).map((i) => i.code);
    if (drift.length === 0 && items2.length === items.length) ok('连续两次取回签名完全一致（稳定，req 1）');
    else no('同一门店的签名在两次取回之间发生了变化', drift.join(','));
  }

  // ------------------------------------------------- 门店账号只看授权门店（req 6）
  section('1.3', '数据范围：门店账号只取到被授权的门店入口');
  {
    const pwdA = envValue('UAT_STORE_A_PASSWORD');
    const pwdB = envValue('UAT_STORE_B_PASSWORD');
    if (!pwdA || !pwdB) {
      no('门店账号口令未配置，无法验证数据范围（环境未就绪）', '先跑 node scripts/uat-accounts.mjs --create');
    } else {
      const tokA = await signIn(STORE_A_EMAIL, pwdA);
      const tokB = await signIn(STORE_B_EMAIL, pwdB);
      const a = tokA ? await http(`${BASE}/api/svc/store-entry`, { headers: { Authorization: `Bearer ${tokA}` } }) : null;
      const b = tokB ? await http(`${BASE}/api/svc/store-entry`, { headers: { Authorization: `Bearer ${tokB}` } }) : null;
      const codesA = (a?.json?.data?.items ?? []).map((i) => i.code);
      const codesB = (b?.json?.data?.items ?? []).map((i) => i.code);
      // 授权是「S01 ↔ store.a、S02 ↔ store.b」（见 store_users 表；若改了授权，这里必须同步改）
      if (
        codesA.length === 1 && codesA[0] === 'S01' &&
        codesB.length === 1 && codesB[0] === 'S02'
      ) {
        ok('门店 A 只取到 S01、门店 B 只取到 S02（applyScope 生效）');
      } else {
        no(
          '门店账号取到的入口范围不对',
          `A=${JSON.stringify(codesA)} B=${JSON.stringify(codesB)}（期望 A=[S01] B=[S02]）`,
        );
      }
      if (codesA.length < items.length && codesB.length < items.length) {
        ok('门店账号的入口集合是总部集合的**真子集**（范围确实被裁过，不是"恰好一样"）');
      } else {
        no('门店账号竟然能看到全部门店 —— 范围裁剪没生效');
      }
    }
  }

  // =========================================================================
  // §2 二维码真实解码（req 8）
  // =========================================================================
  section('2', '真实 Chromium 逐一解码 15 张二维码（req 8）');
  let decoded = null;
  try {
    decoded = await decodeAllQr(items);
  } catch (error) {
    if (error instanceof EnvNotReady) {
      no('二维码真实解码未能执行（环境未就绪）', error.message);
    } else {
      no('二维码真实解码失败', String(error?.message ?? error).slice(0, 300));
    }
  }
  if (decoded) {
    const mismatch = [];
    for (const item of items) {
      const got = decoded.get(item.code);
      if (got !== item.url) mismatch.push(`${item.code}: 解出 ${JSON.stringify(got)} ≠ API 的 ${item.url}`);
    }
    if (mismatch.length === 0) {
      ok(`15 家二维码全部解码成功且**逐字等于** API 返回的 url（每张都真实渲染+解码）`);
    } else {
      no('二维码解码内容与 API 返回的链接不一致', mismatch.slice(0, 4).join('；'));
    }
    // 解出来的 15 条也必须两两不同（否则可能是"15 张图其实一样"）
    const texts = [...decoded.values()];
    if (new Set(texts).size === items.length) ok('解出的 15 条链接两两不同（不是同一张图复制了 15 份）');
    else no('解出的链接有重复', `${new Set(texts).size} 个不同值 / ${items.length} 张图`);
    // 解出来的地址必须能真的打开 H5 页（扫得开 ≠ 打得开）
    const probe = await http(`${baseFromEnv}/h5/report?k=${encodeURIComponent(items[0].entry)}`);
    if (probe.status === 200 && /<div id="app"|<script/.test(probe.body)) {
      ok('扫码得到的地址真的能打开 H5 报修页（HTTP 200 + SPA 容器）');
    } else {
      no('扫码得到的地址打不开 H5 页', `HTTP ${probe.status} ${String(probe.body).slice(0, 120)}`);
    }
  }

  // =========================================================================
  // §3 入口与伪造（req 2 / req 4 / req 5 / req 9）
  // =========================================================================
  section('3', '入口校验：篡改 / 伪造 / 旧码兼容（req 2 / 4 / 5 / 9）');

  const s01 = items.find((i) => i.code === 'S01');
  const s02 = items.find((i) => i.code === 'S02');
  const s15 = items.find((i) => i.code === 'S15');
  assert(s01 && s02 && s15, '接口没有返回 S01/S02/S15，无法继续');

  const entryOf = async (k) => http(`${BASE}/api/public/store-entry?k=${encodeURIComponent(k)}`);

  // ---- 有效入口 ----
  {
    const r = await entryOf(s01.entry);
    const d = r.json?.data;
    if (r.status === 200 && d?.code === 'S01' && d?.name === s01.name && d?.provenance === 'signed') {
      const keys = Object.keys(d).sort();
      if (JSON.stringify(keys) === JSON.stringify(['code', 'name', 'provenance'])) {
        ok('有效签名入口 → 200 且只回 {code,name,provenance}（无 id/电话/地址）');
      } else {
        no('入口解析多回了字段', keys.join(','));
      }
    } else {
      no('有效签名入口未按预期解析', `HTTP ${r.status} ${String(r.body).slice(0, 160)}`);
    }
  }

  // ---- 篡改：把门店编码换掉（req 2 的核心）----
  {
    const forged = `S02.${s01.entry.split('.')[1]}`;
    const r = await entryOf(forged);
    if (r.status === 404 && errorCodeOf(r) === 'STORE_ENTRY_INVALID') {
      ok('把 S01 的签名挂到 S02 → 404 STORE_ENTRY_INVALID（签名绑定了门店编码）');
    } else {
      no('改门店编码的伪造入口未被拒绝', `HTTP ${r.status} code=${errorCodeOf(r)} ${String(r.body).slice(0, 160)}`);
    }
  }

  // ---- 篡改：破坏签名字符 ----
  {
    const parts = s01.entry.split('.');
    const tampered = `${parts[0]}.${parts[1].slice(0, -1)}${parts[1].endsWith('A') ? 'B' : 'A'}`;
    const r = await entryOf(tampered);
    if (r.status === 404 && errorCodeOf(r) === 'STORE_ENTRY_INVALID') {
      ok('改动签名的最后一个字符 → 404（没有"只差一位就放过"的宽容）');
    } else {
      no('篡改签名未被拒绝', `HTTP ${r.status} code=${errorCodeOf(r)}`);
    }
  }

  // ---- 篡改：删掉签名的整段（不得回落成 legacy）----
  {
    const r = await entryOf('S01');
    // 裸编码**是**合法的旧入口 ⇒ 200 legacy。这一条用来说明"两种入口都被接受"，
    // 而"坏签名不回落"由 §3 的坏签名用例负责（那里必须 404）。
    const bad = await entryOf(`S01.${'Z'.repeat(22)}`);
    if (r.status === 200 && r.json?.data?.provenance === 'legacy' && bad.status === 404) {
      ok('裸编码走 legacy（200）、22 位全错签名走拒绝（404）—— 两条路互不混淆');
    } else {
      no(
        'legacy / 坏签名的分流不正确',
        `裸编码 HTTP ${r.status} provenance=${r.json?.data?.provenance}；坏签名 HTTP ${bad.status}`,
      );
    }
  }

  // ---- 空入口 ----
  {
    const r = await pub(`${BASE}/api/public/store-entry`);
    if (r.status === 404 && errorCodeOf(r) === 'STORE_ENTRY_INVALID') {
      ok('缺入口参数 → 404 STORE_ENTRY_INVALID（不泄露"缺的是哪个参数"）');
    } else {
      no('缺入口参数的处理不符合预期', `HTTP ${r.status} code=${errorCodeOf(r)}`);
    }
  }

  // ---- 伪造 body：入口 S01 + body store_code S02 ⇒ 必须拒绝且**不建单** ----
  {
    const before = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    const r = await pub(`${BASE}/api/public/tickets${storeEntryQuery('S01')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({
        store_code: 'S02',
        ticket_type: 'repair',
        content: '[P11-1] 伪造 body store_code 必须被拒绝（脚本自建，不应落库）',
        customer_name: '伪造验收',
        customer_mobile: `135${String(Date.now()).slice(-8)}`,
        privacy_agreed: true,
      }),
    });
    const after = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    if (r.status === 422 && errorCodeOf(r) === 'STORE_BINDING_CONFLICT' && after === before) {
      ok('入口 S01 + body store_code=S02 → 422 STORE_BINDING_CONFLICT，且工单总数未变（req 4）');
    } else {
      no(
        '伪造 body 的 store_code 未被正确拒绝或竟然建了单',
        `HTTP ${r.status} code=${errorCodeOf(r)} 工单数 ${before}→${after}`,
      );
    }
  }

  // ---- 伪造 body：塞进 store_id / 其它内部字段 ⇒ 必须被忽略（白名单）----
  let forgedFieldTicketId = null;
  {
    const mobile = `134${String(Date.now()).slice(-8)}`;
    const r = await pub(`${BASE}/api/public/tickets${storeEntryQuery('S01')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({
        store_code: 'S01',
        // 这些字段**必须**被忽略（parseDto 是白名单，不是黑名单）
        store_id: 2,
        status: 'CLOSED',
        handler_user_id: 1,
        id: 999999,
        ticket_type: 'repair',
        content: '[P11-1] body 越界字段必须被忽略（脚本自建，跑完自删）',
        customer_name: '白名单验收',
        customer_mobile: mobile,
        privacy_agreed: true,
      }),
    });
    const ticketNo = r.json?.data?.ticket_no;
    if ((r.status === 200 || r.status === 201) && ticketNo) {
      const row = psqlRows(
        `SELECT t.id, s.code, t.status FROM service_tickets t JOIN stores s ON s.id = t.store_id` +
          ` WHERE t.ticket_no = '${String(ticketNo).replace(/'/g, "''")}'`,
      )[0];
      forgedFieldTicketId = Number(row?.[0] ?? 0) || null;
      if (row && row[1] === 'S01' && row[2] === 'NEW') {
        ok('body 里的 store_id/status/handler_user_id/id 被忽略，工单落 S01 且状态为 NEW（req 4）');
      } else {
        no('body 越界字段影响了建单结果', `落库行 ${JSON.stringify(row)}`);
      }
    } else {
      no('带越界字段的合法入口建单失败（不该失败，它们应当被忽略）', `HTTP ${r.status} ${String(r.body).slice(0, 160)}`);
    }
  }

  // ---- 旧入口（旧二维码）真实建单 + provenance 留痕（req 5）----
  let legacyTicketId = null;
  {
    const mobile = `133${String(Date.now()).slice(-8)}`;
    // 旧二维码的形态就是 `?store=S15`（裸编码）⇒ 等价于 `k=S15`
    const r = await pub(`${BASE}/api/public/tickets?k=S15`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({
        store_code: 'S15',
        ticket_type: 'repair',
        content: '[P11-1] 旧二维码兼容入口建单（脚本自建，跑完自删）',
        customer_name: '旧码验收',
        customer_mobile: mobile,
        privacy_agreed: true,
      }),
    });
    const ticketNo = r.json?.data?.ticket_no;
    if ((r.status === 200 || r.status === 201) && ticketNo) {
      const row = psqlRows(
        `SELECT t.id, s.code, e.metadata_json->>'entry_provenance'` +
          ` FROM service_tickets t` +
          ` JOIN stores s ON s.id = t.store_id` +
          ` JOIN ticket_events e ON e.ticket_id = t.id AND e.event_type = 'created'` +
          ` WHERE t.ticket_no = '${String(ticketNo).replace(/'/g, "''")}'`,
      )[0];
      legacyTicketId = Number(row?.[0] ?? 0) || null;
      if (row && row[1] === 'S15' && row[2] === 'legacy') {
        ok('旧入口建单成功、归属 S15，且建单事件 metadata.entry_provenance = legacy（req 5 的留痕）');
      } else {
        no('旧入口建单的归属或 provenance 不对', `落库行 ${JSON.stringify(row)}`);
      }
    } else {
      no('旧二维码兼容入口无法建单（req 5 要求它继续可用）', `HTTP ${r.status} ${String(r.body).slice(0, 160)}`);
    }
  }

  // ---- 新入口建单的 provenance 必须是 signed ----
  {
    const mobile = `132${String(Date.now()).slice(-8)}`;
    const r = await pub(`${BASE}/api/public/tickets${storeEntryQuery('S01')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({
        store_code: 'S01',
        ticket_type: 'repair',
        content: '[P11-1] 新签名入口建单（脚本自建，跑完自删）',
        customer_name: '签名验收',
        customer_mobile: mobile,
        privacy_agreed: true,
      }),
    });
    const ticketNo = r.json?.data?.ticket_no;
    const row = ticketNo
      ? psqlRows(
          `SELECT t.id, e.metadata_json->>'entry_provenance'` +
            ` FROM service_tickets t` +
            ` JOIN ticket_events e ON e.ticket_id = t.id AND e.event_type = 'created'` +
            ` WHERE t.ticket_no = '${String(ticketNo).replace(/'/g, "''")}'`,
        )[0]
      : null;
    if (row && row[1] === 'signed') {
      ok('新签名入口建单：建单事件 metadata.entry_provenance = signed');
      cleanupTicket(Number(row[0]));
    } else {
      no('新入口的 provenance 未按 signed 落库', `HTTP ${r.status} 行 ${JSON.stringify(row)}`);
      if (row) cleanupTicket(Number(row[0]));
    }
  }

  // ---- 被篡改的入口不能建单 ----
  {
    const before = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    const forged = `S02.${s01.entry.split('.')[1]}`;
    const r = await pub(`${BASE}/api/public/tickets?k=${encodeURIComponent(forged)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({
        store_code: 'S01',
        ticket_type: 'repair',
        content: '[P11-1] 篡改入口不得建单',
        customer_name: '篡改验收',
        customer_mobile: `131${String(Date.now()).slice(-8)}`,
        privacy_agreed: true,
      }),
    });
    const after = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    if (r.status === 422 && errorCodeOf(r) === 'INVALID_STORE_ENTRY' && after === before) {
      ok('篡改入口建单 → 422 INVALID_STORE_ENTRY 且未落库（req 2/4）');
    } else {
      no('篡改入口竟然可能建单', `HTTP ${r.status} code=${errorCodeOf(r)} 单数 ${before}→${after}`);
    }
  }

  // ---- 缺入口建单 ----
  {
    const r = await pub(`${BASE}/api/public/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({
        store_code: 'S01',
        ticket_type: 'repair',
        content: '[P11-1] 缺入口不得建单',
        customer_name: '缺入口验收',
        customer_mobile: `130${String(Date.now()).slice(-8)}`,
        privacy_agreed: true,
      }),
    });
    if (r.status === 422 && errorCodeOf(r) === 'MISSING_STORE_ENTRY') {
      ok('不带入口建单 → 422 MISSING_STORE_ENTRY（门店归属不再由 body 决定）');
    } else {
      no('缺入口建单未被拒绝', `HTTP ${r.status} code=${errorCodeOf(r)}`);
    }
  }

  // =========================================================================
  // §4 停用门店（req 6）
  // =========================================================================
  section('4', '停用门店不得创建新单，且不影响既有数据（req 6）');
  {
    // ⚠️ 门店编码必须**符合 seed 的 `STORE_CODE_PATTERN`（`/^S\d{2,3}$/`）**。
    //    第一版用了 `TZ9`，结果建单被 `parseDto` 以 `INVALID_STORE_CODE` 拦下 ——
    //    断言"停用门店被拦住"**看似通过**，但拦住它的是**编码格式**而不是停用状态，
    //    等于这条用例根本没测到它要测的东西（典型的形式通过、实质空转）。
    //    用 `S99`：形态合法、且不在 S01~S15 之内。
    const TEMP = 'S99';
    const tempName = 'P11-1 验收临时门店（脚本自建，跑完自删）';
    // ⚠️ 刻意**新建**一个临时门店去测停用，而不是把 15 家真门店之一改成停用：
    //    脚本中途崩溃时，"某家真门店被留在停用状态"是一个**面向客户的故障**
    //    （那家店的二维码当场失效），而临时门店留在库里只是脏数据。
    psqlExec(`DELETE FROM stores WHERE code = '${TEMP}';`);
    const ins = psqlExec(
      `INSERT INTO stores (created_at, updated_at, code, name, active, sort_order)` +
        ` VALUES (now(), now(), '${TEMP}', '${tempName}', false, 999);`,
    );
    if (!ins.ok) {
      no('临时门店创建失败，停用场景未验证', ins.out.slice(0, 200));
    } else {
      const tempEntry = storeEntryToken(TEMP); // 用产品实现签名（密钥与容器同源）
      // ① 停用门店的入口不可解析
      const r1 = await pub(`${BASE}/api/public/store-entry?k=${encodeURIComponent(tempEntry)}`);
      // ② 停用门店不得建单
      const before = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
      const r2 = await pub(`${BASE}/api/public/tickets?k=${encodeURIComponent(tempEntry)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
        body: JSON.stringify({
          store_code: TEMP,
          ticket_type: 'repair',
          content: '[P11-1] 停用门店不得建单',
          customer_name: '停用验收',
          customer_mobile: `139${String(Date.now()).slice(-8)}`,
          privacy_agreed: true,
        }),
      });
      const after = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
      // ⚠️ 判据刻意**不**钉死某一个错误码，只钉住 req 6 真正要求的三件事：
      //    ① 建单被拒绝（4xx，不是 2xx、也不是 5xx）；
      //    ② 没有留下任何工单（计数不变）；
      //    ③ 入口解析本身也不可用。
      //
      //    为什么不钉错误码（2026-10-10 实测）：两条路径**刻意不同** ——
      //      · `publicStore:entry` → **404 STORE_ENTRY_INVALID**：
      //        它把"不存在"与"已停用"折叠成同一句话，不让刚进页面的匿名访客
      //        区分"这个编码不存在"与"这家店停了"（区分它们等于泄露门店状态）。
      //      · `publicTicket:create` → **422 STORE_INACTIVE**：
      //        写入路径在 `findActiveStore()` 里给的是**可行动**的语义，
      //        因为客户此时已经填完一整张表单，需要知道"这店暂时不接单"。
      //    这个差异是**先于 P11-1 就存在的**（旧版建单同样回 STORE_INACTIVE，
      //    H5 页面一直在按它对错误做映射）。
      //    ⇒ 把它写成断言就等于把"两个接口错误码必须一致"当成需求 ——
      //      而那不是用户提的需求，钉死它只会让下一次合理的调整变成假红。
      //    ⚠️ 但**枚举泄露**这一面要如实记下来：持有合法签名入口的人本就知道
      //      这家店存在（入口是我方签的），所以 422 STORE_INACTIVE 不构成新泄露；
      //      而裸编码（legacy）理论上能被猜到 —— 门店编码本来就印在墙上，
      //      因此"能区分某家店是否停用"不在本阶段要守的边界内。
      const rejected = r2.status >= 400 && r2.status < 500;
      if (r1.status === 404 && rejected && after === before) {
        ok(
          `停用门店：入口 404 + 建单被拒（HTTP ${r2.status} ${errorCodeOf(r2)}），工单总数不变`,
          'req 6 的三件事（拒绝 / 不建单 / 历史不受影响）都成立',
        );
      } else {
        no(
          '停用门店未被拦住',
          `入口 HTTP ${r1.status}；建单 HTTP ${r2.status} code=${errorCodeOf(r2)} 单数 ${before}→${after}`,
        );
      }

      // ③ 既有工单不受影响：把临时门店启用后，S01 的历史工单条数不应变化
      const s01TicketsBefore = Number(
        psqlScalar(`SELECT count(*) FROM service_tickets t JOIN stores s ON s.id=t.store_id WHERE s.code='S01'`),
      );
      psqlExec(`UPDATE stores SET active = true, updated_at = now() WHERE code = '${TEMP}';`);
      const r3 = await pub(`${BASE}/api/public/store-entry?k=${encodeURIComponent(tempEntry)}`);
      const s01TicketsAfter = Number(
        psqlScalar(`SELECT count(*) FROM service_tickets t JOIN stores s ON s.id=t.store_id WHERE s.code='S01'`),
      );
      if (r3.status === 200 && s01TicketsAfter === s01TicketsBefore) {
        ok('重新启用后入口恢复可用；期间 S01 既有工单数不变（req 6「历史不受影响」）');
      } else {
        no(
          '启用后入口未恢复或历史工单受影响',
          `入口 HTTP ${r3.status}；S01 工单 ${s01TicketsBefore}→${s01TicketsAfter}`,
        );
      }

      // 清理：临时门店从未建过单 ⇒ 直接删行是安全的
      const del = psqlExec(`DELETE FROM stores WHERE code = '${TEMP}';`);
      if (del.ok && psqlScalar(`SELECT count(*) FROM stores WHERE code='${TEMP}'`) === '0') {
        ok('临时门店已清理（不留脏数据）');
      } else {
        no('临时门店清理失败', del.out.slice(0, 160));
      }
    }
  }

  // =========================================================================
  // §5 S01 / S02 数据隔离（req 9）
  // =========================================================================
  section('5', 'S01 / S02 门店数据隔离（req 9）');
  const isolationTickets = [];
  {
    const mk = async (code, mobile) => {
      const r = await pub(`${BASE}/api/public/tickets${storeEntryQuery(code)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
        body: JSON.stringify({
          store_code: code,
          ticket_type: 'repair',
          content: `[P11-1] 隔离验收：${code}（脚本自建，跑完自删）`,
          customer_name: `隔离验收${code}`,
          customer_mobile: mobile,
          privacy_agreed: true,
        }),
      });
      const no_ = r.json?.data?.ticket_no;
      if (!no_) return null;
      const row = psqlRows(
        `SELECT t.id, s.code FROM service_tickets t JOIN stores s ON s.id=t.store_id` +
          ` WHERE t.ticket_no = '${String(no_).replace(/'/g, "''")}'`,
      )[0];
      return row ? { id: Number(row[0]), store: row[1], no: no_ } : null;
    };
    const t1 = await mk('S01', `136${String(Date.now()).slice(-8)}`);
    const t2 = await mk('S02', `137${String(Date.now()).slice(-8)}`);
    if (t1 && t2 && t1.store === 'S01' && t2.store === 'S02') {
      ok(`同一天同时用两个入口建单：S01 单落 S01、S02 单落 S02（${t1.no} / ${t2.no}）`);
    } else {
      no('两个入口建出的单归属不正确', JSON.stringify({ t1, t2 }));
    }
    if (t1) isolationTickets.push(t1.id);
    if (t2) isolationTickets.push(t2.id);

    // 门店 A 的列表里必须只有 S01 的单
    const pwdA = envValue('UAT_STORE_A_PASSWORD');
    if (!pwdA) {
      no('门店 A 口令未配置，隔离未验证', '环境未就绪');
    } else {
      const tokA = await signIn(STORE_A_EMAIL, pwdA);
      const list = tokA
        ? await http(`${BASE}/api/serviceTickets:list?pageSize=200`, {
            headers: { Authorization: `Bearer ${tokA}` },
          })
        : null;
      const rows = list?.json?.data ?? [];
      const nos = rows.map((r) => r.ticket_no);
      const stores = new Set(rows.map((r) => r.store?.code ?? r.source_store_code).filter(Boolean));
      const leaked = t2 && nos.includes(t2.no);
      if (list?.status === 200 && stores.size <= 1 && [...stores].every((c) => c === 'S01') && !leaked) {
        ok(`门店 A 的工单列表 ${rows.length} 条全部属于 S01，且看不到 S02 的新单 ${t2?.no}`);
      } else {
        no(
          '门店 A 看到了别家门店的工单',
          `HTTP ${list?.status} 门店集合=${JSON.stringify([...stores])} 含 S02 新单=${leaked}`,
        );
      }
    }
  }

  // =========================================================================
  // §6 跨店转移仍然不可用（req 10 · 存在性复核）
  // =========================================================================
  section('6', '跨店转移不可用（req 10）');
  {
    const pwdA = envValue('UAT_STORE_A_PASSWORD');
    const target = isolationTickets[0] ?? Number(psqlScalar('SELECT id FROM service_tickets ORDER BY id LIMIT 1'));
    if (!pwdA) {
      no('门店 A 口令未配置，req 10 未复核', '环境未就绪');
    } else {
      const tokA = await signIn(STORE_A_EMAIL, pwdA);
      const results = {};
      for (const action of ['transfer', 'transferTargets']) {
        const r = tokA
          ? await http(`${BASE}/api/svc:${action}?filterByTk=${target}`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${tokA}`,
                'Content-Type': 'application/json',
                'X-Request-Id': crypto.randomUUID(),
              },
              body: JSON.stringify({ target_store_code: 'S02' }),
            })
          : null;
        results[action] = r ? { status: r.status, code: errorCodeOf(r) } : null;
      }
      const allBlocked = Object.values(results).every((v) => v && (v.status === 403 || v.status === 404));
      if (allBlocked) {
        ok(
          `门店角色调 svc:transfer / svc:transferTargets 一律被拒（${JSON.stringify(results)}）`,
          '完整多角色矩阵见转单撤销专项门禁',
        );
      } else {
        no('跨店转移没有被拒绝', JSON.stringify(results));
      }
    }
  }

  // =========================================================================
  // §7 后台 UI 真实走查：登录 → 页面 → 点「报修入口」→ 复制 / 下载（req 1）
  // =========================================================================
  section('7', '后台 UI 真实走查：能复制链接、能下载二维码（req 1）');
  try {
    const ui = await verifyAdminUi(items);
    for (const line of ui) ok(line);
  } catch (error) {
    if (error instanceof EnvNotReady) no('后台 UI 走查未能执行（环境未就绪）', error.message);
    else no('后台 UI 走查未通过', String(error?.message ?? error).slice(0, 400));
  }

  // =========================================================================
  // §8 客户 H5 真实浏览器走查：进入即锁定门店、无选择器、旧入口如实提示（req 3 / 5）
  // =========================================================================
  section('8', '客户 H5 真实走查：门店锁定 / 无选择器 / 旧入口提示（req 3 / 5）');
  try {
    const ui = await verifyCustomerH5(items, s01, s15);
    for (const line of ui) ok(line);
  } catch (error) {
    if (error instanceof EnvNotReady) no('客户 H5 走查未能执行（环境未就绪）', error.message);
    else no('客户 H5 走查未通过', String(error?.message ?? error).slice(0, 400));
  }

  // ---- 清理 §3 造出来的工单（精确删除，不碰任何真人走查的基线单）----
  for (const id of [forgedFieldTicketId, legacyTicketId]) {
    if (id) {
      try {
        cleanupTicket(id);
      } catch (error) {
        console.log(`  ⚠️ 清理工单 ${id} 失败：${error?.message}`);
      }
    }
  }
  for (const id of isolationTickets) {
    try {
      cleanupTicket(id);
    } catch (error) {
      console.log(`  ⚠️ 清理隔离工单 ${id} 失败：${error?.message}`);
    }
  }
  console.log(`\n  · 已清理本轮自建工单 ${[forgedFieldTicketId, legacyTicketId, ...isolationTickets].filter(Boolean).length} 张`);
}

// ===========================================================================
// 二维码真实解码：真实 Chromium 渲染 SVG → canvas → jsQR
// ===========================================================================
function findChrome() {
  const base = path.join(process.env.USERPROFILE || process.env.HOME || '', '.agent-browser', 'browsers');
  if (!fs.existsSync(base)) return null;
  const candidates = fs
    .readdirSync(base)
    .filter((d) => d.startsWith('chrome-'))
    .map((d) => path.join(base, d, 'chrome.exe'))
    .filter((p) => fs.existsSync(p));
  return candidates[0] ?? null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 起一个真实 Chromium，把 CDP 会话交给回调，结束后无条件关闭。
 *
 * ⚠️ 抽成一份而不是每处各写一段的**理由是本项目踩过的那一类**：
 *    端口分配、`Target.attachToTarget`、`Runtime.enable`、异常必须抛出
 *    （不能静默 resolve(undefined)）—— 这些细节任何一处写歪，
 *    表现都是"浏览器连上了但什么都没发生"，而两处各写一份就会各自歪一次。
 *    （同源教训：DEV-66「探针自己造出来的故障」、以及本项目"同一个坑长出多条腿"的通用形状。）
 *
 * @param {(api: {ctx:Function, evaluate:Function, send:Function}) => Promise<any>} fn
 */
async function withChrome(fn, { downloadsDir = null, grantClipboardFor = null } = {}) {
  const chromePath = findChrome();
  if (!chromePath) throw new EnvNotReady('未找到 Chrome（~/.agent-browser/browsers/chrome-*/chrome.exe）');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  // ⚠️ 端口随机：固定端口时，上一次失败运行留下的 Chrome 可能占着它，
  //    新实例会把 URL 转交给旧实例后退出 —— 脚本连上的是"还停在旧页面"的僵尸浏览器
  //    （walkthrough-p5-1-browser.mjs 注释里同款坑）。
  const port = 24000 + Math.floor(Math.random() * 12000);
  const profile = path.join(OUT_DIR, `chrome-profile-storeentry-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--window-size=1280,900',
      // ⚠️ 本机挂的是**自签演练证书** ⇒ 不加这两条，Chrome 会停在
      //    「您的连接不是私密连接」拦截页上，于是页面里一个 `input` 都没有，
      //    而症状是"登录页未就绪" —— 看起来像后台坏了，其实是证书没被忽略。
      //    沿用既有门禁（verify-store-tab-filter / verify-store-ui-primary-action）
      //    的写法：**只在 SVC_TLS_INSECURE 打开时**才忽略证书错误，
      //    正式域名到位后这个开关一关，校验就回来了。
      ...(SVC_TLS_INSECURE ? ['--ignore-certificate-errors', '--allow-insecure-localhost'] : []),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const kill = () => {
    try {
      chrome.kill();
    } catch {
      /* 已退出 */
    }
  };

  try {
    let version = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        break;
      } catch {
        await sleep(500);
      }
    }
    if (!version) throw new EnvNotReady(`Chrome 的 CDP 未在 ${port} 端口就绪`);

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    /**
     * 浏览器**真实发出**的请求（URL + 方法）。
     *
     * 为什么要收它：`verify-phase3-h5` 之类的断言只看接口返回值，
     * 而"页面到底把入口放在了哪"只有**浏览器实际发出的 URL** 能回答
     * （DEV-74 / DEV-18 两次教训都出在"探针从没看过那一行 Request URL"）。
     */
    const requests = [];
    const send = (method, params = {}, sessionId) => {
      const mid = ++id;
      const msg = { id: mid, method, params: params ?? {} };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
      return new Promise((res, rej) => pending.set(mid, { res, rej }));
    };
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        // ⚠️ CDP 错误必须**抛出**，不能静默 resolve(undefined)（DEV-66）
        if (m.error) p.rej(new Error(`${m.method}: ${m.error.message}`));
        else p.res(m.result);
        return;
      }
      if (m.method === 'Network.requestWillBeSent') {
        requests.push({
          url: m.params.request?.url ?? '',
          method: m.params.request?.method ?? '',
          postData: m.params.request?.postData ?? null,
        });
      } else if (m.method === 'Network.loadingFailed') {
        requests.push({ url: '', method: '', failed: m.params.errorText ?? 'unknown' });
      }
    });
    await new Promise((r) => ws.addEventListener('open', r));

    const targets = await send('Target.getTargets', {});
    const pageTarget = targets.targetInfos.find((t) => t.type === 'page');
    if (!pageTarget) throw new EnvNotReady('Chrome 里没有 page target');
    const { sessionId } = await send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    const ctx = (method, params) => send(method, params, sessionId);
    await ctx('Runtime.enable');
    await ctx('Page.enable');
    await ctx('Network.enable');

    if (downloadsDir) {
      fs.mkdirSync(downloadsDir, { recursive: true });
      // 允许下载到指定目录（且开启事件，便于判断"到底有没有开始下"）
      await send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadsDir,
        eventsEnabled: true,
      });
    }

    // 剪贴板权限：不授予的话 `navigator.clipboard.writeText` 在 headless 里会抛
    // `NotAllowedError`，实现里的兜底（execCommand）在无焦点页面里也返回 false ⇒
    // **复制功能本身没问题，验收却红** ——
    // 那正是"红灯指向环境而不是产品"的典型。授予权限之后，
    // 本门禁还能顺手做一件更强的事：**把剪贴板内容读回来比对**（见 §7-⑤）。
    if (grantClipboardFor) {
      // ⚠️ `Browser.*` 是 **browser 级**命令（不带 sessionId）；
      //    `Page.*` 是 **target 级**命令（必须带 sessionId）。
      //    混用会得到 `'Page.bringToFront' wasn't found` —— 那条报错读起来像
      //    "这个版本没有这个 API"，实际是**发错了端点**。
      await send('Browser.grantPermissions', {
        origin: grantClipboardFor,
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      });
      // 无焦点的页面读不到剪贴板；headless 也需要显式置前
      await ctx('Page.bringToFront');
    }

    /** 求值并把页面侧异常**变成 Node 侧异常**（静默吞掉异常是探针故障的头号来源） */
    const evaluate = async (expression, { awaitPromise = false } = {}) => {
      const res = await ctx('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
      if (res.exceptionDetails) {
        const d = res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails);
        throw new Error(`页面侧异常：${String(d).split('\n')[0]}`);
      }
      return res.result?.value;
    };
    const evaluateJson = async (expression, opts) => JSON.parse(await evaluate(expression, opts));

    return await fn({ ctx, send, evaluate, evaluateJson, requests });
  } finally {
    kill();
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* profile 被 Chrome 占着时留给系统清理 */
    }
  }
}

/**
 * 在页面里注入 jsQR（独立解码实现，与生成端 `qrcode` 不是同一个库）。
 *
 * 🔴 注入时必须**先遮蔽 AMD 的 `define`**：
 *    jsQR 的 dist 是 UMD，分支顺序是
 *      `typeof exports === 'object' && typeof module === 'object'` → `module.exports`
 *      `typeof define === 'function' && define.amd`              → `define([], factory)`
 *      `typeof exports === 'object'`                             → `exports.jsQR`
 *      否则                                                       → `root.jsQR`
 *    而**后台 SPA 里恰好有 requirejs**（NocoBase 用 AMD 加载插件前端），
 *    于是它走了第二支：模块被注册进 AMD 注册表，`window.jsQR` **永远是 undefined**。
 *    症状是"解码时报 jsQR 未注入"，而同一段源码在 `about:blank`（无 define）里
 *    工作得好好的 —— 首跑就是这么被误导的：§2 的 15 张全部解码成功、
 *    §7 的同一段代码却报"未注入"，差别**只在于页面环境**。
 *    ⇒ 用一层 IIFE 把 `module` / `exports` / `define` 声明成局部变量遮蔽掉，
 *      UMD 就只能落到 `root.jsQR = factory()` 那一支。
 */
function jsqrInjectExpression() {
  const p = path.join(NODE_WORKSPACE, 'node_modules', 'jsqr', 'dist', 'jsQR.js');
  if (!fs.existsSync(p)) throw new EnvNotReady(`未找到 jsQR 产物：${p}`);
  const source = fs.readFileSync(p, 'utf8');
  return (
    '(() => {\n' +
    '  var module, exports, define;\n' + // 遮蔽 UMD 的 AMD / CommonJS 分支
    source +
    '\n  return typeof window.jsQR;\n' +
    '})()'
  );
}

/**
 * 页面侧：把一段二维码 SVG 渲染成像素并用 jsQR 解回文本。
 * 返回 `{text}` 或 `{err}`（**不抛**，由调用方决定怎么报）。
 */
function qrDecodeExpression(svg, size) {
  return (
    '(async () => {\n' +
    `  const svg = ${JSON.stringify(svg)};\n` +
    '  const img = new Image();\n' +
    "  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);\n" +
    '  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("svg load failed")); });\n' +
    `  const size = ${size};\n` +
    "  const c = document.createElement('canvas');\n" +
    '  c.width = size; c.height = size;\n' +
    "  const g = c.getContext('2d');\n" +
    "  g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);\n" +
    '  g.drawImage(img, 0, 0, size, size);\n' +
    '  const d = g.getImageData(0, 0, size, size);\n' +
    '  if (typeof window.jsQR !== "function") return JSON.stringify({ err: "jsQR 未注入" });\n' +
    "  const r = window.jsQR(d.data, size, size, { inversionAttempts: 'dontInvert' });\n" +
    '  return JSON.stringify({ text: r ? r.data : null, size: size });\n' +
    '})()'
  );
}

/** 由 SVG 的 viewBox 推出"每模块多少像素"才能让模块边界落在整数像素上 */
function rasterSizeOf(svg) {
  const vb = /viewBox="0 0 ([0-9]+) ([0-9]+)"/.exec(svg);
  if (!vb) throw new Error('二维码 SVG 缺少 viewBox，无法确定模块数');
  return Number(vb[1]) * 12;
}

/**
 * 用真实 Chromium 把每张二维码 SVG 渲染成像素并用 jsQR 解回文本。
 *
 * 🔴 为什么非要真实浏览器（req 8 的字面要求，也是本条判据唯一有意义的形式）：
 *    如果只比对 `url` 与"我以为编进去的字符串"，那么**生成器坏掉时照样全绿** ——
 *    看到的只是"我算了一遍我自己的期望值"。真实渲染引入了 QR 编码/掩码/静区
 *    这几段完全由 `qrcode` 库掌控的逻辑，以及"这张图到底能不能被扫出来"这个事实。
 *
 * ⚠️ jsQR 用的是**独立实现**（不是 qrcode 库），所以"编码器与解码器同时错"的概率极低。
 */
async function decodeAllQr(items) {
  return withChrome(async ({ evaluate, evaluateJson }) => {
    await evaluate(jsqrInjectExpression());
    const decoded = new Map();
    for (const item of items) {
      const svg = String(item.qr_svg);
      const size = rasterSizeOf(svg);
      const parsed = await evaluateJson(qrDecodeExpression(svg, size), { awaitPromise: true });
      if (parsed.err) throw new Error(`${item.code}: ${parsed.err}`);
      decoded.set(item.code, parsed.text);
      console.log(
        `      · ${item.code} → ${parsed.text ? String(parsed.text).slice(-40) : '(解码失败)'}  [${parsed.size}px]`,
      );
    }
    return decoded;
  });
}

// ===========================================================================
// 后台 UI 真实走查（req 1 的"后台授权人员能够复制链接、下载二维码"）
// ===========================================================================
/**
 * 为什么这一段必须**真实浏览器**、且必须点到那两枚按钮：
 *
 *   §1 证明了服务端**回**了正确的链接与二维码；§2 证明了那些二维码**扫得出来**。
 *   但 req 1 说的是**后台授权人员能够复制链接、下载二维码** ——
 *   那是两个**界面动作**。少了这一段，可能出现的漏检是：
 *     · 行内动作压根没挂上（DEV-68 那种"库里写对了、按钮一个都没有"）；
 *     · 弹窗打开了但没有复制按钮 / 点了没反应；
 *     · "下载二维码"下下来的是**空文件**或**别人的码**；
 *     · 下载按钮在 `qr_svg` 为空时仍然可点（那是"点了没反应"的按钮）。
 *   这些都不会让任何 `/api` 断言变红。
 *
 * ⚠️ 下载下来的文件**要再解一次码**，而不是只断言"目录里多了个文件"：
 *    "有文件"与"文件是可扫的二维码"是两件事，前者在下错内容时同样成立。
 *    解出来的文本还必须**逐字等于**该门店的 `url`。
 */
async function verifyAdminUi(items) {
  const notes = [];
  const target = items.find((i) => i.code === 'S01');
  if (!target) throw new EnvNotReady('接口没有返回 S01，无法走查后台 UI');

  // 页面路由 uid **在运行期发现**，不写死：
  // 写死等于把"重新播种后页面换 uid"变成一次假红（而 uid 会随重建变化）。
  const routes = await http(`${BASE}/api/desktopRoutes:list?pageSize=200`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const pageRoute = (routes.json?.data ?? []).find(
    (r) => r.type === 'flowPage' && r.title === '门店报修入口',
  );
  if (!pageRoute?.schemaUid) throw new EnvNotReady('desktopRoutes 里找不到「门店报修入口」页面');
  const pageUrl = `${BASE}/admin/${pageRoute.schemaUid}`;

  const downloadsDir = path.join(OUT_DIR, 'downloads-storeentry');

  const result = await withChrome(
    async ({ ctx, evaluate, evaluateJson }) => {
      const out = [];

      // ---------------- ① 登录 ----------------
      await ctx('Page.navigate', { url: `${BASE}/signin` });
      await sleep(15000); // 冷启动余量：后台 SPA 首次加载要拉几十个插件 bundle
      const inputs = await evaluateJson('JSON.stringify({ n: document.querySelectorAll("input").length })');
      if (inputs.n < 2) throw new EnvNotReady('登录页未就绪（input 少于 2 个）');
      const filled = await evaluateJson(
        '(() => {\n' +
          '  const ins = [...document.querySelectorAll("input")];\n' +
          '  const setVal = (el, val) => {\n' +
          '    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;\n' +
          '    setter.call(el, val);\n' +
          '    el.dispatchEvent(new Event("input", { bubbles: true }));\n' +
          '    el.dispatchEvent(new Event("change", { bubbles: true }));\n' +
          '  };\n' +
          `  setVal(ins[0], ${JSON.stringify(ADMIN_EMAIL)});\n` +
          `  setVal(ins[1], ${JSON.stringify(ADMIN_PASSWORD)});\n` +
          '  return JSON.stringify(ins.slice(0, 2).map((x) => x.value));\n' +
          '})()',
      );
      // ⚠️ 回读复核：填不进去就必须**当场**失败，而不是等 25 秒后报"表格没渲染"
      //    （DEV-66：探针的故障会伪装成产品缺陷）
      if (filled[0] !== ADMIN_EMAIL || !filled[1]) {
        throw new EnvNotReady(`登录表单未填入（长度 ${filled.map((x) => (x || '').length).join('/')}）`);
      }
      await sleep(1200);
      const clicked = await evaluate(
        '(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.innerText||"").indexOf("登录") !== -1); if (!b) return "NOT_FOUND"; b.click(); return "CLICKED"; })()',
      );
      if (clicked !== 'CLICKED') throw new EnvNotReady(`未找到登录按钮（${clicked}）`);

      let signedIn = false;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await sleep(2000);
        const url = await evaluate('location.href');
        if (typeof url === 'string' && url.indexOf('/signin') === -1) {
          signedIn = true;
          break;
        }
      }
      if (!signedIn) throw new EnvNotReady('登录后仍停留在 /signin（账号口令或后台可用性有问题）');

      // ---------------- ② 打开「门店报修入口」页面 ----------------
      await ctx('Page.navigate', { url: pageUrl });
      // 等表格真的出现行。判据是 **DOM 里的行数**，不是"接口 200"——
      // 「接口有数据」不能证明「用户看得见」（DEV-65 的核心教训）。
      let rows = 0;
      const t2 = Date.now() + 60000;
      while (Date.now() < t2) {
        await sleep(1500);
        rows = Number(
          await evaluate('document.querySelectorAll(".ant-table-tbody tr.ant-table-row").length'),
        );
        if (rows > 0) break;
      }
      if (rows <= 0) throw new Error('页面渲染出 0 行门店（表格没出来）');
      out.push(`打开「门店报修入口」页面，渲染出 ${rows} 行门店`);

      // ---------------- ③ 点**目标门店那一行**的「报修入口」 ----------------
      //
      // ⚠️ 判据用**模型自己补的 `data-testid` + `data-store-code`**，不按文案找：
      //    · 「报修入口」四个字同时出现在**菜单项、页面标题、Tab 标题**上，
      //      按文字找极易点到导航那一个 —— 它点了只会跳页，
      //      症状是"弹窗没出现"，把排查引向错误的方向；
      //    · 也不能"点第一行就算"：本页默认按 `sort_order, code` 排序，
      //      而 `sort_order` 是人工编排的展示顺序，**第一行未必是 S01**
      //      （首跑实测第一行是 S15，于是断言"弹窗里的门店名不是 S01"报了红 ——
      //       那是**验收脚本自己的假设**错了，不是产品错）。
      //      改成"点 S01 那一行"之后，判据从"碰巧对齐"变成"精确对齐"。
      const clickedRow = await evaluate(
        '(() => {\n' +
          `  const btn = document.querySelector('[data-testid="svc-store-entry-action"][data-store-code="${target.code}"]');\n` +
          '  if (!btn) return "NOT_FOUND";\n' +
          '  btn.click();\n' +
          '  return "CLICKED";\n' +
          '})()',
      );
      if (clickedRow !== 'CLICKED') {
        // 这一条同时是"自定义动作真的挂上并且**渲染成了我们的模型**"的证据
        throw new Error(
          `门店 ${target.code} 那一行里找不到 [data-testid=svc-store-entry-action] —— ` +
            '行内动作没挂上，或渲染成了框架的兜底按钮（模型没被解析）',
        );
      }
      await sleep(2500);

      // ---------------- ④ 弹窗内容 ----------------
      const modal = await evaluateJson(
        '(() => {\n' +
          '  const q = (sel) => document.querySelector(sel);\n' +
          '  const modalEl = q(\'[data-testid="svc-store-entry-modal"]\');\n' +
          '  const svg = q(\'[data-testid="svc-store-entry-qr"] svg\');\n' +
          '  return JSON.stringify({\n' +
          '    hasModal: !!modalEl,\n' +
          '    name: q(\'[data-testid="svc-store-entry-name"]\') ? q(\'[data-testid="svc-store-entry-name"]\').innerText.trim() : null,\n' +
          '    url: q(\'[data-testid="svc-store-entry-url-value"]\') ? q(\'[data-testid="svc-store-entry-url-value"]\').innerText.trim() : null,\n' +
          '    legacyUrl: q(\'[data-testid="svc-store-entry-legacy-url-value"]\') ? q(\'[data-testid="svc-store-entry-legacy-url-value"]\').innerText.trim() : null,\n' +
          '    hasLegacyNote: !!q(\'[data-testid="svc-store-entry-legacy-note"]\'),\n' +
          '    hasSvg: !!svg,\n' +
          '    qrSvg: svg ? svg.outerHTML : null,\n' +
          '    hasDownload: !!q(\'[data-testid="svc-store-entry-download"]\'),\n' +
          '    hasCopy: !!q(\'[data-testid="svc-store-entry-url-copy"]\'),\n' +
          '  });\n' +
          '})()',
      );
      if (!modal.hasModal) throw new Error('点了「报修入口」但没有出现弹窗');
      out.push('点行内「报修入口」打开了弹窗（动作已挂上且可点）');
      if (modal.name !== target.name) {
        throw new Error(`弹窗里的门店名不是 ${target.name}（实际 ${JSON.stringify(modal.name)}）`);
      }
      out.push(`弹窗正确显示门店名「${modal.name}」`);
      if (modal.url !== target.url) {
        throw new Error(`弹窗里的链接与接口不一致（页面 ${modal.url} ≠ 接口 ${target.url}）`);
      }
      out.push('弹窗里的链接与接口返回逐字一致（页面没有自己拼链接）');
      if (modal.legacyUrl !== target.legacy_url || !modal.hasLegacyNote) {
        throw new Error('旧入口链接或"无防篡改保护"提示缺失');
      }
      out.push('旧入口链接与安全性差异提示（无签名保护）都在弹窗里如实给出');
      if (!modal.hasSvg) throw new Error('弹窗里没有渲染出二维码 SVG');
      if (!modal.hasDownload) throw new Error('弹窗里没有「下载二维码」按钮');
      if (!modal.hasCopy) throw new Error('弹窗里没有「复制」按钮');

      // 页面里的二维码必须与**服务端返回的那一段**在**几何上完全一致**：
      // 前端若自作主张重新生成/缩放/换纠错级别，就会出现
      // "看到的码与签名的那条链接不是一回事"。
      //
      // ⚠️ 比对的是**语义**，不是字符串：`svg.outerHTML` 会被浏览器**重新序列化**
      //    （属性顺序、引号、自闭合形态都可能变），拿它跟源码串比会得到
      //    "看起来不一致"的**假红**（首跑实测就是这条红的）。
      //    所以这里把服务端那一份**也交给浏览器解析**，两边用同一个解析器
      //    比 viewBox + 每条 path 的 stroke/d（决定像素的就是这两样）。
      //    ⇒ "同一段解析逻辑只有一份"这条纪律在验收器里同样适用。
      const svgCompare = await evaluateJson(
        '(() => {\n' +
          `  const expectedSrc = ${JSON.stringify(target.qr_svg)};\n` +
          '  const expected = new DOMParser().parseFromString(expectedSrc, "image/svg+xml").documentElement;\n' +
          '  const actual = document.querySelector(\'[data-testid="svc-store-entry-qr"] svg\');\n' +
          '  if (!actual) return JSON.stringify({ same: false, why: "页面里没有 svg" });\n' +
          '  const sig = (svg) => JSON.stringify({\n' +
          '    vb: svg.getAttribute("viewBox"),\n' +
          '    paths: [...svg.querySelectorAll("path")].map((p) => (p.getAttribute("stroke") || "") + "|" + (p.getAttribute("d") || "")),\n' +
          '  });\n' +
          '  return JSON.stringify({ same: sig(expected) === sig(actual), expected: sig(expected).length, actual: sig(actual).length });\n' +
          '})()',
      );
      if (!svgCompare.same) {
        throw new Error(
          `弹窗里渲染的二维码与服务端返回的几何不一致（前端可能自己重画了二维码；` +
            `长度 ${svgCompare.expected} vs ${svgCompare.actual}）`,
        );
      }
      out.push('弹窗里渲染的二维码与服务端返回的几何逐字一致（viewBox + 每条 path）');

      // ---------------- ⑤ 点「复制」 ----------------
      const copyRes = await evaluate(
        '(() => {\n' +
          '  const btn = document.querySelector(\'[data-testid="svc-store-entry-url-copy"]\');\n' +
          '  if (!btn) return "NOT_FOUND";\n' +
          '  btn.click();\n' +
          '  return "CLICKED";\n' +
          '})()',
      );
      if (copyRes !== 'CLICKED') throw new Error('「复制」按钮不可点');
      await sleep(1200);
      const copyLabel = await evaluate(
        '(() => { const b = document.querySelector(\'[data-testid="svc-store-entry-url-copy"]\'); return b ? b.innerText.replace(/\\s+/g, "") : null; })()',
      );
      // ⚠️ 文案要先**去掉空白再比**：antd 会给"两个汉字"的按钮自动插一个空格
      //    （实测按钮文字是「复 制」/「已 复 制」）—— 拿原始 innerText 直接比
      //    会得到一条**假红**，而且看起来像"按钮没变成已复制"。
      if (copyLabel !== '已复制') {
        throw new Error(`点了「复制」后按钮文案是 ${JSON.stringify(copyLabel)}（期望「已复制」）`);
      }
      // 🔴 更强的一层：把**系统剪贴板的内容读回来**，逐字比对。
      //    只断言"按钮变成了已复制"证明的是"自认成功"，而 req 1 要的是
      //    **链接真的进了剪贴板**。授予权限后这件事可以直接验。
      const clipboard = await evaluate(
        '(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return "ERR:" + (e && e.name); } })()',
        { awaitPromise: true },
      );
      if (clipboard !== target.url) {
        throw new Error(
          `剪贴板内容不是该门店的链接（实际 ${JSON.stringify(String(clipboard).slice(0, 120))}）`,
        );
      }
      out.push('点「复制」后**系统剪贴板里确实是该门店的链接**（回读比对逐字一致）');

      // ---------------- ⑥ 点「下载二维码」并解码下载结果 ----------------
      fs.rmSync(downloadsDir, { recursive: true, force: true });
      const dlRes = await evaluate(
        '(() => {\n' +
          '  const btn = document.querySelector(\'[data-testid="svc-store-entry-download"]\');\n' +
          '  if (!btn) return "NOT_FOUND";\n' +
          '  if (btn.disabled) return "DISABLED";\n' +
          '  btn.click();\n' +
          '  return "CLICKED";\n' +
          '})()',
      );
      if (dlRes !== 'CLICKED') throw new Error(`「下载二维码」按钮不可用（${dlRes}）`);
      let downloaded = null;
      const t3 = Date.now() + 20000;
      while (Date.now() < t3) {
        await sleep(800);
        if (!fs.existsSync(downloadsDir)) continue;
        // 跳过 Chrome 的临时下载文件（`.crdownload`）
        const names = fs.readdirSync(downloadsDir).filter((n) => !n.endsWith('.crdownload'));
        if (names.length > 0) {
          downloaded = path.join(downloadsDir, names[0]);
          break;
        }
      }
      if (!downloaded) throw new Error('点了「下载二维码」但下载目录里没有文件');
      const downloadedText = fs.readFileSync(downloaded, 'utf8');
      if (downloadedText !== target.qr_svg) {
        throw new Error(`下载下来的文件与服务端的二维码不一致（文件名 ${path.basename(downloaded)}）`);
      }
      out.push(`「下载二维码」产出 ${path.basename(downloaded)}（SVG，与服务端逐字一致）`);

      // 🔴 下载结果必须**再解一次码**：只断言"有文件"在下错内容时同样成立。
      //    这一步也顺带证明"下载到的是**这一家**门店的码"（解出的文本要等于它的 url）。
      //
      // ⚠️ jsQR 必须在**最后一次页面导航之后**注入：
      //    每次 `Page.navigate` 都会换掉 JS 上下文，之前注入的 `window.jsQR` 就没了。
      //    （首跑实测：下载与文件比对都过了，只在这一步报"jsQR 未注入" ——
      //      这也说明"注入一次就够"是错的。）
      await evaluate(jsqrInjectExpression());
      const decodedDownload = await evaluateJson(qrDecodeExpression(downloadedText, rasterSizeOf(downloadedText)), {
        awaitPromise: true,
      });
      if (decodedDownload.err) throw new Error(`下载文件解码失败：${decodedDownload.err}`);
      if (decodedDownload.text !== target.url) {
        throw new Error(`下载的二维码解出 ${JSON.stringify(decodedDownload.text)} ≠ ${target.url}`);
      }
      out.push('下载下来的二维码真实解码后等于该门店的链接（下载的不是空图 / 不是别家的码）');

      // ---------------- ⑦ 关闭弹窗后页面仍可用（× 在） ----------------
      const closeRes = await evaluate(
        '(() => {\n' +
          '  const x = document.querySelector(\'[data-testid="svc-store-entry-modal"]\') ? document.querySelector(".ant-modal-close") : null;\n' +
          '  const modalEl = document.querySelector(\'[data-testid="svc-store-entry-modal"]\');\n' +
          '  if (!modalEl) return "NO_MODAL";\n' +
          '  if (!x) return "NO_CLOSE";\n' +
          '  x.click();\n' +
          '  return "CLOSED";\n' +
          '})()',
      );
      if (closeRes !== 'CLOSED') throw new Error(`弹窗右上角关闭按钮不可用（${closeRes}）`);
      await sleep(1200);
      const after = await evaluateJson(
        'JSON.stringify({\n' +
          '  modal: !!document.querySelector(\'[data-testid="svc-store-entry-modal"]\'),\n' +
          '  masks: document.querySelectorAll(".ant-modal-mask").length,\n' +
          '  rows: document.querySelectorAll(".ant-table-tbody tr.ant-table-row").length,\n' +
          '})',
      );
      if (after.modal || after.masks !== 0) {
        throw new Error(`关闭后仍有残留（弹窗 ${after.modal} / 遮罩 ${after.masks}）`);
      }
      out.push(`关闭弹窗后无残留遮罩，页面仍可用（${after.rows} 行门店）`);

      void ctx;
      return out;
    },
    { downloadsDir, grantClipboardFor: new URL(BASE).origin },
  );

  return [...notes, ...result];
}

// ===========================================================================
// 客户 H5 真实浏览器走查（req 3 / req 5 的**客户端**那一半）
// ===========================================================================
/**
 * 这一段回答的是"客户看到什么"，而 §3 回答的是"服务端接受什么"。两者不能互推：
 *   · 服务端把归属收进入口，不等于**页面不再显示门店下拉**（req 3 明文要求不出现）；
 *   · `provenance=legacy` 从接口回得来，不等于**页面上真的写了那句提示**（req 5）。
 *
 * 🔴 最强的一条判据在这里：**点「确认提交」后，浏览器实际发出的建单请求
 *    URL 里必须带 `?k=<签名入口>`**。
 *    · 只看接口返回值证明不了页面把入口带上了（那是"我以为它会带"）；
 *    · 只看 DOM 也证明不了 —— DOM 里根本没有这个值。
 *    只有"浏览器真实发出的那一行 URL"能回答（DEV-18 / DEV-74 两次都栽在这上面）。
 */
async function verifyCustomerH5(items, signedItem, legacyItem) {
  const out = [];
  const h5Base = (envValue('PUBLIC_H5_BASE_URL') || envValue('PUBLIC_BASE_URL') || '').replace(/\/+$/, '');
  if (!h5Base) throw new EnvNotReady('对外基址为空，无法打开 H5');
  const signedUrl = `${h5Base}/h5/report?k=${encodeURIComponent(signedItem.entry)}`;

  return withChrome(async ({ ctx, evaluate, evaluateJson, requests }) => {
    const waitFor = async (expr, { timeout = 45000, poll = 1200, label = expr } = {}) => {
      const dl = Date.now() + timeout;
      while (Date.now() < dl) {
        const v = await evaluate(expr);
        if (v) return v;
        await sleep(poll);
      }
      throw new Error(`等待超时：${label}`);
    };

    // ---------------- ① 签名入口：进入即锁定门店 ----------------
    await ctx('Page.navigate', { url: signedUrl });
    await waitFor('document.querySelector(\'[data-testid="store-lock"]\') ? 1 : 0', {
      label: '门店锁定卡出现',
    });
    const dom = await evaluateJson(
      'JSON.stringify({\n' +
        '  name: (document.querySelector(\'[data-testid="store-name"]\') || {}).innerText || null,\n' +
        '  code: (document.querySelector(\'[data-testid="store-code"]\') || {}).innerText || null,\n' +
        '  selects: document.querySelectorAll("select").length,\n' +
        '  legacyNotice: !!document.querySelector(\'[data-testid="legacy-entry-notice"]\'),\n' +
        '  h1: (document.querySelector("h1") || {}).innerText || null,\n' +
        '  entryError: !!document.querySelector(\'[data-testid="entry-error"]\'),\n' +
        '})',
    );
    if (dom.name !== signedItem.name || dom.code !== signedItem.code) {
      throw new Error(`页面显示的门店不对（${JSON.stringify(dom.name)} / ${JSON.stringify(dom.code)}）`);
    }
    out.push(`客户扫码进入后**直接看到门店名「${dom.name}」**（req 3）`);

    // ⚠️ `select` 计数是 req 3「不出现门店选择器」的**唯一**客观判据：
    //    没有它，"下拉被去掉了"只能靠读代码相信。
    //    （本项目铁律：断言要落到**能观测到的东西**上，DOM 元素计数正是其中一种。）
    if (dom.selects !== 0) {
      throw new Error(`页面里还有 ${dom.selects} 个 <select> —— 门店选择器没有去掉（req 3）`);
    }
    out.push('页面里 **0 个 <select>**（门店选择器确实已移除，req 3）');

    if (dom.legacyNotice) {
      throw new Error('签名入口竟然显示了"旧入口无签名保护"的提示 —— 两种入口被混为一谈');
    }
    out.push('签名入口**不显示**旧入口提示（两种入口在界面上被如实区分）');

    // ---------------- ② 提交前确认门店 ----------------
    // 先不填内容直接点「提交报修」：应当被校验拦下（顺带证明表单校验是活的）
    await evaluate('document.querySelector(\'[data-testid="submit-open-confirm"]\').click(); document.title');
    await sleep(1200);
    const blocked = await evaluateJson(
      'JSON.stringify({\n' +
        '  confirm: !!document.querySelector(\'[data-testid="confirm-store-sheet"]\'),\n' +
        '  banner: (document.querySelector(\'[data-testid="submit-banner"]\') || {}).innerText || null,\n' +
        '})',
    );
    if (blocked.confirm) {
      throw new Error('表单没填就弹出了确认层 —— 校验顺序倒了（应当先校验、再确认）');
    }
    if (!blocked.banner || blocked.banner.indexOf('勾选') === -1) {
      throw new Error(`空表单提交的提示不符合预期：${JSON.stringify(blocked.banner)}`);
    }
    out.push('未勾选隐私即提交 → 被拦下且给出可行动提示（校验仍然有效）');

    // 填齐表单 + 勾选隐私 → 提交 → 应出现"确认报修门店"层
    const mobile = `139${String(Date.now()).slice(-8)}`;
    await evaluateJson(
      '(() => {\n' +
        '  const setVal = (el, val) => { const s = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set; s.call(el, val); el.dispatchEvent(new Event("input", { bubbles: true })); };\n' +
        '  setVal(document.getElementById("f-content"), "P11-1 客户 H5 走查：冰箱不制冷，压缩机一直响");\n' +
        '  setVal(document.getElementById("f-name"), "H5走查客户");\n' +
        `  setVal(document.getElementById("f-mobile"), ${JSON.stringify(mobile)});\n` +
        '  const cb = document.querySelector(\'input[type="checkbox"]\');\n' +
        '  if (!cb.checked) cb.click();\n' +
        '  return JSON.stringify({ content: document.getElementById("f-content").value.length, agreed: cb.checked });\n' +
        '})()',
    );
    await sleep(600);
    await evaluate('document.querySelector(\'[data-testid="submit-open-confirm"]\').click(); document.title');
    await sleep(1500);
    const confirmSheet = await evaluateJson(
      'JSON.stringify({\n' +
        '  open: !!document.querySelector(\'[data-testid="confirm-store-sheet"]\'),\n' +
        '  name: (document.querySelector(\'[data-testid="confirm-store-name"]\') || {}).innerText || null,\n' +
        '})',
    );
    if (!confirmSheet.open) throw new Error('填完表单点提交后没有出现「确认报修门店」层（req 3）');
    if (confirmSheet.name !== signedItem.name) {
      throw new Error(`确认层里的门店名不对（${JSON.stringify(confirmSheet.name)}）`);
    }
    out.push(`提交前弹出确认层并显示报修门店「${confirmSheet.name}」（req 3）`);

    // ---------------- ③ 确认提交 → 检查**真实发出的请求 URL** ----------------
    requests.length = 0;
    await evaluate('document.querySelector(\'[data-testid="submit-confirm"]\').click(); document.title');
    let sendReq = null;
    {
      const dl = Date.now() + 30000;
      while (Date.now() < dl) {
        await sleep(800);
        sendReq = requests.find((r) => r.url.includes('/api/public/tickets'));
        if (sendReq) break;
      }
    }
    if (!sendReq) {
      throw new Error(
        `点「确认提交」后浏览器没有发出 /api/public/tickets 请求（捕获到的请求：` +
          `${requests.filter((r) => r.url).length} 个）`,
      );
    }
    if (!sendReq.url.includes(`k=${encodeURIComponent(signedItem.entry)}`)) {
      throw new Error(
        `建单请求 URL 里没有带上签名入口 —— 实际发出的地址是 ${sendReq.url}\n` +
          '（这正是 P11-1 要修的东西：门店归属必须由入口决定）',
      );
    }
    out.push('点「确认提交」后**浏览器真实发出的建单 URL 带 `?k=<签名入口>`**（req 2/4 的客户端落点）');

    // 收拾掉这一单（走查自建，自删）
    const ticketNo = await evaluate(
      '(async () => {\n' +
        '  const el = document.querySelector(".svc-ticketno .svc-v");\n' +
        '  if (el) return el.innerText.trim();\n' +
        '  return location.search.indexOf("no=") !== -1 ? new URLSearchParams(location.search).get("no") : null;\n' +
        '})()',
      { awaitPromise: true },
    );
    if (ticketNo) {
      const row = psqlRows(
        `SELECT id FROM service_tickets WHERE ticket_no = '${String(ticketNo).replace(/'/g, "''")}'`,
      )[0];
      if (row) {
        cleanupTicket(Number(row[0]));
        out.push(`H5 走查自建的工单一并清理（${ticketNo}）`);
      }
    }

    // ---------------- ④ 旧入口（旧二维码）：必须如实提示无签名保护 ----------------
    await ctx('Page.navigate', { url: `${h5Base}/h5/report?k=${legacyItem.code}` });
    await waitFor('document.querySelector(\'[data-testid="legacy-entry-notice"]\') ? 1 : 0', {
      label: '旧入口提示出现',
    });
    const legacyDom = await evaluateJson(
      'JSON.stringify({\n' +
        '  name: (document.querySelector(\'[data-testid="store-name"]\') || {}).innerText || null,\n' +
        '  selects: document.querySelectorAll("select").length,\n' +
        '  notice: (document.querySelector(\'[data-testid="legacy-entry-notice"]\') || {}).innerText || null,\n' +
        '})',
    );
    if (legacyDom.name !== legacyItem.name) {
      throw new Error(`旧入口显示的门店不对（${JSON.stringify(legacyDom.name)}）`);
    }
    if (legacyDom.selects !== 0) throw new Error('旧入口页面上仍出现了 <select>');
    // 提示文案必须**说出来**"不具备防篡改保护" —— 只是"有个提示框"不够（req 5）。
    if (!legacyDom.notice || legacyDom.notice.indexOf('防篡改') === -1) {
      throw new Error(`旧入口提示没有说明安全性差异：${JSON.stringify(legacyDom.notice)}`);
    }
    out.push('旧二维码入口（`?store=S…`）仍可打开、显示正确门店，并**明确提示不具备防篡改保护**（req 5）');

    // ---------------- ⑤ 被篡改的入口：页面直接判不可用，且**不退化出门店选择器** ----------------
    const broken = `S02.${signedItem.entry.split('.')[1]}`;
    await ctx('Page.navigate', { url: `${h5Base}/h5/report?k=${encodeURIComponent(broken)}` });
    await waitFor('document.querySelector(\'[data-testid="entry-error"]\') ? 1 : 0', {
      label: '入口无效态出现',
    });
    const brokenDom = await evaluateJson(
      'JSON.stringify({\n' +
        '  selects: document.querySelectorAll("select").length,\n' +
        '  msg: (document.querySelector(\'[data-testid="entry-error-message"]\') || {}).innerText || null,\n' +
        '  submitBtn: !!document.querySelector(\'[data-testid="submit-open-confirm"]\'),\n' +
        '})',
    );
    if (brokenDom.selects !== 0) {
      throw new Error('入口失效时页面**退化出了门店选择器** —— 归属权又被交回给客户（req 3）');
    }
    if (brokenDom.submitBtn) throw new Error('入口失效时仍然能提交');
    out.push(
      `篡改后的入口 → 页面直接判不可用（${JSON.stringify(String(brokenDom.msg).slice(0, 40))}…），` +
        '且**没有**退化成门店选择器',
    );

    void items;
    return out;
  });
}

// ===========================================================================
// 入口
// ===========================================================================
if (SELFTEST_ONLY) {
  const code = runSelftest();
  process.exit(code);
}

// ⚠️ `runMain` 自己会在"环境未就绪"时 `process.exit(2)`（它刻意把这条路径收在一处，
//    且在退出前先跑 cleanup）。所以走到下面的代码 ⇒ 环境是就绪的，
//    这里的退出码只表达"断言层面"的结果。
await runMain({
  name: 'P11-1 门店独立报修入口验收（verify-store-entry）',
  main,
  cleanup: undefined,
});

console.log(`\n=== 汇总：通过 ${state.passed} 项 / 未达标 ${state.failures.length} 项 ===`);
for (const f of state.failures) console.log(`  ✗ ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`);
process.exit(state.failures.length ? 1 : 0);
