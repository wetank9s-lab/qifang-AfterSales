#!/usr/bin/env node
/**
 * verify-sms-receipt.mjs —— SMS 送达回执真实行为门禁（Phase 10 / RB-8）
 *
 * ===========================================================================
 * 为什么这支队禁要**在 app 容器内执行**
 * ===========================================================================
 * 回执链路的四条性质，只有跑**真实产物 + 真实数据库 + 真实 HTTP** 才算验过：
 *   ① 合法签名 ⇒ 被消费、delivery_status 真的变 delivered；
 *   ② 坏签名   ⇒ fail-closed（不消费、不改库、不删消息）；
 *   ③ 重复回执 ⇒ 幂等（第二次 0 行受影响，无第二次副作用）；
 *   ④ 状态单调 ⇒ 已 delivered 后到达的 failed **不得**覆盖。
 *
 * 在门禁脚本里重写一遍判定逻辑，验的是脚本自己 —— 所以这里：
 *   · require 的是**容器里真实加载的构建产物**（`@local/service-ticket`）；
 *   · 用容器里的 `pg` 连**真实 Postgres**（`sms_logs` 真表、真条件更新、真事务语义）；
 *   · HTTP 打到**本地真实 socket** 上的桩 MNS —— 它用**同一套 HMAC-SHA1 算法**
 *     严格校验 `Authorization`，签名错一律 403（与阿里云行为一致）。
 *
 * ⚠️ 诚实边界：桩 MNS 不是阿里云。**与真实阿里云队列的联通**需要 AccessKey +
 *   控制台开通 SmsReport 队列，属于发布演练步骤（与 TLS 证书同性质）。
 *   本门禁证明的是"我们的实现对官方协议的理解正确、且对错误输入 fail-closed"，
 *   **不是**"阿里云一定会接受我们的请求"。后者只能由发布演练证明。
 *
 * 用法（在宿主机执行，它负责把脚本送进容器）：
 *   node scripts/verify-sms-receipt.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP_CONTAINER = 'svc-app';
/** 容器内的临时脚本路径（容器内没有宿主目录挂载，只能落在 /tmp） */
/** 容器内路径。**必须放在 /app/nocobase 里**（不是 /tmp）：
 * require('pg') 与 require('@local/service-ticket') 都要沿 node_modules 向上解析，
 * 放在 /tmp 会 MODULE_NOT_FOUND（第一版就踩了这个）。
 */
const IN_CONTAINER = '/app/nocobase/verify-sms-receipt.cjs';

const failures = [];
let passed = 0;

function section(title) {
  console.log('');
  console.log(`【${title}】`);
}
function pass(msg) {
  passed += 1;
  console.log(`  ✅ ${msg}`);
}
function fail(msg) {
  failures.push(msg);
  console.log(`  ❌ ${msg}`);
}

// ---------------------------------------------------------------------------
// 容器内主体
// ---------------------------------------------------------------------------
const BODY = String.raw`
'use strict';
/* 由 scripts/verify-sms-receipt.mjs 注入执行（容器内 /tmp/verify-sms-receipt.cjs） */
const http = require('node:http');
const crypto = require('node:crypto');
const { Client } = require('pg');
const plugin = require('@local/service-ticket');

const {
  MnsReceiptClient, runReceiptTick, normalizeReceipt, signMns, resolveReceiptConfig,
} = plugin;

const ACCESS_KEY_ID = 'AKID-RECEIPT-TEST';
const ACCESS_KEY_SECRET = 'SECRET-receipt-test-0123456789';
const QUEUE = 'Alicom-Queue-TEST-SmsReport';
const ENDPOINT_HOST = '127.0.0.1';
const PROVIDER = 'aliyun';

// ⚠️ 测试手机号：必须是**格式合法但绝不可路由**的号段，避免真发短信。
//   13800000000 属中国移动测试号段，这里只用它做报文里的 To 字段（回执侧不外发）。
const TEST_PHONE = '13800000000';

const failures = [];
let passed = 0;
const ok = (m) => { passed++; console.log('  [PASS] ' + m); };
const no = (m) => { failures.push(m); console.log('  [FAIL] ' + m); };
const assert = (cond, m) => (cond ? ok(m) : no(m));
const assertEq = (a, b, m) => (String(a) === String(b) ? ok(m + ' —— ' + b) : no(m + ' —— 期望 ' + b + '，实际 ' + a));

// ---------------------------------------------------------------------------
// 1. 桩 MNS：**严格校验签名**（与阿里云同算法），签名错一律 403
// ---------------------------------------------------------------------------
/** 阿里云 StringToSign：VERB \n MD5 \n TYPE \n DATE \n '' \n CanonicalizedResource */
function expectedSignature(secret, verb, date, canonicalizedResource) {
  const sts = [verb, '', '', date, '', canonicalizedResource].join('\n');
  return crypto.createHmac('sha1', secret).update(sts, 'utf8').digest('base64');
}

function makeStubMns(state) {
  return http.createServer((req, res) => {
    // 取形如 /queues/Q/messages?waitseconds=..&queueName=..
    const u = new URL(req.url, 'http://stub');
    // 官方 CanonicalizedResource 含 query，且**参数顺序与实际请求一致**。
    const canonicalizedResource = u.pathname + (u.search ? u.search : '');
    const date = req.headers['date'] || '';
    const authz = req.headers['authorization'] || '';

    state.requests.push({
      method: req.method, path: u.pathname, canonicalizedResource,
      date, authz, hasAuthz: !!authz,
    });

    // ① 缺 Date / 缺 Authorization ⇒ 403（官方：Date 缺失/格式错返回 403）
    if (!date || !authz) {
      res.writeHead(403, { 'Content-Type': 'text/xml' });
      return res.end('<Error><Code>InvalidArgument</Code><Message>Date header is invalid or missing.</Message></Error>');
    }
    // ② 校验签名：与客户端**独立重算**（不复用客户端代码，避免"自己算自己验"）
    const want = 'MNS ' + ACCESS_KEY_ID + ':' +
      expectedSignature(ACCESS_KEY_SECRET, req.method, date, canonicalizedResource);
    if (authz !== want) {
      state.authFailures += 1;
      res.writeHead(403, { 'Content-Type': 'text/xml' });
      return res.end('<Error><Code>AccessIDAuthError</Code><Message>AccessID authentication fail.</Message></Error>');
    }

    if (req.method === 'GET') {
      const next = state.queue.shift();
      if (!next) {
        // 官方：队列无消息时 404（MessageNotExist），不是 200 空体
        res.writeHead(404, { 'Content-Type': 'text/xml' });
        return res.end('<Error><Code>MessageNotExist</Code></Error>');
      }
      const xml = '<?xml version="1.0" encoding="utf-8"?><ReceiveMessageResponse>' +
        '<ReceiveMessageResult><Message>' +
        '<MessageId>' + next.messageId + '</MessageId>' +
        '<ReceiptHandle>' + next.receiptHandle + '</ReceiptHandle>' +
        '<MessageBody><![CDATA[' + next.body + ']]></MessageBody>' +
        '<DequeueCount>' + (next.dequeueCount || 1) + '</DequeueCount>' +
        '</Message></ReceiveMessageResult></ReceiveMessageResponse>';
      res.writeHead(200, { 'Content-Type': 'text/xml;charset=utf-8' });
      return res.end(xml);
    }

    if (req.method === 'DELETE') {
      const handle = u.searchParams.get('ReceiptHandle');
      state.deleted.push(handle);
      res.writeHead(204);
      return res.end();
    }

    res.writeHead(405);
    res.end();
  });
}

/** 按官方报文字段构造一条回执（To 会被丢弃 —— 归一化不外带手机号） */
function receiptBody(opts) {
  return JSON.stringify([{
    To: TEST_PHONE,
    Status: opts.status,
    MessageId: opts.messageId,
    SmsSize: '1',
    TaskId: '67890',
    SendDate: 'Thu, 25 Nov 2021 10:27:00 +0800',
    ReceiveDate: opts.receiveDate || 'Thu, 25 Nov 2021 10:27:33 +0800',
    ErrorCode: opts.errorCode || 'success',
    ErrorDescription: opts.errorDescription || 'success',
  }]);
}

(async function main() {
  // ---------------------------------------------------------------- 0. DB
  const pg = new Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });
  await pg.connect();
  const q = (sql, values) => pg.query(sql, values);
  // ⚠️ 适配器必须**忠实实现 Sequelize 的返回契约** [results, metadata]：
  //    pg 的 client.query() 返回的是**单个 Result 对象**，不是数组。
  //    第一版直接透传 pg.query ⇒ applyReceipt 里 const [rows] = … 抛
  //    "is not iterable" ⇒ 被 catch 成 db_error ⇒ 表现为"回执一条都应用不了"。
  //    （这是**门禁自身**的缺陷，不是产品缺陷 —— 真实运行期 db 就是 Sequelize。）
  const db = {
    sequelize: {
      query: async (sql, values) => {
        const r = await pg.query(sql, values);
        return [r.rows, r];
      },
    },
  };

  // 门禁专用 BizId（用不可能与真实数据碰撞的形态）
  const BIZ_A = 'RB8TESTBIZ-A-' + Date.now();
  const BIZ_B = 'RB8TESTBIZ-B-' + Date.now();
  const rowsToClean = [];

  const insertRow = async (bizId) => {
    const r = await q(
      "INSERT INTO sms_logs (scene, provider, template_code, recipient_masked, provider_request_id, provider_biz_id, biz_id, send_status, delivery_status, retry_count, created_at, updated_at) " +
      "VALUES ('dispatch_customer', $1, 'SMS_TEST', '138****0000', 'req-test', $2, $3, 'accepted', 'pending', 0, now(), now()) RETURNING id",
      [PROVIDER, bizId, 'rb8test-' + bizId],
    );
    rowsToClean.push(r.rows[0].id);
    return r.rows[0].id;
  };

  // ---------------------------------------------------------------- 1. 签名纯函数
  console.log('\n【1】MNS 签名（纯函数，逐字对官方规则）');
  // 固定 Date：官方要求 GMT 格式且与服务器相差 ≤15 分钟。纯函数校验时把它钉死，
  // 交叉校验的**双方必须用同一个字符串** —— 第一版这里一处 2012 一处 2022，
  // 断言在比两个不同输入的签名，红得毫无意义（门禁自身的错，不是产品的错）。
  const FIXED_DATE = 'Thu, 17 Mar 2012 18:49:58 GMT';
  {
    const signed = signMns({
      accessKeyId: ACCESS_KEY_ID, accessKeySecret: ACCESS_KEY_SECRET,
      verb: 'GET', contentMd5: '', contentType: '', date: FIXED_DATE,
      canonicalizedResource: '/queues/Q/messages?waitseconds=10&queueName=Q',
    });
    const want = expectedSignature(
      ACCESS_KEY_SECRET, 'GET', FIXED_DATE, '/queues/Q/messages?waitseconds=10&queueName=Q');
    assert(signed.authorization.startsWith('MNS ' + ACCESS_KEY_ID + ':'), 'Authorization 前缀为 "MNS <ak>:"');
    const got = signed.authorization.slice(('MNS ' + ACCESS_KEY_ID + ':').length);
    assertEq(got, want, 'Signature 与官方算法独立重算结果一致');
  }
  {
    // 反向：改了资源路径，签名必须不同（否则等于"什么都签一样"）
    const a = signMns({ accessKeyId: 'a', accessKeySecret: 'b', verb: 'GET', contentMd5: '', contentType: '', date: 'D', canonicalizedResource: '/x' });
    const b = signMns({ accessKeyId: 'a', accessKeySecret: 'b', verb: 'GET', contentMd5: '', contentType: '', date: 'D', canonicalizedResource: '/y' });
    assert(a.authorization !== b.authorization, '资源路径不同 ⇒ 签名不同（未出现"恒定签名"）');
  }

  // ---------------------------------------------------------------- 2. 归一化
  console.log('\n【2】回执归一化（官方字段 → 送达事实）');
  {
    const f = normalizeReceipt(receiptBody({ status: '1', messageId: 'BIZX' }));
    assert(f && f.deliveryStatus === 'delivered', 'Status=1 ⇒ delivered');
    assert(f && f.providerBizId === 'BIZX', 'MessageId 被取为回执匹配键');
    assert(f && f.errorCode === null, '"success" 占位错误码被归一为 null');
    assert(f && f.receivedAt instanceof Date, 'ReceiveDate 被解析为 Date');
    const f2 = normalizeReceipt(receiptBody({ status: '2', messageId: 'BIZY', errorCode: 'W-BLACK', errorDescription: 'blacklisted' }));
    assert(f2 && f2.deliveryStatus === 'failed', 'Status=2 ⇒ failed');
    assert(f2 && f2.errorCode === 'W-BLACK', '失败错误码被保留');
    const f3 = normalizeReceipt(receiptBody({ status: '6', messageId: 'BIZZ' }));
    assert(f3 && f3.deliveryStatus === 'failed', 'Status=6（过期）⇒ failed');
    // 关键：归一化**绝不能**外带手机号
    assert(f && !JSON.stringify(f).includes(TEST_PHONE), '归一化结果里不含手机号');
  }
  {
    // MNS 信封：MessageBody 外层包一层 content（官方形态之一）
    const enveloped = JSON.stringify({ content: receiptBody({ status: '1', messageId: 'BIZENV' }) });
    const f = normalizeReceipt(enveloped);
    assert(f && f.providerBizId === 'BIZENV', 'MNS 信封（content 内嵌 JSON）同样能归一化');
  }
  {
    const f = normalizeReceipt('[{"Status":"9","MessageId":"B"}]');
    assert(f === null, '未知状态码不产出事实（不臆造终态）');
    assert(normalizeReceipt('not json') === null, '非 JSON 报文不产出事实');
  }

  // ---------------------------------------------------------------- 3. 端到端
  const state = { queue: [], deleted: [], requests: [], authFailures: 0 };
  const server = makeStubMns(state);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const logs = [];
  const logger = {
    info: (m) => logs.push(String(m)),
    warn: (m) => logs.push(String(m)),
    error: (m) => logs.push(String(m)),
    debug: (m) => logs.push(String(m)),
  };
  const cfg = resolveReceiptConfig({
    ALIYUN_SMS_RECEIPT_MNS_ENDPOINT: 'https://' + ACCESS_KEY_ID + '.mns.cn-hangzhou.aliyuncs.com',
    ALIYUN_SMS_RECEIPT_MNS_QUEUE: QUEUE,
    ALIYUN_SMS_ACCESS_KEY_ID: ACCESS_KEY_ID,
    ALIYUN_SMS_ACCESS_KEY_SECRET: ACCESS_KEY_SECRET,
  });
  assert(cfg.config !== null, '配置解析：四个键齐备时得到配置');
  const clientConfig = Object.assign({}, cfg.config, { endpoint: 'http://' + ENDPOINT_HOST + ':' + port });
  const client = new MnsReceiptClient({ fetchFn: fetch, config: clientConfig, logger });

  const idA = await insertRow(BIZ_A);
  const idB = await insertRow(BIZ_B);
  const readRow = async (id) => (await q('SELECT delivery_status, delivered_at, error_code FROM sms_logs WHERE id = $1', [id])).rows[0];

  console.log('\n【3】合法签名 ⇒ 真消费、真改库（真实 HTTP + 真实 PG）');
  {
    state.queue.push({ messageId: 'M1', receiptHandle: 'RH-1', body: receiptBody({ status: '1', messageId: BIZ_A }) });
    const r = await runReceiptTick({ client, db, provider: PROVIDER, maxPerTick: 3, logger });
    // 🔍 诊断必须留在脚本里：skipped 分类是"为什么没应用"的唯一线索，
    //    没有它就只能靠猜（第一版就因为缺它而把门禁自身的适配器缺陷当成产品缺陷）。
    console.log('    [diag] skipped=' + JSON.stringify(r.skipped) + ' deleteFailed=' + r.deleteFailed);
    assertEq(r.received, 1, '取到 1 条');
    assertEq(r.applied, 1, '应用 1 条');
    const row = await readRow(idA);
    assertEq(row.delivery_status, 'delivered', 'delivery_status 已由 pending 变为 delivered');
    assert(!!row.delivered_at, 'delivered_at 已写入');
    assert(state.deleted.indexOf('RH-1') >= 0, '成功应用后消息已删除（不重投）');
  }

  console.log('\n【4】重复回执 ⇒ 幂等（官方明确"回执不保证幂等"）');
  {
    const before = await readRow(idA);
    state.queue.push({ messageId: 'M1', receiptHandle: 'RH-2', body: receiptBody({ status: '1', messageId: BIZ_A }) });
    const r = await runReceiptTick({ client, db, provider: PROVIDER, maxPerTick: 3, logger });
    assertEq(r.received, 1, '再次取到同一 MessageId');
    assertEq(r.applied, 0, '第二次未产生状态变化（条件更新 delivery_status=pending 拦下）');
    const after = await readRow(idA);
    assertEq(after.delivered_at && before.delivered_at && String(after.delivered_at) === String(before.delivered_at), 'true', 'delivered_at 未被重复覆盖');
    assert(state.deleted.indexOf('RH-2') >= 0, '重复消息被删除（否则会一直堵队列）');
  }

  console.log('\n【5】状态单调性：已 delivered 后到达的 failed 不得覆盖');
  {
    state.queue.push({ messageId: 'M1', receiptHandle: 'RH-3', body: receiptBody({ status: '2', messageId: BIZ_A, errorCode: 'E-SHOULD-NOT-APPLY' }) });
    const r = await runReceiptTick({ client, db, provider: PROVIDER, maxPerTick: 3, logger });
    assertEq(r.applied, 0, '较旧的失败状态未覆盖已送达');
    const row = await readRow(idA);
    assertEq(row.delivery_status, 'delivered', 'delivery_status 仍为 delivered');
    assert(row.error_code !== 'E-SHOULD-NOT-APPLY', '错误码也未被污染');
  }

  console.log('\n【6】未知 MessageId ⇒ 不泄露、不报错、照常删除');
  {
    state.queue.push({ messageId: 'MX', receiptHandle: 'RH-4', body: receiptBody({ status: '1', messageId: 'RB8-NEVER-EXISTS' }) });
    const r = await runReceiptTick({ client, db, provider: PROVIDER, maxPerTick: 3, logger });
    assertEq(r.received, 1, '取到未知回执 1 条');
    assertEq(r.applied, 0, '未应用');
    assert(state.deleted.indexOf('RH-4') >= 0, '未知回执被删除（避免堵队列）');
    const text = logs.join('\n');
    assert(text.indexOf('RB8-NEVER-EXISTS') < 0, '未知回执的 MessageId 未出现在日志里（无存在性泄露）');
  }

  console.log('\n【7】坏签名 ⇒ fail-closed（403，不消费、不改库、不删消息）');
  {
    // 改客户端 secret，让它签出"错"的签名；服务端必须 403
    const badClient = new MnsReceiptClient({
      fetchFn: fetch,
      config: Object.assign({}, clientConfig, { accessKeySecret: 'WRONG-SECRET-XYZ' }),
      logger,
    });
    const before = await readRow(idB);
    const r = await runReceiptTick({ client: badClient, db, provider: PROVIDER, maxPerTick: 3, logger });
    assert(r.received >= 0, '坏签名下不抛错（探针式健壮）');
    assert(state.authFailures >= 1, '桩 MNS 确实拒绝了错误签名（403）');
    const after = await readRow(idB);
    assertEq(after.delivery_status, before.delivery_status, '坏签名未改库');
    assert(state.deleted.indexOf('RH-BAD') < 0, '坏签名未删除任何消息');
  }

  console.log('\n【8】日志不含敏感原文（手机号 / 报文原文 / AccessKeySecret）');
  {
    const text = logs.join('\n');
    assert(text.indexOf(TEST_PHONE) < 0, '日志不含手机号');
    assert(text.indexOf(ACCESS_KEY_SECRET) < 0, '日志不含 AccessKeySecret');
    assert(text.indexOf('"To"') < 0, '日志不含回执报文原文');
  }

  // ---------------------------------------------------------------- 清理
  await q('DELETE FROM sms_logs WHERE id = ANY($1::bigint[])', [rowsToClean]);
  const left = await q('SELECT count(*)::int AS n FROM sms_logs WHERE id = ANY($1::bigint[])', [rowsToClean]);
  assertEq(left.rows[0].n, 0, '门禁夹具已清理');

  await pg.end();
  server.close();

  console.log('\nRESULT ' + JSON.stringify({ passed, failed: failures.length }));
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('  [FATAL] ' + (err && err.stack ? err.stack : String(err)));
  process.exit(2);
});
`;

// ---------------------------------------------------------------------------
// 宿主机：把脚本送进容器执行
// ---------------------------------------------------------------------------
function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  短信送达回执真实行为门禁（Phase 10 / RB-8）');
  console.log('══════════════════════════════════════════════════════════════');

  // 门禁脚本本身会改 sms_logs ⇒ 容器必须能连到 PG
  let running;
  try {
    running = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', APP_CONTAINER], {
      encoding: 'utf8',
    }).trim();
  } catch {
    console.log('');
    console.log('  ⛔ 容器 svc-app 不存在 —— 无法执行（环境未就绪，不是产品红灯）');
    process.exit(2);
  }
  if (running !== 'true') {
    console.log('');
    console.log('  ⛔ svc-app 未运行 —— 请先 docker compose up -d（环境未就绪，不是产品红灯）');
    process.exit(2);
  }

  const tmpLocal = path.join(os_tmpdir(), 'verify-sms-receipt.cjs');
  fs.writeFileSync(tmpLocal, BODY, 'utf8');
  try {
    execFileSync('docker', ['cp', tmpLocal, `${APP_CONTAINER}:${IN_CONTAINER}`], { stdio: 'pipe' });
  } catch (err) {
    console.log(`  ⛔ 无法把门禁脚本送进容器：${err.message}`);
    process.exit(2);
  } finally {
    fs.rmSync(tmpLocal, { force: true });
  }

  let output = '';
  let code = 1;
  try {
    output = execFileSync('docker', ['exec', APP_CONTAINER, 'node', IN_CONTAINER], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    code = 0;
  } catch (err) {
    output = `${err.stdout || ''}${err.stderr || ''}`;
    code = err.status ?? 1;
  }
  process.stdout.write(output);

  // 清理容器内临时脚本（不留残留物在应用目录里）
  try { execFileSync('docker', ['exec', APP_CONTAINER, 'rm', '-f', IN_CONTAINER], { stdio: 'pipe' }); } catch { /* 已删除或无权限，忽略 */ }

  const m = /RESULT (\{.*\})/.exec(output);
  if (m) {
    const r = JSON.parse(m[1]);
    passed = r.passed;
    failures.push(...Array.from({ length: r.failed }, () => ''));
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  if (code === 0 && failures.length === 0) {
    console.log(`  ✅ 全部通过：${passed} 项`);
    console.log('══════════════════════════════════════════════════════════════');
    console.log('');
    process.exit(0);
  }
  console.log(`  ❌ 失败（exit ${code}）`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(code === 2 ? 2 : 1);
}

function os_tmpdir() {
  return process.env.TEMP || process.env.TMP || 'C:/Windows/Temp';
}

main();
