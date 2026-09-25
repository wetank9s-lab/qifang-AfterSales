/**
 * media-guard —— 师傅上传照片的**图像闸门**（Phase 5 / P5-1）。
 *
 * ---------------------------------------------------------------------------
 * 为什么这是一个「纯函数」模块，而不是塞在 action 里
 * ---------------------------------------------------------------------------
 * 这里判定的每一件事都是**安全边界**：
 *   · 是不是真的图片（magic bytes，不信 Content-Type 与扩展名）；
 *   · 尺寸是不是真的在范围内；
 *   · EXIF/GPS 是不是真的被去掉了。
 * 把它写成纯函数（Buffer 进、Buffer 出、不碰文件系统、不碰数据库）之后，
 * 这些判定就能被**离线断言逐字节验证** —— `scripts/verify-technician-upload.mjs`
 * 会喂进真实构造的 JPEG/PNG/WebP 字节，并断言"输出里再也搜不到 EXIF 标记"。
 * 如果判定逻辑和 IO 混在一起，就只能靠"上传一次看结果"来验证，
 * 那种验证无法覆盖"某个分支的字节序列"。
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 为什么是**段级剥离**，以及 DEV-84 之后补了什么
 * ---------------------------------------------------------------------------
 * 常规做法是 `sharp(buf).rotate().jpeg({quality}).toBuffer()`：解码→重编码，
 * EXIF 自然消失、还能顺便缩放。本项目**用不了**这条路：
 * 应用镜像 `nocobase/nocobase:2.2.15-full-no-nginx` 里
 * `sharp` / `jimp` / `canvas` / `image-size` / `exifr` / `piexifjs` / `jpeg-js` / `pngjs`
 * 实测**全部 MISS**（`scripts/verify-technician-upload.mjs` 的 A0 逐条断言），
 * 而本项目**没有 Dockerfile**（直接用官方镜像），装原生依赖需要改镜像构建链 ——
 * 那是明确的范围外改动。
 *
 * 于是元数据清除改为**不改动像素数据**的段级剥离：
 *   · JPEG —— 丢掉 APP1（Exif + XMP）、APP13（IPTC/Photoshop）、COM；
 *   · PNG  —— 丢掉 tEXt / zTXt / iTXt / eXIf / tIME 块；
 *   · WebP —— 丢掉 EXIF / XMP 块，并重算 RIFF 的长度字段。
 * 这三件事都不需要解码器：这些格式的元数据都躺在**独立的容器段**里，
 * 像素数据在 IDAT / SOS 之后原样保留。
 *
 * ⚠️ 但**只做剥离是不够的** —— 这正是 DEV-84 的真实缺陷：
 * 手机拍出来的 JPEG，其**像素本身往往不是视觉正方向**，正确显示依赖 EXIF
 * Orientation 标签。把 Orientation 一删了事，照片就"躺倒"了
 * （现场实拍：门店端看到的照片统一向右旋转 90°）。
 * 所以本模块补了两件**仍然是纯函数**的事（不需要解码器）：
 *   · `readExifOrientation()`   —— 从容器里**读出** Orientation 的值，不解码像素；
 *   · `orientationTransform()` —— 给出该取向对应的**像素变换矩阵**（几何，与画布无关）。
 * 真正的"按矩阵旋转像素 + 重编码"在 `server/services/photo-orient.ts`，
 * 用的是镜像里**确实存在**的 `@napi-rs/canvas`（取舍见该文件头部）。
 * 本模块**刻意保持纯函数、零依赖**：它是安全判定层，像素变换不是判定。
 *
 * 由此带来四个**刻意的取舍**，必须如实记录而不是当成已完成：
 *   ① **只在必要时重编码**：仅当源图带**非恒等** EXIF 方向时才走
 *      "解码→旋转→重编码"；恒等方向（无 Orientation 或 =1）仍走段级剥离，
 *      像素**逐字节不变**（`scripts/verify-technician-upload.mjs` 的 A2 盯住这点）。
 *      ⚠️ 关键在于顺序：**先按"读了方向 → 先剥离 → 再解码旋转"**，
 *      而不是"解码旋转 → 再剥离"。原因是主流解码器（JPEG/WebP）**自己会套用
 *      EXIF 方向**，而 PNG 的解码器**不会** —— 若把带标签的原图直接交给解码器，
 *      同一条代码在三种容器上会得到两种结果，还会双重旋转。先剥离标签，
 *      解码器就必然拿到"原始存储像素"，变换矩阵才是唯一的方向来源。
 *   ② **缩放只在归一化路径生效**：`.env` 的 `UPLOAD_MAX_EDGE_PX` /
 *      `UPLOAD_JPEG_QUALITY` 目前只作用于"带非恒等方向"的照片；恒等方向仍**不缩放**。
 *      也就是说"上传前统一压到 1600px"**仍未完整实现**，已在 `docs/PHASE-5.md` 标明。
 *      缓解手段依旧是上传前的**字节数上限**（`visit.photo_max_size_mb`）+ 张数上限（6 张）。
 *   ③ **不做像素级校验**：不检测"图片里是否还藏着别的载荷"（如 JPEG 尾部的附加数据）。
 *      本模块只承诺"元数据段已移除"，不承诺"文件内容已净化"。
 *      这也是为什么读取必须走**受控端点**并且响应头固定 `Content-Type` + `nosniff`
 *      （见 action 层的 photo handler）—— 只要不让浏览器把它当 HTML 解析，
 *      夹带内容就没有执行面。
 *   ④ 保留 APP0(JFIF) / APP2(ICC) / APP14(Adobe)：它们不是隐私载体，
 *      删掉 ICC 会改变颜色表现，属于"为了看起来干净而制造新问题"。
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 为什么自己写嗅探而不用 `file-type`
 * ---------------------------------------------------------------------------
 * 容器里确实有 `file-type@5.2.0`，但那是 NocoBase 某个包的**传递依赖**
 * （2018 年的版本，`fileType(buffer)` 的 CJS 形态），既不在本项目声明的依赖里，
 * 也不在 esbuild 的 external 白名单里 —— 依赖它等于把安全判定挂在别人的
 * 依赖树上，NocoBase 升级时它消失或改签名，本闸门会**静默失效**。
 * 自己实现只有 3 个格式、且是 **strict-deny**（只认这三种，其余一律拒绝），
 * 逻辑短到可以逐行审阅，并且能被离线断言穷举。
 */
import { Buffer } from 'node:buffer';

/** 允许的图片类型。**这是白名单本身**，新增格式必须同步 docs/SECURITY.md §3 */
export const IMAGE_MIME = {
  JPEG: 'image/jpeg',
  PNG: 'image/png',
  WEBP: 'image/webp',
} as const;

export type ImageMime = (typeof IMAGE_MIME)[keyof typeof IMAGE_MIME];

/** 白名单的**数组**形态（顺序固定，便于断言"恰好三种"） */
export const SUPPORTED_IMAGE_MIMES: readonly string[] = [
  IMAGE_MIME.JPEG,
  IMAGE_MIME.PNG,
  IMAGE_MIME.WEBP,
];

/** 每种 MIME 对应的落盘扩展名（由**嗅探结果**决定，不取用户文件名） */
export const IMAGE_EXTENSION: Record<string, string> = {
  [IMAGE_MIME.JPEG]: 'jpg',
  [IMAGE_MIME.PNG]: 'png',
  [IMAGE_MIME.WEBP]: 'webp',
};

export interface ImageProbe {
  /** 由 magic bytes 判定，**不是**请求里声明的 Content-Type */
  mime: string;
  /** 落盘扩展名（无点） */
  ext: string;
  /** 像素宽；解析不出时为 null（允许，列可空） */
  width: number | null;
  /** 像素高 */
  height: number | null;
}

export interface StripResult {
  /** 剥离后的字节（可直接落盘） */
  data: Buffer;
  /** 实际移除了哪些段的可读名称（用于日志与断言，**不是**给用户看的） */
  removed: string[];
}

/** 嗅探失败的原因（内部使用；对外统一 `UNSUPPORTED_IMAGE`，不区分原因） */
export type SniffFailure =
  | 'TOO_SHORT'
  | 'UNKNOWN_FORMAT'
  | 'TRUNCATED'
  /** 声明与实际不符（如 PNG 签名后第一块不是 IHDR） */
  | 'MALFORMED';

/**
 * 判定一段字节是不是**受支持的图片**，并顺带取回尺寸。
 *
 * **strict-deny**：不认识的格式一律 `null`（调用方回 `UNSUPPORTED_IMAGE`）。
 * 为什么不返回"未知类型但也放行"：那等于让上传接口变成一个通用文件暂存处，
 * 而它是匿名可写的（Token 即凭证），一旦能存任意字节，
 * 私有目录就变成了"公网可写、口子很小"的网盘 —— 与"现场照片"这个用途无关，
 * 却要承担全部风险。
 */
export function sniffImage(input: Uint8Array): ImageProbe | null {
  const buf = toBuffer(input);

  if (isJpeg(buf)) {
    const size = jpegSize(buf);
    return { mime: IMAGE_MIME.JPEG, ext: 'jpg', width: size?.width ?? null, height: size?.height ?? null };
  }
  if (isPng(buf)) {
    const size = pngSize(buf);
    return { mime: IMAGE_MIME.PNG, ext: 'png', width: size?.width ?? null, height: size?.height ?? null };
  }
  if (isWebp(buf)) {
    const size = webpSize(buf);
    return { mime: IMAGE_MIME.WEBP, ext: 'webp', width: size?.width ?? null, height: size?.height ?? null };
  }
  return null;
}

/**
 * 嗅探结果的**可用性判据**（与"是不是图片"分开）。
 *
 * 为什么需要第二道：`truncated.jpg`（真 JPEG 的前 300 字节）在字节层面
 * **确实是 JPEG** —— `sniffImage` 认它，剥元数据也不报错，但它的尺寸解析不出来，
 * 存进库就是一张**打不开的"照片"**，而师傅那边看到"上传成功"。
 * 现场照片的意义是"门店能看见师傅做了什么"，打不开等于没上传，
 * 却不会触发任何告警 —— 属于最坏的一类"静默成功"。
 *
 * 因此：能解析出宽高才收。判据是**从头部结构读出来的**（不依赖解码器），
 * 所以它对"像素数据中间被截断"仍然无能为力 —— 那一层由浏览器渲染兜底
 * （H5 上传后会立刻把照片渲染出来，打不开当场可见）。
 */
export function probeIssues(probe: ImageProbe | null): string[] {
  if (!probe) return ['UNSUPPORTED_FORMAT'];
  const issues: string[] = [];
  if (!probe.width || !probe.height) issues.push('NO_DIMENSIONS');
  return issues;
}

/**
 * 剥离元数据。**调用方必须先 `sniffImage()` 得到 `mime`** ——
 * 本函数不接受"任意字节 + 任意 mime"，那样无法保证解析器与数据匹配。
 *
 * 失败时抛 `Error`（格式与嗅探结果不符 = 数据被篡改或解析器有 bug）。
 * ⚠️ 这里**刻意不返回 `null` 让调用方兜底**：兜底意味着"解析失败就原样存"，
 * 而"原样存"正好把没剥干净的 EXIF 存进了库 —— 失败必须让上传整体失败。
 */
export function stripImageMetadata(input: Uint8Array, mime: string): StripResult {
  const buf = toBuffer(input);

  if (mime === IMAGE_MIME.JPEG) return stripJpeg(buf);
  if (mime === IMAGE_MIME.PNG) return stripPng(buf);
  if (mime === IMAGE_MIME.WEBP) return stripWebp(buf);

  throw new Error(`[media-guard] 不支持的 MIME：${mime}（只支持 ${SUPPORTED_IMAGE_MIMES.join(' / ')}）`);
}

/**
 * 剥完之后**回查**：把已知的元数据容器签名在结果里搜一遍。
 *
 * 为什么需要它：段级解析是手写的，"移除"与"看起来移除了"必须能区分。
 * 这个函数让 action 层在落盘**之前**就能断言"确实没有了"，
 * 而不是等测试脚本去发现。代价是一次 Buffer.contains，几毫秒。
 *
 * ⚠️ 它只能证明"这些**签名**不在了"，不能证明"没有任何元数据残留"
 * （例如 JPEG 尾部自由追加的字节）。这句话同样写进 docs/SECURITY.md。
 */
export function findMetadataTraces(data: Uint8Array, mime: string): string[] {
  const buf = toBuffer(data);
  const hits: string[] = [];

  if (mime === IMAGE_MIME.JPEG) {
    for (const marker of jpegMetadataMarkers(buf)) hits.push(marker);
  } else if (mime === IMAGE_MIME.PNG) {
    for (const type of pngChunkTypes(buf)) {
      if (PNG_DROP_CHUNKS.has(type)) hits.push(`PNG:${type}`);
    }
  } else if (mime === IMAGE_MIME.WEBP) {
    for (const fourcc of webpChunkTypes(buf)) {
      if (WEBP_DROP_CHUNKS.has(fourcc)) hits.push(`WEBP:${fourcc.trim()}`);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// EXIF Orientation（DEV-84）—— 只读标签与算矩阵，**不解码像素**
// ---------------------------------------------------------------------------

/** EXIF Orientation 的标签号（TIFF IFD0 里的 tag） */
export const EXIF_ORIENTATION_TAG = 0x0112;

/** 合法的取向取值。1 = 视觉正方向；2..8 都需要像素变换 */
export const EXIF_ORIENTATION_VALUES: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];

/** 取向的可读名（只进日志与断言输出，**不是**给用户看的文案） */
export const EXIF_ORIENTATION_LABEL: Record<number, string> = {
  1: '正常',
  2: '水平镜像',
  3: '旋转 180°',
  4: '垂直镜像',
  5: '主对角镜像',
  6: '顺时针 90°',
  7: '副对角镜像',
  8: '逆时针 90°',
};

/**
 * IFD0 的条目数上限。TIFF 的条目数是 16 位无符号数，恶意/损坏文件可以声明 65535
 * 条，让我们在一个 200 字节的段里空转 —— 上限让解析代价与输入长度成正比。
 */
const TIFF_IFD_MAX_ENTRIES = 512;

/** TIFF 头里"魔数"的位置与字节序标记 */
function tiffReader(tiff: Uint8Array) {
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return null;
  const u16 = (i: number): number =>
    little ? (tiff[i] as number) | ((tiff[i + 1] as number) << 8) : ((tiff[i] as number) << 8) | (tiff[i + 1] as number);
  const u32 = (i: number): number =>
    little
      ? ((tiff[i] as number) |
          ((tiff[i + 1] as number) << 8) |
          ((tiff[i + 2] as number) << 16) |
          ((tiff[i + 3] as number) << 24)) >>>
        0
      : (((tiff[i] as number) << 24) |
          ((tiff[i + 1] as number) << 16) |
          ((tiff[i + 2] as number) << 8) |
          (tiff[i + 3] as number)) >>>
        0;
  return { u16, u32 };
}

/**
 * 从一段 **TIFF 结构**（不是容器）里取 Orientation。
 *
 * 为什么单独抽出来：三种容器（JPEG APP1 / PNG eXIf / WebP EXIF）里的元数据
 * 都是**同一份 TIFF 结构**，只是外面包的壳不同。壳的遍历各写一遍，TIFF 的解析
 * 只写一遍 —— 否则三份解析迟早分叉。
 *
 * 只走 IFD0：Orientation 规约上就在 IFD0。不去跟 SubIFD / GPS IFD 的指针，
 * 少一层跟随就少一类死循环。
 */
export function parseExifOrientation(tiff: Uint8Array): number | null {
  const reader = tiffReader(tiff);
  if (!reader) return null;
  const { u16, u32 } = reader;
  if (u16(2) !== 0x002a) return null; // TIFF 魔数
  const ifdOffset = u32(4);
  if (ifdOffset + 2 > tiff.length) return null;

  const count = Math.min(u16(ifdOffset), TIFF_IFD_MAX_ENTRIES);
  for (let n = 0; n < count; n += 1) {
    const entry = ifdOffset + 2 + n * 12;
    if (entry + 12 > tiff.length) break;
    if (u16(entry) !== EXIF_ORIENTATION_TAG) continue;
    // 期望 SHORT(3) × 1：值直接内联在条目最后 2 字节里（本机字节序）
    if (u16(entry + 2) !== 3 || u32(entry + 4) !== 1) return null;
    const value = u16(entry + 8);
    return EXIF_ORIENTATION_VALUES.includes(value) ? value : null;
  }
  return null;
}

/** `Exif\0\0` 前缀（JPEG APP1 与部分 WebP 写入器会带） */
const EXIF_PREFIX = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

function hasExifPrefix(buf: Buffer, at: number, end: number): boolean {
  if (end - at < EXIF_PREFIX.length) return false;
  return EXIF_PREFIX.every((b, i) => buf[at + i] === b);
}

function jpegOrientation(buf: Buffer): number | null {
  let found: number | null = null;
  eachJpegSegment(buf, (marker, start, end) => {
    // APP1 里既可能是 Exif 也可能是 XMP（"http://ns.adobe.com/xap/1.0/"），
    // 只认带 Exif 前缀的那种。
    if (marker !== 0xe1) return 'continue';
    const payload = start + 4;
    if (!hasExifPrefix(buf, payload, end)) return 'continue';
    const value = parseExifOrientation(buf.subarray(payload + EXIF_PREFIX.length, end));
    if (value !== null) {
      found = value;
      return 'stop';
    }
    return 'continue';
  });
  return found;
}

function pngOrientation(buf: Buffer): number | null {
  let found: number | null = null;
  eachPngChunk(buf, (type, start, end) => {
    // PNG 的 eXIf 块载荷**就是** TIFF 头（没有 Exif\0\0 前缀）
    if (type !== 'eXIf') return 'continue';
    const value = parseExifOrientation(buf.subarray(start + 8, end - 4));
    if (value !== null) {
      found = value;
      return 'stop';
    }
    return 'continue';
  });
  return found;
}

function webpOrientation(buf: Buffer): number | null {
  let found: number | null = null;
  eachWebpChunk(buf, (fourcc, start, end) => {
    if (fourcc !== 'EXIF') return 'continue';
    // WebP 的 EXIF 块**有时**带 Exif\0\0 前缀（写入器各异），两种都认
    const base = start + 8;
    const at = hasExifPrefix(buf, base, end) ? base + EXIF_PREFIX.length : base;
    const value = parseExifOrientation(buf.subarray(at, end));
    if (value !== null) {
      found = value;
      return 'stop';
    }
    return 'continue';
  });
  return found;
}

/**
 * 读出图片声明的 EXIF Orientation；**读不到就返回 `null`**（含"字段存在但值非法"）。
 *
 * 调用方必须先 `sniffImage()` 拿到 `mime`（与 `stripImageMetadata` 同理）。
 * ⚠️ 本函数**不碰像素**，也不改字节 —— 它是判定/取参数，不是变换。
 */
export function readExifOrientation(input: Uint8Array, mime: string): number | null {
  const buf = toBuffer(input);
  if (mime === IMAGE_MIME.JPEG) return jpegOrientation(buf);
  if (mime === IMAGE_MIME.PNG) return pngOrientation(buf);
  if (mime === IMAGE_MIME.WEBP) return webpOrientation(buf);
  return null;
}

/**
 * 这个取向**是否需要动像素**。
 *
 * `null`（没有标签）与 `1`（显式正方向）都表示"存储像素就是视觉正方向"，
 * 也就是**不需要**任何变换 —— 这条判据决定了上传走哪条路径
 * （段级剥离 vs 解码重编码），所以它必须是一个能被断言的纯函数，
 * 而不是散在调用点的 `orientation !== 1` 这类写法。
 */
export function needsOrientationTransform(orientation: number | null): boolean {
  return orientation !== null && orientation !== 1 && EXIF_ORIENTATION_VALUES.includes(orientation);
}

/** 像素变换：把**存储像素坐标系**映射到**显示坐标系**（原点左上、单位 1 像素） */
export interface OrientationTransform {
  /** 目标画布是否要交换宽高（5/6/7/8 各转 90°，宽高必然互换） */
  swap: boolean;
  /**
   * 与 Canvas2D `ctx.transform(a, b, c, d, e, f)` 同参：`x' = a·x + c·y + e`，
   * `y' = b·x + d·y + f`。用矩阵而不是"先转后镜像"之类的步骤描述，
   * 是因为矩阵可以被**离线断言**：把源图四角代进去必须落在目标框内，
   * 且特定点必须落到特定位置（见 `scripts/verify-technician-upload.mjs` 的 A4c）。
   */
  matrix: readonly [number, number, number, number, number, number];
}

/**
 * 取向 → 变换矩阵。**这是 EXIF 规约里那张标准表**，逐条与规约一致：
 *
 *   1 正常        2 水平镜像      3 旋转 180°    4 垂直镜像
 *   5 主对角镜像  6 顺时针 90°    7 副对角镜像   8 逆时针 90°
 *
 * 返回 `null` 表示"不需要变换"（取向 1 或非法值）。
 * ⚠️ 千万不要把表里的 e/f 当成常量：它们分别是**源图的宽/高**，
 *    写错会得到一个"尺寸对、画面整块偏移"的结果 —— 那种缺陷在缩略图上看不出来。
 */
export function orientationTransform(
  orientation: number | null,
  width: number,
  height: number,
): OrientationTransform | null {
  const w = width;
  const h = height;
  switch (orientation) {
    case 1:
      return { swap: false, matrix: [1, 0, 0, 1, 0, 0] };
    case 2:
      return { swap: false, matrix: [-1, 0, 0, 1, w, 0] };
    case 3:
      return { swap: false, matrix: [-1, 0, 0, -1, w, h] };
    case 4:
      return { swap: false, matrix: [1, 0, 0, -1, 0, h] };
    case 5:
      return { swap: true, matrix: [0, 1, 1, 0, 0, 0] };
    case 6:
      return { swap: true, matrix: [0, 1, -1, 0, h, 0] };
    case 7:
      return { swap: true, matrix: [0, -1, -1, 0, h, w] };
    case 8:
      return { swap: true, matrix: [0, -1, 1, 0, 0, w] };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

/** 要丢掉的 JPEG 段：APP1=Exif+XMP，APP13=IPTC/Photoshop，COM=注释 */
const JPEG_DROP_MARKERS = new Map<number, string>([
  [0xe1, 'APP1(Exif/XMP)'],
  [0xed, 'APP13(IPTC)'],
  [0xfe, 'COM'],
]);

/** SOFn 里 FF C4 / C8 / CC 不是尺寸标记（分别是 DHT / JPG / DAC） */
const JPEG_SOF_EXCLUDED = new Set([0xc4, 0xc8, 0xcc]);

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8;
}

/** 遍历 JPEG 标记段，回调每个"内容段"（有长度字段的那些） */
function eachJpegSegment(
  buf: Buffer,
  visit: (marker: number, start: number, end: number, length: number) => 'continue' | 'stop',
): void {
  let i = 2; // 跳过 SOI
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) return; // 失同步：交给调用方按"解析失败"处理
    let marker = buf[i + 1];
    // 填充字节 FF FF ... FF <marker>
    let cursor = i;
    while (marker === 0xff && cursor + 2 < buf.length) {
      cursor += 1;
      marker = buf[cursor + 1];
    }
    i = cursor;

    // 无长度字段的独立标记
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    // SOS：其后的数据是熵编码流，不再遍历（长度字段存在但内容不是段结构）
    if (marker === 0xda) return;
    // EOI
    if (marker === 0xd9) return;

    if (i + 3 >= buf.length) return;
    const length = (buf[i + 2] << 8) | buf[i + 3];
    if (length < 2) return; // 长度字段本身占 2 字节，<2 一定是坏数据
    const start = i;
    const end = i + 2 + length;
    if (end > buf.length) return; // 截断：不再往下走

    if (visit(marker, start, end, length) === 'stop') return;
    i = end;
  }
}

function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let found: { width: number; height: number } | null = null;
  eachJpegSegment(buf, (marker, start, end) => {
    if (marker >= 0xc0 && marker <= 0xcf && !JPEG_SOF_EXCLUDED.has(marker)) {
      // SOFn 的数据段：precision(1) height(2) width(2) ...
      const height = (buf[start + 5] << 8) | buf[start + 6];
      const width = (buf[start + 7] << 8) | buf[start + 8];
      if (width > 0 && height > 0 && end >= start + 9) {
        found = { width, height };
        return 'stop';
      }
    }
    return 'continue';
  });
  return found;
}

function stripJpeg(buf: Buffer): StripResult {
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  const removed: string[] = [];
  let copiedTo = 2;

  eachJpegSegment(buf, (marker, start, _end) => {
    const drop = JPEG_DROP_MARKERS.get(marker);
    if (drop) {
      // 把"上一段结束 → 本段开始"之间的原始字节照抄（正常情况下为空）
      if (start > copiedTo) out.push(buf.subarray(copiedTo, start));
      removed.push(drop);
      copiedTo = _end;
    }
    return 'continue';
  });

  // 其余一切（含 SOS 之后的全部熵编码数据与 EOI）原样保留。
  // ⚠️ 这是本函数**最关键的取舍**：不从 SOS 之后重新拼装，
  //    只做"把中间某几段挖掉、其余整体拼接"，因此像素数据逐字节不变。
  if (copiedTo < buf.length) out.push(buf.subarray(copiedTo));

  return { data: Buffer.concat(out), removed };
}

function jpegMetadataMarkers(buf: Buffer): string[] {
  const hits: string[] = [];
  eachJpegSegment(buf, (marker) => {
    const name = JPEG_DROP_MARKERS.get(marker);
    if (name) hits.push(name);
    return 'continue';
  });
  return hits;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 要丢掉的 PNG 块。
 * ⚠️ 不含 `iCCP`（颜色配置）与 `gAMA`/`sRGB` —— 它们不是隐私载体，
 *    删掉会改变显示颜色。理由与保留 JPEG 的 APP2(ICC) 一致。
 */
const PNG_DROP_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** 遍历 PNG 块；回调 `type` 与块在缓冲区中的 [start,end)。返回 'stop' 即停止 */
function eachPngChunk(
  buf: Buffer,
  visit: (type: string, start: number, end: number) => 'continue' | 'stop',
): void {
  let i = 8;
  while (i + 8 <= buf.length) {
    const length = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + length; // 4(length)+4(type)+data+4(crc)
    if (end > buf.length) return; // 截断
    if (visit(type, i, end) === 'stop') return;
    if (type === 'IEND') return;
    i = end;
  }
}

function pngSize(buf: Buffer): { width: number; height: number } | null {
  let found: { width: number; height: number } | null = null;
  eachPngChunk(buf, (type, start) => {
    if (type !== 'IHDR') return 'stop';
    found = { width: buf.readUInt32BE(start + 8), height: buf.readUInt32BE(start + 12) };
    return 'stop';
  });
  return found;
}

function pngChunkTypes(buf: Buffer): string[] {
  const types: string[] = [];
  eachPngChunk(buf, (type) => {
    types.push(type);
    return 'continue';
  });
  return types;
}

function stripPng(buf: Buffer): StripResult {
  const out: Buffer[] = [PNG_SIGNATURE];
  const removed: string[] = [];

  eachPngChunk(buf, (type, start, end) => {
    if (PNG_DROP_CHUNKS.has(type)) {
      removed.push(`PNG:${type}`);
      return 'continue';
    }
    // ⚠️ 保留的块**连同它自己的 CRC 一起原样搬**：不动块内容就不需要重算 CRC。
    out.push(buf.subarray(start, end));
    return 'continue';
  });

  return { data: Buffer.concat(out), removed };
}

// ---------------------------------------------------------------------------
// WebP（RIFF 容器）
// ---------------------------------------------------------------------------

const WEBP_DROP_CHUNKS = new Set(['EXIF', 'XMP ']);

function isWebp(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  );
}

function eachWebpChunk(
  buf: Buffer,
  visit: (fourcc: string, start: number, end: number) => 'continue' | 'stop',
): void {
  let i = 12;
  while (i + 8 <= buf.length) {
    const fourcc = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    // RIFF 的块按偶数字节对齐：奇数长度后有一个填充字节（不计入 size）
    const end = i + 8 + size + (size % 2);
    if (end > buf.length) {
      // 末块被截断时按到文件尾处理，避免整个文件被判坏
      if (visit(fourcc, i, buf.length) === 'stop') return;
      return;
    }
    if (visit(fourcc, i, end) === 'stop') return;
    i = end;
  }
}

function webpChunkTypes(buf: Buffer): string[] {
  const types: string[] = [];
  eachWebpChunk(buf, (fourcc) => {
    types.push(fourcc);
    return 'continue';
  });
  return types;
}

function webpSize(buf: Buffer): { width: number; height: number } | null {
  let found: { width: number; height: number } | null = null;
  eachWebpChunk(buf, (fourcc, start) => {
    const data = start + 8;
    if (fourcc === 'VP8X' && data + 10 <= buf.length) {
      // canvas_width_minus_one / canvas_height_minus_one：24 位小端
      found = {
        width: 1 + (buf[data + 4] | (buf[data + 5] << 8) | (buf[data + 6] << 16)),
        height: 1 + (buf[data + 7] | (buf[data + 8] << 8) | (buf[data + 9] << 16)),
      };
      return 'stop';
    }
    if (fourcc === 'VP8 ' && data + 10 <= buf.length) {
      // 有损：3 字节 frame tag + 起始码 9D 01 2A，随后 14 位宽、14 位高
      found = {
        width: (buf[data + 6] | (buf[data + 7] << 8)) & 0x3fff,
        height: (buf[data + 8] | (buf[data + 9] << 8)) & 0x3fff,
      };
      return 'stop';
    }
    if (fourcc === 'VP8L' && data + 5 <= buf.length && buf[data] === 0x2f) {
      // 无损：1 字节签名 0x2F + 14 位宽-1 + 14 位高-1（跨字节位打包）
      const bits = buf[data + 1] | (buf[data + 2] << 8) | (buf[data + 3] << 16) | (buf[data + 4] << 24);
      found = {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      };
      return 'stop';
    }
    return 'continue';
  });
  return found;
}

function stripWebp(buf: Buffer): StripResult {
  const out: Buffer[] = [];
  const removed: string[] = [];
  const body: Buffer[] = [];

  eachWebpChunk(buf, (fourcc, start, end) => {
    if (WEBP_DROP_CHUNKS.has(fourcc)) {
      removed.push(`WEBP:${fourcc.trim()}`);
      return 'continue';
    }
    body.push(buf.subarray(start, end));
    return 'continue';
  });

  const payload = Buffer.concat(body);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  // ⚠️ RIFF 的长度字段必须重算 —— 剥离块后长度变小。
  //    忘了这一步的表现极坏：文件**能被嗅探器认出来**（前 12 字节没变），
  //    但解码器按声明的长度去读会读到垃圾或提前截断，属于"看起来成功、
  //    实际打不开"的一类。因此下面 `findMetadataTraces` 的离线断言里
  //    专门有一条检查 RIFF 长度与实际字节数一致。
  header.writeUInt32LE(payload.length + 4, 4);
  header.write('WEBP', 8, 'latin1');

  out.push(header, payload);
  return { data: Buffer.concat(out), removed };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 归一成 Buffer。Uint8Array / ArrayBuffer 都可能从不同调用点传进来，
 * 统一在这里处理，避免每个解析器各写一遍 `Buffer.from(x)`。
 */
function toBuffer(input: Uint8Array): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return Buffer.from(input as ArrayBufferLike as ArrayBuffer);
}

/** 供断言脚本引用：RIFF 声明的长度是否与真实字节数一致（WebP 剥离后必查） */
export function readRiffDeclaredSize(data: Uint8Array): number | null {
  const buf = toBuffer(data);
  if (!isWebp(buf)) return null;
  return buf.readUInt32LE(4);
}
