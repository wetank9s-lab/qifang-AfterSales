#!/usr/bin/env node
/**
 * verify-technician-upload.mjs —— **上传安全矩阵**（P5-1）
 * =============================================================================
 *
 * 师傅照片上传是本项目**唯一**允许匿名写磁盘的入口。所以这里不测"能不能上传成功"
 * 这一件事，而是把"哪些东西必须被挡住、挡住之后有没有副作用"逐格钉死。
 *
 * -----------------------------------------------------------------------------
 * 矩阵 A：内容判定（离线，喂真实字节）
 * -----------------------------------------------------------------------------
 *   A1 magic bytes 才是判据：真 JPEG/PNG/WebP 通过；改名的 PHP、SVG、
 *      文本、截断的 JPEG 一律拒绝（**其中截断的真 JPEG 是最容易漏的一格**：
 *      它在字节层面确实是 JPEG，必须靠"头部尺寸解析不出"挡住）
 *   A2 EXIF/GPS 真的没了：用 **Pillow 这个真实解码器**验证
 *      —— 剥离后的文件仍能解码、尺寸不变、像素**逐字节一致**、`getexif()` 为空、
 *      GPS IFD 为空。这是"去 EXIF"这句话唯一有意义的证法：
 *      搜关键字那种断言在同名自定义段上会假过。
 *   A3 剥离不破坏容器：WebP 的 RIFF 长度字段必须重算（不改的话文件能被嗅探器
 *      认出来但解码器读不了 —— 典型的"看起来成功、实际打不开"）
 *
 * -----------------------------------------------------------------------------
 * 矩阵 B：落盘与读取（联机，真打接口）
 * -----------------------------------------------------------------------------
 *   B1 落私有目录、**不在**公共可服务目录（用**同一把 storage_key** 在两处探，
 *      公共路径必须是 404 级的不存在）
 *   B2 磁盘上的字节 == 本地剥离后的字节（证明"存进去的确实是剥离版"，
 *      而不是"上传时剥了、存的是原图"这种最容易写出的错）
 *   B3 张数上限 6：第 7 张 422 `PHOTO_LIMIT_REACHED`，且**没有多出第 7 个文件**
 *   B4 单张大小上限：超限 413，且没有落地文件
 *   B5 类型不符 415，且**一个 inode 都不该产生**（校验在写盘之前）
 *   B6 受控读取：GET photos/:ref → 200 + 正确 Content-Type + no-store + nosniff
 *   B7 **属主校验**：拿 A 单的 ref 去 B 单的 token 读 → 404（ref 不可猜 ≠ 已授权）
 *   B8 Visit 已 SUBMITTED / 已 SUPERSEDED 之后：上传被拒，且无新增行/文件
 *   B9 **事务边界**：照片上传成功 ≠ 提交成功。上传 3 张后"刷新"（重新 GET）
 *      → 仍能看到这 3 张、ref 稳定、**Visit 数不变**（不能产生第二个 Visit）
 *   B10 token 维度限流：临时把每小时上限降到 2，第 3 次上传 429；跑完恢复原值
 *
 * -----------------------------------------------------------------------------
 * 矩阵 C：契约与文案（离线，纯函数）
 * -----------------------------------------------------------------------------
 *   C1 `photo_ref` 的派生规则：22 位、不含 photoId 原文、随 photoId/tokenHash 变化
 *   C2 `SERVICE_RESULT_OPTIONS` / `PHOTO_TYPE_OPTIONS` 仍是原来的 5/4 项（P5-1
 *      把它们从手写数组改成"从常量标签表派生"，这一格盯住派生没改变对外取值）
 *   C3 提交成功文案**不含"完成"**（师傅提交 ≠ 工单完成；含"完成"即为缺陷）
 *
 * -----------------------------------------------------------------------------
 * 用法
 * -----------------------------------------------------------------------------
 *   node scripts/verify-technician-upload.mjs               # 全部
 *   node scripts/verify-technician-upload.mjs --static-only # 只跑 A/C（不需要环境）
 * 退出码：0 全绿 / 1 真红灯 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

import {
  BASE_URL,
  EnvNotReady,
  acceptAndDispatch,
  assert,
  cleanupTicket,
  createScratchTicket,
  eq,
  errorMessageOf,
  localDateOnly,
  makeChecker,
  PRIVATE_DIR,
  PUBLIC_UPLOAD_DIR,
  inApp,
  psqlExec,
  psqlRows,
  psqlScalar,
  runMain,
  SMS_ENABLED_KEY,
  smsSwitch,
  svcPost,
  technicianGet,
  technicianPhoto,
  technicianSubmit,
  technicianUpload,
  tokenFromOutbox,
  twoSessions,
  ROOT,
} from './technician-harness.mjs';

const argv = process.argv.slice(2);
const STATIC_ONLY = argv.includes('--static-only');

const { check, checkAsync, summary, state } = makeChecker({ heading: '上传安全矩阵' });

const TMP = path.join(ROOT, '.tmp-verify', 'p5-media');
const NODE_WORKSPACE = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.workbuddy',
  'binaries',
  'node',
  'workspace',
);
/** 宿主机上的 Pillow（真实解码器）。找不到就**如实降级**，不假装验过 */
const PYTHON = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.workbuddy',
  'binaries',
  'python',
  'envs',
  'default',
  'Scripts',
  'python.exe',
);

function loadEsbuild() {
  const nodeRequire = createRequire(import.meta.url);
  for (const load of [
    () => nodeRequire('esbuild'),
    () => nodeRequire(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild')),
  ]) {
    try {
      return load();
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

let MediaGuard = null;
let PhotoRef = null;

/** 编译共享纯模块（与 verify-client-logic 同一套 esbuild 兜底顺序） */
async function compileShared() {
  const esbuild = loadEsbuild();
  if (!esbuild) throw new Error('找不到 esbuild');
  fs.mkdirSync(TMP, { recursive: true });
  const entry = path.join(TMP, 'shared-entry.ts');
  const src = (name) => path.join(ROOT, 'nocobase/plugins/service-ticket/src/shared', name);
  fs.writeFileSync(
    entry,
    [`export * from '${src('media-guard.ts').replace(/\\/g, '/')}';`,
     `export * from '${src('photo-ref.ts').replace(/\\/g, '/')}';`].join('\n'),
  );
  const outfile = path.join(TMP, 'shared.cjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    logLevel: 'warning',
  });
  const nodeRequire = createRequire(import.meta.url);
  MediaGuard = nodeRequire(outfile);
  PhotoRef = MediaGuard;
}

// ---------------------------------------------------------------------------
// Pillow 夹具
// ---------------------------------------------------------------------------
const MAKE_FIXTURES_PY = String.raw`
import os, sys
from PIL import Image
D = sys.argv[1]
def exif_bytes():
    e = Image.Exif()
    e[0x010F] = "SvcCam"; e[0x0110] = "Model-P5"
    e[0x0132] = "2026:09:23 10:00:00"
    e[0x8825] = {1: "N", 2: (39.9, 0.0, 0.0), 3: "E", 4: (116.38, 0.0, 0.0)}
    return e
img = Image.new("RGB", (640, 480))
px = img.load()
for y in range(480):
    for x in range(640):
        px[x, y] = ((x * 7) % 256, (y * 5) % 256, ((x + y) * 3) % 256)
e = exif_bytes()
img.save(os.path.join(D, "real-exif.jpg"), "JPEG", quality=90, exif=e)
img.save(os.path.join(D, "real-exif.png"), "PNG", exif=e)
img.save(os.path.join(D, "real-exif.webp"), "WEBP", quality=90, exif=e)
raw = open(os.path.join(D, "real-exif.jpg"), "rb").read()
open(os.path.join(D, "truncated.jpg"), "wb").write(raw[:300])
# 超大样本（> nginx 的 client_max_body_size=8m）→ 用于测 nginx 那一层兜底
big = Image.new("RGB", (4000, 3000))
bp = big.load()
for y in range(0, 3000, 3):
    for x in range(0, 4000, 3):
        bp[x, y] = ((x * 13) % 256, (y * 17) % 256, ((x ^ y) % 256))
big.save(os.path.join(D, "oversize.jpg"), "JPEG", quality=98)
# 中等样本：**刻意落在 (1MB, 8MB) 这个窗口里**。
# 用途是测**应用层**的单张上限（手段：把 visit.photo_max_size_mb 临时降到 1）。
# 为什么不能直接拿 oversize.jpg 去打应用层：nginx 的 client_max_body_size 是 8m，
# 12.6MB 会被 nginx 先挡掉并回它自己的 HTML 413 —— 应用层的 PHOTO_TOO_LARGE
# 根本没机会执行，那条断言就变成了"在测 nginx"。
def save_in_window(path, size, lo=1_200_000, hi=6_000_000):
    w, h = size
    im2 = Image.new("RGB", (w, h))
    p2 = im2.load()
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            p2[x, y] = ((x * 31) % 256, (y * 47) % 256, ((x ^ y) % 256))
    for q in (95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 40, 30, 20):
        im2.save(path, "JPEG", quality=q)
        n = os.path.getsize(path)
        if lo <= n <= hi:
            return n, q
    return os.path.getsize(path), -1
mid_n, mid_q = save_in_window(os.path.join(D, "mid.jpg"), (1600, 1200))
print("OK oversize=", os.path.getsize(os.path.join(D, "oversize.jpg")), " mid=", mid_n, "q=", mid_q)
`;

const CHECK_WITH_PIL_PY = String.raw`
import os, sys, json
from PIL import Image
D = sys.argv[1]
out = {}
for name in ("real-exif.jpg", "real-exif.png", "real-exif.webp"):
    src, dst = os.path.join(D, name), os.path.join(D, "stripped-" + name)
    if not os.path.exists(dst):
        out[name] = {"error": "missing stripped output"}; continue
    with Image.open(src) as a:
        before = dict(a.getexif()); pixels_a = a.convert("RGB").tobytes(); size_a = a.size
        gps_a = {}
        try: gps_a = dict(a.getexif().get_ifd(0x8825) or {})
        except Exception: pass
    with Image.open(dst) as b:
        after = dict(b.getexif()); pixels_b = b.convert("RGB").tobytes(); size_b = b.size
        gps_b = {}
        try: gps_b = dict(b.getexif().get_ifd(0x8825) or {})
        except Exception: pass
    out[name] = {
        "exif_before": sorted(before), "gps_before": sorted(gps_a),
        "exif_after": sorted(after), "gps_after": sorted(gps_b),
        "size_before": list(size_a), "size_after": list(size_b),
        "pixels_identical": pixels_a == pixels_b,
    }
print(json.dumps(out))
`;

function hasPillow() {
  if (!fs.existsSync(PYTHON)) return false;
  try {
    execFileSync(PYTHON, ['-c', 'import PIL;print(PIL.__version__)'], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const fixtures = { a: 0, b: 0 };
const sms = smsSwitch();
let degraded = [];

async function staticPhase() {
  await compileShared();

  // ---- 夹具 ----
  const pillowReady = hasPillow();
  fs.mkdirSync(TMP, { recursive: true });
  if (!pillowReady) {
    degraded.push(
      `Pillow 不可用（${PYTHON}）→ 跳过"真实解码器验证 EXIF 已清空/像素不变"这一格；` +
        `A1 的严格拒绝判定仍然执行（用手工构造的字节）`,
    );
  } else {
    const out = execFileSync(PYTHON, ['-c', MAKE_FIXTURES_PY, TMP], { encoding: 'utf8' }).trim();
    console.log(`  · Pillow 夹具已生成：${out}`);
  }
  // 非图片样本（与 PIL 无关，自己写）
  fs.writeFileSync(path.join(TMP, 'php-named-as-jpg.jpg'), Buffer.from('<?php echo 1; ?>' + 'A'.repeat(4000), 'utf8'));
  fs.writeFileSync(path.join(TMP, 'payload.svg'), Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>", 'utf8'));
  fs.writeFileSync(path.join(TMP, 'plain.txt'), Buffer.from('just text, definitely not an image', 'utf8'));
  fs.writeFileSync(path.join(TMP, 'gif.gif'), Buffer.from('GIF89a' + '\u0000'.repeat(40), 'binary'));

  const readFixture = (name) => {
    const p = path.join(TMP, name);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  };

  console.log('\n── A1 magic bytes 才是判据（strict-deny）──');
  const expectAccepted = [
    ['real-exif.jpg', 'image/jpeg'],
    ['real-exif.png', 'image/png'],
    ['real-exif.webp', 'image/webp'],
  ];
  check('A1a 真实 JPEG/PNG/WebP 被识别为对应 MIME 且尺寸正确', () => {
    const results = [];
    for (const [name, mime] of expectAccepted) {
      const buf = readFixture(name);
      if (!buf) {
        degraded.push(`夹具 ${name} 缺失（Pillow 未就绪）`);
        continue;
      }
      const probe = MediaGuard.sniffImage(buf);
      assert(probe, `${name} 应被识别为图片`);
      eq(probe.mime, mime, `${name} 的 MIME`);
      eq([probe.width, probe.height], [640, 480], `${name} 的尺寸`);
      results.push(`${name}→${probe.mime}`);
    }
    assert(results.length > 0, '至少要有一种格式的样本（否则这一格是空跑）');
    return results.join(', ');
  });

  check('A1b 非图片一律拒绝：改名 PHP / SVG / 文本 / GIF / 截断 JPEG', () => {
    const cases = [
      ['php-named-as-jpg.jpg', '扩展名是 .jpg、声明可以是 image/jpeg，但内容是 PHP'],
      ['payload.svg', '主动内容（SVG）'],
      ['plain.txt', '纯文本'],
      ['gif.gif', 'GIF —— **曾经允许**的类型，现在按白名单拒绝'],
      ['truncated.jpg', '截断的真 JPEG'],
    ];
    const seen = [];
    for (const [name, why] of cases) {
      const buf = readFixture(name);
      if (!buf) continue;
      const probe = MediaGuard.sniffImage(buf);
      let rejected;
      if (!probe) {
        rejected = 'UNSUPPORTED_FORMAT';
      } else {
        // 截断的真 JPEG 走这条路：字节层面它确实是 JPEG，
        // 必须靠"头部尺寸解析不出"挡住 —— 否则会存下一张打不开的"照片"
        const issues = MediaGuard.probeIssues(probe);
        rejected = issues.includes('NO_DIMENSIONS') ? 'NO_DIMENSIONS' : '';
      }
      assert(rejected, `${name}（${why}）应被拒绝，实际被接受为 ${probe?.mime}`);
      seen.push(`${name}→${rejected}`);
    }
    assert(seen.length >= 4, `样本不足（只跑了 ${seen.length} 个）：${seen.join(', ')}`);
    return seen.join(', ');
  });

  check('A1c 声明为 image/jpeg 的 PHP 文件：判定结果与文件名/声明完全无关', () => {
    const buf = readFixture('php-named-as-jpg.jpg');
    assert(buf, '缺少 PHP 夹具');
    // 这几个"看起来像"的因素全部不影响判定：扩展名 .jpg、可打印的 ASCII 头、
    // 长度超过任何大小阈值。判据只有 magic bytes。
    assert(buf.slice(0, 5).toString() === '<?php', '夹具前提：它确实是 PHP 源码');
    eq(MediaGuard.sniffImage(buf), null, 'sniffImage 结果（应为 null）');
    return 'PHP 源码 + .jpg 扩展名 → 仍判为非法';
  });

  console.log('\n── A2/A3 EXIF 剥离（真实解码器验证）──');
  check('A2 剥离后：EXIF 与 GPS 为空 / 尺寸不变 / **像素逐字节一致** / 仍可解码', () => {
    assert(pillowReady, 'Pillow 不可用 —— 这一格无法验证（已记为降级项）');
    const removedMap = {};
    for (const [name] of expectAccepted) {
      const buf = readFixture(name);
      assert(buf, `缺少夹具 ${name}`);
      const probe = MediaGuard.sniffImage(buf);
      const { data, removed } = MediaGuard.stripImageMetadata(buf, probe.mime);
      fs.writeFileSync(path.join(TMP, `stripped-${name}`), data);
      removedMap[name] = removed;
      // 剥离后回查：不得再有元数据容器
      eq(MediaGuard.findMetadataTraces(data, probe.mime), [], `${name} 剥离后的残留元数据`);
      assert(removed.length > 0, `${name} 本该剥掉至少一段（相机写入的 EXIF）`);
    }
    const report = JSON.parse(
      execFileSync(PYTHON, ['-c', CHECK_WITH_PIL_PY, TMP], { encoding: 'utf8' }).trim(),
    );
    for (const [name, r] of Object.entries(report)) {
      assert(!r.error, `${name}: ${r.error}`);
      assert(r.exif_before.length > 0, `${name} 剥离**前**应有 EXIF（否则这一格什么都没测）`);
      assert(r.gps_before.length > 0, `${name} 剥离**前**应有 GPS IFD`);
      eq(r.exif_after, [], `${name} 剥离后的 EXIF 标签`);
      eq(r.gps_after, [], `${name} 剥离后的 GPS IFD`);
      eq(r.size_after, r.size_before, `${name} 的尺寸`);
      assert(r.pixels_identical, `${name} 的像素数据必须逐字节一致（段级剥离不该动像素）`);
    }
    return Object.entries(removedMap)
      .map(([n, r]) => `${n}:${r.join('+')}`)
      .join(' | ');
  });

  check('A3 WebP 剥离后 RIFF 长度字段已重算（与真实字节数一致）', () => {
    const name = 'stripped-real-exif.webp';
    const buf = readFixture(name);
    assert(buf, `缺少 ${name}`);
    const declared = MediaGuard.readRiffDeclaredSize(buf);
    assert(declared !== null, '读不到 RIFF 声明长度');
    // 规约：RIFF 的长度字段 = 文件总字节数 - 8
    eq(declared, buf.length - 8, 'RIFF 声明长度 vs 实际');
    return `declared=${declared} actual=${buf.length - 8}`;
  });

  console.log('\n── C1 photo_ref 派生规则 ──');
  check('C1 photo_ref：22 位、不含主键原文、随 photoId 与 tokenHash 变化', () => {
    const h1 = 'a'.repeat(64);
    const h2 = 'b'.repeat(64);
    const r1 = PhotoRef.photoRefOf(101, h1);
    const r2 = PhotoRef.photoRefOf(102, h1);
    const r3 = PhotoRef.photoRefOf(101, h2);
    eq(r1.length, 22, '长度');
    assert(/^[A-Za-z0-9_-]{22}$/.test(r1), `字符集不合法：${r1}`);
    assert(r1 !== r2, '不同 photoId 必须导出不同 ref');
    assert(r1 !== r3, '不同 token 哈希必须导出不同 ref（换访后旧 ref 自然失效）');
    assert(!r1.includes('101'), 'ref 不得包含主键原文');
    assert(PhotoRef.PHOTO_REF_PATTERN.test(r1), 'PHOTO_REF_PATTERN 必须认它');
    return `${r1}（22 位）`;
  });

  console.log('\n── C2/C3 契约与文案 ──');
  check('C2 service_result / photo_type 选项：改成"从常量派生"后取值与顺序不变', () => {
    // 期望值来自搬迁前的**手写数组**（记录在 P5-1 的改动说明里）。
    // 这一格的作用是：派生写法一旦改变对外取值（多/少/改名/换序），立刻变红。
    const expectedServiceResult = [
      { label: '已解决', value: 'resolved' },
      { label: '需再次上门', value: 'need_followup' },
      { label: '未解决', value: 'unresolved' },
      { label: '客户不在家', value: 'customer_absent' },
      { label: '其他', value: 'other' },
    ];
    const expectedPhotoType = [
      { label: '现场', value: 'onsite' },
      { label: '完工', value: 'completed' },
      { label: '收费凭证', value: 'receipt' },
      { label: '其他', value: 'other' },
    ];
    const src = fs.readFileSync(
      path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/collections/_options.ts'),
      'utf8',
    );
    // 静态判据：两个选项必须由标签表派生（出现手写数组即为回退）
    assert(
      /SERVICE_RESULT_OPTIONS\s*=\s*Object\.entries\(SERVICE_RESULT_LABEL\)/.test(src),
      'SERVICE_RESULT_OPTIONS 必须从 SERVICE_RESULT_LABEL 派生',
    );
    assert(
      /PHOTO_TYPE_OPTIONS\s*=\s*Object\.entries\(PHOTO_TYPE_LABEL\)/.test(src),
      'PHOTO_TYPE_OPTIONS 必须从 PHOTO_TYPE_LABEL 派生',
    );
    const labels = fs.readFileSync(
      path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/constants.ts'),
      'utf8',
    );
    for (const { label, value } of [...expectedServiceResult, ...expectedPhotoType]) {
      assert(labels.includes(`'${label}'`), `constants 的标签表里找不到"${label}"`);
      assert(labels.includes(`'${value}'`), `constants 的标签表里找不到值 ${value}`);
    }
    // 顺序：`Object.entries` 保序，所以标签表里的书写顺序就是 UI 顺序
    const serviceIdx = expectedServiceResult.map((o) => labels.indexOf(`'${o.label}'`));
    assert(
      serviceIdx.every((v, i) => i === 0 || v > serviceIdx[i - 1]),
      `service_result 标签表的顺序与原手写数组不一致：${serviceIdx.join(',')}`,
    );
    return `service_result ${expectedServiceResult.length} 项 / photo_type ${expectedPhotoType.length} 项`;
  });

  check('C3 提交成功文案不含"完成"（师傅提交 ≠ 工单完成）', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/actions/technician/visit.ts'),
      'utf8',
    );
    const m = /SUBMIT_SUCCESS_MESSAGE\s*=\s*'([^']+)'/.exec(src);
    assert(m, '取不到 SUBMIT_SUCCESS_MESSAGE 的字面量（它必须是一个显式常量）');
    const message = m[1];
    for (const word of ['完成', '结束', '闭环', '已解决']) {
      assert(!message.includes(word), `成功文案里出现了"${word}"：${message}`);
    }
    assert(message.includes('已提交') && message.includes('等待门店确认'), `文案不符预期：${message}`);
    // 整个响应体也不该出现"完成"（防止在别处又拼一个）
    const okBlock = /ok\(\s*ctx,\s*\{[\s\S]*?\}\s*,\s*\)/m.exec(src);
    if (okBlock) {
      const submitOk = /message:\s*SUBMIT_SUCCESS_MESSAGE/.test(src);
      assert(submitOk, 'submit 的成功响应必须复用 SUBMIT_SUCCESS_MESSAGE 常量，不能就地拼字符串');
    }
    return `"${message}"`;
  });

  return { pillowReady };
}

// ---------------------------------------------------------------------------
// 联机阶段
// ---------------------------------------------------------------------------
async function onlinePhase() {
  const { store, hq } = await twoSessions();
  console.log(`  · 打开 ${SMS_ENABLED_KEY}（原值 ${sms.original}），等待 11s 让配置缓存过期…`);
  await sms.enable();

  // ---- 两张一次性工单：A 走主链路，B 做属主越权对照 ----
  const a = await createScratchTicket({ tag: 'P5-1-UP-A', content: '照片上传矩阵主单' });
  fixtures.a = a.ticketId;
  await acceptAndDispatch(a.ticketId, store);
  const tokenA = (await tokenFromOutbox({ sessionToken: hq, ticketNo: a.ticketNo })).token;
  const aVisitId = Number(
    psqlScalar(
      `SELECT id FROM service_visits WHERE ticket_id = ${a.ticketId} AND visit_status='ASSIGNED' ORDER BY visit_no DESC LIMIT 1`,
    ),
  );
  console.log(`  · 主单 ${a.ticketNo}（id=${a.ticketId}，visit=${aVisitId}）`);

  const b = await createScratchTicket({ tag: 'P5-1-UP-B', content: '属主越权对照单' });
  fixtures.b = b.ticketId;
  await acceptAndDispatch(b.ticketId, store);
  const tokenB = (await tokenFromOutbox({ sessionToken: hq, ticketNo: b.ticketNo })).token;
  const bVisitId = Number(
    psqlScalar(
      `SELECT id FROM service_visits WHERE ticket_id = ${b.ticketId} AND visit_status='ASSIGNED' ORDER BY visit_no DESC LIMIT 1`,
    ),
  );
  console.log(`  · 对照单 ${b.ticketNo}（id=${b.ticketId}，visit=${bVisitId}）`);

  const jpeg = fs.readFileSync(path.join(TMP, 'real-exif.jpg'));
  const png = fs.readFileSync(path.join(TMP, 'real-exif.png'));
  const phpNamedJpg = fs.readFileSync(path.join(TMP, 'php-named-as-jpg.jpg'));
  const oversize = fs.existsSync(path.join(TMP, 'oversize.jpg'))
    ? fs.readFileSync(path.join(TMP, 'oversize.jpg'))
    : null;
  /** 落在 (1MB, 8MB) 窗口内的样本 —— 专供"应用层单张上限"那一格（见 B4 注释） */
  const mid = fs.existsSync(path.join(TMP, 'mid.jpg'))
    ? fs.readFileSync(path.join(TMP, 'mid.jpg'))
    : null;

  /** 库里该工单的照片行（含 storage_key） */
  const photosOf = (ticketId) =>
    psqlRows(
      `SELECT p.id, p.visit_id, p.storage_key, p.mime, p.size, coalesce(p.width::text,'-'),` +
        ` coalesce(p.height::text,'-'), p.sort_order, coalesce(p.upload_ip_hash,'-')` +
        ` FROM service_visit_photos p JOIN service_visits v ON v.id = p.visit_id` +
        ` WHERE v.ticket_id = ${ticketId} ORDER BY p.id`,
    );

  /** 私有目录里属于该 Visit 的文件数（直接数磁盘，不信库） */
  const filesOnDisk = (visitId) =>
    Number(
      inApp(
        `find ${PRIVATE_DIR}/visits/${visitId} -type f 2>/dev/null | wc -l`,
      ).out.replace(/\D/g, '') || 0,
    );

  let firstRef = '';

  console.log('\n── B1/B2 落盘位置与字节一致性 ──');
  await checkAsync('B1 上传成功 → 私有目录有文件、**公共可服务目录没有**同一个 storage_key', async () => {
    const r = await technicianUpload(tokenA, jpeg, { filename: 'onsite.jpg', photoType: 'onsite' });
    eq(r.status, 201, `HTTP（${errorMessageOf(r)}）`);
    const photo = r.json?.data?.photo;
    assert(photo?.ref, `响应缺 ref：${JSON.stringify(r.json).slice(0, 200)}`);
    firstRef = photo.ref;
    eq(photo.mime, 'image/jpeg', 'MIME');
    eq([photo.width, photo.height], [640, 480], '尺寸');
    assert(photo.size < jpeg.length, `剥离后应更小：原 ${jpeg.length} → 存 ${photo.size}`);

    const rows = photosOf(a.ticketId);
    eq(rows.length, 1, '照片行数');
    const key = rows[0][2];
    assert(
      /^visits\/\d+\/\d{6}\/[0-9a-f]{48}\.jpg$/.test(key),
      `storage_key 形状不符（应由服务端生成，不含任何用户输入）：${key}`,
    );

    const inPrivate = inApp(`test -f ${PRIVATE_DIR}/${key} && echo yes`).out.includes('yes');
    assert(inPrivate, `私有目录里找不到 ${key}`);
    // ⚠️ 这条是"私有存储"的**判据本身**：同一个相对路径在公共文档根下必须不存在。
    //    只断言"文件写到了私有目录"是不够的 —— 两个目录都写一份也满足前一句。
    const inPublic = inApp(`test -f ${PUBLIC_UPLOAD_DIR}/${key} && echo yes`).out.includes('yes');
    assert(!inPublic, `公共目录 ${PUBLIC_UPLOAD_DIR}/${key} 竟然存在 —— 私有存储已被破坏！`);
    eq(rows[0][3], 'image/jpeg', '库里的 mime');
    assert(rows[0][8] !== '-' && /^[0-9a-f]{64}$/.test(rows[0][8]), `upload_ip_hash 应为 sha256：${rows[0][8]}`);
    return `${key}（私有 ✓ 公共 ✗）`;
  });

  await checkAsync('B2 磁盘上的字节 == 本地剥离后的字节（证明存的是剥离版而不是原图）', async () => {
    const key = photosOf(a.ticketId)[0][2];
    const expected = MediaGuard.stripImageMetadata(jpeg, 'image/jpeg').data;
    // 两侧都在**本地**算 sha256，再用容器内的 sha256sum 与容器里的那份比 ——
    // 避免把几 MB 二进制拉出容器。
    // ⚠️ 曾用 `execFileSync('node', ['-e', …, buf.toString('base64')])` 传字节：
    //    12KB 的 base64 作为 argv 直接 ENAMETOOLONG（Linux argv 上限 ~128KB，
    //    而 Windows 的 spawn 上限更低）。**"把数据当命令行参数传"是个陷阱**，
    //    正确做法是在进程内算。
    const expectSha = createHash('sha256').update(expected).digest('hex');
    const shaCmd = inApp(`sha256sum ${PRIVATE_DIR}/${key}`).out.split(/\s+/)[0];
    eq(shaCmd, expectSha, '私有文件 sha256 vs 本地剥离结果 sha256');
    assert(expected.length < jpeg.length, '前提：剥离确实让字节变少了');
    return `${shaCmd.slice(0, 12)}… 一致（${jpeg.length}→${expected.length}B）`;
  });

  console.log('\n── B5 类型判定（拒绝时零副作用）──');
  await checkAsync('B5 改名 PHP 上传 → 415，且**一个新文件/新行都不产生**', async () => {
    const before = { rows: photosOf(a.ticketId).length, files: filesOnDisk(aVisitId) };
    const r = await technicianUpload(tokenA, phpNamedJpg, {
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
    });
    eq(r.status, 415, `HTTP（${errorMessageOf(r)}）`);
    eq(r.json?.errors?.[0]?.code, 'UNSUPPORTED_IMAGE', '错误码');
    const after = { rows: photosOf(a.ticketId).length, files: filesOnDisk(aVisitId) };
    eq(after, before, '副作用（行数/文件数）');
    // 响应里不该出现判定细节（"你给的是 PHP" 这类话等于教人构造绕过）
    assert(!/php/i.test(String(r.body)), `响应体泄漏了内容类型判定细节：${r.body.slice(0, 160)}`);
    return `415 ${r.json?.errors?.[0]?.code}，行/文件数不变`;
  });

  /**
   * 单张上限**分两层测**，因为这两层各有各的失效方式：
   *   B4  应用层 —— 产品参数 `visit.photo_max_size_mb` 真的被读到、真的生效
   *   B4b 网关层 —— nginx 的 `client_max_body_size` 作为更外圈的兜底
   * 合成一格会让"到底谁挡的"无从分辨：nginx 的 413 是一个 HTML 页、
   * 没有我们的 JSON 信封，客户端解析时会拿到 undefined 而不是错误码。
   */
  await checkAsync('B4 应用层单张上限：413 PHOTO_TOO_LARGE，且零副作用', async () => {
    if (!mid) {
      degraded.push('Pillow 未生成 mid.jpg → 跳过 B4（应用层大小上限）');
      return '（降级：无窗口内样本）';
    }
    // 手段：把**产品参数**临时降到 1MB，再用约 2MB 的样本打。
    // 为什么这么做而不是直接传那张 12.6MB 的大图：nginx 的 client_max_body_size
    // 是 8m，12.6MB 会被 nginx **先**挡下（回 HTML 413），应用层的
    // `PHOTO_TOO_LARGE` 根本不会执行 —— 那条断言就悄悄变成"在测 nginx"，
    // 而它看起来完全一样（都是 413）。
    assert(
      1 * 1024 * 1024 < mid.length && mid.length < 8 * 1024 * 1024,
      `样本必须落在 (1MB, 8MB) 窗口内才能测到应用层，实际 ${(mid.length / 1048576).toFixed(2)}MB`,
    );

    const key = 'visit.photo_max_size_mb';
    const original = psqlScalar(`SELECT value FROM service_settings WHERE key='${key}'`);
    assert(original !== '', `取不到 ${key} 的当前值`);

    try {
      psqlExec(`UPDATE service_settings SET value='1' WHERE key='${key}';`);
      await new Promise((r) => setTimeout(r, 11_000)); // 等过 ConfigService 的 10s 缓存

      const before = filesOnDisk(aVisitId);
      const r = await technicianUpload(tokenA, mid, { filename: 'mid.jpg' });
      eq(r.status, 413, `HTTP（上限已降为 1MB，样本 ${(mid.length / 1048576).toFixed(2)}MB）`);
      eq(r.json?.errors?.[0]?.code, 'PHOTO_TOO_LARGE', '错误码（必须是应用层的信封）');
      eq(filesOnDisk(aVisitId), before, '副作用（文件数）');
      // 与应用层判定无关的证据：响应必须**带我们的 JSON 信封**，
      // 这才说明它是应用层挡的而不是 nginx 挡的。
      assert(
        Array.isArray(r.json?.errors) && r.json.errors.length > 0,
        `413 但不是应用层信封（很可能是 nginx 先挡了）：${String(r.body).slice(0, 120)}`,
      );
      return `1MB 上限 vs ${(mid.length / 1048576).toFixed(2)}MB → 413，文件数不变`;
    } finally {
      // ⚠️ 改的是**产品参数**，无条件恢复：留在库里会污染后续所有验收
      psqlExec(`UPDATE service_settings SET value='${original}' WHERE key='${key}';`);
      const now = psqlScalar(`SELECT value FROM service_settings WHERE key='${key}'`);
      assert(now === original, `${key} 未恢复，请手工设为 '${original}'（当前 '${now}'）`);
      await new Promise((r) => setTimeout(r, 11_000));
    }
  });

  await checkAsync('B4b 网关层兜底：超过 nginx 上限的请求在应用之前被挡，且不留文件', async () => {
    if (!oversize) {
      degraded.push('Pillow 未生成 oversize.jpg → 跳过 B4b（网关层兜底）');
      return '（降级：无超大样本）';
    }
    assert(
      oversize.length > 8 * 1024 * 1024,
      `样本需大于 nginx 的 client_max_body_size(8m) 才能测到这一层，实际 ${(oversize.length / 1048576).toFixed(2)}MB`,
    );
    const before = filesOnDisk(aVisitId);
    const r = await technicianUpload(tokenA, oversize, { filename: 'big.jpg' });
    eq(r.status, 413, `HTTP（${(oversize.length / 1048576).toFixed(1)}MB）`);
    eq(filesOnDisk(aVisitId), before, '副作用（文件数）');
    // 这一格的**判据**是"它根本没到应用层"：响应里不该有我们的 JSON 信封。
    // 若哪天这里变红，说明 nginx 的上限被改了或样本变小了 ——
    // 那时这格已经不再测 nginx，需要调整样本或断言，别把它当成产品故障。
    assert(
      !Array.isArray(r.json?.errors),
      `超大请求竟然到了应用层（拿到了 JSON 信封）—— nginx 的 client_max_body_size 或样本大小已变：${String(r.body).slice(0, 120)}`,
    );
    return `${(oversize.length / 1048576).toFixed(1)}MB → 413（nginx 层，无 JSON 信封），文件数不变`;
  });

  console.log('\n── B6/B7 受控读取与属主校验 ──');
  await checkAsync('B6 GET photos/:ref → 200 + 固定 Content-Type + no-store + nosniff', async () => {
    const r = await technicianPhoto(tokenA, firstRef);
    eq(r.status, 200, 'HTTP');
    eq(r.headers.get('content-type'), 'image/jpeg', 'Content-Type（取自库不是猜的）');
    // ⚠️ **按集合比较，不按字符串全等**：同一个响应头由两层各写一次 ——
    //    应用层（`visit.ts` 的 photo handler，刻意不依赖反代存在）
    //    与 nginx（`service.conf` 的全局 `add_header ... always`）。
    //    nginx 的 add_header 是**追加**语义，于是线上看到的是 "nosniff, nosniff"。
    //    两者语义完全一样（指令集合去重后都是 {nosniff}），
    //    写成字符串全等会把这个**正确**实现判红，属"会误报的检查"。
    //    真要让这格更严，应该去断言"至少有一层设了它"，而不是钉死份数。
    const nosniff = String(r.headers.get('x-content-type-options') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    assert(
      nosniff.includes('nosniff'),
      `X-Content-Type-Options 必须含 nosniff（实际 ${JSON.stringify(r.headers.get('x-content-type-options'))}）`,
    );
    assert(
      new Set(nosniff).size === 1,
      `X-Content-Type-Options 混入了别的指令：${JSON.stringify(r.headers.get('x-content-type-options'))}`,
    );
    assert(
      String(r.headers.get('cache-control') ?? '').includes('no-store'),
      `私有内容必须 no-store：${r.headers.get('cache-control')}`,
    );
    eq(String(r.headers.get('content-disposition') ?? ''), 'inline', 'Content-Disposition');
    // 响应头里不得带回用户提供的原始文件名
    assert(
      !/photo\.|onsite\./i.test(String(r.headers.get('content-disposition') ?? '')),
      'Content-Disposition 里不得出现原始文件名（头注入面）',
    );
    return `${r.status} ${r.headers.get('content-type')}`;
  });

  await checkAsync('B7 拿 A 单的 ref 用 **B 单的 token** 读 → 404（ref 不可猜 ≠ 已授权）', async () => {
    const r = await technicianPhoto(tokenB, firstRef);
    eq(r.status, 404, 'HTTP');
    eq(r.json?.errors?.[0]?.code, 'PHOTO_NOT_FOUND', '错误码');
    // 与"ref 形态非法"回同一个响应 —— 否则它就变成了"这个 ref 存在吗"的探测器
    const malformed = await technicianPhoto(tokenB, 'A'.repeat(22));
    eq(malformed.status, 404, '形态非法的 ref 的 HTTP');
    eq(String(malformed.body), String(r.body), '两种情况的响应体必须一致（不构成探测器）');
    return '404 PHOTO_NOT_FOUND（与非法 ref 同一响应）';
  });

  console.log('\n── B3 张数上限（原子）──');
  await checkAsync('B3 累计 6 张后第 7 张 → 422 PHOTO_LIMIT_REACHED，且不多出文件', async () => {
    // 已有 1 张，再传 5 张凑满
    for (let i = 0; i < 5; i += 1) {
      const r = await technicianUpload(tokenA, i % 2 === 0 ? jpeg : png, {
        filename: `p${i}.jpg`,
      });
      eq(r.status, 201, `第 ${i + 2} 张上传失败：${errorMessageOf(r)}`);
    }
    eq(photosOf(a.ticketId).length, 6, '满额时的照片行数');
    eq(filesOnDisk(aVisitId), 6, '满额时的磁盘文件数');

    const filesBefore = filesOnDisk(aVisitId);
    const r = await technicianUpload(tokenA, jpeg, { filename: 'p7.jpg' });
    eq(r.status, 422, `HTTP（${errorMessageOf(r)}）`);
    eq(r.json?.errors?.[0]?.code, 'PHOTO_LIMIT_REACHED', '错误码');
    eq(photosOf(a.ticketId).length, 6, '拒绝后的照片行数');
    // ⚠️ 关键：被拒的那次**不能留下文件**。若实现是"先写盘再判上限"，
    //    行数是 6（看着对），而磁盘上会多出第 7 个孤儿文件 —— 越传越多。
    eq(filesOnDisk(aVisitId), filesBefore, '拒绝后的磁盘文件数（不能有孤儿文件）');
    return `6 张封顶，第 7 张 422，磁盘仍 ${filesBefore} 个文件`;
  });

  console.log('\n── B9 事务边界：照片成功 ≠ 提交成功 ──');
  let refsAfterRefresh = [];
  await checkAsync('B9 提交前"刷新/重进"：仍能看到已传 6 张、ref 稳定、**Visit 数不变**', async () => {
    const visitsBefore = Number(
      psqlScalar(`SELECT count(*) FROM service_visits WHERE ticket_id = ${a.ticketId}`),
    );
    const g = await technicianGet(tokenA);
    eq(g.status, 200, `GET HTTP（${errorMessageOf(g)}）`);
    const data = g.json?.data;
    eq(data.photos_count, 6, 'photos_count');
    eq(data.photos.length, 6, 'photos 数组长度');
    refsAfterRefresh = data.photos.map((p) => p.ref);
    // ref 必须**稳定**：刷新后每次 GET 都得到同一组 ref。
    // 若 ref 里掺了随机数或时间戳，页面刷新后图片全部 404 ——
    // 而"刷新后看不到照片"正是师傅会再传一遍的直接诱因。
    const g2 = await technicianGet(tokenA);
    eq(g2.json?.data?.photos?.map((p) => p.ref), refsAfterRefresh, '二次 GET 的 ref 一致性');
    assert(
      refsAfterRefresh.includes(firstRef),
      '首次上传返回的 ref 必须仍在列表里（上传响应与 GET 的 ref 必须同源）',
    );
    // 每一张都真的读得出来
    for (const ref of refsAfterRefresh) {
      const r = await technicianPhoto(tokenA, ref);
      eq(r.status, 200, `ref ${ref.slice(0, 6)}… 读取`);
    }
    const visitsAfter = Number(
      psqlScalar(`SELECT count(*) FROM service_visits WHERE ticket_id = ${a.ticketId}`),
    );
    eq(visitsAfter, visitsBefore, 'Visit 数（上传/刷新**绝不能**产生新 Visit）');
    eq(visitsAfter, 1, 'Visit 数应为 1');
    return `6 张可见且都可读，Visit 数 ${visitsAfter}`;
  });

  await checkAsync('B9b 提交成功（照片数进事件 metadata）→ 之后再上传被拒、无新增', async () => {
    const subs = await technicianSubmit(tokenA, {
      service_result: 'resolved',
      service_note: '上传矩阵：现场已修复，收费 30.5 元',
      is_charged: true,
      reported_charge_amount: 30.5,
    });
    eq(subs.status, 200, `提交 HTTP（${errorMessageOf(subs)}）`);
    eq(subs.json?.data?.message, '已提交，等待门店确认', '终态文案');
    assert(!String(subs.body).includes('完成'), `提交响应不得出现"完成"：${subs.body.slice(0, 200)}`);

    const eventMeta = psqlScalar(
      `SELECT metadata_json::text FROM ticket_events WHERE ticket_id = ${a.ticketId} AND event_type='technician_submitted'`,
    );
    assert(eventMeta.includes('"photo_count": 6') || eventMeta.includes('"photo_count":6'), `事件 metadata 缺 photo_count：${eventMeta}`);

    // 提交后 Visit 已 SUBMITTED → Token 已被消费 → 上传应当被拒
    const before = { rows: photosOf(a.ticketId).length, files: filesOnDisk(aVisitId) };
    const up = await technicianUpload(tokenA, jpeg, { filename: 'late.jpg' });
    eq(up.status, 401, `提交后上传的 HTTP（应为 401 TOKEN_INVALID）`);
    eq(up.json?.errors?.[0]?.code, 'TOKEN_INVALID', '错误码');
    eq(
      { rows: photosOf(a.ticketId).length, files: filesOnDisk(aVisitId) },
      before,
      '提交后的副作用（行数/文件数）',
    );
    return `提交 200 → 再上传 401，行/文件数不变（${before.rows}/${before.files}）`;
  });

  await checkAsync('B8 改派（旧 Visit SUPERSEDED）之后：旧 Token 上传被拒、无新增', async () => {
    const beforeB = { rows: photosOf(b.ticketId).length, files: filesOnDisk(bVisitId) };
    const reassign = await svcPost(
      'reassign',
      b.ticketId,
      store,
      {
        technician_name: '赵师傅',
        technician_mobile: '13900010009',
        expected_visit_at: localDateOnly(3),
        service_mode: 'manufacturer',
        provider_name: 'P5-1改派厂家B',
        reason: 'P5-1 上传矩阵：改派以验证旧链接不能再传照片',
      },
      crypto.randomUUID(),
    );
    eq(reassign.status, 200, `改派 HTTP（${errorMessageOf(reassign)}）`);

    const up = await technicianUpload(tokenB, jpeg, { filename: 'stale.jpg' });
    eq(up.status, 401, '旧 Token 上传的 HTTP');
    eq(up.json?.errors?.[0]?.code, 'TOKEN_INVALID', '错误码');
    const afterB = { rows: photosOf(b.ticketId).length, files: filesOnDisk(bVisitId) };
    eq(afterB, beforeB, '副作用（行数/文件数）');
    const oldStatus = psqlScalar(
      `SELECT visit_status FROM service_visits WHERE ticket_id = ${b.ticketId} ORDER BY visit_no LIMIT 1`,
    );
    eq(oldStatus, 'SUPERSEDED', '旧 Visit 状态');
    return `旧 Token 401，旧 Visit=${oldStatus}，行/文件数不变`;
  });

  console.log('\n── B10 token 维度限流 ──');
  await checkAsync('B10 每小时上限：临时降到 2 → 第 3 次上传 429 且带 Retry-After，跑完恢复', async () => {
    // 用**改派后的新 Visit 的 Token**：它有一张全新的桶（限流按 token 哈希分别计），
    // 不会与本轮前面的上传相互污染。
    const b2Token = (await tokenFromOutbox({ sessionToken: hq, ticketNo: b.ticketNo })).token;
    const key = 'security.technician_token_hourly_limit';
    const original = psqlScalar(`SELECT value FROM service_settings WHERE key='${key}'`);
    assert(original !== '', `取不到 ${key} 的当前值`);

    try {
      psqlExec(`UPDATE service_settings SET value='2' WHERE key='${key}';`);
      // 等过 ConfigService 的 10s 缓存 TTL（理由同 smsSwitch）
      await new Promise((r) => setTimeout(r, 11_000));

      const first = await technicianUpload(b2Token, jpeg, { filename: 'r1.jpg' });
      const second = await technicianUpload(b2Token, jpeg, { filename: 'r2.jpg' });
      const third = await technicianUpload(b2Token, jpeg, { filename: 'r3.jpg' });
      eq(first.status, 201, `第 1 次（${errorMessageOf(first)}）`);
      eq(second.status, 201, `第 2 次（${errorMessageOf(second)}）`);
      eq(third.status, 429, `第 3 次的 HTTP（上限已降为 2）`);
      eq(third.json?.errors?.[0]?.code, 'RATE_LIMITED', '第 3 次的错误码');
      const retryAfter = Number(third.headers.get('retry-after'));
      assert(Number.isFinite(retryAfter) && retryAfter > 0, `Retry-After 缺失或非法：${third.headers.get('retry-after')}`);
      // 429 时**不能**留下文件（限流要发生在解析 body / 写盘之前）
      eq(filesOnDisk(Number(psqlScalar(`SELECT id FROM service_visits WHERE ticket_id=${b.ticketId} AND visit_status='ASSIGNED'`))), 2, '限流后的文件数');
      return `201/201/429，Retry-After=${retryAfter}s`;
    } finally {
      // ⚠️ 无条件恢复：改的是**产品参数**，留在库里会影响后续所有验收
      psqlExec(`UPDATE service_settings SET value='${original}' WHERE key='${key}';`);
      const now = psqlScalar(`SELECT value FROM service_settings WHERE key='${key}'`);
      assert(now === original, `${key} 未恢复，请手工设为 '${original}'（当前 '${now}'）`);
    }
  });
}

await runMain({
  name: '上传安全矩阵（P5-1）',
  main: async () => {
    console.log('\n── A/C 离线阶段（真实字节 + 真实解码器）──');
    await staticPhase();
    if (!STATIC_ONLY) {
      console.log('\n── B 联机阶段（经 nginx 打对外路径）──');
      await onlinePhase();
    } else {
      console.log('  （--static-only：跳过联机阶段）');
    }
    summary();
    if (degraded.length) {
      console.log('  🟡 本轮**降级项**（如实标记，未当成通过）：');
      for (const d of degraded) console.log(`     · ${d}`);
      console.log('');
    }
  },
  cleanup: () => {
    const ra = cleanupTicket(fixtures.a);
    cleanupTicket(fixtures.b);
    if (ra) console.log(`  · 清理：删除 ${ra.filesDeleted} 个私有照片文件 / ${ra.attachmentsDeleted} 条附件行`);
    const back = sms.restore();
    if (sms.original !== undefined) console.log(`  · 短信开关已复位：${back.note}`);
  },
});

if (state.failures.length) process.exit(1);
