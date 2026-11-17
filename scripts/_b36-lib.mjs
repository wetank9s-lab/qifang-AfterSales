/**
 * _b36-lib.mjs —— B-36 验证脚本的**共享底座**（被 e2e 与 mutation 两个脚本使用）
 *
 * 为什么抽出来（`docs/ENGINEERING-RULES.md` 铁律 ④：同一段逻辑出现两次 = 同一个坑有两条腿）：
 *   下面这几件事**本来就是同一件事**，写在两个脚本里必然漂移：
 *     · 用**产品自己**的 `signStoreEntry` 签入口（绝不在这里抄第二遍 HMAC）
 *     · 定位 esbuild（本机在隔离 workspace，不在仓库内）
 *     · 读 `.env` / 跑 psql / 清 Banner 行与文件
 *     · 两道限流闸的"临时调大 + 跑完还原"
 *
 *   一旦分叉，症状是"一个脚本绿、一个脚本红"，而两个脚本测的是同一个产品。
 *
 * 本文件**不带 `.test`/`verify-` 前缀**，因为它不是门禁，是工具。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

export const ROOT = process.cwd();
export const FIX = path.resolve('.tmp-media/b36-fixtures');
export const BANNER_DIR = path.resolve('storage/uploads-banner');
/** 直连应用（不经 nginx）—— 用来把"应用自己的守卫"与"nginx 的守卫"分开证 */
export const APP_DIRECT = 'http://127.0.0.1:13000';
/** 与 `scripts/build-plugin.mjs` 同一套：esbuild 装在这里，不在仓库内 */
const NODE_WORKSPACE = 'C:/Users/Administrator/.workbuddy/binaries/node/workspace';
const SERVICE_CONF = path.join(ROOT, 'nginx/conf.d/service.conf');

const require_ = createRequire(import.meta.url);

/** 读 `.env`（不做 shell 展开，取原值） */
export function readEnv() {
  const env = {};
  for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** 定位 esbuild —— 与 `scripts/build-plugin.mjs` 同一套三级 fallback */
export function loadEsbuild() {
  for (const p of [
    () => require_('esbuild'),
    () => require_(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild')),
    () => require_(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild', 'lib', 'main.js')),
  ]) {
    try {
      const mod = p();
      if (mod && typeof mod.build === 'function') return mod;
    } catch { /* 试下一个 */ }
  }
  throw new Error('找不到 esbuild（试过：仓库内 / 隔离 workspace 两个位置）');
}

/**
 * 加载**产品自己**的 `signStoreEntry`。
 *
 * 🔴 为什么不在这里重写一遍 HMAC：本仓库为"同一段逻辑两份实现"付过多次代价。
 *    签名一旦分叉（哪怕只是 `update()` 里少个前缀），表现是"脚本说入口合法、
 *    服务端说非法"——而两边看起来都对。**唯一**的签名实现只能在产品里。
 */
export function loadSignStoreEntry() {
  const esbuild = loadEsbuild();
  const abs = path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/services/store-entry.ts');
  const result = esbuild.buildSync({
    entryPoints: [abs], bundle: true, write: false, platform: 'node', format: 'cjs',
    target: 'node20', logLevel: 'silent', external: ['@nocobase/*', 'knex', 'sequelize'],
  });
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require_);
  return module.exports.signStoreEntry;
}

// ---------------------------------------------------------------------------
// 数据库 / 文件
// ---------------------------------------------------------------------------
export function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket',
     '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8' },
  ).trim();
}

/** SQL 字面量转义（本脚本只拼自己造的字符串，但仍按纪律处理引号） */
export function sqlStr(v) {
  if (v === null || v === undefined) return 'null';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * 清掉指定门店（含 `null` = 总部通用）的全部 Banner 行与文件。
 *
 * ⚠️ 清理类动作必须**独立再查**（DEV-61：`exit code 0 ≠ 业务动作发生了`），
 *    所以返回值是"复核后的剩余行数是否为 0"，而不是"没抛错就算成功"。
 */
export function purgeBanners(storeIds, label = '') {
  const where = storeIds.length
    ? `where store_id in (${storeIds.join(',')}) or store_id is null`
    : 'where true';
  const files = psql(`select file_name from store_banners ${where};`)
    .split('\n').map((s) => s.trim()).filter(Boolean);
  psql(`delete from store_banners ${where};`);
  for (const f of files) {
    const p = path.join(BANNER_DIR, f);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* 忽略 */ }
  }
  const left = Number(psql(`select count(*) from store_banners ${where};`) || '0');
  if (label) console.log(`  · [${label}] 清掉 ${files.length} 行 / 文件，复核剩余 ${left} 行`);
  return left === 0;
}

/**
 * **直插**一行 Banner（绕过产品的写入路径）。
 *
 * 🔴 为什么必须直插，而不是调接口造数据（这条是本轮最重要的认识）：
 *
 *   `revokeBanner()` 会**同时**改两处：`status → REVOKED` 和 `revoked_at = now()`。
 *   于是"`status='PUBLISHED'` 且 `revoked_at` 有值"这种行，**正常业务流程永远产不出来**。
 *
 *   后果是：如果只在源码里摘掉 `revoked_at: null` 这一个条件，
 *   走正常流程的验证**看不到任何差异**（那些行早就被 `status` 挡在外面了）
 *   ⇒ 摘掉一个真实存在的过滤条件，测试却全绿。
 *
 *   ⇒ 验证"某一列的条件真的在生效"，必须**先构造出只有该列能拦住的数据**。
 *      这不是"造脏数据测试"，而是**让那条分支可观测**的唯一途径。
 *
 * ⚠️ `created_at` / `updated_at` 是 NocoBase 给每张表的通用列，**NOT NULL 且无 DB default**
 *    （由 ORM 层写入）⇒ 直插必须自己补，否则报 `null value in column "created_at"`。
 */
export function insertBannerRow(opts) {
  const {
    storeId = null, fileName, contentHash, mime = 'image/png', w = 1280, h = 360,
    status, enabled = true, publishedAt = null, revokedAt = null, tag,
    requestId = null,
  } = opts;
  const req = requestId ?? `probe-${tag}`;
  const sql = `insert into store_banners
    (store_id, file_name, storage_key, mime, byte_size, width, height, content_hash,
     status, enabled, alt_text, uploaded_at, published_at, revoked_at, request_id,
     created_at, updated_at)
  values (${storeId === null ? 'null' : storeId}, ${sqlStr(fileName)}, ${sqlStr('probe/' + fileName)},
     ${sqlStr(mime)}, 4096, ${w}, ${h}, ${sqlStr(contentHash)}, ${sqlStr(status)}, ${enabled},
     ${sqlStr(tag)}, now(), ${publishedAt ? sqlStr(publishedAt) : 'null'},
     ${revokedAt ? sqlStr(revokedAt) : 'null'}, ${sqlStr(req)}, now(), now())
  returning id;`;
  return Number(psql(sql));
}

/** 把图片字节真正写进公开目录（让"被选中"时 URL 可达，避免把 404 误读成"没选中"） */
export function writeBannerFile(fileName, buf) {
  const dir = path.resolve('storage/uploads-banner');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), buf);
}

/** 按 `request_id` 前缀精确删除直插的行（绝不动别人的行），并**独立复核** */
export function purgeRowsByRequestId(prefix) {
  const files = psql(`select file_name from store_banners where request_id like ${sqlStr(prefix + '%')};`)
    .split('\n').map((s) => s.trim()).filter(Boolean);
  psql(`delete from store_banners where request_id like ${sqlStr(prefix + '%')};`);
  for (const f of files) {
    try { fs.unlinkSync(path.join(BANNER_DIR, f)); } catch { /* 忽略 */ }
  }
  const left = Number(psql(`select count(*) from store_banners where request_id like ${sqlStr(prefix + '%')};`) || '0');
  return { removed: files.length, left, ok: left === 0 };
}

// ---------------------------------------------------------------------------
// 限流：两道独立的闸，跑前临时调大、跑完还原
// ---------------------------------------------------------------------------
export const GATE_NGINX_BURST = '2000';
export const GATE_APP_IP_LIMIT = '3000';
/** 应用侧 `ConfigService` 有 TTL 缓存（10s）⇒ 改库后必须等它过期，否则读到旧值 */
export const CONFIG_TTL_WAIT_MS = 11_500;

/**
 * 创建一对"调大 / 还原"函数，并自动挂 `process.on('exit')` 兜底。
 *
 * ⚠️ 只放宽 **burst（突发容量）**，**绝不放宽 `rate`** —— 那是给真实客户承诺的额度。
 *    这是 `verify-store-entry.mjs` 立下的约定，照抄而不是自创。
 */
export function createRateLimitGate() {
  const originalConf = fs.existsSync(SERVICE_CONF) ? fs.readFileSync(SERVICE_CONF, 'utf8') : null;
  let nginxRaised = false;
  let appRaised = false;
  /** 撞到限流 ⇒ 判"环境未就绪"，不给产品结论 */
  const state = { sawRateLimit: false };

  const reload = () => {
    try {
      execFileSync('docker', ['compose', 'exec', '-T', 'nginx', 'nginx', '-s', 'reload'],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      console.log(`  · nginx reload 失败：${e.message}`);
    }
  };

  function raise() {
    if (originalConf) {
      const patched = originalConf.replace(/(limit_req zone=svc_public burst=)\d+/, `$1${GATE_NGINX_BURST}`);
      if (patched !== originalConf) {
        try {
          fs.writeFileSync(SERVICE_CONF, patched);
          reload();
          nginxRaised = true;
        } catch (e) {
          console.log(`  · nginx burst 临时调大失败（可能会看到 429）：${e.message}`);
          restore();
        }
      }
    }
    try {
      psql(`update service_settings set value='${GATE_APP_IP_LIMIT}', updated_at=now() where key='security.ip_minute_limit';`);
      appRaised = true;
    } catch (e) {
      console.log(`  · 应用层限额临时调大失败（可能会看到 429）：${e.message}`);
    }
  }

  function restore() {
    if (originalConf && nginxRaised) {
      try {
        if (fs.readFileSync(SERVICE_CONF, 'utf8') !== originalConf) {
          fs.writeFileSync(SERVICE_CONF, originalConf);
          reload();
        }
        nginxRaised = false;
      } catch (e) {
        console.error(`  ⚠️ 还原 nginx 配置失败，请手工检查 ${SERVICE_CONF}：${e.message}`);
      }
    }
    if (appRaised) {
      try {
        psql(`update service_settings set value='30', updated_at=now() where key='security.ip_minute_limit';`);
        appRaised = false;
      } catch (e) {
        console.error(`  ⚠️ 还原 security.ip_minute_limit 失败，请手工检查：${e.message}`);
      }
    }
  }

  process.on('exit', restore);
  process.on('SIGINT', () => { restore(); process.exit(2); });

  /**
   * 记一次限流命中。
   *
   * 为什么必须单独拎出来：被限流时**每一条断言都拿到 429**，
   * 于是"篡改入口没被拒绝""私有附件被读走了"这类最吓人的标签会一起亮 ——
   * 看起来像产品全线崩溃，实际是刚才那支脚本把这一分钟的额度用完了。
   */
  function note(status, body = '') {
    const text = String(body ?? '');
    if (status === 429 || text.includes('TOO_MANY_REQUESTS') || text.includes('RATE_LIMITED')) {
      state.sawRateLimit = true;
      return true;
    }
    return false;
  }

  return { raise, restore, note, state };
}

// ---------------------------------------------------------------------------
// HTTP（与客户端同一条路）
// ---------------------------------------------------------------------------
export const uuid = () => crypto.randomUUID();

export async function signIn(base, account, password) {
  const res = await fetch(`${base}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  const j = await res.json().catch(() => null);
  if (!j?.data?.token) throw new Error(`登录失败 ${account}: HTTP ${res.status} ${res.statusText}`);
  return j.data.token;
}

export function makeApi(base, note) {
  return async function api(token, p, opt = {}) {
    const res = await fetch(base + p, {
      method: opt.method || 'GET',
      headers: {
        ...(opt.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opt.headers || {}),
      },
      ...(opt.json !== undefined ? { body: JSON.stringify(opt.json) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 二进制或非 JSON */ }
    note(res.status, text);
    return { status: res.status, json, text, headers: res.headers };
  };
}

/** 从公开 URL 里取出内容指纹（`/api/public/banner/banner-<16hex>.png` → `<16hex>`） */
export function fingerprintOf(banner) {
  const m = /banner-([0-9a-f]{16})\.(jpg|png|webp)$/.exec(String(banner?.url ?? ''));
  return m ? m[1] : null;
}

export function sha16(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}
