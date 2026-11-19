#!/usr/bin/env node
/**
 * BE-03-SMS-FIX-01 · 师傅任务短信最小验证（**隔离环境 + mock 通道**）
 *
 *   node scripts/verify-sms-fix-01-tech-task.mjs
 *
 * 只回答三件事（其余一律不碰）：
 *   ① 师傅任务短信**能不能进入发送链路**？（修前被 SMS_TEMPLATE_PENDING_REVIEW 拦死）
 *   ② 正文里的 `/p/t/{code}` 是否被替换成**真实 22 位凭据**、正文与审核版**逐字一致**？
 *   ③ 后台三个场景的中文名是否正确（客户报修成功通知 / 客户处理进展通知 / 师傅任务通知）？
 *
 * 边界（刻意写死）：
 *   · 只跑 mock provider —— 容器 env `SMS_PROVIDER=mock`、`SMS_ENABLED=false`；
 *   · 本脚本**不打开** sms.enabled、**不**发真实短信、**不**给真实师傅号码发任何东西；
 *   · 收件号码使用文档保留的**假号码**，不取自任何真实师傅记录。
 *
 * ⚠️ 与 `verify-progress-sms-link.mjs` 的关键差别：
 *    那个脚本断言"开发环境**禁发**满足（发件箱无新增）"，
 *    本轮要断言的恰恰相反 —— 修复后师傅短信**必须真的走到 provider**。
 *    所以这里把 sms.enabled 临时打开（仅本机隔离库），跑完**必须还原**（finally 兜底）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SVC_BASE_URL } from './lib/base-url.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 门店入口标识：建单必须带（缺了会 422 MISSING_STORE_ENTRY） */
const ENTRY = JSON.parse(fs.readFileSync(path.join(ROOT, 'storage/tmp/device-test/entry.json'), 'utf8')).entry;

const checks = [];
function ok(name, pass, detail = '') {
  checks.push({ name, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envValue(key) {
  const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

function psql(sql) {
  const r = spawnSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const err = String(r.stderr ?? '').trim();
  if (err) return `PSQL_ERROR:${err.split('\n')[0]}`;
  return String(r.stdout ?? '').trim();
}

async function loadProductModule(relPath, exportNames) {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const esbuild = req('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/esbuild/lib/main.js');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'nocobase/plugins/service-ticket/src/server', relPath)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    external: ['@nocobase/*', 'knex', 'sequelize', 'pino', '@napi-rs/*'],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, req);
  const picked = {};
  for (const n of exportNames) picked[n] = mod.exports[n];
  return picked;
}

async function httpJson(p, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(p.startsWith('http') ? p : `${SVC_BASE_URL}${p}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
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

const rid = () =>
  `11111111-2222-4333-8444-${Date.now().toString(16).slice(-6).padStart(6, '0')}${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;

const maskMobile = (m) => String(m ?? '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  BE-03-SMS-FIX-01 · 师傅任务短信最小验证（隔离 + mock）');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  基址 : ${SVC_BASE_URL}`);

// ---------- 0. 前置：必须是隔离环境、必须是 mock ----------
console.log('\n── ⓪ 前置检查（拒绝在错误环境里"验证"）──────────────────');
const provider = (() => {
  const r = spawnSync('docker', ['exec', 'svc-app', 'printenv', 'SMS_PROVIDER'], { encoding: 'utf8' });
  return String(r.stdout ?? '').trim();
})();
ok('隔离容器 SMS_PROVIDER = mock（不会触达真实短信宝）', provider === 'mock', `实际 = ${provider || '(空)'}`);
if (provider !== 'mock') {
  console.log('\n⛔ 中止：当前不是 mock 通道，拒绝继续（避免给真实号码发短信）。');
  process.exit(2);
}

// 产品常量（判据必须来自产品源码，不能自己抄一份）
const { SMS_REVIEW_PENDING_SCENES, SMS_TEMPLATE_TEXT, SMS_SCENE_LABEL, SMS_SCENE } = await loadProductModule(
  'constants.ts',
  ['SMS_REVIEW_PENDING_SCENES', 'SMS_TEMPLATE_TEXT', 'SMS_SCENE_LABEL', 'SMS_SCENE'],
);

/**
 * 🔴 前置硬闸：**判据本身必须先被证明会红**。
 *    实测教训（2026-11-06 变异测试）：把 `technician_task` 加回
 *    `SMS_REVIEW_PENDING_SCENES` 后重新构建、重启，脚本仍然打出
 *    「✅ 发件箱新增了 technician_task 条目」—— 因为发件箱里还留着**上一轮**的条目
 *    （`since_seq=0` 拉到的是历史全量），于是"这条断言从来没被真正检验过"。
 *    ⇒ 只要源码里还挂着这个闸，脚本直接判 INVALID 退出，
 *      不让后面那些"看起来绿"的断言冒充结论。
 */
if (SMS_REVIEW_PENDING_SCENES.includes('technician_task')) {
  console.log(
    `\n⛔ TEST INVALID：源码里 SMS_REVIEW_PENDING_SCENES 仍含 technician_task（${JSON.stringify(
      SMS_REVIEW_PENDING_SCENES,
    )}）——`,
  );
  console.log('   本次修复未生效，后续断言一律不可信。');
  process.exit(2);
}

ok(
  'SMS_REVIEW_PENDING_SCENES 已不再拦 technician_task（本轮修复点）',
  !SMS_REVIEW_PENDING_SCENES.includes('technician_task'),
  `当前表 = ${JSON.stringify(SMS_REVIEW_PENDING_SCENES)}`,
);

// 正文模板逐字基准（用户裁决版）
const TECH_TPL = '【{sign}】您有新的售后服务任务，请点击链接查看并处理：https://sh.scqfls.cn/p/t/{code}';
ok(
  '师傅短信模板正文与裁决版逐字一致（不含门店/工单号/客户姓名/手机号）',
  SMS_TEMPLATE_TEXT[SMS_SCENE.TECHNICIAN_TASK] === TECH_TPL,
  SMS_TEMPLATE_TEXT[SMS_SCENE.TECHNICIAN_TASK],
);

// ---------- 1. 打开 sms.enabled（仅本机隔离库），务必还原 ----------
const origEnabled = psql(`SELECT coalesce(value,'(none)') FROM service_settings WHERE key='sms.enabled'`);
console.log(`\n── ① 临时打开本机隔离环境的 sms.enabled（原值 ${origEnabled}）────`);
psql(`UPDATE service_settings SET value='true', updated_at=now() WHERE key='sms.enabled'`);
const afterSet = psql(`SELECT coalesce(value,'(none)') FROM service_settings WHERE key='sms.enabled'`);
console.log(`  · 写入后库值 = ${afterSet}；等待 12s 让配置缓存过期…`);
await sleep(12_000);

let restoreDone = false;
const restore = () => {
  if (restoreDone) return;
  restoreDone = true;
  psql(`UPDATE service_settings SET value='${origEnabled === '(none)' ? 'false' : origEnabled}', updated_at=now() WHERE key='sms.enabled'`);
  console.log(`\n  · 已还原 sms.enabled = ${psql(`SELECT coalesce(value,'(none)') FROM service_settings WHERE key='sms.enabled'`)}`);
};
process.on('exit', restore);
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});

try {
  // ---------- 2. 总部登录 ----------
  const hq = await (async () => {
    const r = await httpJson('/api/auth:signIn', {
      method: 'POST',
      body: { email: 'uat.hq@svc.local', password: envValue('UAT_HQ_PASSWORD') },
    });
    const token = r.json?.data?.token;
    if (!token) throw new Error(`总部登录失败：HTTP ${r.status} ${r.text.slice(0, 200)}`);
    return token;
  })();

  const outbox = async () => {
    const r = await httpJson('/api/svc:smsOutbox?since_seq=0&limit=200', { headers: { Authorization: `Bearer ${hq}` } });
    return r.json?.data?.items ?? [];
  };

  // ---------- 3. 建单 → 派工（走真实业务链路，不直接调 enqueue） ----------
  const before = await outbox();
  const beforeSeq = before.reduce((m, i) => Math.max(m, i.seq ?? 0), 0);

  // 假图片：最小 PNG（1x1），避免依赖外部素材
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const sess = (await httpJson('/api/public/media/session', { method: 'POST', body: { media_consent: true } })).json?.data;
  const form = new FormData();
  form.append('file', new Blob([PNG]), 'p.png');
  await fetch(`${SVC_BASE_URL}/api/public/media/upload`, {
    method: 'POST',
    headers: { 'X-Media-Session': sess.session_token },
    body: form,
  });

  // ⚠️ 客户号码用**假号码**（1xx 段不存在真实个人），师傅号码亦用假号。
  //    每次随机末四位：产品有"同一手机号当日提交次数上限"的限流闸，
  //    固定号码连跑两次就会被 429 拦下 —— 那是限流生效（好事），不是短信链路问题。
  const FAKE_CUST = `1350000${String(1000 + Math.floor(Math.random() * 8000)).slice(-4)}`;
  const created = await httpJson(`/api/public/tickets?k=${ENTRY}`, {
    method: 'POST',
    headers: { 'X-Request-Id': rid() },
    body: {
      ticket_type: 'repair',
      content: `FIX-01 师傅短信链路验证 ${Date.now()}`,
      customer_name: '链路验证',
      customer_mobile: FAKE_CUST,
      media_session: { id: sess.session_id, token: sess.session_token },
    },
  });
  const ticketNo = created.json?.data?.ticket_no;
  ok('建单成功', created.status === 201 && !!ticketNo, `HTTP ${created.status} · ${ticketNo ?? created.text.slice(0, 120)}`);
  if (!ticketNo) throw new Error('建单失败，无法继续');

  // 派工：门店账号把工单派给一个**不存在的师傅手机号**（假号），只验证短信链路
  const store = await httpJson('/api/auth:signIn', {
    method: 'POST',
    body: {
      email: envValue('UAT_STORE_A_EMAIL') || 'uat.store.a@svc.local',
      password: envValue('UAT_STORE_A_PASSWORD'),
    },
  });
  const storeToken = store.json?.data?.token;

  const FAKE_TECH = '13500000001';
  // 🔴 ticket_id **不在建单响应的 data 里**（返回的是 ticket_no / progress_token 等对外字段），
  //    直接读 `created.json.data.id` 会拿到 undefined，然后 422 INVALID_TICKET_ID。
  //    这里按 ticket_no 回查一次（只读），不复用任何"猜 id"的写法。
  const ticketId = Number(
    psql(`SELECT id FROM service_tickets WHERE ticket_no='${ticketNo}'`).split('\n')[0],
  );
  ok('回查到工单主键', Number.isInteger(ticketId) && ticketId > 0, `ticket_id=${ticketId}`);
  const assign = await httpJson('/api/svc:dispatch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${storeToken}`, 'X-Request-Id': rid() },
    body: {
      ticket_id: ticketId,
      service_mode: 'inhouse',
      technician_name: '链路验证师傅',
      technician_mobile: FAKE_TECH,
      // 自有师傅上门必须带预计上门日期（缺了 422 MISSING_EXPECTED_VISIT）
      expected_visit_at: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
      reason: 'FIX-01 链路验证',
    },
  });
  console.log(`  · 派工响应：HTTP ${assign.status} ${assign.text.slice(0, 200)}`);

  await sleep(3000);
  const after = await outbox();
  const fresh = after.filter((i) => (i.seq ?? 0) > beforeSeq);
  const tech = fresh.find((i) => i.scene === 'technician_task');
  const prog = fresh.find((i) => i.scene === 'progress_link' || i.scene === 'progress_update');

  console.log('\n── ② 师傅任务短信是否进入发送链路 ────────────────────────');
  ok('发件箱新增了 technician_task 条目（＝真的走进了 provider）', !!tech,
    tech ? `seq=${tech.seq}` : `本次新增 scenes = [${fresh.map((i) => i.scene).join(', ')}]`);
  if (prog) console.log(`  · 同时产生的客户短信：${prog.scene}（本轮不改它，仅观察）`);

  if (tech) {
    const preview = String(tech.preview ?? '');
    console.log(`  · 正文：${preview}`);
    console.log(`  · 收件：${maskMobile(tech.to ?? tech.recipient ?? '')}`);

    // ① 正文 === 模板原文（把 {sign}{code} 换成实际值后逐字比对）
    const rendered = TECH_TPL.replace('{sign}', SMS_SIGN_NAME_OF(preview)).replace(
      /\{code\}/,
      '((...))',
    );
    const codeMatch = preview.match(/\/p\/t\/([A-Za-z0-9_-]+)\s*$/);
    const code = codeMatch ? codeMatch[1] : '';
    ok('正文里带 /p/t/{code}，且 code 是真实凭据', !!code, code ? `${code.length} 位` : '未找到');
    ok('code 长度 = 22（与 PROGRESS 短码口径一致）', code.length === 22, `实际 ${code.length} 位`);
    ok('code 不是未替换的占位符', !/\{|\}/.test(code), code.slice(0, 6) + '…');

    // ② 结构判据：正文必须**正好等于**「签名段 + 模板其余部分」
    // ⚠️ mock 通道会把签名替换成 `【模拟通道】`，2xx 通道则是 `【四川恒晟恒七方】`；
    //    所以只能抹掉签名段再比，不能假定签名文字。
    // ⚠️ 正文**没有句末标点**（审核版就是如此），不能凭印象加"。"。
    const headRe = /^【[^】]*】/;
    const signActual = (preview.match(headRe) ?? [''])[0];
    const bodyActual = preview.replace(headRe, '').replace(/\/p\/t\/[A-Za-z0-9_-]+/, '/p/t/');
    const bodyExpected = TECH_TPL.replace(headRe, '').replace('{code}', '');
    ok('正文结构（除签名/短码外）与裁决版逐字一致', bodyActual === bodyExpected,
      bodyActual === bodyExpected ? `签名段=${signActual} · 其余逐字相同` : `实际「${bodyActual}」`);

    // ③ 合规：不得出现客户姓名、门店名、工单号、任何 11 位手机号
    const leaked = [];
    if (preview.includes('链路验证')) leaked.push('客户姓名');
    if (preview.includes(ticketNo)) leaked.push('工单号');
    if (/1[3-9]\d{9}/.test(preview)) leaked.push('11 位手机号');
    ok('正文未泄露客户姓名/工单号/手机号', leaked.length === 0, leaked.join(',') || '无');

    // ④ 短链可路由（nginx 302，纯路由判据；真实有效性由接口判）
    const shortUrl = `https://sh.scqfls.cn/p/t/${code}`;
    ok('短信里的短链形态正确（https://sh.scqfls.cn/p/t/<22位>）',
      /^https:\/\/sh\.scqfls\.cn\/p\/t\/[A-Za-z0-9_-]{22}$/.test(shortUrl), shortUrl.replace(code, '<code>'));
  }

  // ---------- 4. 后台三个场景名称 ----------
  console.log('\n── ③ 后台场景中文名 ─────────────────────────────────────');
  const expect = {
    progress_link: '客户报修成功通知',
    progress_update: '客户处理进展通知',
    technician_task: '师傅任务通知',
  };
  const ins = await httpJson('/api/svc:insight', { headers: { Authorization: `Bearer ${hq}` } });
  const scenes = ins.json?.data?.scenes ?? ins.json?.data?.sms?.scenes ?? [];
  for (const [scene, want] of Object.entries(expect)) {
    const row = (Array.isArray(scenes) ? scenes : []).find((s) => s.scene === scene);
    const got = row?.label ?? SMS_SCENE_LABEL[scene] ?? '(缺失)';
    ok(`场景名 ${scene} → 「${want}」`, got === want, `实际「${got}」`);
  }

  // ---------- 5. 库内记录 ----------
  console.log('\n── ④ 落库证据 ───────────────────────────────────────────');
  const log = psql(
    `SELECT scene||' | '||send_status||' | '||coalesce(error_code,'-')||' | '||coalesce(left(error_message,60),'-')
       FROM sms_logs WHERE ticket_id=(SELECT id FROM service_tickets WHERE ticket_no='${ticketNo}')
      ORDER BY id`,
  );
  console.log('  ' + log.split('\n').join('\n  '));
  ok(
    'technician_task 落库非 rejected（不再被待审核闸拦）',
    /technician_task \| (accepted|pending)/.test(log),
    log.split('\n').find((l) => l.startsWith('technician_task')) ?? '(无行)',
  );
} catch (e) {
  console.log(`\n⛔ 异常：${e?.message ?? e}`);
  checks.push({ name: '脚本自身执行', pass: false });
} finally {
  restore();
}

// ---------- 汇总 ----------
const failed = checks.filter((c) => !c.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length) {
  console.log('  失败项：');
  for (const f of failed) console.log(`    ❌ ${f.name}`);
}
console.log('══════════════════════════════════════════════════════════════\n');
process.exit(failed.length ? 1 : 0);

/** 从正文里抠签名（`【xxx】` 的第一段）—— 只用于比对结构，不做业务判断 */
function SMS_SIGN_NAME_OF(text) {
  const m = String(text ?? '').match(/^【([^】]*)】/);
  return m ? m[1] : '{sign}';
}
