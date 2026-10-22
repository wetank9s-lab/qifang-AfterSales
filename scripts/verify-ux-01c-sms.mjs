#!/usr/bin/env node
/**
 * verify-ux-01c-sms.mjs —— 「短信通知」管理专项门禁（UX-01C-R8）
 *
 * ===========================================================================
 * 覆盖（逐条对应本轮指令）
 * ===========================================================================
 *   A. 参数与真实消费点：三键（enabled/provider/retry_count）+ 服务商能力；
 *   B. 权限：仅 hq_admin；其余角色 403；页面直访被拒；
 *   C. 校验：bool 只收明确布尔、enum 只收已实现通道、retry 0~1、422 中文；
 *   D. 并发 409 + 请求幂等（不新增审计）；
 *   E. 原生写绕过：serviceSettings 原生 update/create/destroy 全 403；
 *      原生读仍只回 SLA 三键（未因加短信而放宽）；
 *   F. 真实消费：
 *      · 开启 + mock ⇒ dispatch 产生 accepted 记录；
 *      · 关闭 ⇒ 产生 rejected(SMS_DISABLED) 记录；
 *      · **重试次数**用离线 harness 跑真实 `SmsService.flush`（注入失败 provider），
 *        断言 retry_count=0/1 时供应商调用次数 = 1/2，非传输错误不重试；
 *   G. 服务商不可用不能误判：aliyun 缺凭证/模板、smsbao 缺模板映射 ⇒ ready=false，
 *      且"开启/切到不可用通道"被 422 拒绝；
 *   H. 真实浏览器：页面渲染、改重试次数、422 提示、非管理员被拒；
 *   I. 重启后配置/审计仍在；夹具工单按 id 清理。
 *
 * 用法：node scripts/verify-ux-01c-sms.mjs
 * 退出码：0 通过 / 1 判据不满足 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { SVC_BASE_URL } from './lib/base-url.mjs';
import { launchCdp, sleep, psqlRows } from './verify-store-ui-primary-action.mjs';
import { cleanupTicket, createScratchTicket, signIn, svcPost, psqlScalar } from './technician-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.tmp-verify');
const ORIGIN = new URL(SVC_BASE_URL).origin;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};
const note = (label, detail = '') => console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);

function envValue(key, fallback = '') {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* fallthrough */
  }
  return process.env[key] ?? fallback;
}

async function login(emailKey, fallback) {
  const r = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({
      email: envValue(emailKey, fallback),
      password: envValue(emailKey.replace('_EMAIL', '_PASSWORD')),
    }),
  });
  if (r.status !== 200) throw new Error(`${fallback} 登录失败 HTTP ${r.status}`);
  return (await r.json()).data.token;
}

const uuid = () => crypto.randomUUID();

async function apiGet(token, pathname) {
  const r = await fetch(`${SVC_BASE_URL}/api/${pathname}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* noop */
  }
  return { status: r.status, json, text };
}

async function apiPost(token, pathname, body, requestId = uuid()) {
  const r = await fetch(`${SVC_BASE_URL}/api/${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Request-Id': requestId,
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* noop */
  }
  return { status: r.status, json, text };
}

const settingRow = (key) =>
  psqlRows(`select value from service_settings where key='${key}'`)[0]?.[0] ?? '';
const auditCount = (key) =>
  Number(String(psqlScalar(`select count(*) from config_change_audits where key='${key}'`) ?? '0').trim());

async function updateSetting(token, key, value, expected, { scene = 'update', requestId = uuid() } = {}) {
  return apiPost(token, 'svc:updateSetting', { key, value, expected_value: expected, scene }, requestId);
}

function restartApp() {
  spawnSync('docker', ['compose', 'restart', 'app'], { cwd: ROOT, stdio: 'ignore' });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const r = spawnSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', 'svc-app'], { encoding: 'utf8' });
    if (String(r.stdout).trim() === 'healthy') {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  throw new Error('等待 svc-app healthy 超时');
}

// ---------------------------------------------------------------------------
// 离线重试探针：用**真实 SmsService.flush** + 注入失败 provider
// ---------------------------------------------------------------------------
function loadSmsService() {
  const require = createRequire(import.meta.url);
  const esbuild = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/esbuild/lib/main.js');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/services/sms-service.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    external: ['@nocobase/*', 'knex', 'sequelize'],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports.SmsService;
}

async function retryAttempts(SmsService, { limit, errorCode }) {
  let calls = 0;
  const provider = {
    name: 'mock',
    signName: '测试',
    async send() {
      calls += 1;
      return {
        accepted: false,
        errorCode,
        errorMessage: '注入失败',
        providerRequestId: null,
        providerBizId: null,
      };
    },
  };
  const db = {
    sequelize: {
      async query() {
        return [[{ id: 1 }], []];
      },
      async transaction(fn) {
        return fn({});
      },
    },
  };
  const events = { write: async () => {} };
  const config = {
    getBool: async () => true,
    getInt: async (_k, fallback) => (limit === undefined ? fallback : limit),
    getString: async () => 'mock',
  };
  const svc = new SmsService(db, { config, events, provider, logger: {} });
  const pending = {
    smsLogId: 1,
    bizId: `probe-${Date.now()}`,
    scene: 'technician_task',
    templateCode: '',
    ticketId: null,
    visitId: null,
    persisted: true,
    request: {
      to: '13800000000',
      recipientMasked: '138****0000',
      recipientKind: 'technician',
      scene: 'technician_task',
      templateCode: '',
      params: {},
      preview: '测试',
      bizId: 'b1',
    },
  };
  const res = await svc.flush([pending]);
  return { attempts: calls, retryCount: Number(res?.[0]?.retryCount ?? -1), status: res?.[0]?.errorCode };
}

// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  UX-01C-R8：短信通知管理（配置 + 通道能力 + 发送记录）');
console.log('══════════════════════════════════════════════════════════════');

const pageUid = String(
  psqlScalar(`select "schemaUid" from "desktopRoutes" where type='flowPage' and title='短信通知' limit 1`) ?? '',
).trim();
if (!pageUid) {
  console.log('  ⛔ 找不到「短信通知」页面路由 —— 环境未就绪（先跑 seed-admin-pages）');
  process.exit(2);
}
note('页面', `/admin/${pageUid}`);

const tokens = {};
try {
  tokens.hqAdmin = await login('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local');
  tokens.hq = await login('UAT_HQ_EMAIL', 'uat.hq@svc.local');
  tokens.storeA = await login('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local');
  tokens.viewer = await login('UAT_VIEWER_EMAIL', 'uat.viewer@svc.local');
} catch (error) {
  console.log(`  ⛔ ${String(error?.message ?? error)}`);
  process.exit(2);
}

const original = {
  enabled: settingRow('sms.enabled'),
  provider: settingRow('sms.provider'),
  retry: settingRow('sms.retry_count'),
};
note('初始短信配置', `enabled=${original.enabled} provider=${original.provider} retry=${original.retry}`);

const fixtures = [];
try {
  // ── A. 状态与规格 ─────────────────────────────────────────────────────
  console.log('');
  console.log('  A. 参数、消费点与通道能力（服务端判定）');
  {
    const st = await apiGet(tokens.hqAdmin, 'svc:smsStatus');
    const s = st.json?.data;
    check(st.status === 200 && s?.settings, 'hq_admin 读取短信状态 200', `HTTP ${st.status}`);
    check(
      s?.settings?.enabled === (original.enabled === 'true') &&
        s?.settings?.provider === original.provider &&
        Number(s?.settings?.retryCount) === Number(original.retry),
      '状态接口回显库中真实值',
      JSON.stringify(s?.settings),
    );
    const byName = new Map((s?.providers ?? []).map((p) => [p.name, p]));
    check(Boolean(byName.get('mock')?.ready), 'mock 通道：ready（无需凭证/模板）');
    check(byName.get('aliyun')?.ready === false, 'aliyun：缺凭证 ⇒ 不可发送', byName.get('aliyun')?.reason ?? '');
    check(
      byName.get('smsbao')?.ready === false && /模板映射缺失/.test(String(byName.get('smsbao')?.reason ?? '')),
      'smsbao：缺模板映射 ⇒ 明确不可用（不冒充可选）',
      byName.get('smsbao')?.reason ?? '',
    );
    check(!('tencent' in Object.fromEntries(byName)), '不存在 tencent 通道（未实现的不展示）');

    const specs = await apiGet(tokens.hqAdmin, 'svc:listSettingSpecs');
    const keys = (specs.json?.data?.specs ?? []).map((x) => `${x.key}:${x.type}`);
    check(
      ['sms.enabled:bool', 'sms.provider:enum', 'sms.retry_count:int'].every((k) => keys.includes(k)),
      '可写清单恰好登记三个短信键（类型正确）',
      keys.filter((k) => k.startsWith('sms.')).join(', '),
    );
    check(
      (specs.json?.data?.specs ?? []).every((x) => typeof x.consumer === 'string' && x.consumer.length > 0),
      '每条规格都带真实消费点说明',
    );
  }

  // ── B. 权限 ──────────────────────────────────────────────────────────
  console.log('');
  console.log('  B. 权限隔离');
  {
    for (const [role, token] of [['hq_after_sales', tokens.hq], ['store_A', tokens.storeA], ['viewer', tokens.viewer]]) {
      const st = await apiGet(token, 'svc:smsStatus');
      check(st.status === 403, `${role} 读短信状态 403`, `HTTP ${st.status}`);
      const w = await updateSetting(token, 'sms.retry_count', '0', original.retry);
      check(w.status === 403, `${role} 写短信配置 403`, `HTTP ${w.status}`);
    }
    const anon = await apiGet('', 'svc:smsStatus');
    check(anon.status === 401, '匿名读短信状态 401', `HTTP ${anon.status}`);
  }

  // ── C. 原生写绕过 + 原生读范围 ───────────────────────────────────────
  console.log('');
  console.log('  C. 原生接口：写全拒、读不加宽');
  {
    const id = String(psqlScalar(`select id from service_settings where key='sms.retry_count'`) ?? '').trim();
    const upd = await apiPost(tokens.hqAdmin, `serviceSettings:update?filterByTk=${id}`, { value: '9' });
    const del = await apiPost(tokens.hqAdmin, `serviceSettings:destroy?filterByTk=${id}`, {});
    const cre = await apiPost(tokens.hqAdmin, 'serviceSettings:create', { key: '__x__', value: '1' });
    check(upd.status === 403 && del.status === 403 && cre.status === 403, '原生 update/destroy/create 全 403', `${upd.status}/${del.status}/${cre.status}`);
    check(settingRow('sms.retry_count') === original.retry, '绕过尝试后配置值未变', settingRow('sms.retry_count'));

    const list = await apiGet(tokens.hqAdmin, 'serviceSettings:list?pageSize=50');
    const keys = (list.json?.data ?? []).map((r) => r.key);
    check(
      list.status === 200 && keys.length === 3 && keys.every((k) => k.startsWith('sla.')),
      '原生读仍只回 SLA 三键（未因短信设置放宽）',
      keys.join(','),
    );
  }

  // ── D. 校验 / 并发 / 幂等 / 恢复 ─────────────────────────────────────
  console.log('');
  console.log('  D. 校验、并发 409、幂等、恢复审计');
  {
    const badProvider = await updateSetting(tokens.hqAdmin, 'sms.provider', 'tencent', original.provider);
    check(badProvider.status === 422, '未实现通道 422（tencent 不可选）', `HTTP ${badProvider.status}`);

    const badBool = await updateSetting(tokens.hqAdmin, 'sms.enabled', 'yes', original.enabled);
    check(badBool.status === 422, 'bool 只收 true/false（yes ⇒ 422）', `HTTP ${badBool.status}`);

    const badRetry = await updateSetting(tokens.hqAdmin, 'sms.retry_count', '2', original.retry);
    const badMsg = badRetry.json?.errors?.[0]?.message ?? '';
    check(badRetry.status === 422 && /0 ~ 1/.test(badMsg), '重试次数超出契约上限 ⇒ 422（0~1）', badMsg.slice(0, 100));

    // 并发：两个请求同一 expected
    const n0 = auditCount('sms.retry_count');
    const [c1, c2] = await Promise.all([
      updateSetting(tokens.hqAdmin, 'sms.retry_count', '0', original.retry),
      updateSetting(tokens.hqAdmin, 'sms.retry_count', '0', original.retry),
    ]);
    const statuses = [c1.status, c2.status].sort((a, b) => a - b);
    check(statuses[0] === 200 && statuses[1] === 409, '两请求同 expected ⇒ 200 + 409', statuses.join(','));
    check(auditCount('sms.retry_count') === n0 + 1, '并发只多一条审计', `${n0} → ${auditCount('sms.retry_count')}`);
    check(settingRow('sms.retry_count') === '0', '库里为胜出请求的值', settingRow('sms.retry_count'));

    // 幂等：同一 request id 重放
    const rid = uuid();
    const n1 = auditCount('sms.retry_count');
    const first = await updateSetting(tokens.hqAdmin, 'sms.retry_count', '1', '0', { requestId: rid });
    const second = await updateSetting(tokens.hqAdmin, 'sms.retry_count', '1', '0', { requestId: rid });
    check(first.status === 200 && second.status === 200, '同 request id 两次 200', `${first.status}/${second.status}`);
    check(second.json?.data?.data?.replayed === true, '第二次标记幂等回放（replayed=true）');
    check(auditCount('sms.retry_count') === n1 + 1, '幂等回放不新增审计', `${n1} → ${auditCount('sms.retry_count')}`);

    // 恢复（scene=restore）留审计
    const n2 = auditCount('sms.retry_count');
    const restore = await updateSetting(tokens.hqAdmin, 'sms.retry_count', original.retry, '1', { scene: 'restore' });
    const last = psqlRows(
      `select scene from config_change_audits where key='sms.retry_count' order by id desc limit 1`,
    )[0]?.[0];
    check(restore.status === 200 && auditCount('sms.retry_count') === n2 + 1 && last === 'restore', '恢复旧值也留审计（scene=restore）', `scene=${last}`);
  }

  // ── E. 不可用通道的开启闸门 ──────────────────────────────────────────
  console.log('');
  console.log('  E. 不可用通道不能被误标为可发送');
  {
    // 先关短信 → 切到 aliyun（缺凭证）应被拒（即使关闭也拦：避免"切过去就再也开不起来"的错觉？）
    const res = await updateSetting(tokens.hqAdmin, 'sms.provider', 'aliyun', original.provider);
    check(res.status === 422 && res.json?.errors?.[0]?.code === 'SMS_PROVIDER_NOT_READY', '切到缺凭证的 aliyun ⇒ 422 SMS_PROVIDER_NOT_READY', `HTTP ${res.status}`);
    check(settingRow('sms.provider') === original.provider, '通道未被改动', settingRow('sms.provider'));

    const en = await updateSetting(tokens.hqAdmin, 'sms.enabled', 'true', original.enabled);
    check(en.status === 200, 'mock 通道下开启 200', `HTTP ${en.status}`);
  }

  // ── F. 真实消费：mock 发送 + 关闭拒绝 ────────────────────────────────
  console.log('');
  console.log('  F. 真实消费（mock 通道；不向真实客户发送）');
  let tokenForDispatch = null;
  {
    tokenForDispatch = await signIn(envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'), envValue('UAT_STORE_A_PASSWORD'));

    // 开启 + mock：dispatch 产生 accepted
    const t1 = await createScratchTicket({ tag: 'R8-SMS-ON', content: 'R8 短信门禁：开启状态下的派工' });
    fixtures.push(t1.ticketId);
    const d1 = await svcPost(
      'dispatch',
      t1.ticketId,
      tokenForDispatch,
      {
        technician_name: 'R8验收师傅',
        technician_mobile: '13900010009',
        expected_visit_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        service_mode: 'inhouse',
      },
      uuid(),
    );
    check(d1.status === 200, '开启状态下派工成功', `HTTP ${d1.status}`);
    await sleep(1500);
    const rows1 = psqlRows(
      `select scene,provider,send_status,error_code,recipient_masked,retry_count from sms_logs where ticket_id=${t1.ticketId} order by id`,
    );
    const accepted = rows1.find((r) => r[2] === 'accepted');
    check(Boolean(accepted) && accepted[1] === 'mock', '产生了 mock 的 accepted 发送记录', JSON.stringify(rows1));
    check(rows1.every((r) => /^\d{3}\*{4}\d{4}$/.test(r[4])), '记录中的手机号已脱敏', rows1.map((r) => r[4]).join(','));

    // 关闭：再派工 → rejected(SMS_DISABLED)
    const off = await updateSetting(tokens.hqAdmin, 'sms.enabled', 'false', 'true');
    check(off.status === 200, '关闭短信 200', `HTTP ${off.status}`);
    // ⚠️ ConfigService 有 10s 缓存：不等它过期就派工，flush 仍会读到 true
    //    （实测踩到：关闭后派工的短信仍是 accepted）。等 TTL 再发。
    await sleep(11_000);
    const t2 = await createScratchTicket({ tag: 'R8-SMS-OFF', content: 'R8 短信门禁：关闭状态下的派工' });
    fixtures.push(t2.ticketId);
    const d2 = await svcPost(
      'dispatch',
      t2.ticketId,
      tokenForDispatch,
      {
        technician_name: 'R8验收师傅',
        technician_mobile: '13900010010',
        expected_visit_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        service_mode: 'inhouse',
      },
      uuid(),
    );
    check(d2.status === 200, '关闭状态下派工仍成功（业务不失败）', `HTTP ${d2.status}`);
    await sleep(1200);
    const rows2 = psqlRows(`select send_status,error_code from sms_logs where ticket_id=${t2.ticketId} order by id`);
    check(rows2.some((r) => r[0] === 'rejected' && r[1] === 'SMS_DISABLED'), '关闭后产生 rejected(SMS_DISABLED) 记录', JSON.stringify(rows2));

    // 恢复开启
    const on = await updateSetting(tokens.hqAdmin, 'sms.enabled', 'true', 'false');
    check(on.status === 200, '恢复开启 200', `HTTP ${on.status}`);
  }

  // ── G. 重试次数真实消费（离线跑真实 flush）──────────────────────────
  console.log('');
  console.log('  G. 重试次数被真实消费（真实 SmsService.flush + 注入失败 provider）');
  {
    let SmsService;
    try {
      SmsService = loadSmsService();
    } catch (error) {
      check(false, '加载 SmsService', String(error?.message ?? error).slice(0, 160));
    }
    if (SmsService) {
      const r0 = await retryAttempts(SmsService, { limit: 0, errorCode: 'SMS_TRANSPORT_ERROR' });
      check(r0.attempts === 1 && r0.retryCount === 0, 'retry_count=0 ⇒ 只调用 1 次', JSON.stringify(r0));
      const r1 = await retryAttempts(SmsService, { limit: 1, errorCode: 'SMS_TRANSPORT_ERROR' });
      check(r1.attempts === 2 && r1.retryCount === 1, 'retry_count=1 ⇒ 调用 2 次（1 次内联重试）', JSON.stringify(r1));
      const rb = await retryAttempts(SmsService, { limit: 1, errorCode: 'SMS_TEMPLATE_NOT_CONFIGURED' });
      check(rb.attempts === 1, '非传输层错误不重试（模板缺失）', JSON.stringify(rb));
    }
  }

  // ── H. 真实浏览器 ───────────────────────────────────────────────────
  console.log('');
  console.log('  H. 真实浏览器（页面 / 改重试 / 422 / 非管理员）');
  {
    const session = await launchCdp({ label: 'r8-sms-ui' });
    const { cdp } = session;
    try {
      await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/signin` });
      await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页' });
      await cdp.evaluate(`(() => {
        const ins = [...document.querySelectorAll('input')];
        const setVal = (el, val) => {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
          setter.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setVal(ins[0], ${JSON.stringify(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'))});
        setVal(ins[1], ${JSON.stringify(envValue('UAT_HQADMIN_PASSWORD'))});
        return true;
      })()`);
      await sleep(700);
      await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
      await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 45_000 });
      await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/admin/${pageUid}` });
      await sleep(5000);
      const dom = await cdp.evaluate(`(() => ({
        hasCenter: !!document.querySelector('[data-testid="sms-center"]'),
        providerRows: document.querySelectorAll('[data-testid^="sms-provider-row-"]').length,
        settingRows: document.querySelectorAll('[data-testid^="sms-setting-sms."]').length,
        logs: document.querySelectorAll('[data-testid="sms-log-row"]').length,
        text: (document.querySelector('[data-testid="sms-center"]')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
        hasSecret: /ALIYUN_SMS_ACCESS_KEY_SECRET=|SMSBAO_API_KEY=/.test(document.body.innerText),
      }))()`);
      check(dom.hasCenter, '短信通知页面渲染（自定义区块）', dom.text);
      check(dom.providerRows === 3, '通道能力表 3 行', `实际 ${dom.providerRows}`);
      check(dom.settingRows === 3, '配置区 3 项', `实际 ${dom.settingRows}`);
      check(dom.logs > 0, '最近发送记录可见', `${dom.logs} 行`);
      check(!dom.hasSecret, '页面不回显任何凭证值');

      // 改重试次数：1 → 0
      const clickEdit = async (key) => {
        await cdp.evaluate(`document.querySelector('[data-testid="sms-setting-edit-${key}"]').click()`);
        await cdp.waitFor(`!!document.querySelector('[data-testid="sms-edit-modal"]')`, { what: '编辑弹窗', timeout: 20_000 });
      };
      const setValue = async (value) => {
        await cdp.evaluate(`(() => {
          const el = document.querySelector('[data-testid="sms-edit-value"]');
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
          setter.call(el, ${JSON.stringify(String(value))});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        await sleep(200);
      };
      const save = async () => {
        await cdp.evaluate(`(() => {
          const norm = (s) => String(s || '').replace(/\\s+/g, '');
          const b = [...document.querySelectorAll('.ant-modal button')].find((x) => norm(x.innerText) === '保存');
          if (b) b.click();
          return !!b;
        })()`);
      };

      await clickEdit('sms.retry_count');
      const modalText = await cdp.evaluate(`document.querySelector('[data-testid="sms-edit-modal"]').innerText.replace(/\\s+/g,' ')`);
      check(/发送失败重试次数/.test(modalText) && /覆盖/.test(modalText) === false, '编辑弹窗显示中文名与生效说明', modalText.slice(0, 120));
      await setValue('0');
      await save();
      await cdp.waitFor(
        `[...document.querySelectorAll('.ant-message-notice-content')].some((n) => (n.innerText || '').includes('已保存'))`,
        { what: '保存成功提示', timeout: 30_000 },
      );
      await cdp.waitFor(`!document.querySelector('[data-testid="sms-edit-modal"]')`, { what: '弹窗关闭', timeout: 20_000 });
      await sleep(800);
      check(settingRow('sms.retry_count') === '0', '页面保存后库里已更新', settingRow('sms.retry_count'));
      const shownRetry = await cdp.evaluate(
        `document.querySelector('[data-testid="sms-setting-sms.retry_count"]')?.innerText.replace(/\\s+/g,' ')`,
      );
      check(/0\s*次/.test(shownRetry), '页面重新读取并显示新值', shownRetry);

      // 422：2 次超出契约
      await clickEdit('sms.retry_count');
      await setValue('2');
      await save();
      await cdp.waitFor(
        `[...document.querySelectorAll('.ant-message-notice-content')].some((n) => (n.innerText || '').includes('422'))`,
        { what: '422 提示', timeout: 30_000 },
      );
      const err = await cdp.evaluate(`[...document.querySelectorAll('.ant-message-notice-content')].map((n) => n.innerText).join(' | ')`);
      check(/422/.test(err) && /0 ~ 1/.test(err), '422 中文提示范围', err.replace(/\s+/g, ' ').slice(0, 140));
      check(Boolean(await cdp.evaluate(`!!document.querySelector('[data-testid="sms-edit-modal"]')`)), '422 后弹窗保持打开');
      await cdp.evaluate(`(() => { const n = (s)=>String(s||'').replace(/\\s+/g,''); const b=[...document.querySelectorAll('.ant-modal button')].find(x=>n(x.innerText)==='取消'); if(b)b.click(); return true; })()`);
      await sleep(500);
      await cdp.evaluate(`(() => { const n = (s)=>String(s||'').replace(/\\s+/g,''); const b=[...document.querySelectorAll('.ant-modal button')].find(x=>n(x.innerText)==='放弃并关闭'); if(b)b.click(); return true; })()`);
      await sleep(600);

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT_DIR, 'ux01c-r8-sms-center.png'), Buffer.from(shot.data, 'base64'));
    } finally {
      session.close();
    }

    // 非管理员直访
    const s2 = await launchCdp({ label: 'r8-sms-store' });
    const { cdp: c2 } = s2;
    try {
      await c2.send('Page.navigate', { url: `${SVC_BASE_URL}/signin` });
      await c2.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页' });
      await c2.evaluate(`(() => {
        const ins = [...document.querySelectorAll('input')];
        const setVal = (el, val) => {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
          setter.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setVal(ins[0], ${JSON.stringify(envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'))});
        setVal(ins[1], ${JSON.stringify(envValue('UAT_STORE_A_PASSWORD'))});
        return true;
      })()`);
      await sleep(700);
      await c2.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
      await c2.waitFor(`location.href.indexOf('/signin') === -1`, { what: '门店登录', timeout: 45_000 });
      await c2.send('Page.navigate', { url: `${SVC_BASE_URL}/admin/${pageUid}` });
      await sleep(4000);
      // 归一化放在 Node 侧：正则不放进模板字符串，避免转义层数把它变成 /s+/g
      const rawTxt = await c2.evaluate(`(document.body.innerText || '')`);
      const txt = String(rawTxt).replace(/\s+/g, ' ').slice(0, 300);
      const hasCenter = await c2.evaluate(`!!document.querySelector('[data-testid="sms-center"]')`);
      // 两种拒绝形态都算通过：① 路由未授权 → 404；② 区块接口 403 → 提示「仅总部管理员」
      check(
        !hasCenter && (/仅总部管理员/.test(txt) || /页面不存在|No permissions/.test(txt)),
        '非 hq_admin 直访页面被拒（不渲染配置）',
        txt.slice(0, 120),
      );
    } finally {
      s2.close();
    }
  }

  // ── I. 重启持久性 ───────────────────────────────────────────────────
  console.log('');
  console.log('  I. 重启后配置与审计仍在');
  {
    const before = {
      retry: settingRow('sms.retry_count'),
      audits: auditCount('sms.retry_count'),
    };
    restartApp();
    const token = await login('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local');
    check(settingRow('sms.retry_count') === before.retry, '重启后配置值保持', settingRow('sms.retry_count'));
    check(auditCount('sms.retry_count') === before.audits, '重启后审计条数不变', `${before.audits}`);
    const st = await apiGet(token, 'svc:smsStatus');
    check(st.status === 200, '重启后状态接口仍可用', `HTTP ${st.status}`);
  }
} finally {
  // ── 恢复配置 + 清理夹具 ─────────────────────────────────────────────
  console.log('');
  console.log('  J. 收尾（恢复原配置 / 按 id 清理夹具）');
  try {
    const token = await login('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local');
    if (settingRow('sms.enabled') !== original.enabled) {
      await updateSetting(token, 'sms.enabled', original.enabled, settingRow('sms.enabled'), { scene: 'restore' });
    }
    if (settingRow('sms.provider') !== original.provider) {
      await updateSetting(token, 'sms.provider', original.provider, settingRow('sms.provider'), { scene: 'restore' });
    }
    if (settingRow('sms.retry_count') !== original.retry) {
      await updateSetting(token, 'sms.retry_count', original.retry, settingRow('sms.retry_count'), { scene: 'restore' });
    }
    check(
      settingRow('sms.enabled') === original.enabled &&
        settingRow('sms.provider') === original.provider &&
        settingRow('sms.retry_count') === original.retry,
      '短信配置已恢复原值',
      `enabled=${settingRow('sms.enabled')} provider=${settingRow('sms.provider')} retry=${settingRow('sms.retry_count')}`,
    );
  } catch (error) {
    check(false, '恢复短信配置', String(error?.message ?? error).slice(0, 160));
  }
  for (const id of fixtures) {
    try {
      cleanupTicket(id);
      note('已清理夹具工单', `#${id}`);
    } catch (error) {
      note('清理夹具失败', `#${id} ${String(error?.message ?? error).slice(0, 80)}`);
    }
  }
  const left = Number(String(psqlScalar(`select count(*) from service_tickets where customer_name like 'R8-%'`) ?? '0').trim());
  check(left === 0, '夹具工单已清零', `残留 ${left}`);
}

const failed = results.filter((r) => !r.pass);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  结果：通过 ${results.length - failed.length} / 失败 ${failed.length}`);
if (failed.length) for (const f of failed) console.log(`    ❌ ${f.label}${f.detail ? ` —— ${f.detail}` : ''}`);
console.log('══════════════════════════════════════════════════════════════');
process.exit(failed.length ? 1 : 0);
