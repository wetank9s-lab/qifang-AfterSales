/**
 * `banner-store` —— 客户报修页 Banner 的**独立公开图片存储**（B-36）
 *
 * =============================================================================
 * 为什么必须"独立"，而不复用任何既有媒体通道
 * =============================================================================
 *   本工程既有的图片通道**全部**是**按工单私有**的（`UPLOAD_PRIVATE_DIR` +
 *   会话/进度 Token + `private, no-store`），那是因为客户上传的照片里
 *   可能有家庭住址、门牌。Banner 是**平台自己上传的品牌图**，
 *   授权模型正好相反：人人可看、鼓励缓存。
 *
 *   ⇒ 把两者混在一条通道上，任何一方让步都会伤到另一方：
 *     放宽 `publicMedia` = 客户隐私泄露；把 Banner 塞进私有目录 = 客户看不到。
 *     所以这里开**第二条腿**，且这条腿**只服务 Banner**。
 *
 * =============================================================================
 * 这条公开路径的四条自我保护（缺一条都会变成隐患）
 * =============================================================================
 *   ① **只允许"已发布"的读取**：公开目录里的文件名带内容指纹，
 *      但**文件名本身不是权限** —— 公开读接口每次都查库确认
 *      `status='PUBLISHED' AND revoked_at IS NULL`。下架后即使有人知道 URL 也拿不到。
 *   ② **只允许被动图片**：`sniffImageKind()` 只认 JPEG/PNG/WebP 的 magic bytes。
 *      **拒绝 SVG**（SVG 能内嵌 `<script>`，是 XSS 的经典载体）、
 *      拒绝 HTML、拒绝一切声明与实际不符的文件（不看扩展名、不看 Content-Type）。
 *   ③ **文件名即路径**：服务端只用**自己生成的**文件名（sha256 前 16 位 + 白名单扩展名），
 *      绝不使用客户端传来的名字 ⇒ 没有路径穿越、没有特殊字符。
 *   ④ **尺寸上限**：单图 ≤ 2 MB（横幅不需要更大），超限直接 413。
 *
 * ⚠️ 本服务**不读** `UPLOAD_PRIVATE_DIR`，也不向其写任何东西。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sniffImageKind } from './media-format';

/** 公开 Banner 目录的默认位置（容器内）。可用 `UPLOAD_BANNER_DIR` 覆盖。 */
const DEFAULT_BANNER_DIR = '/app/nocobase/storage/uploads-banner';

/** 单图字节上限：横幅用途，2 MB 足够，且能挡住"用 Banner 当网盘" */
export const BANNER_MAX_BYTES = 2 * 1024 * 1024;

/** 允许的 MIME（sniffImageKind 的子集：**去掉 GIF** —— 动图不是横幅需求，且无必要） */
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** 横幅比例校验：太窄/太极端的图放进横幅会拉坏版面 */
const MIN_WIDTH = 320;
const MAX_WIDTH = 4096;
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 2048;
const MAX_ASPECT = 8; // 宽/高 上限（超过就是"细长条"，多半传错图了）

export class BannerFormatError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus = 415,
  ) {
    super(message);
    this.name = 'BannerFormatError';
  }
}

export interface StoredBanner {
  fileName: string;
  storageKey: string;
  mime: string;
  byteSize: number;
  contentHash: string;
  width: number | null;
  height: number | null;
  /** 是否复用了同内容的既有文件（幂等表现） */
  reused: boolean;
}

export interface BannerStoreOptions {
  /** 公开 Banner 根目录（.env 的 UPLOAD_BANNER_DIR） */
  bannerDir?: string;
  maxBytes?: number;
  logger?: any;
}

/**
 * 从图片字节里读出**尺寸**。
 *
 * 只实现 Banner 会用到的三种格式，且只读头部 —— 不需要完整解码器：
 *   · PNG：IHDR 固定在第 16 字节起（8 字节签名 + 4 长度 + 4 类型）
 *   · JPEG：扫 SOFn 段
 *   · WebP：VP8X / VP8L / VP8 三种子格式
 * 读不出尺寸**不是**致命错误（返回 null），但格式识别失败是。
 */
function readImageSize(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png') {
      if (buf.length < 24) return null;
      // 校验 IHDR 段存在，避免把非 PNG 误读
      if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/jpeg') {
      let off = 2; // 跳过 FFD8
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) {
          off += 1;
          continue;
        }
        const marker = buf[off + 1];
        // SOF0..SOF15（排除 DHT=C4 / JPG=C8 / DAC=CC）
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
          off += 2;
          continue;
        }
        const segLen = buf.readUInt16BE(off + 2);
        if (segLen < 2) return null;
        off += 2 + segLen;
      }
      return null;
    }
    if (mime === 'image/webp') {
      if (buf.length < 30) return null;
      const fourCC = buf.toString('ascii', 12, 16);
      if (fourCC === 'VP8X') {
        const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { width: w, height: h };
      }
      if (fourCC === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (fourCC === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

export class BannerStore {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly logger: any;

  constructor(options: BannerStoreOptions = {}) {
    this.root = options.bannerDir ?? process.env.UPLOAD_BANNER_DIR ?? DEFAULT_BANNER_DIR;
    this.maxBytes = options.maxBytes ?? BANNER_MAX_BYTES;
    this.logger = options.logger;
  }

  /** 公开目录路径（诊断用；不对外暴露） */
  get bannerDir(): string {
    return this.root;
  }

  /** 目录必须存在且可写 —— 启动时可自检 */
  ensureDir(): void {
    fs.mkdirSync(this.root, { recursive: true });
  }

  /**
   * 解析公开目录内的绝对路径，**拒绝任何逃逸尝试**。
   * 与 `MediaStoreService.resolveInsideRoot` 同一套判据（同一条腿）。
   */
  resolveInsideRoot(fileName: string): string {
    const root = path.resolve(this.root);
    const abs = path.resolve(root, fileName);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new BannerFormatError('BANNER_PATH_ESCAPE', '存储路径不合法', 500);
    }
    return abs;
  }

  /**
   * 校验并保存一张 Banner 图片。
   *
   * 输入是**原始字节**；本函数负责把"不可信字节"变成"可信的已存文件"：
   * 嗅探 → 尺寸校验 → 算指纹 → 生成文件名 → 落盘 → 返回元数据。
   *
   * ⚠️ 幂等：同内容重复上传**不重复落盘**（指纹相同即复用），
   *    返回 `reused: true`，由调用方决定是复用既有行还是新建。
   */
  async save(input: {
    buffer: Buffer;
    declaredMime?: string | null;
    originalName?: string | null;
  }): Promise<StoredBanner> {
    const buf = input.buffer;
    if (!buf || buf.length === 0) {
      throw new BannerFormatError('BANNER_EMPTY', '上传内容为空', 400);
    }
    if (buf.length > this.maxBytes) {
      throw new BannerFormatError(
        'BANNER_TOO_LARGE',
        `Banner 图片不能超过 ${Math.floor(this.maxBytes / 1024 / 1024)}MB（当前 ${(buf.length / 1024 / 1024).toFixed(1)}MB）`,
        413,
      );
    }

    // ① magic bytes 判定 —— **不看扩展名、不看 Content-Type**
    const sniffed = sniffImageKind(buf);
    if (!sniffed) {
      // 这里同时挡住 SVG 与 HTML：它们没有图片 magic，sniffImageKind 返回 null。
      // 错误文案刻意**不**说"可能是 SVG"，避免给攻击者反馈。
      throw new BannerFormatError(
        'BANNER_NOT_IMAGE',
        '只支持 JPG / PNG / WebP 图片（请确认文件确实是图片格式）',
        415,
      );
    }
    if (!ALLOWED_MIME.has(sniffed.mime)) {
      throw new BannerFormatError('BANNER_MIME_REJECTED', `不支持的图片格式：${sniffed.mime}`, 415);
    }

    // ② 尺寸与比例
    const size = readImageSize(buf, sniffed.mime);
    if (size) {
      const { width, height } = size;
      if (width < MIN_WIDTH || height < MIN_HEIGHT) {
        throw new BannerFormatError(
          'BANNER_TOO_SMALL',
          `图片太小（${width}×${height}），横幅至少 ${MIN_WIDTH}×${MIN_HEIGHT} 像素`,
          422,
        );
      }
      if (width > MAX_WIDTH || height > MAX_HEIGHT) {
        throw new BannerFormatError(
          'BANNER_TOO_LARGE_DIMENSION',
          `图片尺寸过大（${width}×${height}），最大 ${MAX_WIDTH}×${MAX_HEIGHT} 像素`,
          422,
        );
      }
      if (width / height > MAX_ASPECT) {
        throw new BannerFormatError(
          'BANNER_ASPECT_REJECTED',
          `图片过窄（${width}×${height}），宽高比不应超过 ${MAX_ASPECT}:1`,
          422,
        );
      }
    }

    // ③ 内容指纹 → 文件名（客户端提供的名字**一律丢弃**）
    const contentHash = crypto.createHash('sha256').update(buf).digest('hex');
    const fileName = `banner-${contentHash.slice(0, 16)}.${sniffed.ext}`;
    const abs = this.resolveInsideRoot(fileName);

    if (fs.existsSync(abs)) {
      return {
        fileName,
        storageKey: fileName,
        mime: sniffed.mime,
        byteSize: buf.length,
        contentHash,
        width: size?.width ?? null,
        height: size?.height ?? null,
        reused: true,
      };
    }

    this.ensureDir();
    // 先写临时文件再 rename：避免读到"写了一半"的图（rename 在同文件系统内是原子的）
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, buf, { mode: 0o644 });
    fs.renameSync(tmp, abs);

    return {
      fileName,
      storageKey: fileName,
      mime: sniffed.mime,
      byteSize: buf.length,
      contentHash,
      width: size?.width ?? null,
      height: size?.height ?? null,
      reused: false,
    };
  }

  /** 读一个已存在的 Banner 文件；不存在返回 null */
  async read(fileName: string): Promise<{ absPath: string; mime: string; size: number } | null> {
    let abs: string;
    try {
      abs = this.resolveInsideRoot(fileName);
    } catch {
      return null;
    }
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return null;
      const mime = sniffImageKind(fs.readFileSync(abs, { flag: 'r' }).subarray(0, 16))?.mime ?? null;
      if (!mime || !ALLOWED_MIME.has(mime)) return null;
      return { absPath: abs, mime, size: st.size };
    } catch {
      return null;
    }
  }

  /** 删除一个 Banner 文件（下架且无人引用时由调用方决定是否调用） */
  async remove(fileName: string): Promise<boolean> {
    try {
      const abs = this.resolveInsideRoot(fileName);
      if (!fs.existsSync(abs)) return false;
      fs.unlinkSync(abs);
      return true;
    } catch (error) {
      this.logger?.warn?.(`[banner-store] 删除失败 ${fileName}: ${String((error as Error)?.message)}`);
      return false;
    }
  }
}
