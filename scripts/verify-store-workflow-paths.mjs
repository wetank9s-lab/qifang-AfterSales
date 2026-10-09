/**
 * verify-store-workflow-paths.mjs —— 门店四条核心路径的**真机运行证据**（Phase 11 / P11-0）
 *
 * 用户要求：验收重点是「**真实门店售后账号、真实浏览器、真实业务操作**」，
 * 并优先给出「自有上门、厂家代处理、电话解决、转店」四条路径的实际运行证据。
 *
 * ===========================================================================
 * 口径
 * ===========================================================================
 * · 用**真实门店账号**（`uat.store.a@svc.local`，仅授权 S01）登录 —— 不构造特权旁路；
 * · 服务单用**客户匿名入口**真实创建（`POST /api/public/tickets`），与真实业务同一条路；
 * · 每一步都断言**数据库事实**（不是只看 HTTP 200）：
 *     状态、first_response_at、handler_user_id、current_store_entered_at、
 *     Visit 的 service_mode / technician_* / provider_name、Token 的有无。
 * · 每个写操作带 `X-Request-Id`（幂等契约）。
 *
 * ===========================================================================
 * 四条路径各自要证明什么（对应契约 §5.3 / §5.4 / §7）
 * ===========================================================================
 * ① 自有上门：NEW **不经受理**直接派工 → PROCESSING
 *              + first_response_at 非空（首次真实响应）+ handler_user_id = 操作者
 *              + Visit(service_mode=inhouse) 有师傅姓名/手机 + **有** Token
 * ② 厂家代处理：只给 provider_name（**不填师傅姓名/手机**）也能开始处理
 *              + first_response_at 非空 + Visit(manufacturer) 师傅字段为 NULL + **无** Token
 * ③ 电话解决：remoteComplete → WAIT_FEEDBACK + first_response_at 非空 + **无** Token
 * ④ 转店：转到 S02 后
 *              + store_id 变为目标门店
 *              + current_store_entered_at **被重置**（≥ 转店时刻）
 *              + first_response_at **不被重置**（保持原值 —— 它是全生命周期事实）
 *              + handler_user_id **被清空**（原门店处理人不能继续冒充新门店责任人）
 *
 * 用法：node scripts/verify-store-workflow-paths.mjs
 * 退出码：0 四条路径全部通过 / 1 有失败 / 2 环境未就绪
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SVC_BASE_URL } from './lib/base-url.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function envValue(key, fallback = '') {
  const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
  return m ? m[1].trim() : (process.env[key] ?? fallback);
}

/** 走真实 SQL 读库 —— 断言"库里的样子"，而不是只信接口回包 */
import { execFileSync } from 'node:child_process';
function psqlScalar(sql) {
  return execFileSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-F', '|', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

let failed = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const no = (m) => { failed += 1; console.log(`  ❌ ${m}`); };
const info = (m) => console.log(`  ·  ${m}`);

const ORIGIN = new URL(SVC_BASE_URL).origin;
const seq = 0;
void seq;
/**
 * `X-Request-Id` **必须是合法 UUID v4**（契约 §32 的幂等头约定，服务端会校验并 422）。
 * ⚠️ 第一版用 `p11-<tag>-<ts>-<n>` 这种"看起来像请求号"的字符串 ⇒ 建单直接 422
 *    `X-Request-Id 不是合法的 UUID v4`，四条路径全在第一步就挂了。
 *    这类错误的教训：**契约要求 UUID 就得产生真 UUID**，不要自造格式。
 */
const rid = (_tag) => crypto.randomUUID();

async function login(email, password) {
  const r = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, token: j?.data?.token ?? null };
}

async function api(method, url, { token, body, requestId } = {}) {
  const headers = { Origin: ORIGIN };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  if (requestId) headers['X-Request-Id'] = requestId;
  const r = await fetch(`${SVC_BASE_URL}${url}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}

/**
 * 客户匿名建单（与真实业务同一条入口）。
 *
 * ⚠️ 响应**故意只回三个字段**（`ticket_no` / `store_name` / `created_at`）——
 *    这是 Phase 3 冻结的"最小披露"契约，**不含内部 id**。
 *    第一版按 `data.id` 取 ⇒ 明明 201 成功却被脚本判成"建单失败"（4 条全红）。
 *    ⇒ 内部 id 必须用 `ticket_no` 从库里反查，这也与门店"在列表里看到那张单"一致。
 */
async function createTicket(tag) {
  // ⚠️ 每条路径用**不同客户手机号 + 不同内容**：
  //    实测踩到两道防滥用闸门（它们是**正确工作**，不是缺陷）：
  //      · 409 DUPLICATE_TICKET —— 同一手机号 10 分钟内提交相同内容
  //      · 429 RATE_LIMITED      —— 同一手机号**当日**提交次数上限
  //    ⇒ 号码必须**每次运行都不同**：固定四个号跑第二遍就会撞当日的上限，
  //      于是门禁变成"一天只能绿一次"—— 那种门禁没人会跑，也就等于没有。
  //      真实业务里每条工单本来就是不同客户，用时间戳派生号码与真实形态一致。
  const runSeed = String(Date.now()).slice(-8); // 8 位
  const suffix = { inhouse: 1, manufacturer: 2, remote: 3, transfer: 4 }[tag] ?? 9;
  const mobile = `13${runSeed}${suffix}`; // 2 + 8 + 1 = 11 位
  const contentSeed = `${tag}-${Date.now()}`;
  const r = await api('POST', '/api/public/tickets', {
    body: {
      store_code: 'S01',
      ticket_type: 'repair',
      content: `P11-0 四路径验收样本 ${contentSeed} —— 门店直接处理，不经受理`,
      customer_name: '验收样本',
      customer_mobile: mobile,
      // ⚠️ 隐私同意是**契约要求的证据**（拒绝时服务端回 `PRIVACY_NOT_AGREED` 并附带
      //    当前生效的 notice_version）—— 样本必须按真实客户端那样带上它，
      //    而不是把校验绕过去（绕过去就等于没在验真实链路）。
      privacy_agreed: true,
      privacy_notice_version: '2026-09-20',
    },
    requestId: rid(`create-${tag}`),
  });
  const ticketNo = r.json?.data?.ticket_no ?? null;
  const id = ticketNo
    ? Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no='${String(ticketNo).replace(/'/g, "''")}'`))
    : null;
  return { ...r, ticketNo, id: Number.isFinite(id) && id > 0 ? id : null };
}

function ticketRow(id) {
  const raw = psqlScalar(
    `SELECT status||'|'||coalesce(first_response_at::text,'-')||'|'||coalesce(handler_user_id::text,'-')||'|'||
            coalesce(current_store_entered_at::text,'-')||'|'||store_id::text
       FROM service_tickets WHERE id=${Number(id)}`,
  );
  const [status, firstResponse, handler, enteredAt, storeId] = raw.split('|');
  return { status, firstResponse, handler, enteredAt, storeId };
}

function visitRow(ticketId) {
  const raw = psqlScalar(
    `SELECT visit_no||'|'||service_mode||'|'||coalesce(technician_name,'<null>')||'|'||
            coalesce(technician_mobile,'<null>')||'|'||coalesce(provider_name,'<null>')||'|'||
            coalesce(expected_visit_at::text,'<null>')||'|'||
            CASE WHEN access_token_hash IS NULL THEN 'no-token' ELSE 'has-token' END
       FROM service_visits WHERE ticket_id=${Number(ticketId)} ORDER BY visit_no DESC LIMIT 1`,
  );
  const [visitNo, serviceMode, techName, techMobile, provider, expectedAt, token] = raw.split('|');
  return { visitNo, serviceMode, techName, techMobile, provider, expectedAt, token };
}

const PWD = envValue('UAT_STORE_A_PASSWORD');
const STORE = envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local');

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  门店四条核心路径 · 真机运行证据（真实门店账号）');
console.log('══════════════════════════════════════════════════════════════');
if (!PWD) {
  console.log('  ⛔ .env 缺 UAT_STORE_A_PASSWORD —— 环境未就绪');
  process.exit(2);
}
const li = await login(STORE, PWD);
if (!li.token) {
  console.log(`  ⛔ 门店账号登录失败（HTTP ${li.status}）—— 环境未就绪`);
  process.exit(2);
}
console.log(`  · 门店账号：${STORE}（仅授权 S01）`);

// ===========================================================================
// ① 自有上门：NEW → 直接派工（**不需要先 accept**）
// ===========================================================================
console.log('');
console.log('【① 自有上门】NEW →（不经受理）→ 派工 → PROCESSING，且首次响应与处理人原子落库');
{
  const created = await createTicket('inhouse');
  const id = created.id; // ⚠️ 响应刻意不含内部 id，由 ticket_no 反查（见 createTicket）
  if (!id) {
    no(`建单失败：HTTP ${created.status} ${created.text.slice(0, 160)}`);
  } else {
    const before = ticketRow(id);
    info(`建单后：status=${before.status} first_response=${before.firstResponse} handler=${before.handler}`);
    if (before.status !== 'NEW') no(`新建应为 NEW，实际 ${before.status}`);
    else ok('新单状态 = NEW（未经受理）');

    const d = await api('POST', `/api/svc:dispatch?filterByTk=${id}`, {
      token: li.token,
      requestId: rid('dispatch'),
      body: {
        service_mode: 'inhouse',
        technician_name: '张师傅',
        technician_mobile: '13900000001',
        expected_visit_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      },
    });
    if (d.status !== 200) {
      no(`NEW 直接派工被拒：HTTP ${d.status} ${d.text.slice(0, 200)} —— 「不需要先 accept」未成立`);
    } else {
      ok('NEW 直接派工成功（**未调用 accept**）');
      const after = ticketRow(id);
      info(`派工后：status=${after.status} first_response=${after.firstResponse} handler=${after.handler}`);
      if (after.status !== 'PROCESSING') no(`状态应为 PROCESSING，实际 ${after.status}`);
      else ok('状态 → PROCESSING');
      if (!after.firstResponse || after.firstResponse === '-') no('first_response_at 仍为空 —— 首次真实响应未落库');
      else ok(`first_response_at 已原子写入（${after.firstResponse.slice(0, 19)}）`);
      if (!after.handler || after.handler === '-') no('handler_user_id 仍为空 —— 处理人未落库');
      else ok(`handler_user_id 已写入（${after.handler}）`);

      const v = visitRow(id);
      info(`Visit#${v.visitNo}: mode=${v.serviceMode} 师傅=${v.techName} 手机=${v.techMobile} Token=${v.token}`);
      if (v.serviceMode !== 'inhouse') no(`Visit.service_mode 应为 inhouse，实际 ${v.serviceMode}`);
      else if (v.techName === '<null>' || v.techMobile === '<null>') no('自有师傅的姓名/手机不应为空');
      else if (v.token !== 'has-token') no('自有师傅上门**必须**签发 Token（师傅要用它上传回执）');
      else ok('Visit 形态正确：inhouse + 师傅姓名/手机齐全 + **有 Token**');
    }
  }
}

// ===========================================================================
// ② 厂家代处理：只填 provider_name（不伪造师傅姓名/手机）
// ===========================================================================
console.log('');
console.log('【② 厂家代处理】只给服务商名称 → 也能开始处理；师傅字段落 NULL，且**不签发 Token**');
{
  const created = await createTicket('manufacturer');
  const id = created.id; // ⚠️ 响应刻意不含内部 id，由 ticket_no 反查（见 createTicket）
  if (!id) {
    no(`建单失败：HTTP ${created.status} ${created.text.slice(0, 160)}`);
  } else {
    const d = await api('POST', `/api/svc:dispatch?filterByTk=${id}`, {
      token: li.token,
      requestId: rid('dispatch-ext'),
      body: {
        service_mode: 'manufacturer',
        provider_name: '海尔售后',
        // 🔴 刻意**不填** technician_name / technician_mobile / expected_visit_at
      },
    });
    if (d.status !== 200) {
      no(
        `只填服务商名称被拒：HTTP ${d.status} ${d.text.slice(0, 220)}` +
          ' —— 「不得为过校验逼员工填假姓名/假手机号」未成立',
      );
    } else {
      ok('只填「海尔售后」即可开始处理（未伪造师傅姓名/手机号）');
      const after = ticketRow(id);
      if (after.status !== 'PROCESSING') no(`状态应为 PROCESSING，实际 ${after.status}`);
      else ok('状态 → PROCESSING');
      if (!after.firstResponse || after.firstResponse === '-') no('first_response_at 未落库');
      else ok('first_response_at 已落库');

      const v = visitRow(id);
      info(`Visit#${v.visitNo}: mode=${v.serviceMode} provider=${v.provider} 师傅=${v.techName} Token=${v.token}`);
      if (v.serviceMode !== 'manufacturer') no(`Visit.service_mode 应为 manufacturer，实际 ${v.serviceMode}`);
      else if (v.provider !== '海尔售后') no(`provider_name 应为「海尔售后」，实际 ${v.provider}`);
      else if (v.techName !== '<null>' || v.techMobile !== '<null>') {
        no('未填师傅时不应凭空生成师傅姓名/手机（不得伪造）');
      } else if (v.token !== 'no-token') no('provider-only 不应签发师傅 Token（会成孤儿凭据）');
      else ok('Visit 形态正确：manufacturer + 师傅字段 NULL + **无 Token**');
    }
  }
}

// ===========================================================================
// ③ 电话解决：remoteComplete
// ===========================================================================
console.log('');
console.log('【③ 电话解决】remoteComplete → WAIT_FEEDBACK，保留可审计记录且不签发 Token');
{
  const created = await createTicket('remote');
  const id = created.id; // ⚠️ 响应刻意不含内部 id，由 ticket_no 反查（见 createTicket）
  if (!id) {
    no(`建单失败：HTTP ${created.status} ${created.text.slice(0, 160)}`);
  } else {
    const r = await api('POST', '/api/svc/remote-complete', {
      token: li.token,
      requestId: rid('remote'),
      body: {
        ticket_id: Number(id),
        completion_result: '已解决',
        completion_note: '电话指导客户复位后恢复正常',
        is_charged: false,
      },
    });
    if (r.status !== 200) {
      no(`remoteComplete 不可用：HTTP ${r.status} ${r.text.slice(0, 220)}`);
    } else {
      ok('remoteComplete 成功');
      const after = ticketRow(id);
      if (after.status !== 'WAIT_FEEDBACK') no(`状态应为 WAIT_FEEDBACK，实际 ${after.status}`);
      else ok('状态 → WAIT_FEEDBACK（直接进入评价流程，不要求伪造师傅）');
      if (!after.firstResponse || after.firstResponse === '-') no('first_response_at 未落库');
      else ok('first_response_at 已落库');
      const tokenRow = psqlScalar(
        `SELECT count(*)::int FROM service_visits WHERE ticket_id=${Number(id)} AND access_token_hash IS NOT NULL`,
      );
      if (Number(tokenRow) !== 0) no('电话解决不应产生带 Token 的 Visit');
      else ok('未签发任何师傅 Token');
    }
  }
}

// ===========================================================================
// ④ 转店：current_store_entered_at 重置、first_response_at 不重置、责任人清空
// ===========================================================================
console.log('');
console.log('【④ 转店】接手时间重置 + 首次响应保持 + 原门店责任人清空（待处理计时重新开始）');
{
  const created = await createTicket('transfer');
  const id = created.id; // ⚠️ 响应刻意不含内部 id，由 ticket_no 反查（见 createTicket）
  if (!id) {
    no(`建单失败：HTTP ${created.status} ${created.text.slice(0, 160)}`);
  } else {
    // 先让 S01 产生一次真实响应，再转店 —— 这样"不重置 first_response"才有对照
    const d = await api('POST', `/api/svc:dispatch?filterByTk=${id}`, {
      token: li.token,
      requestId: rid('dispatch-t1'),
      body: {
        service_mode: 'inhouse',
        technician_name: '李师傅',
        technician_mobile: '13900000002',
        expected_visit_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      },
    });
    if (d.status !== 200) {
      no(`前置派工失败：HTTP ${d.status} ${d.text.slice(0, 180)}`);
    } else {
      const beforeT = ticketRow(id);
      info(`转店前：store=${beforeT.storeId} 接手时间=${beforeT.enteredAt?.slice(0, 19)} first_response=${beforeT.firstResponse?.slice(0, 19)} handler=${beforeT.handler}`);
      await new Promise((r) => setTimeout(r, 1200)); // 让时间戳可区分
      const t = await api('POST', `/api/svc/tickets/${id}/transfer`, {
        token: li.token,
        requestId: rid('transfer'),
        // ⚠️ 入参名是 target_store_code（不是 id）—— 接口按**门店编码**转店
        body: { target_store_code: 'S02', reason: '客户地址属 S02 辖区' },
      });
      if (t.status !== 200) {
        no(`转店失败：HTTP ${t.status} ${t.text.slice(0, 200)}`);
      } else {
        ok('转店成功');
        const afterT = ticketRow(id);
        info(`转店后：store=${afterT.storeId} 接手时间=${afterT.enteredAt?.slice(0, 19)} first_response=${afterT.firstResponse?.slice(0, 19)} handler=${afterT.handler}`);
        if (Number(afterT.storeId) === Number(beforeT.storeId)) no('store_id 未变化');
        else ok(`门店已变更：${beforeT.storeId} → ${afterT.storeId}`);
        if (!afterT.enteredAt || afterT.enteredAt === '-') no('current_store_entered_at 为空');
        else if (afterT.enteredAt.slice(0, 19) <= String(beforeT.enteredAt).slice(0, 19)) {
          no('current_store_entered_at **未重置** —— 新门店的待处理计时不会重新开始');
        } else ok(`current_store_entered_at 已重置为转店时间（${afterT.enteredAt.slice(0, 19)}）`);
        if (afterT.firstResponse?.slice(0, 19) !== beforeT.firstResponse?.slice(0, 19)) {
          no('first_response_at 被重置了 —— 它是**全生命周期**事实，转店不应改变（契约 §5.4）');
        } else ok('first_response_at 保持不变（符合 §5.4）');
        if (afterT.handler && afterT.handler !== '-') {
          no(`handler_user_id 未清空（=${afterT.handler}）—— 原门店处理人会冒充新门店责任人`);
        } else ok('handler_user_id 已清空（新门店看到的是"待处理"而不是"已有人处理"）');
      }
    }
  }
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
if (failed === 0) {
  console.log('  ✅ 四条核心路径全部通过（真实门店账号 + 真实业务接口 + 库内事实核对）');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(0);
}
console.log(`  ❌ 失败 ${failed} 项`);
console.log('══════════════════════════════════════════════════════════════');
console.log('');
process.exit(1);
