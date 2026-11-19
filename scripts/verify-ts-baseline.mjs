#!/usr/bin/env node
/**
 * verify-ts-baseline.mjs —— **全量 TypeScript 诊断基线门禁**（BUILD-TS-GATE-01）
 *
 * ===========================================================================
 * 它挡的是什么（真实事故）
 * ===========================================================================
 * 2026-10-29 上线 BE-03/05 两页 UI 时，第一次部署后才发现本次改动**新引入 9 条诊断**
 * （TS2694 ×6、TS2347 ×1、TS2322 ×2）：
 *   · `build-plugin.mjs` 用 esbuild —— 只转译，**exit 0**；
 *   · `verify-types.mjs` 只对 TS2304/TS2552 + 宿主包白名单判红 —— 这 9 条**不在判据里**；
 *   · 而 `verify-ts2741-baseline.mjs` 只看 TS2741 —— 也不在。
 * ⇒ 三层门禁全绿，新错误照常上线。这不是"某个判据写松了"，是**判据集合本身有洞**。
 *
 * ===========================================================================
 * 判据（比"再补一个错误码"更根本）
 * ===========================================================================
 * 不挑错误码：**任何代码**的新增诊断都算回归。
 *   · 基线里的（历史积压）允许存在，按 `文件|代码|消息` 计次；
 *   · 新出现的键，或同键次数变多 ⇒ **exit 1，不构建**；
 *   · 变少 ⇒ 只提示"可收紧基线"，**不判红**（修好了不该被罚）。
 *
 * 键为什么**不含行号**：行号会随无关改动整体漂移，含行号的基线每天都要手改，
 * 而每天手改的基线等于没有基线（同样的取舍见 `verify-ts2741-baseline.mjs`）。
 *
 * ⚠️ 不允许用"把新错误码加进忽略名单"来变绿 —— 那正是这套门禁要防的事。
 *    要放宽必须改**基线文件**并说明理由，且基线 diff 会被 code review 看到。
 *
 * 用法：
 *   node scripts/verify-ts-baseline.mjs            # 检查（新增 ⇒ exit 1）
 *   node scripts/verify-ts-baseline.mjs --update   # 重写基线（必须看 diff）
 *   node scripts/verify-ts-baseline.mjs --list     # 打印当前全量诊断
 *
 * 退出码：0 = 无新增；1 = 有新增（代码问题）；2 = 工具不可用（**不给产品结论**）
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'nocobase/plugins/service-ticket/tsconfig.check.json');
const BASELINE = path.join(__dirname, 'expected-ts-baseline.json');

const ARGV = new Set(process.argv.slice(2));
const UPDATE = ARGV.has('--update');
const LIST = ARGV.has('--list');

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

/** `src/x.ts(12,3): error TS2694: Namespace 'x' has no exported member 'Y'.` */
const LINE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

function collect(tscPath) {
  const r = spawnSync(process.execPath, [tscPath, '--project', PROJECT], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const items = [];
  for (const raw of out.split(/\r?\n/)) {
    const m = raw.match(LINE);
    if (!m) continue;
    const [, file, , , severity, code, message] = m;
    const f = file.replace(/\\/g, '/');
    const msg = message.replace(/\s+/g, ' ').trim();
    items.push({ file: f, code, severity, message: msg, key: `${f}|${code}|${msg}` });
  }
  if (out.trim() === '') return { ok: false, reason: `tsc 无任何输出（exit=${r.status}）`, items: [] };
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

function byCode(list) {
  const m = new Map();
  for (const it of list) m.set(it.code, (m.get(it.code) ?? 0) + it.occurrences);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function main() {
  const tscPath = findTsc();
  if (!tscPath) {
    console.error('[ts-baseline] 找不到 tsc（预期在 ~/.workbuddy/binaries/node/workspace/node_modules）');
    console.error('  ⇒ **工具坏了**，不是产品问题；不给结论。');
    return 2;
  }

  const res = collect(tscPath);
  if (!res.ok) {
    console.error(`[ts-baseline] ${res.reason} ⇒ 工具不可用，不给结论`);
    return 2;
  }
  const now = summarize(res.items);
  const total = now.reduce((n, x) => n + x.occurrences, 0);

  if (LIST || UPDATE) {
    console.log(`当前诊断 ${total} 条 / ${now.length} 键；按代码：${byCode(now).map(([c, n]) => `${c}×${n}`).join(' ')}`);
    if (LIST) for (const it of now) console.log(`  ${it.occurrences}×  ${it.key}`);
  }

  if (UPDATE) {
    const payload = {
      note:
        'TypeScript 全量诊断基线（历史积压）。**新增即阻断构建**（verify-ts-baseline.mjs）。' +
        '键=文件|代码|消息，不含行号；放宽基线必须说明理由并接受 diff 复核。',
      generated_at: new Date().toISOString(),
      total,
      entries: now.map(({ key, file, code, severity, message, occurrences }) => ({
        key, file, code, severity, message, occurrences,
      })),
    };
    fs.writeFileSync(BASELINE, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\n已写入基线：${path.relative(ROOT, BASELINE)}（${total} 条 / ${now.length} 键）`);
    return 0;
  }

  if (!fs.existsSync(BASELINE)) {
    console.error(`[ts-baseline] 缺少基线文件：${path.relative(ROOT, BASELINE)}`);
    console.error('  ⇒ 先跑 `node scripts/verify-ts-baseline.mjs --update` 并把 diff 看一遍。');
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
  const nowMap = new Map(now.map((it) => [it.key, it.occurrences]));
  const shrunk = (base.entries ?? [])
    .map((e) => ({ key: e.key, was: e.occurrences ?? 1, now: nowMap.get(e.key) ?? 0 }))
    .filter((x) => x.now < x.was);

  console.log(`[ts-baseline] 基线 ${base.total ?? '?'} 条 → 当前 ${total} 条（${now.length} 键）`);

  if (added.length === 0 && grown.length === 0) {
    if (shrunk.length) {
      console.log(`  ℹ️ ${shrunk.length} 个键比基线更少（修好了）。可择机 --update 收紧基线。`);
      for (const s of shrunk.slice(0, 5)) console.log(`     - ${s.was}→${s.now}  ${s.key}`);
    }
    console.log('  ✅ 无新增诊断');
    return 0;
  }

  console.error(`\n[ts-baseline] ✗ 新增 ${added.length + grown.length} 处诊断（**不构建**）：`);
  for (const a of added) console.error(`  + [新键] ${a.occurrences}×  ${a.code}  ${a.file}  ${a.message}`);
  for (const g of grown) console.error(`  + [变多] ${g.was}→${g.occurrences}×  ${g.code}  ${g.file}  ${g.message}`);
  console.error('\n  ⇒ esbuild 只转译：这些错误打出来的产物**照样能构建成功**。');
  console.error('  ⇒ 修掉它；**不要**把新错误码加进忽略名单来变绿（那正是本门禁要防的）。');
  return 1;
}

process.exit(main());
