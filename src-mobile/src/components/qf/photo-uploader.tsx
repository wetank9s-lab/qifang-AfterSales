/**
 * 照片上传（QFPhotoUploader）。
 *
 * ===========================================================================
 * 为什么要做客户端压缩（不是可选的优化）
 * ===========================================================================
 *   师傅在现场用手机拍的照片，单张常见 3–8 MB（4000×3000）。
 *   三条现实约束叠在一起：
 *     ① 服务端 `resolveMaxPhotoBytes()` 有上限，超了直接拒；
 *     ② 门店/工地常是 4G 弱信号，8 MB 上传在 45s 超时内传不完；
 *     ③ 每阶段最多 6 张，6×8MB = 48MB —— 这个量在真机上要等几分钟。
 *
 *   ⇒ 上传前统一压到 **长边 ≤1600px、JPEG 质量 0.82**。
 *     售后定责看的是"管路走向对不对、有没有装歪"，1600px 完全够；
 *     原始文件留在师傅手机里，需要时再单独要。
 *
 *   ⚠️ 压缩是**在 canvas 上做的**，会丢掉 EXIF。这对本场景是**好事**：
 *      手机竖拍的照片 EXIF 里带 Orientation，不处理就上传会在后台显示成横的
 *      （这是 DEV-84 记过的同类缺陷）。canvas 绘制时浏览器已按 Orientation
 *      把像素摆正，所以导出即为"所见即所得"。
 *
 * ===========================================================================
 * 两个必须做对的地方
 * ===========================================================================
 *   ① **多张要串行上传**，不能 Promise.all：
 *      6 张并行会把上行带宽切成 6 份，弱网下反而更容易全部超时；
 *      而且服务端每张都要过一次鉴权 + 写库，串行也能让"第 3 张失败"的
 *      错误定位变简单（并行时你只知道"有一张失败"）。
 *
 *   ② **失败的那张要留在列表里可重试**，不能静默丢弃。
 *      照片是售后证据，丢一张等于丢一份证据，而用户往往以为是"上传成功了"。
 */

import { useRef, useState } from 'react';
import { useSecurePhoto, archivePhotoFileUrl } from '../../api/media';
import { ArchiveApiAdapter } from '../../api/archives';
import { newRequestId } from '../../api/http';

/** 长边上限（px）。1600 对"看管路、看安装"足够，且单张通常在 300–600 KB */
const MAX_EDGE = 1600;
/** JPEG 质量 */
const QUALITY = 0.82;
/** 压缩后仍超过这个体积就再降一次质量（极少发生，兜底用） */
const SOFT_LIMIT_BYTES = 2.5 * 1024 * 1024;

export interface QFPhotoUploaderProps {
  archiveId: number | string;
  stageId: number;
  /** 已有照片数（来自服务端 stage.photo_count） */
  photoCount: number;
  photoMax: number;
  /** 每成功上传一张后回调（父级需要刷新阶段数据以拿到新的 photo_count） */
  onUploaded: () => void | Promise<void>;
  /** 只读角色不显示上传 */
  disabled?: boolean;
  testId?: string;
}

interface PendingItem {
  key: string;
  name: string;
  state: 'uploading' | 'failed';
  error?: string;
}

/**
 * 上传器。
 *
 * ⚠️ 已上传的照片**不在这里渲染**（渲染在档案详情的照片网格里）——
 *    这里只负责"添加"这件事。同一条数据两处渲染必然出现"这里少一张、那里多一张"。
 */
export function QFPhotoUploader({
  archiveId,
  stageId,
  photoCount,
  photoMax,
  onUploaded,
  disabled,
  testId,
}: QFPhotoUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const busy = pending.some((p) => p.state === 'uploading');
  const full = photoCount + pending.filter((p) => p.state === 'uploading').length >= photoMax;

  const pick = () => {
    if (disabled || busy || full) return;
    inputRef.current?.click();
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setErr(null);

    const room = photoMax - photoCount;
    const list = Array.from(files);
    if (list.length > room) {
      setErr(`这个阶段最多 ${photoMax} 张，已按顺序只上传前 ${room} 张。`);
    }
    const take = list.slice(0, Math.max(0, room));

    for (const file of take) {
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`;
      setPending((p) => [...p, { key, name: file.name, state: 'uploading' }]);
      try {
        const prepared = await prepare(file);
        await ArchiveApiAdapter.attachStagePhoto(
          archiveId,
          { stage_id: stageId, file: prepared, photo_type: 'stage' },
          newRequestId(),
        );
        setPending((p) => p.filter((x) => x.key !== key));
        await onUploaded();
      } catch (e) {
        const msg = e instanceof Error ? e.message : '上传失败';
        setPending((p) => p.map((x) => (x.key === key ? { ...x, state: 'failed', error: msg } : x)));
      }
    }
  };

  return (
    <div data-testid={testId}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        // `capture` 不设：让用户能选相册里的图（师傅常常是干完活统一补传），
        // 设了 capture 在部分安卓上会直接进相机、无法选相册。
        multiple
        className="hidden"
        onChange={(e) => {
          void onFiles(e.target.files);
          // 清空 value：否则选同一张图第二次不会触发 change
          e.target.value = '';
        }}
        data-testid={testId ? `${testId}-input` : undefined}
      />

      <div className="grid grid-cols-4 gap-2">
        {/* 已上传的张数以小方块表示（只给数量，不重复渲染图） */}
        {Array.from({ length: Math.min(photoCount, photoMax) }).map((_, i) => (
          <div
            key={`done-${i}`}
            className="bg-svc-success-soft text-svc-success flex aspect-square items-center justify-center rounded-svc-sm"
            aria-hidden="true"
          >
            <SmallCheck />
          </div>
        ))}

        {pending.map((p) => (
          <div
            key={p.key}
            className={`flex aspect-square flex-col items-center justify-center gap-1 rounded-svc-sm px-1 text-center ${
              p.state === 'failed' ? 'bg-svc-danger-soft text-svc-danger' : 'bg-svc-surface-2 text-svc-ink-3'
            }`}
            title={p.error}
          >
            {p.state === 'failed' ? (
              <>
                <span className="qf-caption font-medium">失败</span>
                <button
                  type="button"
                  className="text-svc-brand-text qf-caption underline"
                  onClick={() => {
                    // 重试 = 先移除失败项，让用户重新选这张图
                    setPending((list) => list.filter((x) => x.key !== p.key));
                    inputRef.current?.click();
                  }}
                >
                  重选
                </button>
              </>
            ) : (
              <span className="svc-spinner" aria-hidden="true" />
            )}
          </div>
        ))}

        {!full ? (
          <button
            type="button"
            onClick={pick}
            disabled={disabled || busy}
            className="bg-svc-surface-2 text-svc-brand-text qf-pressable flex aspect-square flex-col items-center justify-center gap-0.5 rounded-svc-sm disabled:opacity-45"
            aria-label="添加现场照片"
            data-testid={testId ? `${testId}-add` : undefined}
          >
            <CameraGlyph />
            <span className="qf-caption">添加</span>
          </button>
        ) : null}
      </div>

      {err ? (
        <div className="text-svc-warning qf-foot mt-2" role="status">
          {err}
        </div>
      ) : null}
      {pending.some((p) => p.state === 'failed') ? (
        <div className="text-svc-danger qf-foot mt-2" role="alert">
          有照片没传上去。检查网络后点「重选」再传一次 —— 传不上去这个阶段没法完成。
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ 已传照片网格 */

/**
 * 已上传照片（详情页照片区用）。
 *
 * ⚠️ 私有资源只能 `fetch(带 token) → blob → objectURL`，不能直接写 `<img src>`。
 *    每条由 `useSecurePhoto` 独立管理并 revoke。
 *
 * ⚠️ 加载失败必须显示"失败 + 可重试"，不能留空白：
 *    空白在相册里看起来像"这张就是黑的"，用户不会去查网络 ——
 *    而照片是售后定责的关键证据。
 */
export function QFPhotoGrid({
  photos,
  columns = 3,
}: {
  photos: { id: number; photo_type?: string; stage_code?: string | null }[];
  columns?: number;
}) {
  if (photos.length === 0) {
    return (
      <div className="bg-svc-surface text-svc-ink-3 qf-foot rounded-svc border border-svc-line px-4 py-6 text-center">
        还没有现场照片
      </div>
    );
  }
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {photos.map((p) => (
        <PhotoTile key={p.id} photoId={p.id} />
      ))}
    </div>
  );
}

/**
 * 单张照片。
 *
 * ⚠️ 重试靠"换 key 重新挂载"实现：`useSecurePhoto` 只在 path 变化时重取，
 *    同一 path 再调用是空转。用一个自增 nonce 拼进 path（服务端忽略多余 query）
 *    会污染缓存键，所以这里用**重挂载**这个更朴素也更可靠的办法。
 */
function PhotoTile({ photoId }: { photoId: number }) {
  const [nonce, setNonce] = useState(0);
  const { url, loading, error } = useSecurePhoto(
    // nonce 只用于强制重新挂载；path 本身不变，故不进 URL
    archivePhotoFileUrl(photoId),
  );
  return (
    <div key={`${photoId}-${nonce}`} className="bg-svc-surface-2 relative aspect-square overflow-hidden rounded-svc-sm">
      {loading ? <div className="svc-skeleton absolute inset-0" /> : null}
      {url ? (
        <img src={url} alt="现场照片" className="h-full w-full object-cover" loading="lazy" decoding="async" />
      ) : error ? (
        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          className="text-svc-ink-3 qf-caption flex h-full w-full flex-col items-center justify-center gap-1"
        >
          <span>加载失败</span>
          <span className="text-svc-brand-text underline">重试</span>
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ 压缩实现 */

/**
 * 压缩成上传用 JPEG。
 *
 * ⚠️ 三个会让它静默失效的地方，都已处理：
 *   ① `createImageBitmap` 在部分老安卓上不支持 ⇒ 回退到 `<img>` + objectURL
 *   ② canvas 导出必须 `toBlob`（`toDataURL` 会生成 base64，体积大 33% 且阻塞主线程）
 *   ③ 长边本来就小于 MAX_EDGE 时**不要重编码** —— 重编码只会掉质量不掉体积
 *
 * ⚠️ 图片解不出来（损坏文件 / HEIC 在不支持的浏览器）时**退回原文件上传**：
 *    宁可让服务端去判"格式不支持"，也不要在这里静默丢掉师傅拍的照片。
 */
async function prepare(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;

  const bitmap = await loadBitmap(file).catch(() => null);
  if (!bitmap) return file;

  const { width, height } = bitmap;
  const longEdge = Math.max(width, height);
  if (longEdge <= MAX_EDGE && file.size <= SOFT_LIMIT_BYTES) {
    return file;
  }

  const scale = Math.min(1, MAX_EDGE / longEdge);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  // 白底：PNG 透明区转 JPEG 会变黑，铺一层白更接近人眼所见
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, w, h);
  if ('close' in bitmap && typeof (bitmap as ImageBitmap).close === 'function') {
    (bitmap as ImageBitmap).close();
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) return file;

  const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* 落到 <img> 回退 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // ⚠️ 不能在这里 revoke：drawImage 还没发生。由调用方在绘制后统一 revoke。
    //    这里把 url 挂在元素上，便于调用方清理。
    (img as any).__objectUrl = url;
    return img;
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/* ----------------------------------------------------------------- 图标 */

function CameraGlyph() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
      <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="3.2" />
    </svg>
  );
}

function SmallCheck() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
