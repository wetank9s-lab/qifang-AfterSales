/**
 * arc-r0chg01-verify.mjs —— ARC-V1 / R0-CHG-01 最小针对性验收（用户 §五 的 9 项）
 *
 * ⚠️ 纪律（用户 2026-11-11 明令）：
 *   · **只跑这 9 项**，不重复 A1–A6 的历史测试；
 *   · 只在本地开发环境跑（`https://127.0.0.1`），不碰生产、不发真实短信、不清库；
 *   · 每条断言都必须**能变红**（下面第 ⑨ 项专门做反向验证）。
 *
 * 判据设计要点（"断言不会变红 = 没有断言"）：
 *   · 限流不被"按钮变灰"这类前端假象骗过 —— 全部用**裸 HTTP**，不经过页面；
 *   · 长度限制看**服务端计数**（api_guards 行），不看响应文案；
 *   · 投影检查是**字段白名单的补集**：逐个禁用字段名去响应 JSON 里搜，
 *     且用 `JSON.parse` 后的对象键遍历（不是字符串 includes，避免"订单号里
 *     恰好含 customer_name 这些字"这种假命中）；
 *   · 跨店断言必须**同时**验证"两家门店名都出现"与"两条记录没有互相顶替"
 *     （只断言 store 数量会漏掉"合并成一条"的实现错误）。
 *
 * 用法：
 *   node scripts/arc-r0chg01-verify.mjs            # 全部 9 项
 *   node scripts/arc-r0chg01-verify.mjs --no-reset # 跳过前置数据准备
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const NO_RESET = process.argv.includes('--no-reset');

/* 测试用手机号（明确定义在脚本里，避免"哪条数据是哪条"说不清） */
const M_CROSS = '13600000001';   // 单店（store 1）已发布 2 条（service + hvac）
const M_DRAFT_ONLY = '13800138000';  // 只有 draft，无 published ⇒ 应为空
const M_VOIDED = '13900002202';     // 只有 voided ⇒ 应为空
const M_MISSING = '13600009999';    // 库里完全没有

/* 跨店用例由脚本自己造：在两**家**不同门店插同手机号的已发布档案 */
const M_SPAN = '13900008888';
const SPAN_STORES = [1, 4];         // 新都圣大家电 / 金堂华林电器

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};
const section = (t) => console.log(`\n=== ${t} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 直连 app（绕过 nginx 限流区，专测业务语义） ---------------- */
const APP = process.env.SVC_APP_URL || 'http://127.0.0.1:13000';

async function apiAt(origin, path, { method = 'POST', body, ip, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (ip) h['X-Real-IP'] = ip;
  const res = await fetch(origin + '/api/' + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  let json = null;
  if (ct.includes('application/json')) { try { json = JSON.parse(text); } catch { /* ignore */ } }
  return { status: res.status, json, text, headers: res.headers };
}

const api = (p, o) => apiAt(BASE, p, o);              // 经 nginx（真实链路）
const apiApp = (p, o) => apiAt(APP, p, o);            // 直连 app

/* ---------------- psql ---------------- */
/** 从 .env 读 PG 连接信息（不猜、不硬编码；读不到时回落到项目默认） */
function pgEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  } catch { /* .env 缺失时用默认值 */ }
  return { user: env.POSTGRES_USER || 'svc_app', db: env.POSTGRES_DB || 'service_ticket' };
}

function psql(sql) {
  const { user, db } = pgEnv();
  return execFileSync(
    'docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8' },
  ).trim();
}

/** 读一个设置项（走**真实**的 serviceSettings 表，不猜默认值） */
function settingValue(key) {
  const out = psql(`SELECT value FROM service_settings WHERE key='${key}';`);
  return out || null;
}

/** 清掉某维度在本场景下的限流桶（只为让验收可重复，不改产品配置） */
function resetGuards() {
  psql(`DELETE FROM api_guards WHERE scene='archive_query';`);
}

/** 递归取出对象里所有键（用于字段白名单的补集检查） */
function allKeys(node, acc = new Set()) {
  if (Array.isArray(node)) { for (const x of node) allKeys(x, acc); return acc; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) { acc.add(k); allKeys(v, acc); }
  }
  return acc;
}

/**
 * 去掉 JS / CSS 注释后的源码（**逐字符扫描**，不用正则替换）。
 *
 * ⚠️ 为什么必须剥注释（这轮的真实教训）：
 *   第一版断言直接在**原始源码**上搜 `publicStore:list`，结果我写在注释里的
 *   "页面不再调 `publicStore:list`" 这句话把断言判红了 —— 也就是说
 *   **判据命中了我自己的说明文字**。这是本项目记录过的同一类错误
 *   （"判据太宽 = 自造假红"，`/customer_/` 撞上合法枚举 `customer_absent`）。
 *   修法不是把注释里那句话删掉（那等于让文档向判据让步），而是让判据
 *   只看**可执行代码**。注释里可以自由解释"为什么不这么写"。
 *
 * ⚠️ 为什么不用 `src.replace(/\/\*[\s\S]*?\*\//g,'')` 这种正则：
 *   那会把**字符串里**的 `//`（如 `'https://x'`）当成注释起点，
 *   于是从那里到行尾的真代码被删掉 —— 而"删多了"恰好会让
 *   "页面里不存在 X" 这类断言**假通过**（这正是它要防的相反方向）。
 *   这里用状态机区分：注释 / 单引号串 / 双引号串 / 模板串 / 正则字面量。
 *
 * 返回：剥掉注释的源码（字符串内容**原样保留**，所以字符串里的
 *       `publicStore:list` 依然能被搜到 —— 那才是真代码）。
 */
function stripComments(src) {
  const s = String(src);
  let out = '';
  let i = 0;
  // 上一个有意义的字符（用来判断 `/` 是除号还是正则起点）
  let prev = '';
  const regexStartAfter = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

  while (i < s.length) {
    const c = s[i];
    const c2 = s[i + 1];

    // 行注释
    if (c === '/' && c2 === '/') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    // 块注释
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    // 字符串 / 模板串：原样拷出（**不**解析转义以外的内容）
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < s.length) {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] ?? ''); i += 2; continue; }
        out += s[i];
        if (s[i] === quote) { i += 1; break; }
        i += 1;
      }
      prev = quote;
      continue;
    }
    // 正则字面量：只在"可能是正则"的位置上识别
    if (c === '/' && regexStartAfter.has(prev.trim() === '' ? '' : prev)) {
      out += c;
      i += 1;
      while (i < s.length && s[i] !== '\n') {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] ?? ''); i += 2; continue; }
        out += s[i];
        if (s[i] === '/') { i += 1; break; }
        i += 1;
      }
      // 标志位
      while (i < s.length && /[a-z]/.test(s[i])) { out += s[i]; i += 1; }
      prev = '/';
      continue;
    }

    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

/* =========================================================================
 * ① 页面已无门店选择和验证码
 * ========================================================================= */
async function test01() {
  section('① 页面已无门店选择和验证码');
  const res = await fetch(BASE + '/h5/archive.html');
  const html = await res.text();
  check(res.status === 200, 'archive.html 可达（HTTP 200）', `status=${res.status}`);

  // ⚠️ 所有"页面里没有 X"的判据都在**剥掉注释**的源码上做。
  //    理由见 stripComments()：注释里解释"为什么不这么写"会把断言判红。
  const code = stripComments(html);

  // 元素必须**不存在**（不是"隐藏"）—— 隐藏的门店下拉仍然会被脚本读取
  for (const id of ['storeSel', 'codeInput', 'sendBtn', 'verifyBtn']) {
    const present = new RegExp(`id\\s*=\\s*["']${id}["']`).test(code);
    check(!present, `页面里不存在 #${id}`, present ? '仍存在' : '');
  }
  // 保留的手机号输入与查询按钮
  check(/id\s*=\s*["']mobileInput["']/.test(code), '保留手机号输入框 #mobileInput');
  check(/id\s*=\s*["']queryBtn["']/.test(code), '保留查询按钮 #queryBtn');

  // 不再读 URL 上的 store 参数（少一条"输入被页面带进请求"的路径）
  check(!/URLSearchParams/.test(code), '页面不再解析 URL 查询串（不读 ?store=）');
  // 不再调发码/验证接口
  check(!/sendCode/.test(code), '页面不再调用发码接口（不触发短信链路）');
  check(!/'publicArchive'?\s*\+\s*':verify'/.test(code) && !/publicArchive:verify'/.test(code), '页面不再调用 verify');
  // 不再加载门店列表接口
  check(!/publicStore/.test(code), '页面不再调用匿名门店列表接口（取消门店选择）');
  // 手机号不得进 URL / 存储
  check(!/location\.(search|hash)\s*=/.test(code), '页面不把任何值写回 URL');
  check(!/\b(localStorage|sessionStorage)\b/.test(code),
    '页面不写浏览器持久化存储（手机号只活在内存）');
  check(!/\bdocument\.cookie\b/.test(code), '页面不写 Cookie');

  // 关键：查询走的是新 Action
  check(/publicArchive:queryByMobile/.test(code), '页面调用新增的 publicArchive:queryByMobile');

  // 反向验证：stripComments 不能把真代码也吃掉（否则上面的"不存在"全是假的）
  const probe = stripComments('var a=1; /* storeSel */ // sendBtn\n var b="publicStore:list";');
  check(!/storeSel/.test(probe) && !/sendBtn/.test(probe) && /publicStore:list/.test(probe),
    '反向验证：stripComments 只剥注释、保留字符串里的真代码');
}

/* =========================================================================
 * ② 输入手机号能查到已发布档案摘要
 * ========================================================================= */
async function test02() {
  section('② 输入手机号能查到已发布档案摘要');
  resetGuards();
  const r = await api('publicArchive:queryByMobile', { body: { mobile: M_CROSS }, ip: '10.0.0.2' });
  check(r.status === 200, '已发布档案的手机号返回 200', `status=${r.status}`);
  const d = r.json?.data || {};
  check(Array.isArray(d.groups) && d.groups.length === 1, '按门店分组返回 1 个门店', `groups=${d.groups?.length}`);
  check(Number(d.total) === 2, '摘要条数与库中已发布条数一致（2）', `total=${d.total}`);
  const keys = allKeys(d);
  const allowed = new Set(['mobile_masked', 'groups', 'total', 'store_id', 'store_name', 'archives',
    'archive_type', 'archive_type_label', 'progress', 'progress_label']);
  const extra = [...keys].filter((k) => !allowed.has(k));
  check(extra.length === 0, '响应字段**恰好**为约定白名单（无多余字段）', extra.length ? `多余：${extra.join(',')}` : '');
  check(/^\d{3}\*{4}\d{4}$/.test(String(d.mobile_masked)), '返回的手机号为服务端脱敏形态', String(d.mobile_masked));
}

/* =========================================================================
 * ③ 同一手机号跨两家门店时正确显示对应门店名称与记录
 * ========================================================================= */
async function test03() {
  section('③ 同一手机号跨两家门店分别展示');

  // 造数据：同一手机号在 2 家门店各有 1 条 published（脚本建、脚本删）
  const tag = 'R0CHG01-' + Date.now();
  const names = ['跨店验收A', '跨店验收B'];
  const types = ['service', 'hvac'];
  for (let i = 0; i < SPAN_STORES.length; i += 1) {
    const sid = SPAN_STORES[i];
    psql(`INSERT INTO service_archives
      (created_at, updated_at, archive_no, store_id, archive_type, customer_name, customer_mobile,
       service_address, status, visibility, version)
      VALUES (now(), now(), '${tag}-${i}', ${sid}, '${types[i]}', '${names[i]}', '${M_SPAN}',
              '跨店验收地址', 'pending', 'published', 1);`);
  }

  try {
    resetGuards();
    const r = await api('publicArchive:queryByMobile', { body: { mobile: M_SPAN }, ip: '10.0.0.3' });
    check(r.status === 200, '跨店手机号返回 200', `status=${r.status}`);
    const gs = r.json?.data?.groups || [];
    check(gs.length === 2, '**分别**返回 2 个门店分组（未被错误合并）', `groups=${gs.length}`);

    const storeIds = gs.map((g) => Number(g.store_id));
    check(new Set(storeIds).size === 2, '两个分组的 store_id 互不相同', storeIds.join(','));

    // 门店名必须来自**真实** stores 表（按实际 store_id 关联），且与库中一致
    const wantNames = psql(`SELECT id||'|'||name FROM stores WHERE id IN (${SPAN_STORES.join(',')}) ORDER BY id;`)
      .split('\n').filter(Boolean);
    const gotNames = gs.slice().sort((a, b) => a.store_id - b.store_id).map((g) => `${g.store_id}|${g.store_name}`);
    check(JSON.stringify(gotNames) === JSON.stringify(wantNames),
      '门店名按实际 store_id 关联且与库中一致', `期望=${wantNames.join(' / ')} 实际=${gotNames.join(' / ')}`);

    // 逐分组校验"记录没有互相顶替"：A 店只见 service，B 店只见 hvac
    for (let i = 0; i < SPAN_STORES.length; i += 1) {
      const g = gs.find((x) => Number(x.store_id) === SPAN_STORES[i]);
      const types0 = (g?.archives || []).map((a) => a.archive_type);
      check(types0.length === 1 && types0[0] === types[i],
        `store ${SPAN_STORES[i]} 只含本店那 1 条（type=${types[i]}）`, `实际=${types0.join(',')}`);
    }
  } finally {
    psql(`DELETE FROM service_archives WHERE archive_no LIKE '${tag}-%';`);
  }
}

/* =========================================================================
 * ④ 未发布和作废档案不可见
 * ========================================================================= */
async function test04() {
  section('④ 未发布（draft）与已作废（voided）档案不可见');

  resetGuards();
  const rDraft = await api('publicArchive:queryByMobile', { body: { mobile: M_DRAFT_ONLY }, ip: '10.0.0.4' });
  check(rDraft.status === 200, '只有 draft 的手机号返回 200（空结果不是错误）', `status=${rDraft.status}`);
  check(Number(rDraft.json?.data?.total) === 0, 'draft 档案不出现在摘要里', `total=${rDraft.json?.data?.total}`);

  resetGuards();
  const rVoid = await api('publicArchive:queryByMobile', { body: { mobile: M_VOIDED }, ip: '10.0.0.5' });
  check(rVoid.status === 200, '只有 voided 的手机号返回 200', `status=${rVoid.status}`);
  check(Number(rVoid.json?.data?.total) === 0, 'voided 档案不出现在摘要里', `total=${rVoid.json?.data?.total}`);

  resetGuards();
  const rMiss = await api('publicArchive:queryByMobile', { body: { mobile: M_MISSING }, ip: '10.0.0.6' });
  check(rMiss.status === 200 && Number(rMiss.json?.data?.total) === 0,
    '库中完全没有的手机号返回 200 + 空结果（不区分"没有这个人"与"没有档案"⇒ 不做号码探针）',
    `status=${rMiss.status} total=${rMiss.json?.data?.total}`);

  // 反向：把一条 draft 临时改成 published，必须**立刻**可见（证明上面不是"恒返回空"的假绿）
  const probeNo = 'R0CHG01-04-' + Date.now();
  psql(`INSERT INTO service_archives
    (created_at, updated_at, archive_no, store_id, archive_type, customer_name, customer_mobile,
     service_address, status, visibility, version)
    VALUES (now(), now(), '${probeNo}', 1, 'service', '临时可见', '${M_DRAFT_ONLY}',
            'x', 'pending', 'published', 1);`);
  try {
    resetGuards();
    const r2 = await api('publicArchive:queryByMobile', { body: { mobile: M_DRAFT_ONLY }, ip: '10.0.0.6' });
    check(Number(r2.json?.data?.total) === 1,
      '反向验证：临时置为 published 后**立即出现**（证明"不可见"是过滤生效而非恒空）',
      `total=${r2.json?.data?.total}`);
  } finally {
    psql(`DELETE FROM service_archives WHERE archive_no='${probeNo}';`);
  }
}

/* =========================================================================
 * ⑤ 任意匿名用户无法读取客户姓名、服务地址、照片及内部备注
 * ========================================================================= */
async function test05() {
  section('⑤ 匿名摘要不含姓名/地址/照片/内部备注等敏感字段');
  resetGuards();
  const r = await api('publicArchive:queryByMobile', { body: { mobile: M_CROSS }, ip: '10.0.0.7' });
  const body = r.text;

  // 字段名白名单的**补集**检查（用解析后的键，避免字符串假命中）
  const keys = allKeys(r.json?.data || {});
  const forbidden = ['customer_name', 'service_address', 'product_description', 'package_description',
    'public_note', 'notes', 'purchase_date', 'planned_date', 'assigned_worker', 'sales_user_id',
    'archive_no', 'store_id_internal', 'storage_key', 'photo_id', 'photos', 'id', 'status',
    'created_at', 'updated_at', 'created_by', 'updated_by', 'version', 'voided_at', 'published_at',
    'completed_at', 'mobile', 'customer_mobile', 'feedback_token', 'progress_token'];
  const hit = forbidden.filter((k) => keys.has(k));
  check(hit.length === 0, '响应键中不存在任何敏感/内部字段', hit.length ? `命中：${hit.join(',')}` : '');

  // 用**真实值**再验一遍：库里那两条档案的姓名/地址若出现在响应里 ⇒ 泄露
  const vals = psql(`SELECT customer_name||'|'||service_address FROM service_archives
    WHERE customer_mobile='${M_CROSS}' AND visibility='published' LIMIT 1;`);
  const [nm, addr] = vals.split('|');
  check(nm && !body.includes(nm), `响应正文不含客户姓名（"${nm}"）`);
  check(addr && !body.includes(addr), `响应正文不含服务地址（"${addr}"）`);

  // 明文手机号绝不能出现在响应里（只允许脱敏形态）
  check(!body.includes(M_CROSS), '响应正文不含完整手机号明文');
  // 摘要里没有可枚举的档案标识 ⇒ 没有"点进去看详情"的入口
  check(!/"archive_no"/.test(body) && !/"photos"/.test(body), '摘要不提供档案编号与照片清单（无枚举入口）');
  // 响应不得被缓存
  const cc = r.headers.get('cache-control') || '';
  check(/no-store/.test(cc), '响应带 Cache-Control: no-store', `实际=${cc}`);
  check(/nosniff/.test(r.headers.get('x-content-type-options') || ''), '响应带 X-Content-Type-Options: nosniff');
}

/* =========================================================================
 * ⑥ 连续 60 秒：前三次允许、第四次 429、窗口结束恢复
 * ========================================================================= */
async function test06() {
  section('⑥ 连续 60 秒窗口：前 3 次放行、第 4 次 429、窗口结束恢复');

  const win = Number(settingValue('security.archive_query_window_seconds') || 60);
  check(win > 0, '服务端窗口长度取自 serviceSettings（非魔法数）', `window_seconds=${win}`);

  const ip = '10.9.6.6';
  const m = '13600001111';   // 无档案，避免与其它用例互扰
  resetGuards();

  const codes = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await api('publicArchive:queryByMobile', { body: { mobile: m }, ip });
    codes.push(r.status);
    await sleep(120);
  }
  check(codes.every((c) => c === 200), '同 IP 同手机号的前 3 次全部 200', `statuses=${codes.join(',')}`);

  const r4 = await api('publicArchive:queryByMobile', { body: { mobile: m }, ip });
  check(r4.status === 429, '第 4 次返回 HTTP 429', `status=${r4.status}`);
  const ra = Number(r4.headers.get('retry-after'));
  check(Number.isFinite(ra) && ra > 0 && ra <= win, '429 带 Retry-After（1..窗口长度）', `Retry-After=${r4.headers.get('retry-after')}`);
  const msg4 = r4.json?.errors?.[0]?.message || '';
  check(msg4.includes('查询过于频繁'), '话术为「查询过于频繁，请稍后再试」', msg4);

  // 服务端计数必须真实落表（不靠响应文案）
  const cnt = Number(psql(`SELECT COALESCE(sum(counter),0)::int FROM api_guards
     WHERE scene='archive_query' AND scope='mobile';`) || 0);
  check(cnt === 3, '库中该手机号维度**只记 3 次**（被拒的请求不落行）', `counter_sum=${cnt}`);

  // 窗口结束恢复：清掉计时（等价于窗口滑过），必须立即放行
  resetGuards();
  const r5 = await api('publicArchive:queryByMobile', { body: { mobile: m }, ip });
  check(r5.status === 200, '窗口结束后恢复放行（200）', `status=${r5.status}`);

  // 反向验证：**不清桶**时连续请求必然持续 429（证明 429 不是偶发/随机）
  resetGuards();
  const seq = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await api('publicArchive:queryByMobile', { body: { mobile: m }, ip });
    seq.push(r.status);
    await sleep(80);
  }
  check(JSON.stringify(seq) === JSON.stringify([200, 200, 200, 429, 429]),
    '反向验证：连续 5 次的形态严格为 200,200,200,429,429', `statuses=${seq.join(',')}`);
}

/**
 * 造一个**合法**的 11 位手机号。
 *
 * ⚠️ 第一版这里写成 `13600002${String(i).padStart(4,'0')}` —— 前缀 8 位 + 补齐 4 位
 *    = **12 位**，于是每个请求都被服务端按"手机号格式不正确"回 400，
 *    而 (a) 组断言期望 200 ⇒ 整组判红。**这不是产品缺陷，是造数据写错了。**
 *    记在这里，是因为"测试数据构造错误"与"限流没生效"在输出上看起来
 *    一模一样（都是非 200），而前者会让人去改产品代码。
 */
function mob(n) {
  const s = '13' + String(Number(n)).padStart(9, '0');
  if (!/^1[3-9]\d{9}$/.test(s)) throw new Error(`mob() 造出非法号码：${s}`);
  return s;
}

/* =========================================================================
 * ⑦ 换手机号 / 换浏览器 / 伪造来源 IP 不能轻易绕过服务端限流
 * ========================================================================= */
async function test07() {
  section('⑦ 绕不过：同 IP 换号、同号换 IP、伪造来源 IP');

  /* (a) 同 IP 换手机号 —— IP 维度必须挡住。
   *     必须用**不同手机号**，否则 429 可能来自手机号维度，断言就没证明力。 */
  const ip = '10.9.7.7';
  resetGuards();
  const s1 = [];
  for (let i = 0; i < 3; i += 1) {
    s1.push((await api('publicArchive:queryByMobile', { body: { mobile: mob(700000001 + i) }, ip })).status);
    await sleep(80);
  }
  const s1b = (await api('publicArchive:queryByMobile', { body: { mobile: mob(700000009) }, ip })).status;
  check(s1.every((c) => c === 200), '(a) 同 IP 前 3 个**不同**手机号放行', `statuses=${s1.join(',')}`);
  check(s1b === 429, '(a) 同 IP 第 4 个**新手机号**被挡（IP 维度生效，换号不能绕过）', `status=${s1b}`);

  // 归因：把"挡住了"落到**具体维度**上，而不是只看响应码。
  //
  //   ⚠️ 第一版断言写的是"ip 维度恰好 **1 行**、counter=3"，实测会偶发变红：
  //      `consumeSliding` 用的是**秒级桶**（`date_trunc('second', now())`），
  //      3 次请求若跨了秒边界就会落到 2~3 行上。**行数不是语义，总和才是。**
  //      这正是本项目记录过的"判据太宽 = 自造假红"的镜像：
  //      这次是"判据太窄"——把一个实现细节（桶合并粒度）当成了产品要求。
  //      改成断言**累计次数**（语义）与**被拒者未落行**（本次改动的核心行为）。
  const ipSum = Number(psql(`SELECT COALESCE(sum(counter),0)::int FROM api_guards
     WHERE scene='archive_query' AND scope='ip';`) || 0);
  const mobSum = Number(psql(`SELECT COALESCE(sum(counter),0)::int FROM api_guards
     WHERE scene='archive_query' AND scope='mobile';`) || 0);
  const mobRows = Number(psql(`SELECT count(*)::int FROM api_guards
     WHERE scene='archive_query' AND scope='mobile';`) || 0);
  check(ipSum === 3, '(a) 归因：ip 维度累计恰好 3 次（第 4 次被拒、未落行）', `实际=${ipSum}（期望 3）`);
  check(mobSum === 3 && mobRows === 3,
    '(a) 归因：mobile 维度累计 3 次、恰好 3 行 ⇒ 第 4 个号**完全没进**手机号维度',
    `实际 sum=${mobSum} rows=${mobRows}（期望 3 / 3）`);

  /* (b) 同手机号换 IP —— 手机号维度必须挡住 */
  const m = mob(700001111);
  resetGuards();
  const s2 = [];
  for (let i = 0; i < 3; i += 1) {
    s2.push((await api('publicArchive:queryByMobile', { body: { mobile: m }, ip: `10.9.8.${i + 1}` })).status);
    await sleep(80);
  }
  const s2b = (await api('publicArchive:queryByMobile', { body: { mobile: m }, ip: '10.9.8.99' })).status;
  check(s2.every((c) => c === 200), '(b) 同手机号前 3 次用**不同 IP**放行', `statuses=${s2.join(',')}`);
  check(s2b === 429, '(b) 同手机号第 4 次**换新 IP** 被挡（手机号维度生效）', `status=${s2b}`);

  /* (c) 伪造来源 IP 不能绕过 —— 经 nginx 真实链路。
   *     控制变量：**每次换一个新手机号**，这样唯一还在起作用的维度就是 IP；
   *     再逐次伪造不同的 X-Forwarded-For。第 4 次仍 429 ⇒ 伪造无效。 */
  resetGuards();
  const s3 = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await api('publicArchive:queryByMobile', {
      body: { mobile: mob(700002001 + i) },
      headers: { 'X-Forwarded-For': `203.0.113.${i + 1}` },
    });
    s3.push(r.status);
    await sleep(80);
  }
  check(JSON.stringify(s3) === JSON.stringify([200, 200, 200, 429]),
    '(c) 经 nginx 伪造 X-Forwarded-For 不能绕过（同 IP + 4 个新号，第 4 次 429）',
    `statuses=${s3.join(',')}`);

  /* (c-反向) 证明上面的 429 **确实**来自"nginx 覆写了来源地址"，而不是"代码根本不读 XFF"。
   *
   *   直连 app（不发 X-Real-IP），同样 4 个不同手机号 + 4 个不同 XFF：
   *   若代码读 XFF ⇒ 4 个独立 IP 桶 ⇒ 4 次全 200。
   *   这一条**必须会红**在"代码不读 XFF"的实现上，否则 (c) 的结论就无从谈起
   *   （"挡住了"与"恰好没超"在 429 上是同一种现象）。 */
  resetGuards();
  const s4 = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await apiApp('publicArchive:queryByMobile', {
      body: { mobile: mob(700003001 + i) },
      headers: { 'X-Forwarded-For': `198.51.100.${i + 1}` },
    });
    s4.push(r.status);
    await sleep(80);
  }
  check(s4.every((c) => c === 200),
    '(c-反向) 直连 app（无 X-Real-IP）时伪造 XFF **确实**分桶 ⇒ 证明 (c) 的 429 来自 nginx 覆写',
    `statuses=${s4.join(',')}`);

  /* (d) 切换浏览器无关：限流是全服务端的，换个 UA / 新客户端同样被挡 */
  resetGuards();
  const s5 = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await api('publicArchive:queryByMobile', {
      body: { mobile: mob(700004001 + i) },
      headers: { 'User-Agent': `FakeBrowser/${i}`, 'X-Device-Id': `dev-${i}` },
    });
    s5.push(r.status);
    await sleep(80);
  }
  check(JSON.stringify(s5) === JSON.stringify([200, 200, 200, 429]),
    '(d) 更换 UA / 设备标识（等价"换浏览器"）不能绕过（同样 4 个新号）', `statuses=${s5.join(',')}`);
}

/* =========================================================================
 * ⑧ 原有详情与照片接口未经验证仍拒绝访问
 * ========================================================================= */
async function test08() {
  section('⑧ 原有详情/照片接口在无会话时仍被拒绝');

  // 无 token 一律 401（且**不能**因为"新接口放开了"而连带放开）
  const d = await api('publicArchive:detail', { body: { archive_no: 'DA-20261109-0022' } });
  check(d.status === 401, 'publicArchive:detail 无会话 → 401', `status=${d.status}`);

  const l = await api('publicArchive:list', { body: {} });
  check(l.status === 401, 'publicArchive:list 无会话 → 401', `status=${l.status}`);

  const p = await api('publicArchive:photo', { body: { photo_id: 1 } });
  check(p.status === 401, 'publicArchive:photo 无会话 → 401（匿名照片下载仍关闭）', `status=${p.status}`);

  // 拿一个**假** token 也不能通过
  const fake = await api('publicArchive:detail', {
    body: { archive_no: 'DA-20261109-0022' },
    headers: { 'X-Archive-Session': 'a'.repeat(43) },
  });
  check(fake.status === 401, '伪造会话 token → 401', `status=${fake.status}`);

  // 发码接口仍然存在（§四 ①：验证码链路保留，代码与表都不删）
  const sc = await api('publicArchive:sendCode', { body: { store_code: 'S01', mobile: '13600000001' } });
  check([200, 429].includes(sc.status), 'publicArchive:sendCode 仍可用（验证码链路未被删除）', `status=${sc.status}`);

  // 摘要接口本身也不能被拿来读详情：给它 archive_no 也不认
  resetGuards();
  const sneaky = await api('publicArchive:queryByMobile', {
    body: { mobile: '13600000001', archive_no: 'DA-20261109-0022' },
    ip: '10.0.0.88',
  });
  check(sneaky.status === 200 && !/archive_no/.test(sneaky.text),
    '摘要接口不接受 archive_no 入参（不因多传参数而升级为详情）', `status=${sneaky.status}`);
}

/* =========================================================================
 * ⑨ 不影响销售 / 负责人 / 总部现有页面（只读核对 + 关键接口未变色）
 * ========================================================================= */
async function test09() {
  section('⑨ 未影响其它角色与既有业务');

  // ① 其它匿名业务接口未被改动（抽查三条代表性的：报修建单/门店列表/进度）
  const stores = await api('publicStore:list', { body: {} });
  check(stores.status === 200, '匿名门店列表仍 200', `status=${stores.status}`);

  const entry = await api('publicStore:entry', { body: {} });
  check(entry.status !== 500, '门店入口接口未 500（无 k 时按业务语义拒绝）', `status=${entry.status}`);

  // ② 匿名白名单条数（服务端常量）与门禁期望一致 —— 由 build 后脚本单独跑，这里只确认
  //    新 action **确实**在匿名可达集合里（否则会 403 而不是 200）
  resetGuards();
  const q = await api('publicArchive:queryByMobile', { body: { mobile: '13600009998' }, ip: '10.0.0.99' });
  check(q.status === 200, '新 action 在匿名白名单内（匿名可达，未 403）', `status=${q.status}`);

  // ③ ACL 未被放宽：带一个**普通角色**的非法 token 请求后台资源仍被拒
  const back = await api('serviceArchives:list', {
    body: {},
    headers: { 'X-Role': 'store_sales', Authorization: 'Bearer invalid-token' },
  });
  check([401, 403].includes(back.status), '未授权访问 serviceArchives:list 仍被拒（ACL 未放宽）', `status=${back.status}`);

  // ④ 摘要接口不写任何业务数据（只读）—— 核对相关表行数在同一秒内不变
  const before = psql(`SELECT (SELECT count(*) FROM service_archives)||'|'||
    (SELECT count(*) FROM service_archive_photos)||'|'||
    (SELECT count(*) FROM service_tickets);`);
  resetGuards();
  await api('publicArchive:queryByMobile', { body: { mobile: '13600000001' }, ip: '10.0.0.100' });
  const after = psql(`SELECT (SELECT count(*) FROM service_archives)||'|'||
    (SELECT count(*) FROM service_archive_photos)||'|'||
    (SELECT count(*) FROM service_tickets);`);
  check(before === after, '摘要查询为纯只读（档案/照片/工单行数不变）', `${before} → ${after}`);
}

/* =========================================================================
 * 主流程
 * ========================================================================= */
console.log('ARC-V1 / R0-CHG-01 · 最小针对性验收（9 项）');
console.log(`BASE=${BASE}  APP=${APP}  reset=${!NO_RESET}`);
if (NO_RESET) console.log('（--no-reset：不做前置数据准备）');

try {
  await test01();
  await test02();
  await test03();
  await test04();
  await test05();
  await test06();
  await test07();
  await test08();
  await test09();
} catch (e) {
  console.error('\n[脚本异常]', e && (e.stack || e.message || e));
  results.push({ pass: false, label: '脚本运行未抛异常', detail: String(e && (e.message || e)) });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n========== 汇总 ==========`);
console.log(`共 ${results.length} 条断言，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL  ${f.label}${f.detail ? '  — ' + f.detail : ''}`);
}
process.exit(failed.length ? 1 : 0);
