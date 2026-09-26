#!/usr/bin/env node
/**
 * verify-report-kpi.mjs —— Phase 9 的**重门禁**：HQ 看板（I15）与 12 项 KPI（I16）
 * =============================================================================
 *
 * 为什么这个门禁必须存在（而不是"跑一次接口看看返回什么"）
 * -----------------------------------------------------------------------------
 * 报表类交付有三种**看起来对、实际错**的形状，而且都不报错：
 *
 *   ① **口径漂移**：报表自己又算了一遍"逾期"（`expected_visit_at < now`），
 *      与 Phase 8 的 `runSlaScan` 在边界上差一天 —— 看板显示 14、明细列出 13。
 *      ⇒ 本门禁断言 **明细计数 == SLA 计数**，并做**源码级**"第二处谓词不存在"扫描。
 *   ② **分母不是同一个集合**：12 个指标各算各的分母，于是"超时率 34%"用的分母
 *      与旁边的"样本数 41"不是一回事，报表整体不可解释。
 *      ⇒ 断言 `denominator + extra.excluded === sampleSize` 这类**恒等式**。
 *   ③ **范围裁剪只做在一处**：聚合裁了、明细没裁 ⇒ 门店角色能从明细读到别店工单号。
 *      ⇒ 断言门店 actor 的明细项**逐个**属于本店。
 *
 * ⚠️ 本文件是**只读门禁**：不建夹具、不写业务数据（导出审计由
 *    `verify-native-export-bypass.mjs` 负责）。因此它可以在任意时刻重跑。
 *
 * -----------------------------------------------------------------------------
 * 反向验证（`--reverse`，铁律 8："断言不会变红 = 没有断言"）
 * -----------------------------------------------------------------------------
 * 以**故意写错的期望**重放，要求**每一条都必须变红**。
 * 例：`R-D7` 断言"`fromIso` 是 UTC 午夜"——它必须失败，因为事实上是
 * 东八区午夜（`T16:00:00.000Z` 前一天）。若它**通过**，说明日期语义那条断言
 * 抓不住 DEV-71 那个坑（它正是"用 DB 归一化 12:00 / UTC 日界"一类漂移的入口）。
 *
 * -----------------------------------------------------------------------------
 * 前置 / 副作用 / 退出码
 * -----------------------------------------------------------------------------
 *   · `.env` 需要 `UAT_STORE_A_PASSWORD` / `UAT_HQ_PASSWORD` / `UAT_VIEWER_PASSWORD`
 *     / `UAT_HQADMIN_PASSWORD`（先跑 `node scripts/uat-accounts.mjs --create`）
 *   · **无副作用**：只读接口 + 只读 SQL
 *   · 证据落 `.tmp-verify/report-kpi-<run_id>.json`（带 run_id，防"同一条命令跑两遍"覆盖）
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

const { checkAsync, summary, state } = makeChecker({ heading: 'P9 看板 / KPI' });

const DASHBOARD_PATH = '/api/svc/dashboard/summary';
const KPI_PATH = '/api/svc/reports/kpi';
const WIDE = 'from=2020-01-01&to=2030-12-31';

/**
 * 三个 SLA 阈值的**配置键字面量**。
 *
 * ⚠️ 只取"带 `sla.` 前缀的配置键"，**不要**写成 `accept_minutes` / `storeConfirmHours`
 *    这种裸名字：
 *      · 裸 `accept_minutes` 会连 `appointment_overdue_grace_minutes` 的语义边界一起扫进来；
 *      · `storeConfirmHours` 是**对象属性名**（`sla.thresholds.storeConfirmHours`），
 *        它在 `report-kpi.ts` 里被合法引用（只是读取已算好的阈值，不是自己算逾期）
 *        ⇒ 用它当锚点会把一个**正确**的实现判红。
 */
const SLA_THRESHOLD_LITERALS = [
  'sla.accept_minutes',
  'sla.appointment_overdue_grace_minutes',
  'sla.store_confirm_hours',
];

/**
 * SRC-1 的**唯一允许命中集**。
 * 正向断言 = "命中集 ⊆ 这个集合"；反向断言 = "存在集合外的命中"。
 * ⚠️ 正向与反向必须共用这一个常量：首跑反向时我另写了一版"文件数 ≥2"，结果
 *    `constants.ts` + `sla-scan-scheduler.ts` 本来就是 2 个文件 ⇒ 反向**恒成立**
 *    ⇒ 反向门禁永远变红、看起来"通过"，其实毫无区分力（假绿）。
 *    反向断言的正确写法只有一个：**否定正向那条判据本身**。
 */
const SLA_THRESHOLD_ALLOWED = ['constants.ts', 'services/sla-scan-scheduler.ts'];

/**
 * SRC-2 的锚点必须是**构造式** `23:59:59.999`，不能是裸 `23:59:59`。
 * 裸串会被 `constants.ts` 里那句给运维看的说明文案（"当天 23:59:59"）命中 ⇒ 自造假红。
 * `END_OF_DAY_ALLOWED` 同理是正向的唯一允许命中集，反向取它的否定。
 */
const END_OF_DAY_ANCHOR = '23:59:59.999';
const END_OF_DAY_ALLOWED = ['services/sla-scan-scheduler.ts'];

/**
 * SRC-2 反向用的"第二实现文件"探针。
 * 正向的判据是"命中集恰好 == END_OF_DAY_ALLOWED"，它的否命题是
 * "命中集里多出一个别的文件" —— 历史上多出来的那个文件正是 `report-kpi.ts`
 * （它以前自己定义了一份 `endOfLocalDay`）。反向就断言这个文件必须命中。
 */
const END_OF_DAY_REGROWTH_PROBE = 'services/report-kpi.ts';

// ---------------------------------------------------------------------------
// 源码级检查用的小工具
// ---------------------------------------------------------------------------
const SERVER_SRC = path.join(ROOT, 'nocobase', 'plugins', 'service-ticket', 'src', 'server');

function walkTs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** 剥块注释与整行 `//`（**不剥行尾注释**，避免把 `https://` 切坏） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 再剥掉**单/双引号字符串字面量**（保留反引号模板）。
 *
 * 为什么需要它（首跑的一条假红）：本项目的响应里刻意带 `caveat` 文案，
 * 例如 `extra.caveat = '禁止用 expected_visit_at < now 复算（DEV-71）'`。
 * 那是**说明**，不是谓词；不剥字符串就会把说明当成实现判红 —— 而"假红"
 * 的代价是让人开始不信任断言（见 `docs/ENGINEERING-RULES.md`）。
 *
 * ⚠️ **刻意保留反引号模板**：SQL 写在模板里（`SAMPLE_CTE` 等）。
 *    如果连模板一起剥，真写在 SQL 里的 `expected_visit_at <` 反而抓不到 ——
 *    那就把假红换成了假绿，更糟。
 */
function stripStringLiterals(src) {
  return src.replace(/'(?:\\.|[^'\\\n])*'/g, "''").replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

function relative(file) {
  return path.relative(SERVER_SRC, file).replace(/\\/g, '/');
}

/** 在**已剥注释**的源码里找包含 needle 的文件（剥注释是必须的：本仓库大量用注释写口径） */
function filesContaining(needles) {
  const hits = new Set();
  for (const file of walkTs(SERVER_SRC)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    if (needles.some((n) => src.includes(n))) hits.add(relative(file));
  }
  return [...hits].sort();
}

function readJson(r) {
  assert(r.status === 200, `HTTP ${r.status} ${errorMessageOf(r)}`);
  const data = r.json?.data;
  assert(data && typeof data === 'object', `响应缺少 data：${r.body.slice(0, 200)}`);
  return data;
}

function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `YYYY-MM-DD` 在东八区的当日 00:00 → ISO（前一天的 16:00Z） */
function localMidnightIso(dateOnly) {
  return new Date(`${dateOnly}T00:00:00.000+08:00`).toISOString();
}

function addDays(dateOnly, days) {
  const base = new Date(`${dateOnly}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const passwords = {
    storeA: envValue('UAT_STORE_A_PASSWORD'),
    hq: envValue('UAT_HQ_PASSWORD'),
    viewer: envValue('UAT_VIEWER_PASSWORD'),
    hqadmin: envValue('UAT_HQADMIN_PASSWORD'),
  };
  const missing = Object.entries(passwords)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new EnvNotReady(
      `.env 缺口令：${missing.join(', ')} —— 先跑 node scripts/uat-accounts.mjs --create`,
    );
  }

  const health = await http(`${BASE_URL}/api/svc/health`);
  if (health.status !== 200) throw new EnvNotReady(`应用未就绪（/api/svc/health → ${health.status}）`);

  const tokens = {};
  for (const [key, email] of Object.entries({
    storeA: 'uat.store.a@svc.local',
    hq: 'uat.hq@svc.local',
    viewer: 'uat.viewer@svc.local',
    hqadmin: 'uat.hqadmin@svc.local',
  })) {
    const t = await signIn(email, passwords[key]);
    if (!t) throw new EnvNotReady(`${email} 登录失败（口令可能已轮换）`);
    tokens[key] = t;
  }

  const auth = (key) => ({ Authorization: `Bearer ${tokens[key]}` });
  const dash = async (qs, key) => http(`${BASE_URL}${DASHBOARD_PATH}?${qs}`, { headers: auth(key) });
  const kpi = async (qs, key) => http(`${BASE_URL}${KPI_PATH}?${qs}`, { headers: auth(key) });

  const storeIdS01 = Number(psqlScalar(`SELECT id FROM stores WHERE code = 'S01'`));
  console.log(`\n【环境】4 个身份就绪 · S01 = store#${storeIdS01}`);

  const today = localToday();

  // 看板与报表各取一次（宽窗口），后续断言复用
  let dashboard = null;
  let kpiResult = null;

  if (!REVERSE) {
    // =====================================================================
    console.log('\n【I15】HQ 看板聚合');
    // =====================================================================
    await checkAsync('I15-1 总部账号调看板 → 200，结构与窗口齐备', async () => {
      dashboard = readJson(await dash(WIDE, 'hq'));
      for (const key of ['window', 'filters', 'totals', 'overdue', 'breakdown']) {
        assert(key in dashboard, `响应缺 ${key}`);
      }
      assert(typeof dashboard.totals.tickets === 'number', 'totals.tickets 不是数字');
      assert(dashboard.window.from === '2020-01-01', `window.from 回显错误：${dashboard.window.from}`);
      assert(dashboard.window.to === '2030-12-31', `window.to 回显错误：${dashboard.window.to}`);
      return `tickets=${dashboard.totals.tickets} · overdue=${JSON.stringify(
        { a: dashboard.overdue.acceptance, p: dashboard.overdue.appointment, s: dashboard.overdue.storeConfirm },
      )}`;
    });

    await checkAsync('I15-2 totals.tickets 与库内同窗口计数一致（看板数字不是"估出来的"）', async () => {
      const { fromIso, toIso } = dashboard.window;
      const dbCount = Number(
        psqlScalar(
          `SELECT count(*) FROM service_tickets WHERE created_at >= '${fromIso}'::timestamptz ` +
            `AND created_at < '${toIso}'::timestamptz`,
        ),
      );
      assert(
        dbCount === dashboard.totals.tickets,
        `库里 ${dbCount} 张 ≠ 看板 ${dashboard.totals.tickets} 张（窗口 ${fromIso}→${toIso}）`,
      );
      return `${dbCount} 张一致`;
    });

    await checkAsync('I15-3 状态分桶自洽：6 个命名状态 + 未命名状态 == tickets', async () => {
      const t = dashboard.totals;
      const named = t.new + t.processing + t.waitStoreConfirm + t.waitFeedback + t.closed + t.cancelled;
      assert(named <= t.tickets, `命名状态之和(${named}) 竟大于总数(${t.tickets})`);
      // 差额必须正好等于"表里存在但看板不单列"的状态数 —— 这样"少了"就会被抓住，
      // 而"多算"也会被抓（与库对不上）。
      const other = Number(
        psqlScalar(
          `SELECT count(*) FROM service_tickets WHERE created_at >= '${dashboard.window.fromIso}'::timestamptz ` +
            `AND created_at < '${dashboard.window.toIso}'::timestamptz ` +
            `AND status::text NOT IN ('NEW','PROCESSING','WAIT_STORE_CONFIRM','WAIT_FEEDBACK','CLOSED','CANCELLED')`,
        ),
      );
      assert(
        t.tickets - named === other,
        `未命名状态差额 ${t.tickets - named} ≠ 库里非六态计数 ${other}（状态枚举与看板分桶可能已脱节）`,
      );
      return `命名 ${named} + 未命名 ${other} = ${t.tickets}`;
    });

    await checkAsync('I15-4 breakdown.store 之和 == totals.tickets（按维度分组没漏行）', async () => {
      const sum = Object.values(dashboard.breakdown.store).reduce((a, b) => a + b, 0);
      assert(
        sum === dashboard.totals.tickets,
        `store 维度之和 ${sum} ≠ totals.tickets ${dashboard.totals.tickets}`,
      );
      const modeSum = Object.values(dashboard.breakdown.serviceMode).reduce((a, b) => a + b, 0);
      assert(modeSum === dashboard.totals.tickets, `serviceMode 维度之和 ${modeSum} ≠ ${dashboard.totals.tickets}`);
      return `store keys=[${Object.keys(dashboard.breakdown.store).join(',')}]`;
    });

    await checkAsync('I15-5 超时计数来自 SLA（thresholds 与 service_settings 逐项一致）', async () => {
      const rows = psqlRows(`SELECT key, value FROM service_settings WHERE key LIKE 'sla%'`);
      const db = Object.fromEntries(rows.map((r) => [r[0], Number(r[1])]));
      const th = dashboard.overdue.thresholds;
      assert(th && typeof th === 'object', '响应缺 overdue.thresholds');
      assert(
        th.acceptMinutes === db['sla.accept_minutes'],
        `acceptMinutes ${th.acceptMinutes} ≠ 库内 ${db['sla.accept_minutes']}`,
      );
      assert(
        th.graceMinutes === db['sla.appointment_overdue_grace_minutes'],
        `graceMinutes ${th.graceMinutes} ≠ 库内 ${db['sla.appointment_overdue_grace_minutes']}`,
      );
      assert(
        th.storeConfirmHours === db['sla.store_confirm_hours'],
        `storeConfirmHours ${th.storeConfirmHours} ≠ 库内 ${db['sla.store_confirm_hours']}`,
      );
      assert(dashboard.overdue.countsScope === 'global', `countsScope 应为 global，实际 ${dashboard.overdue.countsScope}`);
      assert(typeof dashboard.overdue.scannedAt === 'string', 'overdue.scannedAt 缺失（无法判断这是哪一刻的事实）');
      return `${JSON.stringify(th)} · countsScope=global`;
    });

    await checkAsync('I15-6 范围隔离：门店 A 只看到本店，总部看到多家', async () => {
      const storeView = readJson(await dash(WIDE, 'storeA'));
      const keys = Object.keys(storeView.breakdown.store);
      assert(
        keys.length > 0 && keys.every((k) => k === String(storeIdS01)),
        `门店 A 的 store 维度应只有本店(${storeIdS01})，实际 [${keys.join(',')}]`,
      );
      const hqKeys = Object.keys(dashboard.breakdown.store);
      assert(
        hqKeys.length > keys.length,
        `总部应看到多于门店的维度（总部 [${hqKeys.join(',')}] vs 门店 [${keys.join(',')}]）`,
      );
      assert(
        storeView.totals.tickets < dashboard.totals.tickets,
        `门店可见 ${storeView.totals.tickets} 不应 ≥ 总部可见 ${dashboard.totals.tickets}`,
      );
      return `门店 [${keys.join(',')}]=${storeView.totals.tickets} · 总部 [${hqKeys.join(',')}]=${dashboard.totals.tickets}`;
    });

    await checkAsync('I15-7 匿名调看板 → 401（看板不是公开数据）', async () => {
      const r = await http(`${BASE_URL}${DASHBOARD_PATH}?${WIDE}`);
      assert(r.status === 401, `应 401，实际 ${r.status}`);
      return '401';
    });

    await checkAsync('I15-8 viewer 也能看（"已登录即可"），但范围仍是 scope 裁的', async () => {
      const r = await dash(WIDE, 'viewer');
      assert(r.status === 200, `viewer 应 200，实际 ${r.status} ${errorMessageOf(r)}`);
      const view = readJson(r);
      const keys = Object.keys(view.breakdown.store);
      assert(keys.length > 0, 'viewer 的 store 维度为空（范围裁剪可能把全量裁成了空）');
      // 只断言"不比总部多" —— 具体是 global 还是按店，由 scopeOf 决定，不是本门禁的口径
      assert(
        keys.length <= Object.keys(dashboard.breakdown.store).length,
        `viewer 看到的维度(${keys.length}) 不应多于总部(${Object.keys(dashboard.breakdown.store).length})`,
      );
      return `viewer keys=[${keys.join(',')}]`;
    });

    await checkAsync('I15-9 非法 overdueKind → 422 INVALID_FILTER（不静默当没传）', async () => {
      const r = await dash(`${WIDE}&overdueKind=nonsense`, 'hq');
      assert(r.status === 422, `应 422，实际 ${r.status}`);
      assert(errorCodeOf(r) === 'INVALID_FILTER', `错误码应为 INVALID_FILTER，实际 ${errorCodeOf(r)}`);
      return `422 ${errorCodeOf(r)}`;
    });

    // ---- 明细与 SLA 计数的一致性（契约 §5 的核心）----
    await checkAsync('I15-10 明细计数 == SLA 计数（global actor；两边同源）', async () => {
      // ⚠️ **并行取**两个接口：把两次扫描的时间差压到最小，避免"刚好在这 100ms 里
      //    有工单跨过阈值"造成的偶发不等。若真不相等，重取一次再判 —— 真的分叉会连错两次。
      const compare = async () => {
        const [d, k] = await Promise.all([
          dash(`${WIDE}&overdueKind=acceptance&page=1&pageSize=3`, 'hq'),
          kpi(WIDE, 'hq'),
        ]);
        return { dd: readJson(d), kk: readJson(k) };
      };
      let { dd, kk } = await compare();
      const rateItem = (k) => (k.kpis ?? []).find((x) => x.key === 'acceptanceOverdueRate');
      if (!rateItem(kk)) {
        ({ dd, kk } = await compare());
      }
      const detail = dd.overdueDetail;
      assert(detail, '未返回 overdueDetail（传了 overdueKind 却拿不到明细）');
      assert(detail.kind === 'acceptance', `detail.kind 应为 acceptance，实际 ${detail.kind}`);
      assert(
        detail.totalBasis === 'sla-count',
        `global actor 的 totalBasis 应为 sla-count（精确值），实际 ${detail.totalBasis}`,
      );
      assert(
        detail.total === dd.overdue.acceptance,
        `明细 total ${detail.total} ≠ 看板 overdue.acceptance ${dd.overdue.acceptance}`,
      );
      assert(
        detail.items.length <= detail.pageSize,
        `items ${detail.items.length} 超过 pageSize ${detail.pageSize}`,
      );
      assert(
        dd.overdue.acceptance > 0,
        '本次窗口内待受理超时为 0 —— 该断言失去区分力（等价于恒绿），需要一个非空窗口',
      );
      // 明细项形态（Phase 8 冻结的 SlaOverdueFact，**不含 store_id**）
      for (const it of detail.items) {
        const keys = Object.keys(it).sort();
        assert(
          JSON.stringify(keys) === JSON.stringify(['dueFrom', 'kind', 'ticketId', 'ticketNo', 'visitId']),
          `明细项字段与 SlaOverdueFact 不一致：${keys.join(',')}`,
        );
        assert(it.kind === 'acceptance', `明细项 kind=${it.kind}`);
      }
      // 报表侧的同一个数字（`extra.numerator`）必须也等于它 —— 三处一个数
      const rate = rateItem(kk);
      assert(rate, 'KPI 缺 acceptanceOverdueRate');
      assert(
        rate.extra?.numerator === dd.overdue.acceptance,
        `KPI 报表里的超时分子(${rate.extra?.numerator}) ≠ 看板(${dd.overdue.acceptance})`,
      );
      return `明细 ${detail.total} == 看板 ${dd.overdue.acceptance} == 报表 ${rate.extra?.numerator} · items=${detail.items.length}`;
    });

    await checkAsync('I15-11 门店 actor 的明细**逐条**属于本店，且 totalBasis 显式降级', async () => {
      const r = await dash(`${WIDE}&overdueKind=acceptance&page=1&pageSize=50`, 'storeA');
      const d = readJson(r);
      const detail = d.overdueDetail;
      assert(detail, '门店账号拿不到 overdueDetail');
      assert(
        detail.totalBasis === 'visible-items',
        `非 global actor 的 totalBasis 应为 visible-items（"可见条数下界"），实际 ${detail.totalBasis}`,
      );
      if (detail.items.length > 0) {
        const ids = detail.items.map((x) => x.ticketId);
        const foreign = Number(
          psqlScalar(
            `SELECT count(*) FROM service_tickets WHERE id IN (${ids.join(',')}) AND store_id <> ${storeIdS01}`,
          ),
        );
        assert(foreign === 0, `⚠️ 门店 A 的明细里混进了 ${foreign} 条别店工单（越权）`);
      }
      return `items=${detail.items.length} 全部属于 store#${storeIdS01} · basis=${detail.totalBasis}`;
    });

    await checkAsync('I15-12 明细分页稳定：page1 与 page2 不重叠，total 不变', async () => {
      const [p1, p2] = await Promise.all([
        dash(`${WIDE}&overdueKind=acceptance&page=1&pageSize=3`, 'hq'),
        dash(`${WIDE}&overdueKind=acceptance&page=2&pageSize=3`, 'hq'),
      ]);
      const a = readJson(p1).overdueDetail;
      const b = readJson(p2).overdueDetail;
      assert(a.total === b.total, `两页的 total 应一致（${a.total} vs ${b.total}）`);
      const ida = a.items.map((x) => x.ticketId);
      const idb = b.items.map((x) => x.ticketId);
      const overlap = ida.filter((x) => idb.includes(x));
      assert(overlap.length === 0, `两页出现重复项：${overlap.join(',')}`);
      return `p1=[${ida.join(',')}] p2=[${idb.join(',')}]`;
    });

    // =====================================================================
    console.log('\n【I16】12 项 KPI 报表');
    // =====================================================================
    await checkAsync('I16-1 总部账号调报表 → 200；恰好 12 项且 key 顺序稳定', async () => {
      kpiResult = readJson(await kpi(WIDE, 'hq'));
      const keys = kpiResult.kpis.map((x) => x.key);
      assert(keys.length === 12, `KPI 应为 12 项，实际 ${keys.length}`);
      const expected = await readKpiKeysFromSource();
      assert(
        JSON.stringify(keys) === JSON.stringify(expected),
        `KPI key 顺序与源码不一致：\n  接口 ${keys.join(',')}\n  源码 ${expected.join(',')}`,
      );
      assert(kpiResult.sampleSize > 0, 'sampleSize 为 0（窗口内没有样本，后续断言全部失去意义）');
      return `${keys.length} 项 · sampleSize=${kpiResult.sampleSize}`;
    });

    await checkAsync('I16-2 每项都自证口径（label/value/unit/denominator/basis/source）', async () => {
      for (const item of kpiResult.kpis) {
        assert(typeof item.label === 'string' && item.label.length > 0, `${item.key} 缺 label`);
        assert(
          item.value === null || Number.isFinite(item.value),
          `${item.key} 的 value 既不是 null 也不是有限数：${JSON.stringify(item.value)}`,
        );
        assert(
          ['minutes', 'ratio', 'score', 'count', 'CNY'].includes(item.unit),
          `${item.key} 的 unit 非法：${item.unit}`,
        );
        assert(Number.isFinite(item.denominator), `${item.key} 缺 denominator`);
        assert(
          item.basis === 'field',
          `${item.key} 的 basis 应为 field（字段口径，契约 §4 C3），实际 ${item.basis}`,
        );
        assert(
          typeof item.source === 'string' && item.source.length > 0,
          `${item.key} 缺 source（"注释不是证据"的反面：这里必须给可复算的字段名）`,
        );
      }
      return '12 项全部齐备';
    });

    await checkAsync('I16-3 分母恒等式：firstResponse / closeDuration 的排除数可解释', async () => {
      const byKey = Object.fromEntries(kpiResult.kpis.map((x) => [x.key, x]));
      const fr = byKey.firstResponseMinutes;
      assert(
        fr.denominator + Number(fr.extra?.excluded ?? NaN) === kpiResult.sampleSize,
        `firstResponse：分母 ${fr.denominator} + 排除 ${fr.extra?.excluded} ≠ sampleSize ${kpiResult.sampleSize}`,
      );
      const cd = byKey.closeDurationMinutes;
      assert(
        cd.denominator + Number(cd.extra?.excludedOtherStatus ?? NaN) === kpiResult.sampleSize,
        `closeDuration：分母 ${cd.denominator} + 排除 ${cd.extra?.excludedOtherStatus} ≠ sampleSize ${kpiResult.sampleSize}`,
      );
      return `fr ${fr.denominator}+${fr.extra?.excluded} · cd ${cd.denominator}+${cd.extra?.excludedOtherStatus}`;
    });

    await checkAsync('I16-4 比率型：分母为 0 ⇔ value 为 null（DEV-89 同类形态，0 与"无样本"不可混）', async () => {
      const ratios = kpiResult.kpis.filter((x) => x.unit === 'ratio');
      assert(ratios.length >= 4, `比率型指标不足（实际 ${ratios.length}）—— 判据可能已失效`);
      for (const item of ratios) {
        if (item.denominator <= 0) {
          assert(
            item.value === null,
            `${item.key} 分母为 0 时 value 必须是 null（不能是 0），实际 ${JSON.stringify(item.value)}`,
          );
        } else {
          assert(item.value !== null, `${item.key} 有 ${item.denominator} 个样本，value 不该是 null`);
          assert(
            item.value >= 0 && item.value <= 1,
            `${item.key} 比率越界：${item.value}`,
          );
        }
      }
      return `${ratios.length} 项比率全部自洽`;
    });

    await checkAsync('I16-5 工单集派生的分母不得超过样本集；visit/sms 派生项显式标注来源', async () => {
      // 🔴 这条**不能写成"所有指标的分母 ≤ sampleSize"** —— 那是错的，会变成自造假红：
      //    · `smsSubmitSuccessRate` 的分母是 `sms_logs` **行数**（一张单可发多条短信）；
      //    · `chargeMismatchRate` 的分母是 `service_visits` **行数**（一张单可多次派工）。
      //    实测样本 41 张单时短信分母 45，**大于** sampleSize 且完全正确。
      //    若拿"≤ sampleSize"去卡，第一次跑就会红在一个**正确**的实现上。
      // ⇒ 判据按口径分两组：工单集派生的必须 ≤ sampleSize；行集派生的只要求
      //    `extra.numerator` 自洽 + `source` 明确写到那张表。
      const TICKET_SCOPED = [
        'firstResponseMinutes',
        'closeDurationMinutes',
        'acceptanceOverdueRate',
        'reviewParticipationRate',
        'avgRating',
        'reopenRate',
      ];
      const ROW_SCOPED = {
        smsSubmitSuccessRate: 'sms_logs',
        chargeMismatchRate: 'service_visits',
      };
      const byKey = Object.fromEntries(kpiResult.kpis.map((x) => [x.key, x]));
      for (const key of TICKET_SCOPED) {
        const item = byKey[key];
        assert(item, `KPI 缺 ${key}`);
        assert(
          item.denominator <= kpiResult.sampleSize,
          `${key} 的分母 ${item.denominator} 大于样本集 ${kpiResult.sampleSize}（工单集派生却越界）`,
        );
      }
      assert(
        byKey.serviceModeDistribution.denominator === kpiResult.sampleSize,
        `serviceModeDistribution 的分母应恰好等于样本集（${byKey.serviceModeDistribution.denominator} vs ${kpiResult.sampleSize}）`,
      );
      for (const [key, table] of Object.entries(ROW_SCOPED)) {
        const item = byKey[key];
        assert(item, `KPI 缺 ${key}`);
        assert(
          item.source.includes(table),
          `${key} 的分母来自 ${table}，source 却写的是 ${JSON.stringify(item.source)}（口径说不清）`,
        );
        assert(
          Number.isFinite(item.extra?.numerator),
          `${key} 缺 extra.numerator（分子不可核）`,
        );
      }
      return `${TICKET_SCOPED.length} 项 ≤ ${kpiResult.sampleSize} · ${
        Object.keys(ROW_SCOPED).length
      } 项按行集（短信 ${byKey.smsSubmitSuccessRate.denominator} / Visit ${byKey.chargeMismatchRate.denominator}）`;
    });

    await checkAsync('I16-6 评分 / 收费金额落在业务值域内', async () => {
      const byKey = Object.fromEntries(kpiResult.kpis.map((x) => [x.key, x]));
      const rating = byKey.avgRating;
      if (rating.value !== null) {
        assert(rating.value >= 1 && rating.value <= 6, `平均评分越界：${rating.value}`);
      }
      const charge = byKey.confirmedChargeAmount;
      if (charge.value !== null) {
        assert(charge.value >= 0, `确认收费金额为负：${charge.value}`);
      }
      const mismatch = byKey.chargeMismatchRate;
      if (mismatch.value !== null) {
        assert(mismatch.value >= 0 && mismatch.value <= 1, `收费不一致率越界：${mismatch.value}`);
      }
      return `rating=${rating.value} charge=${charge.value} mismatch=${mismatch.value}`;
    });

    await checkAsync('I16-7 处理方式分布可复算（分布之和 == 样本集；unknown 桶 == 库内 NULL）', async () => {
      const item = kpiResult.kpis.find((x) => x.key === 'serviceModeDistribution');
      assert(item, 'KPI 缺 serviceModeDistribution');
      const dist = item.extra?.distribution ?? null;
      assert(
        dist && typeof dist === 'object',
        `serviceModeDistribution 没有分布明细（extra=${JSON.stringify(item.extra)}）`,
      );
      const values = Object.values(dist).filter((v) => typeof v === 'number');
      assert(values.length > 0, '分布明细里没有数字');
      const sum = values.reduce((a, b) => a + b, 0);
      // ⚠️ 判据修正（首跑踩过）：分母是**整个样本集**，不是"service_mode 非空的行数"。
      //    `service_mode IS NULL` 的行会被归进 `unknown` 桶
      //    （`modeDistribution[String(row.service_mode ?? 'unknown')]`），
      //    所以"分布之和 == 非空计数"这条写法会把一个**正确**的实现判红。
      assert(
        sum === kpiResult.sampleSize,
        `分布之和 ${sum} ≠ 样本集 ${kpiResult.sampleSize}（有行没被分到任何桶）`,
      );
      assert(
        item.value === kpiResult.sampleSize,
        `serviceModeDistribution.value ${item.value} 应等于样本集 ${kpiResult.sampleSize}`,
      );
      // 再核一次 NULL 桶 —— 这条才咬得住"桶标签写对了但归并错"的情况
      const dbNull = Number(
        psqlScalar(
          `SELECT count(*) FROM service_tickets WHERE created_at >= '${kpiResult.window.fromIso}'::timestamptz ` +
            `AND created_at < '${kpiResult.window.toIso}'::timestamptz AND service_mode IS NULL`,
        ),
      );
      assert(
        Number(dist.unknown ?? 0) === dbNull,
        `分布里的 unknown 桶 ${dist.unknown ?? 0} ≠ 库内 service_mode IS NULL ${dbNull}`,
      );
      return `分布之和 ${sum} == 样本集 · unknown ${dist.unknown ?? 0} == 库内 NULL`;
    });

    await checkAsync('I16-8 窗口口径与看板一致（同参数两接口 window 必须相同）', async () => {
      const same = await dash(WIDE, 'hq');
      const a = readJson(same).window;
      const b = kpiResult.window;
      assert(
        JSON.stringify(a) === JSON.stringify(b),
        `两个接口的 window 不一致：\n  看板 ${JSON.stringify(a)}\n  报表 ${JSON.stringify(b)}`,
      );
      return `${b.from}→${b.to} · ${b.fromIso}→${b.toIso}`;
    });

    await checkAsync('I16-9 日期语义（DEV-71 边界）：按天 ⇒ 东八区日界，不是 UTC 午夜', async () => {
      const r = await kpi(`from=${today}&to=${today}`, 'hq');
      const w = readJson(r).window;
      assert(w.from === today && w.to === today, `单日窗口回显应为 ${today}，实际 ${w.from}→${w.to}`);
      const expectFrom = localMidnightIso(today);
      const expectTo = localMidnightIso(addDays(today, 1));
      assert(
        w.fromIso === expectFrom,
        `fromIso 应为东八区当日 00:00（${expectFrom}），实际 ${w.fromIso}`,
      );
      assert(
        w.toIso === expectTo,
        `toIso 应为次日 00:00（${expectTo} = 按天闭区间的半开上界），实际 ${w.toIso}`,
      );
      assert(
        !w.fromIso.endsWith('T00:00:00.000Z') || expectFrom.endsWith('T16:00:00.000Z'),
        '日期语义疑似被当成了 UTC 午夜',
      );
      return `${w.fromIso} → ${w.toIso}（东八区日界 + 半开上界）`;
    });

    await checkAsync('I16-10 缺 from/to → 422 MISSING_DATE_RANGE（报表不做"悄悄最近 30 天"）', async () => {
      const r = await kpi('storeId=', 'hq');
      assert(r.status === 422, `应 422，实际 ${r.status}：${r.body.slice(0, 160)}`);
      assert(
        errorCodeOf(r) === 'MISSING_DATE_RANGE',
        `错误码应为 MISSING_DATE_RANGE，实际 ${errorCodeOf(r)}`,
      );
      return `422 ${errorCodeOf(r)}`;
    });

    await checkAsync('I16-11 非法日期 → 422 INVALID_DATE_RANGE（不静默兜底）', async () => {
      const r = await kpi('from=not-a-date&to=2030-12-31', 'hq');
      assert(r.status === 422, `应 422，实际 ${r.status}`);
      assert(
        errorCodeOf(r) === 'INVALID_DATE_RANGE',
        `错误码应为 INVALID_DATE_RANGE，实际 ${errorCodeOf(r)}`,
      );
      return `422 ${errorCodeOf(r)}`;
    });

    await checkAsync('I16-12 权限：报表是 PRIVILEGED，不是"登录即可"', async () => {
      const cases = [
        ['storeA', 403],
        ['viewer', 403],
        ['hq', 200],
        ['hqadmin', 200],
      ];
      const seen = [];
      for (const [key, want] of cases) {
        const r = await kpi(WIDE, key);
        assert(
          r.status === want,
          `${key} 调报表应 ${want}，实际 ${r.status} ${errorMessageOf(r)}`,
        );
        if (want === 403) {
          assert(
            String(r.body).length < 2000,
            `${key} 的 403 响应体过大（疑似把数据一起回了）`,
          );
        }
        seen.push(`${key}:${r.status}`);
      }
      return seen.join(' ');
    });

    await checkAsync('I16-13 匿名调报表 → 401', async () => {
      const r = await http(`${BASE_URL}${KPI_PATH}?${WIDE}`);
      assert(r.status === 401, `应 401，实际 ${r.status}`);
      return '401';
    });

    await checkAsync('I16-14 门店维度筛选生效（storeId 收窄样本集）', async () => {
      const scoped = readJson(await kpi(`${WIDE}&storeId=${storeIdS01}`, 'hq'));
      assert(
        scoped.sampleSize <= kpiResult.sampleSize,
        `按 storeId 筛选后样本数 ${scoped.sampleSize} 竟大于全量 ${kpiResult.sampleSize}`,
      );
      const dbScoped = Number(
        psqlScalar(
          `SELECT count(*) FROM service_tickets WHERE created_at >= '${kpiResult.window.fromIso}'::timestamptz ` +
            `AND created_at < '${kpiResult.window.toIso}'::timestamptz AND store_id = ${storeIdS01}`,
        ),
      );
      assert(
        scoped.sampleSize === dbScoped,
        `storeId 筛选后样本数 ${scoped.sampleSize} ≠ 库内 ${dbScoped}`,
      );
      return `全量 ${kpiResult.sampleSize} → store#${storeIdS01} ${scoped.sampleSize}`;
    });

    // =====================================================================
    console.log('\n【SRC】单一事实源（超时口径只有一处实现）');
    // =====================================================================
    await checkAsync('SRC-1 三个 SLA 阈值字面量只出现在"常量种子 + SLA 调度器"（其余文件 0 命中）', async () => {
      const hits = filesContaining(SLA_THRESHOLD_LITERALS);
      const allowed = SLA_THRESHOLD_ALLOWED;
      const extra = hits.filter((f) => !allowed.includes(f));
      assert(
        extra.length === 0,
        `以下文件也在读 SLA 阈值（第二处口径的入口）：${extra.join(', ')}`,
      );
      for (const need of allowed) {
        assert(hits.includes(need), `连 ${need} 都没命中 —— 扫描判据可能已失效（假绿）`);
      }
      return `命中 ${hits.join(' , ')}`;
    });

    await checkAsync('SRC-2 "当地日期末尾"的**构造式**只有一个实现（不再有两份副本）', async () => {
      // ⚠️ 锚点必须是**构造式** `23:59:59.999`，不能是裸 `23:59:59`。
      //    首跑就踩了：`constants.ts` 里那条 SLA 宽限设置的**说明文案**写着
      //    "预计上门日期结束（当天 23:59:59）后再宽限…" —— 那是给运维看的描述，
      //    不是第二份日期末尾实现。拿裸串去扫等于把"说明"判成"实现"（自造假红）。
      const hits = filesContaining([END_OF_DAY_ANCHOR]);
      assert(
        JSON.stringify(hits) === JSON.stringify(END_OF_DAY_ALLOWED),
        `"${END_OF_DAY_ANCHOR}" 应只在 ${END_OF_DAY_ALLOWED.join(', ')} 出现，实际：${hits.join(', ')}`,
      );
      // 判据不空转：导出后 report-kpi.ts 必须是**引用方**而非实现方
      const reportSrc = stripComments(
        fs.readFileSync(path.join(SERVER_SRC, 'services', 'report-kpi.ts'), 'utf8'),
      );
      assert(
        reportSrc.includes('endOfLocalDay') && !reportSrc.includes('function endOfLocalDay'),
        'report-kpi.ts 没有把日期末尾改成 import（副本可能又长回来了）',
      );
      return `${hits.join(', ')}（构造式单点）`;
    });

    await checkAsync('SRC-3 逾期纯函数被报表**复用**（import，不是重写）', async () => {
      const reportRaw = fs.readFileSync(path.join(SERVER_SRC, 'services', 'report-kpi.ts'), 'utf8');
      const reportSrc = stripComments(reportRaw);
      assert(
        /import\s*\{[\s\S]*?appointmentOverdueFrom[\s\S]*?\}\s*from\s*'\.\/sla-scan-scheduler'/.test(reportSrc),
        'report-kpi.ts 没有从 sla-scan-scheduler 复用 appointmentOverdueFrom',
      );
      assert(
        /appointmentOverdueFrom\(/.test(reportSrc),
        'report-kpi.ts 只是 import 了却没有调用（判据空转）',
      );
      assert(
        /endOfLocalDay/.test(reportSrc) && !/function endOfLocalDay/.test(reportSrc),
        'report-kpi.ts 自己又实现了一遍 endOfLocalDay（应 import）',
      );
      // 反向：报表文件里**不得**出现"直接比日期"的逾期谓词。
      // ⚠️ 必须先剥掉**字符串字面量**再扫（首跑踩过）：报表把口径写进响应
      //    （`extra.caveat = '禁止用 expected_visit_at < now 复算'`）——
      //    那是给读者的说明，不是谓词。不剥字符串就会把"说明"判成"实现"。
      //    而 SQL 在**反引号模板**里（如 SAMPLE_CTE），故只剥单/双引号，
      //    这样真写在 SQL 模板里的谓词仍然会被抓到。
      const codeOnly = stripStringLiterals(reportSrc);
      const forbidden = [
        /expected_visit_at\s*[<]/,
        /submitted_at\s*[<]/,
        /graceMinutes\s*\*\s*60/,
      ];
      for (const re of forbidden) {
        assert(!re.test(codeOnly), `report-kpi.ts 里出现了自制逾期谓词：${re}`);
      }
      return '复用 appointmentOverdueFrom / endOfLocalDay；代码层无自制谓词';
    });

    await checkAsync('SRC-4 范围裁剪只有一个来源（buildTicketScope 单点定义，导出复用）', async () => {
      const definers = filesContaining(['export function buildTicketScope']);
      assert(
        JSON.stringify(definers) === JSON.stringify(['services/report-kpi.ts']),
        `buildTicketScope 应在 report-kpi.ts 单点定义，实际：${definers.join(', ')}`,
      );
      const exportSrc = stripComments(
        fs.readFileSync(path.join(SERVER_SRC, 'services', 'export-service.ts'), 'utf8'),
      );
      assert(
        /buildTicketScope/.test(exportSrc),
        'export-service.ts 没有复用 buildTicketScope（导出的范围可能与看板/报表不一致）',
      );
      assert(
        !/function buildTicketScope/.test(exportSrc),
        'export-service.ts 自己又定义了一个 buildTicketScope',
      );
      return '单点定义 + 导出复用';
    });

    await checkAsync('SRC-5 导出脱敏是"固定"的（不随 VIEW_RAW_MOBILE 放开 —— D3-a）', async () => {
      const src = stripComments(
        fs.readFileSync(path.join(SERVER_SRC, 'services', 'export-service.ts'), 'utf8'),
      );
      const projectValue = /function projectValue\([\s\S]*?\n\}/.exec(src)?.[0] ?? '';
      assert(projectValue.length > 0, '解析不出 projectValue（判据已失效，需修门禁）');
      assert(
        /column\.mobile[\s\S]{0,200}maskMobileText/.test(projectValue),
        'projectValue 对手机号列没有固定调用 maskMobileText',
      );
      assert(
        !/VIEW_RAW_MOBILE|view_raw_mobile|isHq\(|maskTicketForActor/.test(projectValue),
        'projectValue 里出现了角色判断 —— D3-a 要求导出**一律**脱敏，不看角色',
      );
      return '手机号列无条件 maskMobileText';
    });
  }

  // =======================================================================
  // 反向验证
  // =======================================================================
  if (REVERSE) {
    console.log('\n【反向验证】以下每条都**必须失败**；若某条通过，说明对应用断没有区分力');
    const wideDash = async () => readJson(await dash(WIDE, 'hq'));

    const redExpectations = [
      {
        name: 'R-D2 断言"看板 tickets == 999999"',
        claim: 'I15-2 的库内计数对齐有区分力',
        fn: async () => {
          const d = await wideDash();
          assert(d.totals.tickets === 999999, `反向期望(999999)未成立：实际 ${d.totals.tickets}`);
        },
      },
      {
        name: 'R-D5 断言"countsScope == local"',
        claim: 'I15-5 的 global 标注有区分力',
        fn: async () => {
          const d = await wideDash();
          assert(
            d.overdue.countsScope === 'local',
            `反向期望(local)未成立：实际 ${d.overdue.countsScope} —— 这正是 I15-5 的区分力`,
          );
        },
      },
      {
        name: 'R-D6 断言"门店 A 的 store 维度里含别店 2"',
        claim: 'I15-6 的范围隔离有区分力',
        fn: async () => {
          const d = readJson(await dash(WIDE, 'storeA'));
          assert(
            Object.keys(d.breakdown.store).includes('2'),
            `反向期望(含 store 2)未成立：实际 [${Object.keys(d.breakdown.store).join(',')}]`,
          );
        },
      },
      {
        name: 'R-K1 断言"KPI 只有 11 项"',
        claim: 'I16-1 的"恰好 12 项"有区分力',
        fn: async () => {
          const k = readJson(await kpi(WIDE, 'hq'));
          assert(k.kpis.length === 11, `反向期望(11 项)未成立：实际 ${k.kpis.length} 项`);
        },
      },
      {
        name: 'R-K10 断言"缺日期时报表返回 200"',
        claim: 'I16-10 的 422 有区分力',
        fn: async () => {
          const r = await kpi('storeId=', 'hq');
          assert(r.status === 200, `反向期望(200)未成立：实际 ${r.status} —— 这正是 I16-10 的区分力`);
        },
      },
      {
        name: 'R-K12 断言"门店账号能拿报表 200"',
        claim: 'I16-12 的 403 有区分力',
        fn: async () => {
          const r = await kpi(WIDE, 'storeA');
          assert(r.status === 200, `反向期望(200)未成立：实际 ${r.status} —— 这正是 I16-12 的区分力`);
        },
      },
      {
        name: 'R-K9 断言"fromIso 是 UTC 午夜（T00:00:00.000Z）"',
        claim: 'I16-9 的东八区日界有区分力（DEV-71 那道边界）',
        fn: async () => {
          const k = readJson(await kpi(`from=${today}&to=${today}`, 'hq'));
          assert(
            k.window.fromIso === `${today}T00:00:00.000Z`,
            `反向期望(UTC 午夜)未成立：实际 ${k.window.fromIso} —— 这正是 I16-9 的区分力`,
          );
        },
      },
      {
        name: 'R-S1 断言"存在 SLA_THRESHOLD_ALLOWED 之外的第二个消费方"',
        claim: 'SRC-1 的"单点消费"有区分力',
        fn: async () => {
          const hits = filesContaining(SLA_THRESHOLD_LITERALS);
          const extra = hits.filter((f) => !SLA_THRESHOLD_ALLOWED.includes(f));
          assert(
            extra.length > 0,
            `反向期望(存在集合外命中文件)未成立：命中集 ${JSON.stringify(hits)} ⊆ 允许集 —— 这正是 SRC-1 的区分力`,
          );
        },
      },
      {
        name: 'R-S2 断言"当地日期末尾出现第二份实现文件"',
        claim: 'SRC-2 的"单点实现"有区分力',
        fn: async () => {
          // ⚠️ 必须用与 SRC-2 相同的**构造式**锚点，并且断言的是"多出一个**文件**"，
          //    不是"出现次数 ≥2"：同一文件里出现 3 次是**正常**的（那正是单点实现），
          //    拿次数当判据会让这条反向断言恒成立 = 永远变红 = 假通过。
          const hits = filesContaining([END_OF_DAY_ANCHOR]);
          assert(
            hits.includes(END_OF_DAY_REGROWTH_PROBE),
            `反向期望(${END_OF_DAY_REGROWTH_PROBE} 也命中"${END_OF_DAY_ANCHOR}")未成立：实际命中集 ${JSON.stringify(hits)} —— 这正是 SRC-2 的区分力`,
          );
        },
      },
      {
        name: 'R-S5 断言"导出对手机号列放行原始值（随角色）"',
        claim: 'SRC-5 的 D3-a 固定脱敏有区分力',
        fn: async () => {
          const src = stripComments(
            fs.readFileSync(path.join(SERVER_SRC, 'services', 'export-service.ts'), 'utf8'),
          );
          const projectValue = /function projectValue\([\s\S]*?\n\}/.exec(src)?.[0] ?? '';
          assert(
            /VIEW_RAW_MOBILE/.test(projectValue),
            '反向期望(projectValue 含 VIEW_RAW_MOBILE)未成立：实际不含 —— 这正是 SRC-5 的区分力',
          );
        },
      },
      {
        name: 'R-D10 断言"明细计数 == SLA 计数 + 1"',
        claim: 'I15-10 的"两边同源"有区分力',
        fn: async () => {
          const r = readJson(await dash(`${WIDE}&overdueKind=acceptance&page=1&pageSize=3`, 'hq'));
          assert(
            r.overdueDetail.total === r.overdue.acceptance + 1,
            `反向期望(+1)未成立：实际 detail=${r.overdueDetail.total} sla=${r.overdue.acceptance}` +
              ` —— 这正是 I15-10 的区分力`,
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
        return `已按预期变红（${item.claim}）· ${String(detail).slice(0, 70)}`;
      });
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
  const evidencePath = path.join(evidenceDir, `report-kpi-${RUN_ID}.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`  证据：${path.relative(ROOT, evidencePath)}`);
  console.log(`  共 ${state.passed} 通过 / ${state.failures.length} 失败\n`);

  if (state.failures.length > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------
/** 从源码读 KPI_KEYS（**唯一事实来源**；与接口回显比对） */
async function readKpiKeysFromSource() {
  const src = fs.readFileSync(path.join(SERVER_SRC, 'services', 'report-kpi.ts'), 'utf8');
  const block = /export const KPI_KEYS:\s*string\[\]\s*=\s*\[([\s\S]*?)\]/.exec(src);
  assert(block, '从 report-kpi.ts 里解析不出 KPI_KEYS（判据已失效，需修门禁）');
  const keys = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert(keys.length === 12, `源码里的 KPI_KEYS 是 ${keys.length} 项，期望 12`);
  return keys;
}

runMain({
  name: REVERSE
    ? 'verify-report-kpi（反向验证：每条都必须变红）'
    : 'verify-report-kpi（P9 看板 / 12 项 KPI）',
  main,
  cleanup: () => {},
});
