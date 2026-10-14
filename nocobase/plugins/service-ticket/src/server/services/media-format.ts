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

/**
 * ===========================================================================
 * webm / Matroska：**按 EBML 规范解析元素树**（不是字节搜索）
 * ===========================================================================
 * 🔴 这一段的由来（P11-4 第三批 · DEV-183）：
 *    上一版用"在字节流里搜 ID"的方式找 TrackType（0x83），并由此得出
 *    "真实 MediaRecorder 产物里没有 Tracks"的结论 —— **那个结论是错的**。
 *
 *    用独立工具（`scripts/ebml-probe.py`，按 EBML 规范解析元素树）复核真实产物：
 *      · `audio-chrome.webm`（Chromium 录音 3 秒）：Tracks @195，**TrackType = [2]**
 *      · `video-chrome.webm`（Chromium 录像 3 秒）：Tracks @195，**TrackType = [2, 1]**
 *        （录像有 **2 条轨道**：音频 + 视频）
 *    ⇒ 真实文件**有** Tracks 与 TrackType。上一版之所以"找不到"，
 *      是因为**字节搜索命中了 SeekHead 里的 SeekID**（那是对元素 ID 的**引用**，
 *      恰好也是 0x1654AE6B），从那里往后找 0x83 自然命中了 Info 的 MuxingApp。
 *
 *    教训：**"在字节流里找 ID"不是解析**。ID 会出现在引用、Cues、甚至码流里；
 *    只有按规范走元素树才能判断"这个 ID 属于哪个父元素"。
 *
 * 🔴 资源限制（用户要求"具备资源限制的探测"）：
 *    · 调用方已按 `CUSTOMER_MEDIA.MAX_FILE_BYTES`（8MB）限过大小；
 *    · 这里再限**遍历预算**（元素数 / 深度 / 单次跳过长度），
 *      保证畸形文件不会让解析退化成 CPU 炸弹。
 */
const EBML_ID = {
  SEGMENT: [0x18, 0x53, 0x80, 0x67],
  INFO: [0x15, 0x49, 0xa9, 0x66],
  TRACKS: [0x16, 0x54, 0xae, 0x6b],
  TRACK_ENTRY: [0xae],
  TRACK_TYPE: [0x83],
  DURATION: [0x44, 0x89],
} as const;

/** EBML 的 master（容器）元素 ID —— 只有这些需要递归下钻 */
const EBML_MASTER_IDS = new Set([
  0x1a45dfa3, // EBML（头）
  0x18538067, // Segment
  0x114d9b74, // SeekHead
  0x4dbb, // Seek
  0x1549a966, // Info
  0x1654ae6b, // Tracks
  0xae, // TrackEntry
  0x1f43b675, // Cluster
  0x1c53bb6b, // Cues
  0xbb, // CuePoint
  0x53b8, // CueTrackPositions
  0xa0, // BlockGroup
]);

interface EbmlWalkBudget {
  elements: number;
  maxElements: number;
}

/**
 * 读一个 EBML 变长整数（VINT）。
 *
 * @param keepMarker `true` = 读**元素 ID**（保留标记位，因为 ID 就是原样字节）；
 *                   `false` = 读**尺寸**（去掉标记位，剩下的才是数值）。
 *
 * ⚠️ `value` 对 8 字节形式会超出 JS 安全整数（`2^56`）。**不要用它做等值判断**
 *    （未知长度请用 `isUnknownEbmlSize`）——第一版就是在这里丢精度，
 *    把"长度未知的 Segment"当成了一个超大尺寸 ⇒ 判越界 ⇒ 整个解析在 Segment 处停住，
 *    于是真实录音的视频/音频类别全都读不出来（DEV-184）。
 */
function readEbmlVint(buf: Buffer, pos: number, keepMarker: boolean): { value: number; length: number } | null {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  if (first === 0) return null;
  let length = 0;
  for (let i = 0; i < 8; i += 1) {
    if (first & (0x80 >> i)) {
      length = i + 1;
      break;
    }
  }
  if (length === 0 || pos + length > buf.length) return null;
  let value = keepMarker ? 0 : first & (0xff >> length);
  for (let i = keepMarker ? 0 : 1; i < length; i += 1) {
    value = value * 256 + buf[pos + i];
  }
  return { value, length };
}

/**
 * `[pos, pos+length)` 是不是 EBML 的**未知长度**编码（数据位全 1）。
 *
 * ⚠️ 逐**字节**比较而不是算数值：8 字节形式（`01 FF FF FF FF FF FF FF`）
 *    的值远超 `Number.MAX_SAFE_INTEGER`，用等值判断必然失败。
 */
function isUnknownEbmlSize(buf: Buffer, pos: number, length: number): boolean {
  if (pos + length > buf.length) return false;
  if ((buf[pos] & (0xff >> length)) !== 0) return false;
  for (let i = 1; i < length; i += 1) {
    if (buf[pos + i] !== 0xff) return false;
  }
  return true;
}

/** EBML 无符号整数（值按字节读，**不是** VINT —— 例如 TrackType 的值就是 1 字节） */
function readEbmlUint(buf: Buffer, pos: number, end: number): number | null {
  if (end <= pos || end - pos > 8 || end > buf.length) return null;
  let v = 0;
  for (let i = pos; i < end; i += 1) v = v * 256 + buf[i];
  return v;
}

/**
 * 按规范遍历 EBML 元素，收集 `TrackType` 与 `Duration`。
 *
 * ⚠️ 必须处理**未知长度**（MediaRecorder 的 streaming 输出会用它：
 *    尺寸字节的数据位全 1，例如 `0x01FFFFFFFFFFFFFF`）——
 *    第一版把"未知长度"当成超大尺寸，于是直接判越界返回。
 */
function walkEbml(
  buf: Buffer,
  start: number,
  end: number,
  depth: number,
  budget: EbmlWalkBudget,
  found: { trackTypes: number[]; duration: number | null; sawTracks: boolean },
): void {
  let pos = start;
  while (pos < end) {
    if (budget.elements >= budget.maxElements) return;
    budget.elements += 1;

    const idRead = readEbmlVint(buf, pos, true);
    if (!idRead) return;
    const sizeRead = readEbmlVint(buf, pos + idRead.length, false);
    if (!sizeRead) return;

    const id = idRead.value;
    const payloadAt = pos + idRead.length + sizeRead.length;
    // "尺寸的数据位全 1" = 未知长度（流式写出的 Segment 常用它）
    const unknownLen = isUnknownEbmlSize(buf, pos + idRead.length, sizeRead.length);
    const payloadEnd = unknownLen ? end : payloadAt + sizeRead.value;
    if (payloadEnd > end || payloadEnd < payloadAt) return;

    if (id === 0x83) {
      // 🔴 TrackType 的值是**无符号整数**（1 = video，2 = audio），不是 VINT。
      //    第一版按 VINT 读 ⇒ 值 `0x02`（二进制 10）被当成"7 字节 VINT" ⇒ 越界 ⇒ 丢掉。
      const v = readEbmlUint(buf, payloadAt, payloadEnd);
      if (v !== null) found.trackTypes.push(v);
    } else if (id === 0x4489) {
      // Duration 是 float（宽度由 payload 长度决定，**大端**）
      const width = payloadEnd - payloadAt;
      if (width === 4) found.duration = buf.readFloatBE(payloadAt);
      else if (width === 8) found.duration = buf.readDoubleBE(payloadAt);
    } else if (id === 0x1654ae6b) {
      found.sawTracks = true;
    }

    // ⚠️ **跳过 Cluster**：里面是成百上千个 SimpleBlock（纯码流），
    //    而 Tracks 与 Duration 都在它**之前**。递归它纯属浪费（也是拒绝服务面）。
    //
    //    🔴 但**不能**用"收集够了就 return"来省事：录像有**多条轨道**
    //    （实测 TrackType = [2, 1]：音频 + 视频），读到第一条就返回会漏掉视频轨
    //    ⇒ 整段录像被判成 audio（DEV-185）。
    if (id === 0x1f43b675) {
      // Cluster：只记账，不下钻
    } else if (depth < 6 && EBML_MASTER_IDS.has(id)) {
      walkEbml(buf, payloadAt, payloadEnd, depth + 1, budget, found);
    }

    if (unknownLen) return; // 未知长度的容器吃掉了剩余区间
    if (sizeRead.value === 0) return; // 防御：零长度但不前进会死循环
    pos = payloadEnd;
  }
}

/** 解析一次（结果缓存由调用方负责，避免重复遍历） */
function probeWebm(buf: Buffer): { trackTypes: number[]; duration: number | null; sawTracks: boolean } {
  const found = { trackTypes: [] as number[], duration: null as number | null, sawTracks: false };
  walkEbml(buf, 0, buf.length, 0, { elements: 0, maxElements: 20_000 }, found);
  return found;
}

let webmProbeCache: { buf: Buffer; result: ReturnType<typeof probeWebm> } | null = null;
function probeWebmCached(buf: Buffer) {
  if (webmProbeCache && webmProbeCache.buf === buf) return webmProbeCache.result;
  const result = probeWebm(buf);
  webmProbeCache = { buf, result };
  return result;
}

/**
 * 容器**结构摘要**（只用于诊断，**绝不含客户内容**）。
 *
 * 输出的是"这个文件由哪些 box / 元素组成、时长字段的值是多少"，
 * 例如：`ftyp|moov(mvhd v1 ts=1000 dur=0)|mvex(mehd 2453)|moof|mdat`。
 *
 * 🔴 为什么必须有它（P11-4 · DEV-191）：
 *    真机上报"本地能试听、服务端读不出时长"时，如果日志只有 `DURATION_UNREADABLE`，
 *    就只能靠猜 —— 而猜错的代价是让客户"重新录制"却依然失败（iOS Safari 实测如此）。
 *    有了结构摘要，下一次复测的日志会**直接指出**时长字段到底在哪、值是多少。
 *
 * ⚠️ 隐私边界：只读结构字段（box 类型、timescale、duration、track 类型），
 *    **不读、不记录任何媒体采样数据或文本内容**；字节只取前 12 字节 magic。
 */
export function summariseContainerStructure(buf: Buffer): string {
  const head = buf.subarray(0, 12).toString('hex');
  const parts: string[] = [`head=${head}`];

  // ---- ISO-BMFF（mp4 / mov / m4a）----
  if (buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const u32 = (o: number) => buf.readUInt32BE(o);
    const walk = (start: number, end: number, depth: number, label: string) => {
      let off = start;
      let guard = 0;
      while (off + 8 <= end && guard < 64) {
        guard += 1;
        let size = u32(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        let header = 8;
        if (size === 1) {
          if (off + 16 > end) break;
          size = Number(buf.readBigUInt64BE(off + 8));
          header = 16;
        } else if (size === 0) {
          size = end - off;
        }
        if (size < header || off + size > end) break;
        const payload = off + header;
        const payloadEnd = off + size;
        let detail = '';
        if (type === 'mvhd' || type === 'mdhd') {
          const version = buf[payload];
          if (version === 1 && payload + 32 <= payloadEnd) {
            detail = ` v1 ts=${u32(payload + 20)} dur=${Number(buf.readBigUInt64BE(payload + 24))}`;
          } else if (payload + 20 <= payloadEnd) {
            detail = ` v0 ts=${u32(payload + 12)} dur=${u32(payload + 16)}`;
          }
        } else if (type === 'mehd') {
          const version = buf[payload];
          const dur = version === 1 && payload + 12 <= payloadEnd ? Number(buf.readBigUInt64BE(payload + 4)) : payload + 8 <= payloadEnd ? u32(payload + 4) : -1;
          detail = ` fragment_duration=${dur}`;
        } else if (type === 'hdlr' && payload + 12 <= payloadEnd) {
          detail = ` handler=${buf.toString('ascii', payload + 8, payload + 12)}`;
        }
        parts.push(`${label}${type}${detail}`);
        if (['moov', 'trak', 'mdia', 'mvex', 'moof', 'traf', 'stbl'].includes(type) && depth < 4) {
          walk(payload, payloadEnd, depth + 1, `${label}${type}/`);
        }
        off = payloadEnd;
      }
    };
    walk(0, buf.length, 0, '');
    return parts.join('|');
  }

  // ---- EBML（webm / mkv）----
  if (buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    const probe = probeWebm(buf);
    parts.push(`tracks=${probe.sawTracks ? 'yes' : 'no'}`);
    parts.push(`trackTypes=[${probe.trackTypes.join(',')}]`);
    parts.push(`duration=${probe.duration ?? 'null'}`);
    return parts.join('|');
  }

  parts.push('unrecognised-container');
  return parts.join('|');
}

/**
 * webm 的轨道类型。**只看内容**（Tracks 里的 TrackType 集合）：
 *   · 含 `1`（video）⇒ video（录像通常同时含音频轨，只要有一条视频轨就算视频）
 *   · 只含 `2`（audio）⇒ audio
 *   · 没有 Tracks / 没有 TrackType ⇒ null（调用方 fail-closed 拒绝）
 *
 * ⚠️ **不看**任何客户端声明（MIME / 扩展名 / declared_kind）——
 *    用户明确要求"必须从真实文件内容验证媒体类别"。
 */
function webmTrackType(buf: Buffer): 'video' | 'audio' | null {
  const { trackTypes, sawTracks } = probeWebmCached(buf);
  if (!sawTracks || trackTypes.length === 0) return null;
  if (trackTypes.includes(1)) return 'video';
  if (trackTypes.includes(2)) return 'audio';
  return null;
}

/** webm 时长（`Segment > Info > Duration`，**单位毫秒**，来自元素树） */
function webmDurationMs(buf: Buffer): number | null {
  const { duration } = probeWebmCached(buf);
  if (duration === null || !Number.isFinite(duration) || duration < 0) return null;
  return Math.round(duration);
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
  // ⚠️ mp4 / mov / webm 都在**各自的结构分支**里判类型（hdlr / TrackType），
  //    不靠签名 —— 三者的签名都分不出音视频。
];

/**
 * mp4 / m4a / mov 的时长：读 `moov/mvhd`。
 *
 * 遍历顶层 box（size + type），进 moov 后找 mvhd，按版本读
 * timescale(v1: 4字节@20, v0: 4字节@12) 与 duration(v1: 8字节@24, v0: 4字节@16)。
 * 只需要第一个 moov —— 多 track 的 mvhd 时长一致（它是 movie header）。
 */
/**
 * mp4 的时长。**依次尝试三个来源**（这是 fMP4 的正确处理方式）：
 *   ① `moov > mvhd > duration`（普通 MP4 的总时长）
 *   ② `moov > mvex > mehd > fragment_duration`（**分片 MP4 的总时长**，
 *      单位是 mvhd 的 timescale）
 *   ③ `moov > trak > mdia > mdhd > duration`（轨道时长，最长的那条）
 *
 * 🔴 为什么必须多来源（P11-4 · DEV-191）：
 *    iOS Safari 的 `MediaRecorder` 产出 `audio/mp4`，且**是流式分片写出的**。
 *    这类文件 `mvhd.duration` 经常是 **0**（录制中无法回填总时长），
 *    真实时长只存在于 `mehd` / `mdhd` 里 —— 只读 mvhd 就会得到 0
 *    ⇒ 客户端本地能正常试听、服务端却报"读不出时长"（真机实测就是这样）。
 *    ⚠️ 修的是**格式兼容**，不是把提示改软：读不出仍然 fail-closed 拒绝。
 */
function mp4DurationMs(buf: Buffer): number | null {
  const u32 = (off: number) => buf.readUInt32BE(off);

  /** 遍历 [start, end) 区间里的 box，交给回调；返回 false 可提前结束 */
  const eachBox = (start: number, end: number, visit: (type: string, payload: number, payloadEnd: number) => void) => {
    let off = start;
    while (off + 8 <= end) {
      let size = u32(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      let header = 8;
      if (size === 1) {
        // 64 位扩展尺寸：本项目的文件远小于 4GB，但不展开会算错边界 ⇒ 明确放弃这一层
        if (off + 16 > end) return;
        const big = buf.readBigUInt64BE(off + 8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return;
        size = Number(big);
        header = 16;
      } else if (size === 0) {
        size = end - off;
      }
      if (size < header || off + size > end) return;
      visit(type, off + header, off + size);
      off += size;
    }
  };

  /** mvhd / mdhd 的 (timescale, duration)；v0/v1 偏移不同 */
  const readTimeHeader = (payload: number, payloadEnd: number): { timescale: number; duration: number } | null => {
    if (payload + 4 > payloadEnd) return null;
    const version = buf[payload];
    if (version === 1) {
      if (payload + 32 > payloadEnd) return null;
      return { timescale: u32(payload + 20), duration: Number(buf.readBigUInt64BE(payload + 24)) };
    }
    if (payload + 20 > payloadEnd) return null;
    return { timescale: u32(payload + 12), duration: u32(payload + 16) };
  };

  let mvhdTimescale = 0;
  let mvhdDuration = 0;
  let mehdDuration = 0;
  const trackDurations: Array<{ timescale: number; duration: number }> = [];

  const inMoov = (moovPayload: number, moovEnd: number) => {
    // ① mvhd：先拿它（即使 duration=0，它的 timescale 也是 mehd 的单位基准）
    eachBox(moovPayload, moovEnd, (type, payload, payloadEnd) => {
      if (type === 'mvhd') {
        const t = readTimeHeader(payload, payloadEnd);
        if (t) {
          mvhdTimescale = t.timescale;
          mvhdDuration = t.duration;
        }
      } else if (type === 'mvex') {
        // ② mehd（在 mvex 里）
        eachBox(payload, payloadEnd, (itype, ipayload, ipayloadEnd) => {
          if (itype !== 'mehd') return;
          const version = buf[ipayload];
          if (version === 1) {
            if (ipayload + 12 <= ipayloadEnd) mehdDuration = Number(buf.readBigUInt64BE(ipayload + 4));
          } else if (ipayload + 8 <= ipayloadEnd) {
            mehdDuration = u32(ipayload + 4);
          }
        });
      } else if (type === 'trak') {
        // ③ mdhd（在 trak > mdia 里）
        eachBox(payload, payloadEnd, (mtype, mpayload, mpayloadEnd) => {
          if (mtype !== 'mdia') return;
          eachBox(mpayload, mpayloadEnd, (dtype, dpayload, dpayloadEnd) => {
            if (dtype !== 'mdhd') return;
            const t = readTimeHeader(dpayload, dpayloadEnd);
            if (t && t.timescale > 0 && t.duration > 0) trackDurations.push(t);
          });
        });
      }
    });
  };

  // 顶层找 moov（不要假定 moov 在文件开头：非流式写出的文件里 moov 常在末尾）
  let found = false;
  eachBox(0, buf.length, (type, payload, payloadEnd) => {
    if (type === 'moov' && !found) {
      found = true;
      inMoov(payload, payloadEnd);
    }
  });
  if (!found) return null;

  if (mvhdTimescale > 0 && mvhdDuration > 0) {
    return Math.round((mvhdDuration / mvhdTimescale) * 1000);
  }
  if (mvhdTimescale > 0 && mehdDuration > 0) {
    return Math.round((mehdDuration / mvhdTimescale) * 1000);
  }
  let best = 0;
  for (const t of trackDurations) {
    best = Math.max(best, Math.round((t.duration / t.timescale) * 1000));
  }
  return best > 0 ? best : null;
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
/**
 * @param declaredKind
 *   **浏览器给出的**采集类型（`audio` / `video`），来自 `MediaRecorder.mimeType` 或
 *   `File.type` 的主类型。⚠️ 它**不是**客户在表单里填的东西（没有这种输入），
 *   而是浏览器对"我刚录的是什么"的如实回答。
 *
 *   用途**只有一个**：webm 判不出音视频时（见 webmTrackType 的说明）。
 *   容器能判定时一律以**容器**为准 ⇒ 伪造 declared_kind 不能把视频伪装成语音容器。
 *   而"把上限从 30 秒放宽到 60 秒"本身不是安全边界（只影响契约口径，不影响授权与隔离），
 *   所以这个兜底是可接受的；反过来（缺省按视频）会把 31~60 秒的正常语音误拒。
 */
export function sniffCustomerMedia(
  buf: Buffer,
  expected: 'image' | 'audio' | 'video' | 'mixed',
  declaredKind?: 'audio' | 'video' | null,
): SniffedMedia {
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
          : webmDurationMs(buf);
    if (durationMs === null) {
      throw new MediaFormatError(
        'DURATION_UNREADABLE',
        '无法确认语音时长，请重新录制后上传',
        422,
      );
    }
    // webm 的音视频由 TrackType 决定（签名相同，见 webmTrackType 的说明）
    if (sig.mime === 'audio/webm') {
      // ⚠️ **真实 Chrome/Firefox 的 MediaRecorder 产物里没有 Tracks**（实测 24KB 的真实
      //    录音：Segment 里只有 SeekHead/Info/Cues/Cluster，TrackType 不存在）
      //    ⇒ 容器判不出是常态，不是异常。此时退到**浏览器给出的类型**，
      //    再缺省按语音（浏览器录音的主流形态，且上限更宽松，不会误拒正常语音）。
      // 🔴 **只用内容判定**（用户第三批第一条：不得凭客户端声明决定限制）。
      //    真实产物有 Tracks/TrackType（见上面 DEV-183），所以不需要任何兜底；
      //    判不出就 fail-closed 拒绝，而不是猜一个宽松的上限。
      const track = webmTrackType(buf);
      if (track === null) {
        throw new MediaFormatError(
          'KIND_UNREADABLE',
          '这个文件的格式无法识别，请重新录制或换一个文件',
          422,
        );
      }
      if (track !== 'audio' && (expected === 'image' || expected === 'audio' || expected === 'video')) {
        throw new MediaFormatError('KIND_MISMATCH', '这个入口只接受语音，请重新选择', 415);
      }
      return track === 'video'
        ? { kind: CUSTOMER_MEDIA_KIND.VIDEO as 'video', mime: 'video/webm', ext: 'webm', durationMs }
        : { kind: CUSTOMER_MEDIA_KIND.AUDIO as 'audio', mime: 'audio/webm', ext: 'webm', durationMs };
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
    const durationMs = webmDurationMs(buf);
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
