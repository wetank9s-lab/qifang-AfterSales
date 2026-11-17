/**
 * B 页之一：服务档案列表（门店销售）。
 *
 * ===========================================================================
 * 这里为什么没有底部导航
 * ===========================================================================
 *   门店销售的实际工作只有一个：服务档案（建档 / 查档 / 跟进）。
 *   整改前这里挂着一个**只有"档案"一项**的底栏 —— 点它还在原地，
 *   不提供任何导航，只是白白占掉 50px + 安全区，还会让人误以为
 *   "底下还能去别处"（用户明令取消这种单项 Tabbar，见 app/workspaces.tsx）。
 *
 *   销售没有工单入口，是因为他确实没有工单业务 —— 不与服务端能力矩阵冲突。
 *
 * ===========================================================================
 * 这里最需要小心的一件事：门店不是前端选的
 * ===========================================================================
 *   服务端 A5-B3：请求不传 store_id ⇒ 由服务端按当前账号的**唯一有效门店**推导。
 *   所以本页不显示任何门店选择器；顶部那行店名只是装饰（取不到就不显示）。
 *   若让用户选店，等于允许销售把客户住址写进别家店。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Searchbar } from 'konsta/react';
import { AppShell, PageHeader, useScrollTopOnRouteChange, findScrollContainer } from '../components/AppShell';
import { useWorkspaces } from '../app/workspaces';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { ArchiveCard } from '../components/Domain';
import { ArchiveApiAdapter, type ArchiveFilter, type ArchiveRow } from '../api/archives';
import { singleStoreName } from '../api/stores';
import { ARCHIVE_TYPE_META } from '../design/tokens';
import { TONE_CLASS } from '../design/tokens';
import { navigate, useRoute } from '../router';
import { useSession } from '../app/session-context';

const PAGE_SIZE = 20;

/**
 * 筛选分两组，**视觉上分开、语义上分开**（用户第三节明确要求）。
 *
 * ⚠️ 整改前这两组混在同一条横向滚动带里，中间只插一根 1px 竖线，
 *    于是员工面对的是「全部 / 上门服务 / 暖通工程 / 草稿 / 已发布」这样一串 ——
 *    读起来像同一个维度的五个互斥选项，实际是**两个维度**：
 *      第一组问"做什么业务"，第二组问"发布到什么程度"。
 *    一个人不可能同时只属于"暖通工程"和"已发布"中的某一个。
 *   ⇒ 拆成两行，各带一个小标题，各自独立可清。
 */

/** 第一组：做什么业务（服务类型） */
const TYPE_TABS: { key: '' | 'service' | 'hvac'; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'service', label: '上门服务' },
  { key: 'hvac', label: '暖通工程' },
];

/** 第二组：发布到什么程度（可见性） */
const VIS_FILTERS: { key: string; label: string }[] = [
  { key: 'draft', label: '草稿' },
  { key: 'published', label: '已发布' },
];

/**
 * 从 URL 读筛选条件。
 *
 * ===========================================================================
 * 🔴 为什么筛选必须进 URL（用户第六节点名要观察的那一条）
 * ===========================================================================
 *  「观察…**返回后是否丢失输入或筛选条件**。」
 *
 *   本页进详情是 `navigate('/archives/:id')`、返回是 `history.back()`。
 *   返回后会重新挂载本组件，而 `useState('')` 的初值永远是空
 *   ⇒ **用户筛好"暖通工程 + 草稿"、点进一条档案、再返回，筛选全没了**，
 *     得从头再点两遍。这在真实门店里是每天都在发生的小折磨。
 *
 *   工单列表（`TicketList.tsx`）早已把筛选放进 URL，档案列表当时漏了 ——
 *   同一种意图两处实现，必然只做对一处（工程铁律 ④）。
 *   ⇒ 这里对齐工单列表的做法：`type` / `visibility` / `kw` 都从 query 读。
 *
 * ⚠️ 参数值不由前端校验合法性（与 `parseRoute` 的既有约定一致）：
 *    服务端不认识的值只会查出 0 条，不会越权。这里只做去空格。
 */
function filterFromQuery(query: URLSearchParams): { type: '' | 'service' | 'hvac'; visibility: string; kw: string } {
  const t = (query.get('type') ?? '').trim();
  return {
    type: t === 'service' || t === 'hvac' ? t : '',
    visibility: (query.get('visibility') ?? '').trim(),
    kw: (query.get('keyword') ?? '').trim(),
  };
}

/** 把筛选条件写回 URL（`replace`，不新增历史项 —— 筛选不是"去过一个地方"） */
function queryFromFilter(type: string, visibility: string, kw: string): string {
  const q = new URLSearchParams();
  if (type) q.set('type', type);
  if (visibility) q.set('visibility', visibility);
  if (kw.trim()) q.set('keyword', kw.trim());
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function ArchiveListPage() {
  const { caps } = useSession();
  const route = useRoute();
  const [storeName, setStoreName] = useState<string | null>(null);
  /**
   * ⚠️ 初始值只算一次（`useState` 的惰性初值）。
   *    若写成 `useState(filterFromQuery(route.query).type)` 并把 route 放进依赖，
   *    每次 query 变化都会重置用户正在操作的筛选 —— 那就是"边筛边被清"。
   *    从 URL 读初值是**进入页面**这一件事，不是持续同步。
   */
  const initial = useState(() => filterFromQuery(route.query))[0];
  const [type, setType] = useState<'' | 'service' | 'hvac'>(initial.type);
  const [visibility, setVisibility] = useState(initial.visibility);
  const [kw, setKw] = useState(initial.kw);
  const [rows, setRows] = useState<ArchiveRow[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<'loading' | 'more' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const seq = useRef(0);

  useScrollTopOnRouteChange('archives');
  const tabs = useWorkspaces();

  /**
   * 筛选变化 ⇒ 写回 URL。
   *
   * ⚠️ 用 `replaceState` 而不是 `navigate`：
   *    `navigate` 会 push 一条历史项，于是"点三个筛选 + 返回"要按四次才能回上一页。
   *    筛选是**当前页面的视图状态**，不是"去过的地方"。
   *    （`navigate(..., {replace:true})` 也可以，但它会派发 popstate、
   *      触发 `useRoute` 重渲染；这里直接改 history 更轻，且没有订阅者需要通知。）
   */
  useEffect(() => {
    /**
     * ⚠️ 只**替换 search**，路径原样保留。
     *    不要在这里自己拼 `BASE + '/archives'` —— `BASE` 是 router.ts 的
     *    模块内常量（未导出），前端再写一份就等于把 `/m` 前缀抄成两处，
     *    base 一改必有一条腿掉队（工程铁律 ④）。
     *    当前路径是什么就留什么：本组件只服务 `/m/archives`。
     */
    const search = queryFromFilter(type, visibility, kw);
    if (location.search !== search) {
      history.replaceState({}, '', location.pathname + search);
    }
  }, [type, visibility, kw]);

  useEffect(() => {
    void singleStoreName().then(setStoreName);
  }, []);

  /** 有没有任何生效的筛选条件 —— 空状态的文案由它决定，不是由"结果为空"决定 */
  const hasFilter = Boolean(type || visibility || kw.trim());

  const clearAll = useCallback(() => {
    setType('');
    setVisibility('');
    setKw('');
  }, []);

  const load = useCallback(
    async (page: number, append: boolean) => {
      const my = ++seq.current;
      setState(append ? 'more' : 'loading');
      // ⚠️ 每次筛选变化都要清 error，否则"上次的错误页"会盖住本次的成功结果
      setError(null);
      const f: ArchiveFilter = { type, visibility, keyword: kw.trim() || undefined };
      try {
        const r = await ArchiveApiAdapter.list(f, page, PAGE_SIZE);
        if (my !== seq.current) return;
        setRows((p) => (append ? [...p, ...r.rows] : r.rows));
        setTotal(r.total);
        setState('ready');
        if (!append) {
          // ⚠️ findScrollContainer 而非 '.k-page' —— 后者不滚（空转），
          //    换了筛选条件却停在旧位置，用户会以为"筛选没生效"。
          findScrollContainer().scrollTo({ top: 0, behavior: 'auto' });
        }
      } catch (e) {
        if (my !== seq.current) return;
        setError(e);
        setState('error');
      }
    },
    [type, visibility, kw],
  );

  useEffect(() => {
    void load(1, false);
  }, [load]);

  return (
    <AppShell tabs={tabs} activeTab="archives">
      <PageHeader
        title="服务档案"
        subtitle={storeName ?? undefined}
        right={
          caps.archiveCreate ? (
            <button
              className="svc-icon-btn text-svc-brand"
              aria-label="新建档案"
              onClick={() => navigate('/archives/new')}
              data-testid="archives-new"
            >
              <IconPlus />
            </button>
          ) : undefined
        }
      />

      <div className="sticky top-0 z-10 bg-svc-bg px-4 pt-2 pb-2">
        <Searchbar
          placeholder="档案号 / 客户 / 电话 / 地址"
          value={kw}
          onInput={(e: any) => setKw(e.target.value)}
          onClear={() => setKw('')}
          disableButton
          data-testid="archives-search"
        />

        {/*
          两个维度各占一行，各带小标题。
          第一行 = 业务类型；第二行 = 发布状态。二者可任意组合，互不干扰。
        */}
        <FilterRow label="服务类型">
          {TYPE_TABS.map((t) => (
            <FilterPill key={t.key || 'all'} on={type === t.key} onClick={() => setType(t.key)}>
              {t.label}
            </FilterPill>
          ))}
        </FilterRow>

        <FilterRow label="发布状态">
          {VIS_FILTERS.map((v) => (
            <FilterPill
              key={v.key}
              on={visibility === v.key}
              onClick={() => setVisibility((cur) => (cur === v.key ? '' : v.key))}
            >
              {v.label}
            </FilterPill>
          ))}
          {hasFilter ? (
            <button
              className="text-svc-brand min-h-touch ml-auto shrink-0 px-2 text-[12px]"
              onClick={clearAll}
              data-testid="archives-clear-filter"
            >
              清空
            </button>
          ) : null}
        </FilterRow>
      </div>

      {state === 'loading' ? (
        <LoadingState rows={4} />
      ) : state === 'error' ? (
        <ErrorState error={error} onRetry={() => void load(1, false)} />
      ) : rows.length === 0 ? (
        /**
         * ⚠️ 空状态必须区分"筛出来是空的"与"真的一条都没有"。
         *
         *   整改前这里**无条件**写"还没有服务档案"，并按权限给一个"新建档案"按钮。
         *   实测后果：搜一个不存在的客户 → 页面说"还没有服务档案" →
         *   销售以为库里真空了（或者以为刚才建的没存上）→ 顺手再建一条重复档案。
         *   这是**由文案造成的业务事故**，而界面看起来"很正常"。
         *
         *   ⇒ 有筛选条件时：说"没有找到" + 只给"查看全部"；
         *     无筛选条件时：才是真的没有，这时给建档入口才对得上。
         */
        hasFilter ? (
          <EmptyState
            title="没有找到"
            description="换个词试试，或查看全部。"
            action={
              <Button tonal onClick={clearAll} data-testid="archives-empty-clear">
                查看全部
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="还没有服务档案"
            description={
              caps.archiveCreate
                ? '新建一条上门服务或暖通工程档案后，会出现在这里。'
                : '当前门店还没有服务档案。'
            }
            action={
              caps.archiveCreate ? (
                <Button onClick={() => navigate('/archives/new')} data-testid="archives-empty-create">
                  新建档案
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <div className="px-4 pb-24" data-testid="archives-list">
          <div className="text-svc-ink-3 py-2 text-[12px]">共 {total} 条</div>
          {rows.map((r) => (
            <ArchiveCard key={r.id} row={r} onOpen={() => navigate(`/archives/${r.id}`)} />
          ))}
          {rows.length < total ? (
            <Button tonal disabled={state === 'more'} onClick={() => void load(rows.length / PAGE_SIZE + 1, true)}>
              {state === 'more' ? '加载中…' : '加载更多'}
            </Button>
          ) : (
            <div className="text-svc-ink-3 py-6 text-center text-[12px]">已经到底了</div>
          )}
        </div>
      )}
    </AppShell>
  );
}

/**
 * 一行筛选：小标题 + 可横向滚动的选项。
 *
 * ⚠️ 每组**各自**横向滚动，而不是把两组塞进同一个滚动容器 ——
 *    混在一起时用户滑到最右才发现"后面还有另一半条件"。
 */
function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-svc-ink-3 shrink-0 text-[11px]">{label}</span>
        <span className="bg-svc-line h-px flex-1" aria-hidden="true" />
      </div>
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">{children}</div>
    </div>
  );
}

function FilterPill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`min-h-touch shrink-0 rounded-full border px-3 text-[12px] whitespace-nowrap ${
        on ? 'border-svc-brand bg-svc-brand text-white' : 'border-svc-line bg-svc-surface text-svc-ink-2'
      }`}
    >
      {children}
    </button>
  );
}

/** 类型切换入口（新建页选类型时复用同一份元数据，避免两处各写一遍） */
export const CREATE_TYPE_CARDS = Object.entries(ARCHIVE_TYPE_META).map(([k, v]) => ({
  key: k as 'service' | 'hvac',
  ...v,
}));

export { TONE_CLASS };

function IconPlus() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}
