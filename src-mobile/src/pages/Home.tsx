/**
 * A 页：门店售后 · 工作台（工单首页）。
 *
 * ===========================================================================
 * 整改前这里有一处**结构性矛盾**，必须记住它的形状
 * ===========================================================================
 *   页面把两样**范围不同**的东西并排放着：
 *     · 分组徽标的数字 ← `counts()` = `serviceTickets:list` 按状态计数（全表口径）
 *     · 下方列表        ← `followUpQueue()` = 只含 `PROCESSING` 且
 *                         `next_follow_at` 已到期/今天的工单（**完全不含 NEW**）
 *   于是"待受理 247"下面紧接着写"没有待受理工单"。
 *   两个数字各自都对，**并排放就是错的** —— 用户会归因成"系统烂"。
 *
 *   ⇒ 整改原则：**同一个分区里，数字与列表必须来自同一个 filter。**
 *     徽标 = `counts([group.statuses])`，列表 = `list({statuses: group.statuses})`，
 *     两者共用 `statusIn()` 展开（含 `NEW`/`new` 脏数据），因此数量必然一致。
 *     "今日需跟进"是**另一种范围**，就不能装作同一件事 —— 它独立成块、
 *     标题写明范围、计数就是它自己的条数。
 *
 * ⚠️ 计数只信服务端，绝不"拉全量到前端数"：
 *    543 条时那等于把整张表下载到浏览器，而且前端数出来的数字一旦与服务端
 *    `count` 不一致，又会造出一个新的自相矛盾。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Segmented, SegmentedButton } from 'konsta/react';
import { AppShell, PageHeader, useScrollTopOnRouteChange } from '../components/AppShell';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { TicketCard } from '../components/Domain';
import { TicketApiAdapter, type TicketRow } from '../api/tickets';
import { navigate } from '../router';
import { useSession } from '../app/session-context';
import { useWorkspaces } from '../app/workspaces';

/** 首页分组：只关心"要不要动手"的三类。`statuses` 同时喂给计数与列表 —— 一致性由此保证 */
const GROUPS = [
  { key: 'todo', label: '待受理', statuses: ['NEW'] as string[], empty: '当前没有待受理的工单' },
  {
    key: 'doing',
    label: '处理中',
    statuses: ['PROCESSING', 'WAIT_STORE_CONFIRM'] as string[],
    empty: '当前没有处理中的工单',
  },
  { key: 'done', label: '已闭环', statuses: ['CLOSED'] as string[], empty: '还没有已闭环的工单' },
];

/** 「今日需跟进」一次最多展开几条（超出走工单列表） */
const FOLLOW_UP_PREVIEW = 5;

export function HomePage() {
  const { user, caps } = useSession();
  // 底栏来自唯一来源 app/workspaces.tsx —— 页面不再自己拼 Tab 数组
  const tabs = useWorkspaces();
  const [group, setGroup] = useState<(typeof GROUPS)[number]['key']>('todo');
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  /** 今日需跟进（范围 = 到期与今天，与服务端 `svc:followUpQueue` 完全一致） */
  const [followUp, setFollowUp] = useState<TicketRow[] | null>(null);
  /** 当前分组的列表（范围 = `GROUPS[i].statuses`，与徽标同源） */
  const [rows, setRows] = useState<TicketRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useScrollTopOnRouteChange('home');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 计数、待跟进、分组列表三者互不依赖：并行发，串行会白白多等两个 RTT
      const [c, q, l] = await Promise.all([
        TicketApiAdapter.counts(GROUPS.map((g) => g.statuses[0]!)),
        TicketApiAdapter.followUpQueue(50),
        TicketApiAdapter.list({ statuses: GROUPS[0]!.statuses }, 1, 20),
      ]);
      setCounts(c);
      setFollowUp(q);
      setRows(l.rows);
      setTotal(l.total);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = GROUPS.find((g) => g.key === group)!;

  /**
   * 切分组 ⇒ 换列表。
   *
   * ⚠️ 用**与徽标完全相同的 `statuses`** 重新查一次，而不是把整队列拉到前端过滤。
   *    前端过滤是上面那个矛盾的来源：过滤的输入本身就不含 NEW。
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const l = await TicketApiAdapter.list({ statuses: current.statuses }, 1, 20);
        if (!alive) return;
        setRows(l.rows);
        setTotal(l.total);
      } catch (e) {
        if (alive) setError(e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [current.statuses]);

  const dueCount = followUp?.length ?? 0;
  const shownFollowUp = (followUp ?? []).slice(0, FOLLOW_UP_PREVIEW);

  return (
    <AppShell tabs={tabs} activeTab="home">
      <PageHeader
        title="工作台"
        subtitle={user?.nickname ? `${user.nickname} · ${roleLabel(user.roles.map((r) => r.name))}` : undefined}
        right={
          <button className="svc-icon-btn text-svc-ink-2" aria-label="刷新" onClick={() => void load()} data-testid="home-refresh">
            <IconRefresh />
          </button>
        }
      />

      {loading ? (
        <LoadingState rows={4} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void load()} />
      ) : (
        <>
          {/*
            今日需跟进 —— **独立范围，独立标注**。
            它的口径（到期 / 逾期，只看 PROCESSING）与下方状态分组不同，
            所以这里不借用任何分组的数字，直接用它自己的条数。
            没有到期项时整块不出现，而不是显示一个"0 条"的噪音。
          */}
          {dueCount > 0 ? (
            <section className="px-4 pt-3" data-testid="home-followup">
              <div className="flex items-baseline justify-between">
                <span className="text-svc-ink text-[13px] font-medium">今日需跟进</span>
                <span className="text-svc-ink-3 text-[12px]">{dueCount} 条（已到期或今天）</span>
              </div>
              <div className="mt-2">
                {shownFollowUp.map((t) => (
                  <TicketCard key={t.id} row={t} onOpen={() => navigate(`/tickets/${t.id}`)} />
                ))}
              </div>
              {dueCount > shownFollowUp.length ? (
                <button
                  className="text-svc-brand w-full py-2 text-[13px]"
                  onClick={() => navigate('/tickets?dueToday=1')}
                  data-testid="home-followup-all"
                >
                  查看全部 {dueCount} 条需跟进
                </button>
              ) : null}
            </section>
          ) : null}

          <div className="px-4 pt-3">
            <Segmented strong rounded>
              {GROUPS.map((g) => {
                const n = counts?.[g.statuses[0]!];
                const on = g.key === group;
                return (
                  /**
                   * ⚠️ 用 `<SegmentedButton active>` 而**不是** `<Button segmented strong>`。
                   *    `strong` 在 Konsta 5 里是 **Segmented（容器）** 的属性，
                   *    Button 上对应的属性叫 `segmentedStrong`；`SegmentedButton` 会自己
                   *    从 `SegmentedContext` 读 `strong/rounded` 并转成正确的 Button 属性。
                   *    写成 `<Button segmented strong>` 会被 TS 拦下 —— 但若用 `as any` 绕过，
                   *    它就是个**被忽略的属性**，表现是"选中项没有任何高亮"，且不报错。
                   */
                  <SegmentedButton
                    key={g.key}
                    active={on}
                    onClick={() => setGroup(g.key)}
                    data-testid={`home-group-${g.key}`}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <span className={on ? 'text-svc-ink' : 'text-svc-ink-2'}>{g.label}</span>
                      {typeof n === 'number' && n > 0 ? (
                        <span
                          className={`tabular rounded-full px-1.5 text-[11px] leading-4 ${
                            on ? 'bg-svc-brand text-white' : 'bg-svc-surface-2 text-svc-ink-3'
                          }`}
                        >
                          {n}
                        </span>
                      ) : null}
                    </span>
                  </SegmentedButton>
                );
              })}
            </Segmented>
          </div>

          <div className="px-4 pt-3 pb-2">
            <div className="flex items-baseline justify-between">
              <span className="text-svc-ink-2 text-[12px]">{current.label}工单</span>
              {caps.tickets ? (
                <button
                  className="text-svc-brand text-[12px]"
                  onClick={() => navigate(`/tickets?status=${current.statuses.join(',')}`)}
                  data-testid="home-all"
                >
                  在工单列表中筛选 ›
                </button>
              ) : null}
            </div>
          </div>

          {(rows ?? []).length === 0 ? (
            <EmptyState
              title={current.empty}
              description={
                group === 'todo' ? '新报修到达时会出现在这里，下拉或点右上角可刷新。' : undefined
              }
              action={
                group === 'todo' && caps.tickets ? (
                  <Button tonal onClick={() => navigate('/tickets')}>
                    去工单列表
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="px-4 pb-24">
              {rows!.map((t) => (
                <TicketCard key={t.id} row={t} onOpen={() => navigate(`/tickets/${t.id}`)} />
              ))}
              {total > rows!.length ? (
                <Button tonal onClick={() => navigate(`/tickets?status=${current.statuses.join(',')}`)}>
                  还有 {total - rows!.length} 条，去工单列表查看
                </Button>
              ) : null}
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}

function roleLabel(names: string[]): string {
  const map: Record<string, string> = {
    store_sales: '门店销售',
    store_after_sales: '门店售后',
    store_manager: '门店负责人',
    hq_admin: '总部管理员',
    hq_after_sales: '总部售后',
    admin: '系统管理员',
  };
  return names.map((n) => map[n] ?? n).join(' / ') || '未分配角色';
}

function IconRefresh() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
