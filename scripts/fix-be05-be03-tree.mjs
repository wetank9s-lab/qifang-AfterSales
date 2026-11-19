#!/usr/bin/env node
/**
 * fix-be05-be03-tree.mjs —— BE-05/BE-03 两个空壳页面的定向重建
 *
 * 背景：两个页面（zku15hcn09u / 1y4mi7pchuz）此前只落了 RouteModel 空壳，
 *      缺完整区块子树。replace 模式要求目标页已含 tab（空壳没有 → 400），
 *      所以正确路径是：删空壳 → mode=create 完整重建（复用现有导航组，不新建组）。
 *
 * 安全边界：
 *   · 只操作写死的两个 schemaUid + 两条空壳 desktopRoutes；
 *   · navigation.group 传现有组 routeId=387851208425472（不重复建组）；
 *   · 不跑全量 seed、不 purge、不碰其它页面/角色/ACL/业务数据。
 *
 * 用法：
 *   node scripts/fix-be05-be03-tree.mjs --dry-run   # 只打印将执行的步骤，不写库
 *   node scripts/fix-be05-be03-tree.mjs              # 实际执行
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const BASE = 'https://sh.scqfls.cn';
const GROUP_ROUTE_ID = 387851208425472; // 导航组「售后工单」

function envValue(key, fallback = '') {
  const p = process.env[key];
  if (p !== undefined && String(p).trim() !== '') return String(p).trim();
  try {
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'));
    if (m) return m[1].trim();
  } catch { /* fall through */ }
  return fallback;
}
const ADMIN_EMAIL = envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com');
const ADMIN_PASSWORD = envValue('SMOKE_ADMIN_PASSWORD', '');

const TARGETS = [
  { schemaUid: 'zku15hcn09u', title: '总部售后工作台', blockKey: 'hq-workbench-block', tabKey: 'hq-workbench', routeId: 394390121349120 },
  { schemaUid: '1y4mi7pchuz', title: '短信通知总览', blockKey: 'sms-overview-block', tabKey: 'sms-overview', routeId: 394390125543424 },
];

function log(...a) { console.log(...a); }

async function api(pathname, { method = 'POST', body, token }) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: new URL(BASE).origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function signIn() {
  if (!ADMIN_PASSWORD) throw new Error('SMOKE_ADMIN_PASSWORD 未配置');
  const r = await api('/api/auth:signIn', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  if (r.status !== 200) throw new Error(`登录失败 HTTP ${r.status}`);
  return r.json.data.token;
}

function createDoc(title, blockKey, tabKey) {
  return {
    version: '1',
    mode: 'create',
    navigation: {
      // 与 seed-admin-pages.mjs 的 tablePage() 完全一致：group 用 title（幂等复用同名组）
      group: { title: '售后工单', icon: 'ToolOutlined' },
      item: { title, icon: title.includes('短信') ? 'MessageOutlined' : 'DashboardOutlined' },
    },
    page: { title, enableTabs: false },
    defaults: {},
    tabs: [{ key: tabKey, title, blocks: [{ key: blockKey, type: 'markdown', title }] }],
    assets: {},
  };
}

async function main() {
  const token = DRY_RUN ? null : await signIn();
  for (const t of TARGETS) {
    log(`\n=== ${t.title} (${t.schemaUid}) ===`);
    // 步骤 1：删除空壳 desktopRoutes（menu 项）
    log(`  ① 删空壳 desktopRoutes id=${t.routeId}`);
    if (DRY_RUN) {
      log('     [dry-run] 将 POST /api/desktopRoutes:destroy?filterByTk=' + t.routeId);
    } else {
      const r1 = await api(`/api/desktopRoutes:destroy?filterByTk=${t.routeId}`, { token });
      log(`     → HTTP ${r1.status}${r1.status >= 400 ? ' ' + r1.text.slice(0, 120) : ''}`);
      if (r1.status >= 400) { log('     ✗ 删路由失败，跳过本页'); continue; }
    }
    // 步骤 2：删除空壳 RouteModel（flowModel 根节点）
    log(`  ② 删空壳 RouteModel uid=${t.schemaUid}`);
    if (DRY_RUN) {
      log('     [dry-run] 将 POST /api/flowModels:destroy?filterByTk=' + t.schemaUid);
    } else {
      const r2 = await api(`/api/flowModels:destroy?filterByTk=${t.schemaUid}`, { token });
      log(`     → HTTP ${r2.status}${r2.status >= 400 ? ' ' + r2.text.slice(0, 120) : ''}`);
      if (r2.status >= 400) { log('     ✗ 删模型失败，跳过本页'); continue; }
    }
    // 步骤 3：mode=create 完整重建（复用组，建菜单项 + 页面 + 区块子树）
    log(`  ③ mode=create 完整重建`);
    const doc = createDoc(t.title, t.blockKey, t.tabKey);
    if (DRY_RUN) {
      log('     [dry-run] payload=' + JSON.stringify(doc));
    } else {
      const r3 = await api('/api/flowSurfaces:applyBlueprint', { body: doc, token });
      log(`     → HTTP ${r3.status}`);
      if (r3.status >= 400 || r3.json?.errors) {
        for (const e of r3.json?.errors ?? []) log(`       [${e.ruleId ?? e.code}] ${e.path ?? ''} ${e.message ?? ''}`);
      } else {
        const uid = r3.json?.data?.pageSchemaUid ?? '(见回读)';
        log(`     ✓ 重建成功，新 schemaUid=${uid}`);
      }
    }
  }
  log('\n=== 说明 ===');
  log('  create 会完整生成：菜单项 + 页面 + RootPageModel → tab 容器 → BlockGridModel → markdown 区块。');
  log('  之后需把 markdown 区块 use 换成 HqWorkbenchBlockModel / SmsOverviewBlockModel（第二步）。');
}

main().catch((e) => { console.error('FATAL: ' + (e?.message ?? e)); process.exit(1); });
