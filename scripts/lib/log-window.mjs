/**
 * log-window.mjs —— 门禁的**日志 watermark**（Phase 11 / P11-0）
 *
 * ===========================================================================
 * 它替代的是什么（以及为什么那个做法不允许固化）
 * ===========================================================================
 * 背景：`smoke-test.mjs` 的「无 error 级别输出」断言原本按
 *   「应用就绪之后」切窗口 —— 而"就绪"是从**容器健康日志**推出来的时间点。
 * 于是任何**在 smoke 之前跑过、且故意触发 4xx/5xx 的探针**都会落进这个窗口，
 * 把断言打红（实测：`probe-native-read-deps.mjs` 故意请求被拒资源 ⇒ +2 条 error）。
 *
 * 当时的临时处置是「跑完探针 → `docker compose restart app` → 再跑 smoke」。
 * 🔴 **那不能作为正式方案**：
 *   · 它把"断言是否变绿"绑在**执行顺序**上，而顺序靠人记得 —— 忘一次就红一次，
 *     而红的原因与被测产品**毫无关系**；
 *   · 它让门禁依赖 `restart` 这个副作用动作（重启还会撞 DEV-50 的就绪竞态）；
 *   · 它掩盖了一个更正确的问题：**一支门禁本来就不该去审计别人产生的日志**。
 *
 * ⇒ 正确形态是 **watermark（水位线）**：每支门禁在**自己开始时**记一个时间戳，
 *   只审计该时间戳之后的日志。这样：
 *   · 不依赖 restart、不依赖执行顺序；
 *   · **不需要给错误断言加任何豁免**（严守契约 §0.2「不允许为了全绿扩大豁免名单」）；
 *   · 每支门禁的结论只由**它自己触发的那段行为**决定。
 *
 * ⚠️ 代价（如实记录）：smoke 的 error 断言因此从"应用就绪以来"收窄为"本次运行期间"。
 *   "启动期之后、smoke 之前"那段窗口不再被它覆盖 —— 那部分由各专属门禁承担
 *   （`verify-log-redaction` 审计脱敏、`probe-store-ui-native-reads` 审计浏览器侧
 *   零 429/零控制台错误、`verify-sms-receipt` 等）。宁可各自把话说清楚，
 *   也不要一个"看起来更全、实际靠顺序才绿"的窗口。
 *
 * 用法：
 *   import { openLogWindow, appLogsSince, entriesSince } from './lib/log-window.mjs';
 *   const win = openLogWindow();               // 门禁开始处
 *   ...
 *   const logs = appLogsSince(win);            // 只拿本门禁开始之后的日志
 */
import { execFileSync } from 'node:child_process';

const APP_CONTAINER = 'svc-app';

/**
 * 开一个窗口。返回 ISO 时间戳（UTC），供 `docker logs --since` 使用。
 *
 * ⚠️ 刻意**先 sleep 1 秒再取时间**吗？不 —— 反了：要在门禁做任何请求**之前**取，
 *    否则"开窗口"这一瞬间发出的请求会被漏掉。所以取的是**当下**，
 *    并由调用方保证它是第一件事。
 */
export function openLogWindow(at = new Date()) {
  return at.toISOString();
}

/** 只取本窗口之后的 app 日志（用 Docker 引擎自己的 `--since` 过滤，不靠解析） */
export function appLogsSince(since, { container = APP_CONTAINER } = {}) {
  return execFileSync('docker', ['logs', container, '--since', since], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * 从日志文本里挑出（并在需要时解析）JSON 行。
 *
 * ⚠️ 为什么必须按行解析而不是 `JSON.parse(整个输出)`：`docker logs` 会把 stdout/stderr
 *    混在一起，且非 JSON 行（例如 nginx 式告警、框架的裸输出）随时可能出现。
 *    逐行 try/parse 是唯一稳的读法。
 */
export function entriesSince(since, { container = APP_CONTAINER, filter = null } = {}) {
  const text = appLogsSince(since, { container });
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let j;
    try {
      j = JSON.parse(s);
    } catch {
      continue;
    }
    if (filter && !filter(j)) continue;
    out.push(j);
  }
  return out;
}

/** 便捷：本窗口内 error 级条目 */
export function errorEntriesSince(since, opts = {}) {
  return entriesSince(since, { ...opts, filter: (j) => j?.level === 'error' });
}
