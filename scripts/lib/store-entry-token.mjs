/**
 * store-entry-token.mjs —— 门禁/脚本取得**门店签名入口**的唯一来源
 * =============================================================================
 *
 * 为什么需要它（P11-1 的连带影响）
 * -----------------------------------------------------------------------------
 * `POST /api/public/tickets` 从 P11-1 起**必须带门店入口**（`?k=<入口>`）：
 * 门店归属由入口决定，缺了它服务端回 `MISSING_STORE_ENTRY`。
 * 于是全仓 10 个"用匿名接口建单"的门禁脚本**全都会红** —— 而它们红的原因
 * 会是"入口没传"，与它们各自要验的业务毫无关系。
 *
 * 收敛到本文件，而不是在每个脚本里各写一份：
 *   · 一份 = 只有一个地方要跟着产品改（铁律 ④：同一段逻辑出现两次 = 同一个坑两条腿）；
 *   · 而且**签名算法不抄第二份** —— 见下面那段。
 *
 * ===========================================================================
 * 🔴 签名值由**产品自己的实现**算出来，不是脚本里重写一遍 HMAC
 * ===========================================================================
 * 做法与 `verify-store-tab-filter.mjs` 取 `toRequestFilter()` /
 * `TICKET_STATUS_LABEL` 完全同构：用 esbuild 把
 * `src/server/services/store-entry.ts` 编译成 CJS 再 require。
 *
 * 为什么不"顺手写个 6 行的 HMAC"：
 *   脚本里重写的签名若与产品漂移（改了 HMAC 消息前缀、改了截断长度），
 *   结果是**门禁全红**（服务端拒绝）——那是可以接受的；
 *   真正危险的是反向：脚本自己算的"入口"被服务端接受，
 *   而**产品页面产出的入口**却因为另一条代码路径不一样而失效。
 *   那时门禁全绿、真实门店扫不开码。⇒ 只用产品实现，不给漂移留位置。
 *
 * ===========================================================================
 * 为什么不去调 `/api/svc/store-entry` 拿
 * ===========================================================================
 *   · 那条路要**管理员会话**，而 `verify-concurrency-phase2.mjs` 这类脚本
 *     刻意只做匿名客户端 —— 给它加一个登录依赖，是把"匿名路径纯度"弄脏；
 *   · 匿名入口是 30r/m 的共享桶，每支脚本多打一次就是在挤自己后面的额度
 *     （本项目已因 429 反复把"环境未就绪"误报成"产品坏了"）。
 *
 * ⚠️ 代价：本文件算出的入口**假定**容器内的 `SIGN_SECRET` 与 `.env` 一致。
 *    这个假定**不是被默认的**：`scripts/verify-store-entry.mjs` 有一 条独立断言
 *    （"本地算出的入口，服务端必须接受"），一旦不一致它先红。
 *
 * ⚠️ 密钥缺失时**直接抛错**（不是回一个空串让调用方去撞 422）：
 *    那会把一次"配置缺失"伪装成"建单接口坏了"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, '.tmp-verify');
const NODE_WORKSPACE = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.workbuddy',
  'binaries',
  'node',
  'workspace',
);

/** 环境未就绪（配置缺失 / 依赖缺失），调用方应据此走 exit 2 */
export class StoreEntryEnvNotReady extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreEntryEnvNotReady';
    this.envNotReady = true;
  }
}

function envValue(key, fallback = '') {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : fallback;
  } catch {
    return fallback;
  }
}

/** 用 esbuild 把**产品的** store-entry 模块编成 CJS 再 require（见文件头） */
let signer = null;
function realSignStoreEntry() {
  if (signer) return signer;
  let esbuild = null;
  const req = createRequire(import.meta.url);
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
  if (!esbuild) {
    throw new StoreEntryEnvNotReady('找不到 esbuild —— 无法加载产品的 store-entry 实现');
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const src = path
    .join(ROOT, 'nocobase', 'plugins', 'service-ticket', 'src', 'server', 'services', 'store-entry')
    .replace(/\\/g, '/');
  const entry = path.join(OUT_DIR, 'store-entry-entry.ts');
  const outfile = path.join(OUT_DIR, 'store-entry.cjs');
  fs.writeFileSync(entry, `export * from '${src}';\n`, 'utf8');
  esbuild.buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    // 不静音：编译告警是"接口改了"的早期信号
    logLevel: 'warning',
  });
  const mod = req(outfile);
  if (typeof mod.signStoreEntry !== 'function') {
    throw new StoreEntryEnvNotReady('产品的 store-entry 模块没有导出 signStoreEntry');
  }
  signer = mod.signStoreEntry;
  return signer;
}

/** 进程内的入口缓存：同一门店在一支脚本里只算一次 */
const cache = new Map();

/** `SIGN_SECRET`（容器与 `.env` 必须一致，该假定由 verify-store-entry.mjs 独立断言） */
export function signSecret() {
  const secret = envValue('SIGN_SECRET');
  if (!secret) {
    throw new StoreEntryEnvNotReady(
      '.env 缺 SIGN_SECRET —— 门店入口无法签名（P11-1 起匿名建单必须带入口）',
    );
  }
  return secret;
}

/** 门店编码 → 签名入口值（形如 `S01.<22 位 base64url>`） */
export function storeEntryToken(code) {
  const key = String(code ?? '').trim();
  if (!key) throw new StoreEntryEnvNotReady('storeEntryToken 收到空门店编码');
  if (cache.has(key)) return cache.get(key);
  let token;
  try {
    token = realSignStoreEntry()(key, signSecret());
  } catch (error) {
    if (error instanceof StoreEntryEnvNotReady) throw error;
    throw new StoreEntryEnvNotReady(`签名门店入口失败（门店 ${key}）：${error.message}`);
  }
  cache.set(key, token);
  return token;
}

/**
 * 拼成可直接接到 `/api/public/tickets` 后面的 query 串。
 *
 * ⚠️ 返回的是 `?k=…`（**带问号**）—— 调用方直接 `${url}${storeEntryQuery(code)}`。
 *    不返回裸值，是为了让"忘了加 `?k=`"在形状上不可能发生。
 */
export function storeEntryQuery(code) {
  return `?k=${encodeURIComponent(storeEntryToken(code))}`;
}
