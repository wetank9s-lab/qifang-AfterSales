/**
 * hq-pages.tsx —— BE-05 总部售后工作台 + BE-03 短信通知管理（业务化界面）
 *
 * 本轮（BE-03-UX-01 / BE-05-UX-01）只改**展示层**：数据仍全部来自已部署的只读受控接口
 * `svc:hqOverview` / `svc:smsOverview`，写入仍只走 `svc:updateSetting`（受控 + 审计）。
 * 不碰：页面树 / 菜单 / schemaUid / 统计 SQL / 发送闸门 / 权限 / 服务端发送链路。
 *
 * 三条界面纪律（都是踩过的坑）：
 *  1. **不猜状态**：开关/通道读不到就显示"状态无法确认"，绝不默认成开启（旧版假绿的来源）。
 *     判定逻辑全在 `page-logic.ts` 的 `deriveSmsState()`，页面只渲染结果。
 *  2. **不用 antd Table**：本仓库对 antd 导出面有白名单（Table 被拦），且原生 table 更好控制
 *     `minWidth` 与横向滚动 —— 中文表头被压成竖排就是列宽塌陷造成的。
 *  3. **按容器宽度响应**，不是按浏览器宽度：用 ResizeObserver 量挂载点宽度，
 *     窄了就换卡片视图（宿主后台还有侧边栏，窗口宽度不等于内容宽度）。
 */
import React from 'react';
import { Alert, Button, Empty, Spin } from 'antd';
import { newRequestId } from '../shared/svc-request';
import {
  alertPriority,
  alertTypeText,
  bjTime,
  bjRange,
  deriveSmsState,
  humanizeChannelReason,
  providerLabel,
  sceneLabel,
  smsErrorDetail,
  smsSendStatusText,
  smsSendStatusTone,
  ticketStatusText,
  type Tone,
} from './page-logic';

const HQ_API = '/svc:hqOverview';
const SMS_API = '/svc:smsOverview';

// ---------------------------------------------------------------------------
// 设计令牌（内联样式，不引外部 CSS：避免再进一次构建产物的样式表争论）
// ---------------------------------------------------------------------------
const C = {
  text: '#1f2328',
  sub: '#5b6573',
  faint: '#8b95a5',
  line: '#e6e9ef',
  page: '#f6f8fb',
  card: '#ffffff',
  ok: '#0f7b3f',
  okBg: '#e9f7ef',
  paused: '#8a5a00',
  pausedBg: '#fff6e3',
  blocked: '#b3261e',
  blockedBg: '#fdecea',
  neutral: '#4a5568',
  neutralBg: '#eef1f6',
};

const toneColor = (t: Tone) =>
  t === 'ok' ? [C.ok, C.okBg] : t === 'paused' ? [C.paused, C.pausedBg] : t === 'blocked' ? [C.blocked, C.blockedBg] : [C.neutral, C.neutralBg];

const S = {
  h1: { fontSize: 20, fontWeight: 700, color: C.text, margin: 0, lineHeight: 1.3 } as any,
  h2: { fontSize: 15, fontWeight: 700, color: C.text, margin: 0 } as any,
  hint: { fontSize: 12, color: C.faint, lineHeight: 1.5 } as any,
  card: { background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: '14px 16px' } as any,
  num: { fontSize: 26, fontWeight: 700, lineHeight: 1.1, color: C.text } as any,
  th: {
    textAlign: 'left' as const,
    padding: '8px 10px',
    borderBottom: `1px solid ${C.line}`,
    color: C.sub,
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap' as const,
    background: '#fafbfd',
  },
  td: { padding: '9px 10px', borderBottom: `1px solid #f1f3f7`, fontSize: 13, color: C.text, verticalAlign: 'top' as const },
};

// ---------------------------------------------------------------------------
// 基础构件
// ---------------------------------------------------------------------------

/** 按**容器**宽度响应（宿主后台有侧边栏，窗口宽度 ≠ 内容宽度） */
function useContainerWidth() {
  const ref = React.useRef(null as any);
  const [width, setWidth] = React.useState(0);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const apply = () => setWidth(Number(el.clientWidth) || 0);
    apply();
    const RO = (globalThis as any).ResizeObserver;
    if (typeof RO === 'function') {
      const ro = new RO(apply);
      ro.observe(el);
      return () => ro.disconnect();
    }
    const g: any = globalThis as any;
    if (typeof g.addEventListener === 'function') {
      g.addEventListener('resize', apply);
      return () => g.removeEventListener('resize', apply);
    }
    return undefined;
  }, []);
  return [ref, width] as const;
}

function Pill({ text, tone }: { text: string; tone: Tone }) {
  const [fg, bg] = toneColor(tone);
  return (
    <span
      style={{
        display: 'inline-block',
        // ⚠️ 在 flex 列容器里 inline-block 会被 stretch 拉成通栏色条（真机 390/1440 都出现过），
        //    必须显式 alignSelf，否则"已关闭"会变成一条横贯整卡的橙色带。
        alignSelf: 'flex-start',
        maxWidth: '100%',
        padding: '2px 8px',
        borderRadius: 10,
        fontSize: 12,
        fontWeight: 600,
        color: fg,
        background: bg,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </span>
  );
}

function Section({
  title,
  hint,
  extra,
  children,
}: {
  /** `key` 在 JSX 里是 React 的保留属性；本仓库没有 react 类型 ⇒ 会被当成普通 prop 检查 */
  key?: any;
  title: string;
  hint?: string;
  extra?: any;
  /**
   * ⚠️ 声明为**可选**：本仓库的 tsconfig 没有 react 类型（`types: []` + 宿主包 stub），
   *    JSX children 不会被推断到 props 上 ⇒ 写成必填会让每个调用点都报 TS2741
   *    （基线里 ticket-drawer 那 12 条就是同一类假阳性）。这里可选，运行期等价。
   */
  children?: any;
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h2 style={S.h2}>{title}</h2>
          {hint ? <span style={S.hint}>{hint}</span> : null}
        </div>
        {extra ?? null}
      </div>
      {children}
    </section>
  );
}

/** 折叠的"技术详情"：内部字段/错误码只放这里，主视图不出现 */
function TechDetails({ children, summary = '技术详情' }: { children?: any; summary?: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ borderTop: `1px dashed ${C.line}`, paddingTop: 8 }}>
      <Button size="small" type="link" style={{ paddingLeft: 0 }} onClick={() => setOpen(!open)}>
        {open ? '收起' : '展开'}
        {summary}
      </Button>
      {open ? <div style={{ marginTop: 6 }}>{children}</div> : null}
    </div>
  );
}

type Col = {
  key: string;
  title: string;
  width?: number;
  render: (row: any) => any;
};

/**
 * 原生表格 + **最小列宽**保证：
 * 容器不够时在表格内部横向滚动（而不是把中文表头压成竖排）。
 */
function DataTable({
  columns,
  rows,
  rowKey,
  minWidth,
  narrow,
  renderCard,
  emptyText,
}: {
  columns: Col[];
  rows: any[];
  rowKey: (row: any) => string | number;
  minWidth: number;
  narrow: boolean;
  renderCard?: (row: any) => any;
  emptyText?: string;
}) {
  if (rows.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText ?? '暂无记录'} />;

  if (narrow && renderCard) {
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{rows.map((r) => <div key={rowKey(r)}>{renderCard(r)}</div>)}</div>;
  }

  return (
    <div style={{ overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: 10, background: C.card }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ ...S.th, minWidth: c.width ?? 88 }}>
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) => (
                <td key={c.key} style={S.td}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KpiCard({ label, value, tone, hint }: { key?: any; label: string; value: number | string; tone: Tone; hint?: string }) {
  const [fg] = toneColor(tone);
  return (
    <div style={{ ...S.card, borderLeft: `4px solid ${fg}`, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: C.sub }}>{label}</span>
      <span style={S.num}>{value}</span>
      {hint ? <span style={{ fontSize: 11, color: C.faint }}>{hint}</span> : null}
    </div>
  );
}

type LoadError = { message: string; kind: 'auth' | 'forbidden' | 'network' | 'shape' | 'other' };

function errorView(err: LoadError, reload: () => void) {
  const title =
    err.kind === 'auth'
      ? '登录状态已失效'
      : err.kind === 'forbidden'
        ? '没有查看权限'
        : err.kind === 'shape'
          ? '数据格式异常'
          : err.kind === 'network'
            ? '网络或服务暂时不可用'
            : '加载失败';
  const desc =
    err.kind === 'forbidden'
      ? '当前账号无权查看该页面数据（仅总部售后角色可查看）。'
      : err.kind === 'auth'
        ? '请重新登录后再打开本页面。'
        : err.message;
  return <Alert type="error" showIcon message={title} description={desc} action={<Button size="small" onClick={reload}>重试</Button>} />;
}

function useApi(request: any, url: string, probeKeys: string[]) {
  const [data, setData] = React.useState(null as any);
  const [error, setError] = React.useState(null as any);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (typeof request !== 'function') throw new Error('request 依赖未注入（Model 工厂漏传）');
      const r = await request(url);
      // 响应可能被包多层（ctx.body → data → data），按"哪层含业务键"取，层数变了不会静默失败
      let cur: any = r;
      let payload: any = null;
      for (let i = 0; i < 5; i += 1) {
        if (!cur || typeof cur !== 'object') break;
        if (probeKeys.some((k) => Object.prototype.hasOwnProperty.call(cur, k))) { payload = cur; break; }
        cur = cur.data ?? null;
      }
      if (!payload) throw new Error(`响应结构不符合契约：未找到 ${probeKeys.join(' / ')}`);
      setData(payload);
    } catch (e: any) {
      setData(null); // 🔴 失败就清空：**不拿上一轮的旧数据冒充实时**
      const status = e?.response?.status;
      const msg =
        e?.response?.data?.errors?.[0]?.message || (status ? `HTTP ${status}` : '') || e?.message || '加载失败';
      const kind: LoadError['kind'] =
        status === 401 ? 'auth' : status === 403 ? 'forbidden' : /契约|契约|结构/.test(msg) ? 'shape' : status ? 'network' : 'other';
      setError({ message: String(msg), kind });
    } finally {
      setLoading(false);
    }
  }, [request, url, probeKeys.join(',')]);

  React.useEffect(() => { void load(); }, [load]);
  return { data, error, loading, reload: load };
}

// ---------------------------------------------------------------------------
// BE-05 · 总部售后工作台
// ---------------------------------------------------------------------------

const KPI_GROUPS: Array<{ title: string; hint: string; keys: Array<{ key: string; label: string; tone: Tone }> }> = [
  {
    title: '今日发生量',
    hint: '今天 00:00 起发生的事',
    keys: [
      { key: 'new_today', label: '今日新增', tone: 'neutral' },
      { key: 'closed_today', label: '今日完成', tone: 'ok' },
    ],
  },
  {
    title: '当前存量',
    hint: '此刻仍处于该状态的工单',
    keys: [
      { key: 'processing_now', label: '当前处理中', tone: 'neutral' },
      { key: 'wait_confirm_now', label: '待门店确认', tone: 'paused' },
      { key: 'overdue_now', label: '超过 24 小时未更新', tone: 'blocked' },
    ],
  },
];

function TrendChart({ rows }: { rows: any[] }) {
  const n = Math.max(rows.length, 1);
  const max = Math.max(1, ...rows.map((r) => Math.max(Number(r.new_count) || 0, Number(r.closed_count) || 0)));
  const W = 620;
  const H = 150;
  const padL = 8;
  const padB = 18;
  const plotH = H - padB - 8;
  const slot = (W - padL * 2) / n;
  const barW = Math.max(2, Math.min(7, slot / 2.6));
  const y = (v: number) => 8 + plotH - (v / max) * plotH;
  return (
    <div style={{ ...S.card, padding: '10px 12px' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="auto" role="img" aria-label="近 30 天新增与完成数量">
        <line x1={padL} y1={8 + plotH} x2={W - padL} y2={8 + plotH} stroke={C.line} strokeWidth="1" />
        {rows.map((r, i) => {
          const x = padL + i * slot;
          const nv = Number(r.new_count) || 0;
          const cv = Number(r.closed_count) || 0;
          return (
            <g key={String(r.day)}>
              <rect x={x + slot / 2 - barW - 1} y={y(nv)} width={barW} height={Math.max(0, 8 + plotH - y(nv))} fill="#4b7bec" rx="1.5" />
              <rect x={x + slot / 2 + 1} y={y(cv)} width={barW} height={Math.max(0, 8 + plotH - y(cv))} fill="#27ae60" rx="1.5" />
            </g>
          );
        })}
        <text x={padL} y={H - 4} fontSize="9" fill={C.faint}>{String(rows[0]?.day ?? '').slice(5)}</text>
        <text x={W - padL} y={H - 4} fontSize="9" fill={C.faint} textAnchor="end">{String(rows[rows.length - 1]?.day ?? '').slice(5)}</text>
        <text x={padL} y={11} fontSize="9" fill={C.faint}>峰值 {max}</text>
      </svg>
      <div style={{ display: 'flex', gap: 14, fontSize: 12, color: C.sub, paddingLeft: 4 }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#4b7bec', borderRadius: 2, marginRight: 5 }} />新增</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#27ae60', borderRadius: 2, marginRight: 5 }} />完成</span>
      </div>
    </div>
  );
}

export function HqWorkbenchBlock({ request }: { request: any }) {
  const [wrapRef, width] = useContainerWidth();
  const { data, error, loading, reload } = useApi(request, HQ_API, ['kpi']);

  const narrow = width > 0 && width < 760;
  const mid = width > 0 && width < 1080;
  // 每组按**自己的卡片数**分列：五个 KPI 一刀切 5 列时，"今日发生量"那两格会被拉得很宽
  const kpiCols = (n: number) => (narrow ? 'repeat(2, minmax(0, 1fr))' : `repeat(${n}, minmax(0, 1fr))`);
  void mid;

  const v = data?.kpi?.values ?? {};
  const defs = data?.kpi?.definitions ?? {};
  const alerts = React.useMemo(() => {
    const list = Array.isArray(data?.alerts) ? [...data.alerts] : [];
    list.sort((a, b) => alertPriority(a.alert_type) - alertPriority(b.alert_type));
    return list;
  }, [data]);
  const stores = Array.isArray(data?.stores) ? data.stores : [];
  // 异常待办：默认 20 条（窄屏 10 条），**可展开到接口返回的全部**（当前 DTO 最多 50 条）
  const [showAllAlerts, setShowAllAlerts] = React.useState(false);
  const alertPageSize = narrow ? 10 : 20;
  void mid;
  const trend = Array.isArray(data?.trend) ? data.trend : [];

  return (
    <div ref={wrapRef} style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '4px 2px', color: C.text }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 }}>
        {/* 不再渲染 h1：宿主页面顶部已显示「总部售后工作台」，区块再写一遍就是两个大标题。 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13, color: C.sub, fontWeight: 600 }}>
            统计日期：{bjRange(data?.range?.from)}
          </span>
          <span style={S.hint}>更新时间：{bjTime(data?.generated_at)}（北京时间）</span>
        </div>
        <Button size="small" onClick={reload} loading={loading}>刷新</Button>
      </header>

      {error ? (
        errorView(error, reload)
      ) : loading && !data ? (
        <div style={{ ...S.card, display: 'flex', justifyContent: 'center', padding: 32 }}><Spin tip="加载总部数据…" /></div>
      ) : !data ? (
        <Alert type="warning" showIcon message="未拿到可用数据" action={<Button size="small" onClick={reload}>重试</Button>} />
      ) : (
        <>
          {KPI_GROUPS.map((g) => (
            <Section key={g.title} title={g.title} hint={g.hint}>
              <div style={{ display: 'grid', gridTemplateColumns: kpiCols(g.keys.length), gap: 10 }}>
                {g.keys.map((k) => (
                  <KpiCard key={k.key} label={k.label} value={Number(v[k.key] ?? 0)} tone={k.tone} />
                ))}
              </div>
            </Section>
          ))}

          <TechDetails summary="指标说明">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {KPI_GROUPS.flatMap((g) => g.keys).map((k) => (
                <div key={k.key} style={{ fontSize: 12, color: C.sub }}>
                  <b style={{ color: C.text }}>{k.label}</b>：{String(defs[k.key] ?? '—')}
                </div>
              ))}
            </div>
          </TechDetails>

          <Section
            title="需要优先处理"
            hint={`按关注优先级与最近更新时间排序，共 ${alerts.length} 条（接口最多返回 50 条，不代表全部异常总量）`}
          >
            <DataTable
              narrow={narrow}
              minWidth={680}
              rowKey={(r) => r.id}
              rows={showAllAlerts ? alerts : alerts.slice(0, alertPageSize)}
              emptyText="当前没有需要关注的异常"
              columns={[
                { key: 'ticket_no', title: '工单号', width: 150, render: (r) => <b>{r.ticket_no || '—'}</b> },
                { key: 'store', title: '门店', width: 130, render: (r) => r.store_name || '—' },
                { key: 'status', title: '当前状态', width: 100, render: (r) => ticketStatusText(r.status) },
                {
                  key: 'why',
                  title: '需要关注的原因',
                  width: 170,
                  render: (r) => (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Pill text={alertTypeText(r.alert_type)} tone={r.alert_type === 'low_rating' ? 'blocked' : r.alert_type === 'overdue' ? 'paused' : 'neutral'} />
                      {r.alert_type === 'low_rating' && r.rating != null ? (
                        <span style={{ color: C.sub, fontSize: 12 }}>{r.rating} 星</span>
                      ) : null}
                      {r.alert_type === 'reopened_after_review' && r.reopen_count > 0 ? (
                        <span style={{ color: C.sub, fontSize: 12 }}>重开 {r.reopen_count} 次</span>
                      ) : null}
                      {/* 附加信息：主原因不是"超时"，但这条也确实已超 24h —— 不能因为分级就丢掉 */}
                      {r.is_overdue === true && r.alert_type !== 'overdue' ? (
                        <span style={{ color: C.faint, fontSize: 12 }}>同时超过 24 小时未更新</span>
                      ) : null}
                    </span>
                  ),
                },
                { key: 'updated', title: '最近更新', width: 120, render: (r) => r.updated_local || '—' },
              ]}
              renderCard={(r) => (
                <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <b style={{ fontSize: 14 }}>{r.ticket_no || '—'}</b>
                    <span style={{ fontSize: 12, color: C.faint }}>{r.updated_local || '—'}</span>
                  </div>
                  <div style={{ fontSize: 12, color: C.sub }}>{r.store_name || '—'}　·　{ticketStatusText(r.status)}</div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Pill text={alertTypeText(r.alert_type)} tone={r.alert_type === 'low_rating' ? 'blocked' : r.alert_type === 'overdue' ? 'paused' : 'neutral'} />
                    {r.rating != null ? <span style={{ fontSize: 12, color: C.sub }}>{r.rating} 星</span> : null}
                  </div>
                </div>
              )}
            />
            {alerts.length > alertPageSize || showAllAlerts ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <Button size="small" onClick={() => setShowAllAlerts(!showAllAlerts)}>
                  {showAllAlerts ? '收起' : `展开更多（还有 ${Math.max(alerts.length - alertPageSize, 0)} 条）`}
                </Button>
                <span style={S.hint}>
                  {showAllAlerts
                    ? `已显示全部 ${alerts.length} 条（接口本次最多返回 50 条）`
                    : `当前显示前 ${Math.min(alertPageSize, alerts.length)} 条，共 ${alerts.length} 条`}
                </span>
              </div>
            ) : null}
          </Section>

          <Section title="门店对比" hint={`共 ${stores.length} 家门店（含今日没有业务的门店，计数为 0 也列出）`}>
            <DataTable
              narrow={narrow}
              minWidth={640}
              rowKey={(r) => r.id}
              rows={stores}
              emptyText="暂无门店数据"
              columns={[
                { key: 'name', title: '门店', width: 160, render: (r) => <b>{r.name || '—'}</b> },
                { key: 'new', title: '今日新增', width: 90, render: (r) => Number(r.new_count ?? 0) },
                { key: 'closed', title: '今日完成', width: 90, render: (r) => Number(r.closed_count ?? 0) },
                { key: 'processing', title: '处理中', width: 90, render: (r) => Number(r.processing_now ?? 0) },
                { key: 'wait', title: '待确认', width: 90, render: (r) => Number(r.wait_confirm_now ?? 0) },
                {
                  key: 'overdue',
                  title: '超过 24 小时未更新',
                  width: 150,
                  render: (r) => (Number(r.overdue_now ?? 0) > 0 ? <Pill text={String(r.overdue_now)} tone="blocked" /> : '0'),
                },
              ]}
              renderCard={(r) => (
                <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <b style={{ fontSize: 14 }}>{r.name || '—'}</b>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
                    {[
                      ['今日新增', r.new_count],
                      ['今日完成', r.closed_count],
                      ['处理中', r.processing_now],
                      ['待确认', r.wait_confirm_now],
                      ['超过 24 小时未更新', r.overdue_now],
                    ].map(([label, val]: any) => (
                      <div key={String(label)} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: C.sub, gap: 8 }}>
                        <span>{label}</span>
                        <b style={{ color: C.text }}>{Number(val ?? 0)}</b>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            />
          </Section>

          <Section title="近 30 天趋势" hint="数据与上方统计同一来源（svc:hqOverview 的 trend），页面不另算口径">
            {trend.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无趋势数据" />
            ) : (
              <>
                <TrendChart rows={trend} />
                <TechDetails summary="趋势明细（表格）">
                  <DataTable
                    narrow={false}
                    minWidth={360}
                    rowKey={(r) => r.day}
                    rows={trend}
                    columns={[
                      { key: 'day', title: '日期', width: 110, render: (r) => r.day },
                      { key: 'new', title: '新增', width: 80, render: (r) => Number(r.new_count ?? 0) },
                      { key: 'closed', title: '完成', width: 80, render: (r) => Number(r.closed_count ?? 0) },
                    ]}
                  />
                </TechDetails>
              </>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BE-03 · 短信通知管理
// ---------------------------------------------------------------------------

const CLOSE_CONFIRM_EXTRA: Record<string, string> = {
  technician_task: '师徒任务通知被关闭后，师傅无法通过短信获知新任务，需人工电话通知。',
  dispatch_update: '派工变更通知被关闭后，客户不会收到上门时间变更短信，可能白跑一趟。',
  technician_assignment_cancelled: '取消失败通知被关闭后，原师傅可能仍按原时间上门。',
};

function SmsOverviewBlockInner({ request }: { request: any }) {
  const [wrapRef, width] = useContainerWidth();
  const { data, error, loading, reload } = useApi(request, SMS_API, ['channel']);

  // ⚠️ 所有 hooks 必须在任何条件 return 之前（React #310）
  const [savingScene, setSavingScene] = React.useState(null as any);
  const [saveMsg, setSaveMsg] = React.useState(null as any);
  const [editingScene, setEditingScene] = React.useState(null as any);
  const [draftCode, setDraftCode] = React.useState('' as any);

  const narrow = width > 0 && width < 760;

  const ch: any = data?.channel ?? {};
  const cs: any = data?.channel_status ?? null;
  const eff: any = cs?.effective ?? {};
  const today: any = data?.today ?? {};
  const scenes: any[] = Array.isArray(data?.scenes) ? data.scenes : [];
  const templates: any[] = Array.isArray(data?.templates) ? data.templates : [];
  const recent: any[] = Array.isArray(data?.recent) ? data.recent : [];

  const globalEnabled: boolean | null = ch.enabled === true ? true : ch.enabled === false ? false : null;
  const channelReady: boolean | null = !cs ? null : eff.canSend === true ? true : eff.canSend === false ? false : null;

  /**
   * 通道**配置**是否就绪：取 `channel_status.providers` 中**当前服务商**那条的 `ready`。
   * ⚠️ 不能用 `effective.canSend` —— 那个把总开关也算进去了（总开关一关就变 false），
   *    会显示成"短信宝凭据未配置"，与事实不符（UI 修复 §二.2）。
   */
  const activeProviderRow = (Array.isArray(cs?.providers) ? cs.providers : []).find(
    (x: any) => String(x.name ?? '') === String(ch.provider ?? ''),
  );
  const channelConfigured: boolean | null =
    activeProviderRow && typeof activeProviderRow.ready === 'boolean' ? activeProviderRow.ready : null;

  const overall = deriveSmsState({
    globalEnabled,
    sceneEnabled: true,
    channelReady,
    channelReason: eff.reason ?? null,
  });

  const saveScene = async (scene: string, next: boolean, current: boolean) => {
    if (typeof request !== 'function') { setSaveMsg({ ok: false, text: '页面未正确加载（request 未注入）' }); return; }
    const label = sceneLabel(scene, scenes.find((s) => s.scene === scene)?.label);
    setSavingScene(scene);
    setSaveMsg(null);
    try {
      await request(
        '/svc:updateSetting',
        'post',
        {
          key: `sms.scene.${scene}.enabled`,
          value: next ? 'true' : 'false',
          expected_value: current ? 'true' : 'false',
          scene: 'update',
        },
        { headers: { 'X-Request-Id': newRequestId() } },
      );
      setSaveMsg({ ok: true, text: `已${next ? '开启' : '关闭'}「${label}」` });
      await reload();
    } catch (e: any) {
      const msg = e?.response?.data?.errors?.[0]?.message ?? e?.message ?? '保存失败';
      setSaveMsg({ ok: false, text: `保存失败：${msg}` });
    } finally {
      setSavingScene(null);
    }
  };

  const confirmToggle = (scene: string, label: string, next: boolean) => {
    const ask = (globalThis as any)?.confirm;
    let text = next
      ? `确认开启「${label}」？开启后，这类通知会恢复正常提交。`
      : `确认关闭「${label}」？关闭后这类通知不再提交。${CLOSE_CONFIRM_EXTRA[scene] ?? ''}`;
    if (globalEnabled === false) {
      text += `\n\n当前所有自动短信已暂停。此设置将在短信总开关恢复后影响新产生的通知。`;
    }
    return typeof ask === 'function' ? ask(text) : true;
  };

  const saveTemplate = async (scene: string, next: string, current: string) => {
    if (typeof request !== 'function') { setSaveMsg({ ok: false, text: '页面未正确加载（request 未注入）' }); return; }
    const label = sceneLabel(scene, templates.find((t) => t.scene === scene)?.label);
    setSavingScene(scene);
    setSaveMsg(null);
    try {
      await request(
        '/svc:updateSetting',
        'post',
        { key: `sms.template.${scene}.code`, value: next, expected_value: current, scene: 'update' },
        { headers: { 'X-Request-Id': newRequestId() } },
      );
      setSaveMsg({ ok: true, text: `已保存「${label}」的模板标识：${next || '（空，回退环境变量）'}` });
      setEditingScene(null);
      await reload();
    } catch (e: any) {
      const msg = e?.response?.data?.errors?.[0]?.message ?? e?.message ?? '保存失败';
      setSaveMsg({ ok: false, text: `保存失败：${msg}` });
    } finally {
      setSavingScene(null);
    }
  };

  const otherFailed = Number(today.rejected_non_switch ?? 0) + Number(today.failed ?? 0);
  // 七个场景的"短原因"是否完全相同：相同就只在横幅里说一次
  const sceneShortReasons = scenes.map(
    (r) =>
      deriveSmsState({
        globalEnabled,
        sceneEnabled: r.enabled === true ? true : r.enabled === false ? false : null,
        channelReady,
        channelReason: eff.reason ?? null,
      }).shortReason,
  );
  const reasonAllSame = sceneShortReasons.length > 0 && new Set(sceneShortReasons).size === 1;

  return (
    <div ref={wrapRef} style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '4px 2px', color: C.text }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 }}>
        {/* 同上：宿主页标题已显示「短信通知总览」，区块只补充辅助信息 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13, color: C.sub, fontWeight: 600 }}>短信通知管理</span>
          <span style={S.hint}>
            更新时间：{bjTime(data?.generated_at)}（北京时间）　·　查看短信发送情况与管理通知设置；本页不会主动发送短信
          </span>
        </div>
        <Button size="small" onClick={reload} loading={loading}>刷新</Button>
      </header>

      {error ? (
        errorView(error, reload)
      ) : loading && !data ? (
        <div style={{ ...S.card, display: 'flex', justifyContent: 'center', padding: 32 }}><Spin tip="加载短信状态…" /></div>
      ) : !data ? (
        <Alert type="warning" showIcon message="未拿到可用数据" action={<Button size="small" onClick={reload}>重试</Button>} />
      ) : (
        <>
          {/* ---------- A. 短信发送总状态 ---------- */}
          <Section title="短信发送总状态" hint="这是「现在会不会发短信」的总判断">
            <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
              <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, color: C.sub }}>短信总开关</span>
                <Pill
                  tone={globalEnabled === true ? 'ok' : globalEnabled === false ? 'paused' : 'neutral'}
                  text={globalEnabled === true ? '已开启' : globalEnabled === false ? '已关闭' : '状态无法确认'}
                />
                <span style={{ fontSize: 11, color: C.faint }}>关闭时所有自动短信一律不提交</span>
              </div>
              <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, color: C.sub }}>当前服务商</span>
                <b style={{ fontSize: 16 }}>{providerLabel(ch.provider)}</b>
                <span style={{ fontSize: 11, color: C.faint }}>短信通道</span>
              </div>
              {/* 🔴 通道配置 ≠ 当前发送：总开关关闭时凭据可能完全正常，
                  旧版把两者合成一个"通道检查：未通过"，会让人以为短信宝没配好。 */}
              <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, color: C.sub }}>通道配置</span>
                <Pill
                  text={channelConfigured === true ? '已就绪' : channelConfigured === false ? '未就绪' : '状态无法确认'}
                  tone={channelConfigured === true ? 'ok' : channelConfigured === false ? 'blocked' : 'neutral'}
                />
                <span style={{ fontSize: 11, color: C.faint }}>只看凭据与必要配置是否齐备</span>
              </div>
              <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, color: C.sub }}>当前发送</span>
                <Pill text={overall.effective.text} tone={overall.effective.tone} />
                <span style={{ fontSize: 11, color: C.faint }}>综合总开关与通道的结论</span>
              </div>
            </div>
            <Alert
              type={overall.effective.tone === 'ok' ? 'success' : overall.effective.tone === 'neutral' ? 'info' : 'warning'}
              showIcon
              message={overall.effective.text}
              description={overall.reason}
            />
            <TechDetails summary="通道技术状态">
              <div style={{ fontSize: 12, color: C.sub, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span>总开关原始值：{ch.enabled === null || ch.enabled === undefined ? '未读到' : String(ch.enabled)}</span>
                <span>通道标识：{String(ch.provider ?? '未配置')}</span>
                <span>通道判定：canSend={String(eff.canSend)}　reason={String(eff.reason ?? '—')}</span>
                <span style={{ color: C.faint }}>（上方横幅已把这段诊断转成业务说法；这里是原文）</span>
                <span>重试上限：{String(cs?.settings?.retryCount ?? '—')} 次</span>
              </div>
            </TechDetails>
          </Section>

          {/* ---------- B. 今日发送概况 ---------- */}
          <Section title="今日发送概况" hint="今日 00:00 起（北京时间）的短信任务统计">
            <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
              <KpiCard label="今日短信任务" value={Number(today.total ?? 0)} tone="neutral" />
              <KpiCard label="因总开关暂停" value={Number(today.blocked_by_switch ?? 0)} tone="paused" />
              <KpiCard label="其它原因未发送" value={otherFailed} tone="blocked" />
              <KpiCard label="服务商已受理" value={Number(today.provider_accepted ?? 0)} tone="ok" />
            </div>
            <div style={{ ...S.card, background: C.page, borderStyle: 'dashed', fontSize: 12, color: C.sub }}>
              送达情况暂无法自动确认：当前短信通道未接入送达回执，页面<strong>不展示</strong>"已送达/未送达"，
              也不把"服务商已受理"当成客户已收到。需要确认时请到服务商后台按手机号或提交时间核对。
            </div>
            {Number(today.delivered ?? 0) > 0 ? (
              <TechDetails summary="历史送达记录">
                <span style={{ fontSize: 12, color: C.sub }}>接口返回 delivered={String(today.delivered)}（若为历史遗留数据，请以服务商后台为准）</span>
              </TechDetails>
            ) : null}
          </Section>

          {/* ---------- C. 通知场景设置 ---------- */}
          <Section
            title="通知场景设置"
            hint="逐项控制「哪类通知会发」；实际是否发出还取决于总开关与通道"
            extra={saveMsg ? <span style={{ fontSize: 12, color: saveMsg.ok ? C.ok : C.blocked }}>{saveMsg.text}</span> : null}
          >
            {globalEnabled === false ? (
              <Alert
                type="info"
                showIcon
                message="当前所有自动短信已暂停"
                description="以下设置将在短信总开关恢复后，影响新产生的通知；已经产生的历史记录不会被重发。"
              />
            ) : null}
            <DataTable
              narrow={narrow}
              minWidth={880}
              rowKey={(r) => r.scene}
              rows={scenes}
              emptyText="没有可配置的通知场景"
              columns={[
                {
                  key: 'name',
                  title: '通知场景',
                  width: 160,
                  render: (r) => <b>{sceneLabel(r.scene, r.label)}</b>,
                },
                {
                  key: 'scene_state',
                  title: '场景设置',
                  width: 100,
                  render: (r) => {
                    const st = deriveSmsState({ globalEnabled, sceneEnabled: r.enabled === true ? true : r.enabled === false ? false : null, channelReady });
                    return <Pill text={st.scene.text} tone={st.scene.tone} />;
                  },
                },
                {
                  key: 'effective',
                  title: '当前实际状态',
                  width: 110,
                  render: (r) => {
                    const st = deriveSmsState({
                      globalEnabled,
                      sceneEnabled: r.enabled === true ? true : r.enabled === false ? false : null,
                      channelReady,
                      channelReason: eff.reason ?? null,
                    });
                    return <Pill text={st.effective.text} tone={st.effective.tone} />;
                  },
                },
                {
                  key: 'reason',
                  title: '说明',
                  width: 260,
                  render: (r) => {
                    const st = deriveSmsState({
                      globalEnabled,
                      sceneEnabled: r.enabled === true ? true : r.enabled === false ? false : null,
                      channelReady,
                      channelReason: eff.reason ?? null,
                    });
                    // 全表原因都一样时（例如总开关关掉）只在顶部横幅说一次，行里给 "—"，
                    // 避免同一句话重复 7 遍把表格挤满
                    return <span style={{ fontSize: 12, color: C.sub }}>{reasonAllSame ? '—' : st.shortReason}</span>;
                  },
                },
                { key: 'count', title: '今日任务', width: 90, render: (r) => Number(r.count ?? 0) },
                { key: 'blocked', title: '被总开关拦截', width: 110, render: (r) => Number(r.blocked ?? 0) },
                {
                  key: 'op',
                  title: '操作',
                  width: 130,
                  render: (r) => {
                    const on = r.enabled !== false;
                    const label = sceneLabel(r.scene, r.label);
                    return (
                      <Button
                        size="small"
                        loading={savingScene === r.scene}
                        danger={on}
                        onClick={() => {
                          if (!confirmToggle(r.scene, label, !on)) return;
                          void saveScene(r.scene, !on, on);
                        }}
                      >
                        {on ? '关闭此类通知' : '开启此类通知'}
                      </Button>
                    );
                  },
                },
              ]}
              renderCard={(r) => {
                const st = deriveSmsState({
                  globalEnabled,
                  sceneEnabled: r.enabled === true ? true : r.enabled === false ? false : null,
                  channelReady,
                  channelReason: eff.reason ?? null,
                });
                const on = r.enabled !== false;
                const label = sceneLabel(r.scene, r.label);
                return (
                  <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                      <b style={{ fontSize: 14 }}>{label}</b>
                      <Pill text={st.effective.text} tone={st.effective.tone} />
                    </div>
                    <div style={{ display: 'flex', gap: 14, fontSize: 12, color: C.sub }}>
                      <span>场景设置：<b style={{ color: C.text }}>{st.scene.text}</b></span>
                      <span>今日 {Number(r.count ?? 0)} 条</span>
                      <span>被拦截 {Number(r.blocked ?? 0)}</span>
                    </div>
                    <span style={{ fontSize: 12, color: C.sub }}>{st.reason}</span>
                    <Button
                      size="small"
                      loading={savingScene === r.scene}
                      danger={on}
                      onClick={() => { if (confirmToggle(r.scene, label, !on)) void saveScene(r.scene, !on, on); }}
                    >
                      {on ? '关闭此类通知' : '开启此类通知'}
                    </Button>
                  </div>
                );
              }}
            />
          </Section>

          {/* ---------- D. 通道诊断及模板管理 ---------- */}
          <Section title="通道诊断及模板管理" hint="只显示「能不能发」与配置完整性，不显示任何密钥">
            <Alert
              type={channelReady === true ? 'success' : channelReady === false ? 'warning' : 'info'}
              showIcon
              message={
                channelConfigured === true
                  ? '通道配置已就绪（凭据与必要配置齐备）'
                  : channelConfigured === false
                    ? `通道配置未就绪：${humanizeChannelReason(activeProviderRow?.reason) || '原因见下方诊断'}`
                    : '通道配置状态无法确认'
              }
              description={`服务商：${providerLabel(ch.provider)}　·　当前发送：${overall.effective.text}　·　短信总开关：${
                globalEnabled === true ? '已开启' : globalEnabled === false ? '已关闭' : '无法确认'
              }`}
            />
            <DataTable
              narrow={narrow}
              minWidth={560}
              rowKey={(r) => r.name}
              rows={Array.isArray(cs?.providers) ? cs.providers : []}
              emptyText="没有可诊断的通道"
              columns={[
                { key: 'label', title: '通道', width: 140, render: (r) => <b>{r.label || providerLabel(r.name)}</b> },
                { key: 'ready', title: '凭据配置', width: 110, render: (r) => <Pill text={r.ready ? '已配置' : '未配置'} tone={r.ready ? 'ok' : 'blocked'} /> },
                { key: 'reason', title: '说明', width: 320, render: (r) => <span style={{ fontSize: 12, color: C.sub }}>{humanizeChannelReason(r.reason) || '—'}</span> },
              ]}
              renderCard={(r) => (
                <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>{r.label || providerLabel(r.name)}</b><Pill text={r.ready ? '已配置' : '未配置'} tone={r.ready ? 'ok' : 'blocked'} /></div>
                  <span style={{ fontSize: 12, color: C.sub }}>{humanizeChannelReason(r.reason) || '—'}</span>
                </div>
              )}
            />
            <TechDetails summary="通道诊断原文（含配置项名称）">
              <DataTable
                narrow={false}
                minWidth={620}
                rowKey={(r) => 'raw-' + r.name}
                rows={Array.isArray(cs?.providers) ? cs.providers : []}
                columns={[
                  { key: 'n', title: '通道标识', width: 130, render: (r) => r.name },
                  { key: 'c', title: '凭据就绪', width: 110, render: (r) => String(r.ready) },
                  { key: 'r', title: '诊断原文', width: 360, render: (r) => <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{r.reason || '—'}</span> },
                ]}
              />
            </TechDetails>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>模板配置</h3>
              <span style={S.hint}>
                这里编辑的是<strong>模板标识</strong>，不是短信正文。短信宝按正文发送，这个标识对短信宝<strong>不生效</strong>；
                阿里云等按模板编号发送的通道才会用到它。保存走受控接口并留下审计记录。
              </span>
              <DataTable
                narrow={narrow}
                minWidth={720}
                rowKey={(r) => r.scene}
                rows={templates}
                emptyText="暂无模板登记"
                columns={[
                  { key: 'scene', title: '通知场景', width: 160, render: (r) => <b>{sceneLabel(r.scene, r.label)}</b> },
                  {
                    key: 'override',
                    title: '模板标识（可编辑）',
                    width: 240,
                    render: (r) => (editingScene === r.scene ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input
                          value={draftCode}
                          placeholder="留空=回退环境变量"
                          onChange={(e: any) => setDraftCode(String(e.target.value))}
                          style={{ width: 130, padding: '3px 6px', border: `1px solid ${C.line}`, borderRadius: 6 }}
                        />
                        <Button size="small" type="primary" loading={savingScene === r.scene} onClick={() => void saveTemplate(r.scene, draftCode.trim(), r.override ?? '')}>保存</Button>
                        <Button size="small" onClick={() => setEditingScene(null)}>取消</Button>
                      </span>
                    ) : (
                      <span>
                        <span style={{ color: C.text }}>{r.override || '（未设置）'}</span>
                        <span style={{ color: C.faint, fontSize: 12 }}>　生效：{r.effective ? '已配置' : '未配置'}</span>
                      </span>
                    )),
                  },
                  {
                    key: 'use',
                    title: '当前通道是否使用',
                    width: 130,
                    render: (r) => <Pill text={r.consumes_code ? '使用模板标识' : '不使用（按正文发送）'} tone={r.consumes_code ? 'neutral' : 'ok'} />,
                  },
                  {
                    key: 'op',
                    title: '操作',
                    width: 90,
                    render: (r) => (
                      <Button size="small" onClick={() => { setEditingScene(r.scene); setDraftCode(r.override ?? ''); }}>编辑标识</Button>
                    ),
                  },
                ]}
                renderCard={(r) => (
                  <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <b>{sceneLabel(r.scene, r.label)}</b>
                    <span style={{ fontSize: 12, color: C.sub }}>模板标识：{r.override || '（未设置）'}　·　{r.consumes_code ? '当前通道会使用' : '当前通道不使用'}</span>
                    <Button size="small" onClick={() => { setEditingScene(r.scene); setDraftCode(r.override ?? ''); }}>编辑标识</Button>
                  </div>
                )}
              />
              <TechDetails summary="模板技术详情（变量名与环境变量）">
                <DataTable
                  narrow={false}
                  minWidth={620}
                  rowKey={(r) => r.scene}
                  rows={templates}
                  columns={[
                    { key: 'scene', title: '场景标识', width: 200, render: (r) => r.scene },
                    { key: 'env', title: '环境变量名', width: 260, render: (r) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.env_var || '(无)'}</span> },
                    { key: 'envok', title: '环境变量已配', width: 110, render: (r) => (r.env_configured ? '是' : '否') },
                    { key: 'vars', title: '可用变量', width: 200, render: (r) => ((r.variables ?? []).length ? r.variables.join(' / ') : '—') },
                  ]}
                />
              </TechDetails>
            </div>
          </Section>

          {/* ---------- E. 最近发送记录 ---------- */}
          <Section title="最近发送记录" hint="最近 30 条，按时间倒序；不展示送达结论（无回执来源）">
            <DataTable
              narrow={narrow}
              minWidth={760}
              rowKey={(r) => r.id}
              rows={recent}
              emptyText="今天还没有短信记录"
              columns={[
                { key: 'time', title: '时间', width: 120, render: (r) => r.created_local || '—' },
                { key: 'scene', title: '通知场景', width: 150, render: (r) => sceneLabel(r.scene) },
                {
                  key: 'result',
                  title: '结果',
                  width: 110,
                  render: (r) => <Pill text={smsSendStatusText(r.send_status)} tone={smsSendStatusTone(r.send_status)} />,
                },
                {
                  key: 'why',
                  title: '说明',
                  width: 300,
                  render: (r) => (
                    <span style={{ fontSize: 12, color: C.sub }}>
                      {smsErrorDetail(r.error_code, r.error_message, r.send_status)}
                    </span>
                  ),
                },
                { key: 'to', title: '收件号码', width: 130, render: (r) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.recipient_masked || '—'}</span> },
              ]}
              renderCard={(r) => (
                <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <b>{sceneLabel(r.scene)}</b>
                    <span style={{ fontSize: 12, color: C.faint }}>{r.created_local || '—'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Pill text={smsSendStatusText(r.send_status)} tone={smsSendStatusTone(r.send_status)} />
                    <span style={{ fontSize: 12, color: C.sub }}>{r.recipient_masked || '—'}</span>
                  </div>
                  <span style={{ fontSize: 12, color: C.sub }}>
                    {smsErrorDetail(r.error_code, r.error_message, r.send_status)}
                  </span>
                </div>
              )}
            />
            <TechDetails summary="原始记录（错误码 / 供应商标识）">
              <DataTable
                narrow={false}
                minWidth={860}
                rowKey={(r) => `t${r.id}`}
                rows={recent}
                columns={[
                  { key: 'id', title: 'ID', width: 70, render: (r) => r.id },
                  { key: 'scene', title: 'scene', width: 190, render: (r) => r.scene },
                  { key: 'ss', title: 'send_status', width: 100, render: (r) => r.send_status },
                  { key: 'ec', title: 'error_code', width: 230, render: (r) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.error_code || '—'}</span> },
                  { key: 'req', title: 'provider_request_id', width: 150, render: (r) => <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{r.provider_request_id || '—'}</span> },
                  { key: 'biz', title: 'provider_biz_id', width: 150, render: (r) => <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{r.provider_biz_id || '—'}</span> },
                ]}
              />
            </TechDetails>
          </Section>
        </>
      )}
    </div>
  );
}

export function SmsOverviewBlock(props: { request: any }) {
  return <SmsOverviewBlockInner {...props} />;
}

// ---------------------------------------------------------------------------
// Flow Engine 区块模型工厂（保持原样：不改模型名、不改挂载方式）
// ---------------------------------------------------------------------------
export function buildHqWorkbenchModel({ BaseBlockModel, request }: { BaseBlockModel: any; request: any }) {
  class HqWorkbenchBlockModel extends (BaseBlockModel as any) {
    render(): any {
      return React.createElement(HqWorkbenchBlock, { request });
    }
  }
  HqWorkbenchBlockModel.define?.({ label: '总部售后工作台' });
  return { HqWorkbenchBlockModel };
}

export function buildSmsOverviewModel({ BaseBlockModel, request }: { BaseBlockModel: any; request: any }) {
  class SmsOverviewBlockModel extends (BaseBlockModel as any) {
    render(): any {
      return React.createElement(SmsOverviewBlock, { request });
    }
  }
  SmsOverviewBlockModel.define?.({ label: '短信通知总览' });
  return { SmsOverviewBlockModel };
}
