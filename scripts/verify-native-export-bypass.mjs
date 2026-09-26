#!/usr/bin/env node
/**
 * verify-native-export-bypass.mjs —— Phase 9 / D3 的**重门禁**：ServiceTicket 原生导出旁路
 * =============================================================================
 *
 * 覆盖用户 2026-09-26 裁定的那 7 条（不再扩、也不许缩）：
 *
 *   T1  hq_admin 走自研脱敏导出 → 成功（200 + text/csv）
 *   T2  非 ADMIN 角色走自研导出 → 拒绝（store_after_sales / hq_after_sales / viewer）
 *   T3  root/admin 直接走 ServiceTicket **原生** export → 被拒绝
 *   T4  换一种 native export 调用形态 → 仍不能旁路（能力/action 层，不是 URL 层）
 *   T5  自研 CSV 里手机号等敏感字段符合脱敏规则
 *   T6  `=` `+` `-` `@` 等危险单元格符合 CSV injection 防护
 *   T7  成功导出产生**一次**审计；失败/拒绝**不**伪造成功审计
 *
 * -----------------------------------------------------------------------------
 * 为什么这 7 条必须是"真请求"而不是读代码
 * -----------------------------------------------------------------------------
 * D3 的命题是"**同一个管理员换一个 endpoint 就不能绕开**"。这条命题的两个半边
 * 都只有真请求能证明：
 *   · 半边一（旁路真的关了）：`root`/`admin` 绕过全部 ACL，ACL 层写"拒绝"对它们无效
 *     ⇒ 任何基于"我们配置了权限"的推断都不成立，必须真打一次看它返回什么；
 *   · 半边二（受支持出口真的安全）：脱敏与防注入是**运行时**行为
 *     （`projectValue()` / `csvCell()`），只有真导出一份 CSV 下来逐格检查才算数。
 *
 * ⚠️ 修复前实测（`docs/PHASE-9-PREWORK.md` §3.2）：`POST /api/serviceTickets:export`
 *    body 带 `columns` → **200 + 真实 XLSX，含明文 `13800008220`**。本门禁就是
 *    把那一幕钉死的。
 *
 * -----------------------------------------------------------------------------
 * ⚠️ 一条容易被误读成 bug 的**正确**行为（写在这里，免得后来人"修"回去）
 * -----------------------------------------------------------------------------
 * `svc:exportTickets` 对 `root`/`admin` 返回 **200**，不是 403。
 * 理由：`PLATFORM_ADMIN_ROLES = ['root','admin']`，而 `permission-service.ts#can()`
 * 明确把平台超管"**按总部管理员对待**"（`isPlatformAdmin() → return true`）。
 * 于是它们天然持有 `CAPABILITY.ADMIN`。
 * 这与 D3 并不矛盾 —— D3 要关的是"**平台超管身份自动获得 native bypass**"，
 * 不是"平台超管不能导出"。走唯一受支持出口（脱敏 + 防注入 + 审计）时，
 * 超管与 hq_admin 受**同一套**约束，没有第二条路。
 * ⇒ 本门禁把这一对行为**成对断言**：自研 200 / 原生 403。只有两条一起看，
 *   才看得出"唯一出口"是真的。
 *
 * -----------------------------------------------------------------------------
 * 反向验证（`--reverse`，铁律 8："断言不会变红 = 没有断言"）
 * -----------------------------------------------------------------------------
 * 以**故意写错的期望**重放同一组事实，要求**每一条都必须变红**。
 * 例：`R-T3` 断言"root 走原生 export → 200"——它必须失败，因为事实上 403。
 * 若它**通过**了，说明 T3 根本没有区分力（比红更糟）。
 *
 * -----------------------------------------------------------------------------
 * 前置 / 副作用 / 退出码
 * -----------------------------------------------------------------------------
 *   · `.env` 需要 `UAT_STORE_A_PASSWORD` / `UAT_STORE_B_PASSWORD` / `UAT_HQ_PASSWORD`
 *     / `UAT_VIEWER_PASSWORD` / `UAT_HQADMIN_PASSWORD` / `SMOKE_ADMIN_PASSWORD`
 *     （先跑 `node scripts/uat-accounts.mjs --create`）
 *   · **自建自删**两张夹具（都走真实匿名接口，不直接写库）：
 *       夹具 F1：普通工单 ⇒ 验脱敏（脚本知道它的**明文**手机号）
 *       夹具 F2：`customer_name` 以 `@` 开头、`content` 以 `=` 开头 ⇒ 验 CSV injection
 *     ⚠️ F2 不能走 harness 的 `createScratchTicket()`：它会把 content 拼成
 *        `[TAG] …（脚本自建，跑完自删）`，危险前缀**不在首位** ⇒ 这条断言会假绿。
 *        必须自己发匿名请求，让危险字符真的落在单元格开头。
 *   · 跑完按**自己的 ticket id 精确删除**（绝不 `WHERE ticket_no LIKE …`）。
 *   · 证据落 `.tmp-verify/native-export-bypass-<run_id>.json`（**带 run_id**：
 *     本机 Bash 工具有"同一条命令跑两遍"的历史问题，固定文件名会被覆盖）。
 *   · 退出码：0 全绿 / 1 真红灯 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  BASE_URL,
  ROOT,
  EnvNotReady,
  assert,
  cleanupTicket,
  envValue,
  errorCodeOf,
  errorMessageOf,
  http,
  makeChecker,
  psqlRows,
  psqlScalar,
  runMain,
  signIn,
} from './technician-harness.mjs';

const argv = process.argv.slice(2);
const REVERSE = argv.includes('--reverse');
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto
  .randomBytes(3)
  .toString('hex')}`;

const { checkAsync, summary, state } = makeChecker({ heading: 'P9 / D3 原生导出旁路' });

// ---------------------------------------------------------------------------
// 账号 / 路径常量
// ---------------------------------------------------------------------------
const EMAILS = {
  storeA: 'uat.store.a@svc.local',
  storeB: 'uat.store.b@svc.local',
  hq: 'uat.hq@svc.local',
  viewer: 'uat.viewer@svc.local',
  hqadmin: 'uat.hqadmin@svc.local',
};

const SELF_EXPORT_PATH = '/api/svc/export/tickets';
/** 被 D3 关闭原生导出的 5 个资源（与 `NATIVE_EXPORT_DENY_RESOURCES` 同口径） */
const DENIED_RESOURCES = [
  'serviceTickets',
  'serviceVisits',
  'ticketEvents',
  'smsLogs',
  'serviceVisitPhotos',
];

// ---------------------------------------------------------------------------
// CSV 解析（**必须真解析**：quoted 字段里含逗号，按 `,` split 会错位）
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      /* CRLF 的 CR 丢掉，行结束交给 \n */
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 造一张**危险字符落在单元格首位**的工单（见文件头：不能用 harness 的建单助手）。
 *
 * `customer_name` = `@SUM(1+1)`（`@` 开头 ⇒ 表格软件会当公式）
 * `content`       = `=1+1+cmd|" /C calc"!A1 …`（`=` 开头 ⇒ 同上）
 */
async function createInjectionTicket() {
  const mobile = `138${String(Date.now()).slice(-8)}`;
  const payload = {
    store_code: 'S01',
    source: 'qr',
    ticket_type: 'repair',
    content: '=1+1+cmd|" /C calc"!A1 公式注入验收（脚本自建，跑完自删）',
    customer_name: '@SUM(1+1)',
    customer_mobile: mobile,
    privacy_agreed: true,
  };
  const created = await http(`${BASE_URL}/api/public/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
    body: JSON.stringify(payload),
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new EnvNotReady(
      `建「注入」夹具失败 HTTP ${created.status} ${String(created.body).slice(0, 200)}`,
    );
  }
  const ticketNo = String(created.json?.data?.ticket_no ?? '');
  if (!ticketNo) throw new EnvNotReady('建「注入」夹具未返回 ticket_no');
  const ticketId = Number(
    psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no = '${ticketNo}'`),
  );
  // ⚠️ 夹具前提自检：危险前缀必须真的落在列首。若匿名接口哪天做了 trim/净化，
  //    这条夹具就失效了，此时**必须显式失败**而不是让 T6 静默假绿。
  const stored = String(
    psqlScalar(`SELECT customer_name FROM service_tickets WHERE id = ${ticketId}`),
  );
  const storedContent = String(
    psqlScalar(`SELECT content FROM service_tickets WHERE id = ${ticketId}`),
  );
  assert(
    stored.startsWith('@') && storedContent.startsWith('='),
    `注入夹具的危险前缀没有落在首位（name=${JSON.stringify(stored)} content=${JSON.stringify(
      storedContent.slice(0, 12),
    )}）—— T6 会假绿，必须先修夹具`,
  );
  return { ticketId, ticketNo, mobile };
}

/** 造一张普通工单（脚本知道明文手机号 ⇒ 用于验脱敏） */
async function createPlainTicket() {
  const mobile = `139${String(Date.now()).slice(-8)}`;
  const created = await http(`${BASE_URL}/api/public/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
    body: JSON.stringify({
      store_code: 'S01',
      source: 'qr',
      ticket_type: 'repair',
      content: `[D3] 原生导出旁路验收：脱敏检查基准（脚本自建，跑完自删）`,
      customer_name: 'D3验收客户',
      customer_mobile: mobile,
      privacy_agreed: true,
    }),
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new EnvNotReady(
      `建「脱敏」夹具失败 HTTP ${created.status} ${String(created.body).slice(0, 200)}`,
    );
  }
  const ticketNo = String(created.json?.data?.ticket_no ?? '');
  const ticketId = Number(
    psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no = '${ticketNo}'`),
  );
  if (!ticketId) throw new EnvNotReady('建「脱敏」夹具后反查不到 id');
  return { ticketId, ticketNo, mobile };
}

// ---------------------------------------------------------------------------
// 原生导出的多种调用形态
// ---------------------------------------------------------------------------
/** T4：同一能力名，换 4 种调用形态；再加 4 个兄弟资源 */
function nativeProbes(anchorTicketId) {
  return [
    {
      name: 'body+columns（修复前实测能拿到明文 XLSX 的那一种）',
      resource: 'serviceTickets',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          columns: [{ dataIndex: ['customer_mobile'] }, { dataIndex: ['ticket_no'] }],
          filter: {},
        }),
      },
      url: `${BASE_URL}/api/serviceTickets:export`,
    },
    {
      name: 'filterByTk（GET 单条形态）',
      resource: 'serviceTickets',
      init: { method: 'GET' },
      url: `${BASE_URL}/api/serviceTickets:export?filterByTk=${anchorTicketId}`,
    },
    {
      name: 'list 形态（pageSize + filter）',
      resource: 'serviceTickets',
      init: { method: 'GET' },
      url: `${BASE_URL}/api/serviceTickets:export?pageSize=5&filter=%7B%7D`,
    },
    {
      name: '官方声明的 alias（exportAttachments）',
      resource: 'serviceTickets',
      init: { method: 'GET' },
      url: `${BASE_URL}/api/serviceTickets:exportAttachments?filterByTk=${anchorTicketId}`,
    },
    ...DENIED_RESOURCES.filter((r) => r !== 'serviceTickets').map((resource) => ({
      name: `兄弟资源 ${resource}`,
      resource,
      init: { method: 'GET' },
      url: `${BASE_URL}/api/${resource}:export?pageSize=5`,
    })),
  ];
}

// ---------------------------------------------------------------------------
// 源码级（辅助）断言：能力名单与"不靠 URL / 不动全局 ACL"
// ---------------------------------------------------------------------------
function readServerFile(rel) {
  return fs.readFileSync(path.join(ROOT, 'nocobase', 'plugins', 'service-ticket', 'src', 'server', rel), 'utf8');
}

/** 剥块注释与整行 `//`（**不剥行尾注释**，避免把 `https://` 切坏） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function stringArrayLiteral(src, name) {
  const m = new RegExp(`${name}\\s*:\\s*string\\[\\]\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(src);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/**
 * 解析 `NATIVE_READ_FIELD_DENY: Record<string, string[]> = { 表: ['列', …], … }`。
 * ⚠️ 走 `stripComments` 之后再解析：定义块上方有一大段说明注释，
 *    里面也出现了列名字符串（`'feedback_token_hash'` 等），不剥注释会把注释里的
 *    提及当成名单成员 —— 判据就变成"注释里写没写过"，而不是"代码里禁了哪些列"。
 */
function parseNativeReadDeny(src) {
  const clean = stripComments(src);
  const block = /NATIVE_READ_FIELD_DENY\s*:\s*Record<string,\s*string\[\]>\s*=\s*\{([\s\S]*?)\n\};/.exec(
    clean,
  );
  if (!block) return null;
  const out = {};
  for (const m of block[1].matchAll(/(\w+)\s*:\s*\[([\s\S]*?)\]/g)) {
    out[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  return out;
}

/**
 * 取出 deny 名单里那些列的**真实取值**（用于证明它们没被带进导出）。
 *
 * ⚠️ 不要在脚本里复写"集合名 → 表名"的驼峰转下划线规则：那是**第二份**命名约定，
 *    一旦迁移/建表侧改了规则，这里会静默查错表 —— 而"查错表 ⇒ 查不到值 ⇒ 断言空转"
 *    正是最坏的结果（看起来绿，其实没验）。
 *    改成**回库反查**：拿列名去 `information_schema` 找它实际落在哪张表。
 *    额外好处：若 deny 名单里的列在库里**根本不存在**（名单已漂移，比如列被改名/删除），
 *    这里会直接报错，而不是静默通过。
 */
function denyColumnProbes(deny) {
  const probes = [];
  const orphans = [];
  for (const [collection, fields] of Object.entries(deny)) {
    for (const field of fields) {
      const tables = psqlRows(
        `SELECT table_name FROM information_schema.columns ` +
          `WHERE table_schema = 'public' AND column_name = '${field}' ORDER BY table_name`,
      ).map((r) => r[0]);
      if (tables.length === 0) {
        orphans.push(`${collection}.${field}`);
        continue;
      }
      for (const table of tables) {
        const rows = psqlRows(
          `SELECT "${field}"::text FROM "${table}" WHERE "${field}" IS NOT NULL LIMIT 20`,
        );
        for (const [v] of rows) if (v && v.length >= 16) probes.push({ table, field, v });
      }
    }
  }
  return { probes, orphans };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  // ---- 环境就绪 ----
  const passwords = {
    storeA: envValue('UAT_STORE_A_PASSWORD'),
    storeB: envValue('UAT_STORE_B_PASSWORD'),
    hq: envValue('UAT_HQ_PASSWORD'),
    viewer: envValue('UAT_VIEWER_PASSWORD'),
    hqadmin: envValue('UAT_HQADMIN_PASSWORD'),
    admin: envValue('SMOKE_ADMIN_PASSWORD'),
  };
  const missing = Object.entries(passwords)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new EnvNotReady(
      `.env 缺口令：${missing.join(', ')} —— 先跑 node scripts/uat-accounts.mjs --create` +
        `（admin 口令来自 SMOKE_ADMIN_PASSWORD）`,
    );
  }

  const health = await http(`${BASE_URL}/api/svc/health`);
  if (health.status !== 200) {
    throw new EnvNotReady(`应用未就绪（/api/svc/health → ${health.status}）`);
  }

  const tokens = {};
  for (const [key, email] of Object.entries({
    storeA: EMAILS.storeA,
    storeB: EMAILS.storeB,
    hq: EMAILS.hq,
    viewer: EMAILS.viewer,
    hqadmin: EMAILS.hqadmin,
  })) {
    const t = await signIn(email, passwords[key]);
    if (!t) throw new EnvNotReady(`${email} 登录失败（口令可能已轮换）`);
    tokens[key] = t;
  }
  const adminEmail = envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com');
  const adminToken = await signIn(adminEmail, passwords.admin);
  if (!adminToken) throw new EnvNotReady(`平台超管 ${adminEmail} 登录失败`);
  tokens.admin = adminToken;

  // 自检：admin 真的是平台超管（否则"超管被拒"这条断言测的不是超管）
  const adminRoles = psqlRows(
    `SELECT r."roleName" FROM "rolesUsers" r JOIN users u ON u.id = r."userId" WHERE u.email = '${adminEmail}'`,
  ).map((r) => r[0]);
  console.log(`\n【会话】6 个身份就绪；平台超管 ${adminEmail} 角色 = [${adminRoles.join(', ')}]`);

  const fixtures = [];
  let plain;
  let inject;

  try {
    console.log('\n【夹具】自建两张一次性工单（走真实匿名接口；跑完按 ticket id 精确删除）');
    plain = await createPlainTicket();
    fixtures.push(plain.ticketId);
    inject = await createInjectionTicket();
    fixtures.push(inject.ticketId);
    console.log(`  · F1 脱敏基准：${plain.ticketNo}(#${plain.ticketId}) 明文 ${plain.mobile}`);
    console.log(`  · F2 注入基准：${inject.ticketNo}(#${inject.ticketId}) name=@SUM(1+1) content==1+1+cmd…`);

    const today = localToday();
    const windowQs = `from=${today}&to=${today}`;

    // =====================================================================
    if (!REVERSE) {
      // ------------------------------------------------------------------
      console.log('\n【T1】hq_admin 走**自研**导出 → 成功');
      // ------------------------------------------------------------------
      let csvText = '';
      let csvHeaders = null;
      let csvRows = [];
      let exportRequestId = '';
      let rowCountHeader = '';
      let disposition = '';

      await checkAsync('T1-a hq_admin 调 /api/svc/export/tickets → 200 + text/csv', async () => {
        exportRequestId = crypto.randomUUID();
        const r = await http(`${BASE_URL}${SELF_EXPORT_PATH}?${windowQs}`, {
          headers: {
            Authorization: `Bearer ${tokens.hqadmin}`,
            'X-Request-Id': exportRequestId,
          },
        });
        assert(r.status === 200, `HTTP ${r.status} ${errorMessageOf(r)}`);
        const ct = String(r.headers.get('content-type') ?? '');
        assert(ct.startsWith('text/csv'), `Content-Type 应为 text/csv，实际 ${ct}`);
        disposition = String(r.headers.get('content-disposition') ?? '');
        assert(
          disposition.startsWith('attachment;'),
          `Content-Disposition 应为 attachment，实际 ${disposition}`,
        );
        rowCountHeader = String(r.headers.get('x-export-row-count') ?? '');
        assert(/^\d+$/.test(rowCountHeader), `X-Export-Row-Count 缺失或非数字：${rowCountHeader}`);
        csvText = r.body;
        return `${ct} · ${r.body.length} 字节 · rowCount=${rowCountHeader}`;
      });

      await checkAsync('T1-b 响应头是私有内容口径（no-store / nosniff）+ 规则版本', async () => {
        const r = await http(`${BASE_URL}${SELF_EXPORT_PATH}?${windowQs}`, {
          headers: { Authorization: `Bearer ${tokens.hqadmin}` },
        });
        const cc = String(r.headers.get('cache-control') ?? '');
        const nosniff = String(r.headers.get('x-content-type-options') ?? '');
        const engine = String(r.headers.get('x-export-engine-version') ?? '');
        assert(cc.includes('no-store'), `Cache-Control 应含 no-store，实际 ${cc}`);
        assert(nosniff.includes('nosniff'), `X-Content-Type-Options 应含 nosniff，实际 ${nosniff}`);
        assert(engine.length > 0, 'X-Export-Engine-Version 缺失（无法判断本次按哪版规则导出）');
        return `${cc} · ${nosniff} · engine=${engine}`;
      });

      await checkAsync('T1-c CSV 结构自洽（42 列 · 行数 == X-Export-Row-Count）', async () => {
        csvRows = parseCsv(csvText);
        assert(csvRows.length >= 2, `CSV 至少应有表头 + 1 行数据，实际 ${csvRows.length} 行`);
        [csvHeaders] = csvRows;
        const data = csvRows.slice(1);
        assert(
          Number(rowCountHeader) === data.length,
          `X-Export-Row-Count(${rowCountHeader}) 与 CSV 数据行数(${data.length}) 不一致`,
        );
        // 列宽自洽：每行格数 == 表头列数（错位是"字段里有逗号"的典型症状）
        const bad = data.filter((r) => r.length !== csvHeaders.length).length;
        assert(bad === 0, `${bad} 行的列数与表头不一致（疑似 CSV 转义/换行处理有问题）`);
        return `${csvHeaders.length} 列 · ${data.length} 行数据`;
      });

      await checkAsync('T1-d 表头**不含**凭据类字样（列白名单没有把凭据带出来）', async () => {
        const banned = ['token', 'hash', '哈希', '凭据', 'storage', '密钥', 'secret'];
        const hit = csvHeaders.filter((h) => banned.some((b) => h.toLowerCase().includes(b)));
        assert(hit.length === 0, `表头出现敏感字样：${hit.join(', ')}`);
        // 反向：正因为它**不是**整行直出，`NATIVE_READ_FIELD_DENY` 里的列不该出现
        for (const key of ['feedback_token_hash', 'access_token_hash', 'extra_json', 'upload_ip_hash']) {
          assert(!csvHeaders.includes(key), `表头含未评审列 ${key}`);
        }
        return `${csvHeaders.length} 个中文表头全部通过`;
      });

      // ------------------------------------------------------------------
      console.log('\n【T2】非 ADMIN 角色走自研导出 → 拒绝');
      // ------------------------------------------------------------------
      for (const key of ['storeA', 'storeB', 'hq', 'viewer']) {
        await checkAsync(`T2 ${key} 调自研导出 → 403（"看报表"≠"带走数据"）`, async () => {
          const r = await http(`${BASE_URL}${SELF_EXPORT_PATH}?${windowQs}`, {
            headers: { Authorization: `Bearer ${tokens[key]}` },
          });
          assert(r.status === 403, `应 403，实际 ${r.status}：${r.body.slice(0, 160)}`);
          assert(
            !r.body.includes(plain.mobile),
            '拒绝响应里竟出现了夹具明文手机号',
          );
          return `403 ${errorCodeOf(r) ?? ''}`;
        });
      }

      await checkAsync('T2 匿名调自研导出 → 401', async () => {
        const r = await http(`${BASE_URL}${SELF_EXPORT_PATH}?${windowQs}`);
        assert(r.status === 401, `应 401，实际 ${r.status}`);
        return '401';
      });

      // ------------------------------------------------------------------
      console.log('\n【T3】root/admin 走**原生** export → 被拒绝');
      // ------------------------------------------------------------------
      // ⚠️ 对照前提：平台超管在自研出口上**是** 200（见文件头）。先证明它确实有
      //    能力，否则"原生被拒"可能只是因为"它什么都不能做"——那就没有区分力。
      await checkAsync('T3-a 前提对照：root/admin 走**自研**导出 → 200（超管不是"什么都做不了"）', async () => {
        const r = await http(`${BASE_URL}${SELF_EXPORT_PATH}?${windowQs}`, {
          headers: { Authorization: `Bearer ${tokens.admin}` },
        });
        assert(
          r.status === 200,
          `平台超管走受支持出口应 200，实际 ${r.status} ${errorMessageOf(r)}` +
            ` —— 若这里是 403，"原生被拒"就失去区分力（见文件头说明）`,
        );
        return '200（唯一受支持出口对超管同样开放，但受同一套脱敏/审计约束）';
      });

      await checkAsync('T3-b root/admin 走原生 serviceTickets:export → 403 NATIVE_EXPORT_FORBIDDEN', async () => {
        const r = await http(`${BASE_URL}/api/serviceTickets:export`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            columns: [{ dataIndex: ['customer_mobile'] }, { dataIndex: ['ticket_no'] }],
            filter: {},
          }),
        });
        assert(r.status === 403, `应 403，实际 ${r.status}：${r.body.slice(0, 200)}`);
        assert(
          errorCodeOf(r) === 'NATIVE_EXPORT_FORBIDDEN',
          `错误码应为 NATIVE_EXPORT_FORBIDDEN，实际 ${errorCodeOf(r)}：${r.body.slice(0, 200)}`,
        );
        // 修复前这一条会 200 并回 XLSX —— 顺手确认响应体里没有表格二进制/明文号码
        assert(
          !r.body.includes(plain.mobile) && !r.body.includes('PK'),
          '拒绝响应体里出现了明文手机号或 XLSX（PKZip）头',
        );
        return `403 ${errorCodeOf(r)}`;
      });

      await checkAsync('T3-c 对照：root 读原生**列表**仍 200（拒绝是导出专属，不是把超管整体封了）', async () => {
        const r = await http(`${BASE_URL}/api/serviceTickets:list?pageSize=1`, {
          headers: { Authorization: `Bearer ${tokens.admin}` },
        });
        assert(r.status === 200, `平台超管读列表应 200，实际 ${r.status}`);
        return '200';
      });

      // ------------------------------------------------------------------
      console.log('\n【T4】换一种 native export 调用形态 → 仍不能旁路');
      // ------------------------------------------------------------------
      const probes = nativeProbes(plain.ticketId);
      for (const probe of probes) {
        await checkAsync(`T4 ${probe.name}`, async () => {
          const r = await http(probe.url, {
            ...probe.init,
            headers: { Authorization: `Bearer ${tokens.admin}`, ...(probe.init.headers ?? {}) },
          });
          assert(
            r.status !== 200,
            `⚠️ 竟然 200 —— 这是一条**真实旁路**（${probe.name}）：${r.body.slice(0, 160)}`,
          );
          assert(r.status < 500, `不得 5xx（应安全失败），实际 ${r.status}`);
          // ⚠️ 这里是"必须落在 {403,404}"，**不是** "不得落在 {403,404}"。
          //    首跑就写成 `![403,404].includes(...)`（极性反了），于是 8 条探针
          //    全部"通过守卫却判红"，报错文案还自相矛盾（"应 403/404，实际 403"）。
          //    教训同 `sqlRows`/`psqlRows`：**判据返回 false 时先读一遍它到底在断言什么**。
          assert(
            [403, 404].includes(r.status),
            `应 403/404（守卫安全拒绝），实际 ${r.status}：${r.body.slice(0, 160)}`,
          );
          const code = errorCodeOf(r);
          if (probe.resource === 'serviceTickets' && r.status === 403) {
            assert(
              code === 'NATIVE_EXPORT_FORBIDDEN',
              `serviceTickets 的 403 必须由 D3 守卫给出，实际 ${code}`,
            );
          }
          assert(!r.body.includes(plain.mobile), '响应体里出现了夹具明文手机号');
          return `${r.status} ${code ?? ''}`;
        });
      }

      // ---- 源码级辅助断言（能力名单覆盖度 + 不靠 URL + 不动全局 ACL）----
      await checkAsync('T4-src 能力名单覆盖 5 资源 × 2 形态，且守卫判的是 actionName 不是 URL', async () => {
        const constantsSrc = readServerFile('constants.ts');
        const actions = stringArrayLiteral(constantsSrc, 'NATIVE_EXPORT_ACTIONS');
        const resources = stringArrayLiteral(constantsSrc, 'NATIVE_EXPORT_DENY_RESOURCES');
        assert(actions, 'constants.ts 里找不到 NATIVE_EXPORT_ACTIONS');
        assert(resources, 'constants.ts 里找不到 NATIVE_EXPORT_DENY_RESOURCES');
        for (const need of ['export', 'exportAttachments']) {
          assert(actions.includes(need), `NATIVE_EXPORT_ACTIONS 缺 ${need}`);
        }
        for (const need of DENIED_RESOURCES) {
          assert(resources.includes(need), `NATIVE_EXPORT_DENY_RESOURCES 缺 ${need}`);
        }

        const guard = stripComments(readServerFile('middleware/native-export-guard.ts'));
        assert(
          /ctx\?\.action\?\.actionName\s*\?\?\s*ctx\?\.action\?\.name/.test(guard),
          '守卫没有读 ctx.action.actionName —— 那就不是"能力层封闭"',
        );
        for (const urlish of ['ctx.request.url', 'ctx.url', 'ctx.path', 'originUrl']) {
          assert(!guard.includes(urlish), `守卫读了 ${urlish} —— 这正是被明令禁止的"只封 URL 字符串"`);
        }
        // 不动平台权限模型：守卫不得出现任何 ACL 写操作
        for (const aclCall of ['setAvailableAction', 'acl.allow', 'acl.deny', 'setRole(', 'rolesResources']) {
          assert(
            !guard.includes(aclCall),
            `守卫里出现 ${aclCall} —— D3 明令不得因此改造 NocoBase 全局 ACL / root 机制`,
          );
        }
        return `${resources.length} 资源 × ${actions.length} 形态；判 actionName；未触碰 ACL`;
      });

      await checkAsync('T4-plug 启动期自检真的挂着（名单与受管资源不一致会启动失败）', async () => {
        const plugin = stripComments(readServerFile('plugin.ts'));
        assert(plugin.includes('registerNativeExportGuard'), 'plugin 没有挂载原生导出守卫');
        assert(plugin.includes('assertNativeExportGuard'), 'plugin 没有启动期断言（少了"配置漂移就起不来"）');
        assert(
          /nativeExportGuardWired/.test(plugin),
          '挂载点没有幂等保护（热重载会重复 register）',
        );
        return 'registerNativeExportGuard + assertNativeExportGuard + 幂等标志 齐备';
      });

      // ------------------------------------------------------------------
      console.log('\n【T5】CSV 脱敏规则');
      // ------------------------------------------------------------------
      const colIndex = (label) => csvHeaders.indexOf(label);

      await checkAsync('T5-a 两张手机号列的**每一格**都是掩码形态或空', async () => {
        const idx = [colIndex('客户手机号'), colIndex('师傅手机号')];
        assert(idx.every((i) => i >= 0), `找不到手机号列（表头：${csvHeaders.join('|')}）`);
        const maskRe = /^\d{3}\*{4}\d{4}$/;
        const bad = [];
        for (const row of csvRows.slice(1)) {
          for (const i of idx) {
            const v = row[i] ?? '';
            if (v === '') continue;
            if (!maskRe.test(v)) bad.push(v);
          }
        }
        assert(bad.length === 0, `出现非掩码手机号：${bad.slice(0, 5).join(', ')}`);
        return `${idx.length} 列 × ${csvRows.length - 1} 行全部合规`;
      });

      await checkAsync('T5-b 夹具 F1 的**明文**手机号在整份 CSV 里 0 命中，掩码形态必命中', async () => {
        assert(
          !csvText.includes(plain.mobile),
          `⚠️ CSV 里出现了明文手机号 ${plain.mobile} —— 脱敏被绕过`,
        );
        const masked = `${plain.mobile.slice(0, 3)}****${plain.mobile.slice(-4)}`;
        const row = csvRows.slice(1).find((r) => r[colIndex('工单ID')] === String(plain.ticketId));
        assert(row, `CSV 里没有夹具 F1（#${plain.ticketId}）—— 窗口/范围裁剪可能有问题`);
        assert(
          row[colIndex('客户手机号')] === masked,
          `夹具 F1 的手机号应为 ${masked}，实际 ${JSON.stringify(row[colIndex('客户手机号')])}`,
        );
        return `明文 0 命中 · 掩码 ${masked} 命中`;
      });

      await checkAsync('T5-c 自由文本里的手机号也被打码（D3-a 口径，不只看"手机号列"）', async () => {
        // 在 F1 的 content 里塞一个手机号（走真实匿名接口，保证是"客户自己写进去的"）
        const hidden = `137${String(Date.now()).slice(-8)}`;
        const patched = await http(`${BASE_URL}/api/public/tickets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
          body: JSON.stringify({
            store_code: 'S01',
            source: 'qr',
            ticket_type: 'repair',
            content: `[D3] 自由文本脱敏验收：打 ${hidden} 找我（脚本自建，跑完自删）`,
            customer_name: 'D3自由文本',
            customer_mobile: `136${String(Date.now()).slice(-8)}`,
            privacy_agreed: true,
          }),
        });
        assert(patched.status === 200 || patched.status === 201, `建自由文本夹具失败 ${patched.status}`);
        const patchedNo = String(patched.json?.data?.ticket_no ?? '');
        const patchedId = Number(
          psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no = '${patchedNo}'`),
        );
        fixtures.push(patchedId);

        const r = await http(`${BASE_URL}${SELF_EXPORT_PATH}?${windowQs}`, {
          headers: { Authorization: `Bearer ${tokens.hqadmin}` },
        });
        assert(r.status === 200, `重新导出失败 HTTP ${r.status}`);
        assert(
          !r.body.includes(hidden),
          `⚠️ 自由文本里的手机号 ${hidden} 原样出现在 CSV —— 文件头"收紧 ②"没生效`,
        );
        const rows = parseCsv(r.body);
        const idx = rows[0].indexOf('报修/投诉内容');
        const line = rows.slice(1).find((x) => x[idx]?.includes('自由文本脱敏验收'));
        assert(line, '重新导出的 CSV 里找不到自由文本夹具');
        const masked = `${hidden.slice(0, 3)}****${hidden.slice(-4)}`;
        assert(line[idx].includes(masked), `自由文本里的号码应为 ${masked}，实际 ${line[idx]}`);
        return `明文 0 命中 · 文本内掩码 ${masked} 命中`;
      });

      await checkAsync('T5-d 凭据形态（sha256 十六进制）在 CSV 里 0 命中', async () => {
        const sha = /\b[0-9a-f]{64}\b/g;
        const hits = csvText.match(sha) ?? [];
        assert(hits.length === 0, `CSV 里出现 64 位十六进制串（疑似 Token 哈希）：${hits.slice(0, 3).join(', ')}`);
        return '0 命中';
      });

      /**
       * T5-e —— AT-15 第 4 条要的是「导出内容**不含**任何 `NATIVE_READ_FIELD_DENY` 列」。
       *
       * ⚠️ 为什么不能只查表头：导出表头是**中文标签**（`客户手机号` / `工单ID`…），
       *    而 deny 列表里是 snake_case 列名 ⇒ "表头里没有 `feedback_token_hash`"
       *    是**恒真**的，属于判据空转（假绿）。真正要否证的是：
       *    **那些列的真实取值**有没有被带进 CSV。
       *
       * 做法：从 `constants.ts` 解析 deny 名单（单一事实来源，不手抄），
       * 回库取出这些列在**导出行范围内**的非空真值，再断言 CSV 文本里 0 命中。
       */
      await checkAsync('T5-e deny 列的**真实取值**没有被带进 CSV（AT-15 第 4 条）', async () => {
        const constantsSrc = readServerFile('constants.ts');
        const deny = parseNativeReadDeny(constantsSrc);
        assert(deny, '从 constants.ts 解析不到 NATIVE_READ_FIELD_DENY（解析器已失效）');
        const declared = Object.values(deny).flat().length;
        assert(declared >= 6, `deny 名单只解析出 ${declared} 个列（解析器可能已失效）`);

        const { probes, orphans } = denyColumnProbes(deny);
        assert(
          orphans.length === 0,
          `deny 名单里的列在库里根本不存在（名单已漂移）：${orphans.join(', ')}`,
        );
        assert(
          probes.length > 0,
          '库内取不到任何非空 deny 真值 —— 这条断言会**空转通过**，必须先造出带 Token 的数据再跑',
        );

        const leaked = probes.filter((p) => csvText.includes(p.v));
        assert(
          leaked.length === 0,
          `CSV 里出现了 deny 列的真值：${leaked
            .slice(0, 3)
            .map((p) => `${p.table}.${p.field}`)
            .join(', ')}`,
        );
        const byField = [...new Set(probes.map((p) => p.field))];
        return `${declared} 个 deny 列 / ${probes.length} 个真值（${byField.join('/')}）· 0 命中`;
      });

      // ------------------------------------------------------------------
      console.log('\n【T6】CSV injection 防护');
      // ------------------------------------------------------------------
      await checkAsync('T6-a 夹具 F2 的危险单元格被加单引号前缀（= 与 @ 两种都验）', async () => {
        const row = csvRows
          .slice(1)
          .find((r) => r[colIndex('工单ID')] === String(inject.ticketId));
        assert(row, `CSV 里没有夹具 F2（#${inject.ticketId}）`);
        const name = row[colIndex('客户姓名')];
        const content = row[colIndex('报修/投诉内容')];
        assert(
          name.startsWith("'@"),
          `客户姓名应被转义成 "'@SUM(1+1)"，实际 ${JSON.stringify(name)}`,
        );
        assert(
          content.startsWith("'="),
          `报修内容应被转义成 "'=1+1+…"，实际 ${JSON.stringify(content.slice(0, 20))}`,
        );
        return `name=${JSON.stringify(name)} · content=${JSON.stringify(content.slice(0, 16))}…`;
      });

      await checkAsync('T6-b 全表逐格扫描：**没有任何一格**以危险字符开头', async () => {
        const bad = [];
        for (const row of csvRows) {
          for (const cell of row) {
            if (cell === '') continue;
            if (/^[=+@\t\r]/.test(cell) || cell.startsWith('-')) bad.push(cell.slice(0, 24));
          }
        }
        assert(
          bad.length === 0,
          `${bad.length} 格以危险字符开头（公式注入面）：${bad.slice(0, 5).join(' | ')}`,
        );
        return `${csvRows.length} 行 × ${csvHeaders.length} 列，0 格危险`;
      });

      // ------------------------------------------------------------------
      console.log('\n【T7】导出审计');
      // ------------------------------------------------------------------
      const auditCount = () => Number(psqlScalar('SELECT count(*) FROM export_audits'));
      const auditOf = (requestId) =>
        psqlRows(
          `SELECT id, channel, engine_version, operator_username, operator_roles, row_count, ` +
            `request_id, filter_json::text, columns_json::text, exported_at::text ` +
            `FROM export_audits WHERE request_id = '${requestId}' ORDER BY id DESC LIMIT 1`,
        )[0];

      await checkAsync('T7-a 成功导出恰好产生 1 条审计，且与本次 request id 对齐', async () => {
        const rows = psqlRows(
          `SELECT count(*) FROM export_audits WHERE request_id = '${exportRequestId}'`,
        );
        assert(Number(rows[0][0]) === 1, `本次 request id 应对应恰好 1 条审计，实际 ${rows[0][0]}`);
        const row = auditOf(exportRequestId);
        assert(row, `按 request_id=${exportRequestId} 查不到审计行`);
        assert(row[1] === 'svc:exportTickets', `channel 应为 svc:exportTickets，实际 ${row[1]}`);
        assert(String(row[3]).length > 0, 'operator_username 为空（"谁带走的"答不上来）');
        assert(String(row[4]).includes('hq_admin'), `operator_roles 应含 hq_admin，实际 ${row[4]}`);
        assert(Number(row[5]) === Number(rowCountHeader), `row_count(${row[5]}) 应等于实际行数(${rowCountHeader})`);
        assert(Number(row[5]) === csvRows.length - 1, 'row_count 应等于 CSV 数据行数');
        assert(String(row[8]).includes('customer_mobile'), 'columns_json 应记录列名清单');
        return `audit#${row[0]} · rows=${row[5]} · operator=${row[3]}`;
      });

      await checkAsync('T7-b 审计**只记事实**：不含被导出的值（尤其手机号 / 整份 CSV）', async () => {
        const row = auditOf(exportRequestId);
        const blob = row.join('\u0001');
        assert(
          !blob.includes(plain.mobile) && !blob.includes(inject.mobile),
          '⚠️ 审计里出现了客户明文手机号 —— 这正是"制造第二份敏感数据副本"',
        );
        assert(!blob.includes('\uFEFF'), '审计里出现了 CSV BOM（疑似把 CSV 本体写进了审计）');
        assert(
          Number(row[9].length ?? String(row[9]).length) > 0 || String(row[9]).length > 0,
          'exported_at 缺失',
        );
        const filterJson = JSON.parse(row[7]);
        assert(filterJson.from === today, `filter_json.from 应为 ${today}，实际 ${filterJson.from}`);
        assert(filterJson.to === today, `filter_json.to 应为 ${today}，实际 ${filterJson.to}`);
        assert(
          Object.keys(filterJson).every((k) => !/mobile|content|name/i.test(k)),
          `filter_json 里混入了业务字段：${Object.keys(filterJson).join(', ')}`,
        );
        return `审计仅含 to/fromIso + 筛选维度 + 列名；0 处敏感值`;
      });

      await checkAsync('T7-c 失败/拒绝**不**伪造成功审计（4 个角色的 403 + 超管原生 403 都不增加计数）', async () => {
        const before = auditCount();
        const attempts = [
          await http(`${BASE_URL}${SELF_EXPORT_PATH}?${windowQs}`, {
            headers: { Authorization: `Bearer ${tokens.storeA}` },
          }),
          await http(`${BASE_URL}${SELF_EXPORT_PATH}?${windowQs}`, {
            headers: { Authorization: `Bearer ${tokens.hq}` },
          }),
          await http(`${BASE_URL}${SELF_EXPORT_PATH}?${windowQs}`, {
            headers: { Authorization: `Bearer ${tokens.viewer}` },
          }),
          await http(`${BASE_URL}/api/serviceTickets:export`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ columns: [{ dataIndex: ['customer_mobile'] }], filter: {} }),
          }),
        ];
        assert(
          attempts.every((r) => r.status === 403),
          `4 次尝试应全部被拒，实际状态码 ${attempts.map((r) => r.status).join(', ')}`,
        );
        const after = auditCount();
        assert(
          after === before,
          `被拒的导出竟然增加了审计计数（${before} → ${after}）——"不伪造成功审计"被破坏`,
        );
        return `4 次拒绝 · 审计计数保持 ${after}`;
      });

      // ------------------------------------------------------------------
      console.log('\n【回归】守卫没有误伤正常读路径');
      // ------------------------------------------------------------------
      await checkAsync('REG 门店角色的常规 svc 读 / 原生列表读仍然可用', async () => {
        const a = await http(`${BASE_URL}/api/serviceTickets:list?pageSize=1`, {
          headers: { Authorization: `Bearer ${tokens.storeA}` },
        });
        const b = await http(`${BASE_URL}/api/svc:health`, {
          headers: { Authorization: `Bearer ${tokens.storeA}` },
        });
        assert(a.status === 200, `serviceTickets:list 应 200，实际 ${a.status}`);
        assert(b.status === 200, `svc:health 应 200，实际 ${b.status}`);
        return 'list 200 · health 200';
      });
    }

    // =====================================================================
    // 反向验证：以**故意写错的期望**重放，每条都必须变红
    // =====================================================================
    if (REVERSE) {
      console.log('\n【反向验证】以下每条都**必须失败**；若某条通过，说明对应用断没有区分力');
      const today = localToday();
      const windowQs = `from=${today}&to=${today}`;

      const redExpectations = [
        {
          name: 'R-T3 root 走原生 serviceTickets:export → 200',
          claim: 'T3 的 403 有区分力（不是恒红）',
          fn: async () => {
            const r = await http(`${BASE_URL}/api/serviceTickets:export`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${tokens.admin}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ columns: [{ dataIndex: ['customer_mobile'] }], filter: {} }),
            });
            assert(r.status === 200, `反向期望(200)未成立：实际 ${r.status} —— 这正是 T3 的区分力`);
          },
        },
        {
          name: 'R-T4 原生 exportAttachments → 200',
          claim: 'T4 的 alias 封闭有区分力',
          fn: async () => {
            const r = await http(
              `${BASE_URL}/api/serviceTickets:exportAttachments?filterByTk=${plain.ticketId}`,
              { headers: { Authorization: `Bearer ${tokens.admin}` } },
            );
            assert(r.status === 200, `反向期望(200)未成立：实际 ${r.status} —— 这正是 T4 的区分力`);
          },
        },
        {
          name: 'R-T1 自研导出（hq_admin）→ 403',
          claim: 'T1 的 200 有区分力',
          fn: async () => {
            const r = await http(`${BASE_URL}${SELF_EXPORT_PATH}?${windowQs}`, {
              headers: { Authorization: `Bearer ${tokens.hqadmin}` },
            });
            assert(r.status === 403, `反向期望(403)未成立：实际 ${r.status} —— 这正是 T1 的区分力`);
          },
        },
        {
          name: 'R-T2 门店角色走自研导出 → 200',
          claim: 'T2 的 403 有区分力',
          fn: async () => {
            const r = await http(`${BASE_URL}${SELF_EXPORT_PATH}?${windowQs}`, {
              headers: { Authorization: `Bearer ${tokens.storeA}` },
            });
            assert(r.status === 200, `反向期望(200)未成立：实际 ${r.status} —— 这正是 T2 的区分力`);
          },
        },
        {
          name: 'R-T5 CSV 里含明文手机号（未被脱敏）',
          claim: 'T5 的"明文 0 命中"有区分力',
          fn: async () => {
            const r = await http(`${BASE_URL}${SELF_EXPORT_PATH}?${windowQs}`, {
              headers: { Authorization: `Bearer ${tokens.hqadmin}` },
            });
            assert(
              r.body.includes(plain.mobile),
              `反向期望(含明文 ${plain.mobile})未成立：实际不含 —— 这正是 T5 的区分力`,
            );
          },
        },
        {
          name: 'R-T5e CSV 里含 deny 列的**真实取值**（凭据外泄形态）',
          claim: 'T5-e 的"deny 真值 0 命中"有区分力',
          fn: async () => {
            const deny = parseNativeReadDeny(readServerFile('constants.ts'));
            const { probes } = denyColumnProbes(deny);
            const r = await http(`${BASE_URL}${SELF_EXPORT_PATH}?${windowQs}`, {
              headers: { Authorization: `Bearer ${tokens.hqadmin}` },
            });
            const leaked = probes.filter((p) => r.body.includes(p.v));
            assert(
              leaked.length > 0,
              `反向期望(deny 真值出现在 CSV)未成立：${probes.length} 个真值 0 命中 —— 这正是 T5-e 的区分力`,
            );
          },
        },
        {
          name: 'R-T6 危险单元格**没有**被转义（存在以 `=`/`@` 开头的格子）',
          claim: 'T6 的转义有区分力',
          fn: async () => {
            const r = await http(`${BASE_URL}${SELF_EXPORT_PATH}?${windowQs}`, {
              headers: { Authorization: `Bearer ${tokens.hqadmin}` },
            });
            const rows = parseCsv(r.body);
            const bad = rows.flat().filter((c) => /^[=+@]/.test(c));
            assert(
              bad.length > 0,
              '反向期望(存在未转义的危险单元格)未成立：实际 0 格 —— 这正是 T6 的区分力',
            );
          },
        },
        {
          name: 'R-T7a 一次成功导出**不增加**审计计数',
          claim: 'T7-a 的审计有区分力',
          fn: async () => {
            const before = auditCountStatic();
            const r = await http(`${BASE_URL}${SELF_EXPORT_PATH}?${windowQs}`, {
              headers: { Authorization: `Bearer ${tokens.hqadmin}` },
            });
            assert(r.status === 200, `前置失败：导出未成功（${r.status}）`);
            const after = auditCountStatic();
            assert(
              after === before,
              `反向期望(计数不变)未成立：实际 ${before} → ${after} —— 这正是 T7-a 的区分力`,
            );
          },
        },
        {
          name: 'R-T7c 被拒的导出**会**写一条成功审计',
          claim: 'T7-c 的"不伪造成功审计"有区分力',
          fn: async () => {
            const before = auditCountStatic();
            const r = await http(`${BASE_URL}${SELF_EXPORT_PATH}?${windowQs}`, {
              headers: { Authorization: `Bearer ${tokens.storeA}` },
            });
            assert(r.status === 403, `前置失败：门店角色竟未被拒（${r.status}）`);
            const after = auditCountStatic();
            assert(
              after > before,
              `反向期望(审计增加)未成立：实际 ${before} → ${after} —— 这正是 T7-c 的区分力`,
            );
          },
        },
        {
          name: 'R-T3b 平台超管读原生列表 → 403（把"拒绝"扩大成整体封禁是错的）',
          claim: 'T3-c 的"拒绝只针对导出能力"有区分力',
          fn: async () => {
            const r = await http(`${BASE_URL}/api/serviceTickets:list?pageSize=1`, {
              headers: { Authorization: `Bearer ${tokens.admin}` },
            });
            assert(
              r.status === 403,
              `反向期望(403)未成立：实际 ${r.status} —— 这正是 T3-c 的区分力（拒绝不是"把超管整体封了"）`,
            );
          },
        },
      ];

      for (const item of redExpectations) {
        await checkAsync(item.name, async () => {
          let wentRed = false;
          let detail = '';
          try {
            await item.fn();
          } catch (error) {
            wentRed = true;
            detail = error?.message ?? String(error);
          }
          assert(wentRed, `⚠️ 反向期望竟然**成立**了 —— 说明「${item.claim}」不成立`);
          return `已按预期变红（${item.claim}）· ${detail.slice(0, 80)}`;
        });
      }
    }
  } finally {
    for (const id of fixtures) {
      try {
        const r = cleanupTicket(id);
        console.log(`  · 已清理 ticket #${id}（删文件 ${r.filesDeleted} / 附件 ${r.attachmentsDeleted}）`);
      } catch (error) {
        console.log(`  ⚠️ 清理 ticket #${id} 失败：${error?.message ?? String(error)}`);
      }
    }
  }

  summary();

  const evidenceDir = path.join(ROOT, '.tmp-verify');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidence = {
    run_id: RUN_ID,
    mode: REVERSE ? 'reverse' : 'normal',
    at: new Date().toISOString(),
    base_url: BASE_URL,
    passed: state.passed,
    failed: state.failures.length,
    failures: state.failures,
  };
  const evidencePath = path.join(evidenceDir, `native-export-bypass-${RUN_ID}.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`  证据：${path.relative(ROOT, evidencePath)}`);
  console.log(`  共 ${state.passed} 通过 / ${state.failures.length} 失败\n`);

  if (state.failures.length > 0) process.exitCode = 1;
}

/** 反向模式用的审计计数（夹具生命周期之外，纯读） */
function auditCountStatic() {
  return Number(psqlScalar('SELECT count(*) FROM export_audits'));
}

runMain({
  name: REVERSE
    ? 'verify-native-export-bypass（反向验证：每条都必须变红）'
    : 'verify-native-export-bypass（P9 / D3 七条重门禁）',
  main,
  cleanup: () => {},
});
