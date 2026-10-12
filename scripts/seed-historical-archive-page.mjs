#!/usr/bin/env node
/**
 * seed-historical-archive-page.mjs —— 播种「历史售后档案」后台页面
 * （P11-3 第 4 项 · 用户 D/E 条：归档之后要能查看历史档案）
 *
 * ===========================================================================
 * 为什么单独一个脚本、单独一个页面
 * ===========================================================================
 * 🔴 用户 D 条：「目标是**独立的历史售后档案**，不是 `serviceTickets` 的 NEW 工单」
 *    以及：「保持历史记录与当前 SLA/KPI **隔离**」。
 *
 * 如果只在「历史数据导入」页上放一个区块，那么"档案"与"上传批次"会混在一屏，
 * 看的人（包括验收人）很难确认"这到底是不是当前在办工单"。
 * ⇒ 单独一页、标题就叫「历史售后档案」、列里明确带 `来源文件/工作表/原始行/映射版本`，
 *   而**没有**任何状态流转按钮 —— 它在界面上就不是工单。
 *
 * ⚠️ 本页**只读展示**：不提供任何"改档案"的入口。档案是"确认归档"的产物，
 *    改它等于改历史；撤销走单独的服务端动作，不在页面上放开。
 *
 * 幂等：与 `seed-historical-import-page.mjs` 同一套做法（按标题查 → replace/create）。
 *
 * 用法：node scripts/seed-historical-archive-page.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';

if (SVC_TLS_INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const envValue = (k, d) => {
  const m = envFile.match(new RegExp(`^${k}=(.*)$`, 'm'));
  return m ? m[1].trim() : d;
};

const PAGE_TITLE = '历史售后档案';
const NAV_GROUP = '售后工单';
const COLLECTION = 'historicalServiceArchives';

let TOKEN = '';
const log = (m) => console.log(m);

async function api(pathname, { method = 'POST', body } = {}) {
  const res = await fetch(`${SVC_BASE_URL}${pathname}`, {
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
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

async function signIn() {
  const r = await api('/api/auth:signIn', {
    body: { email: envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com'), password: envValue('SMOKE_ADMIN_PASSWORD', '') },
  });
  TOKEN = r.json?.data?.token ?? '';
  if (!TOKEN) throw new Error(`登录失败 HTTP ${r.status}`);
}

function doc() {
  return {
    version: '1',
    mode: 'create',
    navigation: {
      group: { title: NAV_GROUP, icon: 'ToolOutlined' },
      item: { title: PAGE_TITLE, icon: 'FolderOpenOutlined' },
    },
    page: { title: PAGE_TITLE, enableTabs: false },
    defaults: {
      collections: {
        historicalServiceArchives: {
          fieldGroups: [
            { key: 'a1', title: '档案', fields: ['archive_no', 'idempotency_key', 'stage', 'conversion_state'] },
            {
              key: 'a2',
              title: '来源关联',
              fields: ['batch', 'row', 'mapping_version', 'source_file_name', 'source_sheet', 'source_row'],
            },
            { key: 'a3', title: '归属', fields: ['store', 'store_code_snapshot'] },
            {
              key: 'a4',
              title: '内容',
              fields: [
                'customer_name',
                'customer_mobile',
                'customer_address',
                'device_summary',
                'service_date',
                'fields_json',
                'manual_overrides_json',
                'anomaly_snapshot_json',
              ],
            },
            { key: 'a5', title: '归档信息', fields: ['archived_by_user', 'archived_by_username', 'archived_at', 'archive_note'] },
            { key: 'a6', title: '时间戳', fields: ['createdAt', 'updatedAt'] },
          ],
        },
        // 表格里展示了 belongsTo ⇒ 目标集合也要给分组（"单值关联的目标集合"规则）
        historicalImportBatches: {
          fieldGroups: [
            {
              key: 'b1',
              title: '批次',
              fields: ['batch_no', 'file_name', 'file_hash', 'dedup_key', 'file_bytes', 'detected_kind', 'parser_name', 'parser_version'],
            },
            { key: 'b2', title: '归属', fields: ['attribution_state', 'attribution_scope', 'store', 'visibility_scope', 'stage'] },
            { key: 'b3', title: '上传者', fields: ['uploader_user', 'uploader_username', 'uploaded_at'] },
            {
              key: 'b4',
              title: '结果',
              fields: ['mapping_version', 'mapping_json', 'totals_json', 'ledger_json', 'quality_json', 'warnings_json', 'note'],
            },
            { key: 'b5', title: '时间戳', fields: ['createdAt', 'updatedAt'] },
          ],
        },
        historicalImportRows: {
          fieldGroups: [
            {
              key: 'r1',
              title: '来源行',
              fields: ['batch', 'sheet_name', 'sheet_index', 'source_row', 'header_row', 'classification', 'cells_json', 'header_json', 'source_key'],
            },
            { key: 'r2', title: '时间戳', fields: ['createdAt', 'updatedAt'] },
          ],
        },
        stores: {
          fieldGroups: [
            { key: 'store-basic', title: '门店信息', fields: ['code', 'name', 'active', 'sort_order', 'contact_phone', 'address'] },
          ],
        },
        users: { fieldGroups: [{ key: 'user-basic', title: '用户', fields: ['username', 'nickname', 'email'] }] },
      },
    },
    tabs: [
      {
        key: 'archives',
        title: '历史售后档案',
        blocks: [
          {
            key: 'archives-table',
            type: 'table',
            title: '历史售后档案',
            collection: COLLECTION,
            pageSize: 20,
            fields: [
              'archive_no',
              'store_code_snapshot',
              'source_file_name',
              'source_sheet',
              'source_row',
              'customer_name',
              'customer_mobile',
              'device_summary',
              'service_date',
              'mapping_version',
              'archived_by_username',
              'archived_at',
            ],
            actions: ['filter', 'refresh'],
            sort: ['-archivedAt'],
          },
        ],
      },
    ],
    assets: {},
  };
}

async function findPage() {
  const r = await api('/api/desktopRoutes:list?paginate=false', { method: 'GET' });
  return (r.json?.data ?? []).find((x) => x?.title === PAGE_TITLE) ?? null;
}

async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  播种「历史售后档案」页面（P11-3 第 4 项 · 用户 D/E 条）');
  console.log('══════════════════════════════════════════════════════════════');

  await signIn();
  log('  · 已登录');

  const existing = await findPage();
  const d = doc();
  if (existing) {
    d.mode = 'replace';
    d.target = { pageSchemaUid: existing.schemaUid };
    delete d.navigation;
    log(`  · 页面已存在（uid=${existing.schemaUid}）⇒ mode=replace`);
  } else {
    log('  · 页面不存在 ⇒ mode=create');
  }

  const applied = await api('/api/flowSurfaces:applyBlueprint', { body: d });
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

  const back = await findPage();
  if (!back) {
    log('✗ 写入后仍找不到页面');
    process.exit(1);
  }
  log(`  ✅ 已就绪：${PAGE_TITLE}（uid=${back.schemaUid}）`);
  log('     下一步：浏览器 → 售后工单 → 历史售后档案');
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n⛔ ${e.message}`);
  process.exit(2);
});
