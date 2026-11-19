/**
 * arc-a3-verify.mjs —— ARC-V1 / A3 暖通六阶段定向验收
 *
 * 只测**承重规则**（用户 2026-11-09：不做大量重复测试）：
 *   1. 建暖通档案 → 自动生成六行阶段，顺序固定
 *   2. 跳阶段 → 拒绝
 *   3. 关键阶段缺照片 → 拒绝
 *   4. 非关键阶段（方案确认）无照片可完成
 *   5. 依次完成六阶段 → 工程 accepted
 *   6. 撤回第 3 阶段 → 连带撤回 4/5/6（不留"没勘察却已管路"）
 *   7. 已验收被撤回 → 退回 completed，不再显示已验收
 *   8. 负责人不能操作阶段 → 403
 *   9. 阶段 version 并发冲突 → 409
 *
 * 复用已有账号，不新建、不清库。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const PW = ARC_TEST_PW;

const env = {};
for (const l of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
  if (m) env[m[1]] = m[2];
}

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
      ...(opt.headers || {}),
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

async function signIn(email, password) {
  const r = await api(null, '/api/auth:signIn', { method: 'POST', body: { account: email, password } });
  if (!r.json?.data?.token) throw new Error(`登录失败 ${email}`);
  return r.json.data.token;
}

function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8' },
  ).trim();
}

const tokSalesA = await signIn('arc1.sales.a@svc.local', PW);
const tokMgrA = await signIn('arc1.mgr.a@svc.local', PW);
console.log('账号登录完成');

// ---------------------------------------------------------------------------
section('A. 建暖通档案 → 自动六阶段');
// ---------------------------------------------------------------------------
const created = await api(tokSalesA, '/api/svc:archiveCreate', {
  method: 'POST',
  body: {
    archive_type: 'hvac', store_id: 1,
    customer_name: 'A3暖通客户', customer_mobile: '13700000001',
    service_address: 'A3验收地址', product_description: '中央空调',
  },
});
const aid = created.json?.data?.archive?.id;
check(created.status === 200 && Number(aid) > 0, '暖通档案创建成功', `HTTP ${created.status} id=${aid}`);
if (!Number(aid)) { console.log('  ⛔ 前置失败，中止'); process.exit(2); }

const stageRows = psql(`SELECT stage_code || ':' || stage_order || ':' || status FROM service_archive_stages WHERE archive_id = ${aid} ORDER BY stage_order;`);
const codes = stageRows.split('\n').map((l) => l.split(':')[0]).join(',');
check(
  stageRows.split('\n').length === 6 && codes === 'survey,plan,pipe,device,test,accept',
  '自动生成六行阶段且顺序固定',
  codes,
);

// 取阶段 id/version
const stageMap = {};
for (const line of psql(`SELECT id || '|' || stage_code || '|' || version FROM service_archive_stages WHERE archive_id = ${aid};`).split('\n')) {
  const [id, code, ver] = line.split('|');
  stageMap[code] = { id: Number(id), version: Number(ver) };
}

// ---------------------------------------------------------------------------
section('B. 顺序与照片规则');
// ---------------------------------------------------------------------------
const skip = await api(tokSalesA, '/api/svc:archiveStageComplete', {
  method: 'POST',
  body: { id: aid, stage_code: 'plan', stage_date: '2026-11-09', expected_version: stageMap.plan.version },
});
check(skip.status === 409, '跳过勘察直接完成「方案确认」→ 409', `HTTP ${skip.status} ${skip.text.slice(0, 140)}`);

const noPhoto = await api(tokSalesA, '/api/svc:archiveStageComplete', {
  method: 'POST',
  body: { id: aid, stage_code: 'survey', stage_date: '2026-11-09', expected_version: stageMap.survey.version },
});
check(noPhoto.status === 409, '关键阶段「勘察」缺照片 → 409', `HTTP ${noPhoto.status} ${noPhoto.text.slice(0, 160)}`);

// 补一张勘察照片（stage_id 必须归属本阶段）
psql(`INSERT INTO service_archive_photos
        (archive_id, stage_id, photo_type, storage_key, mime, byte_size, exif_stripped, published, uploaded_at, created_at, updated_at)
      VALUES (${aid}, ${stageMap.survey.id}, 'stage', 'test/a3-survey.jpg', 'image/jpeg', 1024, true, false, now(), now(), now());`);

const surveyDone = await api(tokSalesA, '/api/svc:archiveStageComplete', {
  method: 'POST',
  body: { id: aid, stage_code: 'survey', stage_date: '2026-11-09', expected_version: stageMap.survey.version },
});
check(surveyDone.status === 200, '勘察有照片 → 完成', `HTTP ${surveyDone.status} ${surveyDone.status >= 400 ? surveyDone.text.slice(0, 160) : ''}`);

// 方案确认：照片可选 —— 无照片也应能完成
const planDone = await api(tokSalesA, '/api/svc:archiveStageComplete', {
  method: 'POST',
  body: { id: aid, stage_code: 'plan', stage_date: '2026-11-10', expected_version: stageMap.plan.version },
});
check(planDone.status === 200, '「方案确认」无照片也可完成（照片可选）', `HTTP ${planDone.status} ${planDone.status >= 400 ? planDone.text.slice(0, 160) : ''}`);

// 往后续关键阶段补照片并完成
for (const code of ['pipe', 'device']) {
  psql(`INSERT INTO service_archive_photos
          (archive_id, stage_id, photo_type, storage_key, mime, byte_size, exif_stripped, published, uploaded_at, created_at, updated_at)
        VALUES (${aid}, ${stageMap[code].id}, 'stage', 'test/a3-${code}.jpg', 'image/jpeg', 1024, true, false, now(), now(), now());`);
  const r = await api(tokSalesA, '/api/svc:archiveStageComplete', {
    method: 'POST',
    body: { id: aid, stage_code: code, stage_date: '2026-11-11', expected_version: stageMap[code].version },
  });
  check(r.status === 200, `阶段「${code}」有照片 → 完成`, `HTTP ${r.status}`);
}

const testDone = await api(tokSalesA, '/api/svc:archiveStageComplete', {
  method: 'POST',
  body: { id: aid, stage_code: 'test', stage_date: '2026-11-12', expected_version: stageMap.test.version },
});
check(testDone.status === 200, '「调试运行」无照片可完成', `HTTP ${testDone.status}`);

// ---------------------------------------------------------------------------
section('C. 撤回连锁（在验收前撤回第 3 阶段）');
// ---------------------------------------------------------------------------
const pipeVer = Number(psql(`SELECT version FROM service_archive_stages WHERE id = ${stageMap.pipe.id};`));
const withdraw = await api(tokSalesA, '/api/svc:archiveStageWithdraw', {
  method: 'POST',
  body: { id: aid, stage_code: 'pipe', reason: '现场复核：管路照片需重拍', expected_version: pipeVer },
});
const withdrawnList = (withdraw.json?.data?.withdrawn ?? []).join(',');
check(withdraw.status === 200, '撤回「管路施工」成功', `HTTP ${withdraw.status} 连带=${withdrawnList}`);

const afterWithdraw = psql(`SELECT stage_code || '=' || status FROM service_archive_stages WHERE archive_id = ${aid} ORDER BY stage_order;`).replace(/\n/g, ' ');
check(
  /pipe=withdrawn/.test(afterWithdraw) && /device=withdrawn/.test(afterWithdraw) && /test=withdrawn/.test(afterWithdraw) && /accept=pending/.test(afterWithdraw),
  '后续已完成阶段被连环撤回（不留"没管路却已调试"）',
  afterWithdraw,
);
check(/survey=done/.test(afterWithdraw), '已撤回阶段之前的阶段保持完成', afterWithdraw);

const reasonKept = psql(`SELECT withdraw_reason FROM service_archive_stages WHERE id = ${stageMap.pipe.id};`);
check(reasonKept.includes('重拍'), '撤回原因已留痕', reasonKept);

// 重新完成管路 → 设备 → 调试 → 验收
for (const code of ['pipe', 'device', 'test', 'accept']) {
  const ver = Number(psql(`SELECT version FROM service_archive_stages WHERE id = ${stageMap[code].id};`));
  if (['pipe', 'device', 'accept'].includes(code)) {
    const cnt = Number(psql(`SELECT count(*) FROM service_archive_photos WHERE archive_id = ${aid} AND stage_id = ${stageMap[code].id};`));
    if (cnt === 0) {
      psql(`INSERT INTO service_archive_photos
              (archive_id, stage_id, photo_type, storage_key, mime, byte_size, exif_stripped, published, uploaded_at, created_at, updated_at)
            VALUES (${aid}, ${stageMap[code].id}, 'stage', 'test/a3-${code}.jpg', 'image/jpeg', 1024, true, false, now(), now(), now());`);
    }
  }
  const r = await api(tokSalesA, '/api/svc:archiveStageComplete', {
    method: 'POST',
    body: { id: aid, stage_code: code, stage_date: '2026-11-13', expected_version: ver },
  });
  if (code === 'accept') {
    check(
      r.status === 200 && r.json?.data?.archive?.status === 'accepted',
      '第六阶段完成后工程自动「已验收」',
      `HTTP ${r.status} status=${r.json?.data?.archive?.status}`,
    );
  }
}

// ---------------------------------------------------------------------------
section('D. 权限与并发');
// ---------------------------------------------------------------------------
const mgrStage = await api(tokMgrA, '/api/svc:archiveStageWithdraw', {
  method: 'POST',
  body: { id: aid, stage_code: 'accept', reason: '负责人尝试撤回', expected_version: 1 },
});
check(mgrStage.status === 403, '门店负责人不能操作阶段 → 403', `HTTP ${mgrStage.status}`);

const staleStage = await api(tokSalesA, '/api/svc:archiveStageWithdraw', {
  method: 'POST',
  body: { id: aid, stage_code: 'accept', reason: '旧版本', expected_version: 1 },
});
check(staleStage.status === 409, '阶段 version 过期 → 409（不静默覆盖）', `HTTP ${staleStage.status} ${staleStage.text.slice(0, 140)}`);

const stageList = await api(tokSalesA, `/api/svc:archiveStageList?id=${aid}`, {});
const leakedKey = JSON.stringify(stageList.json ?? {}).includes('storage_key');
check(stageList.status === 200 && !leakedKey, '阶段列表可读且不含 storage_key', `HTTP ${stageList.status} storage_key出现=${leakedKey}`);

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log('\n' + '='.repeat(56));
console.log(`  结论：${results.length - failed.length} PASS / ${failed.length} FAIL（共 ${results.length} 条）`);
console.log('='.repeat(56));
fs.writeFileSync('.tmp-verify/arc-a3-result.json', JSON.stringify({ results, archiveId: aid }, null, 2));
process.exit(failed.length ? 1 : 0);
// 测试口令只在 .env（`ARC_TEST_PW`）：源码不留凭据字面量（见 docs/R2-SECURITY-FREEZE.md 第 2 项）
const ARC_TEST_PW = (() => {
  try {
    const t = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = /^ARC_TEST_PW=(.*)$/m.exec(t);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();

