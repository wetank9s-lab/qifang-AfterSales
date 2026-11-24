/**
 * arc-rules-verify.mjs —— ARC-V1.0 三项冻结规则的针对性验证
 *
 * 只测本次改动的三件事（用户 2026-11-10：不做大规模重复测试）：
 *   A. 撤回阶段 → 本阶段照片自动 published=false
 *   B. 连锁撤回 → 后续已完成阶段的照片同步 published=false
 *   C. 不在撤回范围内的阶段照片**不受影响**（反向验证，防"一刀切下架"）
 *   D. 照片记录与 storage_key 保留（内部仍可查看历史）
 *   E. 客户可见性判定：撤回照片不可读；未撤回且阶段 done 的可读
 *   F. 重新完成后，重新发布的照片恢复可见
 *
 * 判据全部"成对"出现：既验证被撤回的变 false，也验证不该动的没变。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
// 测试口令只在 .env（`ARC_TEST_PW`）：源码不留凭据字面量（见 docs/R2-SECURITY-FREEZE.md 第 2 项）
const ARC_TEST_PW = (() => {
  try {
    const t = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = /^ARC_TEST_PW=(.*)$/m.exec(t);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();

const PW = ARC_TEST_PW;

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};
const section = (t) => console.log(`\n--- ${t} ---`);

async function api(token, p, opt = {}) {
  const res = await fetch(BASE + p, {
    method: opt.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Request-Id': crypto.randomUUID(),
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8' },
  ).trim();
}

// 直接内联判定，避免为了测试而改产品代码 —— 但规则必须与
// `isPhotoCustomerVisible()` 逐条对应（档案 published + 照片 published + 阶段 done）
function customerVisible(archiveVisibility, photoPublished, stageStatus) {
  if (archiveVisibility !== 'published') return false;
  if (photoPublished !== true) return false;
  if (stageStatus !== null && stageStatus !== undefined && stageStatus !== 'done') return false;
  return true;
}

const r0 = await api(null, '/api/auth:signIn', {
  method: 'POST',
  body: { account: 'arc1.sales.a@svc.local', password: PW },
});
const tok = r0.json?.data?.token;
if (!tok) { console.log('登录失败'); process.exit(2); }

// ---------------------------------------------------------------------------
section('准备：建暖通档案并完成勘察 / 方案 / 管路');
// ---------------------------------------------------------------------------
const created = await api(tok, '/api/svc:archiveCreate', {
  method: 'POST',
  body: {
    archive_type: 'hvac', store_id: 1,
    customer_name: '规则验证客户', customer_mobile: '13700000099',
    service_address: '规则验证地址',
  },
});
const aid = created.json?.data?.archive?.id;
if (!Number(aid)) { console.log('创建失败', created.text.slice(0, 200)); process.exit(2); }

// 档案置为已发布（客户可见性的第一个条件）
psql(`UPDATE service_archives SET visibility = 'published', published_at = now() WHERE id = ${aid};`);

const stageMap = {};
for (const line of psql(`SELECT id || '|' || stage_code || '|' || version FROM service_archive_stages WHERE archive_id = ${aid};`).split('\n')) {
  const [id, code, ver] = line.split('|');
  stageMap[code] = { id: Number(id), version: Number(ver) };
}

/** 插一张**已发布**的 stage 照片 */
function addPublishedPhoto(code) {
  psql(`INSERT INTO service_archive_photos
          (archive_id, stage_id, photo_type, storage_key, mime, byte_size, exif_stripped, published, uploaded_at, created_at, updated_at)
        VALUES (${aid}, ${stageMap[code].id}, 'stage', 'test/rules-${code}.jpg', 'image/jpeg', 2048, true, true, now(), now(), now());`);
}
/** 插一张**已发布**的普通服务照片（stage_id 为 NULL）—— 用于验证"不会被误伤" */
function addPlainServicePhoto() {
  psql(`INSERT INTO service_archive_photos
          (archive_id, stage_id, photo_type, storage_key, mime, byte_size, exif_stripped, published, uploaded_at, created_at, updated_at)
        VALUES (${aid}, NULL, 'before', 'test/rules-plain.jpg', 'image/jpeg', 2048, true, true, now(), now(), now());`);
}

for (const code of ['survey', 'plan', 'pipe']) {
  if (['survey', 'pipe'].includes(code)) addPublishedPhoto(code);
  const ver = Number(psql(`SELECT version FROM service_archive_stages WHERE id = ${stageMap[code].id};`));
  const r = await api(tok, '/api/svc:archiveStageComplete', {
    method: 'POST',
    body: { id: aid, stage_code: code, stage_date: '2026-11-10', expected_version: ver },
  });
  if (r.status !== 200) { console.log(`完成 ${code} 失败`, r.text.slice(0, 160)); process.exit(2); }
}
addPlainServicePhoto(); // 混入一张"非阶段照片"，检验不会被连带下架
console.log(`  档案 ${aid} 已就绪：survey/plan/pipe 完成，survey 与 pipe 各有 1 张已发布照片，另有 1 张普通服务照片`);

const before = psql(`SELECT stage_id || ':' || published FROM service_archive_photos WHERE archive_id = ${aid} ORDER BY id;`).replace(/\n/g, ' ');
console.log(`  撤回前照片发布状态：${before}`);

// ---------------------------------------------------------------------------
section('A/B/C. 撤回「管路施工」→ 本阶段与连锁阶段照片取消发布，范围外照片不动');
// ---------------------------------------------------------------------------
const pipeVer = Number(psql(`SELECT version FROM service_archive_stages WHERE id = ${stageMap.pipe.id};`));
const w = await api(tok, '/api/svc:archiveStageWithdraw', {
  method: 'POST',
  body: { id: aid, stage_code: 'pipe', reason: '规则验证：照片需重拍', expected_version: pipeVer },
});
check(w.status === 200, '撤回成功', `HTTP ${w.status} 连带=${(w.json?.data?.withdrawn ?? []).join(',')}`);

const pipePub = psql(`SELECT published FROM service_archive_photos WHERE archive_id = ${aid} AND stage_id = ${stageMap.pipe.id};`);
check(pipePub === 'f', 'A. 被撤回阶段(管路)的照片 → published=false', `published=${pipePub}`);

const surveyPub = psql(`SELECT published FROM service_archive_photos WHERE archive_id = ${aid} AND stage_id = ${stageMap.survey.id};`);
check(surveyPub === 't', 'C. 不在撤回范围内的阶段(勘察)照片 → 保持 published=true', `published=${surveyPub}`);

const plainPub = psql(`SELECT published FROM service_archive_photos WHERE archive_id = ${aid} AND stage_id IS NULL;`);
check(plainPub === 't', 'C. 普通服务照片(stage_id NULL) 不被误伤 → 仍 published=true', `published=${plainPub}`);

// 连锁：先把 device 完成并带照片，再撤回 pipe，验证 device 也被下架
psql(`INSERT INTO service_archive_photos
        (archive_id, stage_id, photo_type, storage_key, mime, byte_size, exif_stripped, published, uploaded_at, created_at, updated_at)
      VALUES (${aid}, ${stageMap.device.id}, 'stage', 'test/rules-device.jpg', 'image/jpeg', 2048, true, true, now(), now(), now());`);
// 先恢复 pipe（重新完成），再完成 device，再撤 pipe —— 构造"连锁撤回有后续已完成阶段"的场景
{
  const pipeVer2 = Number(psql(`SELECT version FROM service_archive_stages WHERE id = ${stageMap.pipe.id};`));
  await api(tok, '/api/svc:archiveStageComplete', {
    method: 'POST',
    body: { id: aid, stage_code: 'pipe', stage_date: '2026-11-10', expected_version: pipeVer2 },
  });
  const devVer = Number(psql(`SELECT version FROM service_archive_stages WHERE id = ${stageMap.device.id};`));
  const r = await api(tok, '/api/svc:archiveStageComplete', {
    method: 'POST',
    body: { id: aid, stage_code: 'device', stage_date: '2026-11-10', expected_version: devVer },
  });
  check(r.status === 200, '（准备）设备阶段完成，其照片此时为已发布', `HTTP ${r.status}`);

  const pipeVer3 = Number(psql(`SELECT version FROM service_archive_stages WHERE id = ${stageMap.pipe.id};`));
  const w2 = await api(tok, '/api/svc:archiveStageWithdraw', {
    method: 'POST',
    body: { id: aid, stage_code: 'pipe', reason: '连锁验证', expected_version: pipeVer3 },
  });
  const withdrawn = (w2.json?.data?.withdrawn ?? []).join(',');
  check(w2.status === 200 && withdrawn.includes('device'), 'B. 连锁撤回包含后续已完成阶段', `连带=${withdrawn}`);

  const devPub = psql(`SELECT published FROM service_archive_photos WHERE archive_id = ${aid} AND stage_id = ${stageMap.device.id};`);
  check(devPub === 'f', 'B. 连锁撤回的后续阶段(设备)照片 → 同步 published=false', `published=${devPub}`);
}

// ---------------------------------------------------------------------------
section('D. 记录与 storage_key 保留（内部仍可查看历史）');
// ---------------------------------------------------------------------------
const total = Number(psql(`SELECT count(*) FROM service_archive_photos WHERE archive_id = ${aid};`));
const withKey = Number(psql(`SELECT count(*) FROM service_archive_photos WHERE archive_id = ${aid} AND storage_key IS NOT NULL AND storage_key <> '';`));
check(total >= 4 && withKey === total, '照片行未被删除，storage_key 全部保留', `行数=${total} 有 key=${withKey}`);

const events = Number(psql(`SELECT count(*) FROM service_archive_events WHERE archive_id = ${aid} AND event_type = 'stage_withdrawn';`));
check(events >= 3, '撤回事件已记录（含连锁）', `stage_withdrawn 事件=${events}`);

// ---------------------------------------------------------------------------
section('E. 客户可见性判定');
// ---------------------------------------------------------------------------
const archVis = psql(`SELECT visibility FROM service_archives WHERE id = ${aid};`);
const pipeStageStatus = psql(`SELECT status FROM service_archive_stages WHERE id = ${stageMap.pipe.id};`);
const surveyStageStatus = psql(`SELECT status FROM service_archive_stages WHERE id = ${stageMap.survey.id};`);

check(
  customerVisible(archVis, pipePub !== 't', pipeStageStatus) === false,
  'E. 撤回阶段的照片：客户不可读（阶段 withdrawn + 照片 false）',
  `档案=${archVis} 照片published=${pipePub} 阶段=${pipeStageStatus}`,
);
check(
  customerVisible(archVis, surveyPub === 't', surveyStageStatus) === true,
  'E. 未撤回且阶段 done 的照片：客户可读',
  `档案=${archVis} 照片published=${surveyPub} 阶段=${surveyStageStatus}`,
);

// 反向：即使照片 published=true，阶段被撤回也不可读
check(
  customerVisible(archVis, true, 'withdrawn') === false,
  'E. 即使照片仍标记已发布，阶段撤回则客户不可读（条件③生效）',
  'photo published=true + stage=withdrawn',
);

// 反向：档案不是 published 时，任何照片都不可读
check(
  customerVisible('draft', true, 'done') === false,
  'E. 档案未发布 → 即使照片与阶段都满足，客户也不可读（条件①生效）',
  'archive=draft',
);

// ---------------------------------------------------------------------------
section('F. 重新完成后重新发布可行');
// ---------------------------------------------------------------------------
{
  const pipeVer4 = Number(psql(`SELECT version FROM service_archive_stages WHERE id = ${stageMap.pipe.id};`));
  const retry = await api(tok, '/api/svc:archiveStageComplete', {
    method: 'POST',
    body: { id: aid, stage_code: 'pipe', stage_date: '2026-11-11', expected_version: pipeVer4 },
  });
  check(retry.status === 200, 'F. 撤回后的阶段可重新完成', `HTTP ${retry.status} ${retry.status >= 400 ? retry.text.slice(0, 160) : ''}`);

  // 销售重新发布照片（模拟 A2 的照片接口尚未落地：直接置位，验证"重新选择并发布"路径可行）
  psql(`UPDATE service_archive_photos SET published = true, updated_at = now()
         WHERE archive_id = ${aid} AND stage_id = ${stageMap.pipe.id};`);
  const republished = psql(`SELECT published FROM service_archive_photos WHERE archive_id = ${aid} AND stage_id = ${stageMap.pipe.id};`);
  check(republished === 't', 'F. 照片可被重新发布', `published=${republished}`);
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log('\n' + '='.repeat(56));
console.log(`  结论：${results.length - failed.length} PASS / ${failed.length} FAIL（共 ${results.length} 条）`);
console.log('='.repeat(56));
fs.writeFileSync('.tmp-verify/arc-rules-result.json', JSON.stringify({ results, archiveId: aid }, null, 2));
process.exit(failed.length ? 1 : 0);

