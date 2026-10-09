/**
 * base-url.mjs —— 「门禁/脚本该用哪个协议与端口访问本实例」的**单一事实来源**
 * （Phase 10 / P10-C）
 *
 * ===========================================================================
 * 为什么需要它：HTTP 不再直出业务之后，所有脚本的默认入口都变了
 * ===========================================================================
 * P10-C 起，80 段只做三件事：`/healthz`、ACME 校验路径、其余一律 301 到 HTTPS。
 * 换句话说 **HTTP 上再也拿不到业务数据** —— 这是发布要求之一（"HTTP 无业务直出"）。
 *
 * 于是所有打本实例的脚本（smoke / verify-* / walkthrough / uat-*）都必须改走 HTTPS。
 * 若各脚本各自硬编码 `http://localhost:${PORT}`，就会产生 15 份会各自漂移的实现
 * —— 那种状态下"某支脚本还走 HTTP"只能靠人去记得，而它**不会报错**：
 * 只会拿到一个 301，然后被当成"接口返回异常"去排障（本项目的经典误导形态）。
 * ⇒ 收敛到本文件：协议与端口**只在这里判定一次**。
 *
 * ===========================================================================
 * 取值来源（按优先级）
 * ===========================================================================
 *   协议：`SVC_BASE_SCHEME`（缺省 `https`）
 *   端口：https 时 `NGINX_HTTPS_PORT`（缺省 8443）；http 时 `NGINX_HTTP_PORT`（缺省 8080）
 *
 * ⚠️ 缺省**必须**是 https：HTTP 已经不再提供业务，把缺省写成 http 会让"忘了配"表现成
 *    "脚本还能跑"（其实是拿到了 301），而那正是最难归因的一种假绿。
 *
 * ===========================================================================
 * 🔴 `SVC_TLS_INSECURE`：**只因为演练证书是自签的**，不是"跳过校验"
 * ===========================================================================
 * 本阶段挂载的是自签演练证书，系统 CA 自然不认 ⇒ Node 默认会拒绝握手。
 * 于是这里允许 `SVC_TLS_INSECURE=1` 关掉**默认**校验，但同时做两件事防止它变成
 * "什么都验不了"：
 *   ① 打一行显式提示（每次运行都看得见，不会被忘掉）；
 *   ② `scripts/verify-tls.mjs` 会用**独立的一条**断言把证书指纹与 SAN 钉死 ——
 *      即"不信任 CA 链"不等于"不校验对端是谁"。
 *
 * 正式域名 + 受信 CA 到位后把 `SVC_TLS_INSECURE` 去掉（或设 0），
 * 那时默认校验就是真的在验公网信任链。**这一步属于 TLS production release gate。**
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/** 读 .env（轻量解析；与各脚本内既有 envValue 同语义，只是收敛到一处） */
function readDotEnv() {
  const out = {};
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  } catch {
    /* .env 不存在时退化为纯 process.env */
  }
  return out;
}

const DOTENV = readDotEnv();

function pick(key, fallback) {
  const fromProcess = process.env[key];
  if (fromProcess !== undefined && String(fromProcess).trim() !== '') return String(fromProcess).trim();
  const fromFile = DOTENV[key];
  if (fromFile !== undefined && String(fromFile).trim() !== '') return String(fromFile).trim();
  return fallback;
}

/** 协议：`https` | `http`。缺省 https（理由见文件头） */
export const SVC_SCHEME = (() => {
  const raw = pick('SVC_BASE_SCHEME', 'https').toLowerCase();
  if (raw !== 'http' && raw !== 'https') {
    throw new Error(`[base-url] SVC_BASE_SCHEME=${JSON.stringify(raw)} 非法（只允许 http | https）`);
  }
  return raw;
})();

/** 与协议匹配的端口 */
export const SVC_BASE_URL_PORT = Number(
  SVC_SCHEME === 'https' ? pick('NGINX_HTTPS_PORT', '8443') : pick('NGINX_HTTP_PORT', '8080'),
);

if (!Number.isInteger(SVC_BASE_URL_PORT) || SVC_BASE_URL_PORT <= 0 || SVC_BASE_URL_PORT > 65535) {
  throw new Error(`[base-url] 端口不合法：${SVC_BASE_URL_PORT}（协议 ${SVC_SCHEME}）`);
}

/** HTTPS 端口（无论当前协议是什么，TLS 门禁都要知道它） */
export const SVC_HTTPS_PORT = Number(pick('NGINX_HTTPS_PORT', '8443'));
/** HTTP 端口（用于验证 80→443 跳转） */
export const SVC_HTTP_PORT = Number(pick('NGINX_HTTP_PORT', '8080'));

/** 是否处于"自签演练"模式（关掉 Node 默认 CA 校验，但见文件头的两条约束） */
export const SVC_TLS_INSECURE = pick('SVC_TLS_INSECURE', '') === '1';

if (SVC_SCHEME === 'https' && SVC_TLS_INSECURE && !process.env.SVC_TLS_INSECURE_NOTICE_SHOWN) {
  process.env.SVC_TLS_INSECURE_NOTICE_SHOWN = '1';
  // eslint-disable-next-line no-console
  console.log(
    '  ⚠️ SVC_TLS_INSECURE=1：本实例挂载的是**自签演练证书**，Node 默认 CA 校验已关闭。\n' +
      '     这不等于"不校验对端"——证书指纹与 SAN 由 scripts/verify-tls.mjs 独立钉住。\n' +
      '     正式域名 + 受信 CA 到位后须去掉该开关（属 TLS production release gate）。',
  );
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/** 本实例的基址（协议 + 主机 + 端口），末尾无斜杠 */
export const SVC_BASE_URL = `${SVC_SCHEME}://localhost:${SVC_BASE_URL_PORT}`;

/** 显式构造某个协议下的基址（TLS 门禁要同时打 http 与 https） */
export function baseUrlFor(scheme, host = 'localhost') {
  const port = scheme === 'https' ? SVC_HTTPS_PORT : SVC_HTTP_PORT;
  return `${scheme}://${host}:${port}`;
}

/** 读证书文件路径（TLS 门禁用来算指纹；**只读公钥部分**，不碰私钥） */
export function certPath() {
  return path.join(ROOT, 'storage', 'certs', 'tls.crt');
}
