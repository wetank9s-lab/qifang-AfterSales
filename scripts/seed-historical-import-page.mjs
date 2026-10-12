#!/usr/bin/env node
/**
 * seed-historical-import-page.mjs —— 播种「历史数据导入」后台页面（P11-3 第 3 项）
 *
 * ===========================================================================
 * 为什么不直接改 `seed-admin-pages.mjs`
 * ===========================================================================
 * 那个脚本已经 2100+ 行，且它对**工单**那几张表有大量互相缠绕的对账逻辑
 * （孤儿清理、按钮墙残留断言、Tab 筛选…）。把一张与之无关的新页挤进去，
 * 会让"页面清单 ↔ builder ↔ 对账断言"三处的耦合再复杂一层。
 * ⇒ 单独一个脚本：职责单一、失败不影响既有页面、可单独重跑。
 *
 * ===========================================================================
 * 播什么
 * ===========================================================================
 *   ① 一个页面「历史数据导入」，含一张 `historicalImportBatches` 的表格区块；
 *   ② 区块**工具栏**上挂 `HistoricalImportWizardModel`（导入向导按钮）。
 *
 * ⚠️ 挂载点为什么是区块工具栏：**上传**不针对任何一行。挂到行操作列会每行渲染一次。
 *
 * ===========================================================================
 * 幂等
 * ===========================================================================
 *   · 页面：先按标题查 `desktopRoutes`，存在则 mode=replace（**不能**带 navigation）；
 *   · 动作行：uid 由 `<blockUid>.historicalImport` 派生 ⇒ 同区块同 uid，
 *     `flowModels:save` 第二次是修正而不是新建（不会长出第二个按钮）。
 *
 * 用法：node scripts/seed-historical-import-page.mjs
 * 退出码：0 成功 / 1 断言失败 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';
// ⚠️ uid 派生**复用**既有的 `actionUid()`，不在这里再写一份。
//    flowModels.uid 只允许 `A-Z a-z 0-9 _-*$`（实测：`ktxvmmmo5y6.historicalImport`
//    被 500 拒掉），所以不能直接拿 `<区块uid>.<动作键>` 当 uid。
//    第二份实现的下场是"同表同动作两个 uid"，也就是**重复按钮**。
import { actionUid } from './ticket-page-actions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 演练证书是自签的 ⇒ 需要显式接受（见 lib/base-url.mjs 关于 SVC_TLS_INSECURE 的说明）。
// ⚠️ 只在**脚本侧**设，不改进程全局的 NODE_TLS_REJECT_UNAUTHORIZED 之外的东西。
if (SVC_TLS_INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const envValue = (k, d) => {
  const m = envFile.match(new RegExp(`^${k}=(.*)$`, 'm'));
  return m ? m[1].trim() : d;
};
// ⚠️ 基址走 `scripts/lib/base-url.mjs`（协议与端口的**单一事实来源**）。
//    P10-C 起 HTTP 段只做 301、不直出业务 —— 手写 `http://localhost:8080`
//    拿到的是一个 301，然后会被当成"接口返回异常"去排障（本项目的经典误导形态）。
const BASE = SVC_BASE_URL;
const ADMIN_EMAIL = envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com');
const ADMIN_PASSWORD = envValue('SMOKE_ADMIN_PASSWORD', '');

const PAGE_TITLE = '历史数据导入';
// ⚠️ 导航分组必须与既有页面**同一个**（来自 expected-sensitive-columns.mjs 的
//    ADMIN_NAV_GROUP）—— 写错会凭空多出一个分组，把后台侧边栏拆成两半。
const NAV_GROUP = '售后工单';
const COLLECTION = 'historicalImportBatches';
const ACTION_USE = 'HistoricalImportWizardModel';
const ACTION_KEY = 'historicalImport';

let TOKEN = '';
const log = (m) => console.log(m);

async function api(pathname, { method = 'POST', body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（HTML 错误页）保持 null */
  }
  return { status: res.status, json, text };
}

async function signIn() {
  const r = await api('/api/auth:signIn', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  TOKEN = r.json?.data?.token ?? '';
  if (!TOKEN) throw new Error(`登录失败（HTTP ${r.status}）：${r.text.slice(0, 200)}`);
}

/**
 * `historicalImportBatches` 的字段分组。
 *
 * ⚠️ 必须**覆盖集合的全部字段**，否则 `applyBlueprint` 报
 *    `default-field-groups-incomplete` 并**整页 400**（本项目已踩过三次同一个坑）。
 *    「列全」≠「会展示」：表格区块只声明下面 LIST_FIELDS 那几列。
 */
const FIELD_GROUPS = [
  {
    key: 'batch-basic',
    title: '批次信息',
    fields: [
      'batch_no',
      'file_name',
      'file_hash',
      'file_bytes',
      'detected_kind',
      'parser_name',
      'parser_version',
    ],
  },
  {
    key: 'batch-attribution',
    title: '归属与可见范围',
    // 🔴 界面上**不会**提供门店选择：门店对应关系尚未确认，本阶段恒为未确认。
    fields: ['attribution_state', 'store', 'visibility_scope', 'stage'],
  },
  {
    key: 'batch-uploader',
    title: '上传者',
    fields: ['uploader_user', 'uploader_username', 'uploaded_at'],
  },
  {
    key: 'batch-result',
    title: '解析结果',
    fields: [
      'mapping_version',
      'mapping_json',
      'totals_json',
      'ledger_json',
      'quality_json',
      'warnings_json',
      'note',
    ],
  },
  // ⚠️ 时间戳列也必须分组 —— 校验器把它们算进"必须覆盖"的全集
  //    （实测报 `missingFieldNames: ["createdAt","updatedAt"]`）。
  { key: 'batch-timing', title: '时间戳', fields: ['createdAt', 'updatedAt'] },
];

const LIST_FIELDS = [
  'batch_no',
  'file_name',
  'detected_kind',
  'stage',
  'attribution_state',
  'mapping_version',
  'uploader_username',
  'uploaded_at',
];

function pageDoc() {
  return {
    version: '1',
    mode: 'create',
    navigation: {
      group: { title: NAV_GROUP, icon: 'ToolOutlined' },
      item: { title: PAGE_TITLE, icon: 'ImportOutlined' },
    },
    page: { title: PAGE_TITLE, enableTabs: false },
    defaults: {
      collections: {
        [COLLECTION]: { fieldGroups: FIELD_GROUPS },
        // 表格里展示了 `store` 关联 ⇒ 目标集合也要给分组（"单值关联的目标集合"规则）
        stores: {
          fieldGroups: [
            {
              key: 'store-basic',
              title: '门店信息',
              fields: ['code', 'name', 'active', 'sort_order', 'contact_phone', 'address'],
            },
          ],
        },
        // ⚠️ 校验器会为单值关联自动生成一个 details 区块，并要求**至少 3 个可见字段**
        //    （实测报 `data-block-visible-fields-minimum`）。
        //    只给 username/nickname 两个是不够的 —— 补一个 email 才达标。
        users: {
          fieldGroups: [
            { key: 'user-basic', title: '用户', fields: ['username', 'nickname', 'email'] },
          ],
        },
      },
    },
    tabs: [
      {
        key: 'batches',
        title: '导入批次',
        blocks: [
          {
            key: 'batches-table',
            type: 'table',
            title: '导入批次',
            collection: COLLECTION,
            pageSize: 20,
            fields: LIST_FIELDS,
            actions: ['filter', 'refresh'],
            sort: ['-createdAt'],
          },
        ],
      },
    ],
    assets: {},
  };
}

async function findPage() {
  const r = await api('/api/desktopRoutes:list?paginate=false', { method: 'GET' });
  const rows = r.json?.data ?? [];
  return rows.find((x) => x?.title === PAGE_TITLE) ?? null;
}

/**
 * 找到本页的表格区块。
 *
 * ⚠️ 判据是 `stepParams.__flowSurfaceMeta.declaredKey`（**不是**顶层 `declaredKey`）——
 *    实测 `flowModels:list` 返回的节点里 `declaredKey` 根本不在顶层，
 *    按顶层字段筛会永远筛不到（表现为"页面上没有这个区块"，而区块其实好好地在那儿）。
 *    `flowModels:list?filter={"parentId":…}` 会 400（parentId 不可过滤），
 *    所以只能取全量再在本地筛 —— 与 `seed-admin-pages.mjs` 同一做法。
 */
async function findBlockForCollection(collection) {
  const r = await api('/api/flowModels:list?paginate=false', { method: 'GET' });
  const rows = r.json?.data ?? [];
  return rows.filter((n) => {
    if (n.use !== 'TableBlockModel') return false;
    const bag = JSON.stringify(n.stepParams ?? {}) + JSON.stringify(n.props ?? {});
    return bag.includes(collection);
  });
}

async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  播种「历史数据导入」页面（P11-3 第 3 项）');
  console.log('══════════════════════════════════════════════════════════════');

  await signIn();
  log(`  · 已登录 ${ADMIN_EMAIL}`);

  const existing = await findPage();
  const doc = pageDoc();
  if (existing) {
    doc.mode = 'replace';
    doc.target = { pageSchemaUid: existing.schemaUid };
    delete doc.navigation;
    log(`  · 页面已存在（uid=${existing.schemaUid}）⇒ mode=replace`);
  } else {
    log('  · 页面不存在 ⇒ mode=create');
  }

  const applied = await api('/api/flowSurfaces:applyBlueprint', { body: doc });
  if (applied.status >= 400 || applied.json?.errors) {
    log(`\n✗ 应用失败 HTTP ${applied.status}`);
    for (const e of applied.json?.errors ?? []) {
      log(`  [${e.ruleId}] ${e.path}`);
      log(`    ${e.message}`);
      if (e.details) log(`    details = ${JSON.stringify(e.details)}`);
    }
    if (!applied.json?.errors) log(`  ${applied.text.slice(0, 600)}`);
    process.exit(1);
  }
  log('  ✓ 页面已写入');

  // ---- 找到本页的表格区块，挂向导按钮 ----
  const mine = await findBlockForCollection(COLLECTION);
  const target = mine[0] ?? null;
  if (!target) {
    log(`✗ 找不到 ${COLLECTION} 的表格区块（本轮页面写入后应当存在）`);
    process.exit(1);
  }
  const blockUid = target.uid;
  const declaredKey = target.stepParams?.__flowSurfaceMeta?.declaredKey ?? '(无)';
  log(`  · 表格区块 uid=${blockUid}（declaredKey=${declaredKey}）`);

  const rowUid = actionUid(blockUid, ACTION_KEY);
  const row = {
    uid: rowUid,
    name: rowUid,
    parentId: blockUid,
    subKey: 'actions',
    subType: 'array',
    use: ACTION_USE,
    props: { type: 'default', iconOnly: false, children: '上传历史 Excel' },
    decoratorProps: {},
    stepParams: {
      __flowSurfaceMeta: { declaredKey: `svc.${blockUid}.${ACTION_KEY}` },
    },
    flowRegistry: {},
    sortIndex: 1,
  };
  const saved = await api('/api/flowModels:save', { body: row });
  if (saved.status >= 400) {
    log(`✗ 动作行写入失败 HTTP ${saved.status} ${saved.text.slice(0, 300)}`);
    process.exit(1);
  }
  const got = typeof saved.json?.data === 'string' ? saved.json.data : rowUid;
  if (got !== rowUid) {
    log(`✗ 写入返回非预期 uid（期望 ${rowUid}，实得 ${got}）`);
    process.exit(1);
  }
  log(`  ✓ 已挂「上传历史 Excel」按钮（uid=${rowUid}）`);

  // ---- 回读断言 ----
  const back = await api(`/api/flowModels:list?filter=${encodeURIComponent(JSON.stringify({ uid: rowUid }))}`, {
    method: 'GET',
  });
  const rows = back.json?.data ?? [];
  const node = rows.find((n) => n.uid === rowUid);
  const okNode =
    !!node &&
    node.parentId === blockUid &&
    node.subKey === 'actions' &&
    node.subType === 'array' &&
    node.use === ACTION_USE;
  if (!okNode) {
    log(`✗ 回读失败：节点形状不对 —— ${JSON.stringify(node ?? null).slice(0, 300)}`);
    process.exit(1);
  }
  log(`  ✓ 回读确认：父=${node.parentId} subKey=${node.subKey} use=${node.use}`);

  // ---- 孤儿收敛 ----
  //
  // 🔴 `mode=replace` 每次都会**重建** TableBlock 并换 uid
  //    （本轮实测：区块 uid 从 `ktxvmmmo5y6` 变成 `x31n7g4mwus`）。
  //    于是上一轮挂在旧区块下的动作行会变成"父不存在的孤儿"。
  //    不清理的话，每跑一次播种就多留一行 —— 那正是用户明令禁止的"重复按钮"。
  //    ⚠️ 这与"库里写对了 ≠ 界面上出现"是同一类事实，必须用断言守住。
  const all = await api('/api/flowModels:list?paginate=false', { method: 'GET' });
  const nodes = all.json?.data ?? [];
  const live = new Set(nodes.map((n) => n.uid));
  const orphans = nodes.filter((n) => n.use === ACTION_USE && !live.has(n.parentId));
  let removed = 0;
  for (const o of orphans) {
    const del = await api('/api/flowSurfaces:removeNode', { body: { target: { uid: o.uid } } });
    if (del.status < 400) removed += 1;
  }
  const after = await api('/api/flowModels:list?paginate=false', { method: 'GET' });
  const remain = (after.json?.data ?? []).filter((n) => n.use === ACTION_USE);
  log(`  · 孤儿收敛：清理 ${removed} 行；现存向导动作行 ${remain.length}（要求恰好 1）`);
  if (remain.length !== 1) {
    log(`✗ 向导动作行 ${remain.length} ≠ 1 —— 页面上会出现重复按钮`);
    process.exit(1);
  }

  log('');
  log('  ✅ 页面与入口就绪。下一步：浏览器打开后台 → 售后工单 → 历史数据导入');
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n⛔ ${e.message}`);
  process.exit(2);
});
