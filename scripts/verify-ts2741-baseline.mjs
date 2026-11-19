#!/usr/bin/env node
/**
 * verify-ts2741-baseline.mjs —— **TS2741 基线门禁**（BE-03-S6 / 前置条件 5）
 *
 * ===========================================================================
 * 它挡的是什么
 * ===========================================================================
 * `SmsSendResult.deliveryStatus` 是**必填**字段，而短信宝 provider 的两个 return
 * **都没写它**。结果：
 *   · `build-plugin.mjs`（esbuild 只转译）→ ✅ 通过；
 *   · `verify-types.mjs` → tsc **确实报了** `TS2741`，但该门禁只对
 *     TS2304 / TS2552 + 宿主包白名单判红 ⇒ **看得见、拦不住**（21 条积压里就有它）。
 * ⇒ 于是出现了"类型契约被破坏但两层门禁全绿"的缝隙。
 *
 * 为什么**不**把 TS2741 一刀切判红：仓库现有 19 条历史积压（多为宿主包 stub 造成的
 * 假阳性）。全判红 ⇒ 这条门禁当天就会被 `|| true` 掉，等于没有。
 *
 * ⇒ 采用**基线 + 增量**判据（与 `verify-types` 的白名单同一种思路）：
 *   · 基线里的 TS2741 **允许存在**（历史债，另行排期）；
 *   · **新出现的**（键不在基线里，或同键次数变多）⇒ **exit 1，不构建**；
 *   · 变少 ⇒ 只报告"可以刷新基线"，**不判红**（修好了不该被罚）。
 *
 * 键的归一化：`文件 | 缺少的属性名 | 期望类型名`。
 *   ⚠️ **刻意不含行号** —— 行号会随无关改动漂移，含行号的基线每天都要手改，
 *      而每天手改的基线等于没有基线。
 *
 * 用法：
 *   node scripts/verify-ts2741-baseline.mjs            # 检查（增量 ⇒ 红）
 *   node scripts/verify-ts2741-baseline.mjs --update   # 用当前结果重写基线（要人看 diff）
 *   node scripts/verify-ts2741-baseline.mjs --list     # 只打印当前 TS2741 清单
 *
 * 退出码：0 = 无新增；1 = 有新增（产品/代码问题）；2 = 工具自身不可用（**不给产品结论**）
 */

/**
 * ⚠️ 2026-10-29 起：本脚本**已被 `verify-ts-baseline.mjs` 覆盖**（TS2741 是它判据的子集，
 *    见 BUILD-TS-GATE-01）。构建流程现在调用全量那一条；本脚本保留作**定向排查**用
 *    （只想看「必填属性缺失」时跑它，比翻 200 多条更省事），基线文件也保留。
 *    ⇒ 改判据请改全量那条，不要把这里当成构建时的唯一 TS 门禁。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'nocobase/plugins/service-ticket/tsconfig.check.json');
const BASELINE = path.join(__dirname, 'expected-ts2741.json');

const ARGV = new Set(process.argv.slice(2));
const UPDATE = ARGV.has('--update');
const LIST = ARGV.has('--list');

/** 与 `verify-types.mjs` 同一处找 tsc（隔离工作区，不污染用户环境） */
function findTsc() {
  const candidates = [
    path.join(
      process.env.USERPROFILE ?? process.env.HOME ?? '',
      '.workbuddy/binaries/node/workspace/node_modules/typescript/bin/tsc',
    ),
    path.join(ROOT, 'node_modules/typescript/bin/tsc'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): error TS2741: Property '(.*?)' is missing in type .* but required in type '(.*)'\.$/;

function collect(tscPath) {
  const r = spawnSync(process.execPath, [tscPath, '--project', PROJECT], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (out.trim() === '') {
    // 空输出通常意味着 tsc 根本没跑起来（参数/路径问题），必须与"0 条诊断"分开
    return { ok: false, reason: `tsc 无任何输出（exit=${r.status}）`, items: [] };
  }
  const items = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(TSC_LINE);
    if (!m) continue;
    const [, file, , , property, type] = m;
    items.push({
      file: file.replace(/\\/g, '/'),
      property,
      type,
      key: `${file.replace(/\\/g, '/')}|${property}|${type}`,
    });
  }
  return { ok: true, items, tscExit: r.status };
}

function summarize(items) {
  const map = new Map();
  for (const it of items) {
    const cur = map.get(it.key) ?? { ...it, occurrences: 0 };
    cur.occurrences += 1;
    map.set(it.key, cur);
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

function main() {
  const tscPath = findTsc();
  if (!tscPath) {
    console.error('[ts2741] 找不到 tsc（预期在 ~/.workbuddy/binaries/node/workspace/node_modules）');
    console.error('  ⇒ **工具坏了**，不是产品问题；不给结论。');
    return 2;
  }

  const res = collect(tscPath);
  if (!res.ok) {
    console.error(`[ts2741] ${res.reason} ⇒ 工具不可用，不给结论`);
    return 2;
  }

  const now = summarize(res.items);
  const total = now.reduce((n, x) => n + x.occurrences, 0);

  if (LIST || UPDATE) {
    console.log(`TS2741 当前 ${total} 条 / ${now.length} 个键：`);
    for (const it of now) console.log(`  ${it.occurrences}×  ${it.key}`);
  }

  if (UPDATE) {
    const payload = {
      note:
        'TS2741 基线：允许存在的历史积压。新增即判红（verify-ts2741-baseline.mjs）。' +
        '键=文件|属性|类型，**不含行号**（行号会漂移）。',
      generated_at: new Date().toISOString(),
      total,
      entries: now.map(({ key, file, property, type, occurrences }) => ({
        key,
        file,
        property,
        type,
        occurrences,
      })),
    };
    fs.writeFileSync(BASELINE, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\n已写入基线：${path.relative(ROOT, BASELINE)}（${total} 条 / ${now.length} 键）`);
    return 0;
  }

  if (LIST) return 0;

  if (!fs.existsSync(BASELINE)) {
    console.error(`[ts2741] 缺少基线文件：${path.relative(ROOT, BASELINE)}`);
    console.error('  ⇒ 先跑 `node scripts/verify-ts2741-baseline.mjs --update` 并把 diff 看一遍。');
    return 2;
  }

  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const baseMap = new Map((base.entries ?? []).map((e) => [e.key, e.occurrences ?? 1]));

  const added = [];
  const grown = [];
  for (const it of now) {
    const was = baseMap.get(it.key);
    if (was === undefined) added.push(it);
    else if (it.occurrences > was) grown.push({ ...it, was });
  }
  const shrunk = [];
  const nowMap = new Map(now.map((it) => [it.key, it.occurrences]));
  for (const e of base.entries ?? []) {
    const cur = nowMap.get(e.key) ?? 0;
    if (cur < (e.occurrences ?? 1)) shrunk.push({ key: e.key, was: e.occurrences ?? 1, now: cur });
  }

  console.log(`[ts2741] 基线 ${base.total ?? '?'} 条 → 当前 ${total} 条（${now.length} 键）`);

  if (added.length === 0 && grown.length === 0) {
    if (shrunk.length) {
      console.log(`  ℹ️ 有 ${shrunk.length} 个键比基线更少（修好了）。可择机 --update 收紧基线。`);
      for (const s of shrunk) console.log(`     - ${s.was}→${s.now}  ${s.key}`);
    }
    console.log('  ✅ 无新增 TS2741');
    return 0;
  }

  console.error(`\n[ts2741] ✗ 新增 ${added.length + grown.length} 处必填属性缺失（不构建）：`);
  for (const a of added) {
    console.error(`  + [新键] ${a.occurrences}×  ${a.file}  Property '${a.property}' → ${a.type}`);
  }
  for (const g of grown) {
    console.error(`  + [变多] ${g.was}→${g.occurrences}×  ${g.file}  Property '${g.property}' → ${g.type}`);
  }
  console.error('\n  ⇒ esbuild 不检查类型：这种缺失打出来的产物"能构建成功"，');
  console.error('     等运行期读到该字段才变成 undefined。补上字段，或（确属历史债时）');
  console.error('     说明理由后 --update 基线 —— 但**不要**用 --update 掩盖本次改动引入的问题。');
  return 1;
}

process.exit(main());
