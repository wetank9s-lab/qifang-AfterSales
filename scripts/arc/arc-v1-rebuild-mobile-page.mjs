/**
 * ARC-V1 / A6 补证 · **隔离环境重建 V2 移动页**（最小复现）
 *
 * ★ 顺序铁律（本轮单变量实验 probe-uid-order.mjs 实测得出）：
 *     **uid 命名空间跨 `flowModels` 与 `desktopRoutes` 共用**。若先写模型再建路由，
 *     路由接口会报 `uid already exists`（而 desktopRoutes 表其实是空的、无唯一索引）。
 *     ⇒ 必须 **先建路由（schemaUid=X）→ 再写模型（uid=X）**。
 *     第一版脚本顺序反了，R3 因此全红；这不是 NocoBase 缺陷，是交付顺序错。
 *
 * ★ 模型数口径（易错）：开发库 `flowModelTreePath` 里这两个树的 **distinct descendant = 33**，
 *     但其中 **7 个是孤儿**（模型早已删除、树路径残留），真实存在于 `flowModels` 的只有 **26**。
 *     ⇒ 交付/比对一律用 **join 口径（26）**；把 33 当期望值 = 追一批不存在的模型。
 *
 * 目标（用户第 2 项）：在"与生产结构相当"的隔离环境里，验证完整交付包能恢复：
 *   ① 移动页面本身          ② 两个业务区块
 *   ③ 销售可打开录入页      ④ 负责人/总部管理员/总部售后可打开只读页
 *   ⑤ 原生档案集合写接口仍拒越权   ⑥ 重复执行授权不产生重复记录、也不因缺权限失败
 *
 * 环境（PROD-HOTFIX-01 起**全部可参数化**，见下方 const 段）：
 *   · ARC_DB / ARC_PG_CONTAINER / ARC_PG_USER  —— 目标库、psql 容器、用户
 *   · ARC_REF_DB                              —— 交付包来源（参照库，只读）
 *   · ARC_PAYLOAD_MODE=ref|file + --payload=  —— 交付包来源方式
 *                                               （**生产只能用 file**：生产机上没有参照库）
 *   · SVC_UAT_BASE                            —— 写入走的 HTTP 基址（须指向**同一个**库的实例）
 *
 *   ⚠️ 写入前**第一件事**是 `select current_database()` 与 ARC_DB **逐字比对**，
 *      不一致立即退出（在发起任何写请求之前）。
 *   ⚠️ 基线判据已从「整库 0/0/0 或 2/26/1」改为「**只看 ARC 归属**」：
 *      生产库 34 条历史路由是**正常基线**，原判据会把它判成污染（假红）。
 *      新判据：ARC 路数 ∈ {0,2} 且 ARC 模型数 ∈ {0,26} 且两者**同态**；
 *      只有页面壳没有 tabs ⇒ 半成品，必须红。
 *
 * ★ 本脚本的定位：**它既是"最小复现"，同时就是交付物本身**。
 *   因为核查发现：ARC-V1 的页面配置在仓库里**没有任何可重放的载体**
 *   （无迁移、无 seed、官方 exportBlueprint 又导不出自定义区块 —— 见下方 E1 证据）。
 *   ⇒ 页面配置目前只存在于开发库这一台上。本脚本把"从零重建"变成可执行动作。
 *
 * 写入策略（照抄本仓库已有的血泪规矩，见 mount-edit-block.mjs / seed-admin-pages.mjs）：
 *   · 模型树用 `flowModels:save`（upsert）—— **不能** `create`，
 *     否则不触发 afterInsert 钩子，`flowModelTreePath` 祖先链不建 ⇒ UI 读树看不见。
 *   · payload 必须**扁平**，`use` 在**顶层**，不能再包一层 `{values:{...}}`（否则静默不渲染）。
 *   · 授权用官方 `rolesDesktopRoutes:create`，并容忍"已存在"（幂等）。
 *
 * 用法：
 *   # 隔离库（参照库在场）
 *   ARC_DB=service_ticket_verify SVC_UAT_BASE=http://127.0.0.1:13001 node scripts/arc/arc-v1-rebuild-mobile-page.mjs --dry-run
 *   # 生产库（必须先冻结载荷；参照库不在场）
 *   ARC_DB=scqf_aftersales_candidate ARC_PG_CONTAINER=scqf-as-postgres ARC_PG_USER=scqf_as \
 *     ARC_PAYLOAD_MODE=file --payload=docs/arc/arc-v1-page-payload.json \
 *     SVC_UAT_BASE=https://sh.scqfls.cn node scripts/arc/arc-v1-rebuild-mobile-page.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  UID_OWNERSHIP, ROUTE_ID_ATTRIBUTION,
  isArcTabsFingerprint, describeFingerprint, decideUidOwnership, decideRouteIdAttribution,
  isArcOwnershipEvidence,
} from '../lib/arc-uid-ownership.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');  // 仓库根
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ---------------------------------------------------------------------------
// 目标环境（PROD-HOTFIX-01：**全部可参数化**，不再硬编码隔离库/隔离容器）
//
// 为什么必须参数化（2026-11-12 PROD-DEPLOY 的实际阻塞）：
//   原脚本把 `service_ticket_verify` 与 `svc-postgres` 写死 ⇒ **只能对隔离库运行**。
//   而生产库 `scqf_aftersales_candidate` 里已有 **34 条既有业务路由**，
//   原 S1 判据只接受 `0/0/0` 或 `2/26/1` ⇒ 对生产库必然假红。
//
// ⚠️ 参数只是"允许指向哪里"，**不是**"信任指向哪里"：
//   写入前的第一件事是 `select current_database()` 与本参数**逐字比对**，
//   不一致立即退出。这是防止"环境变量写错一个字符 ⇒ 写进了开发库/生产库"的唯一防线。
// ---------------------------------------------------------------------------
/**
 * 写入走的 HTTP 基址。
 *
 * ⚠️ 它**必须指向与 ARC_DB 同一个库**的实例 —— 脚本无法从 URL 反查出库名，
 *    所以这一点靠**调用者**保证，并靠 S0 的 `current_database()` 自证兜住
 *    "库名写错"这一类错误（库名对了、实例连错了仍然是 S0 拦不住的另一类，
 *    因此部署命令里基址与容器/库名要成组出现，不要分开抄）。
 */
const BASE = (process.env.SVC_UAT_BASE || 'http://127.0.0.1:13001').trim();
const DB = (process.env.ARC_DB || 'service_ticket_verify').trim();
/** `--dry-run`：只跑到"写入闸门"为止，不发起任何写请求 */
const DRY = process.argv.includes('--dry-run');
/** psql 所在容器（可指向 svc-postgres / scqf-as-postgres / 任何同网 PG 容器） */
const PG_CONTAINER = (process.env.ARC_PG_CONTAINER || 'svc-postgres').trim();
/** psql 用户 */
const PG_USER = (process.env.ARC_PG_USER || 'svc_app').trim();
/**
 * **只读参照库**（交付包来源 + 反向对照）。
 * 交付常量 PAGE_UID/TABS_UID/ROUTE_ID_* 的实体配置只存在于这一台。
 * 它就是**参照源**，不是写入目标 —— 即便它等于 DB 也不会被写（写全部走 BASE 的 HTTP 接口）。
 */
const REF_DB = (process.env.ARC_REF_DB || 'service_ticket').trim();
/**
 * 交付包形态：`ref` = 从 REF_DB 现取（默认，隔离/开发环境）；
 *             `file` = 从 `--payload=<path>` 读取（生产环境：不依赖参照库在场）。
 */
const PAYLOAD_MODE = (process.env.ARC_PAYLOAD_MODE || 'ref').trim();
const PAYLOAD_FILE = (process.argv.find((a) => a.startsWith('--payload=')) || '').slice('--payload='.length);

// ---- 合法的既有路由基线（PROD-HOTFIX-01 的核心语义修正）----
//
// 原判据：`0/0/0` 或 `2/26/1`。删掉它的理由：
//   · 生产库有 **34** 条历史路由，这是**正常基线**，不是污染；
//   · 用它当"合法态"等于要求"整库路由数必须是 0" ⇒ 把正常生产环境判成故障。
//
// 新判据（只看 **ARC 归属**，不看整库绝对数）：
//   ① ARC 页路由数 ∈ {0, 2} —— 要么还没建，要么已建好（页面 + tabs）；
//   ② ARC tabs 子树模型数 ∈ {0, 26}（join 口径）—— 与路由数**必须同态**；
//   ③ 整库路由数 **不作为** 合法性条件（仅记录）；
//   ④ 若 ARC 页路由数 = 1 ⇒ **半成品**（只有页面没 tabs），必须红（不能继续）。
// 任一条不满足 ⇒ 不进入写入，直接 STOP。
const ARC_LEGAL_SHAPES = [
  { routes: 0, models: 0, label: '首次建立' },
  { routes: 2, models: 26, label: '已建好（幂等重放）' },
];
// ---- 交付常量（来自开发库取证，见 docs/ARC-V1-PAGE-CONFIG.md）----
const PAGE_UID = 'n5c25yq5qlt';
const TABS_UID = '97x481j2bv1';
const ROUTE_ID_PAGE = 396888170692608;
const ROUTE_ID_TABS = 396888170692609;
const LAYOUT = 'mobile-layout-model';

/**
 * 隔离实例的 root 口令是**全新初始化时生成的**，与开发库那份 admin-credential-dev.txt
 * 不通用（实测开发库口令在隔离库 401）。故优先读环境变量，再回退到开发凭据文件。
 * ⚠️ 口令只从环境/本地文件读，绝不写进脚本或报告。
 */
function readRootCred() {
  if (process.env.UAT_ROOT_EMAIL && process.env.UAT_ROOT_PASSWORD) {
    return { email: process.env.UAT_ROOT_EMAIL, password: process.env.UAT_ROOT_PASSWORD };
  }
  // ⚠️ 顺序：**先按目标库**找凭据文件，再回退到开发库那份。
  //    为什么（2026-11-12 实测）：隔离库的 root 口令是全新初始化时生成的，
  //    开发库那份 `.tmp-verify/admin-credential-dev.txt` 在隔离库上 **401**。
  //    原来只读开发库那份 ⇒ 换成隔离库/生产形态后**连登录都过不去**，
  //    而现象（exit=1）与"归属校验失败"长得一样 —— 会让人误以为判据拦住了。
  const candidates = [
    path.join(ROOT, `.tmp-verify/admin-credential-${DB}.txt`),
    path.join(ROOT, '.tmp-verify/admin-credential-dev.txt'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const get = (k) => {
      const l = lines.find((x) => new RegExp('^\\s*' + k + '\\s*[:：]').test(x));
      return l ? l.replace(/^\s*[A-Za-z]+\s*[:：]\s*/, '').trim() : '';
    };
    const email = get('email') || get('username');
    const password = get('password');
    if (email && password) return { email, password, source: file };
  }
  return { email: '', password: '', source: '(未找到凭据文件)' };
}
function psql(sql, db = DB) {
  return execFileSync('docker',
    ['exec', '-i', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}
const results = [];
function record(id, desc, pass, detail) {
  if (arguments.length !== 4) throw new Error(`record 参数个数错误(${arguments.length})：${id}`);
  if (typeof pass !== 'boolean') throw new Error(`record 第3参必须是 boolean：${id}`);
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}${detail ? `\n        ${detail}` : ''}`);
}
async function api(token, p, opt = {}) {
  const r = await fetch(BASE + p, {
    method: opt.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Data-Source': 'main',
      'X-Request-Id': crypto.randomUUID(),
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}
async function signIn(account, password) {
  const r = await api(null, '/api/auth:signIn', { method: 'POST', body: { account, password } });
  if (!r.json?.data?.token) {
    // ⚠️ 错误信息里**不带口令**（只带来源与账号），但要带**来源文件** ——
    //    凭据取错文件时，一眼就能看出在用哪一份，而不是去怀疑"库里的账号坏了"。
    throw new Error(
      `登录失败 ${account}：HTTP ${r.status} ${r.text.slice(0, 160)}` +
      `（凭据来源：${readRootCred().source || '环境变量'}；目标库 ${DB} / ${BASE}）`,
    );
  }
  return r.json.data.token;
}

console.log('='.repeat(78));
console.log(`ARC-V1 · 隔离环境重建 V2 移动页   实例=${BASE}  库=${DB}${DRY ? '   [DRY-RUN]' : ''}`);
console.log('='.repeat(78));

// ---------------------------------------------------------------------------
// 0. 目标库自证：`current_database()` 必须与参数**逐字相等**才算数
// ---------------------------------------------------------------------------
// ⚠️ 这是**唯一**能证明"我连的就是我要写的那个库"的判据。
//    环境变量写错一个字符（`..._candidate` 少个 `e`）在 psql 里就是一个新库/报错，
//    而这个判据会让它在**任何写入之前**停下。
const hostInfo = psql('select current_database();');
record('S0', '目标库自证：current_database() 与 ARC_DB 逐字相等',
  hostInfo === DB && DB.length > 0,
  `ARC_DB=${DB}；current_database=${hostInfo}；容器=${PG_CONTAINER} 用户=${PG_USER}`);

// 参照库只用于取交付包与反向对照，**不写入**；连不上也不阻塞（payload 文件模式下不需要它）
let refRoutes = 'n/a';
let refAvailable = false;
try {
  refRoutes = psql('select count(*) from "desktopRoutes";', REF_DB);
  refAvailable = true;
} catch (e) {
  refRoutes = `不可达（${String(e.message || e).slice(0, 60)}）`;
}

// ---------------------------------------------------------------------------
// 1. 基线：只看 **ARC 归属**，不看整库绝对数
// ---------------------------------------------------------------------------
const baseRoutes = psql('select count(*) from "desktopRoutes";');
const baseModels = psql('select count(*) from "flowModels";');
const arcPageRoutes = psql(
  `select count(*) from "desktopRoutes" where "schemaUid" in ('${PAGE_UID}','${TABS_UID}');`);
const arcPageUidRoutes = psql(`select count(*) from "desktopRoutes" where "schemaUid"='${PAGE_UID}';`);
// ARC 模型数（join 口径 = 交付包 26 行）——
//   ⚠️ **不能**只数 tabs（97x）子树：那里只有 24 个。
//      另外 2 个挂在 **page 根**（n5c）下、不在 tabs 下：
//        · `n5c25yq5qlt` 自身（RouteModel，页面壳的模型）
//        · `3ebe3d19d1c`（MobileRootPageModel，parentId = n5c）
//      第一次写这条判据时我用了 `ancestor='97x'` ⇒ 恒得 24，把"已建好"的正常状态
//      判成"既非 0/0 也非 2/26"（假红）。这就是"判据口径与交付包口径不一致"的经典坑：
//      交付包 D2 用的是 `ancestor in (n5c, 97x)`，S1 必须用**同一个口径**，否则两边永远打架。
const arcModelCount = psql(`select count(*) from "flowModels" m
  join "flowModelTreePath" tp on tp.descendant=m.uid
  where tp.ancestor in ('${PAGE_UID}','${TABS_UID}');`);

const arcShape = ARC_LEGAL_SHAPES.find(
  (s) => s.routes === Number(arcPageRoutes) && s.models === Number(arcModelCount));
record('S1', '基线：ARC 归属处于两种合法态之一（0/0 首次建立 或 2/26 已建好）；整库路由数仅记录',
  !!arcShape,
  `ARC 路由=${arcPageRoutes}（其中页面壳=${arcPageUidRoutes}）ARC 模型=${arcModelCount} ⇒ ` +
  `${arcShape ? arcShape.label : '⚠️ 既非 0/0 也非 2/26'}；` +
  `整库 desktopRoutes=${baseRoutes} flowModels=${baseModels}（**不作为**合法性条件）；` +
  `参照库 ${REF_DB} desktopRoutes=${refRoutes}`);

// 半成品（只有页面壳没 tabs）必须单独报出来：它不是"合法态之一"，
// 而是"上次写到一半就断了"，继续写会让 tabs 的 parentId 指向一个来路不明的壳。
if (Number(arcPageRoutes) === 1 && Number(arcPageUidRoutes) === 1) {
  record('S1-half', '半成品拦截：库内只有页面壳、没有 tabs 子路由 ⇒ 不允许继续',
    false, 'ARC 页路由数=1。请人工确认该壳的来源后再重放（本脚本不对半成品做自动修复）');
}

// 六张业务表由插件自动建（这是重要的部署前提）
const arcTables = psql(`select tablename from pg_tables where schemaname='public' and tablename like 'service_archive%' order by 1;`)
  .split('\n').filter(Boolean);
record('S2', '六张 ARC 表已存在（loadCollections 生效，不靠迁移）',
  arcTables.length === 6, `实际 ${arcTables.length} 张：${arcTables.join(' ')}`);

// ---------------------------------------------------------------------------
// 1b. ★ UID 归属核证（S6-A 判据修正 · 2026-11-11）
//
//   问题：2a 的幂等路径是「按 schemaUid 回查已有 id」。ARC 两条 UID 是随机 11 位
//         base36，撞号概率≈0，但**撞上就是灾难** —— 会把 ARC 配置静默写进一个
//         既有的、可能有真实业务数据的页面。
//   ⇒ 判据：**绝不允许"回查到就复用"**。必须先证明已占用的 UID 其内容就是
//          本次重放要写的那份 ARC 配置；证明不了就**停**。
//
//   ★ 判定逻辑**不在本文件内联** —— 唯一实现在 `scripts/lib/arc-uid-ownership.mjs`，
//     由 `scripts/verify-arc-uid-ownership-selftest.mjs` 用双向 fixture + 变异测试钉住。
//     （铁律④：同一段解析逻辑出现两次 = 同一个坑有两条腿。）
// ---------------------------------------------------------------------------
/**
 * 读**指定库**里某 uid 的模型子树指纹。
 * @returns {{total:number, grid:number, createBlk:number, editBlk:number}}
 */
function pageFingerprint(uid, db = DB) {
  const row = psql(`select count(*)
      ||'|'|| count(*) filter (where m.options::text like '%BlockGridModel%')
      ||'|'|| count(*) filter (where m.options::text like '%ArchiveCreateBlockModel%')
      ||'|'|| count(*) filter (where m.options::text like '%ArchiveEditBlockModel%')
    from "flowModels" m join "flowModelTreePath" tp on tp.descendant=m.uid
    where tp.ancestor='${uid}';`, db);
  const [total, grid, createBlk, editBlk] = row.split('|').map(Number);
  return { total, grid, createBlk, editBlk };
}

// 判据区分力自证（正向 + 反向，都拿参照库真实数据）
//
// ⚠️ PROD-HOTFIX-01：参照库**可能不在场**（生产环境下 `service_ticket` 不存在）。
//    原来的写法是直接 `psql(..., 'service_ticket')` —— 库不在就 `execFileSync` 抛错，
//    整个脚本以堆栈退出，把"环境里没有参照库"伪装成"脚本崩了"。
//    现在的语义：参照库在场 ⇒ 必须跑这条反向对照并判绿；不在场 ⇒ 判 **SKIP**（不计入失败，
//    但在汇总里**显式列出**），因为区分力已由 `verify-arc-uid-ownership-selftest.mjs`
//    的双向 fixture + 变异测试在仓库内钉死（那是**更强**的证明，不依赖任何库）。
if (refAvailable) {
  const refArcFp = pageFingerprint(TABS_UID, REF_DB);
  const refOtherFp = pageFingerprint('pac49kftubs', REF_DB);   // 真实业务页（售后工单子页）
  record('S3-R', '反向对照：同一指纹判据对真实业务页判 negative（证明判据有区分力）',
    isArcTabsFingerprint(refArcFp) === true && isArcTabsFingerprint(refOtherFp) === false,
    `${REF_DB} ARC tabs=${describeFingerprint(refArcFp)} ⇒ positive；` +
    `${REF_DB} 业务页 pac49kftubs=${describeFingerprint(refOtherFp)} ⇒ negative`);
} else {
  console.log(`SKIP  S3-R  参照库 ${REF_DB} 不在场 ⇒ 跳过在库对照` +
    `（区分力由 verify-arc-uid-ownership-selftest.mjs 的 fixture + 变异测试保证）`);
}

// 重放前 id 全表快照（判「本次新建的路由 id 是本次新值」的基准）
// ⚠️ 这里**不能用 2a 的 existingId()** —— 它定义在后面（TDZ）；就地内联查询。
const idOfUid = (uid) => {
  const v = psql(`select id from "desktopRoutes" where "schemaUid"='${uid}' order by id limit 1;`);
  return v ? Number(v) : null;
};
const routeIdsBefore = new Set(
  psql(`select id from "desktopRoutes";`).split('\n').filter(Boolean).map(Number));
const prePageId = idOfUid(PAGE_UID);
const preTabsId = idOfUid(TABS_UID);

/**
 * ★ 2026-11-11 R0-FREEZE：取**三条件归属证据**（不只是结构指纹）。
 *
 * 为什么必须补这一步（B1 实测结论）：
 *   在隔离库真实构造"用 ARC 专属块、但集合绑定为 serviceVisits"的页面后，
 *   它的结构指纹是 26/grid=1/create=1/edit=1 —— 与真 ARC 页**完全相同**，
 *   光凭结构判据会判 reuse-proven（假阳 ⇒ 可能把 ARC 配置静默写进它）。
 *   ⇒ 按用户 §B「必须校验实际集合绑定、模型层级和预期页面结构」补两条证据。
 */
function pageEvidence(uid, db = DB) {
  const fp = pageFingerprint(uid, db);
  // 子树内出现的 collectionName（去重）。PG 不允许聚合里直接用 set-returning function，
  // 必须先在子查询里展开 —— 这条踩过，见 B1 探针注释。
  const collRaw = psql(`select coalesce(string_agg(distinct c, ','), '') from (
      select (regexp_matches(m.options::text, '"collectionName":"([^"]+)"', 'g'))[1] as c
        from "flowModels" m join "flowModelTreePath" tp on tp.descendant = m.uid
       where tp.ancestor = '${uid}') s where c is not null;`, db);
  const collectionNames = collRaw ? collRaw.split(',').sort() : [];
  const maxDepthRaw = psql(`select coalesce(max(depth), 0) from "flowModelTreePath" where ancestor = '${uid}';`, db);
  const hasCustomRequest = psql(`select count(*) from "flowModels" m
      join "flowModelTreePath" tp on tp.descendant = m.uid
     where tp.ancestor = '${uid}' and m.options::text like '%CustomRequestActionModel%';`, db);
  const hasFormGrid = psql(`select count(*) from "flowModels" m
      join "flowModelTreePath" tp on tp.descendant = m.uid
     where tp.ancestor = '${uid}' and m.options::text like '%FormGridModel%';`, db);
  return {
    ...fp,
    collectionNames,
    maxDepth: Number(maxDepthRaw),
    hasCustomRequest: Number(hasCustomRequest) > 0,
    hasFormGrid: Number(hasFormGrid) > 0,
  };
}

const tabsEvidence = pageEvidence(TABS_UID);

/**
 * ★ PROD-HOTFIX-01：**页面壳**归属判定（独立于 tabs 三条件）。
 *
 * 为什么必须独立（生产库的真实形态）：
 *   生产库有 34 条既有业务路由，但 tabs 的 schemaUid（`97x481j2bv1`）**根本不存在**。
 *   若只看 tabs 证据，生产库的表现是"零模型、无绑定、深度 0" ——
 *   与"ARC 页被别的页面覆盖"完全同形，却是两件性质不同的事。
 *   真正需要先回答的是：**`PAGE_UID` 这个壳在库里是谁的？**
 *
 * 三支判定：
 *   · absent         —— 该 UID 无路由 ⇒ 首次新建（正常）
 *   · arc            —— 有路由且结构就是本次交付包那一条 ⇒ 幂等复用（继续查 tabs 三条件）
 *   · other-business —— **有路由但不是本次交付包** ⇒ 立即 STOP、零写入
 *
 * 结构比对的口径刻意**不含 id**（生产 id 与开发 id 必然不同），只看：
 *   type / hideInMenu / enableTabs / enableHeader / displayTitle 这五个"壳的形状"字段。
 *   ⚠️ 不比 title：`title` 是运营可改的显示名，改名不该被当成"别人的页面"；
 *      而 `schemaUid` 相同 + 形状相同 + 下面 tabs 三条件全过，三者合起来已足够定性。
 */
function pageShell(uids, db = DB) {
  const list = uids.map((u) => `'${u}'`).join(',');
  const raw = psql(`select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
      select id, "schemaUid", title, type, "hideInMenu", "enableTabs", "enableHeader", "displayTitle"
      from "desktopRoutes" where "schemaUid" in (${list}) order by id) t;`, db);
  return JSON.parse(raw);
}
/** 交付包的路由壳形状（从参照库/载荷文件里取，故滞后到 D1 之后才可比） */
const SHELL_SHAPE_KEYS = ['type', 'hideInMenu', 'enableTabs', 'enableHeader', 'displayTitle'];
function shellVerdict(routeRow, expectedRoute) {
  if (!routeRow) return { verdict: 'absent', id: null, observed: null };
  if (!expectedRoute) {
    // 没有交付包可比 ⇒ 无法证明归属 ⇒ 按"别人的页面"处理（fail-closed）
    return { verdict: 'other-business', id: routeRow.id, observed: routeRow,
      reason: '无交付包可比对（参照库不可达且未提供 --payload）⇒ 无法证明归属' };
  }
  const diff = SHELL_SHAPE_KEYS.filter(
    (k) => String(routeRow[k] ?? '') !== String(expectedRoute[k] ?? ''));
  if (diff.length > 0) {
    return { verdict: 'other-business', id: routeRow.id, observed: routeRow,
      reason: `壳形状不符（${diff.join(',')}）` };
  }
  return { verdict: 'arc', id: routeRow.id, observed: routeRow };
}

// 交付包必须先就绪，才能判壳归属 —— 所以这里先只判 tabs 三条件，
// 壳判定在 D1（交付包加载）之后立即执行（见下方 "1c. 壳归属 + 写入闸门"）。
const ownershipTabs = decideUidOwnership({
  preId: preTabsId,
  tabsFingerprint: tabsEvidence,
  evidence: tabsEvidence,
});
record('S1b', 'UID 归属（tabs 子树）：已占用的 ARC UID 必须被证明属于本次重放（结构+集合绑定+层级）',
  ownershipTabs.verdict !== UID_OWNERSHIP.STOP,
  `重放前 page=${prePageId ?? '无'} tabs=${preTabsId ?? '无'}；${ownershipTabs.reason}`);

/**
 * ★ 统一的 STOP 出口（PROD-HOTFIX-01）。
 *
 * 为什么抽出来：原来只有 tabs 归属失败时走 STOP，其余失败只是"记录 + 继续往下写"。
 * 用户明令「UID 属其他业务、证据缺失或结构不符立即 STOP、零写入」——
 * ⇒ 任何一条前置判据红，都必须在**第一次 HTTP 写请求之前**退出。
 */
function stopNow(headline) {
  const failed = results.filter((r) => !r.pass);
  fs.mkdirSync(path.join(ROOT, '.tmp-verify/evidence/a6'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.tmp-verify/evidence/a6/rebuild-config-result.json'),
    JSON.stringify({ at: new Date().toISOString(), base: BASE, db: DB,
      pgContainer: PG_CONTAINER, pgUser: PG_USER, refDb: REF_DB, results, stopped: true }, null, 2));
  console.log(`\n汇总：PASS ${results.length - failed.length} / ${results.length}`);
  if (failed.length) console.log(`FAIL：${failed.map((f) => f.id).join(', ')}`);
  console.log(`\n🔴 ${headline}`);
  console.log('🔴 本次**未写入任何配置**（零写入）。');
  process.exit(1);
}

if (DRY) {
  console.log('\n[DRY-RUN] 只做基线自证，不执行重建。');
  process.exit(results.some((r) => !r.pass) ? 1 : 0);
}

// ---------------------------------------------------------------------------
const tk = await signIn(readRootCred().email, readRootCred().password);
console.log(`\nroot 登录完成\n`);

// ---------------------------------------------------------------------------
// 1. 交付包：ARC 页面配置的**可重放载荷**
//
//    两种来源（PROD-HOTFIX-01）：
//      · `ref`  —— 从参照库（REF_DB，默认开发库 service_ticket）按 id 现取。
//                  仅适用于"参照库在场"的环境（隔离/开发）。
//      · `file` —— 从 `--payload=<path>` 读取一份**已冻结的**载荷 JSON。
//                  **生产环境只能用这一种**：生产机上没有开发库，也不该在
//                  部署窗口里跨库取数（那会让部署依赖库存在场，多一个失败面）。
//
//    ⚠️ 为什么必须支持 file 模式（这不是"为了方便"）：
//        原实现把 `'service_ticket'` 写死在三条 SQL 的 db 参数里。生产机上该库不存在
//        ⇒ `execFileSync` 抛错 ⇒ 脚本以堆栈退出。也就是说原脚本对生产
//        **在结构上就无法运行**，不是"判据太严"那么轻。
// ---------------------------------------------------------------------------
let devRows;
if (PAYLOAD_MODE === 'file') {
  if (!PAYLOAD_FILE) {
    console.error('🔴 ARC_PAYLOAD_MODE=file 但未提供 --payload=<path>');
    process.exit(2);
  }
  devRows = JSON.parse(fs.readFileSync(path.resolve(PAYLOAD_FILE), 'utf8'));
  console.log(`交付包：从文件读取 ${PAYLOAD_FILE}`);
} else {
  if (!refAvailable) {
    console.error(`🔴 参照库 ${REF_DB} 不可达，且未使用 --payload=：无法取得交付包`);
    process.exit(2);
  }
  devRows = {
    routes: JSON.parse(psql(`
      select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, "parentId", title, tooltip, icon, "schemaUid", "menuSchemaUid", "tabSchemaName",
               type, options, sort, "hideInMenu", "enableTabs", "enableHeader", "displayTitle", hidden
        from "desktopRoutes" where "schemaUid" in ('${PAGE_UID}','${TABS_UID}') order by id) t;`, REF_DB)),
    // ⚠️ 必须 **inner join** flowModels —— 只用 flowModelTreePath 会多出 7 个孤儿
    //    （模型早已删除、树路径残留），把 26 抬成 33，重建时又不该把它们造出来。
    models: JSON.parse(psql(`
      select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select m.uid, m.options,
               tp.ancestor, tp.depth, tp.type as tp_type, tp.sort as tp_sort, tp.async as tp_async
        from "flowModels" m
        join "flowModelTreePath" tp on tp.descendant = m.uid
        where tp.ancestor in ('${PAGE_UID}','${TABS_UID}')
        order by tp.depth, m.uid) t;`, REF_DB)),
    layouts: JSON.parse(psql(`
      select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select "desktopRouteId", "uiLayoutUid" from "desktopRoutesUiLayouts"
        where "desktopRouteId" in (
          select id from "desktopRoutes" where "schemaUid" in ('${PAGE_UID}','${TABS_UID}'))
        ) t;`, REF_DB)),
  };
}
console.log(`交付包：路由 ${devRows.routes.length} 条 / 模型 ${devRows.models.length} 行 / 布局关联 ${devRows.layouts.length} 条`);
record('D1', '交付包含 2 条路由（页面 + tabs 子路由）', devRows.routes.length === 2,
  devRows.routes.map((r) => `${r.id}:${r.type}:${r.schemaUid}`).join(' | '));
record('D2', '交付包含完整模型树（26 行真实模型，含 BlockGrid 与两个业务区块）',
  devRows.models.length === 26,
  `实际 ${devRows.models.length} 行（join 口径；树路径去重 33 中含 7 个孤儿已排除）；` +
  `含 BlockGrid=${devRows.models.some((m) => /BlockGridModel/.test(JSON.stringify(m.options)))}` +
  ` 含建档块=${devRows.models.some((m) => /ArchiveCreateBlockModel/.test(JSON.stringify(m.options)))}` +
  ` 含列表块=${devRows.models.some((m) => /ArchiveEditBlockModel/.test(JSON.stringify(m.options)))}`);
record('D3', '交付包含布局归属（挂到 mobile-layout-model）', devRows.layouts.length === 2,
  devRows.layouts.map((l) => `${l.desktopRouteId}→${l.uiLayoutUid}`).join(' | '));

fs.mkdirSync(path.join(ROOT, '.tmp-verify/evidence/a6'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.tmp-verify/evidence/a6/arc-page-payload.json'),
  JSON.stringify(devRows, null, 2));

// ---------------------------------------------------------------------------
// 1c. ★ **壳归属 + 写入闸门**（PROD-HOTFIX-01 的核心）
//
// 位置刻意在"交付包已加载"之后、"任何 HTTP 写请求"之前：
//   壳判定需要交付包做比对基准，所以只能在 D1 之后；
//   而它又必须是**最后一道**闸门 —— 因为一旦放行，下面就开始 create 了。
// ---------------------------------------------------------------------------
const pageRoute = devRows.routes.find((r) => r.schemaUid === PAGE_UID);
const tabsRoute = devRows.routes.find((r) => r.schemaUid === TABS_UID);

const pageRoutesInDb = pageShell([PAGE_UID]);
const tabsRoutesInDb = pageShell([TABS_UID]);
const shellPage = shellVerdict(pageRoutesInDb[0], pageRoute);
const shellTabs = shellVerdict(tabsRoutesInDb[0], tabsRoute);

// 把壳结论并入归属判定（唯一实现在 arc-uid-ownership.mjs）
const ownership = decideUidOwnership({
  preId: preTabsId,
  tabsFingerprint: tabsEvidence,
  evidence: tabsEvidence,
  pageShell: shellPage,
});
record('S1c', '页面壳归属：PAGE_UID 在库里「不存在」或「就是本次交付包那一条」；否则 STOP',
  shellPage.verdict !== 'other-business' && shellTabs.verdict !== 'other-business' &&
    ownership.verdict !== UID_OWNERSHIP.STOP,
  `page ${PAGE_UID}: ${shellPage.verdict}` +
  `${shellPage.id ? `（库内 id=${shellPage.id}）` : ''}` +
  `${shellPage.reason ? ` · ${shellPage.reason}` : ''}；` +
  `tabs ${TABS_UID}: ${shellTabs.verdict}` +
  `${shellTabs.id ? `（库内 id=${shellTabs.id}）` : ''}` +
  `${shellTabs.reason ? ` · ${shellTabs.reason}` : ''}；` +
  `归属结论=${ownership.verdict}（${ownership.reason}）`);

// 交付包完整性（D1–D3）也参与闸门：缺一条就写不出结构正确的页面
const packageComplete = results.filter((r) => ['D1', 'D2', 'D3'].includes(r.id)).every((r) => r.pass);
const preflightFailed = results.filter((r) => !r.pass);

if (preflightFailed.length > 0 || !packageComplete) {
  stopNow('前置判据未全绿（含 UID 归属/结构/半成品/交付包完整性）⇒ 立即 STOP');
}

if (DRY) {
  console.log('\n[DRY-RUN] 前置判据全绿；不执行重建。');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. 重放：把交付包写入目标库
//    ★ 顺序：**路由 → 模型 → 布局 → 授权**（顺序依赖见文件头「顺序铁律」）
// ---------------------------------------------------------------------------
// 2a. 路由 —— 官方 desktopRoutes:create，**幂等**：
//     ⚠️ 已存在的路由再 create 会 400 `uid already exists`（实测：文档里没有 duplicate/unique
//        这两个词，用它判重复会永远漏判）。重复执行必须"收敛"而不是报错 ——
//        命中已存在时按 schemaUid 回查已有 id 继续用。
//
//     ★ PROD-HOTFIX-01：**不再硬编码 `396888170692609`**。
//       交付包里子路由的 parentId 是**开发库的 id**，生产库/隔离库必然不是它。
//       原来的 `mkRoute(tabsRoute, newPageId)` 靠"显式传参"绕过了这个硬编码，
//       但一旦有人改成"直接展开 rt"就会把开发库 id 写进生产 —— 它是个哑雷。
//       现在改为**按 schemaUid 重映射**：交付包里的 parentId 指向哪条 UID，
//       就换成本次那条 UID 在目标库拿到的 id；指不到任何已知 UID ⇒ 直接判红。
//
//       ⚠️ 新增路由时**不需要**改这个映射表，只要交付包里的 parentId 指向包内另一条路由。
const ROUTE_UID_OF_ID = new Map(devRows.routes.map((r) => [Number(r.id), r.schemaUid]));
let routeFail = [], routeReused = 0;
const existingId = (uid) => {
  const v = psql(`select id from "desktopRoutes" where "schemaUid"='${uid}' order by id limit 1;`);
  return v ? Number(v) : null;
};
/** 已落库的 UID → 目标库 id（按创建顺序累积，子路由可引用父路由） */
const placedRouteIds = new Map();
const mkRoute = async (rt) => {
  const body = { ...rt };
  delete body.id;
  if (body.parentId === null || body.parentId === undefined) {
    delete body.parentId;
  } else {
    const parentUid = ROUTE_UID_OF_ID.get(Number(body.parentId));
    if (!parentUid) {
      routeFail.push(`${rt.schemaUid}:parentId=${body.parentId} 无法映射到交付包内任一 UID`);
      return null;
    }
    const mapped = placedRouteIds.get(parentUid) ?? existingId(parentUid);
    if (!mapped) {
      routeFail.push(`${rt.schemaUid}:父路由 ${parentUid} 尚未落库，无法确定 parentId`);
      return null;
    }
    body.parentId = mapped;
  }
  const r = await api(tk, '/api/desktopRoutes:create', { method: 'POST', body });
  if (r.status < 400) return r.json?.data?.id ?? null;
  if (/already exists/i.test(r.text)) {           // 幂等：复用已存在的路由
    routeReused++;
    return existingId(rt.schemaUid);
  }
  routeFail.push(`${rt.schemaUid}:${r.status}:${r.text.slice(0, 110)}`);
  return null;
};
// 按"父在前"排序（交付包里 page 的 parentId 为空，tabs 指向 page）
const routesOrdered = [...devRows.routes].sort(
  (a, b) => Number(a.parentId === null || a.parentId === undefined) === 1 ? -1
    : Number(b.parentId === null || b.parentId === undefined) === 1 ? 1 : 0);
let newPageId = null, newTabsId = null;
for (const rt of routesOrdered) {
  const id = existingId(rt.schemaUid) ?? await mkRoute(rt);
  if (id) placedRouteIds.set(rt.schemaUid, id);
  if (rt.schemaUid === PAGE_UID) newPageId = id;
  if (rt.schemaUid === TABS_UID) newTabsId = id;
}
const routeCount = psql(`select count(*) from "desktopRoutes" where "schemaUid" in ('${PAGE_UID}','${TABS_UID}');`);
record('R3', '路由重放成功（先父后子，子路由 parentId 按 UID 重映射；重复执行复用已存在路由）',
  Number(routeCount) === 2 && routeFail.length === 0,
  `库内路由数=${routeCount}；父 id=${newPageId} 子 id=${newTabsId}` +
  `${routeReused ? `；复用已存在 ${routeReused} 条（幂等）` : ''}` +
  `${routeFail.length ? '；失败：' + routeFail.join(' ; ') : ''}`);

// R3b · ★ S6-A 判据：本次**新建**的路由 id 必须是本次才出现的新值
//   判定逻辑同样引用唯一实现（`scripts/lib/arc-uid-ownership.mjs`）。
//   三分支：新建 ⇒ 不在重放前快照；复用 ⇒ 必须等于重放前那个 id；
//   落在快照里却又不等于 ⇒ DRIFT（静默漂移，必须红）。
const attribPage = decideRouteIdAttribution({ preId: prePageId, postId: newPageId, idsBefore: routeIdsBefore });
const attribTabs = decideRouteIdAttribution({ preId: preTabsId, postId: newTabsId, idsBefore: routeIdsBefore });
record('R3b', '路由 id 归属：新建 ⇒ 是本次新值；复用 ⇒ 等于重放前那个 id（无静默漂移）',
  attribPage.ok && attribTabs.ok,
  `重放前 page=${prePageId ?? '无'} tabs=${preTabsId ?? '无'}；` +
  `重放后 page=${newPageId} tabs=${newTabsId}；` +
  `page:${attribPage.verdict}（${attribPage.reason}）；tabs:${attribTabs.verdict}（${attribTabs.reason}）`);

// 2b. 模型树 —— 用官方 flowModels:save（upsert），按 depth 从浅到深
//     ★ 必须在路由之后：uid 命名空间跨表共用（见文件头「顺序铁律」）
const byDepth = [...devRows.models].sort((a, b) => a.depth - b.depth);
let modelOk = 0, modelFail = [];
for (const m of byDepth) {
  const payload = typeof m.options === 'string' ? JSON.parse(m.options) : m.options;
  const r = await api(tk, '/api/flowModels:save', { method: 'POST', body: { uid: m.uid, ...payload } });
  if (r.status < 400) modelOk++; else modelFail.push(`${m.uid}:${r.status}:${r.text.slice(0, 90)}`);
}
record('R1', '模型树重放成功（flowModels:save upsert）', modelFail.length === 0,
  `成功 ${modelOk}/${byDepth.length}${modelFail.length ? '；失败：' + modelFail.slice(0, 3).join(' ; ') : ''}`);

// 回读自证：不信任返回值，回库核对（**join 口径**，排除树路径孤儿）
const modelCount = psql(`select count(*) from "flowModels" m join "flowModelTreePath" tp on tp.descendant=m.uid where tp.ancestor in ('${PAGE_UID}','${TABS_UID}');`);
const gridCount = psql(`select count(*) from "flowModels" where options::text like '%BlockGridModel%' and uid in (select descendant from "flowModelTreePath" where ancestor='${TABS_UID}');`);
const blockCount = psql(`select count(*) from "flowModels" where options::text like '%Archive%BlockModel%' and uid in (select descendant from "flowModelTreePath" where ancestor='${TABS_UID}');`);
record('R2', '回读自证：目标库里模型树与交付包一致（26 行真实模型）',
  Number(modelCount) === 26, `目标库 ${modelCount} 行 / 交付包 26 行（join 口径）；BlockGrid=${gridCount} 两个业务区块=${blockCount}`);

// 2c. 布局关联 —— 比对目标：**每条路由只挂 mobile-layout-model**（与开发库终态一致）
//     ★ 实测（probe-auto-grants.mjs）：`desktopRoutes:create` 会**自动**给新路由挂
//       `admin-layout-model`（返回体的 uiLayouts 就带着它）。ARC 页是**移动页**，
//       不该出现在桌面后台菜单里 ⇒ 必须先删掉自动生成的 admin 关联，再挂 mobile。
//       开发库那两条路由的 layouts 聚合结果就是**纯 mobile**，无 admin。
const newRoutes = JSON.parse(psql(`select coalesce(json_agg(row_to_json(t)), '[]'::json) from (select id, "schemaUid" from "desktopRoutes" where "schemaUid" in ('${PAGE_UID}','${TABS_UID}')) t;`));
let layoutOk = 0, droppedAdmin = 0;
for (const nr of newRoutes) {
  // 删掉自动挂上的 admin 布局关联（NocoBase 在 create 时自动加）
  // ⚠️ 本表主键是复合键 (desktopRouteId, uiLayoutUid)，**没有 id 列** ——
  //    用 `filterByTk: a.id` 会 400；必须按复合键删除。
  const auto = JSON.parse(psql(`select coalesce(json_agg(row_to_json(t)), '[]'::json) from (select "uiLayoutUid" from "desktopRoutesUiLayouts" where "desktopRouteId"=${nr.id} and "uiLayoutUid"<>'${LAYOUT}') t;`));
  for (const a of auto) {
    const q = `filter=${encodeURIComponent(JSON.stringify({ desktopRouteId: nr.id, uiLayoutUid: a.uiLayoutUid }))}`;
    const dr = await api(tk, `/api/desktopRoutesUiLayouts:destroy?${q}`, { method: 'POST' });
    if (dr.status < 400) droppedAdmin++;
  }
  const r = await api(tk, '/api/desktopRoutesUiLayouts:create', {
    method: 'POST', body: { desktopRouteId: nr.id, uiLayoutUid: LAYOUT },
  });
  if (r.status < 400) layoutOk++;
}
// ⚠️ 判据 SQL 必须 group by desktopRouteId：缺 group by 时 string_agg 会把两条路由
//    的行并成一行（"mobile,mobile"），看起来像"一条路由挂了两次"。
const layoutRows = psql(`
  select l."desktopRouteId" || ' => ' || string_agg(l."uiLayoutUid", ',' order by l."uiLayoutUid")
  from "desktopRoutesUiLayouts" l
  where l."desktopRouteId" in (select id from "desktopRoutes" where "schemaUid" in ('${PAGE_UID}','${TABS_UID}'))
  group by l."desktopRouteId" order by 1;`).split('\n').filter(Boolean);
record('R4', '布局关联：两条路由都**只**挂 mobile-layout-model（自动的 admin 关联已清掉）',
  layoutRows.length === 2 && layoutRows.every((x) => x.endsWith('=> ' + LAYOUT)),
  `逐条聚合=${layoutRows.join(' | ')}（期望均为 => ${LAYOUT}）；已清掉自动 admin 关联 ${droppedAdmin} 行`);

// ---------------------------------------------------------------------------
// 3. 角色授权
//    ⚠️ DEV-222 的教训：**只授父不授子 = 页面能开、正文全空**
//    ★ 实测（probe-auto-grants.mjs）：建路由时 NocoBase **已自动**授予 admin + member。
//      开发库 ARC 两条路由的授权实际就是 **12 行 / 6 角色**（自动 2 + 手工 4），
//      所以正确判据是「**与开发库角色集合一致**」，而不是"恰好 8 行"。
//    ★ 重复 create 的真实报错是 `desktopRouteId already exists` ——
//      文里**没有** duplicate/unique 这两个词，用 /duplicate|unique/ 去判会永远漏判。
// ---------------------------------------------------------------------------
const DUP_RE = /already exists/i;
const DEV_ROLE_SET = ['admin', 'hq_admin', 'hq_after_sales', 'member', 'store_manager', 'store_sales'];
const ROLES = ['store_sales', 'store_manager', 'hq_admin', 'hq_after_sales'];
const routeIds = newRoutes.map((r) => r.id);
if (routeIds.length === 0) {
  // 前置没成功时，后面的 SQL 会拼出 `in ()` 语法错并让整个脚本以堆栈退出 ——
  // 那会把"前置失败"伪装成"脚本崩溃"，判据就丢了。这里显式短路。
  record('R5', '角色授权：前置路由缺失，无法继续', false, '路由未写入 ⇒ 授权步骤未执行');
  record('R6', '反向对照：授权成对', false, '同上');
  record('R7', '重复执行授权幂等', false, '同上');
  record('R8', '重复执行不因缺权限失败', false, '同上');
} else {
let grantOk = 0, grantFail = [];
for (const role of ROLES) {
  for (const rid of routeIds) {
    const r = await api(tk, '/api/rolesDesktopRoutes:create', { method: 'POST', body: { roleName: role, desktopRouteId: rid } });
    if (r.status < 400 || DUP_RE.test(r.text)) grantOk++;
    else grantFail.push(`${role}/${rid}:${r.status}:${r.text.slice(0, 90)}`);
  }
}
const grantRows = psql(`select count(*) from "rolesDesktopRoutes" where "desktopRouteId" in (${routeIds.join(',')});`);
const roleSet = psql(`select distinct "roleName" from "rolesDesktopRoutes" where "desktopRouteId" in (${routeIds.join(',')}) order by 1;`).split('\n').filter(Boolean);

// 🔴 R1-READY（2026-11-11）判据修正：**授权面有两种合法态**，不能只认一种。
//
// 踩到的假红（真实重放过一次就复现）：
//   本脚本建路由时 NocoBase **自动**授予 `admin` + `member` ⇒ 首次 S6-A 后是 6 角色 × 2 = 12 行。
//   但发布流程里 S6-A 之后紧跟 **S6-B（按用户 §1.5 要求删掉 member 的 ARC 授权）**，
//   之后再跑一次 S6-A 做幂等验证时，路由已存在 ⇒ **不会重新自动授予 member**，
//   于是库里是 5 角色 × 2 = **10 行**。旧判据写死 12 ⇒ R5/R6 变红。
//   这个红与"重放坏了"**毫无关系**，它恰恰说明 S6-B 已经生效 —— 把正确状态报成故障，
//   会诱使操作者去"补回 member"来让判据变绿，即**把发布推向更危险的方向**。
//
// 现在的语义（与 S6-B 的三分支修正同源）：
//   ① 12 行 / 6 角色 ⇒ S6-A 刚跑完、S6-B 尚未执行（合法）
//   ② 10 行 / 5 角色 ⇒ S6-B 已执行、member 已剔除（**更安全的目标态，同样合法**）
//   两种都必须满足的硬条件：**4 个业务角色全在** + **每个角色恰好 2 行**（父子成对）。
const rolesWithMember = [...DEV_ROLE_SET].sort();
const rolesWithoutMember = DEV_ROLE_SET.filter((r) => r !== 'member').sort();
const sortedRoleSet = [...roleSet].sort();
const isFullSet = sortedRoleSet.length === rolesWithMember.length &&
  sortedRoleSet.every((r, i) => r === rolesWithMember[i]);
const isPostS6B = sortedRoleSet.length === rolesWithoutMember.length &&
  sortedRoleSet.every((r, i) => r === rolesWithoutMember[i]);
const expectRows = isFullSet ? DEV_ROLE_SET.length * 2 : rolesWithoutMember.length * 2;

record('R5', '授权落库：4 个业务角色全在，且角色集合是两种合法态之一（12 行/含 member 或 10 行/已剔除 member）',
  (isFullSet || isPostS6B) &&
    ROLES.every((x) => roleSet.includes(x)) && grantFail.length === 0,
  `库内 ${grantRows} 行；角色=${roleSet.join(',')}；` +
  `判定=${isFullSet ? 'S6-A 刚跑完（含自动授予的 member，12 行）' : isPostS6B ? 'S6-B 已执行（member 已剔除，10 行）' : '⚠️ 既非 12 行含 member、也非 10 行不含 member'}；` +
  `期望行数=${expectRows}` +
  `${grantFail.length ? '；失败：' + grantFail.slice(0, 3).join(' ; ') : ''}`);

// 反向对照：必须成对（无"只授父不授子"）
// 角色个数随上面两种合法态浮动（6 或 5），但**每个角色必须恰好 2 行**这条不变。
const pairs = psql(`
  select "roleName" || '=' || count(*) from "rolesDesktopRoutes"
  where "desktopRouteId" in (${routeIds.join(',')}) group by "roleName" order by 1;`).split('\n').filter(Boolean);
record('R6', '反向对照：每个角色都恰好 2 行（父子成对，不存在"只授父不授子"）',
  pairs.length === (isFullSet ? rolesWithMember.length : rolesWithoutMember.length) &&
    pairs.every((p) => p.endsWith('=2')), pairs.join(' | '));

// ---------------------------------------------------------------------------
// 4. 幂等：重复执行授权，行数不变、且不报错
// ---------------------------------------------------------------------------
const before = psql(`select count(*) from "rolesDesktopRoutes" where "desktopRouteId" in (${routeIds.join(',')});`);
let reErr = 0;
const reErrSample = [];
for (const role of ROLES) {
  for (const rid of routeIds) {
    const r = await api(tk, '/api/rolesDesktopRoutes:create', { method: 'POST', body: { roleName: role, desktopRouteId: rid } });
    if (r.status >= 400 && !DUP_RE.test(r.text)) { reErr++; reErrSample.push(`${role}:${r.status}:${r.text.slice(0, 70)}`); }
  }
}
const after = psql(`select count(*) from "rolesDesktopRoutes" where "desktopRouteId" in (${routeIds.join(',')});`);
record('R7', '重复执行授权不产生重复行（幂等）', before === after, `重放前 ${before} 行 → 重放后 ${after} 行`);
record('R8', '重复执行不因"缺少执行权限"失败（无 403；重复返回 already exists 不算错）',
  reErr === 0, `非重复类错误数=${reErr}${reErrSample.length ? '；样例：' + reErrSample.slice(0, 3).join(' ; ') : ''}`);
}

// ---------------------------------------------------------------------------
// 5. 真实渲染：四个角色能否打开页面（销售 = 录入页；其余 = 只读页）
// ---------------------------------------------------------------------------
// 这一步需要真实浏览器；交由 verify-rebuild-mobile.mjs 完成（本脚本只做配置重建）。
console.log('\n配置重建完成。页面渲染验证交由 verify-rebuild-mobile.mjs。');

const failed = results.filter((r) => !r.pass);
fs.writeFileSync(path.join(ROOT, '.tmp-verify/evidence/a6/rebuild-config-result.json'),
  JSON.stringify({ at: new Date().toISOString(), base: BASE, db: DB,
    pgContainer: PG_CONTAINER, pgUser: PG_USER, refDb: REF_DB,
    payloadMode: PAYLOAD_MODE, results, stopped: false }, null, 2));
console.log(`\n汇总：PASS ${results.length - failed.length} / ${results.length}`);
if (failed.length) console.log(`FAIL：${failed.map((f) => f.id).join(', ')}`);
process.exit(failed.length ? 1 : 0);
