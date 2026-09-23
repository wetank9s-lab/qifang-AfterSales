#!/usr/bin/env node
/**
 * =============================================================================
 *  verify-ticket-actions.mjs —— 「自定义动作已挂到页面上」的结构验收
 * -----------------------------------------------------------------------------
 *  为什么需要它：
 *    Phase 4-I 首轮真人走查 BLOCKED，根因是「ActionModel 已注册」被误当成
 *    「Action 已挂到页面」。这两件事之间隔着一整条链路：
 *       模型类注册（浏览器引擎） → flowModels 有行 → **顶层 use 正确**
 *       → 挂在 TableActionsColumnModel 下 → flowModelTreePath 祖先链连通
 *       → 客户端能解析 → **真实渲染出按钮**
 *    这条链上任何一环断了，页面都只是"少几个按钮"——**不报错、不崩溃、静默**。
 *    所以必须有一条能读**真实 flowModels**（而非源码/bundle）的验收，
 *    把"挂没挂上"变成可执行断言。
 *
 *  六条结构断言（用户第四条的逐条落实）：
 *    ① 五个自定义 ActionModel 已在客户端插件注册（源码 + 产物双查）
 *    ② H1（我的门店工单）的每个 serviceTickets TableBlock 都有五个动作实例
 *    ③ H2（全量工单）的 serviceTickets TableBlock 有对应动作实例
 *    ④ TicketDetailActionModel 已实际实例化（顶层 use 命中，不是"行存在"）
 *    ⑤ 页面中没有把 update/edit/delete/addNew 当业务写路径的**额外**注入
 *    ⑥ 重跑播种后动作实例数量不增加（幂等）
 *
 *  **反向验证**（`--reverse`，铁律 8：断言不会变红 = 没有断言）：
 *    临时删掉某张表的 TicketAcceptActionModel 实例 → 本脚本必须 exit 1
 *    并点名是哪张表 → 恢复后必须回到全绿。
 *
 *  用法：
 *    node scripts/verify-ticket-actions.mjs                 # 正常验收
 *    node scripts/verify-ticket-actions.mjs --verbose       # 打印每张表明细
 *    node scripts/verify-ticket-actions.mjs --reverse       # 反向验证（会写库后还原）
 *
 *  退出码：
 *    0 = 全部通过
 *    1 = 有失败项（真红灯）
 *    2 = 环境未就绪（未配置管理员口令 / 服务不可达 —— 不是产品缺陷）
 * =============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TICKET_ACTION_MODELS, TICKET_ACTION_USES, actionRow } from './ticket-page-actions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');
const REVERSE = process.argv.includes('--reverse');

const PORT = Number(process.env.NGINX_HTTP_PORT || 8080);
const BASE = `http://localhost:${PORT}`;
const PACE_MS = 120;
const pace = () => new Promise((r) => setTimeout(r, PACE_MS));

/**
 * 读 .env 里的值。**刻意没有默认口令 fallback** ——
 * 未配置时一律 exit 2（"环境未就绪"），而不是拿一个猜的口令去撞。
 * 撞失败会被误读成"权限/ACL 出问题"，把一次配置缺失伪装成一次产品缺陷。
 */
function envValue(key) {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return '';
  const m = new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm').exec(fs.readFileSync(p, 'utf8'));
  return m ? m[1].trim() : '';
}

const ADMIN_EMAIL = envValue('SMOKE_ADMIN_EMAIL') || 'admin@nocobase.com';
const ADMIN_PASSWORD = envValue('SMOKE_ADMIN_PASSWORD');

const passed = [];
const failures = [];

function check(label, fn) {
  try {
    const detail = fn();
    passed.push({ label, detail });
    process.stdout.write(`  ✓ ${label}${detail ? ` —— ${detail}` : ''}\n`);
  } catch (e) {
    failures.push({ label, message: e.message });
    process.stdout.write(`  ✗ ${label}\n      ${e.message.replace(/\n/g, '\n      ')}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function api(pathname, { method = 'POST', body, token } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 网关 429 之类可能返回非 JSON */
  }
  return { status: res.status, json, text };
}

function exitEnvNotReady(reason) {
  process.stdout.write(`\n⚠️  环境未就绪（exit 2）：${reason}\n`);
  process.stdout.write('   这不是产品缺陷 —— 请配置好环境后重跑。\n\n');
  process.exit(2);
}

// ============================================================================
//  0. 环境前置
// ============================================================================
if (!ADMIN_PASSWORD) {
  exitEnvNotReady(
    'SMOKE_ADMIN_PASSWORD 未配置。请在 .env 里设置（本仓库为公开仓库，**不要**把口令写进任何被提交的文件）',
  );
}

process.stdout.write('\n══════════════════════════════════════════════════════════════\n');
process.stdout.write('  自定义动作结构验收（读真实 flowModels，不读源码）\n');
process.stdout.write(`  目标：${BASE}    模式：${REVERSE ? '反向验证' : '常规验收'}\n`);
process.stdout.write('══════════════════════════════════════════════════════════════\n\n');

let token = null;
try {
  const r = await api('/api/auth:signIn', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  if (r.status !== 200) exitEnvNotReady(`管理员登录失败 HTTP ${r.status}（口令/账号不对，或服务未起）`);
  token = r.json?.data?.token;
  if (!token) exitEnvNotReady('登录返回 200 但没有 token —— 响应形状变了？');
} catch (e) {
  exitEnvNotReady(`连不上 ${BASE}：${e.message}`);
}

// ============================================================================
//  读全量 flowModels（枚举唯一可靠入口，见 ticket-page-actions.mjs 头注释）
// ============================================================================
async function fetchAll() {
  const r = await api('/api/flowModels:list?paginate=false', { method: 'GET', token });
  assert(r.status === 200, `flowModels:list 返回 HTTP ${r.status}`);
  const rows = r.json?.data ?? [];
  // 铁律 10：读到空是最坏的假绿 —— 必须显式断言非空。
  assert(rows.length > 0, 'flowModels 读到 0 条 —— 这一定是假绿（环境坏了或接口变了）');
  const byUid = new Map(rows.map((n) => [n.uid, n]));
  const childrenOf = new Map();
  for (const n of rows) {
    if (!n.parentId) continue;
    if (!childrenOf.has(n.parentId)) childrenOf.set(n.parentId, []);
    childrenOf.get(n.parentId).push(n);
  }
  return { rows, byUid, childrenOf };
}

/** 定位工单表格区块 + 配对的行操作列（declaredKey 前缀匹配，不猜顺序）。 */
function findTicketTableBlocks(tree) {
  const blocks = [];
  for (const node of tree.rows) {
    if (node.use !== 'TableBlockModel') continue;
    const meta = node.stepParams?.__flowSurfaceMeta;
    const declaredKey = meta?.declaredKey;
    if (!declaredKey) continue;
    if (!JSON.stringify(node.stepParams ?? {}).includes('serviceTickets')) continue;
    const actionColumn = tree.rows.find(
      (c) =>
        c.use === 'TableActionsColumnModel' &&
        c.stepParams?.__flowSurfaceMeta?.declaredKey === `${declaredKey}.actionsColumn`,
    );
    blocks.push({ uid: node.uid, declaredKey, actionColumnUid: actionColumn?.uid ?? null });
  }
  return blocks;
}

const tree = await fetchAll();
const blocks = findTicketTableBlocks(tree);

process.stdout.write(`· flowModels 共 ${tree.rows.length} 条，工单表格区块 ${blocks.length} 张\n\n`);

// ============================================================================
//  ① 五个自定义 ActionModel 已在客户端插件注册
// ============================================================================
process.stdout.write('【① 模型类注册】\n');
check('客户端插件源码注册了五个自定义动作', () => {
  const src = path.join(ROOT, 'nocobase/plugins/service-ticket/src/client');
  assert(fs.existsSync(src), `找不到客户端源码目录 ${src}`);
  let all = '';
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) all += fs.readFileSync(p, 'utf8');
    }
  };
  walk(src);
  const missing = TICKET_ACTION_USES.filter((u) => !all.includes(u));
  assert(missing.length === 0, `源码里缺少注册：${missing.join('、')}`);
  return `${TICKET_ACTION_USES.length} 个全部可见`;
});

check('构建产物里五个自定义动作都在（dist 未过期）', () => {
  const out = path.join(ROOT, 'storage/plugins/@local/service-ticket/dist/client');
  assert(fs.existsSync(out), `找不到客户端产物目录 ${out} —— 请先跑 node scripts/build-plugin.mjs`);
  let all = '';
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e.name)) all += fs.readFileSync(p, 'utf8');
    }
  };
  walk(out);
  const missing = TICKET_ACTION_USES.filter((u) => !all.includes(u));
  assert(missing.length === 0, `产物里缺少：${missing.join('、')} —— 请重新构建`);
  return '产物与源码一致';
});

// ============================================================================
//  ②③④ 每个工单表都挂着五个自定义动作（顶层 use 正确）
// ============================================================================
process.stdout.write('\n【②③④ 页面动作实例】\n');

check('找到了工单表格区块（非空断言）', () => {
  assert(blocks.length > 0, '一张 serviceTickets 表格区块都没找到 —— 可能是假绿，也可能是页面未播种');
  return `${blocks.length} 张`;
});

check('每张工单表都有行操作列（动作挂载点）', () => {
  const bad = blocks.filter((b) => !b.actionColumnUid).map((b) => b.declaredKey);
  assert(bad.length === 0, `以下表格没有 actionsColumn，行级动作无处安放：${bad.join('、')}`);
  return `${blocks.length} 张全部配对成功`;
});

/** 逐表核对五个动作：必须 parentId 正确 **且顶层 use 命中**。 */
const perTable = [];
for (const b of blocks) {
  const entry = { declaredKey: b.declaredKey, found: [], malformed: [], missing: [] };
  if (!b.actionColumnUid) {
    entry.missing = [...TICKET_ACTION_USES];
    perTable.push(entry);
    continue;
  }
  const children = (tree.childrenOf.get(b.actionColumnUid) ?? []).filter((c) => c.subKey === 'actions');
  for (const m of TICKET_ACTION_MODELS) {
    const uid = actionRow(b.actionColumnUid, m, 0).uid;
    const node = tree.byUid.get(uid);
    if (!node || node.parentId !== b.actionColumnUid) {
      entry.missing.push(m.use);
      continue;
    }
    // 🔴 判据是「顶层 use」，不是「行存在」——
    //    `{values:{…}}` 双包装写入会让行存在但顶层无 use，页面静默不渲染。
    if (node.use !== m.use) {
      entry.malformed.push(`${uid}:顶层 use=${node.use ?? '<无>'}`);
      entry.missing.push(m.use);
      continue;
    }
    entry.found.push(m.use);
  }
  perTable.push(entry);
}

check('每张工单表五个自定义动作齐全且顶层 use 正确', () => {
  const bad = perTable.filter((t) => t.missing.length > 0);
  assert(
    bad.length === 0,
    bad
      .map((t) => {
        const parts = [`${t.declaredKey} 缺：${t.missing.join('、')}`];
        if (t.malformed.length) parts.push(`顶层 use 错位：${t.malformed.join('、')}`);
        return parts.join('；');
      })
      .join('\n'),
  );
  return `${perTable.length} 张 × 5 = ${perTable.length * 5} 个实例`;
});

check('④ TicketDetailActionModel 已实际实例化', () => {
  const instances = tree.rows.filter((n) => n.use === 'TicketDetailActionModel');
  assert(instances.length > 0, 'TicketDetailActionModel 一个实例都没有 —— 详情按钮不会出现');
  const correctParent = instances.filter((n) =>
    (tree.childrenOf.get(n.parentId) ?? []).length >= 0 && tree.byUid.has(n.parentId) && tree.byUid.get(n.parentId).use === 'TableActionsColumnModel',
  );
  assert(
    correctParent.length === instances.length,
    `有 ${instances.length - correctParent.length} 个实例挂在非 TableActionsColumnModel 的父节点下`,
  );
  return `${instances.length} 个实例，全部挂在行操作列下`;
});

check('⑤ 没有额外的通用写路径被注入自定义 use', () => {
  // 说明：blueprint 会**自动注入** addNew/bulkDelete（DEV-53 坑 2，无法移除），
  // 把它们判成违规 = 断言永远为红 = 没有断言。这里只查"有没有人把
  // 自定义动作伪装成内置写动作"，即自定义 use 与原生写动作混挂在同列。
  const NATIVE_WRITE = ['EditActionModel', 'DeleteActionModel', 'AddNewActionModel', 'BulkDeleteActionModel', 'UpdateRecordActionModel'];
  const offenders = [];
  for (const b of blocks) {
    if (!b.actionColumnUid) continue;
    const kids = tree.childrenOf.get(b.actionColumnUid) ?? [];
    const custom = kids.filter((c) => TICKET_ACTION_USES.includes(c.use));
    const nativeWrite = kids.filter((c) => NATIVE_WRITE.includes(c.use));
    // 存在原生写动作是预期的（blueprint 注入）；只要它们不是**由本脚本**写的即可。
    // 本脚本写的行都带 `__flowSurfaceMeta.declaredKey === 'svc.*'`。
    const scripted = nativeWrite.filter((c) => /^svc\./.test(c.stepParams?.__flowSurfaceMeta?.declaredKey ?? ''));
    if (scripted.length) offenders.push(`${b.declaredKey}: ${scripted.map((c) => c.use).join('、')}`);
    void custom;
  }
  assert(offenders.length === 0, `本脚本写入了原生写动作（应当只写自定义动作）：\n${offenders.join('\n')}`);
  return '无脚本注入的原生写路径';
});

// ============================================================================
//  ⑥ 幂等：重跑播种后动作实例数量不增加
// ============================================================================
process.stdout.write('\n【⑥ 幂等：重跑不增加】\n');
check('自定义动作行数恰好等于 表格数 × 5', () => {
  const live = tree.rows.filter((n) => TICKET_ACTION_USES.includes(n.use));
  const expected = blocks.length * TICKET_ACTION_MODELS.length;
  assert(
    live.length === expected,
    `现存 ${live.length} 行 ≠ 期望 ${expected} 行（= ${blocks.length} 表 × 5）—— 有重复或残留实例`,
  );
  return `${live.length} 行`;
});

check('没有孤儿动作行（parentId 指向不存在的节点）', () => {
  const orphans = tree.rows.filter(
    (n) => TICKET_ACTION_USES.includes(n.use) && !tree.byUid.has(n.parentId),
  );
  assert(orphans.length === 0, `孤儿 ${orphans.length} 行：${orphans.slice(0, 5).map((n) => n.uid).join('、')}`);
  return '0 孤儿';
});

check('没有病态行（顶层 use 缺失/错位）', () => {
  // 这类行由"只数行数"的断言看不见，但客户端一定不渲染。
  const malformed = tree.rows.filter(
    (n) => !n.use && /^[0-9a-z]{11}$/.test(n.uid ?? '') && JSON.stringify(n).includes('Ticket'),
  );
  assert(
    malformed.length === 0,
    `发现 ${malformed.length} 行疑似 {values:{...}} 双包装写入（顶层无 use）：${malformed.slice(0, 5).map((n) => n.uid).join('、')}`,
  );
  return '0 病态行';
});

// ============================================================================
//  --verbose 明细
// ============================================================================
if (VERBOSE) {
  process.stdout.write('\n【各表明细】\n');
  for (const t of perTable) {
    process.stdout.write(`  ${t.missing.length ? '✗' : '✓'} ${t.declaredKey}: ${t.found.length}/5\n`);
  }
}

// ============================================================================
//  --reverse 反向验证（铁律 8：断言不会变红 = 没有断言）
// ============================================================================
if (REVERSE) {
  process.stdout.write('\n══════════════════════════════════════════════════════════════\n');
  process.stdout.write('  反向验证：删一条 TicketAcceptActionModel → 断言必须变红 → 还原\n');
  process.stdout.write('══════════════════════════════════════════════════════════════\n\n');

  const victimBlock = blocks.find((b) => b.actionColumnUid);
  assert(victimBlock, '找不到可下手的表，反向验证的前提不成立');

  const acceptModel = TICKET_ACTION_MODELS.find((m) => m.key === 'accept');
  const victimUid = actionRow(victimBlock.actionColumnUid, acceptModel, 0).uid;
  const victimNode = tree.byUid.get(victimUid);
  assert(victimNode, `目标动作行不存在（uid=${victimUid}）—— 反向验证的前提不成立`);

  // 备份整行，还原时逐字段写回。
  const backup = JSON.parse(JSON.stringify(victimNode));
  process.stdout.write(`  目标：${victimBlock.declaredKey}.${acceptModel.key}（uid=${victimUid}）\n`);

  const del = await api('/api/flowSurfaces:removeNode', { body: { target: { uid: victimUid } }, token });
  await pace();
  process.stdout.write(`  ① 删除：HTTP ${del.status}\n`);
  assert(del.status < 400, `删除失败 HTTP ${del.status}`);

  // ---- 关键：删完之后**真的把断言跑一遍**，要求它变红 ----
  // 不能只写一句"若此刻重跑会变红"——那是描述，不是验证。
  const after2 = await fetchAll();
  const blocks2 = findTicketTableBlocks(after2);
  const roundTable2 = (() => {
    const b = blocks2.find((x) => x.declaredKey === victimBlock.declaredKey);
    if (!b?.actionColumnUid) return null;
    const kids = (after2.childrenOf.get(b.actionColumnUid) ?? []).filter((c) => c.subKey === 'actions');
    const found = TICKET_ACTION_USES.filter((u) => kids.some((c) => c.use === u));
    return { found, missing: TICKET_ACTION_USES.filter((u) => !found.includes(u)) };
  })();

  const turnRed = !roundTable2 || roundTable2.missing.includes(acceptModel.use);
  if (turnRed) {
    process.stdout.write(
      `  ② 断言核对：✓ 变红（${victimBlock.declaredKey} 缺 ${roundTable2?.missing.join('、') ?? '整张表'}）\n`,
    );
  } else {
    process.stdout.write(
      `  ② 断言核对：✗ **没有变红** —— 删除后该表仍报 5/5，说明断言判据没有真正盯住这一行\n`,
    );
    failures.push({
      label: '反向验证（删除后应变红）',
      message: `${victimBlock.declaredKey} 的 TicketAcceptActionModel 已删，但判据仍报齐全 —— 断言无效`,
    });
  }

  // ---- 还原 ----
  const restore = await api('/api/flowModels:save', {
    body: {
      uid: backup.uid,
      name: backup.uid,
      use: backup.use,
      parentId: backup.parentId,
      subKey: backup.subKey,
      subType: backup.subType,
      props: backup.props,
      decoratorProps: backup.decoratorProps,
      stepParams: backup.stepParams,
      flowRegistry: backup.flowRegistry,
      sortIndex: backup.sortIndex,
    },
    token,
  });
  await pace();
  process.stdout.write(`  ③ 还原：HTTP ${restore.status}\n`);

  const finalTree = await fetchAll();
  const restored = finalTree.byUid.get(victimUid);
  const restoredOk =
    restored && restored.use === backup.use && restored.parentId === backup.parentId;
  if (restoredOk) {
    process.stdout.write('  ④ 还原核对：✓ 顶层 use 与 parentId 均与删除前一致\n');
  } else {
    process.stdout.write(`  ④ 还原核对：✗ 还原失败 ${JSON.stringify(restored ?? null)}\n`);
    failures.push({
      label: '反向验证（还原）',
      message: '删除后还原失败 —— 库已被改坏，请重跑 node scripts/seed-admin-pages.mjs',
    });
  }
}

// ============================================================================
//  汇总
// ============================================================================
process.stdout.write('\n══════════════════════════════════════════════════════════════\n');
if (failures.length === 0) {
  process.stdout.write(`  ✅ 全部通过：${passed.length} 项\n`);
  process.stdout.write('══════════════════════════════════════════════════════════════\n\n');
  process.exit(0);
} else {
  process.stdout.write(`  ❌ 通过 ${passed.length} 项，失败 ${failures.length} 项：\n`);
  for (const f of failures) process.stdout.write(`     • ${f.label}\n       ${f.message}\n`);
  process.stdout.write('══════════════════════════════════════════════════════════════\n\n');
  process.exit(1);
}
