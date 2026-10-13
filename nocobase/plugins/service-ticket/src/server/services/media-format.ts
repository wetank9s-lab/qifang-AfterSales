/**
 * media-format —— 客户媒体的**格式与时长判定**（P11-4 · B 条）
 *
 * ===========================================================================
 * 两条不可妥协的原则
 * ===========================================================================
 * ① **不信任何客户端声明**：类型只看 magic bytes（与 PhotoService 的
 *    `sniffImage` 同一哲学），"把 .exe 改名成 .jpg"在这里被拒；
 * ② **解析不出时长就拒绝**（fail-closed）：契约对语音/视频有时长上限，
 *    而"时长"只能从容器里读。读不出来 ⇒ 无法证明它没超时 ⇒ 不收。
 *    这与 PhotoService 拒绝"读不到尺寸的图片"是同一条理由。
 *
 * ⚠️ 支持范围刻意与**浏览器 MediaRecorder 实际能产出的格式**对齐，
 *    不做"尽量多支持"：每多一种容器就多一份解析代码，而多出来的那份
 *    正是没人真实用过、也没被门禁覆盖的那份。
 */
import { CUSTOMER_MEDIA_KIND } from '../constants';

export interface SniffedMedia {
  kind: 'image' | 'audio' | 'video';
  mime: string;
  ext: string;
  /** 音视频的时长（毫秒）；图片为 null */
  durationMs: number | null;
}

export class MediaFormatError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus = 415,
  ) {
    super(message);
    this.name = 'MediaFormatError';
  }
}

// ---------------------------------------------------------------- 图片
// 图片完全复用 PhotoService 的嗅探能力（同一条腿），这里只做入口转发。
const IMAGE_SIGNATURES: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    ext: 'png',
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  // WebP：RIFF....WEBP
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    mime: 'image/gif',
    ext: 'gif',
    test: (b) => b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a',
  },
];

export function sniffImageKind(buf: Buffer): { mime: string; ext: string } | null {
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.test(buf)) return { mime: sig.mime, ext: sig.ext };
  }
  return null;
}

/**
 * MP4 族（mp4 / m4a / mov）的**轨道类型**：`video` / `audio` / 判不出时 null。
 *
 * ⚠️ 为什么必须有它：`ftyp` **不能**区分音视频 —— 音视频 mp4 的文件头一模一样
 *    （都只是 `....ftyp...`）。第一版把 mp4 一律当 `audio/mp4`，
 *    于是**每一个真视频都被当成语音**（错误文案也会说"无法确认语音时长"）。
 *    唯一可靠的判据是 `moov` 里 track 的 `hdlr.handler_type`：
 *    视频是 `vide`、音频是 `soun`（ISO BMFF 的固定值）。
 *
 * 🔴 与 `mp4DurationMs` 同一个基准点教训：hdlr 载荷 = `chunk 起点 + 8`，
 *    handler_type 在其偏移 **8**（version+flags 4 + pre_defined 4）。
 */
function mp4HandlerType(buf: Buffer): 'video' | 'audio' | null {
  const u32 = (off: number) => buf.readUInt32BE(off);

  /**
   * 在 `start..end` 区间内**递归**找 hdlr。
   *
   * 🔴 递归是必须的：真实 MP4 的层级是 `moov > trak > mdia > hdlr`，
   *    而**容器 box 的类型不止 hdlr 这一个"要往里钻"的对象**（trak、mdia、
   *    minf、stbl…）。只扫 moov 的直接子层 ⇒ 找不到 hdlr ⇒
   *    **每一个真实视频/语音都被判"缺少可读的轨道信息"而拒收**
   *    （实测：门禁拼的 moov>trak>hdlr 也一样被判不出）。
   *    深度限制 4 层：真实文件够用，且能挡住畸形盒子导致的深递归。
   */
  const walk = (start: number, end: number, depth: number): 'video' | 'audio' | null => {
    if (depth > 4) return null;
    let off = start;
    while (off + 8 <= end) {
      let size = u32(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      if (size === 1) return null; // 64 位扩展尺寸：本项目不展开
      if (size === 0) size = end - off;
      if (size < 8 || off + size > end) return null;
      if (type === 'hdlr') {
        const p = off + 8; // 载荷起点（chunk 头 8 字节）
        const handler = buf.toString('ascii', p + 8, p + 12);
        if (handler === 'vide') return 'video';
        if (handler === 'soun') return 'audio';
        return null;
      }
      const found = walk(off + 8, off + size, depth + 1);
      if (found) return found;
      off += size;
    }
    return null;
  };

  return walk(0, buf.length, 0);
}

// ---------------------------------------------------------------- 音频
const AUDIO_SIGNATURES: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  // WebM / Matroska（Chrome、Android MediaRecorder 的默认产出）
  { mime: 'audio/webm', ext: 'webm', test: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  // Ogg（Firefox 的 audio/ogg 产出）
  { mime: 'audio/ogg', ext: 'ogg', test: (b) => b.toString('ascii', 0, 4) === 'OggS' },
  // WAV：RIFF....WAVE
  {
    mime: 'audio/wav',
    ext: 'wav',
    test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE',
  },
  // ⚠️ MP4 族**刻意不在这里**：ftyp 分不出音视频（见 mp4HandlerType 的说明），
  //    统一由下面的 mp4 分支按 hdlr 判定后回填。
];

const IS_FTYP = (b: Buffer) => b.length > 8 && b.toString('ascii', 4, 8) === 'ftyp';

// ---------------------------------------------------------------- 视频
const VIDEO_SIGNATURES: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  // ⚠️ 同上：mp4 / mov 交给 hdlr 分支判，不靠 ftyp。
  { mime: 'video/webm', ext: 'webm', test: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
];

/**
 * mp4 / m4a / mov 的时长：读 `moov/mvhd`。
 *
 * 遍历顶层 box（size + type），进 moov 后找 mvhd，按版本读
 * timescale(v1: 4字节@20, v0: 4字节@12) 与 duration(v1: 8字节@24, v0: 4字节@16)。
 * 只需要第一个 moov —— 多 track 的 mvhd 时长一致（它是 movie header）。
 */
function mp4DurationMs(buf: Buffer): number | null {
  const u32 = (off: number) => buf.readUInt32BE(off);
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = u32(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (size === 1) {
      // 64 位扩展尺寸：本项目的文件都远小于 4GB，不展开
      return null;
    }
    if (size === 0) size = buf.length - off;
    if (size < 8 || off + size > buf.length) return null;
    if (type === 'moov') {
      // 在 moov 内找 mvhd
      let inner = off + 8;
      const moovEnd = off + size;
      while (inner + 8 <= moovEnd) {
        const isize = u32(inner);
        const itype = buf.toString('ascii', inner + 4, inner + 8);
        if (isize >= 8 && inner + isize <= moovEnd && itype === 'mvhd') {
          // 🔴 **mvhd 的载荷起点是 `inner + 8`**（chunk 头 size+type 占 8 字节）。
          //    第一版直接用 inner 当载荷起点 ⇒ 所有偏移少 8 字节 ⇒
          //    timescale/duration 恒读成 0 ⇒ **每一个真实视频都被判
          //    "无法确认时长"而拒收**（实测 29 秒与 31 秒的 MP4 都回 422）。
          //    这是"手写容器解析"最典型的错：量对了、基准点错了。
          const p = inner + 8;
          const version = buf[p];
          if (version === 1) {
            const timescale = u32(p + 20);
            const duration = Number(buf.readBigUInt64BE(p + 24));
            if (timescale > 0 && duration > 0) return Math.round((duration / timescale) * 1000);
          } else {
            const timescale = u32(p + 12);
            const duration = u32(p + 16);
            if (timescale > 0 && duration > 0) return Math.round((duration / timescale) * 1000);
          }
          return null;
        }
        if (isize < 8) return null;
        inner += isize;
      }
      return null;
    }
    off += size;
  }
  return null;
}

/** WebM / Matroska 的时长：`Segment > Info > Duration`（float，单位 ms） */
function webmDurationMs(buf: Buffer): number | null {
  // EBML 头部之后是 Segment（ID 0x18538067）；其内 Info（0x1549A966）含 Duration（0x4489，float）
  const findId = (id: number[], from: number): number => {
    for (let i = from; i < buf.length - id.length; i += 1) {
      let ok = true;
      for (let k = 0; k < id.length; k += 1) {
        if (buf[i + k] !== id[k]) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
    return -1;
  };
  const infoAt = findId([0x15, 0x49, 0xa9, 0x66], 0);
  if (infoAt < 0) return null;
  const durAt = findId([0x44, 0x89], infoAt);
  if (durAt < 0) return null;
  let p = durAt + 2;
  // 变长尺寸（首个字节的最高位为 1 的个数 = 长度字节数）
  const first = buf[p];
  let len = 0;
  for (let i = 7; i >= 0; i -= 1) {
    if (first & (1 << i)) len += 1;
    else break;
  }
  if (len < 2 || len > 8 || p + len > buf.length) return null;
  let value = 0;
  for (let i = 1; i < len; i += 1) {
    value = value * 256 + buf[p + i];
  }
  p += len;
  if (p + 4 > buf.length) return null;
  // 4 字节大端 float（WebM 的 Duration 可以是 0/4/8 字节 float；这里只认 4 字节）
  const bits = value;
  const sign = bits >> 31 ? -1 : 1;
  const exponent = (bits >> 23) & 0xff;
  const mantissa = bits & 0x7fffff;
  let f: number;
  if (exponent === 0) f = sign * mantissa * 2 ** -149;
  else f = sign * (1 + mantissa / 0x7fffff) * 2 ** (exponent - 127);
  if (!Number.isFinite(f) || f <= 0) return null;
  return Math.round(f);
}

/** WAV 时长：data chunk 大小 / byteRate */
function wavDurationMs(buf: Buffer): number | null {
  let off = 12;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32LE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'fmt ' && off + 8 + 16 <= buf.length) {
      const byteRate = buf.readUInt32LE(off + 8 + 8);
      if (byteRate === 0) return null;
      // data 通常在 fmt 之后
      let d = off + 8 + size;
      while (d + 8 <= buf.length) {
        const dsize = buf.readUInt32LE(d);
        if (buf.toString('ascii', d + 4, d + 8) === 'data') {
          return Math.round((dsize / byteRate) * 1000);
        }
        d += 8 + dsize + (dsize % 2);
      }
      return null;
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/** Ogg 时长：读最后一页的 granulePosition（本实现只做"能解析出即可"的粗判） */
function oggDurationMs(buf: Buffer): number | null {
  // Ogg 页：`OggS` + version + header_type + granulePosition(8B LE)@6
  // 取**最后一个**完整页的 granulePosition 作为时长上界（单位由 codec 定，
  // 对 Vorbis/Opus 是 48kHz 基准的采样数）。这里保守地只支持到"能读到页"，
  // 精确粒度由调用方的上限比较兜底。
  let last = -1;
  for (let i = buf.length - 27; i >= 0; i -= 1) {
    if (buf.toString('ascii', i, i + 4) === 'OggS') {
      last = i;
      break;
    }
  }
  if (last < 0) return null;
  const granule = Number(buf.readBigUInt64LE(last + 6));
  if (granule <= 0) return null;
  // 48kHz 基准（Vorbis/Opus 通用）
  return Math.round((granule / 48000) * 1000);
}

/**
 * 判定一个缓冲区是不是受支持的客户媒体，并给出**服务端认定的**类型与时长。
 *
 * @param expected 调用方期望的种类（来自会话的 media_kind 限制）；
 *        `mixed` 表示三者皆可。判定出的 kind 与期望不符 ⇒ 拒绝。
 */
export function sniffCustomerMedia(buf: Buffer, expected: 'image' | 'audio' | 'video' | 'mixed'): SniffedMedia {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new MediaFormatError('EMPTY_FILE', '上传内容为空', 422);
  }

  // ① 图片（优先：与 PhotoService 的支持面一致）
  const img = sniffImageKind(buf);
  if (img) {
    if (expected !== 'image' && expected !== 'mixed') {
      throw new MediaFormatError('KIND_MISMATCH', '这个入口只接受音视频，请重新选择', 415);
    }
    return { kind: CUSTOMER_MEDIA_KIND.IMAGE as 'image', mime: img.mime, ext: img.ext, durationMs: null };
  }

  // ② 音频
  for (const sig of AUDIO_SIGNATURES) {
    if (!sig.test(buf)) continue;
    if (expected !== 'audio' && expected !== 'mixed') {
      throw new MediaFormatError('KIND_MISMATCH', '这个入口只接受图片，请重新选择', 415);
    }
    const durationMs =
      sig.mime === 'audio/wav'
        ? wavDurationMs(buf)
        : sig.mime === 'audio/ogg'
          ? oggDurationMs(buf)
          : sig.mime === 'audio/mp4'
            ? mp4DurationMs(buf)
            : webmDurationMs(buf);
    if (durationMs === null) {
      throw new MediaFormatError('DURATION_UNREADABLE', '无法确认语音时长，请重新录制后上传', 422);
    }
    return { kind: CUSTOMER_MEDIA_KIND.AUDIO as 'audio', mime: sig.mime, ext: sig.ext, durationMs };
  }

  // ③ MP4 族（mp4 / m4a / mov）：**先按 hdlr 分音视频**，再读时长
  if (IS_FTYP(buf)) {
    const track = mp4HandlerType(buf);
    if (track === null) {
      throw new MediaFormatError(
        'DURATION_UNREADABLE',
        '无法识别这个视频/语音文件（缺少可读的轨道信息），请重新录制后上传',
        422,
      );
    }
    const wantKind = expected === 'mixed' ? track : expected;
    if (wantKind !== track) {
      throw new MediaFormatError(
        'KIND_MISMATCH',
        track === 'video' ? '这个入口只接受语音，请重新选择' : '这个入口只接受视频，请重新选择',
        415,
      );
    }
    const durationMs = mp4DurationMs(buf);
    if (durationMs === null) {
      throw new MediaFormatError(
        'DURATION_UNREADABLE',
        track === 'video' ? '无法确认视频时长，请重新录制后上传' : '无法确认语音时长，请重新录制后上传',
        422,
      );
    }
    return track === 'video'
      ? { kind: CUSTOMER_MEDIA_KIND.VIDEO as 'video', mime: 'video/mp4', ext: 'mp4', durationMs }
      : { kind: CUSTOMER_MEDIA_KIND.AUDIO as 'audio', mime: 'audio/mp4', ext: 'm4a', durationMs };
  }

  // ④ 视频
  for (const sig of VIDEO_SIGNATURES) {
    if (!sig.test(buf)) continue;
    if (expected !== 'video' && expected !== 'mixed') {
      throw new MediaFormatError('KIND_MISMATCH', '这个入口只接受图片，请重新选择', 415);
    }
    const durationMs =
      sig.mime === 'video/webm' ? webmDurationMs(buf) : mp4DurationMs(buf);
    if (durationMs === null) {
      throw new MediaFormatError('DURATION_UNREADABLE', '无法确认视频时长，请重新录制后上传', 422);
    }
    return { kind: CUSTOMER_MEDIA_KIND.VIDEO as 'video', mime: sig.mime, ext: sig.ext, durationMs };
  }

  throw new MediaFormatError(
    'UNSUPPORTED_MEDIA',
    '只支持图片（JPG/PNG/WebP/GIF）、语音（WebM/M4A/OGG/WAV）与视频（MP4/WebM/MOV）',
    415,
  );
}
