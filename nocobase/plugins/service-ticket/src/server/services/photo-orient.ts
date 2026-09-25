/**
 * photo-orient —— 上传照片的 **EXIF 方向归一化**（DEV-84）。
 * =============================================================================
 *
 * 缺陷：`media-guard.stripImageMetadata()` 做的是**段级剥离**，它把 EXIF
 * （含 Orientation）从容器里删掉，却**不动像素**。而手机拍的 JPEG，像素本身
 * 往往不是视觉正方向 —— 正确显示依赖 Orientation 标签。标签一删，照片就躺倒了：
 * 现场实拍照片在门店端**统一向右旋转 90°**，就是这么来的。
 *
 * 正确的加工顺序（**顺序本身是设计的一部分，不要重排**）：
 *
 *   原始上传字节
 *     ↓ ① 读 EXIF Orientation      media-guard.readExifOrientation（纯函数）
 *     ↓ ② 段级剥离 EXIF/metadata   media-guard.stripImageMetadata（纯函数）
 *     ↓ ③ 解码 → 按矩阵旋转/翻转像素   本模块（需要解码器）
 *     ↓ ④ 重编码                      本模块（输出天然不含 EXIF）
 *     ↓ ⑤ 私有存储
 *
 * -----------------------------------------------------------------------------
 * ⚠️ 为什么是"先剥离、再解码"，而不是直觉上的"先按方向转、再剥离"
 * -----------------------------------------------------------------------------
 * 因为**解码器自己会套用 EXIF 方向，而且三种容器行为不一致**
 * （2026-09-25 在 `nocobase/nocobase:2.2.15-full-no-nginx` 的
 * `@napi-rs/canvas@0.1.100` 上逐容器实测，样本是"存储像素 300×400、Orientation=6"）：
 *
 *   容器   loadImage 是否自动套用 EXIF 方向
 *   JPEG   ✅ 会（解出来是 400×300，画面已转正）
 *   WebP   ✅ 会
 *   PNG    ❌ **不会**（解出来仍是 300×400）
 *
 * 若按直觉把**带标签的原图**交给解码器：JPEG/WebP 会被解码器先转一次，
 * 我们再转一次 ⇒ **双重旋转**；PNG 则不会被转，我们转一次 ⇒ 正确。两个方向都错，
 * 而且错法还不一样。**先把标签剥掉**，解码器拿到的必然是"原始存储像素"，
 * 于是变换矩阵成为方向的**唯一**来源，三种容器行为归一。
 *
 * -----------------------------------------------------------------------------
 * ⚠️ 依赖取舍：为什么用 `@napi-rs/canvas`，以及它消失时会怎样
 * -----------------------------------------------------------------------------
 * 镜像里**没有** `sharp` / `jimp` / `exifr` / `piexifjs` / `jpeg-js` / `pngjs`
 * （`scripts/verify-technician-upload.mjs` 的 A0 逐条断言），也没有 Dockerfile
 * 可以加装原生依赖。**唯一**可用的解码/编码器是 `@napi-rs/canvas@0.1.100` ——
 * 它是 `pdfjs-dist`（NocoBase 用于 PDF 预览）的依赖，被提升到
 * `/app/nocobase/node_modules` 顶层，因此插件 require 得到。
 *
 * 这**正是** `media-guard.ts` 顶部警告过的那类耦合（"把判定挂在别人的依赖树上"）。
 * 所以本模块对它采取三条硬约束，而不是默默依赖：
 *   ① **惰性 + 失败不致命**：`require` 只发生在真正需要归一化的那一刻，失败被
 *      捕获成"能力不可用"，**绝不让整个应用起不来**（没有照片功能的场景照常工作）；
 *   ② **需要时 fail-closed**：源图带非恒等方向、而解码器不可用时，**拒绝这次上传**，
 *      而不是"剥完 EXIF 照存" —— 后者正是本缺陷的成因。把一个躺倒的照片悄悄
 *      存进库，比明确报错坏得多；
 *   ③ **启动自检 + 门禁**：`probeOrientationCapability()` 把"可用 / 不可用 + 原因"
 *      写进启动日志，并用**内嵌构造**的样本跑一遍"剥 → 转 → 编"完整链路；
 *      `scripts/verify-technician-upload.mjs` 的 A0/A4/B11 在**真实镜像**里再断言一次。
 *
 * -----------------------------------------------------------------------------
 * ⚠️ 缩放：只在本路径生效（如实记录，不当成已完成）
 * -----------------------------------------------------------------------------
 * `UPLOAD_MAX_EDGE_PX` / `UPLOAD_JPEG_QUALITY` 目前**只**作用于
 * "带非恒等方向"的照片；恒等方向仍走段级剥离、**不缩放**。
 * 也就是说"上传前统一压到 1600px"这件事**仍未完整实现**（已在 docs/PHASE-5.md 标明）。
 * 之所以在这里顺手设上限，是因为重编码后的字节数不再受"原始上传字节数"约束，
 * 必须给它一个明确上界（1600px @ q82 远小于 5MB 的落盘上限）。
 *
 * -----------------------------------------------------------------------------
 * 能力边界（**不能**由本模块证明的事）
 * -----------------------------------------------------------------------------
 *   · 启动自检只断言"尺寸互换 + 标签消失"，**不**断言像素视觉方向 ——
 *     方向由 `orientationTransform()` 那张矩阵表决定，它在离线阶段由
 *     A4c 用几何断言钉住（源图四角必须落进目标框、特征点必须落到规定位置），
 *     端到端则由 B11 把**真实夹具**上传后取回、用 Pillow 与参考图逐象限比对。
 *   · 不做"图片内容是否安全"的判断（那是 media-guard 的事）。
 */
import { Buffer } from 'node:buffer';

import {
  IMAGE_MIME,
  needsOrientationTransform,
  orientationTransform,
  readExifOrientation,
  stripImageMetadata,
} from '../../shared/media-guard';

/** 归一化参数（由调用方从注入的 env 读出后传入，便于测试注入） */
export interface OrientationNormalizeOptions {
  /** 归一化后允许的最长边；<= 0 表示不缩放 */
  maxEdgePx: number;
  /** JPEG 重编码质量 1..100（PNG 忽略它；WebP 用它） */
  jpegQuality: number;
}

/** 归一化结果：可直接落盘的字节 + 归一化后的尺寸 */
export interface NormalizedPhotoBytes {
  /** 转正后的字节，可直接落盘 */
  data: Buffer;
  /** 与输入同一个 MIME —— 本模块**不换容器** */
  mime: string;
  /** 归一化后的宽（5/6/7/8 已交换） */
  width: number;
  /** 归一化后的高 */
  height: number;
  /** 源图声明的取向（2..8） */
  orientation: number;
  /** 是否因为超过 `maxEdgePx` 而缩小过 */
  scaled: boolean;
}

/** 解码器能力探针的结果（启动日志与门禁都读它） */
export interface OrientationCapability {
  available: boolean;
  /** 不可用时的一句话原因（给人看） */
  reason: string;
  /** `@napi-rs/canvas` 的版本；读不到为 null */
  version: string | null;
  /** 自检：用内嵌样本跑一遍完整链路 */
  selfTest: 'PASS' | 'FAIL' | 'SKIPPED';
  selfTestDetail: string;
}

/**
 * 需要归一化但解码器不可用 —— 调用方必须把这次上传**整体拒掉**（fail-closed）。
 *
 * `status` / `code` 由**错误实例自带**（同 `ValidationError` 的口径）：
 * `actions/svc/_http.ts` 的 `statusOf()` 里有一条对应的 `instanceof` 分支，
 * 它只读不算。⚠️ 往 `statusOf()` 里加错误类型而**不加分支**会让它静默变成 500，
 * `scripts/verify-plugin-load.mjs` 有一条结构性闸门专门拦这件事（DEV-75 的教训）。
 */
export class OrientationUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'PHOTO_ORIENTATION_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'OrientationUnavailableError';
  }
}

/**
 * 对外（匿名师傅端）能看到的文案。
 *
 * ⚠️ **不要**把 `OrientationUnavailableError.message` 直接当对外文案：
 *    它里面写着内部依赖名与 require 的报错文本（如 `require('@napi-rs/canvas') 失败…`），
 *    那是给运维看的。原始原因进应用日志，响应里只回这一句稳定的。
 */
export const ORIENTATION_UNAVAILABLE_TEXT = '照片方向处理暂不可用，请稍后重试';

/** 本模块依赖的包名（日志/断言里引用同一份字面量，避免两处漂移） */
export const ORIENTATION_LIB = '@napi-rs/canvas';

// ---------------------------------------------------------------------------
// 解码器的惰性装载
// ---------------------------------------------------------------------------

interface Canvas2DLike {
  transform: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  scale: (x: number, y: number) => void;
  drawImage: (image: unknown, x: number, y: number, width: number, height: number) => void;
  imageSmoothingEnabled?: boolean;
  imageSmoothingQuality?: string;
}

interface CanvasLike {
  getContext: (kind: '2d') => Canvas2DLike;
  toBuffer: (mime: string, quality?: number) => Buffer;
}

interface LoadedImageLike {
  width: number;
  height: number;
}

interface CanvasModuleLike {
  createCanvas: (width: number, height: number) => CanvasLike;
  loadImage: (source: Buffer) => Promise<LoadedImageLike>;
}

interface CanvasCache {
  mod: CanvasModuleLike | null;
  reason: string;
  version: string | null;
}

let canvasCache: CanvasCache | null = null;

/**
 * 装载解码器。**只在这里 require**，且失败被吸收成"能力不可用"。
 *
 * 为什么用裸 `require` 而不是 `import`：这是原生模块（`.node`），
 * esbuild 打不进产物，必须由宿主在运行时解析 —— 它在
 * `scripts/build-plugin.mjs` 的 EXTERNALS 里，产物中会留下
 * `require("@napi-rs/canvas")`，离线断言（A0d）就是靠这一点确认"耦合还在明处"。
 */
function loadCanvasModule(): CanvasCache {
  if (canvasCache) return canvasCache;
  try {
    // ⚠️ 这里**必须写字符串字面量**（而不是用 ORIENTATION_LIB 变量）：
    //    esbuild 只对字面量做"标记为外部依赖"的处理，变量形式会被当成
    //    动态 require 原样留下 —— 那样就**看不见**这条耦合了，
    //    `scripts/build-plugin.mjs` 的产物自检与 A0d 也就无从断言。
    //    字面量与 ORIENTATION_LIB 的一致性由 A0d 一起盯住。
    const mod = require('@napi-rs/canvas') as CanvasModuleLike;
    if (typeof mod?.createCanvas !== 'function' || typeof mod?.loadImage !== 'function') {
      canvasCache = { mod: null, reason: `已加载 ${ORIENTATION_LIB}，但缺少 createCanvas/loadImage`, version: null };
      return canvasCache;
    }
    let version: string | null = null;
    try {
      version =
        String((require('@napi-rs/canvas/package.json') as { version?: unknown })?.version ?? '') || null;
    } catch {
      version = null;
    }
    canvasCache = { mod, reason: '', version };
  } catch (error) {
    canvasCache = {
      mod: null,
      reason: `require('${ORIENTATION_LIB}') 失败：${(error as Error)?.message ?? String(error)}`,
      version: null,
    };
  }
  return canvasCache;
}

/** 测试用：清掉能力缓存（生产路径不需要） */
export function resetOrientationCacheForTests(): void {
  canvasCache = null;
  probeCache = null;
}

// ---------------------------------------------------------------------------
// 判定：这张图要不要归一化
// ---------------------------------------------------------------------------

/**
 * 需要归一化时返回源图声明的取向（2..8），否则返回 `null`。
 *
 * 它是调用点唯一的判据 —— 把"读标签 + 判断是否需要动像素"收在一个纯函数里，
 * 调用点就不会退化成分散各处的 `orientation !== 1` 写法。
 * ⚠️ 它**只读标签**，不解码、不写盘；解码器是否可用与它无关。
 */
export function pendingOrientation(mime: string, bytes: Uint8Array): number | null {
  const declared = readExifOrientation(bytes, mime);
  return needsOrientationTransform(declared) ? (declared as number) : null;
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/**
 * 按取向旋转/翻转像素并重编码。
 *
 * ⚠️ **入参必须是"已剥离元数据"的字节**。带标签的原图进来会被解码器先转一次
 *    （JPEG/WebP），我们再转一次 ⇒ 双重旋转。这个前提由下面那条断言钉住 ——
 *    它是本模块**最容易被后续改动破坏**的假设，所以宁可多一次廉价检查。
 *
 * 执行顺序：`scale` → 方向矩阵 → `drawImage`，**不可换**。
 *   Canvas2D 的 CTM 是左乘累积（CTM' = CTM · M），所以后写的先作用于坐标点；
 *   方向矩阵里的 e/f 是**源图**的宽高，必须在未缩放的坐标系里生效。
 *   把两者顺序写反，会得到"尺寸正确、画面整块偏移/超出边界"的结果 ——
 *   那种缺陷在小缩略图上看不出来。
 */
export async function normalizePhotoOrientation(
  input: Uint8Array,
  mime: string,
  orientation: number,
  options: OrientationNormalizeOptions,
): Promise<NormalizedPhotoBytes> {
  const { mod, reason } = loadCanvasModule();
  if (!mod) throw new OrientationUnavailableError(reason);

  const src = Buffer.isBuffer(input) ? input : Buffer.from(input);

  // 前提断言：进来的字节必须已经不含方向标签
  const residual = readExifOrientation(src, mime);
  if (residual !== null) {
    throw new Error(
      `[photo-orient] 归一化的入参仍带 Orientation=${residual} —— ` +
        '必须先经 stripImageMetadata() 剥离，否则解码器会重复套用（见本文件头部说明）',
    );
  }

  const image = await mod.loadImage(src);
  const srcW = Math.round(Number(image?.width));
  const srcH = Math.round(Number(image?.height));
  if (!(srcW > 0 && srcH > 0)) {
    throw new Error(`[photo-orient] 解码后尺寸非法：${srcW}x${srcH}`);
  }

  const transform = orientationTransform(orientation, srcW, srcH);
  if (!transform) {
    throw new Error(`[photo-orient] 取向 ${orientation} 没有对应的变换矩阵`);
  }

  const displayW = transform.swap ? srcH : srcW;
  const displayH = transform.swap ? srcW : srcH;

  const limit = Number.isFinite(options.maxEdgePx) ? Math.floor(Number(options.maxEdgePx)) : 0;
  const longest = Math.max(displayW, displayH);
  const scale = limit > 0 && longest > limit ? limit / longest : 1;
  const outW = Math.max(1, Math.round(displayW * scale));
  const outH = Math.max(1, Math.round(displayH * scale));

  const canvas = mod.createCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  if (scale !== 1) ctx.scale(scale, scale);
  const [a, b, c, d, e, f] = transform.matrix;
  ctx.transform(a, b, c, d, e, f);
  if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, srcW, srcH);

  const data = encodeCanvas(canvas, mime, options.jpegQuality);
  return { data, mime, width: outW, height: outH, orientation, scaled: scale !== 1 };
}

/** 按容器编码。**不换容器** —— 落盘扩展名与库里的 mime 依赖这一点。 */
function encodeCanvas(canvas: CanvasLike, mime: string, jpegQuality: number): Buffer {
  const quality = Math.min(100, Math.max(1, Math.round(Number(jpegQuality) || 82)));
  if (mime === IMAGE_MIME.JPEG) return canvas.toBuffer('image/jpeg', quality);
  if (mime === IMAGE_MIME.PNG) return canvas.toBuffer('image/png');
  if (mime === IMAGE_MIME.WEBP) return canvas.toBuffer('image/webp', quality);
  throw new Error(`[photo-orient] 不支持重编码为 ${mime}`);
}

// ---------------------------------------------------------------------------
// 能力探针（启动自检）
// ---------------------------------------------------------------------------

let probeCache: OrientationCapability | null = null;

/**
 * 探一次解码器能力。结果被缓存；`plugin.load()` 会把它写进启动日志。
 *
 * 为什么要自检而不只是 `require` 成功：**require 成功不代表链路可用**。
 * 自检样本是**运行时构造**的（不内嵌二进制），它把"剥 → 转 → 编"整条路走一遍：
 *   1. 用画布画 40×20 的图并编码成 JPEG；
 *   2. 手工贴上最小合法的 APP1(Exif)，只写 Orientation=6；
 *   3. 断言 `readExifOrientation()` 读得出 6（否则测的是空气）；
 *   4. 段级剥离后断言标签消失；
 *   5. 归一化后断言 **40×20 变成 20×40**（取向 6 生效）且无残留标签。
 * 第 5 步同时是"解码器没有替我们转"的反向哨兵：夹具是 JPEG，若哪天有人把
 * "先剥离"改回"直接解码原图"，解码器会自动转一次、尺寸就不会互换，这里立刻红。
 */
export async function probeOrientationCapability(): Promise<OrientationCapability> {
  if (probeCache) return probeCache;

  const { mod, reason, version } = loadCanvasModule();
  if (!mod) {
    probeCache = { available: false, reason, version: null, selfTest: 'SKIPPED', selfTestDetail: reason };
    return probeCache;
  }

  try {
    const detail = await selfTestOrientation(mod);
    probeCache = { available: true, reason: '', version, selfTest: 'PASS', selfTestDetail: detail };
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    probeCache = { available: false, reason: `自检失败：${message}`, version, selfTest: 'FAIL', selfTestDetail: message };
  }
  return probeCache;
}

async function selfTestOrientation(mod: CanvasModuleLike): Promise<string> {
  const fixture = buildOrientationFixture(mod);

  const declared = readExifOrientation(fixture, IMAGE_MIME.JPEG);
  if (declared !== 6) throw new Error(`夹具的 Orientation 应为 6，实际读出 ${declared}`);

  const stripped = stripImageMetadata(fixture, IMAGE_MIME.JPEG).data;
  if (readExifOrientation(stripped, IMAGE_MIME.JPEG) !== null) {
    throw new Error('剥离后仍能读出 Orientation —— 段级剥离失效');
  }

  const out = await normalizePhotoOrientation(stripped, IMAGE_MIME.JPEG, 6, {
    maxEdgePx: 0,
    jpegQuality: 82,
  });
  if (out.width !== 20 || out.height !== 40) {
    throw new Error(`40x20 经取向 6 应为 20x40，实际 ${out.width}x${out.height}`);
  }
  if (readExifOrientation(out.data, IMAGE_MIME.JPEG) !== null) {
    throw new Error('重编码产物仍能读出 Orientation');
  }
  return '40x20 → 20x40（取向 6 生效）且无残留标签';
}

/**
 * 造一张"存储像素 40×20、但声明 Orientation=6"的 JPEG。
 *
 * APP1 里那段 TIFF 是**最小合法结构**（不是随手拼的字节）：它同时能被
 * `media-guard.readExifOrientation()` 与 Pillow 的 `getexif()` 读出来 ——
 * 用真解析器读得到的样本，自检才有意义。
 */
function buildOrientationFixture(mod: CanvasModuleLike): Buffer {
  const canvas = mod.createCanvas(40, 20);
  const ctx = canvas.getContext('2d') as Canvas2DLike & {
    fillStyle?: string;
    fillRect?: (x: number, y: number, w: number, h: number) => void;
  };
  if (typeof ctx.fillRect === 'function') {
    // 左右两半颜色不同：为的是"若解码器替我们转了一次"能留下形状上的痕迹
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 20, 20);
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(20, 0, 20, 20);
  }
  const jpeg = canvas.toBuffer('image/jpeg', 90);

  const tiff = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // 'II' + 42 + IFD0 偏移 8
    0x01, 0x00, // 1 个条目
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, // 0x0112 SHORT×1 = 6
    0x00, 0x00, 0x00, 0x00, // 没有下一个 IFD
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const segment = Buffer.alloc(4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2); // 段长含自身 2 字节

  // 插在 SOI(FF D8) 之后 —— 这正是相机写 EXIF 的位置
  return Buffer.concat([jpeg.subarray(0, 2), segment, payload, jpeg.subarray(2)]);
}
