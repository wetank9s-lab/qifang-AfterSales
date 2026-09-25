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
 * ---------------------------------------------------------------------------
 * 区块（Phase 4-I 第二轮走查后重排；P6-0 追加一个**条件区块**）
 * ---------------------------------------------------------------------------
 * 目标**不是"把数据库字段摆出来"**，而是让门店同事 30 秒内回答四个问题：
 *   A 顶部摘要      → 这是哪张单、什么状态、什么时候建的
 *   B 客户与问题    → 客户是什么问题
 *   C 当前服务      → 现在谁负责、哪天上门（**只显示当前 active Visit**）
 *   C.5 技师回执    → 师傅这次干了什么、要多少钱、有哪些照片（**只在有待确认回执时出现**）
 *   D 处理记录      → 之前发生了什么（历史 Visit 的变化 = 时间线，不再单列一张表）
 *
 * ⚠️ C.5 是 Phase 6 · P6-0 加的**只读**区块（`docs/PHASE-6.md` §6.3）：
 *    它由 `submittedVisitOf()` 决定是否渲染，因此**不影响**任何非
 *    `WAIT_STORE_CONFIRM` 工单的渲染与请求数。它里面**没有**确认/驳回按钮
 *    （那是 P6-1），也不提供金额输入框 —— 本文件依旧不渲染任何表单。
 *
 * ⚠️ 三条整改纪律（都来自真人反馈，见 docs/PHASE-4-I-UAT.md §5）：
 *   ① **不做指标墙**：时效只给"当前这一步"的一句话（`statusTimelinessLine`）。
 *      原实现一次给四行（耗时/首响/预约/倒计时），真人反馈"信息层级混乱"。
 *   ② **不展示内部字段与枚举**：见 `ticket-display.ts` 的 `DETAIL_HIDDEN_FIELDS`
 *      与 `eventActionText()`。**隐藏 ≠ 删除**，原始审计数据仍在库里。
 *   ③ **同一件事只说一次**：当前 Visit 进「当前服务」；历史 Visit 的业务变化
 *      通过时间线表达 —— 不再并列"派工历史表 + 事件时间线"（同一件事说两遍）。
 *      原 Visit 因而**不需要**让一线同事理解 SUPERSEDED 这个词。
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
import { TICKET_STATUS, TICKET_STATUS_LABEL, TICKET_TYPE_LABEL } from '../server/constants';
import { formatAppointmentDate, statusTimelinessLine } from './timeliness';
import {
  activeVisitOf,
  buildTimeline,
  formatStamp,
  serviceModeText,
  submittedVisitOf,
  visitStatusText,
} from './ticket-display';
// P6-0：门店回执**只读**区块（确认/驳回是 P6-1，本文件与那个区块都不实现）
import { StoreReviewSection } from './ticket-store-review';

/**
 * 注入的请求函数：给定**资源路径**（`svc:timeline?...`，**不含 `/api` 前缀**）
 * 返回解析后的 JSON。
 *
 * ⚠️ 这里的注释原本写的是"给定 URL（含 /api 前缀）"—— 那句描述是错的，
 *    而它直接把调用方带进了 404：实现（`app.apiClient.request`）自己会补 `/api`，
 *    调用方再补一次就成了 `/api/api/...`。
 *    凡是"注释描述与实际实现不一致"的地方，迟早会产生一个只在这条路径上的缺陷。
 *
 * ⚠️ 后三个参数（method / body / options）是 P6-0 新增的**最小加宽**：
 *    「技师回执」区块里的照片走 `authenticated fetch → Blob`（§4.3a），
 *    必须能传 `responseType: 'blob'` —— 而 blob 只有走**同一个带登录态的请求器**
 *    才带得上 Authorization。这里刻意**不引入第二个请求器**：
 *    两条取数路径一旦分家，"401 自动跳登录"这类统一行为就会只覆盖其中一条。
 *    现有调用（`request(url)`）行为完全不变（method 默认 'get'）。
 */
export type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

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

/** 客户提交的原始描述：保留换行，块级展示（不是"某个字段"，而是一段话） */
const PARAGRAPH: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  background: '#fafafa',
  border: '1px solid #f0f0f0',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 13,
  lineHeight: 1.7,
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={ROW}>
      <div style={KEY}>{label}</div>
      <div style={VAL}>{children}</div>
    </div>
  );
}

/** 门店：优先显示名字；关系没被载入时退到门店编码（业务可读，非内部主键） */
function storeText(t: any): string {
  return t?.store?.name ?? t?.store?.code ?? t?.source_store_code ?? '—';
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

    // 两个请求的地址先落成常量，便于：
    //   ① 失败时把**实际请求的地址**写进错误文案（见下）；
    //   ② 静态断言能直接锚定这两个字符串（不靠运行时拼接）。
    const timelineUrl = `svc:timeline?filterByTk=${ticketId}&pageSize=50`;
    const visitsUrl = `svc:visits?filterByTk=${ticketId}`;

    /**
     * 给每个请求包一层"把 URL 带进错误里"的壳。
     *
     * 为什么值得写进 UI（Phase 4-I 第三轮关于「详情 404」的真教训）：
     *   真人报"详情打不开"时，最缺的从来不是"它坏了"，而是**那一行 Request URL**。
     *   把 URL 直接放进错误态，下一次走查**不用开 DevTools 也能说清是哪个地址失败**。
     *   （当时为了拿到这个 URL，花了整轮时间在"猜是不是 /api 前缀"上。）
     */
    const withUrl = async (url: string) => {
      try {
        return await request(url);
      } catch (e) {
        throw new Error(`${url} → ${(e as Error)?.message ?? String(e)}`);
      }
    };

    try {
      // 两个请求都**按 ticket_id 在服务端查**，不下载全量再过滤 ——
      // 既省数据，也继续沿用服务端的对象级权限（越权与不存在统一 404）。
      //
      // ⚠️⚠️ 路径**不带 `/api` 前缀**（`svc:timeline` 而不是 `/api/svc:timeline`）。
      //    注入的 `request` 最终走 `app.apiClient.request()`，它会自己补 `/api`。
      //    这里曾经写成 `/api/svc:timeline`，于是真实请求是
      //    `GET /api/api/svc:timeline` → **404 api resource does not exist** →
      //    抽屉永远显示"加载失败"。而 HTTP 断言、产物断言、结构断言全绿 ——
      //    因为**没有任何一条断言看过"浏览器发出的那个 URL"**。
      //    这是"呈现层"缺断言的典型：写动作走 svc-request.ts（本来就无前缀）所以正常，
      //    抽屉是唯一手写 URL 的地方，也就唯一会犯这个错。
      //    现在由 verify-client-logic 的"抽屉请求路径"断言 + preflight §3.7
      //    （真的点一次详情、既看文字也看网络状态码）两面盯住。
      //
      // ⚠️⚠️ 光改这里**还不够**（DEV-74）：nginx 曾对 `/static/plugins/` 发 7 天长缓存，
      //    而产物 URL 不含内容哈希 → 浏览器会**一直跑旧产物**，
      //    症状就是"代码已经修好、真人打开仍然 404"。
      //    现已改为 `no-cache`（每次回源校验、未变则 304），详见
      //    `nginx/conf.d/service.conf` 的 `/static/plugins/` 段。
      const [timeline, visits] = await Promise.all([
        withUrl(timelineUrl),
        withUrl(visitsUrl),
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
  const status = String(t.status ?? '');
  const statusText = (TICKET_STATUS_LABEL as any)[status] ?? status ?? '—';
  const typeText = (TICKET_TYPE_LABEL as any)[t.ticket_type] ?? '—';

  // 「当前服务」= 唯一那条仍然有效的 Visit（被取代/取消的历史 Visit 不进这里）
  const currentVisit = activeVisitOf(state.visits);
  const currentExpectedAt = currentVisit?.expected_visit_at;

  // P6-0：**审核对象** = 当前 `SUBMITTED` 的那条 Visit（`docs/PHASE-6.md` §4.1）。
  // ⚠️ 刻意不用 `currentVisit` 代替 —— 两者判据不同：`currentVisit` 是
  //    "现在谁负责"（排除终态、取 visit_no 最大），而审核对象是"谁在等门店确认"
  //    （**只由状态决定**）。改派会让旧 Visit 转 SUPERSEDED 且两条并存，
  //    用顺序猜会把已被取代的历史回执当成待审核对象。
  const submittedVisit = submittedVisitOf(state.visits);

  // 时效：**一句话**，内容由当前状态决定（见 timeliness.ts）
  const timelinessLine = statusTimelinessLine({
    status,
    createdAt: t.createdAt ?? t.created_at,
    expectedVisitAt: currentExpectedAt ?? t.expected_visit_at,
    closedAt: t.closed_at,
    completedAt: t.completed_at,
    events: state.events,
  });

  const timeline = buildTimeline(state.events);

  return (
    <Drawer
      open
      onClose={onClose}
      width={720}
      title={`工单 ${t.ticket_no ?? `#${ticketId}`}`}
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
          {/* ① 顶部摘要：只剩"这是哪张单 / 什么状态 / 什么时候建的" */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18, fontWeight: 600 }}>{t.ticket_no ?? '—'}</span>
            <Tag color={status === TICKET_STATUS.CLOSED ? 'green' : 'blue'}>{statusText}</Tag>
          </div>
          <div style={{ color: '#8c8c8c', fontSize: 13, marginTop: 6 }}>
            {typeText} · 报修时间 {formatStamp(t.createdAt ?? t.created_at)}
          </div>

          {/* 时效：唯一一条，回答"现在卡在哪一步、这一步多久了/哪天到" */}
          {timelinessLine ? (
            <div
              style={{
                marginTop: 10,
                padding: '8px 10px',
                background: '#f6ffed',
                border: '1px solid #b7eb8f',
                borderRadius: 6,
                fontSize: 13,
                color: '#237804',
              }}
            >
              {timelinessLine}
            </div>
          ) : null}

          {/* ② 客户与问题 */}
          <div style={SECTION_TITLE}>客户与问题</div>
          <Row label="客户">{t.customer_name ?? '—'}</Row>
          <Row label="联系电话">{t.customer_mobile ?? '—'}</Row>
          <Row label="所属门店">{storeText(t)}</Row>
          <div style={{ ...ROW, flexDirection: 'column', gap: 4 }}>
            <div style={KEY}>问题描述</div>
            <div style={PARAGRAPH}>{String(t.content ?? '').trim() || '—'}</div>
          </div>

          {/* ③ 当前服务：**只有当前 active Visit**（历史 Visit 走下面的时间线） */}
          <div style={SECTION_TITLE}>当前服务</div>
          {!currentVisit ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                status === TICKET_STATUS.NEW ? '尚未派工（等待门店受理）' : '当前没有生效的派工'
              }
            />
          ) : (
            <>
              <Row label="服务状态">
                <Tag color="blue">{visitStatusText(currentVisit.visit_status)}</Tag>
              </Row>
              <Row label="服务方式">{serviceModeText(currentVisit.service_mode) || '—'}</Row>
              {/* 服务商只在"厂家/第三方"这类**有主体**的方式下才显示，门店自修不显示空行 */}
              {currentVisit.provider_name ? (
                <Row label="服务商">{currentVisit.provider_name}</Row>
              ) : null}
              <Row label="当前技师">{currentVisit.technician_name ?? '—'}</Row>
              {currentVisit.technician_mobile ? (
                <Row label="技师电话">{currentVisit.technician_mobile}</Row>
              ) : null}
              <Row label="预计上门">
                {formatAppointmentDate(currentExpectedAt) || '未约定'}
              </Row>
              <div style={{ color: '#bfbfbf', fontSize: 12, marginTop: 4 }}>
                第 {currentVisit.visit_no ?? 1} 次派工
              </div>
            </>
          )}

          {/* ③.5 技师回执（P6-0 只读 + P6-2 确认/驳回）：**只在有待确认回执时**才出现，
              所以普通查单不会多一次请求，也不会多一块空白区。
              ⚠️ onChanged 指向 load()：确认/驳回成功或 409 冲突后**整页重拉**，
                 让工单状态、时间线、按钮显隐一起刷新（不再是 SUBMITTED 时
                 submittedVisitOf 返回 null → 整个区块连同按钮一起消失）。 */}
          {submittedVisit?.id != null ? (
            <StoreReviewSection
              visitId={submittedVisit.id}
              request={request}
              onChanged={() => void load()}
            />
          ) : null}

          {/* ④ 处理记录（时间线）：历史 Visit 的变化与工单事件合成一条线 */}
          <div style={SECTION_TITLE}>处理记录</div>
          {timeline.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无处理记录" />
          ) : (
            timeline.map((entry) => (
              <div
                key={entry.key}
                style={{
                  display: 'flex',
                  gap: 12,
                  padding: '7px 0',
                  borderBottom: '1px dashed #f0f0f0',
                  // 通知类（短信）降一级：它们是"顺带发生"的，不抢业务动作的位置
                  opacity: entry.notice ? 0.62 : 1,
                }}
              >
                <div style={{ flex: '0 0 108px', color: '#8c8c8c', fontSize: 12, lineHeight: 1.6 }}>
                  {entry.at}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13 }}>
                    <b>{entry.action}</b>
                    <span style={{ color: '#8c8c8c', marginLeft: 8 }}>{entry.actor}</span>
                  </div>
                  {entry.detail ? (
                    <div style={{ color: '#595959', fontSize: 13, lineHeight: 1.6, marginTop: 2 }}>
                      {entry.detail}
                    </div>
                  ) : null}
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
