/**
 * 短信宝 provider 的**针对性验收**（P11-4 第十轮）
 *
 *   node scripts/verify-smsbao-provider.mjs
 *
 * 全部走**产品的真实代码**，不另写实现：
 *   · `createSmsProvider('smsbao', …)` —— 工厂扩展点；
 *   · `renderSmsPreview(...)` —— 产品的正文渲染（抽出的纯函数，SmsService 也用它）；
 *   · `SMS_TEMPLATE_TEXT` —— 六个既有场景的文案。
 *
 * HTTP 层用**注入的 fetchFn**（`SmsProviderOptions.fetchFn` 是既有的测试扩展点）
 * 模拟短信宝的各种返回，**不发送任何真实短信**。
 *
 * 覆盖用户列出的六项：成功 / 余额不足 / 鉴权失败 / 敏感词 / 号码错误 / 网络超时，
 * 外加：六个场景正文正确 + 签名只出现一次 + 日志不泄漏凭据与完整 URL + 配置缺失不误发。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_WORKSPACE = 'C:/Users/Administrator/.workbuddy/binaries/node/workspace';

const checks = [];
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
};

/** 载入产品的真实 TS 模块（bundle 后 require，与既有验收同一做法） */
function loadModule(relPath, exportNames) {
  const esbuild = require(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild', 'lib', 'main.js'));
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'nocobase/plugins/service-ticket/src/server', relPath)],
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
  const picked = {};
  for (const n of exportNames) picked[n] = mod.exports[n];
  return picked;
}

const { createSmsProvider } = loadModule('services/sms-provider.ts', ['createSmsProvider']);
const { renderSmsPreview } = loadModule('services/sms-preview.ts', ['renderSmsPreview']);
const { SMS_TEMPLATE_TEXT, SMS_SCENE } = loadModule('constants.ts', ['SMS_TEMPLATE_TEXT', 'SMS_SCENE']);

// 伪造凭据（**只在内存里**，不写文件、不进仓库）
const FAKE_USER = 'verify-user';
const FAKE_KEY = 'FAKE-APIKEY-DO-NOT-LEAK-9f2c';
const FAKE_SIGN = '七方售后';
const MOBILE = '13800001234';
const ENV = { SMSBAO_USERNAME: FAKE_USER, SMSBAO_API_KEY: FAKE_KEY, SMSBAO_SIGN_NAME: FAKE_SIGN };

/** 收集 provider 打出来的所有日志（用来断言"没泄漏"） */
function makeLogger() {
  const lines = [];
  return {
    lines,
    warn: (m) => lines.push(String(m)),
    info: (m) => lines.push(String(m)),
    debug: (m) => lines.push(String(m)),
  };
}

/** 造一个 provider：注入 fake fetch + 收集日志 */
function makeProvider(fakeFetch) {
  const logger = makeLogger();
  const provider = createSmsProvider('smsbao', { env: ENV, logger, fetchFn: fakeFetch, timeoutMs: 300 });
  return { provider, logger };
}

/** 模拟短信宝返回：纯文本（官方形态） */
const textReply = (body) => async () => new Response(body, { status: 200 });

/** 一次发送的请求体（用真实渲染的正文） */
const req = (scene, params) => ({
  to: MOBILE,
  recipientMasked: '138****1234',
  recipientKind: 'customer',
  scene,
  templateCode: '',
  params,
  preview: renderSmsPreview(scene, params, FAKE_SIGN),
  bizId: `biz-${scene}`,
});

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  短信宝 provider · 针对性验收（全部用注入 fetch，不发真实短信）');
console.log('══════════════════════════════════════════════════════════════');

// ===========================================================================
// ① 六种接口返回
// ===========================================================================
console.log('\n── ① 短信宝接口返回的六种情形 ──────────────────────────');
{
  const cases = [
    ['成功（官方原文：返回 0 视为发送成功）', textReply('0'), true, null],
    ['余额不足', textReply('41'), false, 'SMSBAO_INSUFFICIENT_BALANCE'],
    ['鉴权失败（错误密码/账号不存在）', textReply('30'), false, 'SMSBAO_BAD_CREDENTIAL'],
    ['账号不存在', textReply('40'), false, 'SMSBAO_ACCOUNT_NOT_FOUND'],
    ['内容含敏感词', textReply('50'), false, 'SMSBAO_CONTENT_REJECTED'],
    ['手机号码不正确', textReply('51'), false, 'SMSBAO_BAD_NUMBER_PLACEHOLDER'],
  ];
  for (const [label, fetchImpl, expectAccepted, expectCode] of cases) {
    const { provider } = makeProvider(fetchImpl);
    const r = await provider.send(req(SMS_SCENE.PROGRESS_LINK, { ticket_no: 'FW20261014-0999', link: 'https://x/p/t' }));
    const codeOk = expectCode === null ? true : expectCode === 'SMSBAO_BAD_NUMBER_PLACEHOLDER' ? r.errorCode === 'SMSBAO_BAD_MOBILE' : r.errorCode === expectCode;
    ok(
      `返回「${label}」⇒ accepted=${expectAccepted}`,
      r.accepted === expectAccepted && codeOk,
      `accepted=${r.accepted}${r.errorCode ? ' code=' + r.errorCode : ''}`,
    );
  }

  // JSON 形态也要认（用户要求带 f=json；两种返回形态都得能解析）
  const { provider: pJson } = makeProvider(async () => new Response('{"code":0}', { status: 200 }));
  const rJson = await pJson.send(req(SMS_SCENE.PROGRESS_LINK, { ticket_no: 'FW1', link: 'https://x/p/t' }));
  ok('JSON 形态返回 {"code":0} 也能被识别为成功', rJson.accepted === true, `accepted=${rJson.accepted}`);

  const { provider: pJson41 } = makeProvider(async () => new Response('{"code":41,"msg":"余额不足"}', { status: 200 }));
  const rJson41 = await pJson41.send(req(SMS_SCENE.PROGRESS_LINK, { ticket_no: 'FW1', link: 'https://x/p/t' }));
  ok('JSON 形态返回 {"code":41} 映射为余额不足', rJson41.errorCode === 'SMSBAO_INSUFFICIENT_BALANCE', `code=${rJson41.errorCode}`);
}

// ---- 网络超时（AbortError）----
{
  const { provider, logger } = makeProvider(
    () => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 20)),
  );
  const r = await provider.send(req(SMS_SCENE.PROGRESS_LINK, { ticket_no: 'FW1', link: 'https://x/p/t' }));
  ok('网络超时 ⇒ accepted=false 且 errorCode=SMSBAO_TIMEOUT', r.accepted === false && r.errorCode === 'SMSBAO_TIMEOUT', `code=${r.errorCode}`);
  ok(
    '超时文案说明"结果未知、交由既有重试/恢复策略"（不自行重试）',
    /结果未知/.test(String(r.errorMessage ?? '')),
    String(r.errorMessage ?? '').slice(0, 50),
  );
  ok('超时日志里没有 URL/凭据', !logger.lines.some((l) => l.includes(FAKE_KEY) || l.includes('http')), `${logger.lines.length} 行日志`);
}

// ---- 网络异常（fetch 的 error.message 通常内嵌完整 URL）----
{
  const leakyError = Object.assign(
    new Error(`fetch failed: https://api.smsbao.com/sms?u=${FAKE_USER}&p=${FAKE_KEY}&m=${MOBILE}&c=...`),
    { name: 'TypeError' },
  );
  const { provider, logger } = makeProvider(async () => {
    throw leakyError;
  });
  const r = await provider.send(req(SMS_SCENE.PROGRESS_LINK, { ticket_no: 'FW1', link: 'https://x/p/t' }));
  const allText = `${r.errorMessage ?? ''} ${logger.lines.join(' ')}`;
  ok(
    '🔴 网络异常时**不回显 fetch 的错误消息**（它内嵌完整 URL）',
    r.accepted === false && r.errorCode === 'SMSBAO_NETWORK_ERROR' && !allText.includes(FAKE_KEY) && !allText.includes(MOBILE),
    `code=${r.errorCode} 泄漏=${allText.includes(FAKE_KEY) || allText.includes(MOBILE)}`,
  );
}

// ===========================================================================
// ② 六个场景的正文 + 签名只出现一次
// ===========================================================================
console.log('\n── ② 既有场景的最终正文与签名 ──────────────────────────');
{
  const scenarios = [
    [SMS_SCENE.DISPATCH_CUSTOMER, { label: '空调维修', ticket_no: 'FW20261014-0001', store: '圣大家电', technician: '张师傅', expected: '今天 15:00' }],
    [SMS_SCENE.TECHNICIAN_TASK, { ticket_no: 'FW20261014-0001', store: '圣大家电', customer: '李女士', address: '新都区某路 1 号', expected: '今天 15:00' }],
    [SMS_SCENE.TECHNICIAN_ASSIGNMENT_CANCELLED, { ticket_no: 'FW20261014-0001', store: '圣大家电', reason: '客户改约' }],
    [SMS_SCENE.DISPATCH_UPDATE, { ticket_no: 'FW20261014-0001', store: '圣大家电', expected: '明天 10:00', label: '空调维修', technician: '张师傅' }],
    [SMS_SCENE.REVIEW_INVITE, { ticket_no: 'FW20261014-0001', store: '圣大家电', link: 'https://x/f/tok', label: '空调维修' }],
    [SMS_SCENE.PROGRESS_LINK, { ticket_no: 'FW20261014-0001', link: 'https://x/p/tok' }],
  ];
  for (const [scene, params] of scenarios) {
    const text = renderSmsPreview(scene, params, FAKE_SIGN);
    const signCount = (text.match(/【[^】]*】/g) ?? []).length;
    ok(
      `场景 ${String(scene).padEnd(32)} 正文以签名开头且签名**只出现一次**`,
      text.startsWith('【') && signCount === 1 && !/【\s*】/.test(text),
      `【】数量=${signCount} · ${text.slice(0, 46)}…`,
    );
    // 参数必须真的被替换进去（没有残留 {var}）
    ok(`场景 ${String(scene).padEnd(32)} 无未替换的 {变量} 残留`, !/\{\w+\}/.test(text), `残留=${(text.match(/\{\w+\}/g) ?? []).join(',') || '无'}`);
  }

  // 与用户指定的首条文案对齐（变量名一致）
  const plText = renderSmsPreview(SMS_SCENE.PROGRESS_LINK, { ticket_no: 'FW20261014-0088', link: 'https://x/p/abc' }, FAKE_SIGN);
  ok(
    'PROGRESS_LINK 正文与拟报备文案一致（仅签名括号按官方要求为【】）',
    plText === `【${FAKE_SIGN}】您的售后申请已提交，工单号FW20261014-0088。查看处理进度：https://x/p/abc`,
    plText,
  );
}

// ===========================================================================
// ③ GET 接口的参数形态（含敏感值不落日志）
// ===========================================================================
console.log('\n── ③ 请求参数形态与日志安全 ────────────────────────────');
{
  let seenUrl = '';
  let seenMethod = '';
  let seenRedirect = '';
  const { provider, logger } = makeProvider(async (url, init) => {
    seenUrl = String(url);
    seenMethod = String(init?.method ?? '');
    seenRedirect = String(init?.redirect ?? '');
    return new Response('0', { status: 200 });
  });
  const r = await provider.send(req(SMS_SCENE.PROGRESS_LINK, { ticket_no: 'FW20261014-0088', link: 'https://192.168.0.167/p/abcDEF' }));
  const u = new URL(seenUrl);
  ok('使用 **HTTPS** 且指向官方发送接口', u.protocol === 'https:' && u.host === 'api.smsbao.com' && u.pathname === '/sms', `${u.origin}${u.pathname}`);
  ok('方法是 **GET**', seenMethod === 'GET', seenMethod);
  ok('**不跟随重定向**（避免凭据被转发到第三方）', seenRedirect === 'error', `redirect=${seenRedirect}`);
  ok('参数含 u / p / m / c / f=json', ['u', 'p', 'm', 'c', 'f'].every((k) => u.searchParams.has(k)), [...u.searchParams.keys()].join(','));
  ok('`c` 即**完整正文**（含工单号与进度链接），不是模板 CODE', /FW20261014-0088/.test(u.searchParams.get('c') ?? '') && /\/p\/abcDEF/.test(u.searchParams.get('c') ?? ''), '正文含工单号与短链');
  ok('未配置专用产品时不带 `g`', !u.searchParams.has('g'), u.searchParams.has('g') ? '带了 g' : '未带 g');
  ok('🔴 **日志里不含** ApiKey / 手机号 / 完整 URL', !logger.lines.some((l) => l.includes(FAKE_KEY) || l.includes(MOBILE) || l.includes('api.smsbao.com')), `${logger.lines.length} 行日志`);
}

// ===========================================================================
// ④ 配置缺失 ⇒ 不得误触发真实发送
// ===========================================================================
console.log('\n── ④ 配置缺失时的行为 ──────────────────────────────────');
{
  const { provider } = makeProvider(textReply('0'));
  const bare = createSmsProvider('smsbao', { env: {}, fetchFn: textReply('0'), logger: makeLogger() });
  ok('未配置任何短信宝凭据 ⇒ configured=false', bare.configured === false, `configured=${bare.configured}`);
  const r = await bare.send(req(SMS_SCENE.PROGRESS_LINK, { ticket_no: 'FW1', link: 'https://x/p/t' }));
  ok('配置缺失时发送被拒且给出 SMS_PROVIDER_NOT_CONFIGURED', r.accepted === false && r.errorCode === 'SMS_PROVIDER_NOT_CONFIGURED', `code=${r.errorCode}`);
  ok('（对照）配置齐备时 configured=true', provider.configured === true);
}

// ===========================================================================
// ⑤ 未知通道仍"响亮失败"（不静默回退 mock）
// ===========================================================================
{
  const unknown = createSmsProvider('not-a-provider', { env: ENV, fetchFn: textReply('0'), logger: makeLogger() });
  const r = await unknown.send(req(SMS_SCENE.PROGRESS_LINK, { ticket_no: 'FW1', link: 'https://x/p/t' }));
  ok(
    '未知通道 ⇒ rejected（SMS_PROVIDER_NOT_IMPLEMENTED），**不静默回退 mock**',
    r.accepted === false && r.errorCode === 'SMS_PROVIDER_NOT_IMPLEMENTED',
    `code=${r.errorCode}`,
  );
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
const passed = checks.filter((c) => c.pass).length;
console.log(`  短信宝 provider 验收：${passed}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════');
if (passed < checks.length) {
  for (const c of checks.filter((x) => !x.pass)) console.log(`  ❌ ${c.name}`);
  process.exitCode = 1;
} else {
  console.log('  ✅ 全部通过（**未发送任何真实短信**：HTTP 层全部是注入的 fake fetch）');
}
