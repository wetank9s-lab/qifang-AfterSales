/**
 * arc-photo-verify.mjs —— ARC-PHOTO-01 照片闭环定向验证
 *
 * 只测承重规则（用户 2026-11-10：不大规模重复测试）：
 *   1. 真实 multipart 上传（字段名 file）→ 落库、落盘、published=false
 *   2. 返回投影**不含 storage_key**
 *   3. 普通服务照片必须 before/after；带 stage_id 被拒
 *   4. 暖通照片必须绑阶段；跨档案 stage 被拒
 *   5. 每阶段 6 张上限
 *   6. 跨店：A 店销售不能给 B 店档案上传；不能读 B 店照片
 *   7. 发布要求阶段 done；撤回阶段后不能重新发布
 *   8. 内部读取：能读到已撤回阶段的历史照片（不删历史）
 *   9. 文件真实落盘且 hash 与上传一致
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Request-Id': crypto.randomUUID(),
      ...(opt.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    body: opt.body instanceof FormData ? opt.body : (opt.body ? JSON.stringify(opt.body) : undefined),
  });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    return { status: res.status, json, text };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buffer: buf, contentType: ct, text: '' };
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

/** 生成一张最小的合法 PNG（1x1），带一个 tEXt 块用于验证元数据剥离 */
function makePng() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = Buffer.from([0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01]);
  const text = chunk('tEXt', Buffer.from('Comment\0arc-photo-test', 'latin1'));
  return Buffer.concat([sig, chunk('IHDR', ihdr), text, chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const tokA = await signIn('arc1.sales.a@svc.local', PW);
const tokB = await signIn('arc1.sales.b@svc.local', PW);
const tokMgr = await signIn('arc1.mgr.a@svc.local', PW);
console.log('账号登录完成');

const png = makePng();
const pngHash = crypto.createHash('sha256').update(png).digest('hex');

// ---------------------------------------------------------------------------
section('准备：建普通服务档案（A店）与暖通档案（A店），以及 B 店档案');
// ---------------------------------------------------------------------------
const svc = await api(tokA, '/api/svc:archiveCreate', {
  method: 'POST',
  body: { archive_type: 'service', store_id: 1, customer_name: '照片验证', customer_mobile: '13600000001', service_address: 'x', service_type: 'install' },
});
const svcId = svc.json?.data?.archive?.id;
const hvac = await api(tokA, '/api/svc:archiveCreate', {
  method: 'POST',
  body: { archive_type: 'hvac', store_id: 1, customer_name: '照片验证暖通', customer_mobile: '13600000002', service_address: 'y' },
});
const hvacId = hvac.json?.data?.archive?.id;
const bSvc = await api(tokB, '/api/svc:archiveCreate', {
  method: 'POST',
  body: { archive_type: 'service', store_id: 4, customer_name: 'B店照片', customer_mobile: '13600000003', service_address: 'z', service_type: 'repair' },
});
const bId = bSvc.json?.data?.archive?.id;
if (!svcId || !hvacId || !bId) { console.log('准备失败'); process.exit(2); }

const surveyId = Number(psql(`SELECT id FROM service_archive_stages WHERE archive_id=${hvacId} AND stage_code='survey';`));

// ---------------------------------------------------------------------------
section('A. 上传 + 投影 + 落盘');
// ---------------------------------------------------------------------------
const form = new FormData();
form.append('file', new Blob([png], { type: 'image/png' }), 'before.png');
form.append('photo_type', 'before');
const up = await api(tokA, `/api/svc:archivePhotoAttach?id=${svcId}`, { method: 'POST', body: form });
const photoId = up.json?.data?.photo?.id;
check(up.status === 200 && Number(photoId) > 0, '普通服务照片上传成功', `HTTP ${up.status} id=${photoId}`);
check(
  up.json?.data?.photo?.published === false,
  '上传即未发布（published=false）',
  `published=${up.json?.data?.photo?.published}`,
);
check(
  !JSON.stringify(up.json ?? {}).includes('storage_key'),
  '返回投影不含 storage_key',
  Object.keys(up.json?.data?.photo ?? {}).join(','),
);

// 前置保护：上传没成功时后面的断言都会变成 undefined 崩溃，
// 那是"测试中断"，不是产品结论。
if (!Number(photoId)) {
  console.log(`  ⛔ 上传失败，中止后续断言（错误：${up.text?.slice(0, 200)}）`);
  process.exit(2);
}

const key = psql(`SELECT storage_key FROM service_archive_photos WHERE id=${photoId};`);
// ⚠️ 必须用**正斜杠**手工拼：`path.join` 在 Windows 上产生 `\`，
//    传给容器里的 `sha256sum` 会变成一个不存在的路径，表现为"文件没落盘"的假红。
const abs = `/app/nocobase/storage/uploads-private/${key}`;

// ⚠️ 这里**不能**比"上传字节 == 落盘字节"的 sha256。
//    我故意在上传的 PNG 里塞了一个 tEXt 块（`arc-photo-test`），而落盘前会剥离元数据
//    ⇒ 两者必然不同。第一版断言就是这样写错的，看起来像"文件落盘不一致"，
//    实际是**剥离生效了**。正确的判据是三条：
//      ① 文件存在且大小等于库里的 byte_size；
//      ② 落盘内容里**查不到**我插入的那段元数据；
//      ③ 能被内部受控接口原样读回（下面 D 段已覆盖）。
const diskStat = execFileSync(
  'docker',
  ['exec', 'svc-app', 'sh', '-c', `stat -c %s "${abs}" 2>/dev/null || echo 0`],
  { encoding: 'utf8' },
).trim();
const dbSize = Number(psql(`SELECT byte_size FROM service_archive_photos WHERE id=${photoId};`));
check(
  Number(diskStat) > 0 && Number(diskStat) === dbSize,
  '文件已落私有目录，且磁盘大小与库内 byte_size 一致',
  `key=${key} disk=${diskStat}B db=${dbSize}B`,
);

const residual = execFileSync(
  'docker',
  ['exec', 'svc-app', 'sh', '-c', `grep -c "arc-photo-test" "${abs}" 2>/dev/null || true`],
  { encoding: 'utf8' },
).trim();
check(
  residual === '0' || residual === '',
  '上传时植入的元数据已被剥离（落盘文件里查不到）',
  `命中行数=${residual || 0}`,
);
check(
  Number(psql(`SELECT count(*) FROM service_archive_photos WHERE id=${photoId} AND exif_stripped = true;`)) === 1,
  '已标记 exif_stripped=true',
  '',
);

// ---------------------------------------------------------------------------
section('B. 类型与绑定规则');
// ---------------------------------------------------------------------------
const badType = new FormData();
badType.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
badType.append('photo_type', 'stage');
const r1 = await api(tokA, `/api/svc:archivePhotoAttach?id=${svcId}`, { method: 'POST', body: badType });
check(r1.status === 400, '普通服务照片用 stage 类型 → 400', `HTTP ${r1.status} ${r1.text?.slice(0, 120)}`);

const withStage = new FormData();
withStage.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
withStage.append('photo_type', 'before');
withStage.append('stage_id', String(surveyId));
const r2 = await api(tokA, `/api/svc:archivePhotoAttach?id=${svcId}`, { method: 'POST', body: withStage });
check(r2.status === 400, '普通服务照片带 stage_id → 400', `HTTP ${r2.status}`);

const hvacNoStage = new FormData();
hvacNoStage.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
const r3 = await api(tokA, `/api/svc:archivePhotoAttach?id=${hvacId}`, { method: 'POST', body: hvacNoStage });
check(r3.status === 400, '暖通照片不绑阶段 → 400', `HTTP ${r3.status} ${r3.text?.slice(0, 120)}`);

// 跨档案挂阶段：拿 B 店档案 + A 店暖通的 survey 阶段
const cross = new FormData();
cross.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
cross.append('stage_id', String(surveyId));
const r4 = await api(tokB, `/api/svc:archivePhotoAttach?id=${bId}`, { method: 'POST', body: cross });
check(r4.status === 400 || r4.status === 404, '跨档案绑定阶段 → 拒绝', `HTTP ${r4.status} ${r4.text?.slice(0, 140)}`);

// ---------------------------------------------------------------------------
section('C. 每阶段 6 张上限');
// ---------------------------------------------------------------------------
let okCount = 0;
for (let i = 0; i < 6; i += 1) {
  const f = new FormData();
  f.append('file', new Blob([png], { type: 'image/png' }), `s${i}.png`);
  f.append('stage_id', String(surveyId));
  const r = await api(tokA, `/api/svc:archivePhotoAttach?id=${hvacId}`, { method: 'POST', body: f });
  if (r.status === 200) okCount += 1;
}
const seventh = new FormData();
seventh.append('file', new Blob([png], { type: 'image/png' }), 's7.png');
seventh.append('stage_id', String(surveyId));
const r7 = await api(tokA, `/api/svc:archivePhotoAttach?id=${hvacId}`, { method: 'POST', body: seventh });
check(okCount === 6 && r7.status === 409, '第 7 张被拒（每阶段上限 6）', `成功=${okCount} 第7张 HTTP=${r7.status}`);

// ---------------------------------------------------------------------------
section('D. 跨店权限');
// ---------------------------------------------------------------------------
const crossUp = new FormData();
crossUp.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
crossUp.append('photo_type', 'before');
const r8 = await api(tokA, `/api/svc:archivePhotoAttach?id=${bId}`, { method: 'POST', body: crossUp });
check(r8.status === 404 || r8.status === 403, 'A 店销售不能给 B 店档案上传', `HTTP ${r8.status}`);

const r9 = await api(tokA, `/api/svc:archivePhotoFile?photo_id=${photoId}`, {});
const r10 = await api(tokB, `/api/svc:archivePhotoFile?photo_id=${photoId}`, {});
check(r9.status === 200 && r9.buffer?.length > 0, '本店销售可读取本店照片', `HTTP ${r9.status} 字节=${r9.buffer?.length ?? 0}`);
check(r10.status === 404 || r10.status === 403, 'B 店销售不能读取 A 店照片', `HTTP ${r10.status}`);

const mgrRead = await api(tokMgr, `/api/svc:archivePhotoFile?photo_id=${photoId}`, {});
check(mgrRead.status === 200, '门店负责人可读（只读角色允许读）', `HTTP ${mgrRead.status}`);

// ---------------------------------------------------------------------------
section('E. 发布规则');
// ---------------------------------------------------------------------------
const pubBefore = await api(tokA, '/api/svc:archivePhotoPublish', {
  method: 'POST',
  body: { photo_id: photoId, published: true },
});
check(pubBefore.status === 200 && pubBefore.json?.data?.photo?.published === true, '普通服务照片可直接发布', `HTTP ${pubBefore.status}`);

const hvacPhotoId = Number(psql(`SELECT id FROM service_archive_photos WHERE archive_id=${hvacId} AND stage_id=${surveyId} ORDER BY id LIMIT 1;`));
const pubStage = await api(tokA, '/api/svc:archivePhotoPublish', {
  method: 'POST',
  body: { photo_id: hvacPhotoId, published: true },
});
check(pubStage.status === 409, '阶段未 done → 照片不能发布', `HTTP ${pubStage.status} ${pubStage.text?.slice(0, 140)}`);

// 完成勘察后发布
const surveyVer = Number(psql(`SELECT version FROM service_archive_stages WHERE id=${surveyId};`));
await api(tokA, '/api/svc:archiveStageComplete', {
  method: 'POST',
  body: { id: hvacId, stage_code: 'survey', stage_date: '2026-11-10', expected_version: surveyVer },
});
const pubAfterDone = await api(tokA, '/api/svc:archivePhotoPublish', {
  method: 'POST',
  body: { photo_id: hvacPhotoId, published: true },
});
check(pubAfterDone.status === 200, '阶段 done 后可发布', `HTTP ${pubAfterDone.status}`);

// 撤回阶段 → 自动取消发布
const sv = Number(psql(`SELECT version FROM service_archive_stages WHERE id=${surveyId};`));
await api(tokA, '/api/svc:archiveStageWithdraw', {
  method: 'POST',
  body: { id: hvacId, stage_code: 'survey', reason: '照片验证', expected_version: sv },
});
check(
  psql(`SELECT published FROM service_archive_photos WHERE id=${hvacPhotoId};`) === 'f',
  '撤回阶段 → 照片自动取消发布',
  '',
);

const repub = await api(tokA, '/api/svc:archivePhotoPublish', {
  method: 'POST',
  body: { photo_id: hvacPhotoId, published: true },
});
check(repub.status === 409, '撤回阶段后不能直接重新发布（必须先重新完成阶段）', `HTTP ${repub.status} ${repub.text?.slice(0, 140)}`);

const histRead = await api(tokA, `/api/svc:archivePhotoFile?photo_id=${hvacPhotoId}`, {});
check(histRead.status === 200, '内部仍可读取已撤回阶段的历史照片', `HTTP ${histRead.status} 字节=${histRead.buffer?.length ?? 0}`);

// ---------------------------------------------------------------------------
section('F. 清单接口不含 storage_key');
// ---------------------------------------------------------------------------
const list = await api(tokA, `/api/svc:archivePhotoList?id=${svcId}`, {});
check(
  list.status === 200 && !JSON.stringify(list.json ?? {}).includes('storage_key'),
  '照片清单可读且不含 storage_key',
  `HTTP ${list.status} 条数=${list.json?.data?.photos?.length ?? 0}`,
);

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log('\n' + '='.repeat(56));
console.log(`  结论：${results.length - failed.length} PASS / ${failed.length} FAIL（共 ${results.length} 条）`);
console.log('='.repeat(56));
fs.writeFileSync('.tmp-verify/arc-photo-result.json', JSON.stringify({ results }, null, 2));
process.exit(failed.length ? 1 : 0);

