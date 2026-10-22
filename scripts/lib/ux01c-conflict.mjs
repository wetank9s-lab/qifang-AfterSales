/**
 * ux01c-conflict.mjs —— 并发写入 409 的**真并发**取证（UX-01C 第五轮 §四）
 *
 * 为什么必须真并发：`expected_value` 的判定是"先读后判"，两个请求串行执行时永远
 * 只有一个通过、另一个读到新值 —— 那验不出**丢失更新**。只有同时发出，才能证明
 * 服务端用的是 `UPDATE ... WHERE key=? AND value=<旧值>` 的条件更新（影响行数 0 ⇒ 409），
 * 而不是"两个都判过、后者覆盖前者"。
 *
 * ⚠️ 两个请求**各自带自己的 X-Request-Id**：若共用一个 id，服务端会按幂等回放，
 *    第二个根本不会真正执行 —— 那样 409 永远测不出来（假绿）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

function envValue(key, fallback = '') {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* 落到 process.env */
  }
  return process.env[key] ?? fallback;
}

function baseUrl() {
  const scheme = envValue('SVC_BASE_SCHEME', 'https');
  const port = envValue(scheme === 'https' ? 'NGINX_HTTPS_PORT' : 'NGINX_HTTP_PORT', scheme === 'https' ? '443' : '8080');
  return `${scheme}://localhost:${port}`;
}

function uuid() {
  return globalThis.crypto.randomUUID();
}

export async function loginHqAdmin() {
  const BASE = baseUrl();
  const ORIGIN = new URL(BASE).origin;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const r = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({
      email: envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'),
      password: envValue('UAT_HQADMIN_PASSWORD'),
    }),
  });
  if (r.status !== 200) throw new Error(`hq_admin 登录失败 HTTP ${r.status}`);
  return { BASE, ORIGIN, token: (await r.json()).data.token };
}

async function updateSetting(ctx, { key, value, expected, scene = 'update' }) {
  const r = await fetch(`${ctx.BASE}/api/svc:updateSetting`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ctx.ORIGIN,
      Authorization: `Bearer ${ctx.token}`,
      'X-Request-Id': uuid(),
    },
    body: JSON.stringify({ key, value, expected_value: expected, scene }),
  });
  const text = await r.text();
  let code = null;
  try {
    code = JSON.parse(text)?.errors?.[0]?.code ?? null;
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, code, text: text.slice(0, 200) };
}

function dbValue(key) {
  const out = execFileSync(
    'docker',
    [
      'compose', 'exec', '-T', 'postgres', 'psql',
      '-U', envValue('DB_USER'),
      '-d', envValue('DB_NAME', envValue('POSTGRES_DB', 'service_ticket')),
      '-t', '-A', '-c',
      `select value from service_settings where key='${key}'`,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return String(out).trim();
}

/**
 * 制造一次真并发冲突，并把值恢复到基线。
 * @returns {{statuses:number[], codes:(string|null)[], finalValue:string, winner:number, restored:boolean}}
 */
export async function runConflict({ key, baseValue, safeValue }) {
  const ctx = await loginHqAdmin();
  const before = dbValue(key);
  if (before !== String(baseValue)) {
    throw new Error(`前置条件不满足：${key}=${before}，期望 ${baseValue}`);
  }

  // ⚠️ 两个值都必须合法（在 5~1440 内），否则失败原因是 422 而不是并发冲突
  const a = String(safeValue);
  const b = String(Number(safeValue) + 1);
  const [ra, rb] = await Promise.all([
    updateSetting(ctx, { key, value: a, expected: baseValue }),
    updateSetting(ctx, { key, value: b, expected: baseValue }),
  ]);

  const statuses = [ra.status, rb.status];
  const codes = [ra.code, rb.code];
  const winner = ra.status === 200 ? a : b;
  const finalValue = dbValue(key);

  // 归位（用胜出值作为 expected，避免把 409 再触发一次）
  const restore = await updateSetting(ctx, { key, value: String(baseValue), expected: finalValue, scene: 'restore' });

  return {
    statuses,
    codes,
    finalValue,
    winner,
    restored: restore.status === 200 && dbValue(key) === String(baseValue),
    detail: { a: ra.text, b: rb.text, restore: restore.text },
  };
}
