/**
 * A 页之二：工单列表（搜索 + 筛选 Sheet + 分页）。
 *
 * ===========================================================================
 * 搜索为什么是"提交式"而不是"边打边搜"
 * ===========================================================================
 *   边打边搜每敲一个字就发一次请求：手机网络下平均 300ms 一次，
 *   输 11 位手机号就是 11 次请求，而服务端每次都要按 `$includes` 扫一张 543 行的表。
 *   更糟的是**回来的顺序不保证**（后发的请求可能先回），
 *   于是列表会闪成"上一个关键词的结果"。
 *
 *   ⇒ 这里用「输入 → 点放大镜/回车才查」。代价是多一次点击，
 *     换来的是"看到的就是最后一次输入的结果"这个确定性。
 *
 * ===========================================================================
 * 空结果 vs 加载中 vs 出错，三者必须分开
 * ===========================================================================
 *   混在一起的典型表现：网络断了显示"没有符合条件的工单"，
 *   用户以为真的没单，于是漏掉了当天最急的报修。
 *   ⇒ 三个状态由 `Feedback.tsx` 的三套组件分管，任何一个都不会退化成另一个。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Searchbar } from 'konsta/react';
import { AppShell, PageHeader } from '../components/AppShell';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { TicketCard } from '../components/Domain';
import { TicketApiAdapter, type TicketFilter, type TicketRow } from '../api/tickets';
import { TICKET_STATUS_META } from '../design/tokens';
import { navigate, useRoute } from '../router';
import { useWorkspaces } from '../app/workspaces';

const PAGE_SIZE = 20;

/** 筛选面板里的状态项（顺序 = 业务紧迫度，不是字母序） */
const STATUS_CHOICES = ['NEW', 'PROCESSING', 'WAIT_STORE_CONFIRM', 'WAIT_FEEDBACK', 'CLOSED', 'CANCELLED'] as const;

/**
 * 从 URL 参数构造初始筛选。
 *
 * ⚠️ 存在的理由：工作台点"待受理 247"时，必须落到**同一个范围**的列表上。
 *    若只是 `navigate('/tickets')`，用户会看到一个包含全部状态的列表 ——
 *    从"247 条待受理"跳过去却看到 900 多条，那又成了新的自相矛盾。
 *
 * ⚠️ 参数值不由前端校验合法性（`parseRoute` 的注释已说明该约定）：
 *    服务端不认识的状态值只会查出 0 条，不会越权。这里只做拆分与去空格。
 */
function filterFromQuery(query: URLSearchParams): TicketFilter {
  const statuses = (query.get('status') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const f: TicketFilter = {};
  if (statuses.length) f.statuses = statuses;
  if (query.get('dueToday') === '1') f.dueToday = true;
  if (query.get('urgent') === '1') f.urgent = true;
  const kw = (query.get('keyword') ?? '').trim();
  if (kw) f.keyword = kw;
  return f;
}

export function TicketListPage() {
  const route = useRoute();
  // 底栏来自唯一来源 app/workspaces.tsx
  const tabs = useWorkspaces();
  /**
   * ⚠️ 初始值只算一次（`useState` 的惰性初值）。
   *    若写成 `useState(filterFromQuery(route.query))` 并在依赖里放 route，
   *    每次 query 变化都会重置用户手动改过的筛选 —— 也就是"筛完一刷新就被清掉"。
   *    从工作台带参数进来是**进入页面**这一件事，不是持续同步。
   */
  const [draftKw, setDraftKw] = useState(() => filterFromQuery(route.query).keyword ?? '');
  const [filter, setFilter] = useState<TicketFilter>(() => filterFromQuery(route.query));
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<'loading' | 'loadingMore' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // 请求序号：只认最后一次发出的请求结果（避免快速切换筛选时的乱序覆盖）
  const seq = useRef(0);

  const load = useCallback(
    async (targetPage: number, append: boolean) => {
      const my = ++seq.current;
      setState(append ? 'loadingMore' : 'loading');
      setError(null);
      try {
        const r = await TicketApiAdapter.list(filter, targetPage, PAGE_SIZE);
        if (my !== seq.current) return; // 已被更新的请求取代
        setRows((prev) => (append ? [...prev, ...r.rows] : r.rows));
        setTotal(r.total);
        setPage(targetPage);
        setState('ready');
      } catch (e) {
        if (my !== seq.current) return;
        setError(e);
        setState('error');
      }
    },
    [filter],
  );

  useEffect(() => {
    void load(1, false);
  }, [load]);

  const applyKeyword = () => {
    setFilter((f) => ({ ...f, keyword: draftKw.trim() || undefined }));
  };

  const clearAll = () => {
    setDraftKw('');
    setFilter({});
  };

  const activeCount =
    (filter.statuses?.length ?? 0) + (filter.urgent ? 1 : 0) + (filter.dueToday ? 1 : 0) + (filter.keyword ? 1 : 0);

  return (
    <AppShell tabs={tabs} activeTab="tickets">
      <PageHeader
        title="工单"
        /**
         * ⚠️ 有底栏的根级页面**不给返回箭头**：底栏已经有"工作台"这个明确的
         *    并列目的地，再给一个"返回"会让同一屏出现两个返回路径。
         *    从工作台跳进来的用户按底栏"工作台"回去，比按左上角箭头更符合直觉。
         */
        right={
          <button
            className="svc-icon-btn text-svc-ink-2 relative"
            aria-label="筛选"
            onClick={() => setSheetOpen(true)}
            data-testid="tickets-filter-open"
          >
            <IconFilter />
            {activeCount > 0 ? (
              <span className="bg-svc-brand absolute top-1.5 right-1.5 h-2 w-2 rounded-full" aria-hidden="true" />
            ) : null}
          </button>
        }
      />

      <div className="bg-svc-bg sticky top-0 z-10 px-4 pt-2 pb-2">
        <Searchbar
          placeholder="工单号 / 客户 / 电话 / 内容"
          value={draftKw}
          onInput={(e: any) => setDraftKw(e.target.value)}
          onClear={() => {
            setDraftKw('');
            setFilter((f) => ({ ...f, keyword: undefined }));
          }}
          onKeyDown={(e: any) => {
            if (e.key === 'Enter') applyKeyword();
          }}
          disableButton
          data-testid="tickets-search"
        />
        {activeCount > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {filter.statuses?.map((s) => (
              <Chip key={s} onRemove={() => setFilter((f) => ({ ...f, statuses: (f.statuses ?? []).filter((x) => x !== s) }))}>
                {TICKET_STATUS_META[s]?.label ?? s}
              </Chip>
            ))}
            {filter.urgent ? <Chip onRemove={() => setFilter((f) => ({ ...f, urgent: undefined }))}>仅紧急</Chip> : null}
            {filter.dueToday ? <Chip onRemove={() => setFilter((f) => ({ ...f, dueToday: undefined }))}>今日到期</Chip> : null}
            {filter.keyword ? (
              <Chip
                onRemove={() => {
                  setDraftKw('');
                  setFilter((f) => ({ ...f, keyword: undefined }));
                }}
              >
                “{filter.keyword}”
              </Chip>
            ) : null}
            <button className="text-svc-ink-3 ml-1 qf-caption" onClick={clearAll}>
              清空
            </button>
          </div>
        ) : null}
      </div>

      {state === 'loading' ? (
        <LoadingState rows={5} />
      ) : state === 'error' ? (
        <ErrorState error={error} onRetry={() => void load(1, false)} onBack={() => navigate('/')} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={activeCount > 0 ? '没有符合条件的工单' : '当前门店还没有工单'}
          description={activeCount > 0 ? '试着放宽筛选条件，或清空关键词。' : undefined}
          action={
            activeCount > 0 ? (
              <Button tonal onClick={clearAll}>
                清空筛选
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="px-4 pb-6" data-testid="tickets-list">
          {/*
            ⚠️ 这里**不显示**"已加载 20"。
               那是分页实现细节（每页 20 条这个数字对业务毫无意义），
               用户看到它只会想"为什么是 20？是不是只加载了 20 条？还有多少？"。
               ⇒ 只说总数（一个业务上真实存在的量），加载更多由下方按钮承担。
               用户原话："隐藏'已加载 20'之类开发实现细节"。
          */}
          <div className="text-svc-ink-3 py-2 qf-caption">共 {total} 条</div>
          {rows.map((t) => (
            <TicketCard key={t.id} row={t} onOpen={() => navigate(`/tickets/${t.id}`)} />
          ))}
          {rows.length < total ? (
            <div className="pt-2">
              <Button
                tonal
                onClick={() => void load(page + 1, true)}
                disabled={state === 'loadingMore'}
                data-testid="tickets-more"
              >
                {state === 'loadingMore' ? '加载中…' : '加载更多'}
              </Button>
            </div>
          ) : (
            <div className="text-svc-ink-3 py-6 text-center qf-caption">已经到底了</div>
          )}
        </div>
      )}

      <FilterSheet
        open={sheetOpen}
        filter={filter}
        onClose={() => setSheetOpen(false)}
        onApply={(f) => {
          setFilter(f);
          setSheetOpen(false);
        }}
      />
    </AppShell>
  );
}

/* ------------------------------------------------------------- 筛选面板 */

function FilterSheet({
  open,
  filter,
  onClose,
  onApply,
}: {
  open: boolean;
  filter: TicketFilter;
  onClose: () => void;
  onApply: (f: TicketFilter) => void;
}) {
  const [local, setLocal] = useState<TicketFilter>(filter);

  // 每次打开都同步一次外部值：否则上次"取消"的改动会残留
  useEffect(() => {
    if (open) setLocal(filter);
  }, [open, filter]);

  const toggleStatus = (s: string) => {
    setLocal((f) => {
      const cur = f.statuses ?? [];
      const next = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
      return { ...f, statuses: next.length ? next : undefined };
    });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="筛选工单">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="bg-svc-surface absolute inset-x-0 bottom-0 rounded-t-svc-xl pb-safe" data-testid="tickets-filter-sheet">
        <div className="border-svc-line flex items-center justify-between border-b px-4 py-3">
          <span className="text-svc-ink qf-sub font-medium">筛选</span>
          <button className="text-svc-ink-2 qf-foot" onClick={onClose}>
            取消
          </button>
        </div>

        <div className="px-4 py-3">
          <div className="text-svc-ink-2 mb-2 qf-caption">状态</div>
          <div className="flex flex-wrap gap-2">
            {STATUS_CHOICES.map((s) => {
              const on = (local.statuses ?? []).includes(s);
              return (
                <button
                  key={s}
                  onClick={() => toggleStatus(s)}
                  /* P-01：胶囊 → 圆角矩形。圆角走 radius-svc(10)，与输入框/按钮同族；
                     宽度仍随文案（这些是"多选筛选标签"，不是互斥分段，不应强制等宽）。 */
                  className={`qf-pressable min-h-touch border px-3.5 qf-foot ${
                    on ? 'border-svc-brand bg-svc-brand text-white' : 'border-svc-line bg-svc-surface-2 text-svc-ink-2'
                  }`}
                >
                  {TICKET_STATUS_META[s]?.label ?? s}
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex gap-2">
            <ToggleChip label="仅紧急" on={Boolean(local.urgent)} onClick={() => setLocal((f) => ({ ...f, urgent: !f.urgent }))} />
            <ToggleChip
              label="今日到期跟进"
              on={Boolean(local.dueToday)}
              onClick={() => setLocal((f) => ({ ...f, dueToday: !f.dueToday }))}
            />
          </div>
        </div>

        <div className="flex gap-2 px-4 py-3">
          <Button
            tonal
            onClick={() => {
              setLocal({ keyword: filter.keyword });
            }}
          >
            重置
          </Button>
          <Button onClick={() => onApply(local)} data-testid="tickets-filter-apply">
            应用筛选
          </Button>
        </div>
      </div>
    </div>
  );
}

function ToggleChip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`qf-pressable min-h-touch border px-3.5 qf-foot ${
        on ? 'border-svc-brand bg-svc-brand text-white' : 'border-svc-line bg-svc-surface-2 text-svc-ink-2'
      }`}
    >
      {label}
    </button>
  );
}

function Chip({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  /**
   * ✅ 这里保留胶囊：它就是**标签**（"已选条件"的呈现），与 QFStatusBadge 同类，
   *    所以带 `qf-badge` 语义标记。区别只在尾部可点移除 ——
   *    那个移除按钮自己撑到 ≥44（用负外边距把多出来的空间吃掉，标签看起来不变大）。
   *
   * ⚠️ 注释必须放在 return 的**外面**：写在 `return (` 之后、JSX 之前会变成
   *    一个裸的 `{/* *\/}` 表达式，语法直接报错（TS1005 / TS1127）。
   */
  return (
    <span className="qf-badge bg-svc-brand-soft text-svc-brand inline-flex items-center gap-1 px-2.5 py-1 qf-caption">
      {children}
      <button
        onClick={onRemove}
        aria-label="移除筛选"
        className="text-svc-brand/70 qf-foot -my-3 inline-flex min-h-touch min-w-touch items-center justify-center leading-none"
      >
        ×
      </button>
    </span>
  );
}

function IconFilter() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 6h18M6 12h12M10 18h4" strokeLinecap="round" />
    </svg>
  );
}
