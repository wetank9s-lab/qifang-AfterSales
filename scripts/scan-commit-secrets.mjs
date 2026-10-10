#!/usr/bin/env node
/**
 * scan-commit-secrets —— 提交前扫描（Phase 10 / RB-1 纪律工具）
 * ===========================================================================
 * 为什么需要它：**取证材料也是凭证副本**。
 *
 * 本系统里最容易被抄进文档/证据文件的不是 `.env`（它通常已被忽略），而是
 * **为了说明缺陷而"按原样贴一遍"的日志片段** ——
 * 贴的时候是为了证明"这里泄漏了 Token/手机号"，贴完就变成第二份泄漏。
 * 历史实测：`docs/` 与本工作区的证据 JSON 里都出现过 43 位明文 Token、
 * 11 位手机号、姓名原文。
 *
 * ⇒ 因此把它做成**可执行的门禁**，而不是一句"要注意"：
 *    提交前跑一次；红了就改文档，而不是忽略。
 *
 * ---------------------------------------------------------------------------
 * 🔴 这个工具最大的失败模式**不是漏报，而是误报**
 * ---------------------------------------------------------------------------
 * 一个总是红的门禁，结局是被 `|| true` 掉，或者被改成只扫一个空目录 ——
 * 两种结局都比没有门禁更糟：它给出的是**虚假的安全感**。
 *
 * 实测：首跑 41 处命中，其中**真凭证 0 处**（16 个合成手机号 + 2 处 npm
 * integrity 摘要 + 1 处 UUID 写法）。所以本版本的重点是**在不放宽判据的
 * 前提下消解噪声** —— 手段是"按**结构上下文**判定"，不是"把阈值调松"：
 *   ① 手机号 → **显式登记表**（见下）；
 *   ② 43 位串 → 看它**是不是 base64url**（Token 必然不含 `+` `/` `=`）；
 *   ③ 32 位 hex → 看它**是不是 UUID 的无连字符写法**。
 *
 * ⚠️ 所有排除项**都会在输出里计数**（`--audit` 可看明细）。
 *    **静默的排除等于假绿** —— 排除必须可审计，否则和白名单写成 `return true` 没区别。
 *
 * ⚠️ 工具**自带反向自检**（每次运行都跑）：如果哪天有人为了让红变绿而把
 *    某个正则调松，自检会先转红并 `exit 2`。这是"门禁守卫门禁"。
 *
 * 用法
 * ---------------------------------------------------------------------------
 *   node scripts/scan-commit-secrets.mjs                 # 只看**暂存区**（提交前用这个）
 *   node scripts/scan-commit-secrets.mjs --all           # 扫工作区全部受版本控制文件
 *   node scripts/scan-commit-secrets.mjs --paths a b     # 只扫指定路径
 *   node scripts/scan-commit-secrets.mjs --verbose        # 打印全部命中（默认每类最多 5 条）
 *   node scripts/scan-commit-secrets.mjs --audit          # 打印全部**被排除**项（白名单审计）
 *
 * 退出码：0 = 干净；1 = 有命中；2 = 环境/用法/自检错误。
 *
 * 判据说明（为什么是这几类）
 * ---------------------------------------------------------------------------
 * ① **43 位 base64url**：评价 Token / 师傅 Token 的**唯一**形态
 *    （`REVIEW_TOKEN_BYTES=32` → base64url 43）。任何非合成的 43 位串都按凭证处理。
 * ② **11 位手机号**：`1[3-9]\d{9}`。掩码形态（`139****0000`）因含 `*` 不会命中。
 * ③ **长 hex（≥32）**：AES 主密钥 / 各种 secret 的形态。**排除** 40 位 git 提交哈希
 *    （用 `git rev-parse` 验证它确实是本仓库的提交）—— 文档里贴 commit 哈希是正常且必要的。
 * ④ **私钥块**：`-----BEGIN … PRIVATE KEY-----`。
 * ⑤ **按文件名**：`.env*`、`aes_key.dat`、`*.pem`、`*.p12`、`storage/tmp/` 下的产物
 *    （原生导出会落含明文手机号的临时 XLSX —— 见 DEV-92 同批记录）。
 * ⑥ **合成号段登记表**：见 `SYNTHETIC_PHONES` 的注释（含"为什么不做规则化判定"）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');

const ARGS = process.argv.slice(2);
const ALL = ARGS.includes('--all');
const VERBOSE = ARGS.includes('--verbose');
const AUDIT = ARGS.includes('--audit');
const pathsIdx = ARGS.indexOf('--paths');
const EXPLICIT = pathsIdx >= 0 ? ARGS.slice(pathsIdx + 1).filter((a) => !a.startsWith('--')) : [];

const MAX_SHOWN = VERBOSE ? 999 : 5;

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function listFiles() {
  if (EXPLICIT.length > 0) return EXPLICIT;
  if (ALL) {
    // 受版本控制的文件 —— 这正是"能被提交出去"的全集。
    // ⚠️ 不要改成 `fs` 递归遍历工作区：那会把 `backups/`（`.gitignore:31` 已忽略，
    //    内含 UAT 清理备份里的**真实手机号**）也拉进来，命中 38 处噪音，
    //    而它**根本不可能被提交**。扫描范围必须等于"可提交范围"，否则门禁失去意义。
    return git(['ls-files']).split('\n').filter(Boolean);
  }
  // 暂存区：提交前最该看的就是这一批
  return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n').filter(Boolean);
}

// --- 判据 -------------------------------------------------------------------

/** 43 位 base64url（Token 的唯一形态）。两端的 lookaround 保证它是**极大** run。 */
const TOKEN_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
const PHONE_RE = /(?<![0-9])1[3-9][0-9]{9}(?![0-9])/g;
const HEX_RE = /(?<![0-9a-fA-F])[0-9a-fA-F]{32,}(?![0-9a-fA-F])/g;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** 合成 Token 白名单：门禁自造的 canary / 占位串，不是真凭证 */
function isSyntheticToken(t) {
  const lower = t.toLowerCase();
  if (lower.startsWith('mock')) return true;
  if (t.includes('CANARY') || t.includes('canary')) return true;
  if (/^(.)\1+$/.test(t)) return true; // AAAA… / TTTT…
  if (/^(X|x|-)+$/.test(t)) return true;
  return false;
}

// --- ② 43 位串：它是 base64url 吗？-----------------------------------------
//
// 为什么这条判据是**精确**的而不是"放宽阈值"：
//   本系统的 Token 是 `randomBytes(32).toString('base64url')` ⇒ 字母表
//   只有 `[A-Za-z0-9_-]`，**永远不含** `+` `/` `=`。
//   而 npm 的 integrity 摘要（`sha512-<base64>`）是**标准 base64** ⇒ 几乎必然含 `+` `/` `=`。
//   ⇒ 若一个 43 位窗口落在**含 `+` `/` `=` 的更长 base64 run** 里，它就不可能是本系统的 Token。
//   实测两处命中（`h5/package-lock.json:603/666`）都被这一条精确排除。
const B64_ANY = /[A-Za-z0-9_+/=-]/;

function enclosingBase64Run(line, start, end) {
  let a = start;
  let b = end;
  while (a > 0 && B64_ANY.test(line[a - 1])) a -= 1;
  while (b < line.length && B64_ANY.test(line[b])) b += 1;
  return line.slice(a, b);
}

const SHA_PREFIX_RE = /^sha(1|256|384|512)-/;
const INTEGRITY_LINE_RE = /"integrity"\s*:\s*"sha(1|256|384|512)-/;

/** 兜底：万一某条标准 base64 恰好不含 `+` `/` `=`（概率约 6%），靠 integrity 上下文拦住 */
function isIntegrityContext(line, run, start) {
  if (SHA_PREFIX_RE.test(run)) return true;
  const idx = line.search(INTEGRITY_LINE_RE);
  return idx >= 0 && start >= idx;
}

/**
 * @returns {{suspect: boolean, why: string|null}}
 */
function classifyToken(token, line, start, end) {
  if (isSyntheticToken(token)) return { suspect: false, why: '合成占位串' };
  const run = enclosingBase64Run(line, start, end);
  if (/[+/=]/.test(run)) return { suspect: false, why: '标准 base64 片段（Token 是 base64url，不含 + / =）' };
  if (isIntegrityContext(line, run, start)) return { suspect: false, why: 'npm integrity 摘要' };
  return { suspect: true, why: null };
}

// --- ③ 长 hex：它是 UUID 吗？------------------------------------------------
//
// 📌 实测教训（值得记下来，因为它推翻了我第一版的判据）：
//    `scripts/verify-client-logic.mjs:296` 那一行是两个 UUID 字面量做对照：
//      带连字符的那个，版本号是 v1（`…-11d4-…`）；
//      紧凑的那个，版本号是 v4（`…-41d4-…`）。
//    ⇒ **它们不是同一个 UUID 的两种写法**，而是 v1/v4 对照夹具。
//    我第一版写的恰恰是"同一个 UUID 的两种写法"（拿紧凑形式的带连字符版本去同行匹配），
//    因此**匹配不到真实数据**。这个错误是被工具**内置自检**抓出来的 ——
//    因为自检样本是照着真实行抄的。这正是"自检样本必须取自真实数据"的价值：
//    凭空编的样本会正好符合我脑中的规则，于是什么也证明不了。
//
//    同理，这段注释本身也不写 32 位 hex 字面量 —— 本文件自己也在扫描范围内，
//    而"为了说明问题而按原样贴一遍"正是本工具要防的事（见文件头）。
//
// ⇒ 改为"**形状 + 上下文**双重判定"，两条都满足才排除：
//    ① 形状：恰好 32 位，且第 12 位是版本号 `1-5`、第 16 位是 variant `8/9/a/b`；
//    ② 上下文：本行出现带连字符的 UUID（`8-4-4-4-12`）**或**出现 `uuid` 字样。
//    为什么不只用形状：一个 32 位 hex 恰好落在 UUID 形状上的概率约 7.8%（5/16 × 4/16），
//    单凭形状排除会**真的漏掉密钥**。加上上下文后，实际风险≈"某行既写着 uuid 又藏着 16 字节密钥"，
//    而这在本系统里不存在（本系统的密钥形态是 43 位 base64url Token 与文件级 `aes_key.dat`）。
//    ⇒ 仍然偏保守：**不带 uuid 上下文的 32 位 hex 一律报**（自检⑥b 守着这条）。
const UUID_DASHED_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function isUuidShaped32(hex32) {
  if (!/^[0-9a-f]{32}$/.test(hex32)) return false;
  return /[1-5]/.test(hex32[12]) && /[89ab]/.test(hex32[16]);
}

function classifyHex(hex, line) {
  if (/^[0-9a-f]{40}$/.test(hex) && isCommitHash(hex)) return { suspect: false, why: '本仓库提交哈希' };
  if (isUuidShaped32(hex) && (UUID_DASHED_RE.test(line) || /uuid/i.test(line))) {
    return { suspect: false, why: 'UUID 紧凑写法（形状合法 + 本行以 UUID 为上下文）' };
  }
  return { suspect: true, why: null };
}

/** 40/64 位 hex 是否其实是 git 提交哈希（文档里贴哈希是正常行为） */
const commitHashCache = new Map();
function isCommitHash(h) {
  if (!/^[0-9a-f]{40}$/.test(h)) return false;
  if (commitHashCache.has(h)) return commitHashCache.get(h);
  let ok = false;
  try {
    const out = git(['rev-parse', '--verify', '--quiet', `${h}^{commit}`]).trim();
    ok = out.length === 40;
  } catch {
    ok = false;
  }
  commitHashCache.set(h, ok);
  return ok;
}

// --- ⑥ 合成手机号：显式登记表 ------------------------------------------------
//
// 为什么**不做规则化判定**（例如"尾号零多就是合成号"）：
//   实测 16 个合成号里，`13800001234` / `13800008220` / `13312345678` 的尾号
//   不符合任何"零多"或"数字种类少"的规律 —— 我试过这两种规则，都收不干净。
//   规则化的失败方向是双向的：收不干净（继续误报）或收太狠（放行真号）。
//
// ⇒ 改为**显式登记**，且登记项必须落在下面的"合成号段族"内。
//   代价是"新增一个合成号要加一行"，而**这一行的摩擦正是想要的** ——
//   它逼着人去确认"这个号确实不是真号"，而不是让规则替人做判断。
//   同时 `SYNTHETIC_PHONE_PREFIXES` 让"把真号塞进白名单"变成一个**响亮**的动作：
//   真号（如 138****5678）不匹配任何族前缀 ⇒ `isSyntheticPhone()` 返回 false
//   ⇒ 白名单失效、门禁继续红 ⇒ 提交前必然被看见。
const SYNTHETIC_PHONE_PREFIXES = [
  '1380000',     // 138 0000 xxxx  —— docs/scripts/插件自检里的占位号
  '13800138000', // 中国移动公开的测试号
  '139000',      // 139 000 xxxxx —— smoke/verify 脚本的夹具号段
  '13312345678', // 明文升序模板，出现在 permission-service 的脱敏示例注释里
];

const SYNTHETIC_PHONES = new Set([
  '13312345678',
  '13800000000', '13800000001', '13800000100', '13800001234', '13800008220', '13800138000',
  '13900000000', '13900010001', '13900010002', '13900010003', '13900010004', '13900010007',
  '13900010009', '13900020002', '13900040004', '13900050005',
  // ---- 2026-10-10（P11-2）新增两条登记 ----
  //
  // ⚠️ 登记理由必须逐条写清（本清单的既有纪律）：下面两条都是**明显可判的合成号**
  //    （全零 / 顺序号），不是真实客户手机号；登记它们是为了让 `--all` 扫描**干净**，
  //    从而"还剩几处未判定"这个数字真正可信 —— 而不是把噪音读成"没问题"。
  //
  // `1390…003`（掩码写法）：`verify-reassign-contract.mjs` 的既有夹具（同族 139 000 …）。
  //    ⚠️ 本注释**只写掩码**：这个文件自己也在扫描范围内，写全号会被自己报一处。
  //    属本轮 `--all` 扫描才暴露的**历史遗留** —— 此前只在**暂存区**扫过，
  //    而那一支从那以后没再被单独暂存过，于是它一直没被翻到。
  //    ⚠️ 顺带记一条方法：**暂存区扫描干净只覆盖本次要提交的文件**；
  //       想确认整个仓库没有明文手机号，必须每隔一段时间跑一次 `--all`。
  '13900030003',
  '13900000099',
  // ⚠️ `13900010007` 的登记理由（P11-1 / B-16，2026-10-10）：
  //    `verify-store-ui-primary-action.mjs` 的 ⑥ 自建夹具需要一个师傅手机号，
  //    沿用本仓库既有的夹具族 `139 0001 000X`（同族已有 001/002/003/004/009）。
  //    它匹配上面的 `139000` 族前缀，且**从未**出现在 .env / 任何真实账号里 ——
  //    确认为合成号，故登记。这一行的摩擦（必须来改登记表）是刻意保留的。
  //
  // ⚠️ `13900010008` / `13900010010` 的登记理由（P11-1，2026-10-10）：
  //    `verify-follow-up-todo.mjs` 建了两张夹具工单，各需要一个师傅手机号，
  //    同样沿用 `139 0001 000X` 夹具族（该族已有 001/002/003/004/007/009）。
  //    两者都匹配 `139000` 族前缀，且**从未**出现在 .env / 任何真实账号里 ⇒ 合成号。
  '13900010008', '13900010010', '13900010011',
  // ⚠️ `13900010011` 的登记理由（P11-1 三项核对，2026-10-10）：
  //    `verify-follow-up-todo.mjs` 的 ③-a（remoteComplete 清待办）用例需要一个师傅手机号，
  //    同样沿用 `139 0001 000X` 夹具族。匹配 `139000` 族前缀，从未出现在 .env ⇒ 合成号。
]);

function isSyntheticPhone(p) {
  if (!SYNTHETIC_PHONES.has(p)) return false;
  return SYNTHETIC_PHONE_PREFIXES.some((pre) => p.startsWith(pre));
}

// --- ⑤ 按文件名直接判定 ------------------------------------------------------

function forbiddenByPath(rel) {
  const base = path.basename(rel);
  if (/^\.env($|\.)/.test(base) && base !== '.env.example') return 'env 文件';
  if (base === 'aes_key.dat') return 'NocoBase AES 主密钥';
  if (/\.(pem|p12|pfx|key)$/i.test(base)) return '私钥/证书文件';
  if (/^secrets?\.(json|ya?ml)$/i.test(base)) return 'secrets 文件';
  if (rel.startsWith('storage/tmp/')) return '原生导出临时产物（含明文手机号）';
  return null;
}

function mask(s) {
  if (s.length <= 8) return `${s.slice(0, 2)}***`;
  return `${s.slice(0, 4)}…${s.slice(-2)}(len=${s.length})`;
}

// --- 内置自检（门禁守卫门禁）-------------------------------------------------
//
// 每次运行都跑。**这是为了让"把红改绿"必须付出代价**：
// 想靠调松 TOKEN_RE / 加白名单让门禁通过，这里会先红。
// 参考本项目的既有纪律：反向断言必须**否定正向判据本身**，否则恒成立 = 假通过。
// ⚠️ 自检样本必须**运行时构造**，不得写成字面量。
// ---------------------------------------------------------------------------
// 为什么（实测）：本文件自己也在扫描范围内。首版把样本写成字面量后，
//   `--paths scripts/scan-commit-secrets.mjs` 立刻报 **8 处**红：
//   3 手机号 + 3 长 hex + 1 个 43 位串 + 1 个私钥块 —— 全是自检样本本身。
//   而当时唯一"顺理成章"的修法就是**把本文件加进豁免名单**。
//
// 🔴 但本文件恰恰是全仓**最不该**被豁免的那一个：
//    它是"调为什么没抓到 X"时最可能被顺手粘进一个真 Token / 真手机号的源文件。
//    给一个安全工具加"自己不被扫"的豁免，等于把最需要被扫的文件排除在外。
//
// ⇒ 正确做法：让样本**不以凭证形态落盘**（拆成片段在运行时拼接）。
//    这样既不需要豁免、又不需要放宽判据 —— 问题被消除，而不是被绕开。
//    同理：`mask()` 与所有断言消息里的值也都是**运行时算出来**的，不是抄的。
const SELF_TEST_BAD_TOKEN = 'Zm9vYmFy'.repeat(5) + 'MTI'; // 8×5 + 3 = 43 位 base64url
const SELF_TEST_BAD_PHONE = '138' + '1234' + '5678'; // 11 位，且**不在**合成登记表内
const SELF_TEST_HEX = 'a3f9c1e0' + '7b4d2856' + '9f0c3e1a' + '8b7d4256'; // 32 位，孤立 ⇒ 必须报
const SELF_TEST_UUID_COMPACT = '550e8400' + 'e29b41d4' + 'a716' + '446655440000';
const SELF_TEST_UUID_DASHED = '550e8400' + '-e29b' + '-11d4' + '-a716' + '-446655440000';
const SELF_TEST_UUID_LINE =
  "const bad = ['', 'not-a-uuid', '" + SELF_TEST_UUID_DASHED + "', '" + SELF_TEST_UUID_COMPACT + "'];";
const SELF_TEST_SHAPED_ONLY = "const key = '" + SELF_TEST_UUID_COMPACT + "';";
const SELF_TEST_PK_HEAD = '-----BEGIN ' + 'RSA PRIVATE KEY' + '-----';
const SELF_TEST_PK_PUB = '-----BEGIN ' + 'PUBLIC KEY' + '-----';
const SELF_TEST_INTEGRITY_LINE =
  '  "integrity": "sha512-Z5UPAxzrjlWNNyGy6i65cJzzvgJ5D3T6wMvs+gWpY9d7qRhANrxqAp6LhxIgZhWEw18RfJTGcRxjuLIBr+m8XQ==",';

function runSelfTest() {
  const problems = [];
  let assertions = 0;
  const check = (ok, msg) => { assertions += 1; if (!ok) problems.push(msg); };
  const tokensOf = (line) => [...line.matchAll(TOKEN_RE)].map((m) => classifyToken(m[0], line, m.index, m.index + m[0].length));
  const hexesOf = (line) => [...line.matchAll(HEX_RE)].map((m) => classifyHex(m[0], line));

  // —— 正向：必须报 ——
  const badTok = tokensOf(SELF_TEST_BAD_TOKEN);
  check(badTok.length === 1, `自检①：43 位非合成串未被识别为 Token（匹配 ${badTok.length} 次）`);
  if (badTok.length === 1) check(badTok[0].suspect, '自检①：43 位非合成串被判为"非嫌疑" —— 判据已被放宽');

  check(!isSyntheticPhone(SELF_TEST_BAD_PHONE), `自检②：真号形态 ${mask(SELF_TEST_BAD_PHONE)} 被登记表放行 —— 白名单已失控`);
  check(isSyntheticPhone('13900010001') && isSyntheticPhone('13800008220'),
    '自检②：已登记的合成号被判为非合成（登记表与族前缀不一致）');

  const badHex = hexesOf(SELF_TEST_HEX);
  check(badHex.length === 1 && badHex[0].suspect, '自检③：孤立的 32 位 hex 未被视为嫌疑（hex 判据已被放宽）');

  check(PRIVATE_KEY_RE.test(SELF_TEST_PK_HEAD), '自检④：私钥块判据失效');
  check(!PRIVATE_KEY_RE.test(SELF_TEST_PK_PUB), '自检④：私钥块判据误伤公钥');

  // —— 反向：必须**不**报（否则就是本次修掉的噪声）——
  const intTok = tokensOf(SELF_TEST_INTEGRITY_LINE);
  check(intTok.length > 0, '自检⑤：integrity 样本行里没有 43 位串 —— 样本已失效，反向断言恒成立（假通过）');
  check(intTok.every((r) => !r.suspect),
    `自检⑤：npm integrity 摘要仍被报为 Token（${intTok.filter((r) => r.suspect).length} 处）`);

  const uuidHex = hexesOf(SELF_TEST_UUID_LINE);
  check(uuidHex.length === 1, `自检⑥：UUID 样本行 hex 匹配数异常（${uuidHex.length}）`);
  if (uuidHex.length === 1) check(!uuidHex[0].suspect, '自检⑥：UUID 紧凑写法仍被报为长 hex');

  // ⑥b **反向的反向**：形状合法但**没有 uuid 上下文**的 32 位 hex 必须**仍然报**。
  //     这一条才是安全底线 —— 它防止"UUID 判据"被顺手放宽成"长得像 UUID 就放行"，
  //     那会让判据从"识别 UUID"退化成"放过 16 字节密钥"。
  const shaped = hexesOf(SELF_TEST_SHAPED_ONLY);
  check(shaped.length === 1 && shaped[0].suspect,
    '自检⑥b：无 uuid 上下文的 32 位 hex 被放行 —— UUID 判据已越界，会漏掉 16 字节密钥');

  for (const p of SYNTHETIC_PHONES) {
    check(isSyntheticPhone(p), `自检⑦：登记表条目 ${mask(p)} 不匹配任何合成号段族 —— 该登记项无效`);
  }

  return { problems, assertions };
}

// --- 扫描 -------------------------------------------------------------------

const TEXT_EXT = new Set([
  '.md', '.json', '.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx', '.txt',
  '.yml', '.yaml', '.conf', '.sql', '.env', '.example', '.csv', '.log', '.inc',
]);

function main() {
  // 🔴 门禁守卫门禁：自检先跑。它红了就不要相信下面的结论。
  const self = runSelfTest();
  if (self.problems.length > 0) {
    console.error('='.repeat(78));
    console.error(' scan-commit-secrets 自检失败 —— 检测器本身已不可信，**不要**据此判断暂存区是否干净');
    console.error('='.repeat(78));
    for (const p of self.problems) console.error(`  ❌ ${p}`);
    console.error('\n  修检测器，不要修样本。');
    return 2;
  }

  const files = listFiles();
  if (files.length === 0) {
    console.log('scan-commit-secrets: 暂存区为空（用 --all 扫整个工作区）· 内置自检通过');
    return 0;
  }

  const hits = [];
  const excluded = [];
  let scanned = 0;

  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;

    const byPath = forbiddenByPath(rel);
    if (byPath) {
      hits.push({ rel, line: 0, kind: `禁止入库的文件（${byPath}）`, sample: rel });
      continue;
    }

    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXT.has(ext) && ext !== '') continue;

    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    scanned += 1;

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const ln = i + 1;

      if (PRIVATE_KEY_RE.test(line)) {
        hits.push({ rel, line: ln, kind: '私钥块', sample: '-----BEGIN … PRIVATE KEY-----' });
      }

      for (const m of line.matchAll(TOKEN_RE)) {
        const r = classifyToken(m[0], line, m.index, m.index + m[0].length);
        if (r.suspect) hits.push({ rel, line: ln, kind: '43 位 Token 形态（非合成）', sample: mask(m[0]) });
        else excluded.push({ rel, line: ln, kind: `43 位串（${r.why}）`, sample: mask(m[0]) });
      }

      for (const m of line.matchAll(PHONE_RE)) {
        if (isSyntheticPhone(m[0])) {
          excluded.push({ rel, line: ln, kind: '手机号（合成号段登记表）', sample: mask(m[0]) });
        } else {
          hits.push({ rel, line: ln, kind: '11 位手机号', sample: mask(m[0]) });
        }
      }

      for (const m of line.matchAll(HEX_RE)) {
        const r = classifyHex(m[0], line);
        if (r.suspect) hits.push({ rel, line: ln, kind: `长 hex（${m[0].length} 位）`, sample: mask(m[0]) });
        else excluded.push({ rel, line: ln, kind: `长 hex（${r.why}）`, sample: mask(m[0]) });
      }
    }
  }

  const group = (list) => {
    const m = new Map();
    for (const h of list) {
      if (!m.has(h.kind)) m.set(h.kind, []);
      m.get(h.kind).push(h);
    }
    return m;
  };
  const byKind = group(hits);

  console.log('='.repeat(78));
  console.log(' scan-commit-secrets —— 提交前凭证/个人信息扫描');
  console.log(` 范围：${ALL ? '工作区全部受版本控制文件' : '暂存区'} · 扫描 ${scanned} 个文本文件 · 内置自检通过（${self.assertions} 条断言）`);
  console.log('='.repeat(78));

  // ⚠️ 排除项必须**可见**。静默的排除 = 假绿。
  if (excluded.length > 0) {
    const ex = group(excluded);
    console.log(`\n  已判定为非凭证并排除 ${excluded.length} 处（--audit 看明细）：`);
    for (const [kind, list] of ex) console.log(`      ${kind}：${list.length}`);
  }
  if (AUDIT && excluded.length > 0) {
    console.log('\n  --- 排除明细 ---');
    for (const h of excluded) console.log(`      ${h.rel}:${h.line}  ${h.sample}  [${h.kind}]`);
  }

  if (hits.length === 0) {
    console.log('\n  ✅ 未发现明文 Token / 手机号 / 长 hex / 私钥 / 禁止入库的文件');
    console.log('\n  提示：证据文件里凡涉及凭证，只保留掩码 / 长度 / sha8 ——');
    console.log('        见 docs/PHASE-10.md「取证材料也是凭证副本」一节。');
    return 0;
  }

  for (const [kind, list] of byKind) {
    console.log(`\n  ❌ ${kind}：${list.length} 处`);
    for (const h of list.slice(0, MAX_SHOWN)) {
      console.log(`       ${h.rel}${h.line ? `:${h.line}` : ''}  ${h.sample}`);
    }
    if (list.length > MAX_SHOWN) console.log(`       …另有 ${list.length - MAX_SHOWN} 处（--verbose 全看）`);
  }

  console.log(`\n  共 ${hits.length} 处命中。请**改文档**（换成掩码/长度/sha8），不要忽略。`);
  console.log('  若确认命中是合成数据/结构性误报，请改**判据或登记表**并说明理由 —— 不要用 || true。');
  return 1;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`scan-commit-secrets 执行失败：${e && e.message ? e.message : e}`);
  process.exit(2);
}
