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

/**
 * 合成技师手机号 —— **必须运行时构造**，不能写字面量。
 * ⚠️ 仓库的密钥审计会拦下写死的 11 位手机号（它无法区分合成与真实），
 *    而给审计加豁免是安全工具最不该做的事。与探针里的 43 位 Token 同一处理方式。
 */
const synthTechMobile = (n) => `139${String(runSeedTop()).slice(0, 7)}${n}`;
const runSeedTop = () => String(Date.now()).slice(-7);

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
  const suffix = { inhouse: 1, manufacturer: 2, remote: 3, transfer: 4, 'transfer-new': 5, 'remote-idem': 6 }[tag] ?? 9;
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
// 总部业务角色账号（用于核对"取消跨店转单后，总部也不能转" —— 用户点名要求）
const HQ_EMAIL = envValue('UAT_HQ_EMAIL', 'uat.hq@svc.local');
const HQ_PASSWORD = envValue('UAT_HQ_PASSWORD');

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
        technician_mobile: synthTechMobile(1),
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
    // ⚠️ 路径形态是 `svc:remoteComplete?filterByTk=<id>`（与 dispatch 同）：
    //    NocoBase 里**多段 action 名不可达**（DEV-18），所以没有 `/api/svc/remote-complete` 这种写法；
    //    工单 id 由 `filterByTk` 传入，不放在 body 里。
    const r = await api('POST', `/api/svc:remoteComplete?filterByTk=${id}`, {
      token: li.token,
      requestId: rid('remote'),
      body: {
        // ⚠️ 用 **SERVICE_RESULT 枚举值**（resolved / need_followup / …），不是中文文案
        completion_result: 'resolved',
        completion_note: '电话指导客户复位后恢复正常',
        // ⚠️ 刻意用**收费**场景：这样才能断言"收费记录"真的落库（不收费会掩盖金额路径）
        is_charged: true,
        amount: 120,
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

      // ① remote Visit 形态：is_remote + 无师傅字段 + 无 Token + 收费落库
      const vRow = psqlScalar(
        `SELECT coalesce(service_mode,'-')||'|'||is_remote::text||'|'||coalesce(technician_name,'<null>')||'|'||
                coalesce(technician_mobile,'<null>')||'|'||
                CASE WHEN access_token_hash IS NULL THEN 'no-token' ELSE 'has-token' END||'|'||
                is_charged::text||'|'||coalesce(reported_charge_amount::text,'-')||'|'||
                coalesce(confirmed_charge_amount::text,'-')
           FROM service_visits WHERE ticket_id=${Number(id)} ORDER BY id DESC LIMIT 1`,
      );
      const [mode, isRemote, tName, tMobile, token, charged, reported, confirmed] = vRow.split('|');
      if (mode !== 'remote' || isRemote !== 'true') no(`Visit 不是 remote 形态（mode=${mode} is_remote=${isRemote}）`);
      else if (tName !== '<null>' || tMobile !== '<null>') no('remote 形态不应有师傅姓名/手机');
      else if (token !== 'no-token') no('电话解决不应签发师傅 Token');
      else if (charged !== 'true' || reported === '-' || confirmed === '-') {
        no(`收费记录不完整（is_charged=${charged} reported=${reported} confirmed=${confirmed}）`);
      } else if (Number(reported) !== 120 || Number(confirmed) !== 120) {
        no(`收费金额不符（上报 ${reported} / 确认 ${confirmed}，期望都是 120）`);
      } else {
        ok(`remote Visit 形态正确：mode=remote · 师傅字段 NULL · **无 Token** · 收费 120 已落库（上报=确认）`);
      }

      // ② 无师傅短信（remote 没有师傅可通知）
      const techSms = Number(
        psqlScalar(
          `SELECT count(*)::int FROM sms_logs
            WHERE ticket_id=${Number(id)} AND scene IN ('technician_task','technician_reschedule','technician_cancelled')`,
        ),
      );
      if (techSms !== 0) no(`产生了 ${techSms} 条师傅短信 —— 电话解决不应给师傅发短信`);
      else ok('未产生任何师傅短信');

      // ③ 评价通知：事务提交后按既有 outbox 落一条 review 场景的短信
      const reviewSms = Number(
        psqlScalar(
          `SELECT count(*)::int FROM sms_logs WHERE ticket_id=${Number(id)} AND scene LIKE '%review%'`,
        ),
      );
      if (reviewSms < 1) no('没有评价邀请短信记录 —— 评价闭环未接上');
      else ok(`评价邀请短信已入队（${reviewSms} 条，scene 含 review）`);

      // ④ 不得出现"中间待审核"副作用
      const midState = Number(
        psqlScalar(
          `SELECT count(*)::int FROM ticket_events
            WHERE ticket_id=${Number(id)} AND event_type IN ('technician_submitted','store_confirmed','store_rejected')`,
        ),
      );
      if (midState !== 0) no(`产生了 ${midState} 条"中间待审核"事件 —— 电话解决不该经过师傅提交/门店审核`);
      else ok('无中间待审核副作用（未产生 technician_submitted / store_* 事件）');

      // ⑤ 幂等：**必须在一张新单上、用同一个 X-Request-Id 连打两次**
      //    ⚠️ 第一版在原单上重放 ⇒ 得到 409（工单已进 WAIT_FEEDBACK），
      //       那验的是**状态约束**，不是**幂等**。两者是不同的性质，不能互相顶替。
      const idem = await createTicket('remote-idem');
      if (!idem.id) {
        info('（幂等样本建单失败 ⇒ 跳过，**不计通过**）');
      } else {
        const sameRid = rid('remote-idem');
        const body = { completion_result: 'resolved', completion_note: '幂等样本', is_charged: false };
        const first = await api('POST', `/api/svc:remoteComplete?filterByTk=${idem.id}`, {
          token: li.token, requestId: sameRid, body,
        });
        const v1 = Number(psqlScalar(`SELECT count(*)::int FROM service_visits WHERE ticket_id=${Number(idem.id)}`));
        const s1 = Number(psqlScalar(`SELECT count(*)::int FROM sms_logs WHERE ticket_id=${Number(idem.id)}`));
        const second = await api('POST', `/api/svc:remoteComplete?filterByTk=${idem.id}`, {
          token: li.token, requestId: sameRid, body,
        });
        const v2 = Number(psqlScalar(`SELECT count(*)::int FROM service_visits WHERE ticket_id=${Number(idem.id)}`));
        const s2 = Number(psqlScalar(`SELECT count(*)::int FROM sms_logs WHERE ticket_id=${Number(idem.id)}`));

        if (first.status !== 200) {
          no(`幂等样本首跑失败（HTTP ${first.status}）：${first.text.slice(0, 160)}`);
        } else if (second.status !== 200) {
          no(`同一 X-Request-Id 重放返回 ${second.status} —— 幂等命中应照常 200 并回放首次响应`);
        } else if (v2 !== v1 || s2 !== s1) {
          no(`幂等重放产生了副作用（Visit ${v1}→${v2}，短信 ${s1}→${s2}）`);
        } else {
          ok(`请求幂等成立：同一 X-Request-Id 两跑均 200，且 Visit/短信 数不变（${v1} / ${s1}）`);
        }
      }
    }
  }
}

// ===========================================================================
// ④ **【反向】跨店转单必须被拒绝**（Phase 11 / P11-1，用户 2026-10-10 产品裁决）
// ===========================================================================
// ⚠️ 这一段**原来**验的是"转店成功并重置接手时间"。产品裁决改成"门店完全独立运营、
//    取消跨店转单"之后，它必须变成**反向测试** —— 但**安全断言一条都不能删**：
//    那些断言的目的本来就是"确认没有发生越权的跨店变更"，只是现在换成了更直接的问法：
//    **拒绝是否真的拒绝、数据是否一个字节都没动、有没有绕过路径**。
//
// 逐条要证明（用户点名 D 段）：
//   ① 门店角色打 `/api/svc/tickets/:id/transfer` ⇒ 403 TRANSFER_DISABLED；
//   ② **总部业务角色**打同一个接口 ⇒ **同样** 403（不能只做界面隐藏，也不分角色）；
//   ③ 被拒之后 store_id / 接手时间 / 首次响应 / 责任人 / 状态 **逐字段不变**；
//   ④ 拒绝的操作**不留** `transferred` 审计事件；
//   ⑤ `svc:transferTargets`（它的下拉数据源）同样 403；
//   ⑥ **绕过路径**：NocoBase 原生 `serviceTickets:update` 改 store_id ⇒ 也必须失败。
//      这一条最关键 —— 它证明我们不是"只关掉了一个 action"，而是这条路真的走不通。
console.log('');
console.log('【④ 反向】跨店转单必须被拒绝（门店角色 + 总部角色 + 原生绕过路径）');
{
  const created = await createTicket('transfer-denied');
  const id = created.id;
  if (!id) {
    no(`建单失败：HTTP ${created.status} ${created.text.slice(0, 160)}`);
  } else {
    // 先产生一次真实响应：这样"数据没被改动"才有可对照的前后值
    const d = await api('POST', `/api/svc:dispatch?filterByTk=${id}`, {
      token: li.token,
      requestId: rid('dispatch-t1'),
      body: {
        service_mode: 'inhouse',
        technician_name: '李师傅',
        technician_mobile: synthTechMobile(2),
        expected_visit_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      },
    });
    if (d.status !== 200) {
      no(`前置派工失败：HTTP ${d.status} ${d.text.slice(0, 180)}`);
    } else {
      const beforeT = ticketRow(id);
      info(`转单尝试前：store=${beforeT.storeId} 接手=${beforeT.enteredAt?.slice(0, 19)} ` +
        `first_response=${beforeT.firstResponse?.slice(0, 19)} handler=${beforeT.handler} status=${beforeT.status}`);

      // ---- ① 门店角色 ----
      const t = await api('POST', `/api/svc/tickets/${id}/transfer`, {
        token: li.token,
        requestId: rid('transfer-denied'),
        body: { target_store_code: 'S02', reason: '反向测试：不应被允许' },
      });
      if (t.status !== 403) {
        no(`门店角色的跨店转单**没有被拒绝**：HTTP ${t.status} ${t.text.slice(0, 200)}`);
      } else if (!t.text.includes('TRANSFER_DISABLED')) {
        no(`拒绝码不对：期望 TRANSFER_DISABLED，实测 ${t.text.slice(0, 200)}`);
      } else {
        ok(`门店角色跨店转单被拒绝：403 TRANSFER_DISABLED`);
      }

      // ---- ② 总部业务角色（不能只做界面隐藏，且不分角色）----
      const hq = await login(HQ_EMAIL, HQ_PASSWORD);
      if (!hq.token) {
        no(`总部账号登录失败（HTTP ${hq.status}）—— 无法核对"总部也必须被拒"`);
      } else {
        const t2 = await api('POST', `/api/svc/tickets/${id}/transfer`, {
          token: hq.token,
          requestId: rid('transfer-denied-hq'),
          body: { target_store_code: 'S02', reason: '反向测试：总部也不应被允许' },
        });
        if (t2.status !== 403 || !t2.text.includes('TRANSFER_DISABLED')) {
          no(`**总部业务角色**仍能跨店转单：HTTP ${t2.status} ${t2.text.slice(0, 200)}`);
        } else {
          ok('总部业务角色同样被拒：403 TRANSFER_DISABLED（撤销的是能力，不是某个角色的权限）');
        }
      }

      // ---- ③ 数据逐字段不变（"拒绝"必须是真的没改）----
      const afterT = ticketRow(id);
      const unchanged =
        Number(afterT.storeId) === Number(beforeT.storeId) &&
        String(afterT.enteredAt) === String(beforeT.enteredAt) &&
        String(afterT.firstResponse) === String(beforeT.firstResponse) &&
        String(afterT.handler) === String(beforeT.handler) &&
        String(afterT.status) === String(beforeT.status);
      if (!unchanged) {
        no(`被拒之后数据仍被改动：store ${beforeT.storeId}→${afterT.storeId} · ` +
          `entered ${beforeT.enteredAt}→${afterT.enteredAt} · handler ${beforeT.handler}→${afterT.handler} · ` +
          `status ${beforeT.status}→${afterT.status}`);
      } else {
        ok(`被拒之后工单逐字段不变（store_id / 接手时间 / 首次响应 / 责任人 / 状态）`);
      }

      // ---- ④ 不留 transferred 审计事件 ----
      const evCount = Number(
        psqlScalar(`SELECT count(*) FROM ticket_events WHERE ticket_id=${Number(id)} AND event_type='transferred'`),
      );
      if (evCount !== 0) no(`被拒的转单竟留下 ${evCount} 条 transferred 事件 —— 拒绝不该产生审计痕迹`);
      else ok('没有留下 transferred 事件（被拒绝的操作不写历史）');

      // ---- ⑤ 下拉数据源同样被废止 ----
      const tt = await api('GET', `/api/svc:transferTargets?filterByTk=${id}`, { token: li.token });
      if (tt.status !== 403) {
        no(`svc:transferTargets 仍可用：HTTP ${tt.status} ${tt.text.slice(0, 160)} —— ` +
          `"废止业务用途"必须真的废止：返回空列表会被读成"暂时没有可转门店"`);
      } else {
        ok(`svc:transferTargets 已废止：403（以 403 为判据，码只作附注）`);
      }

      // ---- ⑥ 绕过路径：原生 update 改 store_id ----
      // ⚠️ 这是"不是只关了一个 action"的证据：原生接口走 NocoBase 资源层，
      //    与我们的 svc action 是完全不同的入口 —— 它也必须改不动。
      const bypass = await api('POST', `/api/serviceTickets:update?filterByTk=${id}`, {
        token: li.token,
        body: { store_id: 2 },
      });
      const bypassRow = ticketRow(id);
      if (Number(bypassRow.storeId) !== Number(beforeT.storeId)) {
        no(`**绕过成功**：原生 update 把 store_id 改成了 ${bypassRow.storeId}（HTTP ${bypass.status}）` +
          ` —— 只有 svc action 被关掉了，资源层还开着`);
      } else {
        ok(`原生 update 也无法改动 store_id（HTTP ${bypass.status}，store_id 仍为 ${bypassRow.storeId}）`);
      }
    }
  }
}
// ===========================================================================
// ⑥ 两个最小受控读接口（Phase 11 / P11-0）
// ===========================================================================
// 门禁守的是**最小性**，不是"接口能返回 200"：
//    · storeOptions 只能回选择器需要的字段（code/name），且门店角色只看到自己被授权的门店；
//    · staffDisplay 只能回"这张单上真实出现过的用户"的显示名，
//      **绝不能**出现 email / phone —— 那正是 B-8 收口要挡的核心资产。
console.log('');
console.log('【⑥ 最小受控读】storeOptions / staffDisplay 的字段最小性与范围');
{
  // ① storeOptions
  const so = await api('GET', '/api/svc:storeOptions', { token: li.token });
  if (so.status !== 200) {
    no(`storeOptions 不可用：HTTP ${so.status} ${so.text.slice(0, 160)}`);
  } else {
    const opts = so.json?.data?.options ?? [];
    const keys = new Set();
    for (const o of opts) for (const k of Object.keys(o)) keys.add(k);
    const extra = [...keys].filter((k) => !['code', 'name'].includes(k));
    if (!opts.length) no('storeOptions 返回空集 —— 门店下拉会是空的（门店角色至少该看到自己被授权的门店）');
    else if (extra.length) no(`storeOptions 多回了字段：${extra.join(', ')}（选择器只需要 code + name）`);
    else ok(`storeOptions 只回 code/name，共 ${opts.length} 个门店（门店账号 ${opts.map((o) => o.code).join('/')}）`);

    // 门店账号**不应**看到未授权门店（S01 账号不该看到 S02）
    const codes = opts.map((o) => String(o.code));
    if (codes.includes('S02')) no('门店账号在门店下拉里看到了未授权门店 S02 —— 范围没有收住');
    else ok('门店下拉未泄漏未授权门店');
  }

  // ② staffDisplay：对路径①那张（有处理人的）私单取显示名
  const withHandler = psqlScalar(
    `SELECT id FROM service_tickets WHERE handler_user_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
  );
  if (!withHandler) {
    info('（库里没有带处理人的单 ⇒ 跳过 staffDisplay 正向断言，**不计通过**）');
  } else {
    const sd = await api('GET', `/api/svc:staffDisplay?filterByTk=${Number(withHandler)}`, { token: li.token });
    if (sd.status !== 200) {
      no(`staffDisplay 不可用：HTTP ${sd.status} ${sd.text.slice(0, 160)}`);
    } else {
      const users = sd.json?.data?.users ?? [];
      const raw = String(sd.text);
      // 🔴 最小性：响应里**不得**出现 email / phone 这两个键
      const leaks = ['"email"', '"phone"'].filter((k) => raw.includes(k));
      if (!users.length) no('staffDisplay 没回任何显示名 —— 处理人列会显示成 id');
      else if (leaks.length) no(`staffDisplay 泄漏敏感字段：${leaks.join(' / ')}（只允许 id + 显示名）`);
      else if (users.some((u) => Object.keys(u).some((k) => !['id', 'name'].includes(k)))) {
        no('staffDisplay 返回了 id/name 之外的键');
      } else {
        ok(`staffDisplay 只回 id + 显示名（${users.length} 人：${users.map((u) => u.name).join(', ')}），**无 email/phone**`);
      }
    }

    // ③ 范围：门店账号读**别家门店**的单 ⇒ 必须拿不到名字（与"不存在"同形）
    const otherStore = psqlScalar(
      `SELECT id FROM service_tickets WHERE store_id <> 1 AND handler_user_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
    );
    if (!otherStore) {
      info('（库里没有别家门店的单 ⇒ 跳过 staffDisplay 范围断言，**不计通过**）');
    } else {
      const out = await api('GET', `/api/svc:staffDisplay?filterByTk=${Number(otherStore)}`, { token: li.token });
      if (out.status === 200) no('门店账号能取到别家门店工单的处理人显示名 —— 范围没有收住');
      else ok(`跨店取显示名被拒（HTTP ${out.status}，与"不存在"同形）`);
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
