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
 * ⚠️ 为什么是**段级剥离**而不是「重新编码」
 * ---------------------------------------------------------------------------
 * 常规做法是 `sharp(buf).rotate().jpeg({quality}).toBuffer()`：解码→重编码，
 * EXIF 自然消失、还能顺便缩放。本项目**用不了**这条路：
 * 应用镜像 `nocobase/nocobase:2.2.15-full-no-nginx` 里**没有任何图像解码库**
 * （实测 `sharp` / `jimp` / `canvas` / `image-size` / `exifr` 全部 MISS），
 * 而本项目**没有 Dockerfile**（直接用官方镜像），装原生依赖需要改镜像构建链、
 * 且容器内访问 npm 受代理限制 —— 那是明确的范围外改动。
 *
 * 于是改为**不改动像素数据**的段级剥离：
 *   · JPEG —— 丢掉 APP1（Exif + XMP）、APP13（IPTC/Photoshop）、COM；
 *   · PNG  —— 丢掉 tEXt / zTXt / iTXt / eXIf / tIME 块；
 *   · WebP —— 丢掉 EXIF / XMP 块，并重算 RIFF 的长度字段。
 * 这三件事都不需要解码器：这些格式的元数据都躺在**独立的容器段**里，
 * 像素数据在 IDAT / SOS 之后原样保留。
 *
 * 由此带来两个**刻意的取舍**，必须如实记录而不是当成已完成：
 *   ① **不做缩放**：`.env` 里的 `UPLOAD_MAX_EDGE_PX` / `UPLOAD_JPEG_QUALITY`
 *      **本轮未生效**（无解码器）。降级已在 `docs/PHASE-5.md` 与本模块顶部标明。
 *      缓解手段是上传前的**字节数上限**（`visit.photo_max_size_mb`）+ 张数上限（6 张）。
 *   ② **不做像素级校验**：不检测"图片里是否还藏着别的载荷"（如 JPEG 尾部的附加数据）。
 *      本模块只承诺"元数据段已移除"，不承诺"文件内容已净化"。
 *      这也是为什么读取必须走**受控端点**并且响应头固定 `Content-Type` + `nosniff`
 *      （见 action 层的 photo handler）—— 只要不让浏览器把它当 HTML 解析，
 *      夹带内容就没有执行面。
 *   ③ 保留 APP0(JFIF) / APP2(ICC) / APP14(Adobe)：它们不是隐私载体，
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
