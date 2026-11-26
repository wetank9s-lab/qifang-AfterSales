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

/**
 * 暖通六阶段：**只在这里保存稳定编码与展示顺序**。
 *
 * 🔴 R2.2.4-rc.9 修（用户第三节原文）：
 *    「此前已明确要求阶段名称读取后台施工阶段配置。使用稳定的六阶段编码进行分组，
 *      显示名称复用现有阶段名称配置及默认回退逻辑。」
 *
 *    旧实现把这个常量写成了 `{ code, label: '勘察' }`，label 是**硬编码中文简称**。
 *    后果：后台把「管路施工」改成「管路与开槽」之后，
 *      · 移动端时间线（读 `svc:archiveStageConfigGet`）显示新名
 *      · 后台照片分组（读这里）仍显示「布管」
 *    同一份档案在两个端上是两个叫法，而那正是用户点名要修的问题。
 *
 * ⇒ 现在这里**只保留 code 与顺序**（它们是不可改的机器码，来自
 *   `ARCHIVE_STAGE_ORDER`），显示名一律由调用方传入的 `stageNames` 解析；
 *   缺配置时回退 `DEFAULT_STAGE_LABEL`（= 服务端 `ARCHIVE_STAGE_LABEL` 的同源副本）。
 */
export const HVAC_STAGE_CODES: ReadonlyArray<string> = [
  'survey',
  'plan',
  'pipe',
  'device',
  'test',
  'accept',
];

/**
 * 代码默认名。**仅作兜底**，不是展示来源。
 *
 * 与 `server/constants.ts::ARCHIVE_STAGE_LABEL` 保持同值 —— 后端那份是唯一权威，
 * 这里只是"配置读不到时不要出现空标题"的同源副本。
 * ⚠️ 不要在任何渲染路径直接用它：走 `resolveStageLabel()`。
 */
export const DEFAULT_STAGE_LABEL: Readonly<Record<string, string>> = {
  survey: '勘察',
  plan: '方案',
  pipe: '布管',
  device: '安装',
  test: '调试',
  accept: '验收',
};

/**
 * 阶段显示名解析：**后台配置优先 → 代码默认名 → code 原文**。
 *
 * 三级回退的理由（每一级都对应一个真实会发生的状态）：
 *   ① 配置里有值 ⇒ 用后台改过的名字（用户的诉求）
 *   ② 配置读失败 / 服务端少给这个 code ⇒ 用默认名，**不显示空串**
 *      （空标题会让员工以为那一行渲染坏了）
 *   ③ 连默认名都没有（未来新增了 code 但没同步这里）⇒ 显示 code 本身，
 *      至少能看出"有这么一组"，而不是一个空白组。
 *
 * ⚠️ 与移动端 `stageNameOf()` 完全同构 —— 两端必须用同一条回退链，
 *    否则又会出现"手机显示新名、电脑显示默认名"的分叉。
 */
export function resolveStageLabel(code: string, stageNames?: Record<string, string> | null): string {
  const configured = String(stageNames?.[code] ?? '').trim();
  if (configured) return configured;
  return DEFAULT_STAGE_LABEL[code] || code;
}

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
    /*
     * 未发布角标。
     *
     * ===================================================================
     * 数据来源核实（用户 rc.6 第一节：「保留照片发布状态标识，但要核实
     * 它的来源是否符合既有照片发布规则」）
     * ===================================================================
     *  `photo.published` 来自 `archive-photo-service.ts::project()` 的
     *  `published: Boolean(row.published)` —— 直接读 `service_archive_photos.published`
     *  列，**不经过任何前端计算、不按阶段状态二次推断**。该列的定义（collections/
     *  serviceArchivePhotos.ts）：
     *
     *    `bool('published', '可对客户公开', { allowNull: false, defaultValue: false })`
     *
     *  既有发布规则的完整链路（逐条对照，全部成立）：
     *   ① **上传即未发布**：`upload()` 写死 `published: false`（service 第 39 行铁律），
     *      客户端上传体刻意不带 published（archive-edit-block.tsx 第 1005 行注释）。
     *      ⇒ 角标在"刚传完"时出现「未发布」是**正确**的，不是误报。
     *   ② **发布是独立动作**：只有 `svc:archivePhotoPublish` 会改它；
     *      阶段完成 / 档案发布 / 撤回都**不碰**这一列。
     *      （`archive-edit-block.tsx` 第 1195–1196 行明确写了"阶段完成接口不碰它"。）
     *   ③ **发布要求阶段已 done**：`setPublished(true)` 把阶段条件写进 UPDATE 的
     *      WHERE（原子性，见 service 第 305–317 行），阶段未完成 ⇒ 409。
     *      ⇒ 暖通阶段照片在阶段完成前一律「未发布」，与角标显示一致。
     *   ④ **取消发布永远允许**（撤回场景），所以撤回后角标回到「未发布」。
     *      ⚠️ 撤回时阶段状态是 `withdrawn` 而照片被置 false ——
     *      此时"未发布"是对的，但**不代表照片不存在**：内部投影不过滤 published，
     *      后台仍能看到它。这正是用户要求的"内部可见、不误导游成客户能看"。
     *
     *  ⇒ 结论：**角标来源符合既有照片发布规则，无需改动**。它表达的是
     *    "客户侧看不到这张"，不是"这张图坏了/没加载出来"。
     *    为了让员工不把两者混淆，文字用「未发布」而不用「不可见/失败」，
     *    并在总数量条里同步给出「已发布 N / 未发布 M」。
     */
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
 *
 * `stageNames` 是后台配置的显示名映射（`svc:archiveStageConfigGet` 的 `stages[].name`）。
 * 🔴 **分组键永远是稳定编码 `code`**，显示名只是"画在标题上的字"。
 *    如果用显示名当 key（例如用「布管」当 key），后台一改名，
 *    照片就会因为 key 对不上而全部掉进「未分类」—— 那是把装饰性配置
 *    变成了影响数据归属的东西，绝对不能这么做。
 */
export function groupHvacPhotos(
  photos: ArchivePhoto[],
  stages: any[] | null,
  stageNames?: Record<string, string> | null,
): Group[] {
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
  for (const code of HVAC_STAGE_CODES) {
    const arr = buckets.get(code);
    // ⚠️ 空分组不渲染：没有照片的阶段不该出现一个「0 张」的空相册
    if (arr && arr.length) out.push({ key: code, label: resolveStageLabel(code, stageNames), photos: arr });
  }
  // 未知 code（理论上不该出现，但服务端阶段表可能带自定义）也保留，放在末位
  for (const [code, arr] of buckets) {
    if (!HVAC_STAGE_CODES.includes(code) && arr.length) {
      out.push({ key: code, label: resolveStageLabel(code, stageNames), photos: arr });
    }
  }
  if (orphan.length) out.push({ key: '__orphan', label: '未分类', photos: orphan });
  return out;
}

/**
 * 普通上门服务分组：**后台保持平铺单组**。
 *
 * 🔴 R2.2.4-rc.9 说明（用户第二节原文）：
 *    「修复**移动端**普通上门服务照片错误分类」—— 问题定位在手机端 bundle
 *    复用了暖通阶段分组逻辑。同一节的末尾又明确：
 *    「**电脑后台普通上门服务现有平铺展示可以保留，不强制重新设计**。」
 *
 * ⇒ 所以这里刻意**不**按 `before/after` 拆分：
 *    后台的用途是"快速扫一眼这家店拍了什么"，一屏铺开比两组更省一次滑动；
 *    而手机端是给客户看"服务前后对照"的证据，才需要分组。
 *    两端用途不同，分组粒度不同是**设计选择**，不是遗漏。
 *
 * ⚠️ 如果将来后台也要分组，改这里即可；但那时要同步更新本注释与验收判据，
 *    不要出现"代码改了、验收还在按平铺断言"这种自欺。
 */
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
  /** 后台配置的阶段显示名（`code → name`）。暖通分组标题用它；普通服务不读。 */
  stageNames?: Record<string, string> | null;
}) {
  const { request, photos, isHvac, stages, stageNames } = props;
  const [viewer, setViewer] = React.useState(null);

  if (!photos || photos.length === 0) return null;

  const groups = isHvac ? groupHvacPhotos(photos, stages, stageNames) : groupServicePhotos(photos);

  // 大图查看器的序列 = 所有分组的照片按展示顺序拼接
  const flat: ArchivePhoto[] = groups.reduce<ArchivePhoto[]>((acc, g) => acc.concat(g.photos), []);
  const indexOf = (p: ArchivePhoto) => flat.findIndex((x) => x.id === p.id);

  /**
   * 「共 N 张」的总数量。
   *
   * 🔴 为什么必须是 `flat.length` 而不是 `photos.length`、也不是各分组张数之和（两者在
   *    当前实现下恒等，但语义不同，将来的改动只会动其中一边）：
   *      · 用户看到的就是下面铺出来的这些格子 —— `flat` 是它们**被渲染出来的完整集合**，
   *        并且与大图查看器的 `index 1/N` 分母是**同一个数**。
   *      · 若哪天分组逻辑开始丢弃照片（例如按权限或按类型过滤），`photos.length` 会
   *        比实际铺出来的多，标题写「共 7 张」而页面上只有 5 张 ⇒ 员工会以为加载失败。
   *      · 反过来若将来出现「同一张照片命中多个阶段」的渲染，`flat` 会多于 `photos`，
   *        那时标题跟着实际数量走才是对的。
   *    ⇒ 一句话：**标题的数字必须等于眼睛能数到的格子数**。
   */
  const total = flat.length;

  /**
   * 已发布张数。只用于在角标之外给一个可核对的概览：
   * 施工照片上传即 `published=false`（`archive-photo-service.ts` 第 39 行铁律），
   * 发布是移动端/后台的独立动作（`archivePhotoPublish`），所以「共 7 张 / 已发布 3 张」
   * 是**真实状态**，不是"加载失败"。
   */
  const publishedCount = flat.filter((p) => p.published === true).length;

  return h(
    'div',
    { 'data-testid': 'sa2-photo-gallery' },
    // ---- 总数量条（用户 rc.6 第一节原文：「施工照片标题增加总数量，例如 施工照片 · 共7张」）----
    //  用独立一行而不是塞进 InfoSection 标题：InfoSection 的 title 是纯字符串，
    //  塞 "施工照片 · 共7张" 之后就没有地方单独打 data-testid 给验收脚本按数字断言了，
    //  而"数字对不对"恰好是最容易出错、最需要被自动核对的那个点。
    h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid #f5f5f5',
      },
      'data-testid': 'sa2-photo-total',
    },
      h('span', { style: { fontSize: 12, color: '#595959' } }, `共 ${total} 张`),
      publishedCount > 0
        ? h('span', {
            style: { fontSize: 12, color: '#389e0d' },
            'data-testid': 'sa2-photo-published-count',
          }, `已发布 ${publishedCount} 张`)
        : null,
      publishedCount < total
        ? h('span', {
            style: { fontSize: 12, color: '#8c8c8c' },
            'data-testid': 'sa2-photo-unpublished-count',
          }, `未发布 ${total - publishedCount} 张`)
        : null,
    ),
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
