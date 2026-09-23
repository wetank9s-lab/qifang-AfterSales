#!/usr/bin/env node
/**
 * probe-detail-request.mjs —— 抓「点开详情」时**浏览器真正发出的那个请求**
 * =============================================================================
 *
 * 为什么单独有它（Phase 4-I 第三轮走查：真人点「详情」得到 HTTP 404，
 * 而 `uat-preflight.mjs` §3.7 声称"真实渲染通过"）：
 *
 *   §3.7 会真的点一次「详情」，然后回读 `.ant-drawer` 里的**区块标题文字**。
 *   但它**从不看网络层** —— 它回答的是"抽屉的骨架渲染出来了吗"，
 *   而**不是**"抽屉的数据请求成功了吗"。
 *
 *   ⚠️ 因此它当时挂的名字「真实渲染闸门」是**过度承诺**。
 *   只要判据是"某几个字符串出现过"，就必须回答一句：
 *   **这几个字符串是静态的、还是会随数据出现？**
 *   —— 若是静态的，那么"区块标题齐全"在**请求 404、抽屉只剩一个错误提示**时
 *   也可能为真（取决于错误态是否也渲染标题），判据就没有区分力。
 *
 *   本脚本补的正是缺的那一层：**捕获实际 HTTP 请求/响应**
 *   （URL / method / status / response body）+ Console + 页面异常。
 *   判据从"文字出现过"提升为"**浏览器为此发出的请求是 200**"。
 *
 * ---------------------------------------------------------------------------
 * 用法
 * ---------------------------------------------------------------------------
 *   node scripts/probe-detail-request.mjs                          # 三个账号各抓一遍
 *   node scripts/probe-detail-request.mjs --account A              # 只抓 UAT-A
 *   node scripts/probe-detail-request.mjs --account A --ticket FW20260922-0059
 *   node scripts/probe-detail-request.mjs --account B --row 0      # 按行号
 *
 * 退出码：0 = 详情请求全 2xx；1 = 抓到非 2xx（真红灯）；
 *         2 = 环境未就绪（Chrome / 口令 / 登录 —— 铁律 4）
 *
 * ⚠️ 只读：登录 + GET，不做任何写动作。
 */
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', '_probe-detail-request-runner.mjs');
const PORT = Number(process.env.NGINX_HTTP_PORT ?? 8080);
const BASE_URL = `http://localhost:${PORT}`;

const argv = process.argv.slice(2);
const argOf = (k, d = null) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const ONLY = argOf('--account');
const TICKET = argOf('--ticket'); // 形如 FW20260922-0059

function readEnvFile() {
  const p = path.join(ROOT, '.env');
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
const ENV = readEnvFile();
const envValue = (k) => ENV[k] || process.env[k] || '';

const ACCOUNTS = {
  A: { code: 'UAT-A', email: 'uat.store.a@svc.local', envKey: 'UAT_STORE_A_PASSWORD', pageTitle: '我的门店工单' },
  B: { code: 'UAT-B', email: 'uat.store.b@svc.local', envKey: 'UAT_STORE_B_PASSWORD', pageTitle: '我的门店工单' },
  HQ: { code: 'UAT-HQ', email: 'uat.hq@svc.local', envKey: 'UAT_HQ_PASSWORD', pageTitle: '全量工单' },
};

function dbScalar(sql) {
  try {
    return execFileSync(
      'docker',
      ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-tAc', sql],
      { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    return '';
  }
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Users\\Administrator\\.agent-browser\\browsers\\chrome-153.0.8010.52\\chrome.exe',
].filter(Boolean);

function runProbe(acc) {
  const pwd = envValue(acc.envKey);
  if (!pwd) return { ok: false, why: `${acc.envKey} 缺失（.env）` };
  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) return { ok: false, why: '未找到 Chrome' };

  // 页面 schemaUid 从库里取，不手抄（DEV-66：手抄会伪装成权限缺陷）
  const schemaUid = dbScalar(
    `SELECT "schemaUid" FROM "desktopRoutes" WHERE type = 'flowPage' AND title = '${acc.pageTitle}' LIMIT 1`,
  );
  if (!schemaUid) return { ok: false, why: `库里找不到页面「${acc.pageTitle}」` };

  if (!fs.existsSync(RUNNER)) return { ok: false, why: `缺少 worker：${RUNNER}` };

  const r = spawnSync(process.execPath, [RUNNER], {
    encoding: 'utf8',
    timeout: 240000,
    env: {
      ...process.env,
      PROBE_CHROME: chrome,
      PROBE_BASE: BASE_URL,
      PROBE_TARGET: `/admin/${schemaUid}`,
      PROBE_EMAIL: acc.email,
      PROBE_PASSWORD: pwd,
      PROBE_TICKET: TICKET ?? '',
    },
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const line = out.split('\n').find((l) => l.startsWith('NETPROBE|'));
  if (!line) return { ok: false, why: `worker 无输出：${out.slice(-500)}` };
  try {
    return JSON.parse(line.slice('NETPROBE|'.length));
  } catch {
    return { ok: false, why: `输出解析失败：${line.slice(0, 300)}` };
  }
}

const keys = ONLY ? [ONLY.toUpperCase()] : ['A', 'B', 'HQ'];
let hardFail = 0;
let envFail = 0;

for (const k of keys) {
  const acc = ACCOUNTS[k];
  if (!acc) {
    console.error(`未知账号 ${k}（可选 A / B / HQ）`);
    process.exit(2);
  }
  console.log(`\n${'═'.repeat(74)}\n  ${acc.code} —— 「${acc.pageTitle}」\n${'═'.repeat(74)}`);

  const r = runProbe(acc);
  if (!r.ok) {
    console.log(`  ⚠️  环境未就绪：${r.why}`);
    envFail++;
    continue;
  }

  console.log(`  落地 URL   ：${r.afterLoginUrl}`);
  console.log(`  表格行数   ：${r.rows.rows}`);
  r.rows.texts.forEach((t, i) => console.log(`      [${i}] ${t}`));
  console.log(`  点击「详情」：${r.clickInfo}`);
  console.log(`  抽屉出现   ：${r.drawerSeen ? '是' : '否'}`);

  const apiReqs = r.requests || [];
  console.log(`\n  ── 网络请求（本次共 ${r.allCount} 条；下列 ${apiReqs.length} 条与业务相关）──`);
  if (apiReqs.length === 0) console.log('      （无）');
  for (const q of apiReqs) {
    const okStatus = typeof q.status === 'number' && q.status >= 200 && q.status < 300;
    console.log(`      ${okStatus ? '✅' : '🚨'} ${q.status}  ${q.method}  ${q.url}`);
    if (q.body) console.log(`           body: ${String(q.body).replace(/\s+/g, ' ').slice(0, 320)}`);
  }

  if (/加载失败/.test(r.drawerText || '')) console.log(`\n  🚨 抽屉渲染出来的是「加载失败」`);
  if (r.drawerText) {
    console.log(`\n  抽屉文字（前 260 字）：\n      ${String(r.drawerText).replace(/\n/g, ' | ').slice(0, 260)}`);
  }
  if (r.consoleMsgs?.length) {
    console.log(`\n  ── Console / Log（末 ${r.consoleMsgs.length} 条）──`);
    for (const c of r.consoleMsgs) console.log(`      [${c.kind}] ${String(c.text).slice(0, 240)}`);
  }
  if (r.pageExceptions?.length) {
    console.log(`\n  ── 页面异常 ──`);
    for (const e of r.pageExceptions) console.log(`      ${String(e).slice(0, 240)}`);
  }

  // ⚠️ 判据只认「抽屉真正要的两个端点」，**不能**把整页所有非 2xx 都算红灯：
  //    NocoBase 后台会顺带请求一批 UAT 账号本来就无权访问的内置接口
  //    （auth:check / aiEmployees:listByUser / aiConversations:unreadCounts → 401），
  //    它们与抽屉无关，混进判据会把「详情其实是好的」判成失败（**假红**，铁律 2）。
  const isDetail = (q) => /svc:(timeline|visits)/.test(String(q.url));
  const detailReqs = apiReqs.filter(isDetail);
  const badDetail = detailReqs.filter((q) => typeof q.status === 'number' && (q.status < 200 || q.status >= 300));
  const otherBad = apiReqs.filter(
    (q) => !isDetail(q) && typeof q.status === 'number' && (q.status < 200 || q.status >= 300),
  );
  // 抽屉两个端点都要真正打出去（`checked > 0` 式反假绿，铁律 3）
  const seen = new Set(detailReqs.map((q) => (/svc:timeline/.test(String(q.url)) ? 'timeline' : 'visits')));

  if (otherBad.length) {
    console.log(
      `\n  ℹ️  另有 ${otherBad.length} 条非 2xx 与抽屉无关（NocoBase 内置接口，UAT 账号无权限），不计入判据：` +
        ` ${otherBad.map((b) => `${b.status} ${String(b.url).replace(/^http:\/\/[^/]+/, '')}`).join(' | ')}`,
    );
  }

  console.log('');
  if (detailReqs.length === 0) {
    console.log(`  🚨 没捕获到 svc:timeline / svc:visits 请求 —— 抽屉没被点开，或请求形态与预期不同`);
    hardFail++;
  } else if (badDetail.length > 0) {
    console.log(`  🚨 详情数据请求存在非 2xx：${badDetail.map((b) => `${b.status} ${b.url}`).join(' | ')}`);
    hardFail++;
  } else if (seen.size < 2) {
    console.log(`  🚨 只捕获到 ${[...seen].join('+')} —— 抽屉应同时请求 timeline 与 visits（疑似有一路静默没发）`);
    hardFail++;
  } else {
    console.log(`  ✅ 详情数据请求全部 2xx：${detailReqs.map((d) => `${d.status} ${d.url}`).join(' | ')}`);
  }
}

console.log('');
if (envFail && !hardFail) {
  console.log('  ⚠️ 环境未就绪，未完成抓包（退出码 2）');
  process.exit(2);
}
if (hardFail) {
  console.log('  ❌ 抓到了真实失败（退出码 1）');
  process.exit(1);
}
console.log('  ✅ 详情数据请求全部 2xx');
process.exit(0);
