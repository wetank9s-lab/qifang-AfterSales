/**
 * 服务查询 —— 员工端**唯一**的搜索入口（2026-11-14）
 * =============================================================================
 * 用户要求
 * -----------------------------------------------------------------------------
 *   "员工端建设一个『服务查询』入口。支持在现有权限内查询：售后工单、
 *    上门服务档案、暖通工程档案。统一搜索框、筛选样式、结果卡片和空状态。
 *    搜索范围按照角色与门店权限自动确定。"
 *
 * =============================================================================
 * 设计上的三条硬约束
 * =============================================================================
 *   ① **不新建数据表、不合并工单与档案**
 *      两者是不同生命周期的东西（工单是一次服务的流水，档案是设备的长期记录），
 *      合表会把"客户报修"和"设备台账"混成一堆。这里只做**展示层聚合**：
 *      同一个搜索框，分别打两个既有 API，把结果并排呈现。
 *
 *   ② **权限决定"看到哪一栏"，不是"看到了但点不进去"**
 *      · 只有档案权限（门店销售）→ 只出现"服务档案"，**不出现工单分类**
 *        （用户原话："销售只有档案权限时不展示无效的售后工单分类"）
 *      · 只有工单权限（门店售后）→ 只出现"售后工单"
 *      · 两类都有（负责人 / 总部）→ 出现"全部 / 售后工单 / 服务档案"切换
 *      ⇒ 前端按 `caps` 决定**发不发请求**，而不是拿到结果再藏起来。
 *         后者会把无权数据下载到浏览器（虽然服务端已裁过，但白花流量）。
 *
 *   ③ **不靠手机号自动合并客户 / 跨店记录**
 *      用户明确禁止。这里的"全部"只是两类结果并排，不做任何实体合并。
 *
 * =============================================================================
 * 为什么搜索框不是"边打字边发请求"
 * =============================================================================
 *   两个列表接口都是 NocoBase 的 `:list`，带 ACL 与门店裁剪。
 *   逐键请求会在 3~5 个字符时打出 5 次并发查询，弱网下结果乱序返回，
 *   用户会看到"字打完了，列表却是前两个字的"。
 *   ⇒ 只在**回车 / 点搜索 / 清空**时发一次；清空即回到"全部"。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { navigate } from '../router';
import { AppShell, PageHeader } from '../components/AppShell';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { ArchiveCard, TicketCard } from '../components/Domain';
import { useSession } from '../app/session-context';
import { useWorkspaces } from '../app/workspaces';
import { ArchiveApiAdapter, type ArchiveRow } from '../api/archives';
import { TicketApiAdapter, type TicketRow } from '../api/tickets';

type Scope = 'all' | 'tickets' | 'archives';

interface Result {
  tickets: TicketRow[];
  archives: ArchiveRow[];
  ticketTotal: number;
  archiveTotal: number;
}

const EMPTY: Result = { tickets: [], archives: [], ticketTotal: 0, archiveTotal: 0 };

/** 搜索框（iOS 搜索栏样式：圆角 10、浅灰底、左侧放大镜） */
function SearchBar({
  value,
  onChange,
  onSubmit,
  onClear,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  placeholder: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="px-4 pt-2 pb-3">
      <div className="bg-svc-surface-2 flex min-h-touch items-center gap-2 rounded-svc px-3">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             className="text-svc-ink-3 shrink-0" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.6-3.6" strokeLinecap="round" />
        </svg>
        <input
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
          placeholder={placeholder}
          className="text-svc-ink placeholder:text-svc-ink-3 min-w-0 flex-1 bg-transparent text-[16px] outline-none"
          data-testid="search-input"
          enterKeyHint="search"
        />
        {value ? (
          <button
            onClick={() => { onChange(''); onClear(); ref.current?.focus(); }}
            className="text-svc-ink-3 shrink-0 px-1 text-[15px]"
            aria-label="清空"
            data-testid="search-clear"
          >
            清空
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 分类切换（只有两类权限都有时才渲染） */
function ScopeTabs({ value, onChange }: { value: Scope; onChange: (s: Scope) => void }) {
  const items: { key: Scope; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'tickets', label: '售后工单' },
    { key: 'archives', label: '服务档案' },
  ];
  return (
    <div className="bg-svc-surface-2 mx-4 mb-3 flex rounded-svc p-1" role="tablist" data-testid="scope-tabs">
      {items.map((it) => {
        const on = it.key === value;
        return (
          <button
            key={it.key}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(it.key)}
            className={`min-h-touch flex-1 rounded-[7px] text-[15px] transition-colors ${
              on ? 'bg-svc-surface text-svc-ink font-medium shadow-sm' : 'text-svc-ink-2'
            }`}
            data-testid={`scope-${it.key}`}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

export function ServiceSearchPage() {
  const { caps } = useSession();
  const tabs = useWorkspaces();

  /**
   * 权限 → 可见分类。
   * ⚠️ 这是**发不发请求**的依据，不是"拿到再过滤"。
   */
  const canTickets = caps.tickets;
  const canArchives = caps.archives;
  const both = canTickets && canArchives;

  const [scope, setScope] = useState<Scope>(both ? 'all' : canTickets ? 'tickets' : 'archives');
  const [draft, setDraft] = useState('');
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<Result>(EMPTY);

  const run = useCallback(async (kw: string, sc: Scope) => {
    setLoading(true);
    setError(null);
    try {
      const wantTickets = canTickets && (sc === 'all' || sc === 'tickets');
      const wantArchives = canArchives && (sc === 'all' || sc === 'archives');
      const [t, a] = await Promise.all([
        wantTickets ? TicketApiAdapter.list({ keyword: kw }, 1, 20) : Promise.resolve(null),
        wantArchives ? ArchiveApiAdapter.list({ keyword: kw }, 1, 20) : Promise.resolve(null),
      ]);
      setResult({
        tickets: t?.rows ?? [],
        archives: a?.rows ?? [],
        ticketTotal: t?.total ?? 0,
        archiveTotal: a?.total ?? 0,
      });
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [canTickets, canArchives]);

  useEffect(() => { void run(keyword, scope); }, [keyword, scope, run]);

  const submit = () => setKeyword(draft.trim());
  const clear = () => { setDraft(''); setKeyword(''); };

  const total = result.ticketTotal + result.archiveTotal;
  const showTickets = canTickets && (scope === 'all' || scope === 'tickets');
  const showArchives = canArchives && (scope === 'all' || scope === 'archives');

  const placeholder = useMemo(() => {
    if (both) return '搜工单号 / 档案号 / 客户 / 电话 / 地址';
    if (canTickets) return '搜工单号 / 客户 / 电话 / 问题';
    return '搜档案号 / 客户 / 电话 / 地址';
  }, [both, canTickets]);

  return (
    <AppShell tabs={tabs} activeTab="search">
      <PageHeader title="服务查询" />
      <SearchBar
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        onClear={clear}
        placeholder={placeholder}
      />
      {both ? <ScopeTabs value={scope} onChange={setScope} /> : null}

      {loading ? (
        <LoadingState rows={3} label="正在查询…" />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void run(keyword, scope)} />
      ) : total === 0 ? (
        /*
         * 空状态文案按用户裁决：**只说"没有找到"，并给"查看全部"**。
         * 不写"未查询到符合条件的记录，请调整关键词后重试"这类长句 ——
         * 客户/店员要的只是"有没有"和"怎么回去"。
         */
        <EmptyState
          title="没有找到"
          description={keyword ? `没有与「${keyword}」相关的记录` : undefined}
          action={
            keyword ? (
              <button
                onClick={clear}
                className="text-svc-brand min-h-touch px-4 text-[16px] font-medium"
                data-testid="search-view-all"
              >
                查看全部
              </button>
            ) : null
          }
        />
      ) : (
        <div className="px-4 pb-6">
          {showTickets && result.tickets.length > 0 ? (
            <section data-testid="result-tickets">
              <h2 className="text-svc-ink-2 mb-2 text-[14px] font-medium">售后工单 · {result.ticketTotal}</h2>
              {result.tickets.map((r) => (
                <TicketCard key={`t${r.id}`} row={r} onOpen={() => navigate(`/tickets/${r.id}`)} />
              ))}
            </section>
          ) : null}

          {showArchives && result.archives.length > 0 ? (
            <section className={showTickets && result.tickets.length > 0 ? 'mt-5' : ''} data-testid="result-archives">
              <h2 className="text-svc-ink-2 mb-2 text-[14px] font-medium">服务档案 · {result.archiveTotal}</h2>
              {result.archives.map((r) => (
                <ArchiveCard key={`a${r.id}`} row={r} onOpen={() => navigate(`/archives/${r.id}`)} />
              ))}
            </section>
          ) : null}

          {/* 已选某类但该类无结果：明确说一句，而不是让页面看起来"空的" */}
          {showTickets && result.tickets.length === 0 && scope === 'tickets' ? (
            <EmptyState title="没有找到" description="没有符合条件的售后工单" />
          ) : null}
          {showArchives && result.archives.length === 0 && scope === 'archives' ? (
            <EmptyState title="没有找到" description="没有符合条件的服务档案" />
          ) : null}
        </div>
      )}
    </AppShell>
  );
}
