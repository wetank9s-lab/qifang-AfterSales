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
    // ⚠️ 自己会打 10 路并发匿名建单 → 前面留更长的冷却
    ['verify-phase3-h5', {}, HEAVY_COOLDOWN_MS],
    // ⚠️ 必须在 smoke 之前：本脚本读真实 flowModels，不做写操作，早跑早暴露
    //    "自定义动作没挂到页面上"这件事 —— 那正是首轮走查 BLOCKED 的根因（DEV-68/69）。
    ['verify-ticket-actions', {}],
    // ⚠️ Phase 4-I 第二轮新增：改派 reason 契约（P0 缺陷）的端到端验收。
    //    它会**自建一张一次性工单**并自删，所以放在复位之前跑、跑完仍由第 ② 步兜底。
    //    关键：它把"与 UI 完全一致的 payload"真的打给服务端 —— 这是唯一能发现
    //    "表单收集到了但载荷丢了"这类缺陷的断言形态。
    //    它也**同时承担** H3 抽屉 Visit 数据源（svc:visits）的契约断言（A7），
    //    因为只有它自带 Visit 夹具。
    ['verify-reassign-contract', {}],
    // ⚠️ `SMOKE_ALLOW_NO_VISITS=1` 是**必要的**：走查洁净基线把 Visit 清成 0，
    //    而 smoke 里那条 svc:visits 断言需要至少一条 Visit 才成立。
    //    这里显式允许它**跳过**（而不是靠残留数据碰巧满足）。
    //    ⚠️ 覆盖没有丢：同主题断言已搬到 verify-reassign-contract 的 A7（自带夹具）。
    //    跳过的条数会**单独打印**（`· 跳过 N 项`），不计入"通过"。
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
    // ⚠️ 必须把 `· 跳过 N 项` 一起抄进汇总：跳过项**不计入**"通过"，
    //    只截 `全部通过：N 项` 会把"被跳过的一条"伪装成通过（旧实现就踩过）。
    const summary =
      /全部通过：\d+ 项(?: · 跳过 \d+ 项)?/.exec(out)?.[0] ??
      /(?:通过 \d+ 项，失败 \d+ 项(?:，跳过 \d+ 项)?)/.exec(out)?.[0] ??
      `rc=${r.status}`;
    const bad = r.status !== 0;
    if (bad) failed += 1;

    // 失败时把 429 单独点出来 —— 否则下一个人又会去查业务代码。
    // ⚠️ 匹配范围要**宽**：不同脚本的 429 文案不一样
    //    （`实际 429` / `HTTP 429` / `RATE_LIMITED` / `TOO_MANY_REQUESTS`），
    //    漏掉一种就会让"疑似限流"沉没成"真红灯"。
    //
    // ⚠️⚠️ 但**只能在红灯行里找**，且**只在脚本真的失败时**才提示（2026-09-23 修）：
    //    旧实现扫的是**整份输出**，于是 `smoke-test` 每轮都命中 ——
    //    因为它自己就有**断言"限流生效"的绿灯用例**（`RATE_LIMITED` /
    //    `TOO_MANY_REQUESTS` 是它**期望**看到的字面量）。
    //    结果：每次全绿运行都挂一条"含 1 处限流迹象（先单独复跑该脚本）"，
    //    让人去复跑一个本来就没问题的脚本 —— 典型的"会误报的检查比没检查更糟"
    //    （铁律 2），而且会训练出"这条提示可以无视"，真出事时没人看。
    //    判据：① 只看红灯行（`❌` / 汇总条目 `•` / `✗`）；
    //          ② 脚本通过时不存在"假红"可谈，一律不提示。
    const problemLines = out
      .split('\n')
      .filter((l) => /❌|✗/.test(l) || /^\s*•/.test(l))
      .join('\n');
    const throttleHits = (
      problemLines.match(/实际 429|HTTP 429|RATE_LIMITED|TOO_MANY_REQUESTS|429 Too Many/gi) ?? []
    ).length;
    const hint =
      bad && throttleHits
        ? `  ⚠️ 失败项含 ${throttleHits} 处限流字样（**先单独复跑该脚本**：若转绿即编排问题，非业务缺陷）`
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
step('② 复位走查洁净基线（删脚本噪声 → 把 4 张 UAT 单打回全新状态）');

/**
 * 把 scripts/sql/ 下的复位脚本送进容器。
 *
 * ⚠️ 以前这一步是**手工** `docker cp`，忘了拷就报"找不到 /tmp/xxx.sql" ——
 *    属于"环境未就绪伪装成脚本坏了"。改为每次自动拷贝，且校验文件存在。
 */
function pushSql(fileName) {
  const local = path.join(ROOT, 'scripts', 'sql', fileName);
  if (!fs.existsSync(local)) {
    console.error(`✗ 缺少 ${path.relative(ROOT, local)} —— 无法复位`);
    process.exit(2);
  }
  const r = spawnSync('docker', ['cp', local, `${PG_CONTAINER}:/tmp/${fileName}`], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(`✗ docker cp ${fileName} 失败：${(r.stderr || '').trim().slice(0, 300)}`);
    process.exit(2);
  }
}

/**
 * 顺序**不可反**：
 *   ① sweep  —— 只删 id≥1041 的脚本噪声（不做全库 Visit 断言）
 *   ② reset  —— 把 35/886/1039/1040 打回全新（清 Visit/事件/短信，断言全库 Visit=0）
 * 反过来的话，②的全库断言会被尚未清理的噪声工单卡住。
 */
const before = countTickets();
pushSql('uat-sweep-noise.sql');
psql(null, { file: '/tmp/uat-sweep-noise.sql' });
const afterSweep = countTickets();
console.log(`  噪声清理：${before} → ${afterSweep} 张（保留 35,886,1039,1040）`);

pushSql('uat-reset-fixtures.sql');
psql(null, { file: '/tmp/uat-reset-fixtures.sql' });

const after = countTickets();
const kept = psql("SELECT string_agg(id::text, ',' ORDER BY id) FROM service_tickets;");
const visits = Number(psql('SELECT count(*) FROM service_visits;'));
const events = Number(psql('SELECT count(*) FROM ticket_events;'));
const statuses = psql(
  "SELECT string_agg(ticket_no||'='||status, ' ' ORDER BY id) FROM service_tickets;",
);

console.log(`  夹具复位：${afterSweep} → ${after} 张 · 全部状态 ${statuses}`);
console.log(`  保留：${kept}`);
console.log(`  Visit：${visits} 条 · 事件：${events} 条（走查起点应为 0 / 0）`);

if (after !== 4 || kept !== '35,886,1039,1040' || visits !== 0) {
  console.error(
    `\n✗ 基线不符预期（期望 4 张 = 35,886,1039,1040、Visit=0）。\n` +
      `  两个复位脚本的详细报错见上方 psql 输出。`,
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
