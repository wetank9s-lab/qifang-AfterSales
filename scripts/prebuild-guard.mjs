#!/usr/bin/env node
/**
 * prebuild-guard.mjs —— 构建前基线漂移检查（BE-03/BE-05 事故后加的闸）
 *
 * 事故：多轮修改被写进了**不参与构建**的源码副本（工作区 git 仓库），
 *      而真正构建的是 `admin-base/`。结果"源码已改、产物没变"，
 *      排查时又因为页面有标题而误判成"组件没挂载"。
 *
 * 规则（单一事实来源）：
 *   · **构建基线 = `admin-base/`**（`build-plugin.mjs` 只读它）。
 *   · 工作区仓库里的同名文件必须与基线**逐字节一致**；不一致就中止构建，
 *     并明确列出哪几个文件漂移。
 *
 * 用法：
 *   node scripts/prebuild-guard.mjs          # 检查，漂移则 exit 1
 *   node scripts/prebuild-guard.mjs --list   # 只看清单不看内容
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(__dirname, '..');
const BASE = path.resolve(WORKSPACE, '..', 'admin-base');

/**
 * 受管文件：既影响 BE-03/BE-05，也包含它们依赖的注册与共享模块。
 * 新增受管文件时必须同步这里 —— 否则又会出现"改了但没人在看"的静默漂移。
 */
const MANAGED = [
  'nocobase/plugins/service-ticket/src/client/hq-pages.tsx',
  'nocobase/plugins/service-ticket/src/client/page-logic.ts',
  'nocobase/plugins/service-ticket/src/client/index.ts',
  'nocobase/plugins/service-ticket/src/server/actions/svc/insight.ts',
  'nocobase/plugins/service-ticket/src/server/actions/svc/config-settings.ts',
  'nocobase/plugins/service-ticket/src/server/services/sms-service.ts',
  'nocobase/plugins/service-ticket/src/server/services/sms-provider.ts',
  'nocobase/plugins/service-ticket/src/server/constants.ts',
  'nocobase/plugins/service-ticket/src/server/services/sms-status.ts',
  'nocobase/plugins/service-ticket/src/shared/svc-request.ts',
];

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);

function main() {
  if (!fs.existsSync(BASE)) {
    console.error(`✗ 构建基线目录不存在：${BASE}`);
    process.exit(2);
  }
  const rows = [];
  let drift = 0;
  for (const rel of MANAGED) {
    const ws = path.join(WORKSPACE, rel);
    const bs = path.join(BASE, rel);
    const wsOk = fs.existsSync(ws);
    const bsOk = fs.existsSync(bs);
    if (!wsOk || !bsOk) {
      rows.push({ rel, ws: wsOk ? sha(ws) : '(缺失)', bs: bsOk ? sha(bs) : '(缺失)', state: 'MISS' });
      drift += 1;
      continue;
    }
    const h1 = sha(ws);
    const h2 = sha(bs);
    const same = h1 === h2;
    if (!same) drift += 1;
    rows.push({ rel, ws: h1, bs: h2, state: same ? 'SAME' : 'DIFF' });
  }

  if (process.argv.includes('--list')) {
    for (const r of rows) console.log(`${r.state}  ${r.rel}`);
    return 0;
  }

  console.log('构建基线：admin-base/');
  for (const r of rows) {
    console.log(`  ${r.state.padEnd(4)}  ${r.rel}  ws=${r.ws} base=${r.bs}`);
  }
  if (drift > 0) {
    console.error(`\n✗ 有 ${drift} 个受管文件在工作区与构建基线之间漂移。`);
    console.error('  处置：确认哪一份是验收版后同步（通常是 base → 工作区），再重新构建。');
    console.error('  **不要**直接构建：那样"源码已改、产物没变"，排查会再次走偏。');
    return 1;
  }
  console.log('\n✓ 全部一致，可以构建。');
  return 0;
}

process.exit(main());
