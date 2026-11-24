/**
 * 组件展厅（`/m/components`）。
 *
 * ===========================================================================
 * 为什么必须有一个"组件单独预览页"
 * ===========================================================================
 *   用户第九节明确要求："共享组件应有单独的预览或组件展示页面。"
 *   理由不是"好看"，而是：**设计系统坏掉的时候，业务页面不会报错**。
 *   某个 tone 的底色配错、某个空态文字变透明、按钮在深色下不可读 ——
 *   这些在业务页面上会表现为"某个页面看着怪"，很容易被归因为数据问题。
 *
 *   ⇒ 本页把每个组件的**所有变体**并排放在一起：
 *     深色/浅色切换、三种宽度、以及每个组件不依赖任何业务数据。
 *     验收脚本 `scripts/ui-verify.mjs` 会在这里做"每个组件都渲染出非零尺寸"的断言。
 */

import { useState } from 'react';
import { Button } from 'konsta/react';
import { AppShell, PageHeader, StickyActionBar } from '../components/AppShell';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PermissionDeniedState,
  ServiceStatusBadge,
  useConfirm,
  useToast,
} from '../components/Feedback';
import { ServiceTimeline, HvacProgress, Highlight, TicketCard, ArchiveCard, maskMobile } from '../components/Domain';
import { Field, FieldGroup, SegmentedField } from '../components/Form';
import { TONE_CLASS, type Tone } from '../design/tokens';
import { ApiError } from '../api/http';
import type { TicketRow } from '../api/tickets';
import type { ArchiveRow } from '../api/archives';

const TONES: Tone[] = ['brand', 'success', 'warning', 'danger', 'info', 'neutral'];

const DEMO_TICKET: TicketRow = {
  id: 1,
  ticket_no: 'SV20261112000001',
  content: '空调不制冷，室外机有异响，已连续三晚影响睡眠',
  customer_name: '王女士',
  customer_mobile: '13800001234',
  status: 'NEW',
  ticket_type: 'repair',
  appliance_category: '空调',
  service_address: '十里大道一段 88 号 3 栋 502',
  store_id: 1,
  urgent: true,
  expected_visit_at: null,
  created_at: new Date(Date.now() - 1000 * 60 * 37).toISOString(),
  updated_at: new Date().toISOString(),
  technician_name: null,
  next_follow_at: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
  rating: null,
  review_status: null,
};

const DEMO_ARCHIVE: ArchiveRow = {
  id: 2,
  archive_no: 'ARC20261112000002',
  archive_type: 'hvac',
  customer_name: '李先生',
  customer_mobile: '13900005678',
  service_address: '康乐小区 12 栋 1 单元 301',
  service_type: null,
  product_description: '格力中央空调 5 匹一拖四',
  package_description: null,
  purchase_date: '2026-10-01',
  service_date: null,
  planned_date: '2026-11-20',
  assigned_worker: '张师傅',
  public_note: null,
  status: 'serving',
  visibility: 'published',
  store_id: 1,
  version: 3,
  completed_at: null,
  created_at: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
  updated_at: new Date().toISOString(),
};

export function ComponentGalleryPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [dark, setDark] = useState(false);
  const [seg, setSeg] = useState<'a' | 'b' | ''>('a');
  const [txt, setTxt] = useState('');
  const [err, setErr] = useState<string | null>('示例错误');

  return (
    <AppShell>
      {toast.node}
      {confirm.node}
      <PageHeader
        title="组件展厅"
        back
        right={
          <button
            className="text-svc-brand min-h-touch px-2 text-[13px]"
            onClick={() => {
              const next = !dark;
              setDark(next);
              document.documentElement.classList.toggle('dark', next);
            }}
            data-testid="gallery-dark-toggle"
          >
            {dark ? '浅色' : '深色'}
          </button>
        }
      />

      <Section title="ServiceStatusBadge">
        <div className="flex flex-wrap gap-2" data-testid="gallery-badges">
          {TONES.map((t) => (
            <ServiceStatusBadge key={t} label={t} tone={t} />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {TONES.map((t) => (
            <ServiceStatusBadge key={t} label={t} tone={t} size="sm" />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {TONES.map((t) => (
            <span key={t} className={`${TONE_CLASS[t].bg} ${TONE_CLASS[t].text} rounded-svc-sm px-2 py-1 qf-caption`}>
              {t} 底色
            </span>
          ))}
        </div>
      </Section>

      <Section title="TicketCard / ArchiveCard">
        <TicketCard row={DEMO_TICKET} onOpen={() => toast.show('卡片可点击', 'info')} />
        <ArchiveCard row={DEMO_ARCHIVE} />
        <div className="text-svc-ink-3 qf-caption">手机号掩码：{maskMobile('13800001234')}</div>
      </Section>

      <Section title="ServiceTimeline">
        <div className="bg-svc-surface rounded-svc border border-svc-line p-4">
          <ServiceTimeline
            items={[
              { key: 1, title: '客户提交报修', at: new Date(Date.now() - 7200e3).toISOString(), tone: 'info' },
              {
                key: 2,
                title: '门店受理',
                by: '陈主管 · 待受理 → 处理中',
                at: new Date(Date.now() - 3600e3).toISOString(),
                tone: 'brand',
              },
              {
                key: 3,
                title: '已派工',
                by: '陈主管',
                at: new Date(Date.now() - 1800e3).toISOString(),
                note: '张师傅 138****6677\n约定周六上午上门',
                tone: 'brand',
              },
            ]}
          />
        </div>
      </Section>

      <Section title="HvacProgress">
        <div className="bg-svc-surface rounded-svc border border-svc-line p-4">
          <HvacProgress
            stages={[
              { stage_code: 'survey', status: 'done' },
              { stage_code: 'plan', status: 'done' },
              { stage_code: 'pipe', status: 'done' },
              { stage_code: 'device', status: 'pending' },
              { stage_code: 'test', status: 'pending' },
              { stage_code: 'accept', status: 'pending' },
            ]}
          />
        </div>
      </Section>

      <Section title="表单控件">
        <FieldGroup>
          <Field label="普通输入" value={txt} onChange={setTxt} placeholder="请输入" testId="gallery-input" />
          <Field label="带错误" value="" onChange={() => {}} error={err} testId="gallery-input-error" />
          <Field label="带说明" value="" onChange={() => {}} hint="这是辅助说明文案" />
          <Field label="日期" value="" onChange={() => {}} type="date" />
          <SegmentedField
            label="分段选择"
            value={seg}
            onChange={setSeg}
            options={[
              { value: 'a', label: '选项 A' },
              { value: 'b', label: '选项 B' },
            ]}
            testId="gallery-segmented"
          />
        </FieldGroup>
        <div className="mt-2 flex gap-2">
          <Button onClick={() => setErr((v) => (v ? null : '示例错误'))}>切换错误态</Button>
          <Button tonal onClick={(e: any) => e}>次要按钮</Button>
        </div>
      </Section>

      <Section title="状态：EmptyState">
        <div className="bg-svc-surface rounded-svc border border-svc-line">
          <EmptyState title="没有数据" description="这是空态的描述文案，最多两行。" />
        </div>
      </Section>

      <Section title="状态：LoadingState">
        <LoadingState rows={2} label="加载中" />
      </Section>

      <Section title="状态：ErrorState（4 种）">
        <div className="bg-svc-surface mb-2 rounded-svc border border-svc-line">
          <ErrorState error={new ApiError(0, 'NETWORK_ERROR', '网络连接失败，请检查网络后重试')} onRetry={() => {}} />
        </div>
        <div className="bg-svc-surface mb-2 rounded-svc border border-svc-line">
          <ErrorState error={new ApiError(429, 'RATE_LIMITED', '查询过于频繁，请稍后再试', { retry_after_seconds: 42 })} onRetry={() => {}} />
        </div>
        <div className="bg-svc-surface rounded-svc border border-svc-line">
          <ErrorState error={new ApiError(403, 'FORBIDDEN', '没有权限执行此操作')} onBack={() => {}} />
        </div>
      </Section>

      <Section title="状态：PermissionDeniedState">
        <div className="bg-svc-surface rounded-svc border border-svc-line">
          <PermissionDeniedState onBack={() => {}} />
        </div>
      </Section>

      <Section title="Highlight">
        <div className="text-svc-ink text-[13px]">
          <Highlight text="客户反馈空调不制冷，需要周六上门" keyword="空调" />
        </div>
      </Section>

      <Section title="Toast / Confirm">
        <div className="flex gap-2">
          <Button onClick={() => toast.show('已保存')}>成功 Toast</Button>
          <Button tonal onClick={() => toast.show('出错了', 'danger')}>
            失败 Toast
          </Button>
          <Button
            tonal
            onClick={() =>
              void confirm.ask({
                title: '确认执行？',
                content: '这是一段二次确认的说明文字。',
                confirmText: '执行',
                danger: true,
              })
            }
          >
            二次确认
          </Button>
        </div>
      </Section>

      <div className="h-24" />
      <StickyActionBar>
        <Button large onClick={() => toast.show('底部操作栏正常')} data-testid="gallery-sticky-action">
          底部固定操作栏
        </Button>
      </StickyActionBar>
    </AppShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="px-4 pt-4" data-testid={`gallery-section-${title}`}>
      <div className="text-svc-ink-3 mb-2 px-1 qf-caption font-medium">{title}</div>
      {children}
    </section>
  );
}
