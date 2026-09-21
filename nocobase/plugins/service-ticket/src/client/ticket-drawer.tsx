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
 * ⚠️ 依赖纪律（很重要）：
 *   这里只 import **已确认在运行时可解析**的模块：`react` / `react-dom` / `antd`。
 *   列表与排版一律用**原生 HTML + 内联样式**，刻意不用 antd 的
 *   Descriptions / Timeline —— 这两个组件在 antd v4/v5 之间 `items` 与 `children`
 *   写法不兼容，一旦踩错就是整个抽屉渲染不出来（而这在接口断言里看不出来）。
 *   同理 `Drawer` 用 v5 的 `open`（NocoBase 2.2.15 用 antd v5）。
 */
import React, { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { Alert, Drawer, Empty, Spin, Tag } from 'antd';

// 状态中文名直接复用服务端的常量（server/constants.ts 是**零 import 的纯常量**文件，
// 客户端引用它是安全的，也避免"界面标签与服务端各写一份"的漂移）。
import { TICKET_STATUS_LABEL, VISIT_STATUS_LABEL } from '../server/constants';
import { computeTimeliness } from './timeliness';

/** 注入的请求函数：给定 URL（含 /api 前缀）返回解析后的 JSON */
export type Requester = (url: string) => Promise<any>;

export interface TicketDrawerOptions {
  ticketId: number | string;
  request: Requester;
}

interface DrawerState {
  loading: boolean;
  error: string | null;
  ticket: any;
  events: any[];
  visits: any[];
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={ROW}>
      <div style={KEY}>{label}</div>
      <div style={VAL}>{children}</div>
    </div>
  );
}

function TicketDrawer({ ticketId, request, onClose }: TicketDrawerOptions & { onClose: () => void }) {
  const [state, setState] = useState<DrawerState>({
    loading: true,
    error: null,
    ticket: null,
    events: [],
    visits: [],
  });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      // 两个请求都**按 ticket_id 在服务端查**，不下载全量再过滤 ——
      // 既省数据，也继续沿用服务端的对象级权限（越权与不存在统一 404）。
      const [timeline, visits] = await Promise.all([
        request(`/api/svc:timeline?filterByTk=${ticketId}&pageSize=50`),
        request(`/api/svc:visits?filterByTk=${ticketId}`),
      ]);
      setState({
        loading: false,
        error: null,
        ticket: timeline?.data?.ticket ?? null,
        events: timeline?.data?.events ?? [],
        visits: visits?.data?.visits ?? [],
      });
    } catch (error) {
      setState({
        loading: false,
        error: (error as Error)?.message ?? String(error),
        ticket: null,
        events: [],
        visits: [],
      });
    }
  }, [ticketId, request]);

  useEffect(() => {
    void load();
  }, [load]);

  const t = state.ticket ?? {};
  const timeliness = computeTimeliness({
    createdAt: t.createdAt ?? t.created_at,
    firstResponseAt: t.first_response_at,
    expectedVisitAt: t.expected_visit_at,
    closedAt: t.closed_at,
    completedAt: t.completed_at,
  });

  return (
    <Drawer
      open
      onClose={onClose}
      width={720}
      title={t.ticket_no ? `工单 ${t.ticket_no}` : `工单 #${ticketId}`}
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
          {/* ① 工单基本信息 */}
          <div style={SECTION_TITLE}>工单基本信息</div>
          <Row label="当前状态">
            <Tag color={t.status === 'CLOSED' ? 'green' : 'blue'}>
              {(TICKET_STATUS_LABEL as any)[t.status] ?? t.status ?? '—'}
            </Tag>
          </Row>
          <Row label="客户">{t.customer_name ?? '—'}{t.customer_mobile ? `（${t.customer_mobile}）` : ''}</Row>
          <Row label="门店">{t.store?.name ?? t.store?.code ?? t.source_store_code ?? '—'}</Row>
          <Row label="类型">{t.ticket_type ?? '—'}</Row>
          <Row label="内容">{t.content ?? '—'}</Row>

          {/* ② 时效（Phase 4 只展示时间，不做 SLA 引擎 —— 阈值/扫描/看板在 Phase 9）*/}
          <div style={SECTION_TITLE}>时效</div>
          <Row label="报修时间">{t.createdAt ?? t.created_at ?? '—'}</Row>
          <Row label="耗时">{timeliness.elapsedText}</Row>
          {timeliness.firstResponseText ? (
            <Row label="首响">{timeliness.firstResponseText}</Row>
          ) : null}
          {timeliness.appointmentText ? (
            <Row label="预约">
              {timeliness.appointmentText}
              {timeliness.relativeText ? (
                <span style={{ marginLeft: 10, color: timeliness.overdue ? '#cf1322' : '#8c8c8c' }}>
                  {timeliness.relativeText}
                </span>
              ) : null}
            </Row>
          ) : null}

          {/* ③ 派工历史（Visit #1 SUPERSEDED / Visit #2 ASSIGNED …）*/}
          <div style={SECTION_TITLE}>派工历史</div>
          {state.visits.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无派工记录" />
          ) : (
            state.visits.map((v: any, i: number) => (
              <div key={v.id ?? i} style={{ ...ROW, alignItems: 'flex-start' }}>
                <div style={KEY}>Visit #{v.visit_no ?? i + 1}</div>
                <div style={VAL}>
                  <Tag color={v.visit_status === 'SUPERSEDED' ? 'default' : 'blue'}>
                    {(VISIT_STATUS_LABEL as any)[v.visit_status] ?? v.visit_status ?? '—'}
                  </Tag>
                  <span style={{ marginLeft: 8 }}>
                    {v.technician_name ?? '—'}
                    {v.technician_mobile ? ` ${v.technician_mobile}` : ''}
                    {v.provider_name ? `（${v.provider_name}）` : ''}
                  </span>
                  <div style={{ color: '#8c8c8c', fontSize: 12 }}>
                    派工 {v.assigned_at ?? '—'}
                    {v.expected_visit_at ? ` · 预约 ${v.expected_visit_at}` : ''}
                    {v.superseded_at ? ` · 已终止 ${v.superseded_at}` : ''}
                    {v.token_revoked_reason ? ` · 链接失效原因 ${v.token_revoked_reason}` : ''}
                  </div>
                </div>
              </div>
            ))
          )}

          {/* ④ 事件时间线 */}
          <div style={SECTION_TITLE}>事件时间线</div>
          {state.events.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无事件" />
          ) : (
            state.events.map((e: any, i: number) => (
              <div key={e.id ?? i} style={{ ...ROW, alignItems: 'flex-start' }}>
                <div style={{ ...KEY, fontSize: 12 }}>{e.createdAt ?? e.created_at ?? '—'}</div>
                <div style={VAL}>
                  <b>{e.event_type ?? '—'}</b>
                  {e.from_status || e.to_status ? (
                    <span style={{ color: '#8c8c8c', marginLeft: 8 }}>
                      {(TICKET_STATUS_LABEL as any)[e.from_status] ?? e.from_status ?? '—'}
                      {' → '}
                      {(TICKET_STATUS_LABEL as any)[e.to_status] ?? e.to_status ?? '—'}
                    </span>
                  ) : null}
                  <div style={{ color: '#595959' }}>{e.summary ?? ''}</div>
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
  const container = document.createElement('div');
  document.body.appendChild(container);
  const close = () => {
    ReactDOM.unmountComponentAtNode(container);
    container.remove();
  };
  ReactDOM.render(<TicketDrawer {...options} onClose={close} />, container);
  return close;
}
