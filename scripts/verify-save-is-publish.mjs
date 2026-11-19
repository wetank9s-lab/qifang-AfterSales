#!/usr/bin/env node
/**
 * verify-save-is-publish.mjs —— R2.2.1 用户第 7.4 条「保存即正式发布」的门禁。
 *
 * ===========================================================================
 * 用户原话
 * ===========================================================================
 * 「7.4 保存即正式发布 —— **必须修改实际服务端默认创建行为，不能只隐藏前端按钮**」
 * 「现有草稿不允许未经批准批量自动发布」
 * 「数据库字段保留、不做破坏性迁移」
 * 「`status` 与 `visibility` 不可混淆」
 *
 * ===========================================================================
 * 判据（每条都能变红）
 * ===========================================================================
 *   S1  **代码层**：`archive-service.ts` 的 create 里 `visibility` 赋的是 PUBLISHED
 *       （不是 DRAFT）。这是"改服务端而不是藏按钮"的机械证据。
 *   S2  **代码层**：`published_at` 与 `visibility` 在**同一条** create 调用里
 *       （不能分两步，否则存在 published 但 published_at 为空的窗口）。
 *   S3  **运行期**：真建一条档案 → 直接读库，`visibility='published'` 且
 *       `published_at` 非空。
 *   S4  **运行期**：同一时刻 `status` 仍是 `pending` —— 证明 status 与 visibility
 *       **没有**被混为一谈（发布 ≠ 完工）。
 *   S5  **不回溯**：建单前后统计 `visibility='draft'` 的总数**不变** —— 证明这次改动
 *       **没有**顺手把存量草稿批量发布。
 *   S6  **字段保留**：`visibility` / `status` / `published_at` 三列仍在（无破坏性迁移）。
 *   S7  **可证伪对照**：把 create 代码改回 DRAFT 时 S1 必须红（内存里改，不改源文件）。
 *
 * ⚠️ 自建档案在 finally 里按 id 级联删除，并**强校验删除行数**。
 * 用法：node scripts/verify-save-is-publish.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { SVC_BASE_URL } from './lib/base-url.mjs';
import { envValue, http, signIn } from './technician-harness.mjs';

/**
 * 测试口令**只在 .env 里**（`ARC_TEST_PW`）。
 * 2026-11-19 R2.2.1 封版审计：本文件原先硬编码了 `arc1.*` 测试账号口令，
 * 而 `docs/R2-SECURITY-FREEZE.md` 早已判定「脚本硬编码测试凭据 = 高危、排除出提交」。
 * 改成读 .env 之后，源码里不再有可用的凭据字面量，同时脚本仍能直接跑。
 */
const ARC_TEST_PW = envValue("ARC_TEST_PW");

const ROOT = path.resolve(import.meta.dirname, '..');
const SVC_SRC = path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/services/archive-service.ts');

const out = [];
const rec = (id, ok, d) => {
  out.push({ id, ok: !!ok });
  console.log(`${ok ? '✓' : '✗'} ${id} ${d}`);
};

const psql = (sql) =>
  execSync(`docker exec svc-postgres psql -U svc_app -d service_ticket -t -A -c ${JSON.stringify(sql)}`, {
    encoding: 'utf8',
  }).trim();

async function main() {
  // ── S1 / S2 代码层 ────────────────────────────────────────────────────────
  const src = fs.readFileSync(SVC_SRC, 'utf8');
  // 只取 create 方法里的 create 调用片段，避免撞上 publish() 里的 PUBLISHED
  const createStart = src.indexOf('async create(');
  const createEnd = src.indexOf('async update(');
  const createBody = src.slice(createStart, createEnd);

  const visLine = (createBody.match(/visibility:\s*ARCHIVE_VISIBILITY\.(\w+)/) ?? [])[1] ?? '(未找到)';
  rec('S1-server-side-published', visLine === 'PUBLISHED',
    `create 里 visibility = ARCHIVE_VISIBILITY.${visLine}（须 PUBLISHED；改前端按钮不会改变这一行）`);

  const sameCall = /values:\s*\{[\s\S]*?visibility:\s*ARCHIVE_VISIBILITY\.PUBLISHED[\s\S]*?published_at:/.test(createBody);
  rec('S2-same-insert', sameCall, `published_at 与 visibility 在同一 values 对象内=${sameCall}（分两步会有空窗）`);

  // ── S5 基线：建单前草稿数 ─────────────────────────────────────────────────
  const draftBefore = Number(psql("SELECT count(*) FROM service_archives WHERE visibility='draft';"));
  const totalBefore = Number(psql('SELECT count(*) FROM service_archives;'));

  // ── S6 三列仍在 ───────────────────────────────────────────────────────────
  const cols = psql(
    "SELECT column_name FROM information_schema.columns WHERE table_name='service_archives' AND column_name IN ('visibility','status','published_at') ORDER BY 1;",
  ).split('\n').filter(Boolean);
  rec('S6-columns-kept', cols.length === 3, `列存在=${JSON.stringify(cols)}（须 3 列全在，无破坏性迁移）`);

  // ── S3 / S4 / S5 运行期 ───────────────────────────────────────────────────
  // ⚠️ 不能用 `arc1.mgr.a`（门店经理是**只读**角色，archiveCreate 会 403
  //    `ARCHIVE_FORBIDDEN 当前角色无档案写入权限`）。建档要门店销售。
  const token = await signIn('arc1.sales.a@svc.local', ARC_TEST_PW);
  const mobile = `138${String(Date.now()).slice(-8)}`;
  const created = await http(`${SVC_BASE_URL}/api/svc:archiveCreate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID(), Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      store_id: 1,
      archive_type: 'hvac',
      customer_name: 'R221PUBLISH验收',
      customer_mobile: mobile,
      service_address: '验收地址（脚本自建）',
    }),
  });
  // ⚠️ 判据看 `created.status`，不看 `created.ok` —— 本仓库的 `http()` 返回体
  //    在成功时 `ok` 可能为 false（历史遗留的 ok 语义对 SPA 请求不适用），
  //    用 `ok` 会在 HTTP 200 时报"失败"，把真实成功误判成故障。
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`archiveCreate 失败 HTTP ${created.status} ${String(created.body).slice(0, 240)}`);
  }
  // 🔴 响应形状是 { data: { archive: { id } } } —— 不是扁平 data.id（第一次就栽在这里）
  const id = Number(created.json?.data?.archive?.id ?? 0);
  // 🔴 取不到 id 时**先删再抛**：本步骤确实已经建了一条档案，若直接 throw，
  //    `finally` 不会执行（try 还没进），库里就留下一条 `R221PUBLISH验收` 脏数据。
  //    真实发生过：第一次跑 FATAL 后残留 id=370，靠手工 SQL 才清掉。
  //    ⇒ 造数据脚本的"清理"必须覆盖到"取 id 之后、断言之前"的每一条退出路径。
  if (!id) {
    // 兜底：按 customer_name + 手机号定位并清掉，避免留脏数据
    try {
      const strayId = Number(
        psql(`SELECT id FROM service_archives WHERE customer_mobile='${mobile}' ORDER BY id DESC LIMIT 1;`) || 0,
      );
      if (strayId) {
        psql(
          'WITH e AS (DELETE FROM service_archive_events WHERE archive_id=' + strayId + ' RETURNING 1), ' +
          's AS (DELETE FROM service_archive_stages WHERE archive_id=' + strayId + ' RETURNING 1), ' +
          'p AS (DELETE FROM service_archive_photos WHERE archive_id=' + strayId + ' RETURNING 1), ' +
          'a AS (DELETE FROM service_archives WHERE id=' + strayId + ' RETURNING 1) ' +
          'SELECT count(*) FROM a;',
        );
        console.log(`  （已兜底清理未取到 id 的档案 id=${strayId}）`);
      }
    } catch (cleanupErr) {
      console.log(`  ⚠️ 兜底清理失败，请手工核对 mobile=${mobile}：${cleanupErr?.message ?? cleanupErr}`);
    }
    throw new Error(`未取到档案 id：${String(created.body).slice(0, 240)}`);
  }

  try {
    const row = psql(
      `SELECT visibility || '|' || status || '|' || coalesce(published_at::text,'NULL') FROM service_archives WHERE id=${id};`,
    );
    const [vis, status, pubAt] = row.split('|');
    rec('S3-runtime-published', vis === 'published' && pubAt !== 'NULL' && pubAt !== '',
      `id=${id} visibility=${vis} published_at=${pubAt}`);
    rec('S4-status-not-confused', status === 'pending',
      `status=${status}（须 pending —— 发布 ≠ 完工，两者正交）`);

    const draftAfter = Number(psql("SELECT count(*) FROM service_archives WHERE visibility='draft';"));
    rec('S5-no-backfill', draftAfter === draftBefore,
      `建单前草稿=${draftBefore} 建单后=${draftAfter}（须相等：新建不回溯存量草稿）`);
    void totalBefore;
  } finally {
    // ── 清理：级联删 + 强校验行数 ─────────────────────────────────────────
    // ⚠️ 用 concat + chr(35) 拼分隔符，不用 `||` 接单引号 —— 后者会让 shell 提前闭合
    const sql =
      'WITH e AS (DELETE FROM service_archive_events WHERE archive_id=' + id + ' RETURNING 1), ' +
      's AS (DELETE FROM service_archive_stages WHERE archive_id=' + id + ' RETURNING 1), ' +
      'p AS (DELETE FROM service_archive_photos WHERE archive_id=' + id + ' RETURNING 1), ' +
      'a AS (DELETE FROM service_archives WHERE id=' + id + ' RETURNING 1) ' +
      'SELECT concat((SELECT count(*) FROM a), chr(35), (SELECT count(*) FROM e), chr(35), (SELECT count(*) FROM s), chr(35), (SELECT count(*) FROM p));';
    const [a, e, s, p] = psql(sql).split('#').map(Number);
    console.log(`  清理 id=${id}：档案=${a} 事件=${e} 阶段=${s} 照片=${p}`);
    rec('S8-cleanup', a === 1, `清理档案行数=${a}（须 1，否则留下了脏数据）`);
  }

  // ── S7 可证伪对照：把代码改回 DRAFT，S1 必须红 ────────────────────────────
  const mutated = createBody.replace('visibility: ARCHIVE_VISIBILITY.PUBLISHED', 'visibility: ARCHIVE_VISIBILITY.DRAFT');
  const mutatedVis = (mutated.match(/visibility:\s*ARCHIVE_VISIBILITY\.(\w+)/) ?? [])[1] ?? '';
  rec('S7-mutation-control', mutatedVis === 'DRAFT',
    `内存里改回 DRAFT 后复算得到 ${mutatedVis}（须变成 DRAFT，证明 S1 真能红）`);

  const fail = out.filter((r) => !r.ok);
  console.log(`\n汇总：PASS ${out.length - fail.length} / ${out.length}`);
  if (fail.length) {
    console.log('未通过：' + fail.map((f) => f.id).join(', '));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e);
  const NL = String.fromCharCode(10);
  console.error(String(e?.stack ?? '').split(NL).slice(0, 5).join(' | '));
  process.exitCode = 1;
});
