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

/**
 * 业务进度筛选项（R2.2.5 §六）。
 *
 * 🔴 用户原话：「普通上门服务增加**轻量进度筛选**（全部 / 待服务 / 服务中 / 已完成）」。
 *
 * ⚠️ 只有三档，不是七档：**不恢复**「草稿 / 已发布」「已预约 / 已验收」这些。
 *    `scheduled`（已预约）在库里确实存在（历史数据），但它与待服务是
 *    **同一个下一步**（都该点"开始服务"），单列一档只是把同一个待办拆成两栏。
 *    `accepted`（已验收）同理并进"已完成"—— 销售的操作到"已完成"就结束了。
 * ⚠️ `pending` 一档在筛选时**必须同时匹配 `scheduled`**：
 *    否则历史 `scheduled` 档案在"待服务"里看不到、在"全部"里看得到，
 *    用户会以为筛掉了数据。`buildFilter` 用的是精确等于，所以这里
 *    用一个特殊值 `pending` + 在 `buildFilter` 里展开成 `$in`。
 */
type StatusKey = '' | 'pending' | 'serving' | 'completed';

const STATUS_OPTIONS: { value: Exclude<StatusKey, ''>; label: string }[] = [
  { value: 'pending', label: '待服务' },
  { value: 'serving', label: '服务中' },
  { value: 'completed', label: '已完成' },
];

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
function filterFromQuery(query: URLSearchParams): { type: TypeKey; kw: string; status: StatusKey } {
  const t = (query.get('type') ?? '').trim();
  const s = (query.get('status') ?? '').trim();
  return {
    type: t === 'service' || t === 'hvac' ? t : '',
    kw: (query.get('keyword') ?? '').trim(),
    /**
     * ⚠️ 进度筛选也进 URL（同 type / keyword 的理由）：
     *    进详情再返回时 `useState('')` 会把筛选重置成"全部"，
     *    用户就会以为"筛出来的结果又变回去了"。
     * ⚠️ 白名单收窄：URL 里出现未知值（例如旧链接的 `?status=draft`）
     *    一律当"全部"，**不要**把它透传给接口 —— 那会变成一个
     *    界面上看不见、却在生效的筛选条件（排查噩梦）。
     */
    status: s === 'pending' || s === 'serving' || s === 'completed' ? s : '',
  };
}

/** 把筛选条件写回 URL（`replace`，不新增历史项 —— 筛选不是"去过一个地方"） */
function queryFromFilter(type: TypeKey, kw: string, status: StatusKey): string {
  const q = new URLSearchParams();
  if (type) q.set('type', type);
  if (kw.trim()) q.set('keyword', kw.trim());
  if (status) q.set('status', status);
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
  const [statusKey, setStatusKey] = useState<StatusKey>(initial.status);
  const [rows, setRows] = useState<ArchiveRow[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<'loading' | 'more' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const seq = useRef(0);

  useScrollTopOnRouteChange('archives');
  const tabs = useWorkspaces();

  /** 筛选变化 ⇒ 写回 URL（`replaceState`，不 push 历史项） */
  useEffect(() => {
    const search = queryFromFilter(type, kw, statusKey);
    if (location.search !== search) {
      history.replaceState({}, '', location.pathname + search);
    }
  }, [type, kw, statusKey]);

  useEffect(() => {
    void singleStoreName().then(setStoreName);
  }, []);

  /** 有没有任何生效的筛选条件 —— 空态文案由它决定，不是由"结果为空"决定 */
  const hasFilter = Boolean(type || kw.trim() || statusKey);

  const clearAll = useCallback(() => {
    setType('');
    setKw('');
    setStatusKey('');
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
      const f: ArchiveFilter = {
        type,
        keyword: kw.trim() || undefined,
        // 进度筛选：`pending`/`completed` 会被 `buildFilter` 展开成多值（见 STATUS_GROUP）
        status: statusKey || undefined,
      };
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
    [type, kw, statusKey],
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

            🔴 R2.2.1 §二：「服务类型三段选择器**未选中项也必须清晰可见**」。
               旧实现轨道底色是 `bg-svc-bg`（#F2F2F7）—— 与页面底色同值，
               于是整条轨道**看不见**，页面上只剩一个浮着的白块，
               看起来像"只有一个按钮"。这正是候选版截图 02 上被指出的问题。
               ⇒ 轨道改 `#E7E7EC`（设计稿值，比页面底色明显下沉一档），
                 未选中文字用 `#51515A`（不是 ink-2 的 #5F6670，更实一档）。
          */}
          <div
            role="radiogroup"
            aria-label="服务类型"
            className="qf-seg-track grid gap-1 rounded-svc-lg p-1"
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

        {/*
          ============================================================
          进度筛选（R2.2.5 §六「轻量进度筛选」）
          ============================================================

          🔴 为什么是**四段**而不是五个按钮或一行 chips：
             全部 / 待服务 / 服务中 / 已完成 —— 正好覆盖员工脑子里的
             "这一单现在到哪一步"。用户原话给的也是这四档。

          ⚠️ 与上面"服务类型"用同一套控件形态（`qf-seg-track` + `SegBtn`），
             **不复用 `QFSegmented` 的原因同上方注释**：这里同样有一个
             "全部"是空串。
          ⚠️ 它必须比服务类型**低一档视觉权重**：类型是"我在看哪类生意"，
             进度是"我在找哪一单"。所以它放在第二行、不换控件形态 ——
             换形态会让两条筛选看起来属于两个不同的功能区。

          ⚠️ 只在**没有一个类型筛选**或**选了"上门服务"**时显示？
             不。暖通档案 status 也是 pending/serving/completed（六阶段推进时
             服务端会写 serving / accepted），所以这四档对暖通同样有意义。
             全局都显示，反而是最简单的正确做法。
        */}
        <div className="mt-2">
          <div
            role="radiogroup"
            aria-label="服务进度"
            className="qf-seg-track grid gap-1 rounded-svc-lg p-1"
            style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}
            data-testid="archives-status"
            data-qf-control="segmented"
          >
            <SegBtn on={statusKey === ''} onClick={() => setStatusKey('')}>
              全部
            </SegBtn>
            {STATUS_OPTIONS.map((o) => (
              <SegBtn key={o.value} on={statusKey === o.value} onClick={() => setStatusKey(o.value)}>
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
            <QFServiceCard
              key={r.id}
              row={r}
              onOpen={() => navigate(`/archives/${r.id}`)}
              /*
                🔴 R2.2.5 §六：卡片快捷操作。

                用户原话：「待服务→开始服务；服务中→完成服务；已完成→查看记录」，
                并且明令「快捷操作**打开对应业务面板，不直接修改状态**」。

                ⇒ 这里只做一件事：带上 `?act=` 跳到详情页，由详情页打开对应面板。
                  为什么不是在本页弹面板：完成服务需要"实际日期 + 前后照片 + 备注"，
                  那是一整张表单，而列表项上没有照片上下文 —— 在列表里弹出来，
                  用户得先加载照片才知道缺什么，等于把一个详情页塞进列表。
                  "跳过去并自动打开"少一次点击，且所有上下文都在。

                ⚠️ `caps.archiveCreate`（写权限位）不够时**不给快捷操作**：
                   店长/总部点进去也只能看到一个只读提示，不如不给这个按钮，
                   免得他们以为"点了没反应"。
              */
              quickAction={
                caps.archiveCreate
                  ? (() => {
                      const st = String(r.status ?? '');
                      if (st === 'pending' || st === 'scheduled') {
                        return {
                          text: '开始服务',
                          onClick: () => navigate(`/archives/${r.id}?act=start`),
                          testId: `archive-quick-start-${r.id}`,
                        };
                      }
                      if (st === 'serving') {
                        return {
                          text: '完成服务',
                          onClick: () => navigate(`/archives/${r.id}?act=complete`),
                          testId: `archive-quick-complete-${r.id}`,
                        };
                      }
                      if (st === 'completed' || st === 'accepted') {
                        return {
                          text: '查看记录',
                          onClick: () => navigate(`/archives/${r.id}`),
                          testId: `archive-quick-view-${r.id}`,
                        };
                      }
                      return undefined;
                    })()
                  : undefined
              }
            />
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
       * 不构成命中区）。44 + 4×2 = 52，正好等于 `qf-control` 输入框高度，
       * 一屏里只有一种控件高度。
       *
       * 另外这个控件是**自渲染**而不是复用 QFSegmented 的：
       * 原因是"全部"是空串，而 QFSegmented 的 options 需要 T 型值；
       * 但两处的尺寸/圆角/选中态样式必须**逐字一致**，否则同一个视觉语言
       * 会在两个页面里长出两种样子。
       *
       * ⚠️ 选中态的字色是 `#0053B5` 而不是 `--color-svc-brand-text`(#0062CC)：
       *    设计稿如此，且它是**轨道内**的选中项 —— 与轨道底 #E7E7EC 组合时
       *    对比度 5.9:1，够。用变量会把它拉成与页面别处蓝字同色，
       *    反而看不出"这是被选中的那一格"。
       */
      className={`qf-pressable flex min-h-touch items-center justify-center px-2 text-center transition-colors ${
        on
          ? 'bg-svc-surface shadow-[0_1px_2px_rgba(0,0,0,0.10)]'
          : 'bg-transparent'
      }`}
      style={{
        borderRadius: 8,
        ...(on ? { fontWeight: 700 } : {}),
      }}
      data-qf-seg={on ? 'on' : 'off'}
    >
      <span className={`qf-sub leading-tight ${on ? 'qf-seg-on' : 'qf-seg-off'} font-semibold`}>{children}</span>
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
