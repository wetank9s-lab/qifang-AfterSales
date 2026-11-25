/**
 * 后台「上门服务档案」详情 · 现场照片预览
 *
 * =============================================================================
 * 为什么单独一个文件
 * =============================================================================
 * `service-archives-admin-model.tsx` 已经 900+ 行，再塞进一个带弹层、懒加载、
 * objectURL 生命周期的相册组件，会让那个文件彻底不可读。这里只负责一件事：
 * **把 `svc:archivePhotoList` 拿到的照片元数据，渲染成能看的图**。
 *
 * =============================================================================
 * 三条不可越过的边界（用户 R2.2.4 第二阶段原文）
 * =============================================================================
 *  ① **不新增服务端接口**。
 *     `svc:archivePhotoList`（要元数据）与 `svc:archivePhotoFile`（要字节）
 *     已经存在，且后者的授权链是完整的：
 *       photoId → 反查 photo.archive_id → 反查 archive →
 *       `archives.assertCanAccessRow(actor, archive)`（门店范围）→ 才读文件。
 *     **不信任前端传的门店范围**，前端也拿不到 storage_key（project() 不投影它）。
 *  ② **不改公共存储**。照片仍在 `privateDir`，只走带 Bearer 的 fetch 拿 blob。
 *     `<img src="/api/svc:archivePhotoFile/...">` 必然 401 ——
 *     浏览器对 `<img>` 不发 Authorization 头。
 *  ③ **objectURL 必须释放**。每张原图解码占 1.5–3 MB，翻十几张低端机会卡；
 *     而且不释放会出现「关了抽屉还留着上一个档案的图」这种串档观感。
 *     这里在组件卸载、切换档案、关闭弹层三处都 revoke。
 *
 * =============================================================================
 * 分组规则（照用户原文，不自行发挥）
 * =============================================================================
 *  · 暖通（archive_type='hvac'）：标题「施工照片」，按六阶段分组
 *    survey/plan/pipe/device/test/accept；`stage_id` 落不到任何阶段的进「未分类」，
 *    **不丢弃、不猜测、不自动改归属**（历史数据可能是 stage_id=null 或指向已删阶段）。
 *  · 普通上门（service）：标题「现场照片」，按服务记录展示，**不套**六阶段。
 *  · 没有照片的分组**不渲染**（不显示空相册）。
 *  · 草稿与已发布都要显示：`archivePhotoList` 本就不过滤 published，
 *    投影里带 `published` 只用于角标提示，不参与过滤。
 */
import React from 'react';
import { Button, Empty, Modal, Spin, Tag } from 'antd';

type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

/** `svc:archivePhotoList` 的投影（见 archive-photo-service.ts::project） */
export interface ArchivePhoto {
  id: number;
  archive_id: number;
  stage_id: number | null;
  photo_type: string | null;
  mime: string | null;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  published: boolean;
  uploaded_at: string | null;
}

/** 暖通六阶段（顺序即展示顺序，与移动端一致） */
export const HVAC_STAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'survey', label: '勘察' },
  { code: 'plan', label: '方案' },
  { code: 'pipe', label: '布管' },
  { code: 'device', label: '安装' },
  { code: 'test', label: '调试' },
  { code: 'accept', label: '验收' },
];

/**
 * 照片文件 URL。
 *
 * 🔴 DEV-2xx（2026-11-25 隔离验收实测）：**不能带 `/api` 前缀**。
 *    `request()` 底层是 `app.apiClient`（axios 实例），它的 `baseURL` 已经是 `/api`
 *    ⇒ 写成 `/api/svc:archivePhotoFile` 实际发出的是
 *    **`/api/api/svc:archivePhotoFile`**，命中 404，前端表现为「加载失败」，
 *    而用 curl 直连 `/api/svc:…` 又是 200 —— 极易误判成权限/存储问题。
 *    同文件既有调用（`svc:archiveAdminList` / `svc:archivePhotoList` …）一律不带前缀，
 *    这里跟随同一约定。
 *
 * ⚠️ 参数名用 `photo_id`（服务端主参数名）。服务端虽已兼容
 *    `photo_id`/`id`/`filterByTk`（DEV-271），这里用主名避免依赖兼容层。
 */
export function archivePhotoFileUrl(photoId: number): string {
  return `svc:archivePhotoFile?photo_id=${encodeURIComponent(String(photoId))}`;
}

// ---------------------------------------------------------------------------
// 单张缩略图：自带 loading / error / retry，互不影响
// ---------------------------------------------------------------------------

/**
 * ⚠️ 为什么要给每张图单独的 hook 实例而不是在父层统一 load：
 *    统一 load 一旦某张失败就整块降级；而且父层无法给单张图做"重试"。
 *    每张图独立 state ⇒ 一张失败只影响它自己。
 */
function PhotoThumb(props: {
  request: Requester;
  photo: ArchivePhoto;
  size?: number;
  onClick: () => void;
  /** 进入视口才加载（懒加载），避免一次拉几十张原图 */
  lazy?: boolean;
  /**
   * 固定尺寸模式。默认 `false` ⇒ 宽度跟随网格列宽（见下方样式注释的 DEV 说明）。
   * 只有调用方明确要"96×96 小图"（例如以后放进表格单元格）时才传 `true`。
   */
  fixed?: boolean;
}) {
  const { request, photo, size = 96, onClick, lazy = true, fixed = false } = props;
  const [url, setUrl] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState(null);
  const [nonce, setNonce] = React.useState(0);
  const [visible, setVisible] = React.useState(!lazy);
  // ⚠️ 不给 useRef 传类型实参：`react` 在本仓库是**无体声明** stub，
  //    `React.useRef<HTMLDivElement>` 会报 TS2347「Untyped function calls may not
  //    accept type arguments」。改成 `null` 初值 + 运行期判断即可。
  const boxRef = React.useRef(null);
  const urlRef = React.useRef(null);

  // 懒加载：进入视口（留 200px 余量）才置 visible
  React.useEffect(() => {
    if (!lazy || visible) return;
    const el = boxRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [lazy, visible]);

  React.useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        const blob = await request(archivePhotoFileUrl(photo.id), 'GET', undefined, { responseType: 'blob' });
        if (cancelled) return;
        // request() 在 responseType='blob' 时应返回 Blob；兼容返回 ArrayBuffer 的实现
        // ⚠️ 不写 `: Blob` 类型标注：ambient 里 Blob 只是值声明，当类型用报 TS2749。
        const b = blob instanceof Blob ? blob : new Blob([blob as any], { type: String(photo.mime ?? 'image/*') });
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        const u = URL.createObjectURL(b);
        urlRef.current = u;
        setUrl(u);
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? '加载失败'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    };
  }, [request, photo.id, photo.mime, visible, nonce]);

  return h(
    'div',
    {
      ref: boxRef,
      style: {
        /*
         * 🔴 DEV-2xx 修正（2026-11-25 后台真机截图发现）：**缩略图必须跟随网格列宽**。
         *
         *    改之前是 `width: size, height: size`，`size` 默认 96px —— 而网格列是
         *    `repeat(4, minmax(0,1fr))`。抽屉宽的时候每列能到 250px 上下，
         *    96px 的方块在几百像素的格子里**左上对齐**，看起来就是"缩略图没铺满、
         *    一列里挤着好几个"；4 张图时第 4 张换行，视觉上更像三张挤在一起 + 一张掉队。
         *    用户第二阶段原话是「优先 4 列自适应，按详情区宽度调整」。
         *
         *    ⇒ 宽度交给网格（`width: '100%'`），高度用 `aspect-ratio: 1 / 1` 跟随。
         *      这样 4 列永远等宽等高，缩略图铺满各自的格子。
         *    ⚠️ 保留一个 `minHeight` 兜底：极窄容器（例如 360px 弹窗里还能再分成 4 列）
         *       时单格可能小于 40px，那时图会小到认不出，宁可给个下限。
         *       `maxWidth` 限制上限，避免宽屏抽屉里一张缩略图夸张到 400px。
         *
         *    `size` 参数保留，但只在调用方**显式**要求固定尺寸时才生效（走固定分支），
         *    网格内调用不传 ⇒ 自适应。这样既不破坏旧调用，也不用改调用点。
         */
        ...(fixed ? { width: size, height: size } : {
          width: '100%',
          aspectRatio: '1 / 1',
          minHeight: 40,
          maxWidth: size > 96 ? size : undefined,
        }),
        borderRadius: 8, overflow: 'hidden',
        border: '1px solid #f0f0f0', background: '#fafafa',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: url ? 'zoom-in' : 'default', position: 'relative',
      },
      onClick: url ? onClick : undefined,
      'data-testid': `sa2-photo-${photo.id}`,
    },
    loading
      ? h(Spin, { size: 'small' })
      : err
        ? h('div', { style: { fontSize: 11, color: '#ff4d4f', textAlign: 'center', padding: 4 } },
            '加载失败',
            // 🔴 必须把 `err` 显示出来：只写"加载失败"会让一次
            //    URL 拼错（如多一层 `/api`）看起来和"权限不足""文件缺失"一模一样，
            //    排障要多花十几分钟去猜。这里给一行可复制的原文。
            h('div', {
              title: err,
              style: { marginTop: 2, fontSize: 10, color: '#8c8c8c', lineHeight: 1.3, maxHeight: 30, overflow: 'hidden', wordBreak: 'break-all' },
            }, String(err).slice(0, 40)),
            h('div', { style: { marginTop: 4 } },
              h(Button, {
                size: 'small', type: 'link',
                onClick: (e: any) => { e?.stopPropagation?.(); setNonce((n) => n + 1); },
              }, '重试'),
            ),
          )
        : url
          ? h('img', {
              src: url,
              alt: `照片 ${photo.id}`,
              /*
               * 🔴 `contain` 而不是 `cover`（2026-11-25 截图实测改）。
               *
               *    原来是 `objectFit: 'cover'`：格子是正方形，竖图（实测 898×1600）
               *    被上下裁掉一截 —— 那张图上"365 大夜宴"的字被切了一半。
               *    第二阶段原话是「原始图片保持正常比例，**大图不能裁切关键施工内容**」。
               *    大图查看器我用了 `contain`，但**缩略图同样是"给人看的证据"**：
               *    施工照片里管线走向、机器铭牌、验收单都在边缘，`cover` 恰好把它们裁掉，
               *    而员工看图就是想确认这些。
               *
               *    ⇒ 缩略图改 `contain`：完整显示，四周留底色（父容器 `#fafafa`），
               *      代价是竖图两侧有留白 —— 这比"看起来整齐但看不到内容"好得多。
               */
              style: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
              'data-real-src': 'object-url',
            })
          : h('div', { style: { fontSize: 11, color: '#bfbfbf' } }, '…'),
    // 未发布角标：内部可见，但不误导成"客户也能看"
    photo.published === false
      ? h('span', {
          style: {
            position: 'absolute', left: 0, top: 0, background: 'rgba(0,0,0,.55)',
            color: '#fff', fontSize: 10, padding: '1px 5px', borderBottomRightRadius: 6,
          },
        }, '未发布')
      : null,
  );
}

// ---------------------------------------------------------------------------
// 大图查看器：上一张 / 下一张 / 放大 / 缩小 / 关闭
// ---------------------------------------------------------------------------

function PhotoViewer(props: {
  request: Requester;
  photos: ArchivePhoto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const { request, photos, index, onIndex, onClose } = props;
  const cur = photos[index];
  const [url, setUrl] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);
  const [scale, setScale] = React.useState(1);
  const [nonce, setNonce] = React.useState(0);
  const urlRef = React.useRef(null);

  // 🔴 切换 index 时必须先释放上一张，否则快速翻页会累积 objectURL，
  //    而且旧图的 blob 还活着 ⇒ 内存里同时存在两张原图。
  React.useEffect(() => {
    if (!cur) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setScale(1);
    (async () => {
      try {
        const blob = await request(archivePhotoFileUrl(cur.id), 'GET', undefined, { responseType: 'blob' });
        if (cancelled) return;
        const b = blob instanceof Blob ? blob : new Blob([blob as any], { type: String(cur.mime ?? 'image/*') });
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        const u = URL.createObjectURL(b);
        urlRef.current = u;
        setUrl(u);
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? '加载失败'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    };
  }, [request, cur?.id, cur?.mime, nonce]);

  // 键盘：← → 翻页，Esc 关闭
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      else if (e.key === 'ArrowRight' && index < photos.length - 1) onIndex(index + 1);
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, photos.length, onIndex, onClose]);

  if (!cur) return null;

  return h(Modal, {
    open: true,
    onCancel: onClose,
    footer: null,
    width: 'min(1040px, 92vw)',
    title: `照片 ${index + 1} / ${photos.length}`,
    destroyOnClose: true,
    'data-testid': 'sa2-photo-viewer',
  },
    h('div', { style: { textAlign: 'center', minHeight: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', borderRadius: 6, overflow: 'auto' } },
      loading
        ? h(Spin, null)
        : err
          ? h('div', { style: { color: '#fff', padding: 24 } },
              h('div', null, `加载失败：${err}`),
              h(Button, { size: 'small', style: { marginTop: 8 }, onClick: () => setNonce((n) => n + 1) }, '重试'),
            )
          : url
            // objectFit:'contain' ⇒ 不裁切关键施工内容（用户原文要求）
            ? h('img', {
                src: url, alt: `照片 ${cur.id}`,
                style: {
                  maxWidth: '100%', maxHeight: '68vh',
                  transform: `scale(${scale})`, transition: 'transform .15s ease',
                  objectFit: 'contain', display: 'block', margin: '0 auto',
                },
              })
            : null,
    ),
    h('div', { style: { display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12, flexWrap: 'wrap' } },
      h(Button, { disabled: index <= 0, onClick: () => onIndex(index - 1) }, '上一张'),
      h(Button, { disabled: index >= photos.length - 1, onClick: () => onIndex(index + 1) }, '下一张'),
      h(Button, { onClick: () => setScale((s) => Math.min(4, Number((s + 0.25).toFixed(2)))) }, '放大'),
      h(Button, { onClick: () => setScale((s) => Math.max(0.5, Number((s - 0.25).toFixed(2)))) }, '缩小'),
      h(Button, { onClick: () => setScale(1) }, `重置（${Math.round(scale * 100)}%）`),
      h(Button, { type: 'primary', onClick: onClose }, '关闭'),
    ),
  );
}

// ---------------------------------------------------------------------------
// 分组：暖通按六阶段、普通服务按记录
// ---------------------------------------------------------------------------

interface Group { key: string; label: string; photos: ArchivePhoto[] }

/**
 * 暖通分组。
 *
 * `stage_id` 与 `stage_code` 的映射来自 `detail.stages`（服务端权威投影）。
 * 🔴 落不到任何已知阶段的一律进「未分类」——**不丢弃、不猜测**。
 *    历史数据里可能是 `stage_id=null`（早期上传没带阶段），
 *    也可能指向一个已被删除的阶段行（stage_id 有值但 stages 里找不到）。
 *    这两种都不能自作主张塞进某一阶段。
 */
export function groupHvacPhotos(photos: ArchivePhoto[], stages: any[] | null): Group[] {
  const byStageId = new Map<number, string>();
  for (const s of stages ?? []) {
    const id = Number(s?.id);
    const code = String(s?.stage_code ?? '');
    if (Number.isFinite(id) && code) byStageId.set(id, code);
  }
  const buckets = new Map<string, ArchivePhoto[]>();
  const orphan: ArchivePhoto[] = [];
  for (const p of photos) {
    const sid = p.stage_id === null || p.stage_id === undefined ? null : Number(p.stage_id);
    const code = sid !== null ? byStageId.get(sid) : undefined;
    if (!code) { orphan.push(p); continue; }
    if (!buckets.has(code)) buckets.set(code, []);
    buckets.get(code)!.push(p);
  }
  const out: Group[] = [];
  for (const st of HVAC_STAGES) {
    const arr = buckets.get(st.code);
    if (arr && arr.length) out.push({ key: st.code, label: st.label, photos: arr });
  }
  // 未知 code（理论上不该出现，但服务端阶段表可能带自定义）也保留，放在末位
  for (const [code, arr] of buckets) {
    if (!HVAC_STAGES.some((s) => s.code === code) && arr.length) {
      out.push({ key: code, label: code, photos: arr });
    }
  }
  if (orphan.length) out.push({ key: '__orphan', label: '未分类', photos: orphan });
  return out;
}

/** 普通上门服务分组：不套六阶段，全部照片平铺在一组 */
export function groupServicePhotos(photos: ArchivePhoto[]): Group[] {
  return photos.length ? [{ key: 'service', label: '现场照片', photos }] : [];
}

// ---------------------------------------------------------------------------
// 主体
// ---------------------------------------------------------------------------

export function ArchivePhotoGallery(props: {
  request: Requester;
  photos: ArchivePhoto[] | null;
  isHvac: boolean;
  stages: any[] | null;
}) {
  const { request, photos, isHvac, stages } = props;
  const [viewer, setViewer] = React.useState(null);

  if (!photos || photos.length === 0) return null;

  const groups = isHvac ? groupHvacPhotos(photos, stages) : groupServicePhotos(photos);

  // 大图查看器的序列 = 所有分组的照片按展示顺序拼接
  const flat: ArchivePhoto[] = groups.reduce<ArchivePhoto[]>((acc, g) => acc.concat(g.photos), []);
  const indexOf = (p: ArchivePhoto) => flat.findIndex((x) => x.id === p.id);

  return h(
    'div',
    { 'data-testid': 'sa2-photo-gallery' },
    groups.map((g) =>
      h('div', { key: g.key, style: { marginBottom: 14 }, 'data-testid': `sa2-photo-group-${g.key}` },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          h('span', { style: { fontSize: 13, fontWeight: 600, color: '#262626' } }, g.label),
          h(Tag, { color: 'blue', style: { marginInlineEnd: 0 } }, `${g.photos.length} 张`),
        ),
        // 4 列自适应：minmax(0,1fr) 保证不会被长内容撑破产生横向溢出
        h('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            gap: 8,
          },
        },
          g.photos.map((p) =>
            h(PhotoThumb, {
              key: p.id,
              request,
              photo: p,
              onClick: () => setViewer(indexOf(p)),
            }),
          ),
        ),
      ),
    ),
    viewer !== null && viewer >= 0
      ? h(PhotoViewer, {
          request,
          photos: flat,
          index: viewer,
          onIndex: setViewer,
          onClose: () => setViewer(null),
        })
      : null,
  );
}

// `h` 在本仓库是手搓的 hyperscript（见主文件说明：react 是无体 stub，
// 不能用 JSX，也不能引 React.createElement 的类型断言）。
function h(type: any, props: any, ...children: any[]): any {
  return React.createElement(type, props, ...children);
}
