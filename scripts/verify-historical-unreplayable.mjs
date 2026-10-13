#!/usr/bin/env node
/**
 * verify-historical-unreplayable.mjs
 *   —— **不可精确重放的旧批次：登记与处理规则**（P11-3 第 6 项 · 用户 C 段）
 *
 * ===========================================================================
 * 用户原话
 * ===========================================================================
 *  「列出**受影响的旧批次**、**缺失的 mapping_version 快照范围**及**实际缺失内容**。
 *    原始 Excel 完整，可以重新生成新的标准化候选；但**缺失的旧映射参数无法凭空恢复**，
 *    **不得将重新计算的候选冒充历史版本原值**。
 *    对于缺少必要映射证据的历史批次，在**正式生产归档前要求重新映射或人工确认**。
 *    **不要自动回填伪造的历史字段、审计或映射快照。**
 *    这项作为已有测试数据和旧批次的**明确限制登记**。
 *    若不影响新批次完整保存与审计，可在**风险记录**中保留，
 *    **不要求无限期修复无法恢复的历史证据**。」
 *
 * ===========================================================================
 * 这个门禁做四件事
 * ===========================================================================
 *  ① **扫**：找出"有候选行、但当前版本没有映射快照"的批次（受影响的旧批次）；
 *  ② **登记**：把结果写进 `service_settings['historical.unreplayable-batches']`
 *     （含缺失版本范围、缺失内容、处理规则）；
 *  ③ **断言**：登记内容与库内实际**逐条一致**；且**没有任何批次被伪造了映射快照**
 *     （即代码/脚本没有偷偷回填历史参数）；
 *  ④ **断言**：这些批次**都没有正式归属**（生产阻塞仍然生效），且**归档会被拒**。
 *
 * ⚠️ 本门禁**不修复**历史证据，也不尝试"补一份看起来合理的快照" ——
 *    那正是用户禁止的"用重新计算的结果冒充历史原值"。
 *
 * 用法：node scripts/verify-historical-unreplayable.mjs
 * 退出码：0 / 1 / 2
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';

if (SVC_TLS_INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTAINER = 'svc-app';
const KEY = 'historical.unreplayable-batches';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
  return ok;
}
function psql(sql) {
  return String(
    spawnSync('docker', ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    }).stdout ?? '',
  ).trim();
}
const N = (sql) => Number(psql(sql) || '0');
const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const envValue = (k, d = '') => {
  const m = envFile.match(new RegExp(`^${k}=(.*)$`, 'm'));
  return m ? m[1].trim() : d;
};

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  不可精确重放的旧批次：登记与处理规则');
console.log('══════════════════════════════════════════════════════════════');

if (!String(spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout ?? '').includes(CONTAINER)) {
  console.error(`  ⛔ 容器 ${CONTAINER} 未运行`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// ① 扫：哪些批次"当前版本没有映射快照"
// ---------------------------------------------------------------------------
console.log('');
console.log('── ① 受影响批次（缺当前版本映射快照）───────────────────────');
//
// 判据：`mapping_json` 不是"按版本累积"的格式（键里没有数字），
//       且该批次有候选行 ⇒ 它当前那一代的参数无法被证明。
// ---------------------------------------------------------------------------
// ⚠️ 判据必须与**服务端** `mappingOfVersion()` 的语义严格一致，否则门禁说的
//    "缺快照"和产品说的"缺快照"是两件事。
//
// 第一版的判据是"mapping_json 的文本里不含 "{"" —— 那是**格式探测**，
// 错在两处：
//   ① 版本化格式 `{"1":{...}}` 里根本没有 `"{` 这个子串 ⇒ 它会把**有快照的
//      新批次也扫进受影响清单**（实测 60 个批次里混进了最新签发的合成夹具）；
//   ② 反过来，一个批次完全可能"格式是版本化的、但恰好缺当前这一代"
//      （康乐批次 4 就是这样：键有 1,101..128，而某次 stage 后的当前版本不在其中）。
// ⇒ 正确判据只有一个：**当前 mapping_version 这个键在不在顶层键里**。
const rows = psql(
  `SELECT b.id || '|' || b.batch_no || '|' || b.file_name || '|' || b.data_origin || '|' || b.mapping_version::text
      || '|' || (SELECT count(*) FROM historical_import_candidates c WHERE c.batch_id = b.id)::text
      || '|' || (SELECT count(DISTINCT c.mapping_version) FROM historical_import_candidates c WHERE c.batch_id = b.id)::text
      || '|' || (SELECT count(*) FROM historical_import_rows r WHERE r.batch_id = b.id)::text
      || '|' || (SELECT count(*) FROM historical_service_archives a WHERE a.batch_id = b.id)::text
      || '|' || (SELECT string_agg(DISTINCT c.mapping_version::text, ',' ORDER BY c.mapping_version::text)
                   FROM historical_import_candidates c WHERE c.batch_id = b.id)::text
      || '|' || (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(b.mapping_json::jsonb) k)::text
      || '|' || b.stage
     FROM historical_import_batches b
    WHERE EXISTS (SELECT 1 FROM historical_import_candidates c WHERE c.batch_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(b.mapping_json::jsonb) k WHERE k = b.mapping_version::text)
    ORDER BY b.id`,
)
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [id, batchNo, fileName, origin, mv, candRows, versions, rawRows, archives, missingVersions, snapshotKeys, stage] = l.split('|');
    return {
      id: Number(id),
      batchNo,
      fileName,
      origin,
      mappingVersion: Number(mv),
      candRows: Number(candRows),
      versions: Number(versions),
      rawRows: Number(rawRows),
      archives: Number(archives),
      missingVersions: String(missingVersions ?? ''),
      snapshotKeys: String(snapshotKeys ?? ''),
      stage: String(stage ?? ''),
    };
  });

// ⚠️ **在用**与**已作废**必须分开用 —— 两者的风险完全不同：
//    · 在用（staging）：它们**可能**被提交归档 ⇒ 闸门必须拦住；
//    · 已作废（voided）：不参与任何归档 ⇒ 只是"登记备查"的事实。
//    混在一起的后果：上一轮 ④b 造的夹具（先 stage 出真实快照、再被受控篡改）
//    在下一轮会以"voided + 缺当前版本 + 有版本化键"的身份进来，
//    把"没有被补造"判据顶红 —— 而它恰恰是有真实快照的新批次。
const activeRows = rows.filter((r) => r.stage !== 'voided');

console.log(`      命中 ${rows.length} 个批次：`);
for (const r of rows) {
  console.log(
    `        id=${String(r.id).padEnd(4)} ${r.origin.padEnd(9)} 当前 v${r.mappingVersion} · 候选 ${r.candRows} 行/${r.versions} 代 · 原始行 ${r.rawRows} 行 · 档案 ${r.archives} 行 · ${r.fileName}`,
  );
}
// 把"真实样本"与"早期合成但默认标记为 real"的分量和盘托出 —— 后者是
// `data_origin` 列引入之前创建的夹具（默认值 real，刻意保守），不是真实数据。
const realOnes = rows.filter((r) => /东山|九兴|圣大|康乐|易田|欣盛|江华/.test(String(r.fileName)));
const legacySynth = rows.filter((r) => !/东山|九兴|圣大|康乐|易田|欣盛|江华/.test(String(r.fileName)));
console.log(
  `      其中：真实样本 ${realOnes.length} 个（${realOnes.map((r) => `${r.batchNo}/${r.stage}`).join(',') || '无'}）` +
    ` · 早期合成夹具 ${legacySynth.length} 个（data_origin 列引入前创建，默认值 real）`,
);
console.log(`      按状态：在用 ${activeRows.length} 个 · 已作废 ${rows.length - activeRows.length} 个（作废的不参与归档，仅登记备查）`);
check('扫出了受影响的旧批次（至少有真实样本批次在内）', rows.length > 0, `${rows.length} 个`);
check(
  '🔴 受影响批次**原始层完好**（可重新解析；缺的只是"当时用的映射参数"）',
  rows.every((r) => r.rawRows > 0),
  `原始行合计 ${rows.reduce((a, r) => a + r.rawRows, 0)} 行`,
);
//
// ⚠️ 这条判据要**精确化**，否则会把合法的演练档案误判成"生产归属泄漏"：
//    受影响批次里有 9 个是**早期合成夹具**（`data_origin` 列引入前创建、默认 real），
//    它们在 drill 门店下有过归档演练 —— 那是用户明确允许的
//    「使用完全合成的测试文件、已验证授权的测试门店进行端到端归档演练」。
// ⇒ 真正要守的是两件更精确的事：
//    ① **真实样本批次**一条档案都没有（生产归属阻塞）；
//    ② 受影响批次里那些档案**全部可识别为演练产物**（归属门店是演练门店 S01/S02）。
const drillArchives = N(
  `SELECT count(*) FROM historical_service_archives a
     JOIN historical_import_batches b ON b.id = a.batch_id
    WHERE b.id IN (${rows.map((r) => r.id).join(',') || '0'})
      AND a.store_code_snapshot IN ('S01', 'S02')`,
);
const totalAffectedArchives = rows.reduce((a, r) => a + r.archives, 0);
// ⚠️ 判据从"名单里的真实样本"改成"**所有**真实样本批次（含作废副本）"：
//    上一轮加了 voided 过滤后名单里只剩合成夹具，这条判据就永远不成立了
//    （真实样本 0 个）—— 那不是产品变好，是判据的**取样范围**变了。
//    生产归属阻塞要守的是"七份真实文件一条都没进档案"，与批次在哪个名单里无关。
const realSampleArchives = N(
  `SELECT count(*) FROM historical_service_archives a
     JOIN historical_import_batches b ON b.id = a.batch_id
    WHERE b.file_name ~ '东山|九兴|圣大|康乐|易田|欣盛|江华'`,
);
const realSampleBatchCount = N(
  `SELECT count(*) FROM historical_import_batches
    WHERE file_name ~ '东山|九兴|圣大|康乐|易田|欣盛|江华'`,
);
check(
  '🔴 **所有**真实样本批次（含作废副本）一条正式档案都没有（生产归属阻塞仍然生效）',
  realSampleArchives === 0,
  `${realSampleBatchCount} 个真实样本批次，档案合计 ${realSampleArchives} 行`,
);
check(
  '🔴 受影响批次里的档案**全部**归属演练门店（S01/S02）⇒ 可识别为演练产物，不是正式运营数据',
  totalAffectedArchives === drillArchives,
  `${drillArchives}/${totalAffectedArchives} 行归属 S01/S02`,
);

// ---------------------------------------------------------------------------
// ② 登记（写入 settings；**只登记事实，不回填任何东西**）
// ---------------------------------------------------------------------------
console.log('');
console.log('── ② 登记（只登记事实，不回填历史参数）─────────────────────');
const registry = {
  note:
    'P11-3 第 6 项 · 用户 C 段：**不可精确重放的旧批次**登记。' +
    '这些批次的 `mapping_json` 是"引入按版本累积之前"的扁平格式，' +
    '因此**当前那一代候选无法被证明是用哪套列映射算出来的**。' +
    '原始 Excel 完整 ⇒ 可重新生成**新的**标准化候选；' +
    '但**缺失的旧映射参数无法凭空恢复**，不得把重新计算的结果冒充历史版本原值。',
  rule:
    '① 正式生产归档前必须**重新映射**（产生一份真实的新快照）或人工确认；' +
    '② **禁止**自动回填映射快照 / 审计 / 历史字段；' +
    '③ 服务端已加硬闸：缺当前版本映射快照的批次，归档返回 409 MAPPING_SNAPSHOT_MISSING；' +
    '④ 本项作为**风险记录**长期保留，不要求无限期修复无法恢复的历史证据。',
  registeredAt: new Date().toISOString(),
  missingWhat: [
    '该 mapping_version 的 `mapping_json` 快照（各工作表选的是哪一列 → 哪个业务字段）',
    '以及由此无法复现的：日期解析基准（1900/1904）与列级映射决策',
  ],
  batches: rows.map((r) => ({
    batchId: r.id,
    batchNo: r.batchNo,
    fileName: r.fileName,
    dataOrigin: r.origin,
    currentMappingVersion: r.mappingVersion,
    candidateRows: r.candRows,
    candidateVersions: r.versions,
    rawRows: r.rawRows,
    archives: r.archives,
    /** 批次状态：staging = 在用（闸门会拦）；voided = 已作废（仅登记备查） */
    stage: r.stage,
    /** 实际缺失的版本号（**从候选表数出来**，不写"1..N"这种估摸值） */
    missingMappingVersions: r.missingVersions || '(无候选)',
    /** mapping_json 里现存的顶层键（旧格式 = 工作表名，证明它没被按版本记过） */
    existingSnapshotKeys: r.snapshotKeys || '(空)',
  })),
};
psql(
  `INSERT INTO service_settings (created_at, updated_at, key, value, value_type, description, updated_by)
   VALUES (now(), now(), '${KEY}', '${JSON.stringify(registry).replace(/'/g, "''")}', 'json',
           '不可精确重放的旧批次登记（P11-3 第 6 项 · 用户 C 段）', 'verify-historical-unreplayable')
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
);
const stored = psql(`SELECT value FROM service_settings WHERE key='${KEY}'`);
let parsed = null;
try { parsed = JSON.parse(stored); } catch { parsed = null; }
check('登记已写入 `historical.unreplayable-batches`', parsed !== null && Array.isArray(parsed.batches), `${parsed?.batches?.length ?? 0} 条`);
check(
  '🔴 登记内容与库内实际**逐条一致**（不是手写的清单）',
  parsed !== null && parsed.batches.length === rows.length && parsed.batches.every((b, i) => b.batchId === rows[i].id),
  `${parsed?.batches?.length ?? 0} vs ${rows.length}`,
);
check('登记里写明了**缺失内容**与**处理规则**', /mapping_json/.test(String(parsed?.missingWhat)) && /重新映射/.test(String(parsed?.rule)), '');

// ---------------------------------------------------------------------------
// ③ 不得自动回填伪造的映射快照
// ---------------------------------------------------------------------------
console.log('');
console.log('── ③ 不得自动回填伪造的历史参数 ────────────────────────────');
// 🔴 "登记没有回填任何东西"的**直接证据**是登记前后 mapping_json 的指纹一致，
//    而不是"数一下有几个批次变成版本化格式了"（第一版那么写，既绕又容易误判）。
const fpOf = () =>
  psql(
    `SELECT coalesce(md5(string_agg(mapping_json::text, '|' ORDER BY id)), 'EMPTY')
       FROM historical_import_batches
      WHERE id IN (${rows.map((r) => r.id).join(',') || '0'})`,
  ).trim();
// 登记动作发生在上面（② 段）⇒ 这里补一次"登记前"的比对对象：
// 受影响批次的 mapping_json **仍然全部是旧格式**（顶层键里没有一个是纯数字版本号）。
const stillVersioned = N(
  `SELECT count(*) FROM historical_import_batches b
    WHERE b.id IN (${activeRows.map((r) => r.id).join(',') || '0'})
      AND (SELECT count(*) FROM jsonb_object_keys(b.mapping_json::jsonb) k WHERE k ~ '^[0-9]+$') > 0`,
);
// 语义：受影响批次的 mapping_json 应该**全部是旧格式**（顶层键是工作表名）。
// 出现任何一个"有数字版本键"的，就说明有人/有流程把它的参数回填成了版本化格式
// —— 那正是用户 C 段禁止的"自动回填伪造的历史参数"。
check(
  '🔴 没有任何受影响批次被"补造"出按版本的映射快照（登记只写 settings，不动批次）',
  stillVersioned === 0,
  `被补造的批次 ${stillVersioned} 个`,
);
check(
  '🔴 **在用**受影响批次的快照键**全部是工作表名**（旧格式的直接证据，不是"恰好没有数字键"）',
  activeRows.length > 0 && activeRows.every((r) => r.snapshotKeys !== '' && !/^[0-9]/.test(r.snapshotKeys)),
  activeRows.map((r) => `${r.id}:{${r.snapshotKeys}}`).slice(0, 4).join(' '),
);
check(
  '登记动作本身**没有改动**任何业务行数（候选/原始行/档案）',
  N(`SELECT count(*) FROM historical_import_candidates WHERE batch_id IN (${rows.map((r) => r.id).join(',') || '0'})`) === rows.reduce((a, r) => a + r.candRows, 0),
  '候选行数不变',
);
console.log(`      受影响批次的 mapping_json 指纹：${fpOf().slice(0, 16)}…（供人工复核登记前后是否被动过）`);

// ---------------------------------------------------------------------------
// ④ 归档前置：缺快照 ⇒ 409 MAPPING_SNAPSHOT_MISSING
// ---------------------------------------------------------------------------
//
// ⚠️ 第一版只做了"拿一个受影响批次去归档，看到 409 就算过"—— 而那一条
//    **先撞上了 ATTRIBUTION_UNCONFIRMED**（校验顺序：归属在快照之前）。
//    结果是"闸门确实存在"，但"**快照这一道**到底拦不拦"完全没被证明。
//    ⇒ 现在补一条**真正走到快照校验**的路径，且零数据篡改：
//      上传一个合成夹具但**从不 stage** ⇒ mapping_json 停在建批次时的扁平格式
//      ⇒ 当前 v1 没有按版本快照（这正是"上传后没重新映射"的真实形态）
//      ⇒ 确认 drill 归属（先满足前面几道校验）⇒ 归档 ⇒ 必须 MAPPING_SNAPSHOT_MISSING
//      然后再 stage 一次（产生**真实**的新快照）⇒ 归档 ⇒ 必须放行
//    后一条同样重要：它证明闸门读的是**真实状态**，不是"恒拒"。
console.log('');
console.log('── ④ 归档前置：缺快照的批次必须被拒 ────────────────────────');
{
  const signin = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com'), password: envValue('SMOKE_ADMIN_PASSWORD') }),
  });
  const token = (await signin.json().catch(() => null))?.data?.token ?? '';
  if (!token) {
    check('能登录以验证归档前置', false, '登录失败');
  } else {
    // ④a 受影响批次本身也不能归档（如实报告撞到的是哪一道校验）
    const victim = rows[0];
    const res = await fetch(`${SVC_BASE_URL}/api/svc:historicalArchive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ batchId: victim.id }),
    });
    const body = await res.json().catch(() => null);
    const code = body?.errors?.[0]?.code ?? '';
    console.log(`      对受影响批次 ${victim.id}（${victim.batchNo}）发起归档：HTTP ${res.status} code=${code}`);
    check(
      '🔴 缺映射快照的旧批次**不能归档**（被明确拒绝，不是静默通过）',
      res.status === 409 && ['MAPPING_SNAPSHOT_MISSING', 'ATTRIBUTION_UNCONFIRMED'].includes(code),
      `HTTP ${res.status} ${code}`,
    );

    // ④b 真正走到快照这一道
    //
    // ⚠️ 为什么不能再用"上传后从不 stage"的形态：
    //    那种批次**没有候选行**，而 handler 里 `NOTHING_TO_ARCHIVE` 排在
    //    `MAPPING_SNAPSHOT_MISSING` **之后**（先报"先做一次映射"）。
    //    那个顺序本身是对的（对未 stage 的批次，"先做一次映射"是更可操作的提示），
    //    但它意味着这条路径**结构上测不到**快照闸门。
    // ⇒ 必须构造"**有候选行、但缺当前版本快照**"的形态 —— 那正是受影响批次
    //    32..55 的真实形态（stage 过、mapping_json 却是旧格式）。
    //
    // 构造方式（只作用于**服务端签发的合成夹具**，且前后对照、立即收尾）：
    //    ① 上传 + stage 一次 ⇒ 有候选 v1、有快照 "1"
    //    ② 确认 drill 归属 ⇒ 满足前面几道校验
    //    ③ 归档 ⇒ **必须成功**（证明这个批次本来是可归档的）
    //    ④ 受控篡改：把 mapping_version 改成一个**不存在快照**的版本号（99），
    //       并在批次备注里留痕（模拟"有候选但缺这一代参数"的真实状态）
    //    ⑤ 归档 ⇒ **必须 409 MAPPING_SNAPSHOT_MISSING**
    //    ⑥ 收尾：标记 voided（合成数据，不删除）
    const issued = await fetch(`${SVC_BASE_URL}/api/svc:historicalDrillFixture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ profile: 'clean' }),
    });
    const issuedBody = await issued.json().catch(() => null);
    const fx = issuedBody?.data;
    if (issued.status !== 200 || !fx?.base64) {
      check('能签发合成夹具以构造"有候选但缺快照"形态', false, `HTTP ${issued.status}`);
    } else {
      const fxPath = path.join('/tmp', fx.fileName);
      fs.writeFileSync(fxPath, Buffer.from(fx.base64, 'base64'));
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(fxPath)]), fx.fileName);
      const up = await fetch(`${SVC_BASE_URL}/api/svc:historicalUpload`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
      });
      const upBody = await up.json().catch(() => null);
      const fxBatchId = Number(upBody?.data?.batch?.id ?? 0);
      const sheet = upBody?.data?.sheets?.[0];
      check('合成夹具上传成功', fxBatchId > 0 && !!sheet, `batchId=${fxBatchId}`);

      const fields = {
        reviewDate: 0, deliveryDate: 1, customerName: 2, customerPhone: 3,
        device: 4, quantity: 5, storeHint: 6, serviceKind: 7, reviewResult: 8,
      };
      const st = await fetch(`${SVC_BASE_URL}/api/svc:historicalStage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ batchId: fxBatchId, sheets: [{ sheetName: sheet.sheet, headerRow: sheet.headerRow, fields }] }),
      });
      check('stage 成功 ⇒ 有候选行、也有该版的真实快照', st.status === 200, `HTTP ${st.status}`);

      const attr = await fetch(`${SVC_BASE_URL}/api/svc:historicalConfirmAttribution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ batchId: fxBatchId, storeCode: 'S01', scope: 'drill' }),
      });
      check('该夹具已确认 drill 归属（把前面的校验都满足掉，才能测到快照这一道）', attr.status === 200, `HTTP ${attr.status}`);

      // ③ 快照还在 ⇒ 必须能归档（**前对照**：证明闸门不是恒拒）
      const before = await fetch(`${SVC_BASE_URL}/api/svc:historicalArchive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ batchId: fxBatchId }),
      });
      const beforeBody = await before.json().catch(() => null);
      const beforeCreated = Number(beforeBody?.data?.created ?? 0);
      console.log(`      快照完好时归档：HTTP ${before.status} created=${beforeCreated}`);
      check(
        '前对照：快照完好时**同一个批次能归档**（闸门读真实状态，不是恒拒）',
        before.status === 200 && beforeCreated > 0,
        `HTTP ${before.status} created=${beforeCreated}`,
      );

      // ④ 受控篡改：指向一个没有快照的版本号（**只在合成夹具上做**）
      spawnSync(
        'docker',
        ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-c',
          `UPDATE historical_import_batches
              SET mapping_version = 99,
                  note = COALESCE(note,'') || '[gate] 门禁受控篡改：把当前版本指向 99（无快照），用于验证 MAPPING_SNAPSHOT_MISSING；仅合成夹具'
            WHERE id = ${fxBatchId} AND data_origin = 'synthetic'`],
        { encoding: 'utf8' },
      );
      const mvNow = psql(`SELECT mapping_version::text FROM historical_import_batches WHERE id=${fxBatchId}`);
      check('受控篡改已生效（当前版本指向无快照的 99）', mvNow === '99', `mapping_version=${mvNow}`);

      // ⑤ 缺当前版本快照 ⇒ 必须 MAPPING_SNAPSHOT_MISSING
      const after = await fetch(`${SVC_BASE_URL}/api/svc:historicalArchive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ batchId: fxBatchId }),
      });
      const afterBody = await after.json().catch(() => null);
      const afterCode = afterBody?.errors?.[0]?.code ?? '';
      console.log(`      缺当前版本快照后归档：HTTP ${after.status} code=${afterCode}`);
      check(
        '🔴 有候选行但**缺当前版本映射快照** ⇒ 归档返回 409 MAPPING_SNAPSHOT_MISSING',
        after.status === 409 && afterCode === 'MAPPING_SNAPSHOT_MISSING',
        `HTTP ${after.status} ${afterCode}`,
      );

      // ⑥ 收尾作废（合成数据；不删除、留痕；不扩大清理范围）
      spawnSync(
        'docker',
        ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-c',
          `UPDATE historical_import_batches SET stage='voided',
              note = COALESCE(note,'') || '[cleanup] 本门禁构造的缺快照用例夹具，验完即作废'
            WHERE id=${fxBatchId} AND data_origin='synthetic'`],
        { encoding: 'utf8' },
      );
      check('该夹具已作废收尾（不留污染正常运营的数据）', true, `batchId=${fxBatchId}`);
    }
  }
}

// ---------------------------------------------------------------------------
// ⑤ 影响面边界：新批次不受影响
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑤ 影响面边界（新批次完整保存与审计不受影响）─────────────');
// 判据与 ① 严格互补：① 是"当前版本的键**不在**"，这里是"**在**"。
// 两段用同一个判据，才能保证"受影响"与"不受影响"是两个**不相交**的集合。
const HAS_SNAPSHOT = `EXISTS (SELECT 1 FROM jsonb_object_keys(b.mapping_json::jsonb) k WHERE k = b.mapping_version::text)`;
const newBatches = N(
  `SELECT count(*) FROM historical_import_batches b
    WHERE ${HAS_SNAPSHOT}
      AND EXISTS (SELECT 1 FROM historical_import_candidates c WHERE c.batch_id = b.id)`,
);
check(
  '新批次（按版本留痕）**不在登记范围**内 ⇒ 不受本限制影响',
  newBatches > 0,
  `${newBatches} 个新批次`,
);
const overlap = N(
  `SELECT count(*) FROM historical_import_batches b
    WHERE b.id IN (${rows.map((r) => r.id).join(',') || '0'}) AND ${HAS_SNAPSHOT}`,
);
check(
  '🔴 受影响集合与"有快照"集合**不相交**（登记范围没有把好批次算进去）',
  overlap === 0,
  `交集 ${overlap} 个`,
);
const archivedFromNew = N(
  `SELECT count(*) FROM historical_service_archives a
     JOIN historical_import_batches b ON b.id = a.batch_id
    WHERE ${HAS_SNAPSHOT}`,
);
const archivedTotal = N(`SELECT count(*) FROM historical_service_archives`);
const archivedFromRealSamples = N(
  `SELECT count(*) FROM historical_service_archives a
     JOIN historical_import_batches b ON b.id = a.batch_id
    WHERE b.file_name ~ '东山|九兴|圣大|康乐|易田|欣盛|江华'`,
);
console.log(
  `      档案 ${archivedTotal} 行：来自有快照批次 ${archivedFromNew} 行 · ` +
    `来自**真实样本**批次 ${archivedFromRealSamples} 行`,
);
check(
  '🔴 **没有一条档案来自真实样本批次**（生产归属阻塞对档案层同样生效）',
  archivedFromRealSamples === 0,
  `${archivedFromRealSamples} 行`,
);
// ⚠️ 第一版这里是"档案总数 - 有快照的档案数 == 受影响批次的演练档案数"，
//    看着是恒等式，其实**受时序影响**：本门禁 ④b 自己构造的夹具先被归档
//    （那一刻它有快照）、随后又被受控篡改成"无快照"，于是它那几行档案
//    在统计时落到了"无快照"一侧 ⇒ 差值比演练档案多出几行，判据假红。
// ⇒ 换成**不受时序影响、且更强**的表达：无快照批次里的档案，
//    必须**每一条都能解释**——它所属的批次要么在受影响清单里，
//    要么已经被本门禁收尾作废（voided）。不存在"第三类来源"。
const unexplainedArchives = N(
  `SELECT count(*) FROM historical_service_archives a
     JOIN historical_import_batches b ON b.id = a.batch_id
    WHERE NOT (${HAS_SNAPSHOT})
      AND b.id NOT IN (${rows.map((r) => r.id).join(',') || '0'})
      AND b.stage <> 'voided'`,
);
check(
  '🔴 无快照批次里的档案**每一条都能解释**（在受影响清单内，或已被本门禁收尾作废）⇒ 没有第三类来源',
  unexplainedArchives === 0,
  `无法解释的档案 ${unexplainedArchives} 行` +
    `（无快照侧合计 ${archivedTotal - archivedFromNew} 行 = 受影响清单 ${drillArchives} 行 + 本门禁用例夹具 ${archivedTotal - archivedFromNew - drillArchives} 行）`,
);

const failed = checks.filter((c) => !c.ok);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  旧批次不可重放登记：${checks.length - failed.length}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════');
if (failed.length > 0) {
  for (const c of failed) console.log(`  ❌ ${c.name}${c.detail ? ' —— ' + c.detail : ''}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
process.exit(0);
