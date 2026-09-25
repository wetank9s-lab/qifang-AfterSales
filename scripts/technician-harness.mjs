#!/usr/bin/env node
/**
 * technician-harness.mjs —— P5-1 三支验收脚本的**共享夹具**
 * =============================================================================
 *
 * 为什么要有这个文件（而不是三支脚本各写一份工具函数）：
 *
 *   三支脚本（token 矩阵 / 上传安全 / 提交与事务边界）都要做同样四件事：
 *   登录门店账号 → 建一张一次性工单 → 受理并派工 → 从 mock 短信发件箱取出
 *   **师傅链接里的明文 Token**，最后把自己造的工单精确删掉。
 *
 *   这套流程里每一段都踩过坑（见下），复制三份的后果不是"多点代码"，而是
 *   **同一个坑长出三条腿**：修好了一支脚本的取 Token 方式，另外两支还在用旧的，
 *   而它们各自都是绿的 —— 这正是本项目已经吃过一次亏的形状
 *   （`smoke-test` 与 `verify-plugin-load` 各有一份相同的 settings 解析器，
 *    一起变瞎，见 `PROJECT-RULES.md` §5 铁律 5）。
 *   所以：**只此一份**。脚本要改夹具，改这里。
 *
 * -----------------------------------------------------------------------------
 * 几个不显眼但必须这么写的地方
 * -----------------------------------------------------------------------------
 * ① **一次性工单必须自建自删，且按 id 精确删**
 *    走查基线里只有 4 张工单（35 / 886 / 1039 / 1040），它们是真人走查的证据，
 *    不能被脚本顺手删掉。因此这里只删"自己刚建的那张"，
 *    绝不使用 `WHERE ticket_no LIKE 'FW%'` 这类范围条件。
 *
 * ② **匿名建单接口不回 id**（刻意的，最小披露）→ 只能用 `ticket_no` 反查。
 *    为了测试方便去让接口回 id，等于把"内部主键不出站"这条口径拆掉。
 *
 * ③ **明文 Token 只能从 mock 短信发件箱取**
 *    Token 入库只存 sha256（明文只在短信里出现过一次），所以库里**取不出来**。
 *    可取回点是 `/api/svc:smsOutbox`（仅 `sms.provider=mock` 时存在，是自毁闸）。
 *    取的时候有两个陷阱，都在 `tokenFromOutbox()` 的注释里写清了：
 *    发件箱**跨轮次不清空**（"取最新一条"会拿到上一张工单的 Token），
 *    且链接要从 `params.link` 取而不是从会被截断的 `preview` 里正则捞。
 *    ⚠️ 本模块与 `smoke-test.mjs` 的 `phase4OutboxFor()` 读同一个接口、同一组字段
 *      （各自有独立的 http/断言工具，故未强行合并）。**两处读同一个形状** ——
 *      接口一变两边同时红，不会出现"一边静默取到空"。
 *
 * ④ **清理必须覆盖照片与私有文件**
 *    `service_visit_photos` 的行 + `uploads-private` 下的文件 + `attachments` 行。
 *    只删工单会留下孤儿照片：库里查不到（外键行没了），磁盘上却在涨。
 *    而"张数上限"是按行算的，孤儿文件不会触发任何告警。
 *
 * ⑤ **退出码约定**（项目铁律 4）：0 全绿 / 1 真红灯 / 2 环境未就绪。
 *    环境未就绪**不能**用 `process.exit(2)` 直接退出 —— 那会跳过 `finally`，
 *    把刚建的工单留在库里。统一用 `EnvNotReady` 异常在 finally 之后退出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

export const ROOT = path.resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------
export function envValue(key, fallback = '') {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return fallback;
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(fs.readFileSync(p, 'utf8'));
  return m ? m[1].trim() : fallback;
}

export const PORT = envValue('NGINX_HTTP_PORT', '8080');
export const BASE_URL = `http://localhost:${PORT}`;
export const PUBLIC_BASE_URL = envValue('PUBLIC_BASE_URL', BASE_URL);
/** 与 uat-preflight.mjs / uat-accounts.mjs 同一约定：邮箱固定，口令在 .env */
export const STORE_EMAIL = 'uat.store.a@svc.local';
/**
 * 总部账号。**只有它（或管理员）能读 mock 短信发件箱** ——
 * `svc:smsOutbox` 的 handler 明确要求总部角色（实测：门店账号得到
 * `403 短信发件箱仅总部角色可用`）。这不是可以放宽的限制：
 * 发件箱里有全部客户的脱敏手机号与短信正文，门店账号看到别的门店的短信
 * 就是越权。因此取 Token 这件事必须**换一个身份**去读，
 * 与本地的门店业务流程（建单/受理/派工）分成两个会话。
 */
export const HQ_EMAIL = 'uat.hq@svc.local';
export const STORE_CODE = 'S01';

/** 私有上传目录（容器内绝对路径）—— 断言"文件到底落在哪"时用它 */
export const PRIVATE_DIR = envValue('UPLOAD_PRIVATE_DIR', '/app/nocobase/storage/uploads-private');
/** 公共上传目录 —— 任何师傅照片出现在这里都是缺陷 */
export const PUBLIC_UPLOAD_DIR = '/app/nocobase/storage/uploads';

export class EnvNotReady extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnvNotReady';
  }
}

// ---------------------------------------------------------------------------
// 断言框架（各脚本共用一套计数与输出格式）
// ---------------------------------------------------------------------------
export function makeChecker({ heading } = {}) {
  const state = { passed: 0, failures: [] };

  const check = (name, fn) => {
    try {
      const detail = fn();
      state.passed += 1;
      console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (error) {
      state.failures.push({ name, message: error.message });
      console.log(`  ❌ ${name} — ${error.message}`);
    }
  };

  const checkAsync = async (name, fn) => {
    try {
      const detail = await fn();
      state.passed += 1;
      console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (error) {
      state.failures.push({ name, message: error.message });
      console.log(`  ❌ ${name} — ${error.message}`);
    }
  };

  const summary = () => {
    const total = state.passed + state.failures.length;
    console.log(
      `\n${heading ? `${heading}：` : ''}${
        state.failures.length ? `❌ ${state.failures.length}/${total} 项失败` : `✅ 全部通过：${total} 项`
      }\n`,
    );
    if (state.failures.length) {
      for (const f of state.failures) console.log(`   · ${f.name}\n     ${f.message}`);
      console.log('');
    }
  };

  return { check, checkAsync, summary, state };
}

export function assert(cond, message) {
  if (!cond) throw new Error(message);
}

export function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${what}：实际 ${a}，期望 ${e}`);
}

// ---------------------------------------------------------------------------
// 数据库
// ---------------------------------------------------------------------------
export function psqlScalar(sql) {
  return execFileSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

export function psqlRows(sql) {
  const out = execFileSync(
    'docker',
    [
      'exec',
      'svc-postgres',
      'psql',
      '-U',
      'svc_app',
      '-d',
      'service_ticket',
      '-t',
      '-A',
      '-F',
      '\u0001',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  ).trim();
  if (!out) return [];
  return out.split('\n').map((line) => line.split('\u0001'));
}

export function psqlExec(sql) {
  const r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      'svc-postgres',
      'psql',
      '-U',
      'svc_app',
      '-d',
      'service_ticket',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  );
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

/** 容器内执行（查/删私有文件用）。**只传固定命令**，不拼用户输入 */
export function inApp(cmd) {
  const r = spawnSync('docker', ['exec', 'svc-app', 'sh', '-lc', cmd], { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
export async function http(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（照片二进制流等）交给调用方断言 */
  }
  return {
    status: res.status,
    json,
    body: text,
    headers: res.headers,
    bytes: res.headers.get('content-type')?.startsWith('image/') ? Buffer.from(text, 'binary') : null,
  };
}

export const errorCodeOf = (r) => r?.json?.errors?.[0]?.code;
export const errorMessageOf = (r) =>
  r?.json?.errors?.[0]?.message ?? String(r?.body ?? '').slice(0, 160);

export async function signIn(email, password) {
  const r = await http(`${BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (r.status !== 200) return null;
  return r.json?.data?.token ?? null;
}

/**
 * 建两个会话：门店（做业务）+ 总部（读发件箱取 Token）。
 *
 * 为什么一定要两个而不是"用总部账号把业务也做了"：
 *   本脚本要验的正是**门店视角**的派工/改派（责任主体判据、门店隔离都在那条路径上）。
 *   换身份去跑业务，验的就不是线上真实路径了。
 * 为什么不能只用一个门店会话：发件箱对门店账号 403（见 `HQ_EMAIL` 注释）。
 */
export async function twoSessions() {
  const storePassword = envValue('UAT_STORE_A_PASSWORD');
  const hqPassword = envValue('UAT_HQ_PASSWORD');
  if (!storePassword) {
    throw new EnvNotReady(
      '.env 缺 UAT_STORE_A_PASSWORD —— 先跑 node scripts/uat-accounts.mjs --create',
    );
  }
  if (!hqPassword) {
    throw new EnvNotReady('.env 缺 UAT_HQ_PASSWORD —— 取师傅 Token 需要总部账号读 mock 发件箱');
  }
  const store = await signIn(STORE_EMAIL, storePassword);
  if (!store) throw new EnvNotReady(`门店账号 ${STORE_EMAIL} 登录失败（口令可能已轮换）`);
  const hq = await signIn(HQ_EMAIL, hqPassword);
  if (!hq) throw new EnvNotReady(`总部账号 ${HQ_EMAIL} 登录失败（口令可能已轮换）`);
  return { store, hq };
}

export async function svcPost(action, ticketId, token, body, requestId) {
  return http(`${BASE_URL}/api/svc:${action}?filterByTk=${ticketId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
}

export async function svcGet(action, ticketId, token) {
  return http(`${BASE_URL}/api/svc:${action}?filterByTk=${ticketId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** `YYYY-MM-DD`（本地时区），派工/改约的日期入参 */
export function localDateOnly(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// 建单 / 派工 / 取 Token
// ---------------------------------------------------------------------------

/**
 * 建一张**一次性**工单（走匿名真实入口）。
 *
 * @returns `{ ticketId, ticketNo, mobile }`
 */
export async function createScratchTicket({ tag, content }) {
  const mobile = `137${String(Date.now()).slice(-8)}`;
  const created = await http(`${BASE_URL}/api/public/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
    body: JSON.stringify({
      store_code: STORE_CODE,
      ticket_type: 'repair',
      content: `[${tag}] ${content}（脚本自建，跑完自删）`,
      customer_name: `${tag}验收`,
      customer_mobile: mobile,
      privacy_agreed: true,
    }),
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new EnvNotReady(
      `匿名建单失败 HTTP ${created.status} ${String(created.body).slice(0, 200)}`,
    );
  }
  const ticketNo = String(created.json?.data?.ticket_no ?? '');
  if (!ticketNo) {
    throw new EnvNotReady(`匿名建单未返回 ticket_no（${String(created.body).slice(0, 200)}）`);
  }
  const ticketId = Number(
    psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no = '${ticketNo}'`),
  );
  if (!ticketId) throw new EnvNotReady(`按 ticket_no=${ticketNo} 反查不到工单 id`);
  return { ticketId, ticketNo, mobile };
}

/** 受理 + 首次派工（走 `svc:accept` / `svc:dispatch`，与 UI 同一条服务端路径） */
export async function acceptAndDispatch(ticketId, sessionToken, overrides = {}) {
  const acceptRes = await svcPost('accept', ticketId, sessionToken, {}, crypto.randomUUID());
  assert(
    acceptRes.status === 200,
    `受理失败 HTTP ${acceptRes.status} ${errorMessageOf(acceptRes)}`,
  );

  const dispatchRes = await svcPost(
    'dispatch',
    ticketId,
    sessionToken,
    {
      technician_name: '王师傅',
      technician_mobile: '13900010001',
      expected_visit_at: localDateOnly(1),
      service_mode: 'manufacturer',
      provider_name: 'P5-1验收厂家',
      ...overrides,
    },
    crypto.randomUUID(),
  );
  assert(
    dispatchRes.status === 200,
    `首次派工失败 HTTP ${dispatchRes.status} ${errorMessageOf(dispatchRes)}`,
  );
  return dispatchRes;
}

/**
 * 从 mock 短信发件箱里取出**指定工单**的师傅作业 Token。
 *
 * ⚠️ 响应形状是 `data.items[]`（**不是** `entries`），每项形如
 *    `{ seq, scene, params: { ticket_no, link, ... }, preview, ... }`。
 *    这不是猜的 —— 与 `smoke-test.mjs` 的 `phase4OutboxFor()` 读的是同一个
 *    接口与同一组字段名。两处读同一个响应，**形状一变两边同时红**
 *    （不会出现"一边静默取到空"）。
 *
 * ⚠️ 必须**按 `params.ticket_no` + `scene` 过滤**，不能用"取最新一条"：
 *    发件箱是**进程内**内存队列，跨轮次、跨工单都不清空。历史上探针按
 *    `items.pop()` 取最新，结果拿到了**上一张工单**的 Token ——
 *    "改派后旧 Token 失效"那条断言于是看着通过、实际证的是别的工单
 *    （`smoke-test.mjs` 里留了这条复盘）。
 *
 * ⚠️ Token 从 `params.link` 取（而不是从 `preview` 里正则捞）：
 *    `link` 是短信模板的原始入参，形态稳定；`preview` 是渲染后的正文，
 *    会被截断（`SMS_PREVIEW_MAX_LENGTH=500`）。链路长时截断会把
 *    链接尾巴切掉 → 正则失配 → 报"环境未就绪"，方向完全跑偏。
 *
 * @param opts.sessionToken 已登录的会话（该 action 在 ACL 上要求登录）
 * @param opts.ticketNo     只认这个工单的短信（**必须传**，见上）
 * @param opts.scene        缺省 `technician_task`（派工/改约给师傅的那条）
 * @returns 最后一个匹配项的 Token（改约场景下就是**最新**那枚）
 */
export async function tokenFromOutbox({ sessionToken, ticketNo, scene = 'technician_task' } = {}) {
  if (!ticketNo) throw new Error('tokenFromOutbox 必须传 ticketNo（理由见函数注释）');

  const r = await http(`${BASE_URL}/api/svc:smsOutbox?since_seq=0&limit=200`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  if (r.status !== 200) {
    throw new EnvNotReady(
      `mock 短信发件箱不可用（HTTP ${r.status} ${errorMessageOf(r)}）—— ` +
        `/api/svc:smsOutbox 只在 sms.provider=mock 时存在（自毁闸），且需要已登录会话`,
    );
  }
  const items = r.json?.data?.items ?? [];
  const matched = items
    .filter((i) => i?.scene === scene && String(i?.params?.ticket_no ?? '') === String(ticketNo))
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  if (!matched.length) {
    throw new EnvNotReady(
      `发件箱里没有工单 ${ticketNo} 的 ${scene} 短信（共 ${items.length} 条）—— 确认派工成功且通道为 mock`,
    );
  }
  const last = matched[matched.length - 1];
  const token = /\/([A-Za-z0-9_-]{43})$/.exec(String(last?.params?.link ?? ''))?.[1];
  if (!token) {
    throw new EnvNotReady(
      `第 ${last.seq} 条 ${scene} 短信的 params.link 里没有 43 位 Token：${String(
        last?.params?.link ?? '(空)',
      ).slice(0, 120)}`,
    );
  }
  return { token, seq: Number(last.seq), matches: matched.length };
}

/** 发件箱里该工单的**全部**师傅短信（改约后会有多枚 Token，用于断言"旧的真废了"） */
export async function outboxTokensFor({ sessionToken, ticketNo, scene = 'technician_task' }) {
  const r = await http(`${BASE_URL}/api/svc:smsOutbox?since_seq=0&limit=200`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  if (r.status !== 200) return [];
  const items = r.json?.data?.items ?? [];
  return items
    .filter((i) => i?.scene === scene && String(i?.params?.ticket_no ?? '') === String(ticketNo))
    .sort((a, b) => Number(a.seq) - Number(b.seq))
    .map((i) => ({
      seq: Number(i.seq),
      token: /\/([A-Za-z0-9_-]{43})$/.exec(String(i?.params?.link ?? ''))?.[1] ?? null,
    }))
    .filter((i) => i.token);
}

// ---------------------------------------------------------------------------
// 短信开关（取 Token 的**前置条件**）
// ---------------------------------------------------------------------------
/** 参数键：短信总开关。默认 false（供应商账号未批下来时不照发） */
export const SMS_ENABLED_KEY = 'sms.enabled';

/**
 * 临时打开短信开关，跑完**无条件**恢复原值。
 *
 * ---------------------------------------------------------------------------
 * 为什么取 Token 必须先开这个开关（2026-09-23 实测踩到）
 * ---------------------------------------------------------------------------
 * 本机 `sms.enabled=false`，于是派工虽然成功（Visit 建好了），
 * 但两条短信都是 `send_status=rejected / error_code=SMS_DISABLED` ——
 * **短信根本没有经过 mock 通道**，发件箱里自然一条都没有。
 * 而 Token 明文只存在于"短信入参"里（库里只有 sha256），
 * 所以发件箱空 ⇒ **拿不到任何 Token** ⇒ 整个 P5-1 都验不了。
 * 这不是产品的缺陷：`sms.enabled=false` 是"短信供应商还没就绪"的正常配置，
 * 业务应当照常跑（这条本身也是 smoke-test 的一条断言）。
 *
 * 因此这里沿用 `smoke-test.mjs` §4d 的既有做法：改一个参数、用完恢复。
 * ⚠️ 两个必须照抄的细节：
 *   ① **等 11 秒**：`sms.enabled` 由 `ConfigService` 以 **10s TTL** 缓存在进程内
 *      （设计如此，为了"后台改参数不必重启"）。刚写完库就读，可能读到**上一个**值 ——
 *      那会产生一条与功能无关的假红灯（"派工了但发件箱空"），
 *      而排查方向会跑偏到短信代码上。全脚本只此一处等待，等的是一个**确定的**事实。
 *   ② **恢复用读到的原值**，不假设它一定是 false（别人可能正开着）。
 */
export function smsSwitch() {
  const original = psqlScalar(`SELECT value FROM service_settings WHERE key='${SMS_ENABLED_KEY}'`);
  let changed = false;

  return {
    original,
    /** 打开并等过缓存 TTL */
    async enable() {
      psqlExec(`UPDATE service_settings SET value='true' WHERE key='${SMS_ENABLED_KEY}';`);
      changed = true;
      await new Promise((resolve) => setTimeout(resolve, 11_000));
    },
    /**
     * 恢复原值。**必须放在 finally 里**（本文件头 ⑤：不留环境改动）。
     * 恢复本身也要被验证 —— 不验证的话，"恢复失败"会静默地影响**下一次**
     * 运行（那一轮里 `sms.enabled` 是开着的），而两轮各自的日志都看不出所以然。
     */
    restore() {
      if (!changed) return { ok: true, note: '未改动，无需恢复' };
      psqlExec(`UPDATE service_settings SET value='${original}' WHERE key='${SMS_ENABLED_KEY}';`);
      const now = psqlScalar(`SELECT value FROM service_settings WHERE key='${SMS_ENABLED_KEY}'`);
      const ok = now === original;
      if (!ok) console.log(`  ⚠️ ${SMS_ENABLED_KEY} 未恢复成功，请手工设为 '${original}'（当前 '${now}'）`);
      return { ok, note: `${original} → true → ${now}` };
    },
  };
}

// ---------------------------------------------------------------------------
// 直接打师傅接口（对外路径，经 nginx —— **不用内部 NocoBase 路径**）
// ---------------------------------------------------------------------------
export async function technicianGet(token) {
  return http(`${BASE_URL}/api/technician/visits/${token}`);
}

export async function technicianUpload(token, fileBuffer, { filename = 'photo.jpg', contentType = 'image/jpeg', photoType } = {}) {
  const form = new FormData();
  const blob = new Blob([fileBuffer], { type: contentType });
  form.append('file', blob, filename);
  if (photoType) form.append('photo_type', photoType);
  return http(`${BASE_URL}/api/technician/visits/${token}/files`, { method: 'POST', body: form });
}

export async function technicianSubmit(token, body) {
  return http(`${BASE_URL}/api/technician/visits/${token}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

export async function technicianPhoto(token, ref) {
  return http(`${BASE_URL}/api/technician/visits/${token}/photos/${ref}`);
}

// ---------------------------------------------------------------------------
// 快照（submit 前后对比用；字段刻意挑"语义敏感的"，不是 SELECT *）
// ---------------------------------------------------------------------------
export function visitSnapshots(ticketId) {
  return psqlRows(
    `SELECT id, visit_no, visit_status, store_confirm_status, coalesce(service_result,'-'),` +
      ` coalesce(service_note,'-'), is_charged, coalesce(reported_charge_amount::text,'-'),` +
      ` (token_used_at IS NOT NULL)::text, (token_revoked_at IS NOT NULL)::text,` +
      ` coalesce(submitted_at::text,'-')` +
      ` FROM service_visits WHERE ticket_id = ${ticketId} ORDER BY visit_no`,
  ).map((r) => r.join(' | '));
}

/**
 * 工单快照（submit 前后对比用）。
 *
 * ⚠️ 列的可用性必须**对着真库**写，不能凭字段表名猜。
 *    本函数原先查的是 `accept_at` —— `service_tickets` 上**根本没有这一列**
 *    （真实列是 `dispatch_at` / `completed_at` / `reviewed_at`），
 *    于是每次调用都抛 `column "accept_at" does not exist`。
 *    它一直没被发现，是因为在 P5-1 的 submit 脚本之前**没有任何脚本调用它**
 *    （死代码）：没有调用点的"工具函数"不会被任何绿灯覆盖。
 */
export function ticketSnapshot(ticketId) {
  const r = psqlRows(
    `SELECT status, coalesce(dispatch_at::text,'-'), coalesce(completed_at::text,'-'),` +
      ` coalesce(technician_name,'-')` +
      ` FROM service_tickets WHERE id = ${ticketId}`,
  )[0];
  return r ? r.join(' | ') : '(不存在)';
}

export function eventRows(ticketId) {
  return psqlRows(
    `SELECT event_type, coalesce(from_status,'-'), coalesce(to_status,'-'),` +
      ` coalesce(visit_id::text,'-'), summary` +
      ` FROM ticket_events WHERE ticket_id = ${ticketId} ORDER BY id`,
  );
}

export function photoRows(ticketId) {
  return psqlRows(
    `SELECT p.id, p.visit_id, p.photo_type, p.storage_key, p.mime, p.size,` +
      ` coalesce(p.width::text,'-'), coalesce(p.height::text,'-'), p.sort_order,` +
      ` coalesce(p.upload_ip_hash,'-')` +
      ` FROM service_visit_photos p` +
      ` JOIN service_visits v ON v.id = p.visit_id` +
      ` WHERE v.ticket_id = ${ticketId} ORDER BY p.id`,
  );
}

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------

/** 私有目录里是否存在某个 storage_key 对应的文件 */
export function privateFileExists(storageKey) {
  const r = inApp(`test -f ${shellQuote(path.posix.join(PRIVATE_DIR, storageKey))} && echo yes`);
  return r.out.includes('yes');
}

/** 公共目录里是否出现了同名文件（**出现即缺陷**） */
/**
 * 公共可服务目录里**这个 storage_key** 是否存在。
 *
 * ⚠️ 不要写"公共目录里有没有任何图片"这种粗判据（本机踩过）：
 *    该目录里本来就有后台的 logo PNG（`logo-*.png`），于是粗判据**永远为真**
 *    → 一条与"私有存储"毫无关系的假红灯，而且它长得跟真缺陷一模一样。
 *    判据必须落到**本次这张照片的 key** 上。
 */
export function publicFileExists(storageKey) {
  if (!storageKey) return false;
  const r = inApp(`test -f ${shellQuote(path.posix.join(PUBLIC_UPLOAD_DIR, storageKey))} && echo yes`);
  return r.out === 'yes';
}

/** 公共可服务目录里现有的图片（诊断用：让日志说清"那里到底有什么"） */
export function publicPhotoFiles() {
  const r = inApp(
    `find ${PUBLIC_UPLOAD_DIR} -type f \\( -name '*.jpg' -o -name '*.jpeg' -o -name '*.png' -o -name '*.webp' \\) 2>/dev/null | head -10`,
  );
  return r.out ? r.out.split('\n').filter(Boolean) : [];
}

/**
 * 夹具照片（**真 JPEG**）：优先复用上传矩阵的 Pillow 产物；不在就现场生成一张。
 *
 * 为什么不能用 4 字节假 JPEG（`FF D8 FF D9`）：上传要过 magic bytes 嗅探 +
 * 容器完整性两道闸（`media-guard.ts`），截断/缺 SOF 的假 JPEG 会被 415/422 拒掉。
 * （P1 矩阵里用假 JPEG 是刻意的 —— 那一格认证先于内容判定，401 与内容无关。）
 */
const TMP_MEDIA = path.join(ROOT, '.tmp-verify', 'p5-media');
const PYTHON = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.workbuddy',
  'binaries',
  'python',
  'envs',
  'default',
  'Scripts',
  'python.exe',
);
export function ensureFixtureJpeg() {
  const file = path.join(TMP_MEDIA, 'real-exif.jpg');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  fs.mkdirSync(TMP_MEDIA, { recursive: true });
  const py = [
    "import os, sys",
    "from PIL import Image",
    "d = sys.argv[1]",
    "img = Image.new('RGB', (640, 480))",
    "px = img.load()",
    "for y in range(480):",
    "    for x in range(640):",
    "        px[x, y] = ((x * 7) % 256, (y * 5) % 256, ((x + y) * 3) % 256)",
    "img.save(os.path.join(d, 'real-exif.jpg'), 'JPEG', quality=90)",
  ].join('\n');
  try {
    execFileSync(PYTHON, ['-c', py, TMP_MEDIA], { encoding: 'utf8' });
  } catch (error) {
    throw new EnvNotReady(`生成夹具 JPEG 失败（需要宿主机 Pillow）：${error.message}`);
  }
  assert(fs.existsSync(file), '夹具 JPEG 生成后仍不存在');
  return fs.readFileSync(file);
}

/**
 * 精确删除一支脚本自建的工单及其全部附属物。
 *
 * ⚠️ 只按传入的 id 删（文件头 ①）。照片的**磁盘文件**也要删（文件头 ④）：
 *    先从库里取 storage_key，再逐个删文件，最后删行。
 */
export function cleanupTicket(ticketId) {
  if (!ticketId) return;

  // ⚠️ 顺序很重要：**先把要用的 id/key 读出来，再删行**。
  //    反过来写会踩到"删完 photo 行才去按 file_id 删附件"——
  //    子查询此时已经空了，附件行成了孤儿（而且不会报错）。
  const photos = psqlRows(
    `SELECT p.storage_key, p.file_id FROM service_visit_photos p` +
      ` JOIN service_visits v ON v.id = p.visit_id WHERE v.ticket_id = ${ticketId}`,
  ).map((r) => ({ key: r[0], fileId: r[1] }));

  // 只删"本系统生成"的形状，防止一旦库被写坏而误删库外文件
  const keys = photos
    .map((p) => p.key)
    .filter((k) => /^visits\/\d+\/\d{6}\/[0-9a-f]{48}\.(jpg|png|webp)$/.test(k));

  for (const key of keys) {
    inApp(`rm -f ${shellQuote(path.posix.join(PRIVATE_DIR, key))}`);
  }

  const fileIds = photos.map((p) => Number(p.fileId)).filter((n) => Number.isFinite(n) && n > 0);

  const statements = [
    `DELETE FROM service_visit_photos WHERE visit_id IN (SELECT id FROM service_visits WHERE ticket_id = ${ticketId});`,
    fileIds.length ? `DELETE FROM attachments WHERE id IN (${fileIds.join(',')});` : '',
    `DELETE FROM idempotency_records WHERE resource_id = ${ticketId};`,
    `DELETE FROM sms_logs WHERE ticket_id = ${ticketId};`,
    `DELETE FROM ticket_events WHERE ticket_id = ${ticketId};`,
    `DELETE FROM service_visits WHERE ticket_id = ${ticketId};`,
    `DELETE FROM service_tickets WHERE id = ${ticketId};`,
  ].filter(Boolean);

  psqlExec(statements.join(' '));
  return { filesDeleted: keys.length, attachmentsDeleted: fileIds.length };
}

/** 单引号转义（只用于我们自己构造的、形状受约束的路径串） */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// 运行包裹：把 EnvNotReady 的处理收成一处
// ---------------------------------------------------------------------------
/**
 * 统一的 main 包装。
 *
 * 为什么要有它：`process.exit(2)` 会**跳过 finally**（本文件头 ⑤）。
 * 这里登记 `finally` 回调，把"退出码 2"推迟到清理之后。
 */
export async function runMain({ name, main, cleanup }) {
  console.log(`\n=== ${name} ===`);
  let envFailure = '';
  try {
    await main();
  } catch (error) {
    if (error instanceof EnvNotReady) {
      envFailure = error.message;
    } else {
      console.log(`\n  ❌ 脚本异常：${error?.stack ?? error}\n`);
      envFailure = `异常：${error?.message ?? error}`;
    }
  } finally {
    try {
      cleanup?.();
    } catch (error) {
      console.log(`  ⚠️ 清理失败：${error?.message}`);
    }
  }
  if (envFailure) {
    console.log(`\n  🟡 环境未就绪（退出码 2）：${envFailure}\n`);
    process.exit(2);
  }
}
