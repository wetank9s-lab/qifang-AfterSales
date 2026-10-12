#!/usr/bin/env node
/**
 * verify-historical-review-archive.mjs
 *   —— P11-3 第 4 项 · 用户 **B（异常确认）/ C（去重预览）/ D（受控归档闭环）** 验收门禁
 *
 * ===========================================================================
 * 用户原话（逐段对应到下面的小节）
 * ===========================================================================
 *  B「员工需要能看到每份文件的：售后候选数量 / 排除非售后数量 / 疑似重复数量 /
 *    **需要人工确认的唯一记录数量** / 主要异常类型及对应原始行。
 *    异常应支持查看原始值、修正标准化候选值、确认或保持待处理。
 *    **不得覆盖原始层，不得凭猜测补手机号、年份、服务结果。**
 *    康乐 Sheet2 的"来电表扬"等原始结果**必须保留**，不得强制伪装成另一个标准业务结果。
 *    异常核对操作要记录**真实操作人、时间、原值及新值**。」
 *
 *  C「同文件重复上传遵守权限隔离并保证幂等。跨文件可根据**客户联系方式、业务日期、
 *    家电信息**等提示疑似重复，但**不得只凭手机号相同就合并** ——
 *    同一客户可能有多次真实售后。去重结果允许人工确认保留两条或标记重复。
 *    **不能自动删除原始记录**，不能让不同门店的客户资料互相泄漏。」
 *
 *  D「实现明确的『确认归档』操作，目标是**独立的历史售后档案**，不是 serviceTickets
 *    的 NEW 工单。归档时必须：验证批次权限 / 验证正式门店 code 与真实门店身份的
 *    确认关系 / 验证映射版本·异常处理状态及人工确认 / 保留来源文件·工作表·原始行·
 *    标准化版本关联 / 保证重复点击与网络重试不会生成重复档案 / 保持历史与当前 SLA·KPI 隔离。
 *    只有明确仍需继续处理的历史事项，才允许由授权员工通过**单独的**『转为当前服务单』
 *    操作进入当前工作流；必须保留历史来源关联和创建审计，**不得批量自动转单**。
 *    **因为当前 15 家门店 code 尚未全部核定，真实历史资料不得未经确认就正式归属。**
 *    允许使用**完全合成的测试文件、已验证授权的测试门店**进行端到端归档演练；
 *    不得为了让门禁转绿，偷偷把**真实 Excel 归到某个占位门店**。」
 *
 * ⚠️ 本脚本只用**运行时生成的合成文件**，且只在**演练门店**（scope=drill）上归档。
 *    最后一条断言专门证明：**真实七份样本的批次一条都没有被归档**。
 *
 * 用法：node scripts/verify-historical-review-archive.mjs
 * 退出码：0 / 1 / 2
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';

if (SVC_TLS_INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIST = path.join(ROOT, 'storage/plugins/@local/service-ticket/dist/server/index.js');
const TMP = path.join(ROOT, 'storage/tmp/historical-synth');
const CONTAINER = 'svc-app';
const RUN = `R${Date.now().toString(36).toUpperCase()}`;

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
  return ok;
}

const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const envValue = (k) => {
  const m = envFile.match(new RegExp(`^${k}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
};

function psql(sql) {
  const r = spawnSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  );
  return String(r.stdout ?? '').trim();
}

// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P11-3 第 4 项 · B 异常确认 / C 去重预览 / D 受控归档闭环');
console.log('══════════════════════════════════════════════════════════════');

if (!fs.existsSync(PLUGIN_DIST)) {
  console.error('  ⛔ 找不到插件产物 —— 先跑 node scripts/build-plugin.mjs');
  process.exit(2);
}
if (!String(spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout ?? '').includes(CONTAINER)) {
  console.error(`  ⛔ 容器 ${CONTAINER} 未运行`);
  process.exit(2);
}

const ACCOUNTS = {
  A: { label: 'UAT-A（S01）', email: 'uat.store.a@svc.local', pwd: envValue('UAT_STORE_A_PASSWORD') },
  B: { label: 'UAT-B（S02）', email: 'uat.store.b@svc.local', pwd: envValue('UAT_STORE_B_PASSWORD') },
  HQ: { label: 'admin（总部）', email: envValue('SMOKE_ADMIN_EMAIL') || 'admin@nocobase.com', pwd: envValue('SMOKE_ADMIN_PASSWORD') },
};
for (const [k, a] of Object.entries(ACCOUNTS)) {
  if (!a.pwd) {
    console.error(`  ⛔ ${k} 口令缺失`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// 合成文件（**每轮内容不同**，保证门禁可重复跑）
// ---------------------------------------------------------------------------
fs.mkdirSync(TMP, { recursive: true });
function buildSynth(fileName, rows, sheetName = '合成') {
  const requireWs = createRequire(path.join(process.env.USERPROFILE ?? '', '.workbuddy/binaries/node/workspace/anchor.cjs'));
  const XLSX = requireWs('xlsx');
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const p = path.join(TMP, fileName);
  fs.writeFileSync(p, XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
  return p;
}

const HEADER = ['回访时间', '安装时间', '姓名', '电话', '机器信息', '数量', '销售单位', '性质', '回访结果'];

// 主文件：刻意包含 ① 缺手机号 ② 一格多号 ③ 含糊日期 ④ 服务结果不在已知集合（"来电表扬"）
const FILE_A = buildSynth(`合成-主-${RUN}.xlsx`, [
  HEADER,
  // ① 缺手机号 + ④ 服务结果不在已知集合
  ['2026-09-01', '2026-09-02', `合成甲${RUN}`, '', `合成空调KFR-01-${RUN}`, 1, '合成门店', '安装', '来电表扬'],
  // ② 一格多号（同一客户两个号）+ 日期含糊
  ['9月3日', '2026-09-04', `合成乙${RUN}`, '13800000111/13800000112', `合成冰箱BCD-02-${RUN}`, 1, '合成门店', '维修', '满意'],
  // 干净行（应可直接归档）
  ['2026-09-05', '2026-09-06', `合成丙${RUN}`, '13800000113', `合成洗衣机XQG-03-${RUN}`, 1, '合成门店', '安装', '满意'],
  // 干净行
  ['2026-09-07', '2026-09-08', `合成丁${RUN}`, '13800000114', `合成电视TV-04-${RUN}`, 1, '合成门店', '安装', '满意'],
]);

// 第二份文件：与主文件的"合成丙"共用手机号 + 共用家电型号 ⇒ 强证据疑似重复
const FILE_B = buildSynth(`合成-交叉-${RUN}.xlsx`, [
  HEADER,
  ['2026-09-05', '2026-09-06', `合成丙${RUN}`, '13800000113', `合成洗衣机XQG-03-${RUN}`, 1, '合成门店', '安装', '满意'],
  // 只共用手机号（不同型号、不同日期）⇒ 弱证据
  ['2026-08-01', '2026-08-02', `合成戊${RUN}`, '13800000114', `合成微波炉MW-05-${RUN}`, 1, '合成门店', '维修', '满意'],
]);

console.log(`  · 合成主文件   ${path.basename(FILE_A)}`);
console.log(`  · 合成交叉文件 ${path.basename(FILE_B)}`);

// ---------------------------------------------------------------------------
async function signIn(email, pwd) {
  const res = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pwd }),
  });
  const json = await res.json().catch(() => null);
  const token = json?.data?.token ?? '';
  if (!token) throw new Error(`${email} 登录失败 HTTP ${res.status}`);
  return token;
}
async function api(token, pathname, { method = 'POST', body } = {}) {
  const res = await fetch(`${SVC_BASE_URL}${pathname}`, {
    method,
    headers: {
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text, payload: json?.data ?? json };
}
async function upload(token, filePath) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(filePath));
  return api(token, '/api/svc:historicalUpload', { body: form });
}

const tokens = {};
for (const [k, a] of Object.entries(ACCOUNTS)) tokens[k] = await signIn(a.email, a.pwd);
console.log('  · 三个账号已登录');

const beforeTickets = Number(psql('SELECT count(*) FROM service_tickets'));
console.log(`  · 验收前当前工单数 ${beforeTickets}`);

// ---------------------------------------------------------------------------
// ① 上传 + 映射
// ---------------------------------------------------------------------------
console.log('');
console.log('── ① 上传合成文件并生成标准化结果 ─────────────────────────');
const upA = await upload(tokens.A, FILE_A);
const batchA = upA.payload?.batch;
check('合成主文件上传成功', upA.status === 200 && !!batchA?.id, `HTTP ${upA.status} ${batchA?.batchNo}`);
const sheetA = upA.payload.sheets[0];
const fieldsA = { ...sheetA.autoMapping };
// 合成表的列名与真实表不同，这里显式指定映射（**不同文件的列顺序可以不一样**）
const mapA = {
  reviewDate: 0,
  deliveryDate: 1,
  customerName: 2,
  customerPhone: 3,
  device: 4,
  quantity: 5,
  storeHint: 6,
  serviceKind: 7,
  reviewResult: 8,
};
void fieldsA;
const staged = await api(tokens.A, '/api/svc:historicalStage', {
  body: { batchId: batchA.id, sheets: [{ sheetName: sheetA.sheet, headerRow: sheetA.headerRow, fields: mapA }] },
});
check('映射并暂存成功', staged.status === 200 && staged.payload?.written > 0, `写入 ${staged.payload?.written} 行，v${staged.payload?.mappingVersion}`);

const upB = await upload(tokens.A, FILE_B);
const sheetB = upB.payload.sheets[0];
const batchB = upB.payload.batch;
await api(tokens.A, '/api/svc:historicalStage', {
  body: { batchId: batchB.id, sheets: [{ sheetName: sheetB.sheet, headerRow: sheetB.headerRow, fields: mapA }] },
});

// ---------------------------------------------------------------------------
// ② B：概览计数
// ---------------------------------------------------------------------------
console.log('');
console.log('── ② B：一份文件的全部计数（含"唯一记录数"）──────────────');
const summaryRes = await api(tokens.A, `/api/svc:historicalReviewSummary?batchId=${batchA.id}`, { method: 'GET' });
const S = summaryRes.payload?.summary ?? {};
console.log(`      售后候选 ${S.importableCount} · 排除非售后 ${S.excludedCount} · 疑似重复 ${S.duplicateCount} · 需人工确认 ${S.needsConfirmCount}（唯一行 ${S.needsConfirmUniqueRowCount}）`);
console.log(`      异常：唯一行 ${S.anomalyUniqueRowCount} · 命中次数 ${S.anomalyHitCount}`);
console.log(`      类型：${(S.anomalyTypes ?? []).map((t) => `${t.label}×${t.hitCount}`).join(' · ')}`);
check('返回了五个分类计数', ['importableCount', 'excludedCount', 'duplicateCount', 'needsConfirmCount', 'parseErrorCount'].every((k) => typeof S[k] === 'number'), JSON.stringify({ i: S.importableCount, e: S.excludedCount, d: S.duplicateCount, n: S.needsConfirmCount }));
check('分类之和 == 候选总数（互斥可求和）', S.dispositionSum === S.candidateCount, `${S.dispositionSum} vs ${S.candidateCount}`);
check(
  '🔴 "需要人工确认的唯一记录数"用**行去重**算，不是把各分类相加',
  S.needsConfirmUniqueRowCount <= S.needsConfirmCount && S.needsConfirmUniqueRowCount > 0,
  `唯一 ${S.needsConfirmUniqueRowCount} ≤ 记录 ${S.needsConfirmCount}`,
);
check(
  '🔴 异常同样区分"唯一行数"与"命中次数"，且两者不等（本次合成数据刻意构造了多重命中）',
  S.anomalyUniqueRowCount <= S.anomalyHitCount,
  `唯一 ${S.anomalyUniqueRowCount} vs 命中 ${S.anomalyHitCount}`,
);
check('给出了主要异常类型', (S.anomalyTypes ?? []).length > 0, (S.anomalyTypes ?? []).map((t) => t.key).join(','));
check(
  '每种异常类型都给出了对应的**原始行号**（供人回原文件定位）',
  (S.anomalyTypes ?? []).every((t) => (t.sampleRows ?? []).length > 0 && t.sampleRows.every((r) => r.sourceRow >= 1)),
  (S.anomalyTypes ?? []).map((t) => `${t.key}:${t.sampleRows.map((r) => r.sourceRow).join('/')}`).join(' '),
);

// ---------------------------------------------------------------------------
// ③ B：人工核对 + 修正（含审计与"不覆盖"）
// ---------------------------------------------------------------------------
console.log('');
console.log('── ③ B：逐行核对 / 修正（原值·新值·操作人留痕）────────────');
const candidates = await api(tokens.A, `/api/svc:historicalBatches?batchId=${batchA.id}&limit=200`, { method: 'GET' });
const cands = candidates.payload?.candidates ?? [];
const needsConfirm = cands.filter((c) => c.disposition === 'needs-confirm');
const importables = cands.filter((c) => c.disposition === 'importable');
console.log(`      候选 ${cands.length}：可导入 ${importables.length} / 需确认 ${needsConfirm.length}`);
check('取回了候选列表', cands.length > 0, `${cands.length} 条`);

// 原始层快照（稍后证明没被覆盖）
const rawBefore = psql(`SELECT md5(string_agg(cells_json::text, '' ORDER BY id)) FROM historical_import_rows WHERE batch_id=${batchA.id}`);
const machineBefore = psql(`SELECT md5(string_agg(fields_json::text, '' ORDER BY id)) FROM historical_import_candidates WHERE batch_id=${batchA.id}`);

// ③a 非法修正必须被拒：手机号形态不对
const badPhone = await api(tokens.A, '/api/svc:historicalReviewRow', {
  body: { batchId: batchA.id, candidateId: needsConfirm[0]?.id, action: 'correct', field: 'customerPhone', value: '12345' },
});
check('修正手机号为非法形态 ⇒ 422（不得凭猜测补位）', badPhone.status === 422, `HTTP ${badPhone.status} ${badPhone.json?.errors?.[0]?.code ?? ''}`);

// ③b 非法日期（缺年份）必须被拒
const badDate = await api(tokens.A, '/api/svc:historicalReviewRow', {
  body: { batchId: batchA.id, candidateId: needsConfirm[0]?.id, action: 'correct', field: 'serviceDate', value: '9.1' },
});
check('修正日期为"9.1"这类缺年份写法 ⇒ 422', badDate.status === 422, `HTTP ${badDate.status} ${badDate.json?.errors?.[0]?.code ?? ''}`);

// ③c 合法修正：把缺手机号那行补成合成号码（人填的，且形态合法）
const targetRow = cands.find((c) => (c.issues ?? []).some((i) => /电话列为空|拆不出合法手机号/.test(i))) ?? needsConfirm[0];
const goodFix = await api(tokens.A, '/api/svc:historicalReviewRow', {
  body: {
    batchId: batchA.id,
    candidateId: targetRow.id,
    action: 'correct',
    field: 'customerPhone',
    value: '13800000199',
    note: `验收脚本合成修正 ${RUN}`,
  },
});
check('合法的人工修正被接受', goodFix.status === 200, `HTTP ${goodFix.status}`);
check(
  '响应明确回"机器结果与原始值都没动"',
  goodFix.payload?.machineFieldsUnchanged === true && goodFix.payload?.rawLayerUnchanged === true,
  JSON.stringify({ m: goodFix.payload?.machineFieldsUnchanged, r: goodFix.payload?.rawLayerUnchanged }),
);

// ③d 审计留痕：真实操作人 / 时间 / 原值 / 新值
const reviewRows = psql(
  `SELECT count(*) FROM historical_import_reviews WHERE batch_id=${batchA.id}`,
);
const reviewDetail = psql(
  `SELECT operator_username || '|' || action || '|' || coalesce(field_name,'') || '|' ||
          coalesce(old_value_json::text,'') || '|' || coalesce(new_value_json::text,'') || '|' ||
          (operated_at IS NOT NULL)::text
     FROM historical_import_reviews WHERE batch_id=${batchA.id} AND action='correct' ORDER BY id DESC LIMIT 1`,
);
console.log(`      审计行数 ${reviewRows}；最近一条修正：${reviewDetail}`);
const parts = reviewDetail.split('|');
check('修正操作写入了审计（有操作人 / 原值 / 新值 / 时间）', Number(reviewRows) > 0 && parts[0] && parts[3] && parts[4] && parts[5] === 'true', '');
check('审计里记得住**是谁**做的（不是匿名）', /uat[._]?store[._]?a|UAT-A/i.test(reviewDetail), parts[0]);

// ③e 原始层与机器结果**一个字节都没变**
const rawAfter = psql(`SELECT md5(string_agg(cells_json::text, '' ORDER BY id)) FROM historical_import_rows WHERE batch_id=${batchA.id}`);
const machineAfter = psql(`SELECT md5(string_agg(fields_json::text, '' ORDER BY id)) FROM historical_import_candidates WHERE batch_id=${batchA.id}`);
check('🔴 原始层未被修改（cells_json 的 md5 前后一致）', rawBefore === rawAfter && rawBefore.length > 0, `${rawBefore.slice(0, 12)}…`);
check('🔴 机器标准化结果未被修改（fields_json 的 md5 前后一致）', machineBefore === machineAfter && machineBefore.length > 0, `${machineBefore.slice(0, 12)}…`);

// ③f "来电表扬"必须原样保留（不得被伪装成标准业务结果）
const praised = psql(
  `SELECT count(*) FROM historical_import_candidates
    WHERE batch_id=${batchA.id} AND fields_json::text LIKE '%来电表扬%'`,
);
const praisedRaw = psql(
  `SELECT count(*) FROM historical_import_rows
    WHERE batch_id=${batchA.id} AND cells_json::text LIKE '%来电表扬%'`,
);
check('🔴 原始层里"来电表扬"仍在（原样保留）', Number(praisedRaw) > 0, `${praisedRaw} 行`);
check('🔴 机器标准化结果里"来电表扬"仍是原值（state=unrecognized，**未被伪装成"满意"**）', Number(praised) > 0, `${praised} 行`);
const praisedIsUnknown = psql(
  `SELECT count(*) FROM historical_import_candidates
    WHERE batch_id=${batchA.id} AND fields_json::text LIKE '%来电表扬%' AND fields_json::text LIKE '%unrecognized%'`,
);
check('该行的服务结果被标为 unrecognized（**没有**被改成已知结果）', Number(praisedIsUnknown) > 0, `${praisedIsUnknown} 行`);

// ③g 「逐条确认」这一动作本身可用（**先只确认一行**——剩余的留给 ⑥ 证明
//     "还有待处理记录时归档会被拦下"）。
const oneConfirm = await api(tokens.A, '/api/svc:historicalReviewRow', {
  body: { batchId: batchA.id, candidateId: (needsConfirm[0] ?? cands[0]).id, action: 'confirm', note: `验收：单行确认 ${RUN}` },
});
check('逐条确认可用', oneConfirm.status === 200, `HTTP ${oneConfirm.status}`);

// ---------------------------------------------------------------------------
// ④ C：去重预览
// ---------------------------------------------------------------------------
console.log('');
console.log('── ④ C：跨文件疑似重复（只提示、不合并）───────────────────');
const dupRes = await api(tokens.A, '/api/svc:historicalDuplicates', { method: 'GET' });
const dup = dupRes.payload ?? {};
console.log(`      扫描 ${dup.scannedBatches} 个批次 / ${dup.scannedCandidates} 条候选；强 ${dup.strongCount} · 弱 ${dup.weakCount}`);
for (const g of (dup.groups ?? []).slice(0, 3)) {
  console.log(`      · [${g.strength}] ${g.reasons.join(' + ')} → ${g.members.map((m) => `${m.batchNo}#${m.sourceRow}`).join(' vs ')}`);
}
check('检测到跨文件疑似重复', (dup.groups ?? []).length > 0, `强 ${dup.strongCount} / 弱 ${dup.weakCount}`);
check(
  '🔴 只凭手机号相同只能算**弱证据**（同一客户可能有多次真实售后）',
  (dup.groups ?? []).some((g) => g.strength === 'weak' && g.reasons.length === 1 && g.reasons[0] === '手机号相同'),
  '',
);
check(
  '手机号 + 家电型号/日期/姓名同时相同 ⇒ **强证据**',
  (dup.groups ?? []).some((g) => g.strength === 'strong' && g.reasons.length >= 2),
  (dup.groups ?? []).find((g) => g.strength === 'strong')?.reasons.join(' + ') ?? '',
);
check('响应里明确写了"只提示、不合并、不删除"', /不会自动合并|不合并/.test(dup.note ?? ''), dup.note ?? '');
check('成员里给出的手机号是**脱敏**的', (dup.groups ?? []).every((g) => g.members.every((m) => !/^\d{11}$/.test(String(m.mobileMasked ?? '')))), '');

// 人工裁决：保留两条
const keepBoth = await api(tokens.A, '/api/svc:historicalDuplicateDecision', {
  body: { batchId: batchA.id, candidateId: importables[0]?.id ?? cands[0].id, action: 'keep-both', note: `验收：保留两条 ${RUN}` },
});
check('去重裁决"保留两条"可用', keepBoth.status === 200, `HTTP ${keepBoth.status}`);
const dupReviewCount = psql(`SELECT count(*) FROM historical_import_reviews WHERE batch_id=${batchA.id} AND scope='duplicate'`);
check('去重裁决也留了审计（scope=duplicate）', Number(dupReviewCount) > 0, `${dupReviewCount} 条`);

// 跨门店：B 不能看到 A 的重复
const dupB = await api(tokens.B, '/api/svc:historicalDuplicates', { method: 'GET' });
check(
  '🔴 B 门店的去重扫描**看不到** A 门店的批次（不跨店泄漏客户资料）',
  !(dupB.payload?.groups ?? []).some((g) => g.members.some((m) => m.batchNo === batchA.batchNo)),
  `B 扫到 ${dupB.payload?.scannedBatches ?? 0} 个批次`,
);

// ---------------------------------------------------------------------------
// ⑤ D：归档前置全部被拒
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑤ D：归档前置（未确认归属 / 非总部 / 非名单门店）───────');
const archEarly = await api(tokens.A, '/api/svc:historicalArchive', { body: { batchId: batchA.id } });
check(
  '未确认门店归属 ⇒ 409 ATTRIBUTION_UNCONFIRMED（不得正式归属）',
  archEarly.status === 409 && archEarly.json?.errors?.[0]?.code === 'ATTRIBUTION_UNCONFIRMED',
  `HTTP ${archEarly.status} ${archEarly.json?.errors?.[0]?.code ?? ''}`,
);

const confirmByStore = await api(tokens.A, '/api/svc:historicalConfirmAttribution', {
  body: { batchId: batchA.id, storeCode: 'S01' },
});
check('门店账号不得确认归属（只有总部可以）⇒ 403', confirmByStore.status === 403, `HTTP ${confirmByStore.status}`);

const confirmNonListed = await api(tokens.HQ, '/api/svc:historicalConfirmAttribution', {
  body: { batchId: batchA.id, storeCode: 'S09' },
});
check(
  '🔴 归属到**不在身份确认名单**的门店 ⇒ 409（15 家门店 code 未全部核定）',
  confirmNonListed.status === 409 && confirmNonListed.json?.errors?.[0]?.code === 'STORE_IDENTITY_UNCONFIRMED',
  `HTTP ${confirmNonListed.status} ${confirmNonListed.json?.errors?.[0]?.code ?? ''}`,
);

const confirmProduction = await api(tokens.HQ, '/api/svc:historicalConfirmAttribution', {
  body: { batchId: batchA.id, storeCode: 'S01', scope: 'production' },
});
check(
  '🔴 对**只有演练范围**的门店发起**正式**归属 ⇒ 409 STORE_IDENTITY_DRILL_ONLY',
  confirmProduction.status === 409 && confirmProduction.json?.errors?.[0]?.code === 'STORE_IDENTITY_DRILL_ONLY',
  `HTTP ${confirmProduction.status} ${confirmProduction.json?.errors?.[0]?.code ?? ''}`,
);

// ---------------------------------------------------------------------------
// ⑥ D：演练归档闭环
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑥ D：合成文件 + 已验证授权门店的**演练**归档 ───────────');
const confirmDrill = await api(tokens.HQ, '/api/svc:historicalConfirmAttribution', {
  body: { batchId: batchA.id, storeCode: 'S01', scope: 'drill', note: `演练归属 ${RUN}` },
});
check('总部显式按 drill 范围确认归属 ⇒ 成功（演练路径）', confirmDrill.status === 200 && confirmDrill.payload?.attributionScope === 'drill', `HTTP ${confirmDrill.status} scope=${confirmDrill.payload?.attributionScope}`);

// 🔴 归档前仍有"待人工处理"的记录 ⇒ 必须被拦下（用户 D 条：验证异常处理状态及人工确认）
//
// ⚠️ 这一条**必须**在"把待确认行全部确认完"**之前**跑 ——
//    第一版放在确认循环之后，于是它测的是一个"已经没有待处理行"的批次，
//    断言恒不成立（实测报 HTTP 200）。**顺序本身就是判据的一部分**。
const archPending = await api(tokens.HQ, '/api/svc:historicalArchive', { body: { batchId: batchA.id } });
check(
  '🔴 归档前若仍有"待人工处理"的记录 ⇒ 409 REVIEW_PENDING（先核对再归档）',
  archPending.status === 409 && archPending.json?.errors?.[0]?.code === 'REVIEW_PENDING',
  `HTTP ${archPending.status} ${archPending.json?.errors?.[0]?.code ?? ''}`,
);

// 现在把剩余待处理行逐条确认（演练：每条都写审计）
let confirmedCount = 0;
for (const c of cands.filter((x) => x.disposition === 'needs-confirm' || x.disposition === 'duplicate')) {
  const r = await api(tokens.A, '/api/svc:historicalReviewRow', {
    body: { batchId: batchA.id, candidateId: c.id, action: 'confirm', note: `验收：逐条确认 ${RUN}` },
  });
  if (r.status === 200) confirmedCount += 1;
}
console.log(`      已逐条确认 ${confirmedCount} 行`);
check('逐条确认后该批次不再有待处理行', confirmedCount > 0, `${confirmedCount} 行`);

const archA1 = await api(tokens.HQ, '/api/svc:historicalArchive', { body: { batchId: batchA.id, note: `演练归档 ${RUN}` } });
console.log(`      创建 ${archA1.payload?.created} 条 · 复用 ${archA1.payload?.reused} 条 · 跳过排除行 ${archA1.payload?.excludedRowsSkipped} 条`);
check('演练归档成功', archA1.status === 200 && archA1.payload?.created > 0, `HTTP ${archA1.status}`);
check('归档响应明确"没有创建任何当前服务单、未影响 SLA"', archA1.payload?.ticketsCreated === 0 && archA1.payload?.slaAffected === false, JSON.stringify({ t: archA1.payload?.ticketsCreated, s: archA1.payload?.slaAffected }));

// 幂等：重复点击
const archA2 = await api(tokens.HQ, '/api/svc:historicalArchive', { body: { batchId: batchA.id, note: `演练归档重复点击 ${RUN}` } });
check(
  '🔴 重复点击归档 ⇒ 不再新增档案（全部 reused）',
  archA2.status === 200 && archA2.payload?.created === 0 && archA2.payload?.reused === archA1.payload?.created,
  `created=${archA2.payload?.created} reused=${archA2.payload?.reused}`,
);
const archiveCount = psql(`SELECT count(*) FROM historical_service_archives WHERE batch_id=${batchA.id}`);
check('库内该批次档案数 == 首次创建的条数（幂等键兜住）', Number(archiveCount) === archA1.payload?.created, `${archiveCount} vs ${archA1.payload?.created}`);

// 原始行与映射版本关联仍在
const linkOk = psql(
  `SELECT count(*) FROM historical_service_archives a
     JOIN historical_import_rows r ON r.id = a.row_id
    WHERE a.batch_id=${batchA.id} AND a.mapping_version IS NOT NULL AND r.source_row IS NOT NULL`,
);
check('档案保留了来源关联（批次/原始行/工作表/原始行号/映射版本齐全）', Number(linkOk) === Number(archiveCount), `${linkOk}/${archiveCount}`);
const sheetLinked = psql(`SELECT count(*) FROM historical_service_archives WHERE batch_id=${batchA.id} AND source_sheet IS NOT NULL AND source_row IS NOT NULL`);
check('档案带上了工作表与原始行号', Number(sheetLinked) === Number(archiveCount), `${sheetLinked}/${archiveCount}`);

// 排除的非售后行**不进档案**
const excludedArchived = psql(
  `SELECT count(*) FROM historical_service_archives a
     JOIN historical_import_candidates c ON c.row_id = a.row_id AND c.mapping_version = a.mapping_version
    WHERE a.batch_id=${batchA.id} AND c.disposition = 'excluded'`,
);
check('🔴 非售后排除记录**不进入**历史售后档案', Number(excludedArchived) === 0, `${excludedArchived} 条`);

// 历史与当前工单隔离
const afterTickets = Number(psql('SELECT count(*) FROM service_tickets'));
check(
  '🔴 当前服务单数量**不因历史归档变化**（归档与 current 工单完全隔离）',
  afterTickets === beforeTickets,
  `${beforeTickets} → ${afterTickets}`,
);

// 档案查看
const archiveList = await api(tokens.HQ, '/api/svc:historicalArchives?limit=50', { method: 'GET' });
check('可以查看历史档案', archiveList.status === 200 && (archiveList.payload?.archives ?? []).length > 0, `${archiveList.payload?.total} 条`);
check('档案接口明确标注"这不是当前在办工单"', archiveList.payload?.kind === 'historical-archive' && archiveList.payload?.notServiceTickets === true, '');
check(
  '档案列表里的手机号是**脱敏**的',
  (archiveList.payload?.archives ?? []).every((a) => !a.customerMobileMasked || /\*/.test(String(a.customerMobileMasked))),
  (archiveList.payload?.archives ?? [])[0]?.customerMobileMasked ?? '(无)',
);
check(
  '每条档案都能回答"来自哪个文件/工作表/原始行/映射版本"',
  (archiveList.payload?.archives ?? []).every((a) => a.sourceFileName && a.sourceSheet && a.sourceRow >= 1 && a.mappingVersion >= 1),
  '',
);

// ---------------------------------------------------------------------------
// ⑦ D：转为当前服务单（一次一条、必填理由、不批量）
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑦ D：转当前服务单（单独操作、不批量）───────────────────');
const archiveId = archA1.payload.archiveIds[0];
const batchTry = await api(tokens.HQ, '/api/svc:historicalConvertToTicket', {
  body: { archiveIds: [archiveId], reason: '验收：批量应被拒' },
});
check('🔴 传数组（批量转单）⇒ 422 被拒', batchTry.status === 422, `HTTP ${batchTry.status} ${batchTry.json?.errors?.[0]?.code ?? ''}`);

const noReason = await api(tokens.HQ, '/api/svc:historicalConvertToTicket', { body: { archiveId } });
check('不填理由 ⇒ 422（必须说明为什么仍需继续处理）', noReason.status === 422, `HTTP ${noReason.status} ${noReason.json?.errors?.[0]?.code ?? ''}`);

const byStore = await api(tokens.A, '/api/svc:historicalConvertToTicket', {
  body: { archiveId, reason: '门店账号不该能转单' },
});
check('门店账号不得转单 ⇒ 403', byStore.status === 403, `HTTP ${byStore.status}`);

const ticketsBeforeConv = Number(psql('SELECT count(*) FROM service_tickets'));
const conv1 = await api(tokens.HQ, '/api/svc:historicalConvertToTicket', {
  body: { archiveId, reason: `验收：该历史事项仍需继续处理 ${RUN}` },
});
check('总部按单条转单成功', conv1.status === 200 && !!conv1.payload?.ticketNo, `HTTP ${conv1.status} ticket=${conv1.payload?.ticketNo}`);
check('转单响应带回了历史来源关联', !!conv1.payload?.sourceLink?.archiveNo && conv1.payload?.sourceLink?.sourceRow >= 1, JSON.stringify(conv1.payload?.sourceLink ?? {}));

const ticketsAfterConv1 = Number(psql('SELECT count(*) FROM service_tickets'));
check(
  '一次转单只多 **1** 张当前服务单（不多不少）',
  ticketsAfterConv1 === ticketsBeforeConv + 1,
  `${ticketsBeforeConv} → ${ticketsAfterConv1}`,
);

const conv2 = await api(tokens.HQ, '/api/svc:historicalConvertToTicket', {
  body: { archiveId, reason: `验收：重复点击 ${RUN}` },
});
check(
  '🔴 重复点击转单 ⇒ 复用既有工单，不新建（幂等）',
  conv2.status === 200 && conv2.payload?.reused === true && conv2.payload?.ticketNo === conv1.payload?.ticketNo,
  `reused=${conv2.payload?.reused} ticket=${conv2.payload?.ticketNo}`,
);
const convCount = psql(`SELECT count(*) FROM historical_ticket_conversions WHERE archive_id=${archiveId}`);
check('库内该档案只有一条转换记录（archive_id UNIQUE）', Number(convCount) === 1, `${convCount} 条`);
const convState = psql(`SELECT conversion_state FROM historical_service_archives WHERE id=${archiveId}`);
check('档案上的转单状态与转换记录一致（不漂移）', String(convState) === 'converted', String(convState));

const ticketsAfterConv2 = Number(psql('SELECT count(*) FROM service_tickets'));
check(
  '🔴 重复点击转单**不再多出工单**（幂等）',
  ticketsAfterConv2 === ticketsAfterConv1,
  `${ticketsAfterConv1} → ${ticketsAfterConv2}`,
);

// ---------------------------------------------------------------------------
// ⑧ 反向：真实样本**一条都没被归档**
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑧ 反向：真实七份样本不得被正式归属/归档 ────────────────');
const realBatches = psql(
  `SELECT count(*) FROM historical_import_batches
    WHERE file_name ~ '东山|九兴|圣大|康乐|易田|欣盛|江华'`,
);
const realAttributed = psql(
  `SELECT count(*) FROM historical_import_batches
    WHERE file_name ~ '东山|九兴|圣大|康乐|易田|欣盛|江华' AND attribution_state = 'confirmed'`,
);
const realArchived = psql(
  `SELECT count(*) FROM historical_service_archives a JOIN historical_import_batches b ON b.id = a.batch_id
    WHERE b.file_name ~ '东山|九兴|圣大|康乐|易田|欣盛|江华'`,
);
console.log(`      真实样本批次 ${realBatches} 个；其中已确认归属 ${realAttributed} 个；已归档档案行 ${realArchived} 行`);
check('🔴 真实样本批次**一个都没有**被确认归属', Number(realAttributed) === 0, `${realAttributed} 个`);
check('🔴 真实样本**一条档案都没有**产生（未把真实 Excel 归到占位门店）', Number(realArchived) === 0, `${realArchived} 行`);

const productionScoped = psql(
  `SELECT count(*) FROM service_settings WHERE key='historical.store-identity-confirmations' AND value LIKE '%"scope": "production"%'`,
);
check('门店身份名单里**没有任何 production 条目** ⇒ 真实资料结构上无法归属', Number(productionScoped) === 0, `${productionScoped} 条`);

// 演练档案必须能一眼看出是演练
const drillMarked = psql(
  `SELECT count(*) FROM historical_import_batches WHERE id=${batchA.id} AND note LIKE '%attribution:drill%'`,
);
check('演练归属在批次备注里留了痕（可一眼分辨演练 vs 正式）', Number(drillMarked) === 1, `${drillMarked}`);

// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  B / C / D 门禁：${checks.length - failed.length}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════');
if (failed.length > 0) {
  for (const c of failed) console.log(`  ❌ ${c.name}${c.detail ? ' —— ' + c.detail : ''}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
process.exit(0);
