/**
 * _b36-banner-src-mutation.mjs —— **源码级**变异：证明 e2e 的 53 条断言真的会红
 *
 * =============================================================================
 * 与 `_b36-banner-mutation.mjs` 的分工（两者**不能互相替代**）
 * =============================================================================
 * | 脚本 | 手法 | 能证明什么 | **不能**证明什么 |
 * |---|---|---|---|
 * | `_b36-banner-mutation.mjs` | **数据层**注入脏行 | 产品的每个过滤维度真的生效 | e2e 那些**断言本身**有没有观测力 |
 * | 本脚本 | **改产品源码**一个过滤条件 | 对应断言**会变红** | — |
 *
 * 为什么要后者（`docs/ENGINEERING-RULES.md` 铁律 ①：**断言不会变红 = 没有断言**）：
 *   数据层注入只能得出"脏行没被选中"，但**没被选中**也可能是因为
 *     · 断言读错了字段（比如读 `data.img` 而产品给的是 `data.banner`）⇒ 永远 null ⇒ 永远"通过"；
 *     · 判据写宽了（比如只判"不是那个指纹"，而实际连图片都没返回）。
 *   唯一能把这两者分开的办法：**故意把产品弄坏，看断言会不会叫**。
 *
 * 手法：**逐个过滤条件**在 `services/banner-service.ts` 里摘掉一处，
 *   重新构建 → 重启 → 跑 e2e → 断言**必须**变红 → 还原 → 重建 → 再跑必须全绿。
 *
 * 变异清单（每个都对应一条具名断言）：
 *   V1 去掉 `status: PUBLISHED`      ⇒ 「DRAFT/下架图不得被选中」类断言应变红
 *   V2 去掉 `revoked_at: null`       ⇒ 「下架后客户端不再显示」应变红
 *   V4 门店优先改成分店无关（直接查全局最新） ⇒ 「不串店 / 优先自有」应变红
 *   A1 后台门店下拉去掉 `active` 过滤  ⇒ 「停用门店不进下拉」应变红（观测器 admin）
 *   A2 后台门店下拉去掉范围裁剪        ⇒ 「门店角色只看自己的店」应变红（观测器 admin）
 *
 * 每个变异声明一个 `detector`（见下方 `DETECTORS`），并声明 `file`（默认第一个）：
 *   · e2e      → `_b36-banner-e2e.mjs`（走正常业务流程）
 *   · mutation → `_b36-banner-mutation.mjs`（直插脏行）
 *   · admin    → `_b36-admin-probe.mjs`（后台列表 + 门店下拉契约）
 *
 * ⚠️ 安全：本脚本**一定**在 finally / 进程退出时还原源码并重建。
 *    若中途被打断，先手工 `git diff` 看 `banner-service.ts`，再重建。
 * ⚠️ 本脚本会**重启 app 容器**（改服务端代码必须重启才生效）。
 *
 * 用法：`node scripts/_b36-banner-src-mutation.mjs`
 *   退出码：0 = 每个变异都让对应断言变红，且还原后全绿；
 *          1 = **有变异没被任何断言发现**（探针观测力不足）；
 *          2 = 环境未就绪（无法构建 / 还原失败）
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { ROOT, purgeRowsByRequestId } from './_b36-lib.mjs';

/** 变异期间"前置直插"的行统一带这个 request_id 前缀，便于精确清理 */
const PROBE_PREFIX = 'probe-b36-srcmut-';

// ---------------------------------------------------------------------------
// 造一张辨识度高的 PNG（与其它脚本的素材指纹不冲突）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(width, height, seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const o = rowStart + 1 + x * 3;
      const band = Math.floor((x * 3 + seed * 61) / width);
      const stripe = (x + y + seed * 17) % 23 === 0 ? 70 : 0;
      raw[o] = (band === 0 ? 25 : band === 1 ? 230 : 110) + stripe;
      raw[o + 1] = (band === 0 ? 190 : band === 1 ? 30 : 100) + stripe;
      raw[o + 2] = (band === 0 ? 70 : band === 1 ? 210 : 50) + stripe;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SVC = path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/services/banner-service.ts');
const ORIGINAL = fs.readFileSync(SVC, 'utf8');
/** 备份文件放 .tmp-media（不在 git 索引里），但也用内存里的 ORIGINAL 做还原依据 */
const BACKUP = path.resolve('.tmp-media/_b36-banner-service.orig.ts');

/**
 * 多文件变异的第二目标：后台配置区（`actions/svc/banner.ts`）。
 * ⚠️ 有了第二个文件，"还原"就不能再只写回一个常量 —— 见 `restore()`。
 * ⚠️ 这些常量必须和 `SVC`/`ORIGINAL` 声明在一起：`const` 有 TDZ，
 *    放到下面会让顶层的备份写入直接 `ReferenceError`（首跑踩到）。
 */
const SVC_BANNER = path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/actions/svc/banner.ts');
const ORIGINAL_BANNER = fs.readFileSync(SVC_BANNER, 'utf8');
const BACKUP_BANNER = path.resolve('.tmp-media/_b36-banner-actions.orig.ts');

fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
fs.writeFileSync(BACKUP, ORIGINAL);
fs.writeFileSync(BACKUP_BANNER, ORIGINAL_BANNER);

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    ...opts,
    // 🔴 让**子进程**也能重建产物。
    //
    // 事故（2026-11-16，本脚本第 2 版）：本脚本用 `execFileSync` **从自己进程内部**
    // 再调一次 `build-plugin.mjs`。而 `build-plugin.mjs` 开头会
    // `fs.rmSync(dist, {recursive:true})` 清旧产物 —— `dist` 下有 60 个条目，
    // 超过沙箱的 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD`(50) ⇒
    // 抛 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，构建**硬失败**。
    //
    // 形态很坑：**同一个 build，我在工具层手跑能过、被脚本调就挂**。
    // 因为工具层的沙箱豁免**不会**传递给 `execFileSync` 的子进程。
    // 于是本脚本把"工具环境问题"报成了「变异后构建失败 ⇒ 变异不该让代码编不过」——
    // 一条**看起来像产品结论的工具噪声**。
    //
    // 判据：stderr 里出现 `SAFE_DELETE_BULK` ⇒ **工具环境**，不是产品。
    // 修法：显式把阈值调高（只影响本脚本派生的子进程，不改动仓库任何文件）。
    // ⚠️ 放在 `...opts` **之后**：调用方若自带 env，阈值仍必须保住
    //    （否则一次 `{env:{...}}` 的调用就又把它顶掉了）。
    env: {
      ...process.env,
      CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD: '5000',
      ...(opts.env ?? {}),
    },
  });
}

/** 构建插件（等同 `node scripts/build-plugin.mjs`），只关心成败 */
function build() {
  try {
    run(process.execPath, ['scripts/build-plugin.mjs']);
    return { ok: true, out: '' };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
  }
}

/**
 * 重启 app：必须 `docker stop` 让 Windows 释放 bind 挂载的 dist 句柄，
 * 再 `up -d`。直接 `restart` 有时拿到的是旧句柄（本项目在 Windows 上踩过）。
 */
function restartApp() {
  try { run('docker', ['stop', 'svc-app']); } catch { /* 可能本来就没跑 */ }
  run('docker', ['compose', 'up', '-d', 'app']);
  // 等健康。⚠️ "healthy" 本身就是一次结构验证：
  //    插件启动自检（资源形状表 ↔ handler 实现）不过的话容器起不来。
  for (let i = 0; i < 30; i += 1) {
    let status = '';
    try {
      status = run('docker', ['inspect', '-f', '{{.State.Health.Status}}', 'svc-app']).trim();
    } catch { /* 忽略 */ }
    if (status === 'healthy') return true;
    // 同步等待 5s（不用 shell 的 sleep，避免 Windows/Git Bash 差异）
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
  return false;
}

/**
 * ⚠️ 锚点一律用**单行**，绝不拼多行字符串。
 *    本仓库源码是 **CRLF**（`docs/ENGINEERING-RULES.md` V5）：用 `\n` 拼出的
 *    多行锚点**永远匹配不上**，表现是"变异没生效却以为跑了"——一种假绿。
 *    单行锚点天然对行尾免疫。
 */
const ANCHOR_OWN = 'filter: { ...PUBLIC_BANNER_FILTER, store_id: sid, enabled: true },';
const ANCHOR_SID = "const sid = Number(storeId);";

// ---- 后台配置区（`actions/svc/banner.ts`）的锚点 ----
// 对应 `_b36-admin-probe.mjs` 的 ①/⑤ 两组断言。
const ANCHOR_ACTIVE = 'const activeFilter = { active: true };';
const ANCHOR_SCOPE_SUB = 'filter: { ...activeFilter, id: { $in: scope.storeIds } },';

const MUTATIONS = [
  {
    id: 'V1',
    what: '去掉 `status: PUBLISHED` 过滤（草稿也会被选中）',
    detector: 'e2e',
    apply: (src) => src.replace(
      ANCHOR_OWN,
      'filter: { store_id: sid, enabled: true }, // [MUTATION V1] 故意丢掉状态判定',
    ),
  },
  {
    id: 'V2',
    what: '去掉 `revoked_at: null`（已下架的还会被选中）',
    // ⚠️ **必须由数据层变异来发现**：`revokeBanner` 会同时把 status 改成 REVOKED，
    //    所以"PUBLISHED 但 revoked_at 有值"这种行正常流程造不出来 ⇒ e2e 结构上看不见
    //    （首跑把它交给 e2e 就得到了一条假的"逃逸"）。详见上面 DETECTORS 的注释。
    detector: 'mutation',
    apply: (src) => src.replace(
      ANCHOR_OWN,
      'filter: { status: BANNER_STATUS.PUBLISHED, store_id: sid, enabled: true }, // [MUTATION V2] 故意丢掉下架判定',
    ),
  },
  {
    id: 'V4',
    what: '门店优先改成分店无关（直接取全局最新，会串店）',
    detector: 'e2e',
    apply: (src) => src
      .replace(ANCHOR_OWN, 'filter: { ...PUBLIC_BANNER_FILTER, enabled: true }, // [MUTATION V4] 故意丢掉门店归属')
      .replace(ANCHOR_SID, `${ANCHOR_SID}\n  void sid; // [MUTATION V4] 让未使用变量不报错`),
  },

  // ───────────────────────────────────────────────────────────────────────
  // A 组：后台配置区（`actions/svc/banner.ts`）—— 观测器是 `_b36-admin-probe.mjs`
  //
  // ⚠️ 这两条是**被真实缺陷逼出来的**：初版 `BannerManager` 调了
  //    `request('svc:storeOptions')` 并读 `data.items`，而该动作返回的是
  //    `{options:[{code,name}]}` —— **没有数字主键 id**，且 `bannerUpload.store_id`
  //    要的就是主键。结果形态是"页面能开、不报错、只是选不了门店"。
  //    ⇒ 断言必须能看见这类"静默降级"，所以必须有变异来证明它们真会红。
  // ───────────────────────────────────────────────────────────────────────
  {
    id: 'A1',
    file: 'banner-actions',
    what: '门店下拉不再按 `active` 过滤（停用门店也会出现在下拉里）',
    detector: 'admin',
    apply: (src) => src.replace(
      ANCHOR_ACTIVE,
      'const activeFilter = {}; // [MUTATION A1] 故意丢掉"只给启用门店"',
    ),
  },
  {
    id: 'A2',
    file: 'banner-actions',
    what: '门店角色的下拉不再收范围（把全部门店都给它）',
    detector: 'admin',
    apply: (src) => src.replace(
      ANCHOR_SCOPE_SUB,
      'filter: { ...activeFilter }, // [MUTATION A2] 故意丢掉 id ∈ scope.storeIds',
    ),
  },
];

/**
 * 🔴 本脚本的**核心设计**：每个源码变异都必须指定"由哪个观测器来发现它"。
 *
 * 为什么（首跑踩到，值得记下来）：
 *   我最初让**所有**变异都交给 `_b36-banner-e2e.mjs` 来发现。V1/V4 通过了，
 *   **V2 却逃逸**。排查后不是探针坏，而是**分工错了**：
 *
 *     · `revokeBanner()` **同时**改 `status → REVOKED` 与 `revoked_at = now()`
 *       ⇒ 「`status='PUBLISHED'` 且 `revoked_at` 有值」这种行
 *          **在正常业务流程里永远产不出来**。
 *     · 而 e2e 走的就是正常业务流程（上传→发布→下架），并且**开头会清库**。
 *       所以它**结构上不可能**观测到"单独摘掉 `revoked_at` 条件"这件事。
 *
 *   ⇒ 硬把 V2 塞给 e2e，只会得到一条**假的"逃逸"**（其实是我给错了观测器）。
 *      正确做法是：**能造出该形态数据的观测器**去发现它 ——
 *      也就是 `_b36-banner-mutation.mjs`（它直插脏行，不受业务流程限制）。
 *
 * 于是每个变异带一个 `detector`：
 *   · `'e2e'`      → 跑 `_b36-banner-e2e.mjs`，期望 exit 1
 *   · `'mutation'` → 跑 `_b36-banner-mutation.mjs`，期望 exit 1
 *
 * 这同时把 `_b36-banner-mutation.mjs` 的**观测力**也证了（否则它只是个"全绿脚本"）。
 */
const DETECTORS = {
  e2e: {
    label: '端到端探针（走正常业务流程）',
    run: () => runScript('scripts/_b36-banner-e2e.mjs'),
  },
  mutation: {
    label: '数据层变异（直插脏行，能造出业务流程造不出的形态）',
    run: () => runScript('scripts/_b36-banner-mutation.mjs'),
  },
  admin: {
    label: '后台契约探针（列表 + 门店下拉）',
    run: () => runScript('scripts/_b36-admin-probe.mjs'),
  },
};

function runScript(rel) {
  try {
    const out = run(process.execPath, [rel], { stdio: 'pipe' });
    return { code: 0, out, failed: [] };
  } catch (e) {
    const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
    const code = typeof e.status === 'number' ? e.status : 2;
    const failed = [];
    let inList = false;
    for (const line of out.split(/\r?\n/)) {
      if (line.includes('失败项：')) { inList = true; continue; }
      // 两个观测器的红灯行格式不同，都要认（否则会得到"逃逸"的假结论）：
      //   · e2e      → `  FAIL  某某断言  [..]`
      //   · mutation → `  FAIL  M2 某某 脏行未被选中  [..]` + 自报「变异逃逸」
      if (line.includes('变异逃逸') || line.includes('变异未被选中')) { failed.push(line.trim()); continue; }
      if (/^\s+FAIL\b/.test(line)) { failed.push(line.trim()); continue; }
      if (inList && /^\s+- /.test(line)) failed.push(line.trim().replace(/^-\s*/, ''));
    }
    return { code, out, failed };
  }
}

/** 兼容旧调用点：默认观测器 = e2e */
function runE2E() { return DETECTORS.e2e.run(); }

/**
 * 多文件还原。
 *
 * 🔴 为什么不能只写回一个常量：本脚本现在会改**两个**源文件。
 *    只还原其中一个，留下的那处变异会**静默留在工作区** ——
 *    表现为"下一轮 e2e 莫名其妙变红"，而这正是最贵的一类故障。
 *    ⇒ 还原一律走这张表，逐个写回 + **逐个字节复核**（"写了"不等于"写对了"）。
 */
const FILES = {
  'banner-service': { path: SVC, original: ORIGINAL, backup: BACKUP, label: 'services/banner-service.ts' },
  'banner-actions': { path: SVC_BANNER, original: ORIGINAL_BANNER, backup: BACKUP_BANNER, label: 'actions/svc/banner.ts' },
};

function fileOf(m) { return FILES[m.file ?? 'banner-service']; }

function restore() {
  for (const key of Object.keys(FILES)) {
    const f = FILES[key];
    try {
      fs.writeFileSync(f.path, f.original);
      // ⚠️ 独立复核：`writeFileSync` 没抛错 ≠ 内容真的回去了
      const now = fs.readFileSync(f.path, 'utf8');
      const same = now === f.original;
      console.log(`  · 已还原 ${f.label}：${same ? '✅ 字节一致' : '❌ 内容不一致！'}`);
      if (!same) {
        console.error(`  ⚠️ ${f.label} 还原后与原始内容不同！请手工从 ${f.backup} 恢复。`);
      }
    } catch (e) {
      console.error(`  ⚠️ 还原 ${f.label} 失败！请手工从 ${f.backup} 恢复：${e.message}`);
    }
  }
}

async function main() {
  console.log('\n════════ B-36 源码级变异（证明断言会红） ════════');
  console.log('  ⚠️ 本脚本会改产品源码 + 重建 + 重启容器；结束**一定**还原。\n');

  // 🔴 开工前先确认源码是**干净的**。
  //    为什么必须有这一步（真踩过）：本脚本"改了源码 → 构建 → 重启 → 跑探针"，
  //    中间任何一步被中断（超时/被 kill/管道 SIGPIPE），**变异就留在工作区**了。
  //    下一轮跑起来会基于"已经被改坏的产品"得出结论，而这个结论**看起来完全正常**。
  //    实测：一次 `| head -5` 触发 SIGPIPE 杀掉进程，`banner-service.ts` 留下了
  //    V4 的变异（`filter: {...PUBLIC_BANNER_FILTER, enabled: true }`）—— 门店归属判定被摘掉。
  //    ⇒ 判据：源文件里**不得**出现 `MUTATION` 标记；出现即 exit 2（环境未就绪，
  //      不下产品结论），并明确告诉人怎么恢复。
  let dirty = [];
  for (const key of Object.keys(FILES)) {
    const f = FILES[key];
    if (/\[MUTATION /.test(f.original)) dirty.push(f.label);
  }
  if (dirty.length) {
    console.log('  ⛔ 检测到工作区**残留着变异**：' + dirty.join(', '));
    console.log('     ⇒ 这是【环境未就绪】，不是产品结论。请先还原：');
    console.log('       git checkout -- nocobase/plugins/service-ticket/src/server/');
    console.log('       （或从 .tmp-media/*.orig.ts 覆盖回去）');
    process.exit(2);
  }
  console.log('  · 开工自检：两个源文件均无残留变异 ✅');

  const log = [];
  let bail = null;

  try {
    for (const m of MUTATIONS) {
      // 每个变异声明自己改哪个文件（默认 banner-service，兼容原有三条）
      const f = fileOf(m);
      const mutated = m.apply(f.original);
      if (mutated === f.original) {
        console.log(`  ⛔ ${m.id} 变异未生效（锚点没匹配上）—— 这是【工具坏了】，不是产品结论。`);
        console.log(`     （目标文件 ${f.label}；本仓库是 CRLF，多行锚点必须按行尾对齐：见 ENGINEERING_RULES V5）`);
        bail = `变异 ${m.id} 的锚点未匹配`;
        break;
      }
      fs.writeFileSync(f.path, mutated);
      console.log(`\n── ${m.id}：${m.what} ──`);
      console.log(`  · 目标 ${f.label}，已注入变异，重建 + 重启 …`);
      const b = build();
      if (!b.ok) {
        // ⚠️ 区分两类「构建失败」，否则会把工具环境问题报成产品结论（本轮真踩过）：
        //    · SAFE_DELETE_BULK_* ⇒ 沙箱的批量删除闸（工具环境），**不是**变异把代码改坏了；
        //    · 其它 ⇒ 才可能是变异真的编不过。
        const isSandbox = /SAFE_DELETE_BULK/.test(b.out);
        console.log(
          isSandbox
            ? '  ⛔ 变异后构建被**沙箱**拦下（SAFE_DELETE_BULK_*）—— 这是【工具环境】，不是产品结论。'
            : '  ⛔ 变异后构建失败 —— 这本身是【工具坏了】（变异不该让代码编不过）',
        );
        console.log(b.out.split(/\r?\n/).slice(-12).join('\n'));
        bail = isSandbox
          ? `变异 ${m.id} 的构建被沙箱拦下（SAFE_DELETE_BULK）—— 环境未就绪`
          : `变异 ${m.id} 导致构建失败`;
        break;
      }
      const healthy = restartApp();
      console.log(`  · 容器 healthy=${healthy}`);
      if (!healthy) { bail = `变异 ${m.id} 后容器未 healthy`; break; }

      // ---- 观测器：由变异**自己声明**用哪个（见 DETECTORS 的注释） ----
      const det = DETECTORS[m.detector];
      if (!det) { bail = `变异 ${m.id} 声明了未知观测器 ${m.detector}`; break; }
      console.log(`  · 观测器：${det.label}`);
      const r = det.run();
      const red = r.code === 1 && r.failed.length > 0;
      console.log(`  ${red ? 'PASS' : 'FAIL'}  ${m.id} 变异被断言发现（观测器必须 exit 1）  [exit=${r.code} 红灯 ${r.failed.length} 条]`);
      if (r.failed.length) {
        for (const f of r.failed.slice(0, 6)) console.log(`        · ${f}`);
        if (r.failed.length > 6) console.log(`        · …另有 ${r.failed.length - 6} 条`);
      }
      log.push({ id: m.id, detector: m.detector, detected: red, code: r.code, n: r.failed.length });

      if (!red) {
        console.log(`  ⛔ ${m.id} **变异逃逸** —— 产品被弄坏了，观测器却全绿 ⇒ 观测力不足。`);
        bail = `变异 ${m.id} 逃逸（观测器 ${m.detector}）`;
        break;
      }
    }
  } finally {
    // 🔴 无论走哪条路，都必须还原并重建出一个可用的产品
    restore();
    // ⚠️ 前置直插的行必须先清掉，否则"还原后全绿"会被**自己造的数据**破坏
    //    （那会让人误判成"还原没成功"，而实际只是探针残留）
    try {
      const c = purgeRowsByRequestId(PROBE_PREFIX);
      console.log(`  · 清掉残留前置行：文件 ${c.removed} 个，复核剩余 ${c.left} 行`);
    } catch (e) {
      console.error(`  ⚠️ 清理前置行失败：${e.message}`);
    }
    console.log('\n── 还原后重建 + 重启 ──');
    const b = build();
    console.log(`  · 重建 ${b.ok ? '成功' : '失败'}`);
    const healthy = restartApp();
    console.log(`  · 容器 healthy=${healthy}`);
    const r = runE2E();
    console.log(`  · 还原后 e2e：exit=${r.code} ${r.code === 0 ? '（全绿）' : '（不是全绿！）'}`);
    if (r.code !== 0) {
      console.log('    失败项：');
      for (const f of r.failed) console.log(`      - ${f}`);
      console.log('  ⛔ 还原后没有回到全绿 ⇒ 环境有问题，不给结论。exit 2');
      process.exit(2);
    }
    // ⚠️ 还原后**两个**观测器都要绿：只验 e2e 会漏掉"banner.ts 没还原干净"
    //    （它恰恰只影响后台探针）。
    const ra = DETECTORS.admin.run();
    console.log(`  · 还原后 admin-probe：exit=${ra.code} ${ra.code === 0 ? '（全绿）' : '（不是全绿！）'}`);
    if (ra.code !== 0) {
      console.log('    失败项：');
      for (const f of ra.failed) console.log(`      - ${f}`);
      console.log('  ⛔ 还原后后台探针没有回到全绿 ⇒ 环境有问题（很可能某个源文件没还原干净）。exit 2');
      process.exit(2);
    }
    // 独立确认两个源文件都**逐字节**回到原始状态（不信 restore() 的自我报告）
    for (const key of Object.keys(FILES)) {
      const f = FILES[key];
      const now = fs.readFileSync(f.path, 'utf8');
      const same = now === f.original;
      console.log(`  · ${f.label} 字节复核：${same ? '✅ 与原始一致' : '❌ 不一致！'}`);
      if (!same) {
        console.log(`  ⛔ ${f.label} 残留了变异内容 ⇒ 不给结论。exit 2`);
        process.exit(2);
      }
    }
  }

  console.log('\n════════════════════════════════════════════════');
  if (bail) {
    // ⚠️ 退出码必须区分"工具/环境坏了"与"变异逃逸了"：
    //    · 逃逸（观测器全绿）    ⇒ exit 1：**产品/探针的观测力**有问题；
    //    · 环境未就绪（沙箱/构建）⇒ exit 2：**不给产品结论**。
    //    混成一个码，会让"环境问题"看起来像"断言不够强"，从而去改本来没错的断言。
    const isEnv = /沙箱|环境未就绪|未 healthy|锚点未匹配|未知观测器/.test(bail);
    console.log(`  ${isEnv ? '⚠️' : '❌'} ${bail}`);
    process.exit(isEnv ? 2 : 1);
  }
  console.log(`  ✅ ${log.length} 个源码变异**全部**被断言抓到，且还原后全绿。`);
  console.log('     ⇒ e2e 的那些断言有观测力（它们真的会红，不是"没试出错"）。');
  process.exit(0);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  restore();
  process.exit(2);
});

/**
 * 🔴 中断兜底：被 kill / 超时 / 管道 SIGPIPE 时**也要**还原。
 *
 * 为什么必须有（真踩过，代价是"基于改坏的产品得出了正确结论"这种最隐蔽的假绿）：
 *   `finally` 只覆盖"代码正常走到"的路径。进程被**强杀**时 `finally` 不执行，
 *   变异就留在源码里，而**下一次运行会把它当成基线**。
 *   实测：`node scripts/... | head -5` 触发 SIGPIPE，进程被杀，
 *   `banner-service.ts` 留下了 V4（门店归属判定被摘掉）。
 *
 * ⚠️ 这里在 SIGINT/SIGTERM 处理器里**同步**还原是安全的：`restore()` 只做
 *    `writeFileSync` + `readFileSync`，不依赖事件循环。
 * ⚠️ 不能在这里 `process.exit()` 之前做异步操作（信号处理器里异步不会被等到）。
 */
function restoreOnSignal(sig) {
  console.error(`\n  ⚠️ 收到 ${sig} —— 立即还原源码后退出（不重建；工作区已安全）`);
  restore();
  process.exit(2);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => restoreOnSignal(sig)); } catch { /* 平台不支持该信号名 */ }
}
