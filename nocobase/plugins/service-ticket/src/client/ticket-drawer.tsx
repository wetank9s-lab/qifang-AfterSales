/**
 * H3 —— 工单详情**只读抽屉**（"单张工单工作台"）
 *
 * 为什么是一个自己渲染的 React 组件，而不是 NocoBase 的蓝图弹窗：
 *   DEV-53 已取证：`applyBlueprint` 会把弹窗编译成一个 `defaults` 为 `undefined`
 *   的 compose 步骤，弹窗内区块的默认 `edit` 动作必然 400；而唯一的豁免路径
 *   要求"恰好 1 个 editForm"的内联 edit popup —— 那等于给工单开一个
 *   **绕过状态机的表单**，是设计禁止项。所以详情只能客户端自渲染。
 *
 * 为什么是**只读**：
 *   写操作只有四个业务按钮（受理/派工/改派/改约，见 ticket-actions.tsx），
 *   且一律走 `/api/svc:*`，由服务端 PermissionService + 状态机裁决。
 *   本组件不渲染任何表单、不提交任何写请求 —— 它不是"另一个改状态的入口"。
 *
 * ---------------------------------------------------------------------------
 * 区块（Phase 4-I 第二轮走查后重排；P6-0 追加一个**条件区块**）
 * ---------------------------------------------------------------------------
 * 目标**不是"把数据库字段摆出来"**，而是让门店同事 30 秒内回答四个问题：
 *   A 顶部摘要      → 这是哪张单、什么状态、什么时候建的
 *   B 客户与问题    → 客户是什么问题
 *   C 当前服务      → 现在谁负责、哪天上门（**只显示当前 active Visit**）
 *   C.5 技师回执    → 师傅这次干了什么、要多少钱、有哪些照片（**只在有待确认回执时出现**）
 *   D 处理记录      → 之前发生了什么（历史 Visit 的变化 = 时间线，不再单列一张表）
 *
 * ⚠️ C.5 是 Phase 6 · P6-0 加的**只读**区块（`docs/PHASE-6.md` §6.3）：
 *    它由 `submittedVisitOf()` 决定是否渲染，因此**不影响**任何非
 *    `WAIT_STORE_CONFIRM` 工单的渲染与请求数。它里面**没有**确认/驳回按钮
 *    （那是 P6-1），也不提供金额输入框 —— 本文件依旧不渲染任何表单。
 *
 * ⚠️ 三条整改纪律（都来自真人反馈，见 docs/PHASE-4-I-UAT.md §5）：
 *   ① **不做指标墙**：时效只给"当前这一步"的一句话（`statusTimelinessLine`）。
 *      原实现一次给四行（耗时/首响/预约/倒计时），真人反馈"信息层级混乱"。
 *   ② **不展示内部字段与枚举**：见 `ticket-display.ts` 的 `DETAIL_HIDDEN_FIELDS`
 *      与 `eventActionText()`。**隐藏 ≠ 删除**，原始审计数据仍在库里。
 *   ③ **同一件事只说一次**：当前 Visit 进「当前服务」；历史 Visit 的业务变化
 *      通过时间线表达 —— 不再并列"派工历史表 + 事件时间线"（同一件事说两遍）。
 *      原 Visit 因而**不需要**让一线同事理解 SUPERSEDED 这个词。
 *
 * ⚠️ 依赖纪律（很重要）：
 *   这里只 import **已确认在运行时可解析**的模块：`react` / `react-dom` / `antd`。
 *   列表与排版一律用**原生 HTML + 内联样式**，刻意不用 antd 的
 *   Descriptions / Timeline —— 这两个组件在 antd v4/v5 之间 `items` 与 `children`
 *   写法不兼容，一旦踩错就是整个抽屉渲染不出来（而这在接口断言里看不出来）。
 *   同理 `Drawer` 用 v5 的 `open`（NocoBase 2.2.15 用 antd v5）。
 */
import React, { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
// ⚠️ `message` **必须**从 `antd` 导入 —— 见下方 DEV-147：从 `@nocobase/client` 导入会拿到
//    `undefined`（那个包不导出它），症状是"写成功了、但提示那句抛错"。
//    插件内 primary-action / ticket-actions / ticket-store-review / store-entry-action
//    四个文件**全都**从 antd 导入 —— 这一处曾经是唯一的例外。
import { Alert, Button, Drawer, Empty, Input, Modal, Spin, Tag, message } from 'antd';
// 🔴 请求号**必须**用共享实现：仓库里 `shared/svc-request.ts` 早就有 `newRequestId()`
//    （带 `crypto.randomUUID` 缺失时的 `getRandomValues` 兜底），
//    `primary-action.tsx` / `ticket-actions.tsx` 都用它。
//    ⚠️ 2026-10-10 实测事故：本文件**只写了 `newRequestId()` 却没 import** ⇒
//      抽屉渲染期直接 `ReferenceError`，表现为"点了查看抽屉不出现"（DEV-145）。
//    ⚠️ `sendSvcRequest` 还带 2 次重试，与本插件其它写动作同一条路径 ——
//      自己拼 URL/headers 等于第二套实现（同一个坑两条腿）。
import { newRequestId, sendSvcRequest } from '../shared/svc-request';

// 状态中文名直接复用服务端的常量（server/constants.ts 是**零 import 的纯常量**文件，
// 客户端引用它是安全的，也避免"界面标签与服务端各写一份"的漂移）。
import { TICKET_STATUS, TICKET_STATUS_LABEL, TICKET_TYPE_LABEL } from '../server/constants';
import { formatAppointmentDate, statusTimelinessLine } from './timeliness';
import {
  activeVisitOf,
  buildTimeline,
  formatStamp,
  serviceModeText,
  submittedVisitOf,
  visitStatusText,
} from './ticket-display';
// P6-0：门店回执**只读**区块（确认/驳回是 P6-1，本文件与那个区块都不实现）
import { StoreReviewSection } from './ticket-store-review';
// Phase 11 / P11-1：家电分类的**落库值 → 中文文案**。取自共享契约，
// 不在本文件再写一份映射（同一份枚举三处各写一遍是本项目已经付过代价的坑）。
import { applianceCategoryLabel } from '../shared/appliance-category';

/**
 * 注入的请求函数：给定**资源路径**（`svc:timeline?...`，**不含 `/api` 前缀**）
 * 返回解析后的 JSON。
 *
 * ⚠️ 这里的注释原本写的是"给定 URL（含 /api 前缀）"—— 那句描述是错的，
 *    而它直接把调用方带进了 404：实现（`app.apiClient.request`）自己会补 `/api`，
 *    调用方再补一次就成了 `/api/api/...`。
 *    凡是"注释描述与实际实现不一致"的地方，迟早会产生一个只在这条路径上的缺陷。
 *
 * ⚠️ 后三个参数（method / body / options）是 P6-0 新增的**最小加宽**：
 *    「技师回执」区块里的照片走 `authenticated fetch → Blob`（§4.3a），
 *    必须能传 `responseType: 'blob'` —— 而 blob 只有走**同一个带登录态的请求器**
 *    才带得上 Authorization。这里刻意**不引入第二个请求器**：
 *    两条取数路径一旦分家，"401 自动跳登录"这类统一行为就会只覆盖其中一条。
 *    现有调用（`request(url)`）行为完全不变（method 默认 'get'）。
 */
export type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

export interface TicketDrawerOptions {
  ticketId: number | string;
  request: Requester;
  /**
   * 抽屉的 z-index。由 `openTicketDrawer` 按"当前已打开浮层的最高层 + 1"算出
   * （P0 根因修复：本抽屉渲染在应用树之外，拿不到宿主 ConfigProvider 的层级 ⇒ 必须显式对齐）。
   */
  zIndex?: number;
}

interface DrawerState {
  loading: boolean;
  error: string | null;
  ticket: any;
  events: any[];
  visits: any[];
  /** UX-01A：当前账号能否写工单（服务端 `svc:timeline` 回的 `can_write`）—— 决定是否显示"添加内部备注" */
  canWrite: boolean;
  /** UX-MEDIA-01：客户上传的媒体清单（只含元数据，**没有** storage_key / 文件名） */
  media: Array<{
    id: number;
    kind: string;
    mime: string;
    size: number;
    durationMs: number | null;
    width: number | null;
    height: number | null;
  }>;
  /**
   * UX-MEDIA-01：媒体清单被**明确拒绝**（403）。
   *
   * viewer 不具备 `WRITE_TICKET` ⇒ 服务端 403。UI 必须把这种情况与"读取失败"
   * 区分开：前者**静默不渲染**（不是错误），后者要给可重试的提示。
   * 也不能因为"看不到媒体"就显示一块空区块 —— 那等于告诉只读角色"这里有东西你看不到"。
   */
  mediaDenied: boolean;
  /** 媒体清单读取失败（网络/500）—— 只有这类才在界面上报错并给重试 */
  mediaError: string | null;
}

const SECTION_TITLE: React.CSSProperties = {
  fontWeight: 600,
  margin: '18px 0 8px',
  paddingBottom: 6,
  borderBottom: '1px solid #f0f0f0',
};

const ROW: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  padding: '5px 0',
  fontSize: 13,
  lineHeight: 1.6,
};

const KEY: React.CSSProperties = { width: 96, flex: '0 0 96px', color: '#8c8c8c' };

const VAL: React.CSSProperties = { flex: 1, wordBreak: 'break-all' };

/** 客户提交的原始描述：保留换行，块级展示（不是"某个字段"，而是一段话） */
const PARAGRAPH: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  background: '#fafafa',
  border: '1px solid #f0f0f0',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 13,
  lineHeight: 1.7,
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={ROW}>
      <div style={KEY}>{label}</div>
      <div style={VAL}>{children}</div>
    </div>
  );
}

/** 门店：优先显示名字；关系没被载入时退到门店编码（业务可读，非内部主键） */
function storeText(t: any): string {
  return t?.store?.name ?? t?.store?.code ?? t?.source_store_code ?? '—';
}

/**
 * UX-01A：「添加内部备注」—— 详情里唯一允许**写**的区块，且它**只追加一条事件**：
 * 不改状态、不重开、不派工、不发短信、不动 next_follow_at。
 *
 * ⚠️ 它与本文件头部"本组件不渲染任何表单、不是另一个改状态的入口"的纪律
 *    **并存而不冲突**：那条纪律针对的是"改工单状态的表单"；而这是 append-only 的备注，
 *    走 `svc:internalNote`（服务端只写 `ticketEvents`，一个工单字段都不碰）。
 *    内部备注**与业务跟进（`svc:followUp`）是两个动作**，刻意分开。
 */
function NoteComposer({
  ticketId,
  request,
  onAdded,
}: {
  ticketId: number | string;
  request: Requester;
  onAdded: () => void;
}) {
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async (): Promise<void> => {
    const text = note.trim();
    if (!text) {
      message.error('请填写内部备注内容');
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      await sendSvcRequest(request as any, {
        action: 'internalNote',
        ticketId: ticketId as number,
        body: { note: text },
        requestId: newRequestId(),
      });
      message.success('已添加内部备注');
      setNote('');
      onAdded();
    } catch (error: any) {
      message.error(
        `添加内部备注失败：${error?.response?.data?.message ?? error?.message ?? error}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="internal-note-composer" style={{ marginBottom: 10 }}>
      <Input.TextArea
        data-testid="internal-note-input"
        rows={2}
        maxLength={500}
        placeholder="内部备注（仅门店 / 总部可见，不会通知客户或师傅）：例如「已电话回访，客户满意」"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div style={{ marginTop: 6 }}>
        <Button
          size="small"
          type="primary"
          data-testid="internal-note-submit"
          loading={busy}
          onClick={() => void submit()}
        >
          添加内部备注
        </Button>
      </div>
    </div>
  );
}

/**
 * UX-MEDIA-01：客户提交材料的**单条**渲染。
 *
 * 三类媒体共用同一条取数路径：`authenticated request → Blob → objectURL`。
 *
 * 为什么不用 `<img src="/api/svc:ticketMediaFile?id=...">` 直接指过去：
 *   `<img>/<audio>/<video>` 发出的请求**带不上 Authorization 头**（本插件的登录态
 *   走 Bearer），而客户媒体又**不允许**做成签名 URL / 公开 URL。
 *   这与技师回执照片（`PhotoThumb`）是同一个已裁决过的做法（PHASE-6 §4.3a），
 *   不另造第二套。代价是整份文件进内存（服务端限制单文件 ≤ 8MB），可接受。
 *
 * blob 生命周期收在本组件里（与 `PhotoThumb` 同纪律）：
 *   散在父组件写就会"换了工单旧 blob 没释放"或"释放早了图变白"。
 */
function CustomerMediaItem({
  item,
  index,
  request,
  zIndex,
}: {
  item: DrawerState['media'][number];
  index: number;
  request: Requester;
  zIndex?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    let alive = true;
    let created: string | null = null;
    (async () => {
      try {
        // 路径不带 `/api` 前缀（apiClient 自己补），否则会变成 `/api/api/...` → 404
        const blob = await request(`svc:ticketMediaFile?id=${item.id}`, 'get', undefined, {
          responseType: 'blob',
        });
        if (!alive) return;
        if (!(blob instanceof Blob)) throw new Error('响应不是媒体文件');
        created = URL.createObjectURL(blob);
        setUrl(created);
      } catch (e) {
        if (alive) setError((e as Error)?.message ?? String(e));
      }
    })();
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [item.id, request]);

  const kindCap = item.kind === 'image' ? '照片' : item.kind === 'audio' ? '录音' : item.kind === 'video' ? '视频' : '材料';
  const caption = `${kindCap} ${index + 1} · ${fmtBytes(item.size)}${
    item.durationMs ? ` · ${fmtDuration(item.durationMs)}` : ''
  }`;

  if (error) {
    return (
      <div
        data-testid="customer-media-error"
        style={{ ...MEDIA_BOX, color: '#cf1322', borderColor: '#ffccc7', fontSize: 12 }}
      >
        读取失败：{error}
      </div>
    );
  }
  if (!url) {
    return (
      <div style={{ ...MEDIA_BOX, background: '#fafafa' }}>
        <Spin size="small" />
      </div>
    );
  }

  if (item.kind === 'image') {
    return (
      <>
        <button
          type="button"
          data-testid="customer-media-image"
          aria-label={`查看${caption}`}
          onClick={() => setPreview(true)}
          style={{ ...MEDIA_BOX, padding: 0, cursor: 'zoom-in', overflow: 'hidden' }}
        >
          <img
            src={url}
            alt={caption}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </button>
        <Modal
          open={preview}
          footer={null}
          onCancel={() => setPreview(false)}
          width={760}
          // 抽屉是"浮层之上的浮层"：预览必须比抽屉更高，否则被遮住（UX-01A P0 同型问题）
          zIndex={(zIndex ?? 1000) + 10}
          title={caption}
          destroyOnClose
        >
          <img src={url} alt={caption} style={{ width: '100%', display: 'block' }} />
        </Modal>
      </>
    );
  }

  if (item.kind === 'audio') {
    return (
      <div data-testid="customer-media-audio" style={{ ...MEDIA_BOX, width: 420, height: 'auto', padding: 8 }}>
        <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 4 }}>{caption}</div>
        <audio src={url} controls preload="metadata" style={{ width: '100%' }} />
      </div>
    );
  }

  if (item.kind === 'video') {
    return (
      <div data-testid="customer-media-video" style={{ ...MEDIA_BOX, width: 420, height: 'auto', padding: 8 }}>
        <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 4 }}>{caption}</div>
        <video src={url} controls playsInline preload="metadata" style={{ width: '100%', borderRadius: 4 }} />
      </div>
    );
  }

  // 未知类型：不猜怎么渲染，只给一条可下载的说明（避免"空白但以为没传"）
  return (
    <div data-testid="customer-media-unknown" style={{ ...MEDIA_BOX, width: 420, height: 'auto', padding: 8, fontSize: 12 }}>
      {caption}（暂不支持预览）
    </div>
  );
}

const MEDIA_BOX: React.CSSProperties = {
  width: 220,
  height: 160,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid #f0f0f0',
  borderRadius: 6,
  background: '#fff',
};

function fmtBytes(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

function fmtDuration(ms: number): string {
  const total = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(total) || total < 0) return '时长未知';
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function TicketDrawer({ ticketId, request, zIndex, onClose }: TicketDrawerOptions & { onClose: () => void }) {
  const [state, setState] = useState<DrawerState>({
    loading: true,
    error: null,
    ticket: null,
    events: [],
    visits: [],
    canWrite: false,
    media: [],
    mediaDenied: false,
    mediaError: null,
  });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));

    // 两个请求的地址先落成常量，便于：
    //   ① 失败时把**实际请求的地址**写进错误文案（见下）；
    //   ② 静态断言能直接锚定这两个字符串（不靠运行时拼接）。
    const timelineUrl = `svc:timeline?filterByTk=${ticketId}&pageSize=50`;
    const visitsUrl = `svc:visits?filterByTk=${ticketId}`;

    /**
     * 给每个请求包一层"把 URL 带进错误里"的壳。
     *
     * 为什么值得写进 UI（Phase 4-I 第三轮关于「详情 404」的真教训）：
     *   真人报"详情打不开"时，最缺的从来不是"它坏了"，而是**那一行 Request URL**。
     *   把 URL 直接放进错误态，下一次走查**不用开 DevTools 也能说清是哪个地址失败**。
     *   （当时为了拿到这个 URL，花了整轮时间在"猜是不是 /api 前缀"上。）
     */
    const withUrl = async (url: string) => {
      try {
        return await request(url);
      } catch (e) {
        throw new Error(`${url} → ${(e as Error)?.message ?? String(e)}`);
      }
    };

    try {
      // 两个请求都**按 ticket_id 在服务端查**，不下载全量再过滤 ——
      // 既省数据，也继续沿用服务端的对象级权限（越权与不存在统一 404）。
      //
      // ⚠️⚠️ 路径**不带 `/api` 前缀**（`svc:timeline` 而不是 `/api/svc:timeline`）。
      //    注入的 `request` 最终走 `app.apiClient.request()`，它会自己补 `/api`。
      //    这里曾经写成 `/api/svc:timeline`，于是真实请求是
      //    `GET /api/api/svc:timeline` → **404 api resource does not exist** →
      //    抽屉永远显示"加载失败"。而 HTTP 断言、产物断言、结构断言全绿 ——
      //    因为**没有任何一条断言看过"浏览器发出的那个 URL"**。
      //    这是"呈现层"缺断言的典型：写动作走 svc-request.ts（本来就无前缀）所以正常，
      //    抽屉是唯一手写 URL 的地方，也就唯一会犯这个错。
      //    现在由 verify-client-logic 的"抽屉请求路径"断言 + preflight §3.7
      //    （真的点一次详情、既看文字也看网络状态码）两面盯住。
      //
      // ⚠️⚠️ 光改这里**还不够**（DEV-74）：nginx 曾对 `/static/plugins/` 发 7 天长缓存，
      //    而产物 URL 不含内容哈希 → 浏览器会**一直跑旧产物**，
      //    症状就是"代码已经修好、真人打开仍然 404"。
      //    现已改为 `no-cache`（每次回源校验、未变则 304），详见
      //    `nginx/conf.d/service.conf` 的 `/static/plugins/` 段。
      const [timeline, visits] = await Promise.all([
        withUrl(timelineUrl),
        withUrl(visitsUrl),
      ]);

      /**
       * UX-MEDIA-01：客户媒体清单**单独取**，且**失败不拖垮抽屉**。
       *
       * 三个理由（都对应一个具体坏法）：
       *   ① viewer 会拿到 403 —— 它不是"详情加载失败"，不能把整个抽屉变成红框；
       *   ② 历史工单可能早于 P11-4（没有媒体），404/空集都应按"没有"处理；
       *   ③ 媒体是**补充材料**，不是工单主体。它坏了也要能看见客户与状态，
       *      否则一次媒体接口故障会把整个售后处理挡死。
       *
       * 🔴 2026-10-17 实测（门店门禁 ①b 抓到的回归）：
       *    第一版把媒体请求 **await 在主请求之后**，于是 `loading` 多挂了约 100ms ——
       *    抽屉在这段时间里 `ticket=null`，标题显示回退值「工单 #6673」而不是工单号。
       *    那不是"门禁太严"，而是**媒体把主体信息挡住了**。
       *    ⇒ 先把 timeline/visits 落进 state（标题与客户信息立刻正确），
       *      媒体**随后**补进来；它的失败只影响媒体区块自己。
       */
      setState({
        loading: false,
        error: null,
        ticket: timeline?.data?.ticket ?? null,
        events: timeline?.data?.events ?? [],
        visits: visits?.data?.visits ?? [],
        // 只有服务端说"能写"才显示备注入口 —— 与后端 assertCanWriteTicket 同一判据
        canWrite: timeline?.data?.can_write === true,
        media: [],
        mediaDenied: false,
        mediaError: null,
      });

      let media: DrawerState['media'] = [];
      let mediaDenied = false;
      let mediaError: string | null = null;
      try {
        const res = await request(`svc:ticketMedia?filterByTk=${ticketId}`);
        const payload = res && typeof res === 'object' && 'data' in res ? (res as any).data : res;
        media = Array.isArray(payload?.media) ? payload.media : [];
      } catch (e: any) {
        const status = Number(e?.response?.status ?? e?.status ?? 0);
        if (status === 403) mediaDenied = true;
        else if (status === 404) media = [];
        else mediaError = String(e?.message ?? e);
      }
      setState((s) => ({ ...s, media, mediaDenied, mediaError }));
    } catch (error) {
      setState({
        loading: false,
        error: (error as Error)?.message ?? String(error),
        ticket: null,
        events: [],
        visits: [],
        canWrite: false,
        media: [],
        mediaDenied: false,
        mediaError: null,
      });
    }
  }, [ticketId, request]);

  useEffect(() => {
    void load();
  }, [load]);

  const t = state.ticket ?? {};
  const status = String(t.status ?? '');
  const statusText = (TICKET_STATUS_LABEL as any)[status] ?? status ?? '—';
  const typeText = (TICKET_TYPE_LABEL as any)[t.ticket_type] ?? '—';

  // 「当前服务」= 唯一那条仍然有效的 Visit（被取代/取消的历史 Visit 不进这里）
  const currentVisit = activeVisitOf(state.visits);
  const currentExpectedAt = currentVisit?.expected_visit_at;

  // P6-0：**审核对象** = 当前 `SUBMITTED` 的那条 Visit（`docs/PHASE-6.md` §4.1）。
  // ⚠️ 刻意不用 `currentVisit` 代替 —— 两者判据不同：`currentVisit` 是
  //    "现在谁负责"（排除终态、取 visit_no 最大），而审核对象是"谁在等门店确认"
  //    （**只由状态决定**）。改派会让旧 Visit 转 SUPERSEDED 且两条并存，
  //    用顺序猜会把已被取代的历史回执当成待审核对象。
  const submittedVisit = submittedVisitOf(state.visits);

  // 时效：**一句话**，内容由当前状态决定（见 timeliness.ts）
  const timelinessLine = statusTimelinessLine({
    status,
    createdAt: t.createdAt ?? t.created_at,
    expectedVisitAt: currentExpectedAt ?? t.expected_visit_at,
    closedAt: t.closed_at,
    completedAt: t.completed_at,
    events: state.events,
  });

  /**
   * 调整**已有工单**的紧急标记（Phase 11 / P11-2 · 用户 2026-10-10 第 3 项）。
   *
   * 用户要求："在服务详情中提供**简洁**的紧急/普通调整入口，按原有门店写权限裁决，
   * 记录原值、新值及操作者。**不得为此增加列表按钮墙**；跨店调整必须拒绝，
   * 终态工单不得无依据修改。"
   *
   * 三条实现选择（都对应上面的原话）：
   *   ① 入口放在**详情抽屉的顶部摘要**里 —— 它紧挨着"紧急"那个红 Tag，
   *      是"看到它、就想改它"的同一个位置；列表行内动作**一个字不加**；
   *   ② **终态（已闭环 / 已取消）时先要原因**：用一个带输入框的确认弹窗收原因，
   *      非终态则一句话确认即可（一线改标记是日常操作，不该每次都写原因）；
   *   ③ 权限**不在前端判**：直接发请求，403/404 由服务端裁决并原样显示
   *      （前端猜权限 = 迟早与服务端分叉，见 DEV-139 的教训）。
   *
   * ⚠️ 终态判定用**服务端返回的 status**，不是本地猜的 —— 抽屉打开与点击之间状态可能已经变了。
   */
  const toggleUrgent = useCallback(
    async (next: boolean) => {
      const current = state.ticket;
      if (!current) return;
      const status = String(current.status ?? '');
      const terminal = status === 'CLOSED' || status === 'CANCELLED';

      /**
       * 发一次请求（把"要原因"的判断留在这里，服务端仍会独立校验一次）。
       *
       * 🔴 **2026-10-10 实测（DEV-146）**：第一版写完只做
       *    `setState(prev => ({...prev, ticket: {...prev.ticket, urgent: next}}))`，
       *    然后 `void load()` 整体重载 —— 结果**第二次点击时组件读到的 `urgent` 仍是旧值**，
       *    于是"取消紧急"又被当成"设为紧急"（确认弹窗标题仍是「标记为紧急？」）。
       *    两种可能：① `load()` 读回的是**过期数据**把我刚写对的值覆盖了；
       *             ② 状态更新被 `load()` 的返回值盖掉。
       *    ⇒ 无论哪一种，**同一字段的真相只有一个来源**：
       *      **刚才那次变更的响应**。它明确回了 `urgent: true/false`，比"再读一次"权威。
       *      重载仍然保留（时间线要刷新），但**以响应为准**这一点不再依赖重读。
       *    ⚠️ 这也正是用户要求第 9 条"关闭、重新打开详情，紧急状态仍正确"的同一件事：
       *      如果读回真的会过期，那不只是组件状态问题，**重开详情也会显示错的紧急状态** ——
       *      所以下面的门禁里专门有一条"重开详情再核对"，不许只测内存状态。
       */
      const send = async (reason: string): Promise<void> => {
        try {
          const res = await sendSvcRequest(request, {
            action: 'setUrgent',
            ticketId,
            body: {
              urgent: next,
              ...(reason ? { reason } : {}),
            },
            requestId: newRequestId(),
          });
          // ⚠️ 注入的 request 返回的是**响应信封** ⇒ 多剥一层 `.data`（本项目已踩过两次）
          const payload = res && typeof res === 'object' && 'data' in res ? (res as any).data : res;
          const nowUrgent = payload?.urgent === true;

          message.success(next ? '已标记为紧急' : '已取消紧急标记');

          // 🔴 **以变更响应为准**更新这个字段，见下面的"为什么"。
          setState((prev) => ({ ...prev, ticket: { ...prev.ticket, urgent: nowUrgent } }));
          void load();
        } catch (error: any) {
          message.error(
            `调整紧急标记失败：${error?.response?.data?.message ?? error?.message ?? error}`,
          );
        }
      };

      if (!terminal) {
        Modal.confirm({
          title: next ? '标记为紧急？' : '取消紧急标记？',
          icon: null,
          closable: true,
          okText: '确定',
          cancelText: '取消',
          content: next
            ? '标记后门店会优先处理；它只影响提示，不改变流程与时限口径。'
            : '取消后这张单回到普通优先级。',
          onOk: () => send(''),
        });
        return;
      }

      // 终态：**必须有依据**（服务端也会拦，这里先把原因收上来）
      let reason = '';
      Modal.confirm({
        title: `${status === 'CLOSED' ? '已闭环' : '已取消'}的工单 —— 修改必须填写原因`,
        icon: null,
        closable: true,
        okText: '提交',
        cancelText: '取消',
        content: (
          <div>
            <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 8 }}>
              这次修改会连同原因一起写进时间线（原值 / 新值 / 操作者都会留痕）。
            </div>
            <Input.TextArea
              rows={3}
              maxLength={200}
              data-testid="urgent-reason"
              placeholder="例如：客户电话追加紧急要求"
              onChange={(e) => {
                reason = e.target.value;
              }}
            />
          </div>
        ),
        onOk: async () => {
          if (!reason.trim()) {
            // 抛错 ⇒ 弹窗保持打开（用户要能补填，而不是重来）
            throw new Error('请填写修改原因');
          }
          await send(reason.trim());
        },
      });
    },
    [request, ticketId, state.ticket, load],
  );

  const timeline = buildTimeline(state.events);

  return (
    <Drawer
      open
      onClose={onClose}
      width={720}
      zIndex={zIndex}
      title={`工单 ${t.ticket_no ?? `#${ticketId}`}`}
      destroyOnClose
    >
      {state.loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : state.error ? (
        <Alert type="error" message="加载失败" description={state.error} showIcon />
      ) : (
        <>
          {/* ① 顶部摘要：只剩"这是哪张单 / 什么状态 / 什么时候建的" */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18, fontWeight: 600 }}>{t.ticket_no ?? '—'}</span>
            <Tag color={status === TICKET_STATUS.CLOSED ? 'green' : 'blue'}>{statusText}</Tag>
            {/*
              Phase 11 / P11-1 §6.1：紧急标记属于**顶部摘要**（一线人员第一眼要看的三个信息之一）。
              ⚠️ 只在为真时渲染一个红 Tag，**不渲染"普通"标签** ——
                 给每张单都挂一个灰色的"非紧急"，等于把唯一需要被看见的信号稀释掉。
            */}
            {t.urgent === true ? <Tag color="red">紧急</Tag> : null}
            {/*
              P11-2：**已有工单**的紧急标记调整入口。
              ⚠️ 放在这里（详情抽屉顶部）而不是列表行内 —— 用户明令「不得为此增加列表按钮墙」。
              用 `type="link"` + 小尺寸：它是一个**低频的更正动作**，
              视觉权重必须低于旁边的状态 Tag 与主操作。
            */}
            <Button
              size="small"
              type="link"
              data-testid="toggle-urgent"
              onClick={() => void toggleUrgent(t.urgent !== true)}
            >
              {t.urgent === true ? '取消紧急' : '设为紧急'}
            </Button>
          </div>
          <div style={{ color: '#8c8c8c', fontSize: 13, marginTop: 6 }}>
            {typeText} · 报修时间 {formatStamp(t.createdAt ?? t.created_at)}
          </div>

          {/* 时效：唯一一条，回答"现在卡在哪一步、这一步多久了/哪天到" */}
          {timelinessLine ? (
            <div
              style={{
                marginTop: 10,
                padding: '8px 10px',
                background: '#f6ffed',
                border: '1px solid #b7eb8f',
                borderRadius: 6,
                fontSize: 13,
                color: '#237804',
              }}
            >
              {timelinessLine}
            </div>
          ) : null}

          {/* ② 服务事项（§6.1 的顺序：客户 → 服务地址 → 门店 → 服务事项） */}
          <div style={SECTION_TITLE}>客户与问题</div>
          <Row label="客户">{t.customer_name ?? '—'}</Row>
          <Row label="联系电话">{t.customer_mobile ?? '—'}</Row>
          {/* 服务地址：§8.1 明确"客户提交选填、安排上门前应补全" ⇒ 空值显示为**待补全**而不是 '—' */}
          <Row label="服务地址">
            {String(t.service_address ?? '').trim() || <span style={{ color: '#faad14' }}>待补全</span>}
          </Row>
          <Row label="所属门店">{storeText(t)}</Row>
          <Row label="家电类型">{applianceCategoryLabel(t.appliance_category) || '—'}</Row>
          <Row label="品牌/型号">{String(t.brand_model ?? '').trim() || '—'}</Row>
          <div style={{ ...ROW, flexDirection: 'column', gap: 4 }}>
            <div style={KEY}>问题描述</div>
            <div style={PARAGRAPH}>{String(t.content ?? '').trim() || '—'}</div>
          </div>

          {/*
            ②.5 客户提交的材料（UX-MEDIA-01）。
            ⚠️ 只在"有材料"或"读取真的失败"时渲染：
               · 大多数工单没有媒体 ⇒ 不摆一块空区块（那是噪声）；
               · viewer 被服务端 403 ⇒ **静默不渲染**（用户明令不得自动开放媒体，
                 也不该用一块"看不到的材料"提示它的存在）；
               · 网络/500 ⇒ 给可读的失败原因，但**不拖垮**整个抽屉（客户与状态仍能看）。
          */}
          {!state.mediaDenied && (state.media.length > 0 || state.mediaError) ? (
            <>
              <div style={SECTION_TITLE}>客户提交的材料</div>
              {state.mediaError ? (
                <Alert
                  type="warning"
                  showIcon
                  data-testid="customer-media-failed"
                  message="客户材料读取失败"
                  description={`${state.mediaError}（工单内容不受影响；可关闭后重新打开重试）`}
                />
              ) : (
                <div
                  data-testid="customer-media-list"
                  style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}
                >
                  {state.media.map((m, i) => (
                    <CustomerMediaItem
                      key={m.id}
                      item={m}
                      index={i}
                      request={request}
                      zIndex={zIndex}
                    />
                  ))}
                </div>
              )}
            </>
          ) : null}

          {/* ③ 当前服务：**只有当前 active Visit**（历史 Visit 走下面的时间线） */}
          <div style={SECTION_TITLE}>当前服务</div>
          {!currentVisit ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                // ⚠️ 2026-10-10 文案裁决：NEW 的界面说法统一为「待处理」
                //    （`accept` 已不在门店流程里 —— NEW 直接派工/转店/取消/电话解决）
                status === TICKET_STATUS.NEW ? '尚未派工（等待门店处理）' : '当前没有生效的派工'
              }
            />
          ) : (
            <>
              <Row label="服务状态">
                <Tag color="blue">{visitStatusText(currentVisit.visit_status)}</Tag>
              </Row>
              <Row label="服务方式">{serviceModeText(currentVisit.service_mode) || '—'}</Row>
              {/* 服务商只在"厂家/第三方"这类**有主体**的方式下才显示，门店自修不显示空行 */}
              {currentVisit.provider_name ? (
                <Row label="服务商">{currentVisit.provider_name}</Row>
              ) : null}
              <Row label="当前技师">{currentVisit.technician_name ?? '—'}</Row>
              {currentVisit.technician_mobile ? (
                <Row label="技师电话">{currentVisit.technician_mobile}</Row>
              ) : null}
              <Row label="预计上门">
                {formatAppointmentDate(currentExpectedAt) || '未约定'}
              </Row>
              <div style={{ color: '#bfbfbf', fontSize: 12, marginTop: 4 }}>
                第 {currentVisit.visit_no ?? 1} 次派工
              </div>
            </>
          )}

          {/* ③.5 技师回执（P6-0 只读 + P6-2 确认/驳回）：**只在有待确认回执时**才出现，
              所以普通查单不会多一次请求，也不会多一块空白区。
              ⚠️ onChanged 指向 load()：确认/驳回成功或 409 冲突后**整页重拉**，
                 让工单状态、时间线、按钮显隐一起刷新（不再是 SUBMITTED 时
                 submittedVisitOf 返回 null → 整个区块连同按钮一起消失）。 */}
          {submittedVisit?.id != null ? (
            <StoreReviewSection
              visitId={submittedVisit.id}
              request={request}
              onChanged={() => void load()}
            />
          ) : null}

          {/*
            ④ 内部记录：**门店内部备注入口** + **历史事件（时间线）**。
            ⚠️ 业务动作（处理 / 跟进 / 审核）**不在**这个抽屉里 —— 它们是列表行的主动作
               与对应的处理 / 跟进 / 审核窗口。抽屉只管两件事：**查看** + **追加内部备注**，
               三类功能（工单信息 / 业务操作 / 内部记录）各归其位，不混成一个按钮菜单。
            ⚠️ 备注入口只在服务端说"能写"时出现（viewer 等只读角色看不到，也就不会点了才 403）。
          */}
          <div style={SECTION_TITLE}>内部记录</div>
          {state.canWrite ? (
            <NoteComposer ticketId={ticketId} request={request} onAdded={() => void load()} />
          ) : (
            <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 8 }}>
              当前账号为只读，不能添加内部备注。
            </div>
          )}
          {timeline.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无处理记录" />
          ) : (
            timeline.map((entry) => (
              <div
                key={entry.key}
                style={{
                  display: 'flex',
                  gap: 12,
                  padding: '7px 0',
                  borderBottom: '1px dashed #f0f0f0',
                  // 通知类（短信）降一级：它们是"顺带发生"的，不抢业务动作的位置
                  opacity: entry.notice ? 0.62 : 1,
                }}
              >
                <div style={{ flex: '0 0 108px', color: '#8c8c8c', fontSize: 12, lineHeight: 1.6 }}>
                  {entry.at}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13 }}>
                    <b>{entry.action}</b>
                    <span style={{ color: '#8c8c8c', marginLeft: 8 }}>{entry.actor}</span>
                  </div>
                  {entry.detail ? (
                    <div style={{ color: '#595959', fontSize: 13, lineHeight: 1.6, marginTop: 2 }}>
                      {entry.detail}
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </>
      )}
    </Drawer>
  );
}

/**
 * 打开工单详情抽屉。
 *
 * 用 `ReactDOM.render` 挂在自建容器上，而不是依赖 NocoBase 的 viewer API：
 * 后者在不同小版本间形态不稳定，而这里是 Phase 4 唯一的详情入口，
 * 不值得为"更原生"承担一个渲染不出来的风险。
 *
 * @returns 关闭函数
 */
export function openTicketDrawer(options: TicketDrawerOptions): () => void {
  const g: any = globalThis; // DOM 全局经显式断言取（本插件客户端 tsconfig 无 "DOM" lib）
  const container = g.document.createElement('div');
  g.document.body.appendChild(container);
  const close = () => {
    ReactDOM.unmountComponentAtNode(container);
    container.remove();
  };

  /**
   * 🔴 P0 根因修复（UX-01A 第六轮，2026-10-16 实测取证）。
   *
   * 问题：从「工作台卡片 → 列表弹窗」里点工单号打开的本抽屉**被列表弹窗遮挡**，
   * 点不到、聚焦不了。真实浏览器实测：
   *   `drawerZ=1000 · drawerMaskZ=1000 · modalZ=2000 · elementFromPoint 命中的是 ant-modal-wrap`
   *
   * 根因（**不是** CSS 写错，也不是"该设个更大值"）：本抽屉用 `ReactDOM.render`
   * 渲染在**应用树之外**的裸容器里，因此**拿不到宿主 ConfigProvider 的 z-index 层**
   * ——宿主弹层在 2000 层，而本抽屉退回到 antd 默认基值 1000 ⇒ 天然被压在下层。
   * 这是"跨渲染树丢上下文"的典型症状；任何"调 CSS z-index"都只是掩盖。
   *
   * 修法（框架机制，非"拍一个极大值"）：用 `ConfigProvider zIndex` 把本抽屉的
   * z-index **基值**对齐到"当前已打开浮层的最高层"，使抽屉落在其上（+1）。
   *   · 没有浮层时 ⇒ 基值 1000，抽屉 1001（与原先一致，无回归）；
   *   · 有 2000 的弹窗时 ⇒ 基值 2000，抽屉 2001 ⇒ **在最上层**。
   * 这样它参与同一套层级管理，而不是靠"压别人一头"的魔法数字。
   */
  let baseZ = 1000;
  try {
    const els = [...g.document.querySelectorAll('.ant-modal-wrap, .ant-modal-mask, .ant-drawer')];
    const zs = els
      .map((e: any) => Number(g.getComputedStyle(e).zIndex))
      .filter((n: number) => Number.isFinite(n));
    if (zs.length) baseZ = Math.max(...zs);
  } catch {
    /* 取不到就用默认基值 —— 退化为原行为，不放大问题 */
  }

  ReactDOM.render(<TicketDrawer {...options} zIndex={baseZ + 1} onClose={close} />, container);
  return close;
}
