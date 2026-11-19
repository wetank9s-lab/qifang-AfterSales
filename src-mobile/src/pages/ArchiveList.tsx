/**
 * B 页之一：服务档案列表（门店销售）。
 *
 * ===========================================================================
 * R2.2.1 重做（用户第 7.1 条）
 * ===========================================================================
 *   改造要点：
 *     ① 筛选**只保留一维**：全部 / 上门服务 / 暖通工程。
 *        「草稿 / 已发布」整组删除 —— 保存即发布之后，列表里除了存量草稿
 *        全是已发布，那一组筛选永远只能筛出 0 条或全部。
 *        用户第 7.1 条原话：「**不显示草稿筛选、已发布筛选、草稿标签、已发布标签**」。
 *     ② 筛选用**圆角矩形分段控件**，不再用 `rounded-full` 胶囊（审计 P-01）。
 *     ③ 卡片换 `QFServiceCard`：客户姓名 20px 打头、服务内容其次、
 *        档案号掉到脚注——用户明令「客户姓名和服务内容优先，档案编号放次要位置」。
 *     ④ 空态三态分离（真没数据 / 筛不到 / 加载失败）由 `states.tsx` 的三个组件承担。
 *
 * ===========================================================================
 * 这里为什么没有底部导航
 * ===========================================================================
 *   门店销售的实际工作只有一个：服务档案（建档 / 查档 / 跟进）。
 *   挂一个**只有"档案"一项**的底栏，点它还在原地，不提供任何导航，
 *   只白占 50px + 安全区，还会让人误以为"底下还能去别处"。
 *
 * ===========================================================================
 * 这里最需要小心的一件事：门店不是前端选的
 * ===========================================================================
 *   服务端 A5-B3：请求不传 store_id ⇒ 由服务端按当前账号的**唯一有效门店**推导。
 *   所以本页不显示任何门店选择器；顶部那行店名只是装饰（取不到就不显示）。
 *   若让用户选店，等于允许销售把客户住址写进别家店。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppShell,
  PageHeader,
  useScrollTopOnRouteChange,
  findScrollContainer,
} from '../components/AppShell';
import { useWorkspaces } from '../app/workspaces';
import {
  QFButton,
  QFCard,
  QFEmptyState,
  QFErrorState,
  QFIconButton,
  QFLoadingSkeleton,
  QFNarrowEmptyState,
  QFSearchField,
  QFServiceCard,
  describeQFError,
} from '../components/qf';
import { ArchiveApiAdapter, type ArchiveFilter, type ArchiveRow } from '../api/archives';
import { singleStoreName } from '../api/stores';
import { navigate, useRoute } from '../router';
import { useSession } from '../app/session-context';

const PAGE_SIZE = 20;

type TypeKey = '' | 'service' | 'hvac';

/** 服务类型三档（用户第 7.1 条：只有这三档） */
const TYPE_OPTIONS: { value: 'service' | 'hvac'; label: string }[] = [
  { value: 'service', label: '上门服务' },
  { value: 'hvac', label: '暖通工程' },
];

/**
 * 从 URL 读筛选条件。
 *
 * ===========================================================================
 * 🔴 为什么筛选必须进 URL
 * ===========================================================================
 *   本页进详情是 `navigate('/archives/:id')`、返回是 `history.back()`。
 *   返回后会重新挂载本组件，而 `useState('')` 的初值永远是空
 *   ⇒ **筛好"暖通工程"、点进一条档案、再返回，筛选全没了**。
 *   工单列表早已把筛选放进 URL，档案列表当时漏了 ——
 *   同一种意图两处实现，必然只做对一处（工程铁律 ④）。
 *
 * ⚠️ R2.2.1：`visibility` 参数**已从 URL 契约里移除**。
 *    旧链接里带着 `?visibility=draft` 的，这里读不到就忽略，
 *    不会报错也不会被当成筛选条件（否则会出现"以为没筛，其实在筛"）。
 */
function filterFromQuery(query: URLSearchParams): { type: TypeKey; kw: string } {
  const t = (query.get('type') ?? '').trim();
  return {
    type: t === 'service' || t === 'hvac' ? t : '',
    kw: (query.get('keyword') ?? '').trim(),
  };
}

/** 把筛选条件写回 URL（`replace`，不新增历史项 —— 筛选不是"去过一个地方"） */
function queryFromFilter(type: TypeKey, kw: string): string {
  const q = new URLSearchParams();
  if (type) q.set('type', type);
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
   *    若把 route 放进依赖持续同步，每次 query 变化都会重置用户正在操作的筛选。
   *    从 URL 读初值是**进入页面**这一件事，不是持续同步。
   */
  const initial = useState(() => filterFromQuery(route.query))[0];
  const [type, setType] = useState<TypeKey>(initial.type);
  const [kw, setKw] = useState(initial.kw);
  const [rows, setRows] = useState<ArchiveRow[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<'loading' | 'more' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const seq = useRef(0);

  useScrollTopOnRouteChange('archives');
  const tabs = useWorkspaces();

  /** 筛选变化 ⇒ 写回 URL（`replaceState`，不 push 历史项） */
  useEffect(() => {
    const search = queryFromFilter(type, kw);
    if (location.search !== search) {
      history.replaceState({}, '', location.pathname + search);
    }
  }, [type, kw]);

  useEffect(() => {
    void singleStoreName().then(setStoreName);
  }, []);

  /** 有没有任何生效的筛选条件 —— 空态文案由它决定，不是由"结果为空"决定 */
  const hasFilter = Boolean(type || kw.trim());

  const clearAll = useCallback(() => {
    setType('');
    setKw('');
  }, []);

  const load = useCallback(
    async (page: number, append: boolean) => {
      const my = ++seq.current;
      setState(append ? 'more' : 'loading');
      // ⚠️ 每次筛选变化都要清 error，否则"上次的错误页"会盖住本次的成功结果
      setError(null);
      /**
       * ⚠️ R2.2.1：**不再传 visibility**。
       *    接口仍支持这个参数（存量草稿要靠它在后台看），
       *    但员工端列表已经不提供这个维度 —— 传了就等于
       *    "界面上看不见的条件仍在生效"，那是排查噩梦。
       */
      const f: ArchiveFilter = { type, keyword: kw.trim() || undefined };
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
    [type, kw],
  );

  useEffect(() => {
    void load(1, false);
  }, [load]);

  const errInfo = describeQFError(error);

  return (
    <AppShell tabs={tabs} activeTab="archives">
      <PageHeader
        title="服务档案"
        subtitle={storeName ?? undefined}
        right={
          caps.archiveCreate ? (
            <QFIconButton ariaLabel="新建档案" onClick={() => navigate('/archives/new')} testId="archives-new">
              <IconPlus />
            </QFIconButton>
          ) : undefined
        }
      />

      {/*
        顶部筛选区：搜索框 + 服务类型分段。
        ⚠️ `bg-svc-bg` 而不是 `bg-svc-surface`：
           它是"筛选工具"，不是内容。和下方白卡片形成层级差，
           才是 iOS 列表页的观感（内容区白、工具栏灰）。
      */}
      <div className="bg-svc-bg sticky top-0 z-10 px-4 pt-2 pb-2" data-testid="archives-filters">
        <QFSearchField
          value={kw}
          onChange={setKw}
          placeholder="客户 / 档案号 / 电话 / 地址"
          testId="archives-search"
        />

        <div className="mt-2">
          {/*
            ⚠️ 三段：全部 / 上门服务 / 暖通工程。
                `QFSegmented` 的 value 只接受 `T | ''`，而"全部"就是空串 ——
                所以额外渲染"全部"这一格时必须把空串当合法值传下去。
                这里不把"全部"塞进 options（否则 grid 会算出 3 列但只有 2 个真实类型，
                将来加类型时又得改列数），而是单独渲染一个选项。
          */}
          <div
            role="radiogroup"
            aria-label="服务类型"
            className="bg-svc-bg grid gap-0.5 rounded-svc p-[3px]"
            style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}
            data-testid="archives-type"
            data-qf-control="segmented"
          >
            <SegBtn on={type === ''} onClick={() => setType('')}>
              全部
            </SegBtn>
            {TYPE_OPTIONS.map((o) => (
              <SegBtn key={o.value} on={type === o.value} onClick={() => setType(o.value)}>
                {o.label}
              </SegBtn>
            ))}
          </div>
        </div>
      </div>

      {state === 'loading' ? (
        <QFLoadingSkeleton rows={4} label="正在加载服务档案" />
      ) : state === 'error' ? (
        <QFErrorState info={errInfo} onRetry={() => void load(1, false)} testId="archives-error" />
      ) : rows.length === 0 ? (
        /**
         * ⚠️ 空状态必须区分"筛出来是空的"与"真的一条都没有"。
         *
         *   旧版这里**无条件**写"还没有服务档案"。实测后果：
         *   搜一个不存在的客户 → 页面说"还没有服务档案" →
         *   销售以为库里真空了（或以为刚建的没存上）→ 顺手再建一条重复档案。
         *   这是**由文案造成的业务事故**，而界面看起来"很正常"。
         */
        hasFilter ? (
          <QFNarrowEmptyState onClear={clearAll} keyword={kw.trim()} testId="archives-empty-clear" />
        ) : (
          <QFEmptyState
            title="还没有服务档案"
            description={
              caps.archiveCreate
                ? '新建一条上门服务或暖通工程档案后，会出现在这里。'
                : '当前门店还没有服务档案。'
            }
            action={
              caps.archiveCreate ? (
                <QFButton onClick={() => navigate('/archives/new')} testId="archives-empty-create">
                  新建档案
                </QFButton>
              ) : undefined
            }
            testId="archives-empty"
          />
        )
      ) : (
        <div className="px-4 pb-24" data-testid="archives-list">
          <div className="text-svc-ink-3 qf-foot py-2" data-testid="archives-total">
            共 {total} 条
          </div>
          {rows.map((r) => (
            <QFServiceCard key={r.id} row={r} onOpen={() => navigate(`/archives/${r.id}`)} />
          ))}
          {rows.length < total ? (
            <LoadMore loading={state === 'more'} onClick={() => void load(rows.length / PAGE_SIZE + 1, true)} />
          ) : (
            <div className="text-svc-ink-3 qf-foot py-6 text-center">已经到底了</div>
          )}
        </div>
      )}
    </AppShell>
  );
}

/* ------------------------------------------------------------------ 局部件 */

/** 分段控件里的单个选项（与 `QFSegmented` 内部一致：白底滑块 + 8px 圆角） */
function SegBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      /**
       * ⚠️ `min-h-touch`(44) 而不是 38 —— 与 `QFSegmented` 保持同值。
       *
       * 2026-11-19 验收实测：这里写 38 时，可点区域只有 38px（父容器 p-[3px]
       * 不构成命中区）。44 + 3×2 = 50，正好等于 `qf-control` 输入框高度，
       * 一屏里只有一种控件高度。
       *
       * 另外这个控件是**自渲染**而不是复用 QFSegmented 的：
       * 原因是"全部"是空串，而 QFSegmented 的 options 需要 T 型值；
       * 但两处的尺寸/圆角/选中态样式必须**逐字一致**，否则同一个视觉语言
       * 会在两个页面里长出两种样子。
       */
      className={`qf-pressable flex min-h-touch items-center justify-center px-2 text-center transition-colors ${
        on ? 'bg-svc-surface text-svc-ink shadow-[0_1px_2px_rgba(0,0,0,0.10)]' : 'text-svc-ink-2 bg-transparent'
      }`}
      style={{ borderRadius: 8 }}
    >
      <span className="qf-sub leading-tight font-medium">{children}</span>
    </button>
  );
}

/**
 * 加载更多。
 *
 * ⚠️ 用 `QFCard` 包一层而不是放一个裸按钮：
 *    裸按钮在暗色背景上会看起来像"页面结束了"，
 *    而它其实是一个可点的区域。卡片的按压反馈能说清这件事。
 */
function LoadMore({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <QFCard testId="archives-load-more" onClick={loading ? undefined : onClick} className="mt-1">
      <div className="text-svc-brand-text qf-body flex min-h-touch items-center justify-center font-medium">
        {loading ? '加载中…' : '加载更多'}
      </div>
    </QFCard>
  );
}

function IconPlus() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}
