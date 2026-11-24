/**
 * arc-a2-verify.mjs —— ARC-V1 / A2 承重验收（开发环境）
 *
 * 覆盖执行令「三、权限补充验证」+「四、A2」的硬判据：
 *   1. store_manager 写接口 → 403
 *   2. hq_admin 写接口 → 403
 *   3. A 店销售不能创建/修改 B 店档案
 *   4. 缺前后照片不能标记完成（409）
 *   5. 有前后照片可以完成（200）且状态变 completed
 *   6. 并发版本冲突 → 409（不静默覆盖）
 *   7. 原生 collection:update 不能绕过（对业务角色无授权）
 *
 * 纪律：
 *   · 用真实账号登录、真实 HTTP，不伪造角色
 *   · 每条断言都能变红（正向 + 反向成对出现）
 *   · 只对开发环境执行
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

const DEV_PW = ARC_TEST_PW;

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
      // ⚠️ 必须是**合法 UUID v4**：项目对写接口的幂等头有格式校验，
      //    随便拼一个字符串会先被 422 挡掉，而不是走到业务校验 ——
      //    那种情况下"403/409"全变成"422"，看起来像是权限全坏了。
      'X-Request-Id': opt.requestId || crypto.randomUUID(),
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
  if (!r.json?.data?.token) throw new Error(`登录失败 ${email}: HTTP ${r.status}`);
  return r.json.data.token;
}

function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8' },
  ).trim();
}

const tokSalesA = await signIn('arc1.sales.a@svc.local', DEV_PW);
const tokSalesB = await signIn('arc1.sales.b@svc.local', DEV_PW);
const tokMgrA = await signIn('arc1.mgr.a@svc.local', DEV_PW);
const tokHq = await signIn(env.UAT_HQADMIN_EMAIL || 'uat.hqadmin@svc.local', env.UAT_HQADMIN_PASSWORD);
console.log('四个账号登录完成');

// ---------------------------------------------------------------------------
section('A. 创建权限与门店归属');
// ---------------------------------------------------------------------------
const created = await api(tokSalesA, '/api/svc:archiveCreate', {
  method: 'POST',
  body: {
    archive_type: 'service',
    store_id: 1,
    customer_name: 'A2验收客户',
    customer_mobile: '13900000001',
    service_address: 'A店验收地址',
    service_type: 'install',
    product_description: '验收机型',
  },
});
const createdId = created.json?.data?.archive?.id;
check(
  created.status === 200 && Number(createdId) > 0,
  'A 店销售可以创建本店(1)档案',
  `HTTP ${created.status} id=${createdId ?? 'n/a'} ${created.status >= 400 ? created.text.slice(0, 200) : ''}`,
);
check(
  String(created.json?.data?.archive?.store_id) === '1',
  '新建档案门店归属正确且未被请求体篡改',
  `store_id=${created.json?.data?.archive?.store_id}`,
);

const crossCreate = await api(tokSalesA, '/api/svc:archiveCreate', {
  method: 'POST',
  body: {
    archive_type: 'service', store_id: 4,
    customer_name: '越权客户', customer_mobile: '13900000002',
    service_address: 'B店地址', service_type: 'install',
  },
});
check(
  crossCreate.status === 404 || crossCreate.status === 403,
  'A 店销售不能创建 B 店(4)档案',
  `HTTP ${crossCreate.status} ${crossCreate.text.slice(0, 160)}`,
);

// ---------------------------------------------------------------------------
section('B. 只读角色与总部角色的写入拒绝');
// ---------------------------------------------------------------------------
const mgrWrite = await api(tokMgrA, '/api/svc:archiveCreate', {
  method: 'POST',
  body: {
    archive_type: 'service', store_id: 1,
    customer_name: '负责人越权', customer_mobile: '13900000003',
    service_address: 'x', service_type: 'install',
  },
});
check(
  mgrWrite.status === 403,
  'store_manager 调用写入接口 → 403',
  `HTTP ${mgrWrite.status} ${mgrWrite.text.slice(0, 160)}`,
);

const hqWrite = await api(tokHq, '/api/svc:archiveCreate', {
  method: 'POST',
  body: {
    archive_type: 'service', store_id: 1,
    customer_name: '总部越权', customer_mobile: '13900000004',
    service_address: 'x', service_type: 'install',
  },
});
check(
  hqWrite.status === 403,
  'hq_admin 调用写入接口 → 403',
  `HTTP ${hqWrite.status} ${hqWrite.text.slice(0, 160)}`,
);

// ---------------------------------------------------------------------------
section('C. 跨店修改');
// ---------------------------------------------------------------------------
const bArchive = await api(tokSalesB, '/api/svc:archiveCreate', {
  method: 'POST',
  body: {
    archive_type: 'service', store_id: 4,
    customer_name: 'B2验收客户', customer_mobile: '13900000005',
    service_address: 'B店验收地址', service_type: 'repair',
  },
});
const bId = bArchive.json?.data?.archive?.id;
check(bArchive.status === 200 && Number(bId) > 0, 'B 店销售可以创建本店(4)档案', `HTTP ${bArchive.status} id=${bId}`);

const crossUpdate = await api(tokSalesA, '/api/svc:archiveUpdate', {
  method: 'POST',
  body: { id: bId, expected_version: 1, customer_name: 'A改B' },
});
check(
  crossUpdate.status === 404 || crossUpdate.status === 403,
  'A 店销售不能修改 B 店档案',
  `HTTP ${crossUpdate.status} ${crossUpdate.text.slice(0, 160)}`,
);

// ---------------------------------------------------------------------------
section('D. 完工闸：缺照片必须拒绝');
// ---------------------------------------------------------------------------
// 前置：如果创建没成功，后面所有断言都会变成"undefined 崩溃"，那不是产品结论。
// 这里显式中止并说明"是前置失败导致的中断"，避免把工具故障误读成产品故障。
if (!Number(createdId)) {
  console.log('  ⛔ 前置失败：A 店档案未创建成功，后续断言无法执行（这是测试中断，不是产品结论）');
  process.exit(2);
}
const noPhoto = await api(tokSalesA, '/api/svc:archiveComplete', {
  method: 'POST',
  body: { id: createdId, completed_at: '2026-11-09', expected_version: 1 },
});
const noPhotoCode = noPhoto.json?.errors?.[0]?.code ?? noPhoto.json?.code ?? '';
check(
  noPhoto.status === 409,
  '缺前后照片标记完成 → 409',
  `HTTP ${noPhoto.status} code=${noPhotoCode} ${noPhoto.text.slice(0, 200)}`,
);

// 只补「服务前」一张 —— 仍然必须拒绝（证明是"逐类型"判，不是"有照片就行"）
psql(`INSERT INTO service_archive_photos
        (archive_id, photo_type, storage_key, mime, byte_size, exif_stripped, published, uploaded_at, created_at, updated_at)
      VALUES (${createdId}, 'before', 'test/arc-a2-before.jpg', 'image/jpeg', 1024, true, false, now(), now(), now());`);
const onlyBefore = await api(tokSalesA, '/api/svc:archiveComplete', {
  method: 'POST',
  body: { id: createdId, completed_at: '2026-11-09', expected_version: 1 },
});
check(
  onlyBefore.status === 409,
  '只有「服务前」一张 → 仍拒绝（逐类型判定）',
  `HTTP ${onlyBefore.status} ${onlyBefore.text.slice(0, 200)}`,
);

// ---------------------------------------------------------------------------
section('E. 补全后可以完成');
// ---------------------------------------------------------------------------
psql(`INSERT INTO service_archive_photos
        (archive_id, photo_type, storage_key, mime, byte_size, exif_stripped, published, uploaded_at, created_at, updated_at)
      VALUES (${createdId}, 'after', 'test/arc-a2-after.jpg', 'image/jpeg', 1024, true, false, now(), now(), now());`);
const done = await api(tokSalesA, '/api/svc:archiveComplete', {
  method: 'POST',
  body: { id: createdId, completed_at: '2026-11-09', expected_version: 1 },
});
check(
  done.status === 200 && String(done.json?.data?.archive?.status) === 'completed',
  '前后照片齐备 → 完成成功，status=completed',
  `HTTP ${done.status} status=${done.json?.data?.archive?.status} ${done.status >= 400 ? done.text.slice(0, 200) : ''}`,
);
// ⚠️ 不要拿 UTC 字符串去 startsWith('2026-11-09')：
//    `2026-11-09`（Asia/Shanghai）落库后是 `2026-11-08T16:00:00.000Z`。
//    这条断言我第一次就写错了，看起来像"日期没保存"，实际是时区。
//    正确判据：能解析成日期 + 本地日期等于填的那天。
const completedRaw = done.json?.data?.archive?.completed_at ?? '';
const completedLocalDate = completedRaw
  ? new Date(completedRaw).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
  : '';
check(
  completedLocalDate === '2026-11-09',
  '完成日期已落库且按本地时区仍是所填日期',
  `completed_at=${completedRaw} → 本地 ${completedLocalDate || '(空)'}`,
);

// ---------------------------------------------------------------------------
section('F. 并发：旧版本号不得静默覆盖');
// ---------------------------------------------------------------------------
// ⚠️ 这里必须**成对**验证，否则会假绿：
//   只测"旧版本被拒"是不够的 —— 如果 update 因为别的原因（例如永远 affected=0）
//   全部失败，那条断言照样绿，但它证明的是"功能坏了"，不是"并发被挡住了"。
//   ⇒ 先用**当前版本**更新成功，再用**旧版本**更新被拒。
// 版本号直接从库里取，不走 `serviceArchives:get`：
//   那个接口受字段白名单与 ACL 影响，可能不下发 version（实测取到 undefined），
//   于是 expected_version 变成 NaN → 被 422 挡掉，看起来像"更新权限坏了"。
const curVersion = Number(
  psql(`SELECT version FROM service_archives WHERE id = ${createdId};`) || 0,
);

const fresh = await api(tokSalesA, '/api/svc:archiveUpdate', {
  method: 'POST',
  body: { id: createdId, expected_version: curVersion, customer_name: '并发验收-正常更新' },
});
check(
  fresh.status === 200,
  '用当前版本号更新 → 成功（证明 update 通路本身可用）',
  `HTTP ${fresh.status} 旧版本=${curVersion} 新版本=${fresh.json?.data?.archive?.version} ${fresh.status >= 400 ? fresh.text.slice(0, 200) : ''}`,
);

const stale = await api(tokSalesA, '/api/svc:archiveUpdate', {
  method: 'POST',
  body: { id: createdId, expected_version: curVersion, customer_name: '旧版本覆盖' },
});
check(
  stale.status === 409,
  '用过期 expected_version 更新 → 409（不静默覆盖）',
  `HTTP ${stale.status} ${stale.text.slice(0, 200)}`,
);

const stillFreshName = psql(`SELECT customer_name FROM service_archives WHERE id = ${createdId};`);
check(
  stillFreshName === '并发验收-正常更新',
  '被拒的那次没有写入数据库（内容仍是成功那次的值）',
  `customer_name=${stillFreshName}`,
);

// ---------------------------------------------------------------------------
section('G. 原生 collection:update 不能绕过');
// ---------------------------------------------------------------------------
const nativeUpdate = await api(tokSalesA, `/api/serviceArchives:update?filterByTk=${createdId}`, {
  method: 'POST',
  body: { values: { status: 'pending', store_id: 4 } },
});
check(
  nativeUpdate.status >= 400,
  '原生 serviceArchives:update 对业务角色不可用（不能绕过状态与门店校验）',
  `HTTP ${nativeUpdate.status} ${nativeUpdate.text.slice(0, 160)}`,
);

// ---------------------------------------------------------------------------
section('H. 审计事件');
// ---------------------------------------------------------------------------
const evCount = Number(psql(`SELECT count(*) FROM service_archive_events WHERE archive_id = ${createdId};`));
check(evCount >= 2, '创建与完工都写了审计事件', `events=${evCount}`);

const leaked = Number(psql(
  `SELECT count(*) FROM service_archive_events
    WHERE archive_id = ${createdId} AND payload_json::text LIKE '%13900000001%';`,
));
check(leaked === 0, '审计 payload 不含客户手机号明文', `命中=${leaked}`);

// ---------------------------------------------------------------------------
section('I. 无效门店绑定 → 仍拒绝（用户点名的第 4 条）');
// ---------------------------------------------------------------------------
// 账号绑 [1, 2]，而 stores 里**没有** id=2。
// 期望：整个档案访问被拒（412/403/空集），**不是**"忽略 2 号店、按 1 号店放行"。
// 这两种实现的区别是"替用户猜"与"fail closed"，档案含住宅照片，只能选后者。
const tokBad = await signIn('arc1.sales.bad@svc.local', DEV_PW);
const badList = await api(tokBad, '/api/serviceArchives:list?paginate=false', {});
const badRows = Array.isArray(badList.json?.data) ? badList.json.data : [];
check(
  badList.status === 403 || badRows.length === 0,
  '绑定含不存在门店(2) 的销售：档案访问被拒，不按 1 号店放行',
  `HTTP ${badList.status} 行数=${badRows.length} stores=[${[...new Set(badRows.map((r) => r.store_id))].join(',')}]`,
);

const badCreate = await api(tokBad, '/api/svc:archiveCreate', {
  method: 'POST',
  body: {
    archive_type: 'service', store_id: 1,
    customer_name: '无效门店', customer_mobile: '13900000009',
    service_address: 'x', service_type: 'install',
  },
});
check(
  badCreate.status >= 400,
  '绑定含不存在门店(2) 的销售：也不能写入 1 号店档案',
  `HTTP ${badCreate.status} ${badCreate.text.slice(0, 160)}`,
);

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log('\n' + '='.repeat(60));
console.log(`  结论：${results.length - failed.length} PASS / ${failed.length} FAIL（共 ${results.length} 条）`);
console.log('='.repeat(60));
fs.writeFileSync('.tmp-verify/arc-a2-result.json', JSON.stringify({ results, archiveId: createdId }, null, 2));
process.exit(failed.length ? 1 : 0);

