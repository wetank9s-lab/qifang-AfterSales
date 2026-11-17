/**
 * A 页之三：工单详情（业务时间线 + 底部固定主操作）。
 *
 * ===========================================================================
 * 主操作怎么选：由**服务端状态**决定，不由前端"聪明"
 * ===========================================================================
 *   一条工单当前能做什么，是状态机的事（docs/STATE-MACHINE.md）。
 *   前端只做一件事：把当前状态映射到"最可能被点的那一个按钮"。
 *   映射表写错，最坏后果是按钮点下去收到 409/403 —— 不会造成越权，
 *   因为服务端每个动作都重新校验状态。
 *
 *   ⇒ 这也是为什么"底部主操作"允许单值而不做能力探测：
 *     能力探测（先发一次 OPTIONS 或试调）在移动网络上代价太高，
 *     而误点的代价只是一个明确的中文错误提示。
 *
 * ===========================================================================
 * 二次确认只用在这三处
 * ===========================================================================
 *   · 受理：会改变工单归属（别人就抢不到了）
 *   · 派工：会给师傅发短信，短信发出去就收不回
 *   · 驳回：客户会收到通知
 *   其余（备注、刷新）一律不确认 —— 每步都弹窗会让用户开始无脑点"确定"。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, List, ListItem } from 'konsta/react';
import { AppShell, PageHeader, StickyActionBar } from '../components/AppShell';
import {
  ErrorState,
  LoadingState,
  PermissionDeniedState,
  ServiceStatusBadge,
  useConfirm,
  useSubmitGuard,
  useToast,
  describeError,
} from '../components/Feedback';
import {
  ServiceTimeline,
  absTime,
  maskMobile,
  relTime,
  telHref,
  type TimelineItem,
} from '../components/Domain';
import { Field, FieldGroup, useBeforeUnload } from '../components/Form';
import { TicketApiAdapter, type TicketDetail } from '../api/tickets';
import { TICKET_STATUS_META, TICKET_TYPE_META, applianceLabel, SMS_SCENE_LABEL, SMS_SEND_STATUS_LABEL, labelOf, metaOf, type Tone } from '../design/tokens';
import { newRequestId, ApiError } from '../api/http';
import { navigate } from '../router';
import { useSession } from '../app/session-context';

/** 事件类型 → 展示文案 / 色调（未知类型原样显示，不显示"未知"） */
const EVENT_LABEL: Record<string, { label: string; tone: Tone }> = {
  created: { label: '客户提交报修', tone: 'info' },
  accepted: { label: '门店受理', tone: 'brand' },
  dispatched: { label: '已派工', tone: 'brand' },
  reassigned: { label: '已改派', tone: 'warning' },
  rescheduled: { label: '已改约', tone: 'warning' },
  visit_confirmed: { label: '门店确认回执', tone: 'success' },
  visit_rejected: { label: '门店驳回回执', tone: 'danger' },
  completed: { label: '师傅提交完成', tone: 'success' },
  remote_completed: { label: '门店直接解决', tone: 'success' },
  closed: { label: '已闭环', tone: 'success' },
  cancelled: { label: '已取消', tone: 'neutral' },
  transferred: { label: '工单转店', tone: 'neutral' },
  follow_up: { label: '跟进记录', tone: 'info' },
  internal_note: { label: '内部备注', tone: 'neutral' },
  escalated: { label: '已升级', tone: 'danger' },
  reopened: { label: '已重开', tone: 'warning' },

  /**
   * 2026-11-14：补上库里真实存在、但表里没有的 5 类事件。
   *
   *   实测库中分布（GROUP BY event_type）：
   *     created 519 / sms_failed 451 / sms_sent 425 / dispatched 205 /
   *     remote_completed 104 / accepted 96 / closed 74 / reviewed 42 /
   *     follow_up 39 / cancelled 29 / transferred 27 / store_confirmed 11
   *
   *   ⇒ 之前 sms_sent / sms_failed / reviewed / store_confirmed /
   *     technician_submitted 全部走兜底，把代码值直接印在时间线上
   *     （截图里能看到一排 sms_sent）。用户明令不许出现数据模型词。
   */
  sms_sent: { label: '短信已发送', tone: 'neutral' },
  sms_failed: { label: '短信发送失败', tone: 'danger' },
  reviewed: { label: '客户已评价', tone: 'success' },
  store_confirmed: { label: '门店确认完成', tone: 'success' },
  technician_submitted: { label: '师傅提交回执', tone: 'brand' },
};

export function TicketDetailPage({ id }: { id: string }) {
  const { caps } = useSession();
  const [data, setData] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const toast = useToast();
  const confirm = useConfirm();
  const accept = useSubmitGuard();

  // 备注输入（详情的第三个区域）
  const [noteText, setNoteText] = useState('');
  const note = useSubmitGuard();
  useBeforeUnload(noteText.trim().length > 0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await TicketApiAdapter.detail(id);
      setData(d);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <AppShell>
        <PageHeader title="工单详情" back />
        <LoadingState rows={4} />
      </AppShell>
    );
  }

  if (error) {
    const isForbidden = error instanceof ApiError && error.isForbidden;
    return (
      <AppShell>
        <PageHeader title="工单详情" back />
        {isForbidden ? (
          <PermissionDeniedState onBack={() => navigate('/tickets')} />
        ) : (
          <ErrorState error={error} onRetry={() => void load()} onBack={() => navigate('/tickets')} />
        )}
      </AppShell>
    );
  }

  const t = data?.ticket;
  if (!t) {
    return (
      <AppShell>
        <PageHeader title="工单详情" back />
        <ErrorState error={new ApiError(404, 'NOT_FOUND', '工单不存在或已被移除')} onBack={() => navigate('/tickets')} />
      </AppShell>
    );
  }

  const st = metaOf(TICKET_STATUS_META, t.status, 'neutral');
  const events: TimelineItem[] = (data?.events ?? []).map((e) => {
    const meta = e.event_type ? EVENT_LABEL[e.event_type] : undefined;
    const from = e.from_status ? (TICKET_STATUS_META[e.from_status]?.label ?? e.from_status) : null;
    const to = e.to_status ? (TICKET_STATUS_META[e.to_status]?.label ?? e.to_status) : null;
    return {
      key: e.id,
      /**
       * 兜底不印代码值（同工单卡片的品类处理）。
       * 服务端新增事件类型时，宁可显示"系统记录"，也不要让店员看到
       * sms_bounce_v2 这种字符串 —— 那既看不懂、又像故障。
       */
      title: meta?.label ?? '系统记录',
      by: [e.operator_name, from && to ? `${from} → ${to}` : null].filter(Boolean).join(' · ') || null,
      at: e.created_at,
      note: e.note,
      tone: meta?.tone ?? 'neutral',
    };
  });

  const canAccept = caps.ticketWrite && ['NEW', 'new'].includes(t.status);
  const primary = canAccept
    ? {
        label: '受理此工单',
        run: async () => {
          const ok = await confirm.ask({
            title: '确认受理？',
            content: '受理后这条工单会归属到你名下，其他同事将无法再受理。',
            confirmText: '受理',
          });
          if (!ok) return;
          await accept.run(async () => {
            try {
              await TicketApiAdapter.accept(t.id, newRequestId());
              toast.show('已受理');
              await load();
            } catch (e) {
              toast.show(describeError(e).message, 'danger');
            }
          });
        },
      }
    : null;

  return (
    <AppShell>
      <PageHeader title={t.ticket_no || `工单 #${t.id}`} back subtitle={TICKET_TYPE_META[String(t.ticket_type ?? '')] ?? undefined} />
      {toast.node}
      {confirm.node}

      {/* 概要 */}
      <div className="px-4 pt-3">
        <div className="bg-svc-surface rounded-svc border border-svc-line p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-svc-ink text-[17px] font-semibold">{t.customer_name || '（未填姓名）'}</div>
              {/* 机型也属"有才显示"：没有时不占一行灰杠 */}
              {applianceLabel(t.appliance_category) ? (
                <div className="text-svc-ink-2 mt-0.5 text-[15px]">{applianceLabel(t.appliance_category)}</div>
              ) : null}
            </div>
            <ServiceStatusBadge label={st.label} tone={st.tone} />
          </div>

          <div className="text-svc-ink-2 mt-3 text-[13px] leading-relaxed whitespace-pre-wrap">
            {t.content || '（无内容）'}
          </div>

          <div className="border-svc-line mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
            <a
              href={telHref(t.customer_mobile ?? undefined) ?? '#'}
              className="bg-svc-brand-soft text-svc-brand inline-flex min-h-touch items-center rounded-full px-3 text-[13px] font-medium"
              data-testid="ticket-call"
            >
              拨打 {maskMobile(t.customer_mobile)}
            </a>
            {t.urgent ? <ServiceStatusBadge label="紧急" tone="danger" /> : null}
          </div>
        </div>
      </div>

      {/* 明细 */}
      <div className="px-4 pt-3">
        <div className="bg-svc-surface overflow-hidden rounded-svc border border-svc-line">
          {/*
            ⚠️ 这里**只列有内容的字段**（用户第四节："没有值的次要字段不要大量显示'—'"）。
               原来 6 行里有 3 行是占位符（"未约定" / "未派工" / "尚未响应"），
               于是"这条工单到底什么情况"要在一屏"未…"里找那两三行真值。

            ⚠️ 但"服务地址"是例外，**即使为空也保留**：
               它是这一屏唯一的可执行信息（师傅要按它上门），
               空了必须说出来（"未填写"），不能静默消失 ——
               否则售后会以为"地址在别处"，而实际上就是没人填。

            ⚠️ 判断"有没有值"用**原始字段**（`t.expected_visit_at`），
               不是用展示串（"未约定"本身就是个非空字符串）。
          */}
          <Row k="服务地址" v={t.service_address || null} fallback="未填写" />
          <Row k="首次响应" v={t.first_response_at ? absTime(t.first_response_at) : null} />
          <Row k="预约上门" v={t.expected_visit_at ? absTime(t.expected_visit_at) : null} />
          <Row k="师傅" v={t.technician_name || null} />
          <Row k="提交时间" v={absTime(t.created_at)} />
          {/*
            ⚠️「最近更新」只在**它真的提供新信息**时才显示（用户第三节："没有最近更新时间时
               隐藏该字段"）。两个判据，缺一个就会出现无意义的行：

               ① `updated_at` 为空 / 非法 ⇒ 原先会渲染成 `—（—）`，
                  两个空值拼在一起，员工看不出这行想说什么。
               ② `updated_at === created_at` ⇒ 这条工单**从未被修改过**，
                  该行与上面「提交时间」逐字重复。实测 543 条工单里有 **219 条**（40%）
                  属于这种情况 —— 也就是说近一半的详情页会白挂一行重复时间。

               ⇒ 只有"改过"的工单才显示这行，且显示的是**变更后的时间**才有意义。
                 用 Date 比较而不是字符串比较：两者可能一个是 `...Z` 另一个是 `...+08:00`，
                 字符串不等但其实是同一时刻。
          */}
          <Row k="最近更新" v={lastUpdatedText(t.updated_at, t.created_at)} />
          {t.rating ? <Row k="客户评分" v={`${'★'.repeat(Math.round(Number(t.rating)))} ${t.rating}`} /> : null}
          {t.review_comment ? <Row k="客户评价" v={t.review_comment} /> : null}
        </div>
      </div>

      {/* 业务时间线 */}
      <div className="px-4 pt-4">
        <div className="text-svc-ink-3 mb-2 px-1 text-[11px] font-medium">处理记录</div>
        <div className="bg-svc-surface rounded-svc border border-svc-line p-4">
          <ServiceTimeline items={events} />
        </div>
      </div>

      {/* 内部备注 */}
      {caps.ticketWrite ? (
        <div className="px-4 pt-4">
          <FieldGroup title="内部备注（仅员工可见）">
            <Field
              label="记录一条跟进"
              value={noteText}
              onChange={setNoteText}
              multiline
              placeholder="例如：客户要求周六上午上门"
              testId="ticket-note-input"
            />
          </FieldGroup>
          <div className="pt-2">
            <Button
              tonal
              disabled={note.busy || !noteText.trim()}
              onClick={() =>
                void note.run(async () => {
                  try {
                    await TicketApiAdapter.note(t.id, noteText.trim(), newRequestId());
                    setNoteText('');
                    toast.show('已记录');
                    await load();
                  } catch (e) {
                    toast.show(describeError(e).message, 'danger');
                  }
                })
              }
              data-testid="ticket-note-submit"
            >
              {note.busy ? '提交中…' : '保存备注'}
            </Button>
          </div>
        </div>
      ) : null}

      {/* 短信轨迹（只读，展示"发没发"） */}
      {data && data.sms.length > 0 ? (
        <div className="px-4 pt-4 pb-6">
          <div className="text-svc-ink-3 mb-2 px-1 text-[11px] font-medium">通知记录</div>
          <List strong inset className="my-0">
            {data.sms.map((s) => (
              <ListItem
                key={s.id}
                // ⚠️ 必须翻中文：DTO 给的 `scene` 是原始代码值（technician_task 等）。
                //    直接印出来就是"界面展示代码枚举"，用户第三节明令禁止。
                title={labelOf(SMS_SCENE_LABEL, s.scene)}
                subtitle={absTime(s.created_at)}
                after={
                  /**
                   * ⚠️ 判据要锚在**真实存在的取值**上（见 tokens.ts: SMS_SEND_STATUS_LABEL 的长注释）：
                   *    原先写的是 `=== 'sent'`，而服务端枚举里没有 `sent`
                   *    ⇒ 永远走兜底、把 `accepted`/`rejected` 英文码印给员工。
                   *    这里改成查表，并只对"未发出"的两种给弱化色。
                   */
                  <span
                    className={
                      s.send_status === 'accepted'
                        ? 'text-svc-ink-2 text-[12px]'
                        : 'text-svc-ink-3 text-[12px]'
                    }
                  >
                    {labelOf(SMS_SEND_STATUS_LABEL, s.send_status)}
                  </span>
                }
              />
            ))}
          </List>
        </div>
      ) : (
        <div className="h-6" />
      )}

      {primary ? (
        <StickyActionBar>
          <Button large disabled={accept.busy} onClick={() => void primary.run()} data-testid="ticket-primary-action">
            {accept.busy ? '处理中…' : primary.label}
          </Button>
        </StickyActionBar>
      ) : caps.ticketWrite ? (
        <StickyActionBar>
          <div className="text-svc-ink-3 w-full text-center text-[12px]">
            当前状态（{st.label}）下没有可执行的主操作
          </div>
        </StickyActionBar>
      ) : null}
    </AppShell>
  );
}

/**
 * 明细行。
 *
 * ⚠️ `v` 传 `null` ⇒ **整行不渲染**。
 *    这是"次要字段不要堆 —"的实现方式：不是把 '—' 换成更淡的灰，
 *    而是让空字段根本不占位置。
 *
 * ⚠️ `fallback` 用于"必须说出来"的字段（如服务地址）：
 *    它为空时要显示 `未填写` 而不是消失 —— 见调用处注释。
 */
/**
 * 「最近更新」的展示串 —— **没有新信息时返回 null**（调用方的 `Row` 会整行不渲染）。
 *
 * 判据（两条都要，见调用处注释）：
 *   ① 时间缺失或非法 ⇒ null（不要拼出 `—（—）`）
 *   ② 与创建时间同一时刻 ⇒ null（那是"从未改过"，与「提交时间」逐字重复）
 *
 * 用 `getTime()` 比较而不是字符串相等：同一时刻可能有 `Z` 与 `+08:00` 两种写法。
 */
function lastUpdatedText(
  updatedAt: string | null | undefined,
  createdAt: string | null | undefined,
): string | null {
  if (!updatedAt) return null;
  const u = new Date(updatedAt).getTime();
  if (!Number.isFinite(u)) return null;
  if (createdAt) {
    const c = new Date(createdAt).getTime();
    if (Number.isFinite(c) && u === c) return null;
  }
  return `${relTime(updatedAt)}（${absTime(updatedAt)}）`;
}

function Row({ k, v, fallback }: { k: string; v: string | null; fallback?: string }) {
  const text = v ?? fallback;
  if (!text) return null;
  return (
    <div className="border-svc-line flex items-start gap-3 border-b px-4 py-2.5 last:border-b-0">
      <span className="text-svc-ink-3 w-[68px] shrink-0 text-[12px]">{k}</span>
      <span className={`min-w-0 flex-1 text-[13px] break-words ${v ? 'text-svc-ink' : 'text-svc-ink-3'}`}>{text}</span>
    </div>
  );
}
