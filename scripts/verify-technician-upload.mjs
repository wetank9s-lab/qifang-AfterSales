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
/** DEV-84 的方向夹具与"取回的落盘文件"所在目录 */
const ORIENT_DIR = path.join(TMP, 'orient');
const ORIENT_OUT_DIR = path.join(TMP, 'orient-stored');
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

// ---------------------------------------------------------------------------
// DEV-84 EXIF 方向夹具与检查器
// ---------------------------------------------------------------------------
/**
 * 参考图 REF（**视觉正方向**）是 400×300 的四象限纯色块：
 *
 *     TL=红  TR=绿
 *     BL=蓝  BR=黄
 *
 * 夹具把 REF 按"EXIF 规约的**逆**变换"做成存储像素，再写上对应的 Orientation
 * —— 这就等价于"手机拍出来的原图"：像素本身不是视觉正方向，全靠标签告诉查看器。
 *
 * 为什么必须用"四象限 4 个不同颜色"而不是别的图案：判定是**看画面朝向**，
 * 而不是"字节有没有变"。纯色块在 JPEG 的有损重编码下依然稳定可分（采样取
 * 象限中心 3×3 邻域均值），而且任何一个非恒等取向都会改变四象限的排列 ——
 * 若实现退化成"只剥 EXIF 不转像素"，象限排列立刻对不上，测试必然红。
 */
const MAKE_ORIENT_PY = String.raw`
import os, sys
from PIL import Image
D = sys.argv[1]
os.makedirs(D, exist_ok=True)
W, H = 400, 300
RED, GREEN, BLUE, YELLOW = (255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)
ref = Image.new("RGB", (W, H))
px = ref.load()
for y in range(H):
    for x in range(W):
        if y < H // 2:
            px[x, y] = RED if x < W // 2 else GREEN
        else:
            px[x, y] = BLUE if x < W // 2 else YELLOW
ref.save(os.path.join(D, "orient-ref.png"), "PNG")

T = Image.Transpose
# 取向 -> "把视觉正方向变成存储像素"的变换（即 EXIF 变换的逆）
STORE = {1: None, 2: T.FLIP_LEFT_RIGHT, 3: T.ROTATE_180, 4: T.FLIP_TOP_BOTTOM,
         5: T.TRANSPOSE, 6: T.ROTATE_90, 7: T.TRANSVERSE, 8: T.ROTATE_270}

def exif_bytes(orientation=None, gps=False):
    e = Image.Exif()
    e[0x010F] = "SvcCam"                       # Make：证明"剥离前确实有 EXIF"
    e[0x0110] = "Model-DEV84"
    e[0x0132] = "2026:09:25 12:00:00"
    if gps:
        e[0x8825] = {1: "N", 2: (39.9, 0.0, 0.0), 3: "E", 4: (116.38, 0.0, 0.0)}
    if orientation is not None:
        e[0x0112] = orientation
    return e

made = []
for o, tf in STORE.items():
    stored = ref if tf is None else ref.transpose(tf)
    stored.save(os.path.join(D, "orient%d.jpg" % o), "JPEG", quality=95, exif=exif_bytes(o))
    made.append("orient%d.jpg" % o)

# 没有 EXIF 的基准（取向缺失 ⇒ 视为不变换）
ref.save(os.path.join(D, "orient-none.jpg"), "JPEG", quality=95)
# 带方向 + 带 GPS：验证"转正"与"清 GPS"能同时成立
ref.transpose(T.ROTATE_90).save(os.path.join(D, "orient6-gps.jpg"), "JPEG", quality=95,
                                exif=exif_bytes(6, gps=True))
# 另外两种容器壳里也各放一份（同一份 TIFF 结构，外面的壳不同）
ref.transpose(T.ROTATE_90).save(os.path.join(D, "orient6.png"), "PNG", exif=exif_bytes(6))
ref.transpose(T.ROTATE_90).save(os.path.join(D, "orient6.webp"), "WEBP", quality=95, exif=exif_bytes(6))
# 非法取值（9）：必须被当作"没有方向"，而不是"取向 9"
invalid_note = "n/a"
try:
    ref.save(os.path.join(D, "orient-invalid.jpg"), "JPEG", quality=95, exif=exif_bytes(9))
    invalid_note = "9"
except Exception as ex:
    invalid_note = "SKIP(%s)" % ex
print("orient-ref.png(400x300) " + " ".join(made) + " invalid=" + invalid_note)
`;

/**
 * 方向检查器。对目录里的每个 `orient*` 图输出：
 *   · `layout` —— 四象限颜色排列（参考图算出来应是 "RGBY"）
 *   · `exif_transpose_layout` —— **Pillow 自己按 EXIF 方向转一遍**后的排列。
 *     这一列是"独立裁判"：A4b 用它证明夹具确实符合规约（否则 B11b 拿这些
 *     夹具去断言"转正了"就没有意义 —— 一个造错的夹具能让坏实现看起来是好的）。
 *   · `exif_tags` / `gps_tags` / `orientation_tag` —— 元数据是否真的没了
 */
const CHECK_ORIENT_PY = String.raw`
import os, sys, json, glob
from PIL import Image, ImageOps

D = sys.argv[1]
PALETTE = {"R": (255, 0, 0), "G": (0, 255, 0), "B": (0, 0, 255), "Y": (255, 255, 0)}

def layout(img):
    img = img.convert("RGB")
    w, h = img.size
    pts = [(w // 4, h // 4), (3 * w // 4, h // 4), (w // 4, 3 * h // 4), (3 * w // 4, 3 * h // 4)]
    out, worst = [], 0
    for (x, y) in pts:
        # 取象限中心 3x3 邻域的均值：抗 JPEG 噪声与色度子采样
        vals = [img.getpixel((min(w - 1, max(0, x + dx)), min(h - 1, max(0, y + dy))))
                for dx in (-1, 0, 1) for dy in (-1, 0, 1)]
        mean = tuple(sum(v[i] for v in vals) // len(vals) for i in range(3))
        best, bd = None, 1 << 30
        for k, c in PALETTE.items():
            d = sum((mean[i] - c[i]) ** 2 for i in range(3))
            if d < bd:
                bd, best = d, k
        out.append(best)
        worst = max(worst, bd)
    return "".join(out), list(img.size), worst

with Image.open(os.path.join(D, "orient-ref.png")) as r:
    ref_layout, ref_size, _ = layout(r)

result = {"ref": {"layout": ref_layout, "size": ref_size}, "files": {}}
for path in sorted(glob.glob(os.path.join(D, "orient*"))):
    name = os.path.basename(path)
    if name in ("orient-ref.png",):
        continue
    try:
        with Image.open(path) as im:
            ex = im.getexif()
            rec = {
                "size": list(im.size),
                "orientation_tag": ex.get(0x0112),
                "exif_tags": sorted(ex),
                "gps_tags": [],
            }
            try:
                rec["gps_tags"] = sorted(ex.get_ifd(0x8825) or {})
            except Exception:
                rec["gps_tags"] = []
            rec["layout"], _, rec["maxdev"] = layout(im)
            try:
                rec["exif_transpose_layout"] = layout(ImageOps.exif_transpose(im.copy()))[0]
            except Exception as e:
                rec["exif_transpose_layout"] = "ERR:" + str(e)[:60]
        result["files"][name] = rec
    except Exception as e:
        result["files"][name] = {"error": str(e)[:120]}
print(json.dumps(result))
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

/** 把宿主机上的脚本送进 app 容器跑（用 base64 传参，避开层层引号转义） */
function runInAppNode(source) {
  const b64 = Buffer.from(source, 'utf8').toString('base64');
  return inApp(`echo ${b64} | base64 -d > /tmp/dev84-probe.cjs && node /tmp/dev84-probe.cjs`);
}

/** 从容器私有目录里取回一张照片的字节（base64 走 stdout，避免 docker cp 的路径问题） */
function fetchPrivateFileBase64(storageKey) {
  const out = inApp(`base64 -w0 ${PRIVATE_DIR}/${storageKey}`);
  return out.ok ? out.out.replace(/\s+/g, '') : '';
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const fixtures = { a: 0, b: 0, c: 0, d: 0 };
const sms = smsSwitch();
let degraded = [];
/**
 * Pillow 是否可用（真实解码器）。
 * ⚠️ 必须是**模块级**的：`staticPhase()` 里的局部变量在 `onlinePhase()`（B11b）
 * 里读不到 —— 那会表现成 `pillowReady is not defined` 这种"测试脚本自身的 bug"，
 * 而不是被测系统的缺陷，排查时容易白花时间。
 */
let pillowReady = false;

async function staticPhase() {
  await compileShared();

  // ---- 夹具 ----
  pillowReady = hasPillow();
  fs.mkdirSync(TMP, { recursive: true });
  if (!pillowReady) {
    degraded.push(
      `Pillow 不可用（${PYTHON}）→ 跳过"真实解码器验证 EXIF 已清空/像素不变"这一格；` +
        `A1 的严格拒绝判定仍然执行（用手工构造的字节）`,
    );
  } else {
    const out = execFileSync(PYTHON, ['-c', MAKE_FIXTURES_PY, TMP], { encoding: 'utf8' }).trim();
    console.log(`  · Pillow 夹具已生成：${out}`);
    const orientOut = execFileSync(PYTHON, ['-c', MAKE_ORIENT_PY, ORIENT_DIR], { encoding: 'utf8' }).trim();
    console.log(`  · DEV-84 方向夹具已生成：${orientOut}`);
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

  // -------------------------------------------------------------------------
  // A4（DEV-84）：EXIF 方向
  // -------------------------------------------------------------------------
  console.log('\n── A4 EXIF 方向（DEV-84：读标签 / 夹具合规 / 变换矩阵）──');

  const readOrientFixture = (name) => {
    const p = path.join(ORIENT_DIR, name);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  };

  check('A4a 读得出 EXIF Orientation：1..8 逐个正确，缺失/非法一律 null', () => {
    assert(pillowReady, 'Pillow 不可用 —— 方向夹具没生成');
    const seen = [];
    for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const buf = readOrientFixture(`orient${o}.jpg`);
      assert(buf, `缺少夹具 orient${o}.jpg`);
      eq(MediaGuard.readExifOrientation(buf, 'image/jpeg'), o, `orient${o}.jpg 的取向`);
      seen.push(o);
    }
    // 缺失标签 ≠ 取向 1：前者是"没人告诉过我们方向"，后者是"明确说就是正方向"。
    // 两者对**是否动像素**的结论相同，但要在库里区分（attachments.meta.exif_orientation）。
    eq(MediaGuard.readExifOrientation(readOrientFixture('orient-none.jpg'), 'image/jpeg'), null, '无标签');
    // 非法取值（9）必须被当成"没有方向"。若把它当 9 去查变换表，会得到"没有矩阵"，
    // 于是走异常分支 —— 一张取向字段损坏的照片会让上传 422，而不是被当成正方向存下。
    const invalid = readOrientFixture('orient-invalid.jpg');
    if (invalid) eq(MediaGuard.readExifOrientation(invalid, 'image/jpeg'), null, '非法取向 9');
    // 另外两个容器壳（PNG eXIf / WebP EXIF）走的是同一份 TIFF 解析器，必须也读得出
    eq(MediaGuard.readExifOrientation(readOrientFixture('orient6.png'), 'image/png'), 6, 'PNG eXIf');
    eq(MediaGuard.readExifOrientation(readOrientFixture('orient6.webp'), 'image/webp'), 6, 'WebP EXIF');
    // 判据函数：只有 2..8 需要动像素
    eq(
      [null, 1, 2, 8, 9, 0].map((o) => MediaGuard.needsOrientationTransform(o)),
      [false, false, true, true, false, false],
      'needsOrientationTransform',
    );
    eq(MediaGuard.orientationTransform(null, 10, 20), null, 'null 取向没有矩阵');
    eq(MediaGuard.orientationTransform(1, 10, 20)?.swap, false, '取向 1 不交换宽高');
    eq(MediaGuard.orientationTransform(6, 10, 20)?.swap, true, '取向 6 必须交换宽高');
    return `1..8 全读对 + 无标签/非法值→null + 三容器壳一致（${seen.length} 个样本）`;
  });

  check('A4b 夹具本身符合 EXIF 规约（裁判 = Pillow 的 exif_transpose）', () => {
    assert(pillowReady, 'Pillow 不可用 —— 这一格无法验证（已记为降级项）');
    const report = JSON.parse(
      execFileSync(PYTHON, ['-c', CHECK_ORIENT_PY, ORIENT_DIR], { encoding: 'utf8' }).trim(),
    );
    // 参考图自身的布局先立住：四象限依次是 红/绿/蓝/黄
    eq(report.ref.layout, 'RGBY', '参考图的象限布局');
    eq(report.ref.size, [400, 300], '参考图尺寸');

    const notUpright = [];
    for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const rec = report.files[`orient${o}.jpg`];
      assert(rec && !rec.error, `orient${o}.jpg 检查失败：${rec?.error ?? '记录缺失'}`);
      eq(rec.orientation_tag, o, `orient${o}.jpg 的标签值`);
      assert(rec.exif_tags.length > 0, `orient${o}.jpg 剥离前应有 EXIF（否则这一格什么都没测）`);
      // 裁判结论：Pillow 自己按标签转一遍，必须回到正方向
      eq(rec.exif_transpose_layout, 'RGBY', `orient${o}.jpg 经 Pillow 转正的布局`);
      // 夹具的**存储像素**必须真的不是正方向（1 除外）—— 这是本测试的立身之本：
      // 如果夹具本身已经是正方向，那么"不转也能过"，测试等于空跑。
      if (o !== 1) {
        assert(
          rec.layout !== 'RGBY',
          `orient${o}.jpg 的存储像素就是正方向（${rec.layout}）—— 夹具失效，这一格会假绿`,
        );
        notUpright.push(`${o}:${rec.layout}`);
      }
      // 5..8 各转 90°，存储尺寸必然与正方向互换
      eq(
        rec.size,
        o >= 5 ? [300, 400] : [400, 300],
        `orient${o}.jpg 的存储尺寸（应为 ${o >= 5 ? '300x400' : '400x300'}）`,
      );
      assert(rec.maxdev < 3000, `orient${o}.jpg 的象限取色偏离过大：${rec.maxdev}`);
    }
    const none = report.files['orient-none.jpg'];
    eq(none?.orientation_tag ?? null, null, 'orient-none.jpg 不应有取向标签');
    eq(none?.exif_tags ?? [], [], 'orient-none.jpg 不应有 EXIF');
    eq(none?.layout, 'RGBY', 'orient-none.jpg 的存储像素就是正方向');

    const gps = report.files['orient6-gps.jpg'];
    assert(gps && gps.gps_tags.length > 0, 'orient6-gps.jpg 剥离前应有 GPS IFD');
    eq(gps.exif_transpose_layout, 'RGBY', 'orient6-gps.jpg 经 Pillow 转正的布局');

    for (const name of ['orient6.png', 'orient6.webp']) {
      const rec = report.files[name];
      eq(rec?.orientation_tag, 6, `${name} 的标签值（另外两种容器壳）`);
      eq(rec?.exif_transpose_layout, 'RGBY', `${name} 经 Pillow 转正的布局`);
    }
    return `8 个取向的夹具都"存储不正、转正正确"（存储布局：${notUpright.join(' ')}）`;
  });

  check('A4c 变换矩阵：源图四角必落进目标框，且特征点落到规约规定的位置', () => {
    const W = 400;
    const H = 300;
    // 规约几何：每个取向把"源图左上角 / 右上角"送到目标框的哪个角。
    // 这张表是**独立写出来的**（直接照 EXIF 规约的定义），不是从实现里抄的 ——
    // 抄一份实现里的表，实现写错表也跟着错，等于没测。
    const ANCHORS = {
      1: { swap: false, tl: [0, 0], tr: [W, 0] },
      2: { swap: false, tl: [W, 0], tr: [0, 0] },
      3: { swap: false, tl: [W, H], tr: [0, H] },
      4: { swap: false, tl: [0, H], tr: [W, H] },
      5: { swap: true, tl: [0, 0], tr: [0, W] },
      6: { swap: true, tl: [H, 0], tr: [H, W] },
      7: { swap: true, tl: [H, W], tr: [H, 0] },
      8: { swap: true, tl: [0, W], tr: [0, 0] },
    };
    const EPS = 1e-6;
    for (const [key, spec] of Object.entries(ANCHORS)) {
      const o = Number(key);
      const tf = MediaGuard.orientationTransform(o, W, H);
      assert(tf, `取向 ${o} 应有变换`);
      eq(tf.swap, spec.swap, `取向 ${o} 的 swap`);
      const [a, b, c, d, e, f] = tf.matrix;
      const dw = spec.swap ? H : W;
      const dh = spec.swap ? W : H;
      // ① 任意源点都必须落进目标框（否则画面会被裁掉一块）
      for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H], [W / 3, H / 3]]) {
        const X = a * x + c * y + e;
        const Y = b * x + d * y + f;
        assert(
          X >= -EPS && X <= dw + EPS && Y >= -EPS && Y <= dh + EPS,
          `取向 ${o}：源点 (${x},${y}) → (${X},${Y}) 落到目标框 ${dw}x${dh} 之外`,
        );
      }
      // ② 特征点必须落到规约规定的位置
      const tl = [a * 0 + c * 0 + e, b * 0 + d * 0 + f];
      const tr = [a * W + c * 0 + e, b * W + d * 0 + f];
      eq(
        [Math.round(tl[0]), Math.round(tl[1])],
        spec.tl,
        `取向 ${o}：源左上角应落到 ${spec.tl}`,
      );
      eq(
        [Math.round(tr[0]), Math.round(tr[1])],
        spec.tr,
        `取向 ${o}：源右上角应落到 ${spec.tr}`,
      );
    }
    return `8 个取向的矩阵：四角落框 + 左上/右上锚点全部与规约一致（源 ${W}x${H}）`;
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

  console.log('\n── B11 方向归一化（DEV-84：真实夹具端到端）──');

  /**
   * B11 为什么用**两张新工单**而不是复用 A/B：
   *   · 单张 Visit 的上限是 6 张，而 1..8 **全测**需要 8 张；
   *   · A 单已被 B3 灌满 6 张、B 单已被改派（旧 Visit 变 SUPERSEDED）。
   * 为什么值得全测 8 种而不是只测用户报的 90°：镜像/翻转（2/4/5/7）与旋转
   * （3/6/8）在矩阵表里是**不同的行**，"只测 6"会漏掉整张表的一半 ——
   * 而这张表恰恰是本次修复的核心。
   */
  const c = await createScratchTicket({ tag: 'DEV84-ORIENT-C', content: 'DEV-84 方向夹具主单（旋转类）' });
  fixtures.c = c.ticketId;
  await acceptAndDispatch(c.ticketId, store);
  const tokenC = (await tokenFromOutbox({ sessionToken: hq, ticketNo: c.ticketNo })).token;
  const cVisitId = Number(
    psqlScalar(
      `SELECT id FROM service_visits WHERE ticket_id = ${c.ticketId} AND visit_status='ASSIGNED' ORDER BY visit_no DESC LIMIT 1`,
    ),
  );

  const d = await createScratchTicket({ tag: 'DEV84-ORIENT-D', content: 'DEV-84 方向夹具副单（镜像类）' });
  fixtures.d = d.ticketId;
  await acceptAndDispatch(d.ticketId, store);
  const tokenD = (await tokenFromOutbox({ sessionToken: hq, ticketNo: d.ticketNo })).token;
  const dVisitId = Number(
    psqlScalar(
      `SELECT id FROM service_visits WHERE ticket_id = ${d.ticketId} AND visit_status='ASSIGNED' ORDER BY visit_no DESC LIMIT 1`,
    ),
  );
  console.log(`  · 方向主单 ${c.ticketNo}（visit=${cVisitId}）/ 副单 ${d.ticketNo}（visit=${dVisitId}）`);

  /** 被 nginx 粗粒度限流挡下的次数（只做统计与降级提示，不当成失败） */
  let nginxThrottled = 0;
  /**
   * nginx 的 429 vs 应用层的 429 —— 两者**必须分开对待**。
   *
   * nginx 的 `svc_upload` 区是 60r/m + `burst=20 nodelay`，按 **IP** 计数
   * （`nginx/nginx.conf` 的注释明说它是"粗粒度兜底"）。本脚本一次运行会从
   * 同一个 IP 打几十次 `/api/technician/`，B11 再一口气加 9 次上传，很容易撞上它。
   * 它返回的是 **nginx 自己**的信封：`{"code":"TOO_MANY_REQUESTS","message":"请求过于频繁，请稍后再试"}`
   * —— 扁平结构、**没有** `errors[]` 数组（见 `nginx/conf.d/service.conf` 的
   * `error_page 429 = @too_many`）。
   *
   * 应用层的 `RateLimitedError` 则带 `errors[0].detail.{scene,scope,limit,used}`。
   * 所以判据很干净：
   *   · 扁平信封 ⇒ 这是**基础设施**的兜底，与被测行为无关 ⇒ 可以退避重试；
   *   · 带 errors[].detail ⇒ 这是**被测行为**（B10 专门验它）⇒ **绝不重试**，
   *     重试会把它变成假绿。
   * 重试次数会被记下来并在结尾的"降级项"里明示，不悄悄发生。
   */
  const isNginxThrottle = (r) => r.status === 429 && !Array.isArray(r.json?.errors);

  /** 上传一批方向夹具，逐张断言"201 + 尺寸已交换" */
  const uploadOrientationFixtures = async (token, files, visitId) => {
    const uploaded = [];
    for (const file of files) {
      const before = filesOnDisk(visitId);
      let done = null;
      for (let attempt = 1; attempt <= 6 && !done; attempt += 1) {
        // 一点点主动节流：nginx 的桶按 1 次/秒 回填，连续 9 张上传必然要等它
        await new Promise((res) => setTimeout(res, 600));
        const r = await technicianUpload(token, fs.readFileSync(path.join(ORIENT_DIR, file)), {
          filename: file,
          photoType: 'onsite',
        });
        if (isNginxThrottle(r)) {
          nginxThrottled += 1;
          await new Promise((res) => setTimeout(res, 1200 * attempt));
          continue;
        }
        eq(r.status, 201, `${file} 上传（${errorMessageOf(r)}）`);
        const photo = r.json?.data?.photo;
        assert(photo?.ref, `${file} 的响应缺 ref`);
        // 不换容器：落盘 mime 仍是 image/jpeg（扩展名也还该是 .jpg）
        eq(photo.mime, 'image/jpeg', `${file} 的 MIME`);
        // ⚠️ 这是"尺寸已交换"的**接口级**判据：夹具的存储像素可能是 300x400，
        //    归一化后的正方向一律是 400x300。若实现沿用了旋转前的尺寸，这里立刻红。
        eq([photo.width, photo.height], [400, 300], `${file} 归一化后的尺寸`);
        eq(filesOnDisk(visitId), before + 1, `${file} 之后磁盘文件数`);
        done = { file, ref: photo.ref, size: Number(photo.size) };
      }
      assert(done, `${file}：连续 6 次都被 nginx 的 svc_upload 区挡住（IP 粒度 60r/m，见 nginx/nginx.conf）`);
      uploaded.push(done);
    }
    return uploaded;
  };

  await checkAsync('B11a 镜像能力：归一化依赖的原生解码器确实在，且它在产物里是**外置**的', async () => {
    // ⚠️ 探针必须**按插件自己的解析上下文**去 resolve。
    //    踩过的坑：脚本放在 /tmp 里直接 require.resolve(id)，Node 会从 /tmp
    //    往上找 node_modules（/tmp/node_modules、/node_modules），**永远找不到**
    //    /app/nocobase/node_modules 里的包 —— 于是探针把 8 个包全报成 absent，
    //    把"能力正常"误判成"能力缺失"。这正是"检查本身写错了"的一类假红。
    //    下面用插件产物的真实目录作为解析起点（`paths` 的语义就是"假装模块在这里"）。
    const PLUGIN_SERVER_DIR = '/app/nocobase/node_modules/@local/service-ticket/dist/server';
    const probe = runInAppNode(`
const PATHS = ['${PLUGIN_SERVER_DIR}'];
const ids = ['sharp','jimp','exifr','image-size','piexifjs','jpeg-js','pngjs','@napi-rs/canvas'];
const absent = [], present = [];
for (const id of ids) {
  try { require.resolve(id, { paths: PATHS }); present.push(id); } catch (e) { absent.push(id); }
}
let version = null, resolved = null;
try {
  resolved = require.resolve('@napi-rs/canvas', { paths: PATHS });
  version = require(require.resolve('@napi-rs/canvas/package.json', { paths: PATHS })).version;
} catch (e) { version = 'ERR:' + e.message.slice(0, 80); }
console.log(JSON.stringify({ absent, present, version, resolved }));
`);
    assert(probe.ok, `容器内探针执行失败：${probe.out.slice(0, 200)}`);
    const parsed = JSON.parse(probe.out.trim().split('\n').pop());
    assert(
      parsed.present.includes('@napi-rs/canvas'),
      `从插件目录解析不到 @napi-rs/canvas（解析起点 ${PLUGIN_SERVER_DIR}）—— ` +
        `带 EXIF 方向的照片会被 fail-closed 拒绝：${probe.out.slice(0, 240)}`,
    );
    assert(parsed.version && !String(parsed.version).startsWith('ERR:'), `读不到版本号：${parsed.version}`);

    // 产物侧：这条耦合必须是**明示**的（外置 + 可见），而不是被内联/被悄悄删掉。
    // 内联是不可能的（原生 .node），但"被删掉"完全可能 —— 那种缺陷只在
    // "带方向的照片"上表现为静默不转，其它断言全绿。
    const distPath = path.join(ROOT, 'storage/plugins/@local/service-ticket/dist/server/index.js');
    assert(fs.existsSync(distPath), `产物不存在（先跑 scripts/build-plugin.mjs）：${distPath}`);
    const dist = fs.readFileSync(distPath, 'utf8');
    assert(
      /require\("@napi-rs\/canvas"\)/.test(dist),
      '产物里没有 require("@napi-rs/canvas") —— 方向归一化会静默失效（构建产物自检也会拦，这里再确认一次）',
    );

    // 其余解码器"不在"是 media-guard 顶部那段注释的依据。这里如实报告而不硬判：
    // 哪天镜像里真的多了一个更好的解码器，那是**好事**，不该把门禁判红；
    // 但那段注释就该更新了，所以留一条降级提示。
    const alternatives = parsed.absent.filter((id) => id !== '@napi-rs/canvas');
    if (alternatives.length < 7) {
      degraded.push(
        `镜像里出现了其他图像解码器（${parsed.present.filter((i) => i !== '@napi-rs/canvas').join(', ')}）` +
          ' —— media-guard.ts 顶部"实测全部 MISS"的注释需要复核',
      );
    }
    return `@napi-rs/canvas v${parsed.version} 可用（${parsed.resolved}）；产物外置引用已确认；替代解码器缺席 ${alternatives.length}/7`;
  });

  await checkAsync('B11b 1..8 全部取向：上传后落盘像素**已转正**、EXIF/GPS 已清、尺寸已交换', async () => {
    assert(pillowReady, 'Pillow 不可用 —— 落盘字节无法用真实解码器判朝向');
    // 主单放旋转类 + 带 GPS 的样本；副单放镜像类
    const rotatedFiles = ['orient1.jpg', 'orient3.jpg', 'orient6.jpg', 'orient8.jpg', 'orient6-gps.jpg'];
    const mirroredFiles = ['orient2.jpg', 'orient4.jpg', 'orient5.jpg', 'orient7.jpg'];
    const uploadedC = await uploadOrientationFixtures(tokenC, rotatedFiles, cVisitId);
    const uploadedD = await uploadOrientationFixtures(tokenD, mirroredFiles, dVisitId);

    // 落盘字节从**私有目录**取（不是走 HTTP）：这里要判的是"库里存的是什么"，
    // 而 HTTP 那一层的响应头/鉴权由 B6 单独盯。而且 `http()` 用的 res.text()
    // 会把二进制按 UTF-8 解一次（会损坏字节），本来也不能拿来当像素判据。
    const rowsOf = (ticketId) =>
      psqlRows(
        `SELECT p.storage_key, p.size, p.mime, a.meta::text FROM service_visit_photos p` +
          ` JOIN service_visits v ON v.id = p.visit_id JOIN attachments a ON a.id = p.file_id` +
          ` WHERE v.ticket_id = ${ticketId} ORDER BY p.id`,
      );

    fs.rmSync(ORIENT_OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(ORIENT_OUT_DIR, { recursive: true });
    fs.copyFileSync(path.join(ORIENT_DIR, 'orient-ref.png'), path.join(ORIENT_OUT_DIR, 'orient-ref.png'));

    const cases = [
      ...uploadedC.map((u, i) => ({ ...u, row: rowsOf(c.ticketId)[i], visitId: cVisitId })),
      ...uploadedD.map((u, i) => ({ ...u, row: rowsOf(d.ticketId)[i], visitId: dVisitId })),
    ];

    for (const item of cases) {
      assert(item.row, `${item.file} 在库里找不到对应的照片行`);
      const [key, size, mime, meta] = item.row;
      eq(mime, 'image/jpeg', `${item.file} 库里的 mime`);
      // 取回落盘字节
      const b64 = fetchPrivateFileBase64(key);
      assert(b64.length > 100, `${item.file} 取不到落盘字节（key=${key}）`);
      const bytes = Buffer.from(b64, 'base64');
      // 接口报的 size 必须等于磁盘文件的真实长度 —— 否则"显示正常"就只是接口在自说自话
      eq(bytes.length, item.size, `${item.file} 落盘字节数与接口报的 size`);
      eq(Number(size), bytes.length, `${item.file} 库里记的 size 与磁盘`);
      fs.writeFileSync(path.join(ORIENT_OUT_DIR, item.file), bytes);

      // 库里应当记下"为什么这张照片是转过的"（事后排查不靠人回想）
      const flat = String(meta).replace(/\s+/g, '');
      assert(
        flat.includes('"rotated_from":null') || /"rotated_from":\d/.test(flat),
        `${item.file} 的 attachments.meta 缺 rotated_from：${flat.slice(0, 160)}`,
      );
    }

    const report = JSON.parse(
      execFileSync(PYTHON, ['-c', CHECK_ORIENT_PY, ORIENT_OUT_DIR], { encoding: 'utf8' }).trim(),
    );
    eq(report.ref.layout, 'RGBY', '参考图布局（判据的基准）');
    const summary = [];
    for (const item of cases) {
      const rec = report.files[item.file];
      assert(rec && !rec.error, `${item.file} 检查失败：${rec?.error ?? '记录缺失'}`);
      // ① 核心断言：落盘像素的视觉方向 == 参考图（四象限 红/绿/蓝/黄）
      eq(rec.layout, 'RGBY', `${item.file} 落盘后的象限布局（必须已转正）`);
      eq(rec.size, [400, 300], `${item.file} 落盘后的尺寸`);
      assert(rec.maxdev < 3000, `${item.file} 象限取色偏离过大：${rec.maxdev}`);
      // ② EXIF / GPS / 方向标签都必须没有
      eq(rec.orientation_tag ?? null, null, `${item.file} 落盘后不应再有 Orientation 标签`);
      eq(rec.exif_tags, [], `${item.file} 落盘后不应再有 EXIF`);
      eq(rec.gps_tags, [], `${item.file} 落盘后不应再有 GPS IFD`);
      summary.push(`${item.file}→${rec.layout}`);
    }
    // 交叉证据：被归一化过的图，其"存储布局"本应不是正方向（A4b 已证明），
    // 这里再确认"它现在的确是正方向" —— 两句话合起来才是"确实转过"。
    assert(summary.length === 9, `样本数应为 9（1/3/6/8 + 带 GPS 的 6 + 2/4/5/7），实际 ${summary.length}`);
    if (nginxThrottled > 0) {
      degraded.push(
        `B11b 期间被 **nginx** 的 svc_upload 区（IP 粒度 60r/m，burst=20）挡下 ${nginxThrottled} 次并退避重试成功` +
          ' —— 这是基础设施的粗粒度兜底，与被测行为无关；若次数继续增长，应考虑给本脚本的上传段加长节流',
      );
    }
    return `${summary.join(' ')}${nginxThrottled ? `（nginx 兜底重试 ${nginxThrottled} 次）` : ''}`;
  });

  await checkAsync('B11c 取向为恒等（=1）时不做无谓重编码：落盘字节 == 本地段级剥离结果', async () => {
    const key = psqlRows(
      `SELECT p.storage_key FROM service_visit_photos p JOIN service_visits v ON v.id = p.visit_id` +
        ` WHERE v.ticket_id = ${c.ticketId} ORDER BY p.id LIMIT 1`,
    )[0]?.[0];
    assert(key, '取不到 orient1.jpg 对应的 storage_key');
    // 契约：**只在方向非恒等时才重编码**。取向 1 的照片必须逐字节等于段级剥离的结果 ——
    // 这条性质有两层意义：① 绝大多数照片（无标签或 =1）不受本次修复影响，行为零变化；
    // ② A2 那条"剥离不动像素"的断言因此仍然有效，不会被"顺手全部重编码"悄悄废掉。
    const local = MediaGuard.stripImageMetadata(
      fs.readFileSync(path.join(ORIENT_DIR, 'orient1.jpg')),
      'image/jpeg',
    ).data;
    const expected = createHash('sha256').update(local).digest('hex');
    const actual = inApp(`sha256sum ${PRIVATE_DIR}/${key}`).out.split(/\s+/)[0];
    eq(actual, expected, `取向 1 照片的落盘 sha256 vs 本地剥离结果（${local.length}B）`);
    return `${actual.slice(0, 12)}… 一致（取向 1 未重编码，${local.length}B）`;
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
    // DEV-84 的两张方向工单也要清（它们各有 5 / 4 张私有照片）
    const rc = cleanupTicket(fixtures.c);
    const rd = cleanupTicket(fixtures.d);
    if (ra) console.log(`  · 清理：删除 ${ra.filesDeleted} 个私有照片文件 / ${ra.attachmentsDeleted} 条附件行`);
    if (rc || rd) {
      console.log(
        `  · 清理（DEV-84 方向工单）：删除 ${(rc?.filesDeleted ?? 0) + (rd?.filesDeleted ?? 0)} 个私有照片文件 / ` +
          `${(rc?.attachmentsDeleted ?? 0) + (rd?.attachmentsDeleted ?? 0)} 条附件行`,
      );
    }
    const back = sms.restore();
    if (sms.original !== undefined) console.log(`  · 短信开关已复位：${back.note}`);
  },
});

if (state.failures.length) process.exit(1);
