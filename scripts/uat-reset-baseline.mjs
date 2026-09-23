#!/usr/bin/env node
/**
 * UAT 走查前的「一键复位」：跑全量验证 + 把数据库恢复成走查洁净基线。
 * =============================================================================
 *
 * 为什么需要它（不是一个"方便脚本"，是在堵一个真实的坑）：
 *   `smoke-test.mjs` 会**真实调用匿名报修接口**造工单（并发验收 / 幂等 / 探针等）。
 *   也就是说 —— **每跑一次验收，库里就多几张噪声工单**。
 *   而走查要求"每店一张、无 Visit"的干净基线，否则真人打开列表翻不到目标单，
 *   会把"数据脏"误判成"工单丢了"（2026-09-22 实际发生过一次）。
 *
 * 所以动作顺序是**固定的**：先验证（此时脏是正常的），再复位基线。
 * 反过来做（先复位再验证）等于白复位 —— 验证过程又会把库弄脏。
 *
 * 用法：
 *   node scripts/uat-reset-baseline.mjs            # 验证 + 复位（走查前标准动作）
 *   node scripts/uat-reset-baseline.mjs --skip-verify   # 只复位（刚验证过时用）
 *
 * 退出码：0 全部成功 / 1 有步骤失败 / 2 环境未就绪（连不上库）
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const envValue = (k, d) => {
  const m = new RegExp(`^${k}=(.*)$`, 'm').exec(envFile);
  return m ? m[1].trim() : d;
};

const DB_USER = envValue('DB_USER');
const DB_NAME = envValue('DB_DATABASE');
const DB_PASS = envValue('DB_PASSWORD');
const PG_CONTAINER = 'svc-postgres';

if (!DB_USER || !DB_NAME || !DB_PASS) {
  console.error('✗ .env 缺少 DB_USER / DB_DATABASE / DB_PASSWORD，无法连接');
  process.exit(2);
}

const SKIP_VERIFY = process.argv.includes('--skip-verify');

function psql(sql, { file } = {}) {
  const args = ['exec', '-e', `PGPASSWORD=${DB_PASS}`, PG_CONTAINER,
    'psql', '-U', DB_USER, '-d', DB_NAME, '-t', '-A', '-F', '|'];
  args.push(...(file ? ['-v', 'ON_ERROR_STOP=1', '-f', file] : ['-c', sql]));
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`✗ psql 失败（rc=${r.status}）：${(r.stderr || '').trim().slice(0, 400)}`);
    process.exit(2);
  }
  return r.stdout.trim();
}

function step(title) {
  console.log(`\n${'─'.repeat(66)}\n  ${title}\n${'─'.repeat(66)}`);
}

function countTickets() {
  return Number(psql('SELECT count(*) FROM service_tickets;'));
}

// ---------------------------------------------------------------------------
// 1. 验证（会把库弄脏，所以必须先跑）
// ---------------------------------------------------------------------------
if (!SKIP_VERIFY) {
  step('① 全量验证（注意：smoke 会真的造工单，库会变脏 —— 第 ② 步复位）');

  // ⚠️ 每个联网脚本之间必须**留冷却**，否则后一个会被 nginx 限流判 429 假红。
  //
  // 机制（实测复现）：`svc_public` 是 `rate=30r/m burst=10 nodelay`（见 nginx/nginx.conf）。
  //   · 单独跑 smoke → 117 项全绿；
  //   · 「verify-phase3-h5 → smoke」连跑 → smoke 的匿名报修断言**必定**拿到 429
  //     （报错形如"期望 422 / 409，实际 429"），凭空多出 2~3 条红。
  // 也就是说这是**测试编排**问题，不是产品缺陷 —— 但 429 混在真红灯里会让人去查业务代码，
  // 属于"会误报的检查比没检查更糟"（工程铁律 2）。所以由调用方负责让桶回满。
  //
  // 30r/m = 0.5/s，从上一次打满算起需 20s 才完全回满；取 25s 留余量。
  //
  // ⚠️ 2026-09-23 补充：本机实测仍会**偶发**假红（`verify-phase3-h5` 报 rc=1，
  //    单独复跑 35/35 全绿）。原因是该脚本自己会打一次 **10 路并发**匿名建单，
  //    而 `svc_public` 的 `burst=10 nodelay` 是"瞬时放行 10 个"——它把桶刚好打空，
  //    若紧邻的上一个脚本也让桶处于低水位，回填就来不及。
  //    因此对它**单独加长**冷却，而不是全局拉长（全局拉长会让整轮多等好几分钟，
  //    反而促使下一个人把冷却删掉）。
  const COOLDOWN_MS = 25000;
  const HEAVY_COOLDOWN_MS = 40000;

  const scripts = [
    ['verify-config', {}],
    ['verify-plugin-load', {}],
    ['verify-client-logic', {}],
    // 自己会打 10 路并发匿名建单 → 前面留更长的冷却
    ['verify-phase3-h5', {}, HEAVY_COOLDOWN_MS],
    // ⚠️ 必须在 smoke 之前：本脚本读真实 flowModels，不做写操作，早跑早暴露
    //    "自定义动作没挂到页面上"这件事 —— 那正是首轮走查 BLOCKED 的根因（DEV-68/69）。
    ['verify-ticket-actions', {}],
    ['smoke-test', { SMOKE_ALLOW_NO_VISITS: '1' }],
  ];

  let failed = 0;
  let first = true;
  for (const [name, extraEnv, cooldownMs] of scripts) {
    if (!first) {
      const cd = cooldownMs ?? COOLDOWN_MS;
      process.stdout.write(`  … 冷却 ${cd / 1000}s（等 nginx 令牌桶回填，防 429 假红）`);
      await new Promise((r) => setTimeout(r, cd));
      process.stdout.write('\r' + ' '.repeat(64) + '\r');
    }
    first = false;

    const r = spawnSync('node', [path.join(ROOT, 'scripts', `${name}.mjs`)], {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    const summary =
      /全部通过：(\d+) 项/.exec(out)?.[0] ??
      /(?:通过 (\d+) 项，失败 (\d+) 项)/.exec(out)?.[0] ??
      `rc=${r.status}`;
    const bad = r.status !== 0;
    if (bad) failed += 1;

    // 失败时把 429 单独点出来 —— 否则下一个人又会去查业务代码。
    // ⚠️ 匹配范围要**宽**：不同脚本的 429 文案不一样
    //    （`实际 429` / `HTTP 429` / `RATE_LIMITED` / `TOO_MANY_REQUESTS`），
    //    漏掉一种就会让"疑似限流"沉没成"真红灯"。
    const throttleHits = (
      out.match(/实际 429|HTTP 429|RATE_LIMITED|TOO_MANY_REQUESTS|429 Too Many/gi) ?? []
    ).length;
    const hint = throttleHits
      ? `  ⚠️ 含 ${throttleHits} 处限流迹象（**先单独复跑该脚本**：若转绿即编排问题，非业务缺陷）`
      : '';
    console.log(`  ${bad ? '✗' : '✅'} ${name.padEnd(20)} ${summary}${hint}`);
  }

  if (failed) {
    console.error(`\n✗ 有 ${failed} 个验证脚本未通过 —— 先修问题再复位基线（不放行）`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 2. 复位基线
// ---------------------------------------------------------------------------
step('② 复位走查洁净基线（保留每店一张 UAT 工单，删除脚本噪声）');

const before = countTickets();
psql(null, { file: '/tmp/uat-sweep-noise.sql' });

// 复位 SQL 若不在容器里，说明没拷过去 —— 明确报错而不是静默跳过
const after = countTickets();
const kept = psql("SELECT string_agg(id::text, ',' ORDER BY id) FROM service_tickets;");
const visits = Number(psql('SELECT count(*) FROM service_visits;'));
const events = Number(psql('SELECT count(*) FROM ticket_events;'));

console.log(`  工单：${before} → ${after}`);
console.log(`  保留：${kept}`);
console.log(`  Visit：${visits} 条 · 事件：${events} 条`);

if (after !== 4 || kept !== '35,886,1039,1040' || visits !== 0) {
  console.error(
    `\n✗ 基线不符预期（期望 4 张 = 35,886,1039,1040、Visit=0）。\n` +
      `  若提示找不到 /tmp/uat-sweep-noise.sql，先执行：\n` +
      `    docker cp scripts/sql/uat-sweep-noise.sql svc-postgres:/tmp/`,
  );
  process.exit(1);
}

step('③ 前哨复核（确认走查环境真的就绪）');
const pf = spawnSync('node', [path.join(ROOT, 'scripts', 'uat-preflight.mjs')], {
  encoding: 'utf8',
  cwd: ROOT,
  env: { ...process.env, SMOKE_ALLOW_NO_VISITS: '1' },
});
const pfOut = `${pf.stdout}\n${pf.stderr}`;
const tail = pfOut.split('\n').filter((l) => /前哨结果|环境事实已固定/.test(l));
console.log(tail.map((l) => `  ${l.trim()}`).join('\n') || '  （前哨无输出）');

console.log(`\n${'═'.repeat(66)}\n  ✅ 基线已复位，可以安排真人走查\n${'═'.repeat(66)}\n`);
