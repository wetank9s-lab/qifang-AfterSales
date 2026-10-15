/**
 * 私有媒体受控流式读取（P11-5 Range 修复，2026-10-15）。
 *
 * 🔴 **唯一入口，禁止在 `media` / `photo` / 其它端点各复制一份 Range 解析**。
 *    两个师傅端点（`technicianVisit:media` / `technicianVisit:photo`）共用本文件。
 *
 * 安全不变式（顺序不可颠倒）：
 *   调用方**必须**在「派工 Token 校验 → 当前 Visit 有效性 → ref 候选集归属验证 →
 *   找到真实私有媒体（`stored`）」全部通过之后，才调用 `streamPrivateMedia`。
 *   本函数**只负责"把已确认有权读取的文件按 Range 流式吐出"**，
 *   **绝不**把 `Range` / `ref` / `Token` 当作任何授权依据。
 *
 * 行为：
 *   · 无 Range 或无法解析的单段/多段 Range → **200 全量**（兼容 Chromium 与既有下载路径）；
 *   · 合法单段 `bytes` Range → **206** + `Accept-Ranges` + `Content-Range` + 部分 `Content-Length`；
 *   · 合法但超出文件范围 → **416** + `Content-Range` 头（取值形如 `bytes * / total`，即星号占位 total）。
 *
 * 保留既有安全头：DB 记录的 `Content-Type`（绝不信请求/文件系统）、`nosniff`、
 * `private, no-store`、`inline`。
 *
 * 🔴 **脱敏日志**：只记媒体 MIME / size / 是否收到 Range / 请求字节范围 / 返回 200·206·416 /
 *    `Content-Range`。**绝不**记完整 Token、ref、客户资料或媒体内容。
 */

import { createReadStream } from 'node:fs';

export interface PrivateMediaFile {
  absPath: string;
  mime: string;
  size: number;
}

export interface PrivateMediaLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface StreamPrivateMediaOptions {
  /** 仅用于脱敏诊断，见文件头说明 */
  log?: PrivateMediaLogger;
  /**
   * 出错日志里的业务标签（如「现场照片」「客户媒体」），**不**含任何路径 / ref / Token。
   * 用于区分是哪类媒体在流式读取时出错，且不泄漏存储结构。
   */
  label?: string;
}

type ParseRangeResult =
  | { kind: 'none' }
  | { kind: 'unsupported' }
  | { kind: 'unsatisfiable'; total: number }
  | { kind: 'ok'; start: number; end: number; total: number };

/**
 * 解析**单段** `bytes=` Range（Safari 媒体播放所需形态）。
 *
 * 支持：
 *   · `bytes=0-`              （从 0 到末尾）
 *   · `bytes=start-end`      （含闭区间）
 *   · `bytes=-N`             （末尾 N 字节，合法后缀范围）
 *
 * 不支持（回落 200 全量）：
 *   · 缺省 / 空 header；
 *   · 单位非 `bytes=`；
 *   · 多段 `bytes=0-10,20-30`（本实现只服务单段，避免手搓 multipart/byteranges 响应体）。
 *
 * 合法但无法满足（回 416）：
 *   · `start >= total`；
 *   · `start > end`；
 *   · 后缀 `N <= 0` 或算出的 `start > end`。
 *
 * 末尾 `end >= total` 按 RFC 7233 钳制到 `total - 1`（浏览器常越界请求，服务器钳制即可）。
 */
export function parseSingleByteRange(
  header: string | undefined | null,
  total: number,
): ParseRangeResult {
  if (!header) return { kind: 'none' };
  const trimmed = String(header).trim();
  const m = /^bytes=(\d*)-(\d*)$/.exec(trimmed);
  // 形如 `bytes=...` 但本实现不接受的形态（多段 / 非法字符 / 非 bytes 单位）
  if (!m) return { kind: 'unsupported' };

  const startStr = m[1];
  const endStr = m[2];

  // 后缀形式 bytes=-N
  if (startStr === '' && endStr !== '') {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: 'unsatisfiable', total };
    const start = Math.max(0, total - suffix);
    const end = total - 1;
    if (start > end) return { kind: 'unsatisfiable', total };
    return { kind: 'ok', start, end, total };
  }

  // 仅 start：bytes=start-
  if (startStr !== '' && endStr === '') {
    const start = Number(startStr);
    if (!Number.isInteger(start) || start < 0) return { kind: 'unsupported' };
    if (start >= total) return { kind: 'unsatisfiable', total };
    return { kind: 'ok', start, end: total - 1, total };
  }

  // 完整范围：bytes=start-end
  if (startStr !== '' && endStr !== '') {
    const start = Number(startStr);
    const end = Number(endStr);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0) {
      return { kind: 'unsupported' };
    }
    if (start > end) return { kind: 'unsatisfiable', total };
    if (start >= total) return { kind: 'unsatisfiable', total };
    const clampedEnd = Math.min(end, total - 1);
    return { kind: 'ok', start, end: clampedEnd, total };
  }

  // bytes=- （两者皆空）：不支持
  return { kind: 'unsupported' };
}

/**
 * 在**全部鉴权与归属校验通过之后**调用：流式返回私有媒体，自动处理 Range。
 * 不返回任何值，直接写 `ctx`。
 */
export function streamPrivateMedia(
  ctx: any,
  stored: PrivateMediaFile,
  opts: StreamPrivateMediaOptions = {},
): void {
  const total = Number(stored.size) || 0;
  const safeMime = String(stored.mime || 'application/octet-stream');
  const rangeHeader = ctx.get?.('Range');
  const parsed = parseSingleByteRange(rangeHeader, total);
  const log = opts.log;
  const label = opts.label || '媒体';

  // 公共安全头：无论 200 / 206 / 416 都设，且**绝不能**从请求或文件系统推测 Content-Type
  ctx.withoutDataWrapping = true;
  ctx.set?.('X-Content-Type-Options', 'nosniff');
  ctx.set?.('Cache-Control', 'private, no-store');
  ctx.set?.('Content-Disposition', 'inline');
  ctx.set?.('Accept-Ranges', 'bytes');

  const diag = (status: number, extra: string): void => {
    log?.info?.(
      `[private-media] mime=${safeMime} size=${total} range=${rangeHeader ?? '(none)'} -> ${status} ${extra}`,
    );
  };

  if (parsed.kind === 'ok') {
    const { start, end } = parsed;
    const chunkSize = end - start + 1;
    ctx.status = 206;
    ctx.set?.('Content-Type', safeMime);
    ctx.set?.('Content-Range', `bytes ${start}-${end}/${total}`);
    ctx.set?.('Content-Length', String(chunkSize));
    ctx.body = createReadStream(stored.absPath, { start, end }, (error: NodeJS.ErrnoException | null) => {
      if (error) log?.error?.(`[private-media] 读取${label}流失败：${error?.message}`);
    });
    diag(206, `Content-Range=bytes ${start}-${end}/${total}`);
    return;
  }

  if (parsed.kind === 'unsatisfiable') {
    ctx.status = 416;
    ctx.set?.('Content-Range', `bytes */${total}`);
    ctx.body = '';
    diag(416, `Content-Range=bytes */${total}`);
    return;
  }

  // none / unsupported ⇒ 200 全量（兼容 Chromium 与既有下载路径，不破坏现有行为）
  ctx.status = 200;
  ctx.set?.('Content-Type', safeMime);
  ctx.body = createReadStream(stored.absPath, (error: NodeJS.ErrnoException | null) => {
    if (error) log?.error?.(`[private-media] 读取${label}流失败：${error?.message}`);
  });
  diag(200, `full ${total}B`);
}
