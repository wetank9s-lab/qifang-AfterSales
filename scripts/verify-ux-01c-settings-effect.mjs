#!/usr/bin/env node
/**
 * verify-ux-01c-settings-effect.mjs —— 阈值**真的被使用** + 重启后仍在（UX-01C 第五轮 §三.5 / §三.10）
 *
 * ===========================================================================
 * 为什么"页面改完显示新值"不算生效
 * ===========================================================================
 * 本项目已经踩过"可存不生效"的假设置：值写进表里、界面回显正常，但消费方仍在读
 * 代码里的默认值。唯一的证据是**消费过程的行为跟着变**。
 *
 * 这里的消费点是 `services/sla-scan-scheduler.ts:226` 的 `readInt('sla.accept_minutes')`：
 *   谓词 `status='NEW' AND created_at < now - acceptMinutes`
 * ⇒ 把阈值从 5 调到 1440，"待受理超时"计数必须**恰好等于**用同一阈值算出的行数。
 *
 * ===========================================================================
 * 怎么拿到"扫描当时"的口径（避免时间漂移造成假红/假绿）
 * ===========================================================================
 * health 会回 `slaScannedAt`（缓存快照的时间戳）。用它作基准算 SQL 的截止点，
 * 而不是"脚本此刻的 now" —— 两者差几十秒，边界上的工单会让计数对不上。
 *
 * ⚠️ 每次改值后**重启**：SLA 扫描每 5 分钟一轮，等它太慢；启动期会跑一次同样的
 *    `runSlaScan`（同一条代码路径），重启即可得到"新阈值下的当前事实"。
 *
 * 用法：node scripts/verify-ux-01c-settings-effect.mjs
 * 退出码：0 通过 / 1 判据不满足 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SVC_BASE_URL } from './lib/base-url.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

const KEY = 'sla.accept_minutes';
const BASE_VALUE = Number(envValue('UX01C_EXPECT_BASE', '120'));
const LOW = 5; // 规格下限（spec.min）
const HIGH = 1440; // 规格上限（spec.max）

const ORIGIN = new URL(SVC_BASE_URL).origin;

const results = [];
function check(pass, label, detail = '') {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
}
function note(label, detail = '') {
  console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);
}

function psql(query) {
  const out = execFileSync(
    'docker',
    [
      'compose', 'exec', '-T', 'postgres', 'psql',
      '-U', envValue('DB_USER'),
      '-d', envValue('DB_NAME', envValue('POSTGRES_DB', 'service_ticket')),
      '-t', '-A', '-c', query,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return String(out).trim();
}
const dbValue = () => psql(`select value from service_settings where key='${KEY}'`);
const auditCount = () => Number(psql(`select count(*) from config_change_audits where key='${KEY}'`));

async function login() {
  const r = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({
      email: envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'),
      password: envValue('UAT_HQADMIN_PASSWORD'),
    }),
  });
  if (r.status !== 200) throw new Error(`hq_admin 登录失败 HTTP ${r.status}`);
  return (await r.json()).data.token;
}

async function updateSetting(token, { value, expected, scene = 'update' }) {
  const r = await fetch(`${SVC_BASE_URL}/api/svc:updateSetting`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      Authorization: `Bearer ${token}`,
      'X-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({ key: KEY, value: String(value), expected_value: String(expected), scene }),
  });
  const text = await r.text();
  return { status: r.status, text: text.slice(0, 200) };
}

async function health(token) {
  const r = await fetch(`${SVC_BASE_URL}/api/svc:health`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status !== 200) throw new Error(`health HTTP ${r.status}`);
  return (await r.json()).data;
}

function restartApp() {
  spawnSync('docker', ['compose', 'restart', 'app'], { cwd: ROOT, stdio: 'ignore' });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const r = spawnSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', 'svc-app'], { encoding: 'utf8' });
    if (String(r.stdout).trim() === 'healthy') {
      // 等插件 afterLoad（含资源授权自愈 / ACL 回灌）跑完
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  throw new Error('等待 svc-app healthy 超时');
}

/** 用"扫描时刻"作基准，算某个阈值下**应当**命中的 NEW 工单数（与扫描谓词同口径） */
function expectedOverdue(scannedAt, minutes) {
  return Number(
    psql(
      `select count(*) from service_tickets where status='NEW' ` +
        `and created_at < (timestamptz '${scannedAt}' - interval '${minutes} minutes')`,
    ),
  );
}

// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  UX-01C：阈值消费证据 + 重启后仍在');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  · 键：${KEY} · 基线 ${BASE_VALUE} · 低 ${LOW} / 高 ${HIGH}`);

if (!envValue('UAT_HQADMIN_PASSWORD')) {
  console.log('  ⛔ .env 缺 UAT_HQADMIN_PASSWORD —— 环境未就绪');
  process.exit(2);
}
if (dbValue() !== String(BASE_VALUE)) {
  console.log(`  ⛔ 前置条件不满足：库里 ${KEY}=${dbValue()}，期望 ${BASE_VALUE}`);
  process.exit(2);
}

let token = await login();
const auditsAtStart = auditCount();
note('起始审计条数', String(auditsAtStart));

// ---- ① 基线扫描事实（当前 120 分钟） -------------------------------------
const h0 = await health(token);
const baseOverdue = Number(h0.slaAcceptanceOverdue);
check(Number.isFinite(baseOverdue), '基线扫描已产出计数', `slaAcceptanceOverdue=${baseOverdue} @ ${h0.slaScannedAt}`);
check(
  baseOverdue === expectedOverdue(h0.slaScannedAt, BASE_VALUE),
  `基线计数与库中口径一致（${BASE_VALUE} 分钟）`,
  `health=${baseOverdue} / SQL=${expectedOverdue(h0.slaScannedAt, BASE_VALUE)}`,
);

// ---- ② 改成下限 5 → 重启 → 计数应变大 ------------------------------------
const r5 = await updateSetting(token, { value: LOW, expected: BASE_VALUE });
check(r5.status === 200, `受控写入 ${BASE_VALUE} → ${LOW}`, `HTTP ${r5.status} ${r5.text.slice(0, 120)}`);
check(dbValue() === String(LOW), '库里已是新值', dbValue());
check(auditCount() === auditsAtStart + 1, '写入留痕 +1', `${auditsAtStart} → ${auditCount()}`);

restartApp();
note('已重启（启动期会跑一次 SLA 扫描）');
token = await login();
const h5 = await health(token);
const overdue5 = Number(h5.slaAcceptanceOverdue);
const expect5 = expectedOverdue(h5.slaScannedAt, LOW);
check(
  Math.abs(overdue5 - expect5) <= 2,
  `阈值 ${LOW} 分钟下的计数与数据库同口径`,
  `health=${overdue5} / SQL=${expect5} @ ${h5.slaScannedAt}`,
);
check(overdue5 > baseOverdue, '阈值调小后超时计数**变大**（消费生效）', `${baseOverdue} → ${overdue5}`);

// ---- ③ 改成上限 1440 → 重启 → 计数应变小 ---------------------------------
const r1440 = await updateSetting(token, { value: HIGH, expected: LOW });
check(r1440.status === 200, `受控写入 ${LOW} → ${HIGH}`, `HTTP ${r1440.status}`);
restartApp();
token = await login();
const h1440 = await health(token);
const overdue1440 = Number(h1440.slaAcceptanceOverdue);
const expect1440 = expectedOverdue(h1440.slaScannedAt, HIGH);
check(
  Math.abs(overdue1440 - expect1440) <= 2,
  `阈值 ${HIGH} 分钟下的计数与数据库同口径`,
  `health=${overdue1440} / SQL=${expect1440} @ ${h1440.slaScannedAt}`,
);
check(overdue1440 < overdue5, '阈值调大后超时计数**变小**（消费生效）', `${overdue5} → ${overdue1440}`);

// ---- ④ 恢复基线 → 重启 → 值/审计/授权都还在 ------------------------------
const rBack = await updateSetting(token, { value: BASE_VALUE, expected: HIGH, scene: 'restore' });
check(rBack.status === 200, `恢复 ${HIGH} → ${BASE_VALUE}（scene=restore）`, `HTTP ${rBack.status}`);
restartApp();
token = await login();
check(dbValue() === String(BASE_VALUE), '重启后配置值仍是基线', dbValue());
check(auditCount() === auditsAtStart + 3, '三次写入各留一条审计（重启后仍在）', `${auditsAtStart} → ${auditCount()}`);

const grants = Number(
  psql(`select count(*) from "dataSourcesRolesResources" where "roleName"='hq_admin' and name='serviceSettings'`),
);
check(grants === 1, '重启/重播种后 hq_admin 的 serviceSettings 资源授权仍在', `行数 ${grants}`);

const list = await fetch(`${SVC_BASE_URL}/api/serviceSettings:list?pageSize=10`, {
  headers: { Authorization: `Bearer ${token}` },
});
const listJson = await list.json();
check(
  list.status === 200 && Number(listJson?.meta?.count) === 3,
  '重启后页面数据源仍可用（list 只回 3 个键）',
  `HTTP ${list.status} · count=${listJson?.meta?.count}`,
);

const hFinal = await health(token);
check(
  Number(hFinal.slaAcceptanceOverdue) === expectedOverdue(hFinal.slaScannedAt, BASE_VALUE),
  '恢复后计数回到基线口径',
  `health=${hFinal.slaAcceptanceOverdue} / SQL=${expectedOverdue(hFinal.slaScannedAt, BASE_VALUE)}`,
);

// ---- ⑤ 审计内容抽查 ------------------------------------------------------
const trail = psql(
  `select coalesce(old_value,'')||'->'||coalesce(new_value,'')||'('||coalesce(scene,'')||')' ` +
    `from config_change_audits where key='${KEY}' order by id desc limit 3`,
).split('\n').filter(Boolean).reverse();
note('最近三条审计（时间顺序）', trail.join(' · '));
check(
  trail.some((t) => t.includes(`${BASE_VALUE}->${LOW}`)) &&
    trail.some((t) => t.includes(`${LOW}->${HIGH}`)) &&
    trail.some((t) => t.includes(`${HIGH}->${BASE_VALUE}`)),
  '三条审计的 old→new 与三次实际改动一致',
  trail.join(' · '),
);

const failed = results.filter((r) => !r.pass);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  结果：通过 ${results.length - failed.length} / 失败 ${failed.length}`);
if (failed.length) for (const f of failed) console.log(`    ❌ ${f.label}${f.detail ? ` —— ${f.detail}` : ''}`);
console.log('══════════════════════════════════════════════════════════════');
process.exit(failed.length ? 1 : 0);
