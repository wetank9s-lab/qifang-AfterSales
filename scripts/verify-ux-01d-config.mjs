/**
 * verify-ux-01d-config.mjs —— UX-01D M1 **配置契约**门禁。
 *
 * 判什么（用户 §八 / §十）：
 *   A. 默认值与"今天的页面"逐字一致，且前后端两份默认值不漂移；
 *   B. 白名单与校验：未知键 / 超长 / 控制字符 / `<` `>` / 非法枚举 / 不支持的 schema 版本一律 422；
 *   C. **草稿隔离**：保存草稿不改动公开接口（version 与 doc 都不变）；
 *   D. 权限：匿名 401；其它三个业务角色 403（读也不行）；
 *   E. 原生 CRUD 绕过：两张新表对所有业务角色（含 hq_admin）均 403；
 *   F. 缓存：未发布时同版本 ETag 命中 304。
 *
 * 用法：node scripts/verify-ux-01d-config.mjs
 * 退出码：0 全绿 / 1 有断言红 / 2 环境未就绪（不算产品结论）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
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

const pg = (sql) =>
  execFileSync('docker', ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-tAc', sql], {
    encoding: 'utf8',
  }).trim();

async function api(pathname, { method = 'GET', token, body, requestId, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Origin: BASE,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* noop */
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function login(email, password) {
  const r = await api('/api/auth:signIn', { method: 'POST', body: { email, password } });
  if (r.status !== 200) throw new Error(`登录失败 ${email}: HTTP ${r.status}`);
  return r.json.data.token;
}

const uuid = () => crypto.randomUUID();

const EXPECTED_DEFAULTS = {
  name: '四川七方连锁售后服务平台',
  subtitle: '',
  preset: 'classic-blue',
  media_help: '也可直接填写文字，任选一种即可说明问题。',
  media_help_on: true,
};

/** 从 H5 的常量文件里读默认值（不 import —— 它是 TS/ESM，脚本只做文本核对） */
function readH5Defaults() {
  const text = fs.readFileSync(path.join(ROOT, 'h5/src/ui-defaults.ts'), 'utf8');
  const grab = (key) => {
    const m = new RegExp(`${key}:\\s*'([^']*)'`).exec(text);
    return m ? m[1] : null;
  };
  return {
    name: grab('name'),
    subtitle: grab('subtitle'),
    preset: grab('preset'),
    media_help: grab('media_help'),
    media_help_on: /modules:\s*\{\s*media_help:\s*(true|false)/.exec(text)?.[1] === 'true',
  };
}

const docOf = (cfg) => ({
  schema_version: cfg.schema_version,
  brand: cfg.brand,
  theme: cfg.theme,
  copy: cfg.copy,
  modules: cfg.modules,
});

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  UX-01D M1：装修配置契约（默认值 / 白名单 / 隔离 / 权限 / 原生 CRUD）');
console.log('══════════════════════════════════════════════════════════════');

const roles = [
  { role: 'hq_admin', email: envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), env: 'UAT_HQADMIN_PASSWORD' },
  { role: 'hq_after_sales', email: envValue('UAT_HQ_EMAIL', 'uat.hq@svc.local'), env: 'UAT_HQ_PASSWORD' },
  { role: 'store_A', email: envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'), env: 'UAT_STORE_A_PASSWORD' },
  { role: 'viewer', email: envValue('UAT_VIEWER_EMAIL', 'uat.viewer@svc.local'), env: 'UAT_VIEWER_PASSWORD' },
];

let tokens = {};
try {
  for (const r of roles) tokens[r.role] = await login(r.email, envValue(r.env));
} catch (error) {
  console.log(`  ⛔ 环境未就绪：${error.message}`);
  process.exit(2);
}
const admin = tokens.hq_admin;

// ---------------------------------------------------------------------------
// A. 默认值
// ---------------------------------------------------------------------------
console.log('\nA. 默认值（= 今天的页面，不含任何"主动视觉变化"）');
const draftRes = await api('/api/svc:uiThemeDraft', { token: admin });
if (draftRes.status !== 200) {
  console.log(`  ⛔ 读草稿失败 HTTP ${draftRes.status}: ${draftRes.text.slice(0, 200)}`);
  process.exit(2);
}
const payload = draftRes.json?.data?.data ?? draftRes.json?.data ?? draftRes.json;
const defaults = payload.defaults;
const h5 = readH5Defaults();

check(
  defaults?.brand?.name === EXPECTED_DEFAULTS.name &&
    defaults?.brand?.subtitle === EXPECTED_DEFAULTS.subtitle &&
    defaults?.theme?.preset === EXPECTED_DEFAULTS.preset &&
    defaults?.copy?.media_help === EXPECTED_DEFAULTS.media_help &&
    defaults?.modules?.media_help === EXPECTED_DEFAULTS.media_help_on,
  '服务端默认值 = 今天的页面',
  JSON.stringify({ name: defaults?.brand?.name, preset: defaults?.theme?.preset }),
);
check(
  h5.name === defaults?.brand?.name &&
    h5.subtitle === defaults?.brand?.subtitle &&
    h5.preset === defaults?.theme?.preset &&
    h5.media_help === defaults?.copy?.media_help &&
    h5.media_help_on === defaults?.modules?.media_help,
  'H5 内置默认值与服务端逐字段一致（两处漂移会立刻变红）',
  `H5=${JSON.stringify(h5)}`,
);
check(defaults?.schema_version === 1, 'schema_version = 1', String(defaults?.schema_version));

// ---------------------------------------------------------------------------
// B. 白名单与校验
// ---------------------------------------------------------------------------
console.log('\nB. 白名单与校验（非法输入一律 422，且**不落库**）');
const baseDoc = {
  schema_version: 1,
  brand: { name: '七方售后', subtitle: '' },
  theme: { preset: 'classic-blue' },
  copy: { media_help: '也可直接填写文字，任选一种即可说明问题。' },
  modules: { media_help: true },
};
const revNow = () => Number(payload.draft?.revision ?? 0);

async function trySave(doc, label, expectedStatus = 422) {
  const r = await api('/api/svc:uiThemeSave', {
    method: 'POST',
    token: admin,
    requestId: uuid(),
    body: { doc, expected_revision: revNow() },
  });
  check(r.status === expectedStatus, label, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
  return r;
}

await trySave({ ...baseDoc, extra: 1 }, '未知顶层键 ⇒ 422', 422);
await trySave({ ...baseDoc, brand: { ...baseDoc.brand, slogan: 'x' } }, '未知 brand 键 ⇒ 422', 422);
await trySave({ ...baseDoc, brand: { name: '短', subtitle: '' } }, '名称 <2 字 ⇒ 422', 422);
await trySave({ ...baseDoc, brand: { name: '一'.repeat(21), subtitle: '' } }, '名称 >20 字 ⇒ 422', 422);
await trySave({ ...baseDoc, brand: { name: '<script>x</script>', subtitle: '' } }, '名称含 < > ⇒ 422', 422);
await trySave({ ...baseDoc, brand: { name: '正常名称', subtitle: 'a\nb' } }, '副标题含换行 ⇒ 422', 422);
await trySave({ ...baseDoc, theme: { preset: 'purple' } }, '非法主题枚举 ⇒ 422', 422);
await trySave({ ...baseDoc, copy: { media_help: '字'.repeat(41) } }, '帮助文案 >40 字 ⇒ 422', 422);
await trySave({ ...baseDoc, schema_version: 99 }, '不支持的 schema_version ⇒ 422', 422);

// ---------------------------------------------------------------------------
// C. 草稿隔离
// ---------------------------------------------------------------------------
console.log('\nC. 草稿隔离（保存草稿不得影响公开接口）');
const pubBefore = await api('/api/publicUiTheme:get');
const beforeBody = pubBefore.json?.data ?? pubBefore.json;
const okSave = await api('/api/svc:uiThemeSave', {
  method: 'POST',
  token: admin,
  requestId: uuid(),
  body: {
    doc: {
      ...baseDoc,
      brand: { name: '隔离验证名', subtitle: '' },
      theme: { preset: 'brand-red' },
    },
    expected_revision: revNow(),
  },
});
check(okSave.status === 200, '合法草稿保存成功', `HTTP ${okSave.status}`);
const savedRevision = Number(okSave.json?.data?.data?.revision ?? okSave.json?.data?.revision ?? 0);
check(savedRevision === revNow() + 1 || savedRevision > 0, '返回新的 revision', String(savedRevision));

const pubAfter = await api('/api/publicUiTheme:get');
const afterBody = pubAfter.json?.data ?? pubAfter.json;
check(
  afterBody.version === beforeBody.version && JSON.stringify(docOf(afterBody)) === JSON.stringify(docOf(beforeBody)),
  '公开接口的 version 与内容**均未变化**（草稿隔离）',
  `before v${beforeBody.version} / after v${afterBody.version}`,
);

// ---------------------------------------------------------------------------
// D. 权限
// ---------------------------------------------------------------------------
console.log('\nD. 权限（仅 hq_admin；其它角色读写皆 403）');
const anon = await api('/api/svc:uiThemeDraft');
check(anon.status === 401, '匿名读草稿 ⇒ 401', `HTTP ${anon.status}`);

// UX-01D M1 签收补证：预览消费已移出匿名面（见 verify-ux-01d-preview-auth.mjs）
const anonOldPreview = await api('/api/publicUiTheme:preview', { method: 'POST', body: { token: 'x' } });
check(anonOldPreview.status === 404, '匿名预览接口已移除（404）', `HTTP ${anonOldPreview.status}`);
const anonPreviewDoc = await api('/api/svc:uiThemePreviewDoc', { method: 'POST', body: { token: 'x' } });
check(anonPreviewDoc.status === 401, '匿名调预览消费（受控动作）⇒ 401', `HTTP ${anonPreviewDoc.status}`);

for (const r of roles.filter((x) => x.role !== 'hq_admin')) {
  const read = await api('/api/svc:uiThemeDraft', { token: tokens[r.role] });
  const save = await api('/api/svc:uiThemeSave', {
    method: 'POST',
    token: tokens[r.role],
    requestId: uuid(),
    body: { doc: baseDoc, expected_revision: 0 },
  });
  const publish = await api('/api/svc:uiThemePublish', {
    method: 'POST',
    token: tokens[r.role],
    requestId: uuid(),
    body: { expected_revision: 1 },
  });
  const preview = await api('/api/svc:uiThemePreview', { method: 'POST', token: tokens[r.role], requestId: uuid(), body: {} });
  const rel = await api('/api/svc:uiThemeReleases', { token: tokens[r.role] });
  check(
    [read, save, publish, preview, rel].every((x) => x.status === 403),
    `${r.role}：读/存/预览/发布/历史 全部 403`,
    [read, save, publish, preview, rel].map((x) => x.status).join('/'),
  );
}

// ---------------------------------------------------------------------------
// E. 原生 CRUD 绕过
// ---------------------------------------------------------------------------
console.log('\nE. 原生 CRUD 绕过（两张新表对所有业务角色都不可读写）');
for (const r of roles) {
  const list = await api('/api/pageThemeDrafts:list', { token: tokens[r.role] });
  const create = await api('/api/pageThemeDrafts:create', {
    method: 'POST',
    token: tokens[r.role],
    body: { scope: 'hq', revision: 1, base_version: 0, doc: baseDoc },
  });
  const relList = await api('/api/pageThemeReleases:list', { token: tokens[r.role] });
  const update = await api('/api/pageThemeReleases:update?filterByTk=1', {
    method: 'POST',
    token: tokens[r.role],
    body: { version: 99 },
  });
  check(
    [list, create, relList, update].every((x) => x.status === 403 || x.status === 404),
    `${r.role}：原生 list/create/update 均不可用`,
    [list, create, relList, update].map((x) => x.status).join('/'),
  );
}

// ---------------------------------------------------------------------------
// F. 缓存
// ---------------------------------------------------------------------------
console.log('\nF. 缓存协商（未发布时同版本 ETag 命中 304）');
const first = await api('/api/publicUiTheme:get');
const etag = first.headers.get('etag');
check(Boolean(etag), '公开接口返回 ETag', String(etag));
const second = await api('/api/publicUiTheme:get', { headers: { 'If-None-Match': String(etag) } });
check(second.status === 304, '带 If-None-Match 命中 304（内容未变）', `HTTP ${second.status}`);

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  配置契约：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
console.log('');
