/**
 * `StoreWorkbenchModel` —— UX-01A / A1：门店**售后服务工作台**（自定义区块模型）。
 *
 * 实现方式（复用既有 FlowEngine 扩展，不自建页面系统）：
 *   · 蓝图用宿主 `markdown` 区块建页 → 落库后用既有 `flowModels:save` 把该区块
 *     节点的 `use` 换成 `StoreWorkbenchModel`（与 A2 换字段模型同法）；
 *   · 基类取宿主真实存在的区块模型（`MarkdownBlockModel`，退回 `TableBlockModel`），覆写 `render()`。
 *
 * 数据口径（用户 A1 §2，全部经**服务端授权范围**查询，前端不拉全量再过滤）：
 *   待处理=NEW；已处理（**累计**）=WAIT_FEEDBACK+CLOSED；辅助=PROCESSING/WAIT_STORE_CONFIRM/WAIT_FEEDBACK。
 *   今日待办：待受理(NEW) + 待审核(WAIT_STORE_CONFIRM) + `svc:followUpQueue`（到期/逾期），按工单 id 去重。
 *   历史导入档案在独立集合，不在 `serviceTickets` ⇒ 天然不混入。
 *
 * 布局（UX-01A 第七轮 §三）：顶部标题 + 右侧紧凑快捷入口；五卡同行；下方**双栏**今日待办 / 最近服务单
 * （各 ≤5 条 + 「查看全部」）；窄屏自动上下排列。
 */
import React from 'react';
import { Button, Empty, Spin, Tag, Modal, message } from 'antd';
import { openTicketDrawer } from './ticket-drawer';

type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

const COUNT = (filter: unknown) =>
  `serviceTickets:list?pageSize=1&filter=${encodeURIComponent(JSON.stringify(filter))}`;
const LIST = (filter: unknown, pageSize = 30) =>
  `serviceTickets:list?pageSize=${pageSize}&sort=-createdAt,-id&filter=${encodeURIComponent(
    JSON.stringify(filter),
  )}`;

/**
 * 「我的门店工单」页面的 SPA 路径（"新建服务单"快捷入口跳转用 —— 复用**已有的**建单入口，
 * 不另造建单表单）。取自该页 `desktopRoutes.schemaUid`（NocoBase 后台路由为 `/admin/<schemaUid>`）。
 */
const STORE_LIST_PATH = '/admin/tujyw08ec1d';

const STATUS_LABEL: Record<string, string> = {
  NEW: '待处理',
  PROCESSING: '处理中',
  WAIT_STORE_CONFIRM: '待门店确认',
  WAIT_FEEDBACK: '待客户评价',
  CLOSED: '已闭环',
  CANCELLED: '已取消',
};

function metaCount(r: any): number {
  return Number(r?.meta?.count ?? r?.data?.meta?.count ?? 0) || 0;
}
function rowsOf(r: any): any[] {
  return Array.isArray(r?.data) ? r.data : Array.isArray(r?.data?.data) ? r.data.data : [];
}

const CARD: React.CSSProperties = {
  border: '1px solid #f0f0f0',
  borderRadius: 8,
  padding: '12px 14px',
  minWidth: 132,
  flex: '1 1 132px',
  cursor: 'pointer',
  background: '#fff',
};
const SECTION: React.CSSProperties = { fontWeight: 600, margin: '0 0 8px' };

/** 一张统计卡（可点击 → 打开对应筛选结果） */
function StatCard({ label, value, note, onClick }: { label: string; value: number | null; note?: string; onClick: () => void }) {
  return (
    <div style={CARD} data-testid="wb-stat-card" data-stat={label} onClick={onClick} role="button" tabIndex={0}>
      <div style={{ color: '#8c8c8c', fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.2 }} data-testid="wb-stat-value">
        {value == null ? '—' : value}
      </div>
      {note ? <div style={{ color: '#bfbfbf', fontSize: 11 }}>{note}</div> : null}
    </div>
  );
}

/** 分页取一页工单（**服务端** page/pageSize/sort；filter 与卡片同源） */
function listUrl(filter: unknown, page: number, pageSize: number) {
  // 排序 `-createdAt,-id`：创建时间倒序，同一时间用唯一 id 兜底，保证翻页顺序稳定。
  return `serviceTickets:list?page=${page}&pageSize=${pageSize}&sort=-createdAt,-id&filter=${encodeURIComponent(
    JSON.stringify(filter),
  )}`;
}

/**
 * **服务端分页**的工单列表（概览卡 / 记录查询 / 「查看全部」共用）。
 *  · 每次**只请求当前页**；总数取服务端 `meta.count`（授权范围内）；稳定排序 `-createdAt,-id`。
 *  · **过期请求丢弃**（快速翻页时慢响应不得覆盖新页结果）；页码失效自动校正。
 *  · 失败显示错误 + 重试（**绝不显示成 0 条**）。行内工单号 → 既有只读详情抽屉（P0 已修：在最上层）。
 */
function TicketListPaged({ filter, request }: { filter: unknown; request: Requester }) {
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(10);
  const [total, setTotal] = React.useState<number | null>(null);
  const [rows, setRows] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);
  const seq = React.useRef(0);

  React.useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const r = await request(listUrl(filter, page, pageSize));
        if (my !== seq.current) return; // 过期响应 ⇒ 丢弃
        const cnt = Number(r?.meta?.count ?? 0) || 0;
        const totalPages = Math.max(1, Math.ceil(cnt / pageSize));
        if (page > totalPages) {
          setPage(totalPages); // 页码失效（筛选/每页条数变化后）⇒ 校正
          return;
        }
        setTotal(cnt);
        setRows(rowsOf(r));
      } catch (e: any) {
        if (my !== seq.current) return;
        setError(String(e?.response?.data?.message ?? e?.message ?? e));
        setRows([]);
        setTotal(null);
      } finally {
        if (my === seq.current) setLoading(false);
      }
    })();
  }, [filter, page, pageSize, reloadKey, request]);

  const totalPages = total == null ? null : Math.max(1, Math.ceil(total / pageSize));

  return (
    <div data-testid="wb-list" data-page={page} data-page-size={pageSize} data-total={total ?? ''}>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 24 }} data-testid="wb-list-loading"><Spin /></div>
      ) : error ? (
        <div data-testid="wb-list-error" style={{ padding: 12 }}>
          <div style={{ color: '#cf1322', marginBottom: 8 }}>加载失败：{error}</div>
          <Button size="small" type="primary" data-testid="wb-list-retry" onClick={() => setReloadKey((k) => k + 1)}>
            重试
          </Button>
        </div>
      ) : !rows.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的工单" />
      ) : (
        <div data-testid="wb-list-rows">
          {rows.map((t) => (
            <div
              key={t.id}
              data-testid="wb-list-row"
              style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px dashed #f0f0f0', fontSize: 13 }}
            >
              <a
                style={{ color: '#1677ff', cursor: 'pointer', flex: '0 0 150px' }}
                data-testid="wb-list-ticketno"
                data-ticket-id={t.id}
                onClick={() => openTicketDrawer({ ticketId: t.id, request: request as any })}
              >
                {t.ticket_no}
              </a>
              <span style={{ flex: '0 0 84px', color: '#8c8c8c' }}>{STATUS_LABEL[String(t.status)] ?? t.status}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.customer_name ?? '—'}
              </span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }} data-testid="wb-pager">
        <Button size="small" data-testid="wb-prev" disabled={page <= 1 || !!error} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          上一页
        </Button>
        <span data-testid="wb-page-info">
          第 {page} / {totalPages ?? '?'} 页 · 共 {total ?? '?'} 条
        </span>
        <Button
          size="small"
          data-testid="wb-next"
          disabled={totalPages == null || page >= totalPages || !!error}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </Button>
        <span style={{ marginLeft: 'auto' }}>
          每页
          <select
            data-testid="wb-page-size"
            value={pageSize}
            style={{ marginLeft: 6 }}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1); // 每页条数变化 ⇒ 回到第 1 页
            }}
          >
            <option value={10}>10</option>
            <option value={20}>20</option>
          </select>
          条
        </span>
      </div>
    </div>
  );
}

/** 打开"筛选结果"弹窗：与卡片**同一 filter**（口径一致），列表**服务端分页** */
function openFilteredList(opts: { title: string; filter: unknown; request: Requester }) {
  const { title, filter, request } = opts;
  const m = Modal.info({
    title,
    width: 760,
    icon: null,
    okText: '关闭',
    content: React.createElement(TicketListPaged, { filter, request }),
  });
  return () => m.destroy();
}

/** 「查看全部」等只读文本链接（键盘可达；不是 button） */
function TextLink({ testid, onClick, children }: { testid: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <a
      role="link"
      tabIndex={0}
      data-testid={testid}
      style={{ color: '#1677ff', cursor: 'pointer', fontWeight: 400, fontSize: 12 }}
      onClick={onClick}
      onKeyDown={(e: any) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </a>
  );
}

function Workbench({ request, app }: { request: Requester; app: any }) {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [data, setData] = React.useState<{ counts: Record<string, number>; todo: any[]; recent: any[] }>({
    counts: {},
    todo: [],
    recent: [],
  });

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cNew, cProcessing, cWaitStore, cWaitFeedback, cClosed, queue, recent] = await Promise.all([
        request(COUNT({ status: 'NEW' })),
        request(COUNT({ status: 'PROCESSING' })),
        request(COUNT({ status: 'WAIT_STORE_CONFIRM' })),
        request(COUNT({ status: 'WAIT_FEEDBACK' })),
        request(COUNT({ status: 'CLOSED' })),
        request('svc:followUpQueue?limit=100').catch(() => null),
        request(LIST({}, 10)).catch(() => null),
      ]);
      const counts = {
        NEW: metaCount(cNew),
        PROCESSING: metaCount(cProcessing),
        WAIT_STORE_CONFIRM: metaCount(cWaitStore),
        WAIT_FEEDBACK: metaCount(cWaitFeedback),
        CLOSED: metaCount(cClosed),
      };
      // 今日待办：待受理(NEW) + 待审核(WAIT_STORE_CONFIRM) + 队列(到期跟进/已逾期)，**按 id 去重**
      const dedup = new Map<number, any>();
      const push = (t: any, reason: string) => {
        const id = Number(t?.id);
        if (!Number.isFinite(id)) return;
        if (!dedup.has(id)) dedup.set(id, { id, ticket_no: t?.ticket_no, reason });
      };
      try {
        rowsOf(await request(LIST({ status: 'NEW' }, 20))).forEach((t) => push(t, '待受理'));
      } catch { /* 单项失败不影响整体 */ }
      try {
        rowsOf(await request(LIST({ status: 'WAIT_STORE_CONFIRM' }, 20))).forEach((t) => push(t, '待门店审核'));
      } catch { /* ignore */ }
      const qItems = Array.isArray(queue?.data?.items) ? queue.data.items : Array.isArray(queue?.items) ? queue.items : [];
      for (const t of qItems) push(t, '到期跟进');
      setData({ counts, todo: [...dedup.values()], recent: rowsOf(recent) });
    } catch (e: any) {
      setError(String(e?.response?.data?.message ?? e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [request]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const navigate = (path?: string) => {
    if (!path) {
      message.info('请在左侧菜单打开「我的门店工单」');
      return;
    }
    const router = app?.router;
    if (typeof router?.navigate === 'function') router.navigate(path);
    else (globalThis as any).location.assign(path);
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 48 }} data-testid="wb-loading"><Spin tip="正在加载工作台…" /></div>;
  }
  if (error) {
    return (
      <div style={{ padding: 24 }} data-testid="wb-error">
        <div style={{ color: '#cf1322', marginBottom: 12 }}>工作台加载失败：{error}</div>
        <Button type="primary" data-testid="wb-retry" onClick={() => void load()}>重试</Button>
      </div>
    );
  }

  const { counts, todo, recent } = data;
  const processed = (counts.WAIT_FEEDBACK ?? 0) + (counts.CLOSED ?? 0);
  const colStyle: React.CSSProperties = { flex: '1 1 420px', minWidth: 300 };

  return (
    <div data-testid="store-workbench" style={{ padding: '4px 2px' }}>
      {/* ① 顶部：标题 + 右侧**紧凑**快捷入口（不再单列"快捷操作"大区块） */}
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}
      >
        <div>
          <span style={{ fontSize: 18, fontWeight: 700 }}>售后服务工作台</span>
          <span style={{ color: '#8c8c8c', fontSize: 12, marginLeft: 8 }}>当前授权门店范围 · 累计口径</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }} data-testid="wb-quick">
          <Button size="small" type="primary" data-testid="wb-quick-create" onClick={() => navigate(STORE_LIST_PATH)}>
            新建服务单
          </Button>
          <Button size="small" data-testid="wb-quick-query" onClick={() => openFilteredList({ title: '记录查询', filter: {}, request })}>
            记录查询
          </Button>
        </div>
      </div>

      {/* ② 概览：五卡**同一行**（窄屏自动换行） */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }} data-testid="wb-overview">
        <StatCard label="待处理" value={counts.NEW ?? 0} note="状态：待处理" onClick={() => openFilteredList({ title: '待处理工单', filter: { status: 'NEW' }, request })} />
        <StatCard label="已处理（累计）" value={processed} note="待客户评价 + 已闭环" onClick={() => openFilteredList({ title: '已处理（累计）', filter: { status: { $in: ['WAIT_FEEDBACK', 'CLOSED'] } }, request })} />
        <StatCard label="处理中" value={counts.PROCESSING ?? 0} onClick={() => openFilteredList({ title: '处理中工单', filter: { status: 'PROCESSING' }, request })} />
        <StatCard label="待门店确认" value={counts.WAIT_STORE_CONFIRM ?? 0} onClick={() => openFilteredList({ title: '待门店确认', filter: { status: 'WAIT_STORE_CONFIRM' }, request })} />
        <StatCard label="待客户评价" value={counts.WAIT_FEEDBACK ?? 0} onClick={() => openFilteredList({ title: '待客户评价', filter: { status: 'WAIT_FEEDBACK' }, request })} />
      </div>

      {/* ③ 下方**双栏**：今日待办 / 最近服务单（各 ≤5 条 + 查看全部；窄屏上下排列） */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 16 }}>
        <div style={colStyle} data-testid="wb-todo-col">
          <div style={{ ...SECTION, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>今日待办</span>
            <TextLink testid="wb-todo-all" onClick={() => openFilteredList({ title: '今日待办（处理中）', filter: { status: 'PROCESSING' }, request })}>
              查看全部
            </TextLink>
          </div>
          <div data-testid="wb-todo">
            {todo.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="今天没有待办事项" />
            ) : (
              todo.slice(0, 5).map((t) => (
                <div key={t.id} style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px dashed #f0f0f0', fontSize: 13 }} data-testid="wb-todo-row">
                  <a
                    style={{ color: '#1677ff', cursor: 'pointer', flex: '0 0 150px' }}
                    data-testid="wb-todo-ticketno"
                    data-ticket-id={t.id}
                    onClick={() => openTicketDrawer({ ticketId: t.id, request: request as any })}
                  >
                    {t.ticket_no ?? `#${t.id}`}
                  </a>
                  <Tag color="orange">{t.reason}</Tag>
                </div>
              ))
            )}
          </div>
        </div>

        <div style={colStyle} data-testid="wb-recent-col">
          <div style={{ ...SECTION, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>最近服务单</span>
            <TextLink testid="wb-recent-all" onClick={() => openFilteredList({ title: '最近服务单', filter: {}, request })}>
              查看全部
            </TextLink>
          </div>
          <div data-testid="wb-recent">
            {recent.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无服务单" />
            ) : (
              recent.slice(0, 5).map((t) => (
                <div key={t.id} style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px dashed #f0f0f0', fontSize: 13 }} data-testid="wb-recent-row">
                  <a
                    style={{ color: '#1677ff', cursor: 'pointer', flex: '0 0 150px' }}
                    data-testid="wb-recent-ticketno"
                    data-ticket-id={t.id}
                    onClick={() => openTicketDrawer({ ticketId: t.id, request: request as any })}
                  >
                    {t.ticket_no}
                  </a>
                  <span style={{ flex: '0 0 84px', color: '#8c8c8c' }}>{STATUS_LABEL[String(t.status)] ?? t.status}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.customer_name ?? '—'}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function buildStoreWorkbenchModel(deps: {
  BaseBlockModel: any;
  request: Requester;
  app: any;
}): Record<string, any> {
  const { BaseBlockModel, request, app } = deps;
  if (!BaseBlockModel) return {};

  class StoreWorkbenchModel extends BaseBlockModel {
    render(): any {
      return React.createElement(Workbench, { request, app });
    }
  }
  Object.defineProperty(StoreWorkbenchModel, 'name', { value: 'StoreWorkbenchModel' });

  return { StoreWorkbenchModel };
}
