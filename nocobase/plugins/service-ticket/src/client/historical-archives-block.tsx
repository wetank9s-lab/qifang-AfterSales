/**
 * historical-archives-block.tsx —— BE-02A S2：历史售后档案专用区块
 *
 * ===========================================================================
 * 为什么不用原生 TableBlockModel
 * ===========================================================================
 * 历史集合（historicalServiceArchives 等）不进 `collections:listMeta`：
 *   裁剪者是本项目 `collection-metadata-scope.ts` 的 `COLLECTION_METADATA_ALLOWLIST`（4 项），
 *   而原生 ACL 对这批集合的 `list` 也始终 403（四轮实验均未通）。
 *
 * 所以本页**完全不依赖**：
 *   · 历史 Collection 的客户端元数据（不在 listMeta 里也能跑）
 *   · 原生 Collection ACL（一个权限都不扩）
 * 数据全部来自受控只读接口 `svc:historicalArchiveQuery`
 * （门店隔离在服务端用 `listBatchesForActor` → `batch_id $in` 完成）。
 *
 * ===========================================================================
 * 挂载方式（与 StoreWorkbenchModel / PageThemeModel 同一套）
 * ===========================================================================
 * seed 建 `markdown` 宿主区块 → 把该节点的 `use` 换成 `HistoricalArchivesBlockModel`
 * → `flowModels:save` → 回读。见 scripts/seed-admin-pages.mjs 的 `seedHistoricalArchivesBlock()`。
 */
import React from 'react';
import { Alert, Button, DatePicker, Empty, Input, Modal, Space, Spin, Tag } from 'antd';

const API = '/svc:historicalArchiveQuery';
const PAGE_SIZES = [10, 20, 50];

type Row = {
  id: number;
  archiveNo?: string | null;
  storeCode?: string | null;
  customerName?: string | null;
  customerMobile?: string | null;
  deviceSummary?: string | null;
  serviceDate?: string | null;
  archivedAt?: string | null;
};

type Detail = Row & {
  customerAddress?: string | null;
  archiveNote?: string | null;
  sourceFileName?: string | null;
  sourceSheet?: string | null;
  sourceRow?: number | null;
  archivedBy?: string | null;
  conversionState?: string | null;
  batchId?: number | null;
};

/** 把接口错误翻成员工能看懂的话（不把堆栈抛给业务） */
function humanize(status?: number, code?: string): string {
  if (status === 401) return '登录状态已失效，请重新登录后再试。';
  if (status === 403) return '当前角色没有查看历史档案的权限。';
  if (status === 404) return '这条历史档案不存在，或不在你的门店范围内。';
  if (status && status >= 500) return '服务暂时不可用，请稍后重试。';
  if (code === 'NETWORK') return '网络异常，请检查连接后重试。';
  return '查询失败，请稍后重试。';
}

export function HistoricalArchivesPanel({ request }: { request: any }) {
  const [keyword, setKeyword] = React.useState('');
  const [storeCode, setStoreCode] = React.useState('');
  const [range, setRange] = React.useState<[string, string]>(['', '']);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);
  const [rows, setRows] = React.useState<Row[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [detail, setDetail] = React.useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState('');

  // 过期响应丢弃：快速连点时只认最后一次
  const seq = React.useRef(0);

  // ⚠️ 显式接收筛选条件：`reset()` 里 setState 是异步的，若让 load 读闭包里的 state，
  //    重置后第一次查询仍会带着旧 keyword（实测：重置后 total 仍是"共 29 条"）。
  const load = React.useCallback(
    async (p: number, ps: number, kw = keyword, sc = storeCode, rg = range) => {
      const my = ++seq.current;
      setLoading(true);
      setError('');
      try {
        // ⚠️ 本项目 `request` 的签名是 `request(urlString)`，不是 axios 的 `request(config)`
        const qs = new URLSearchParams({
          page: String(p),
          pageSize: String(ps),
          ...(kw ? { keyword: kw } : {}),
          ...(sc ? { storeCode: sc } : {}),
          ...(rg[0] ? { dateFrom: rg[0] } : {}),
          ...(rg[1] ? { dateTo: rg[1] } : {}),
        }).toString();
        const r = await request(`${API}?${qs}`);
        if (my !== seq.current) return;
        // NocoBase 的 request 会解包一层：既可能是 {data:{archives}} 也可能直接是 {archives}
        const d = Array.isArray(r?.data?.archives) ? r.data : Array.isArray(r?.archives) ? r : {};
        setRows(Array.isArray(d.archives) ? d.archives : []);
        setTotal(Number(d.total) || 0);
      } catch (e: any) {
        if (my !== seq.current) return;
        setRows([]);
        setTotal(0);
        setError(humanize(e?.response?.status, e?.code));
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [keyword, storeCode, range],
  );

  React.useEffect(() => {
    void load(page, pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize]);

  const search = () => {
    if (page === 1) void load(1, pageSize);
    else setPage(1); // 条件变化回第一页
  };

  const reset = () => {
    setKeyword('');
    setStoreCode('');
    setRange(['', '']);
    // 直接传空条件，不等 setState 生效
    if (page === 1) void load(1, pageSize, '', '', ['', '']);
    else setPage(1);
  };

  const openDetail = async (id: number) => {
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    try {
      const r = await request(`${API}?id=${encodeURIComponent(String(id))}`);
      const d = r?.data?.archive ? r.data : r?.archive ? r : {};
      if (!d.archive) throw Object.assign(new Error('not found'), { response: { status: 404 } });
      setDetail(d.archive as Detail);
    } catch (e: any) {
      setDetailError(humanize(e?.response?.status, e?.code));
    } finally {
      setDetailLoading(false);
    }
  };

  const th: React.CSSProperties = { padding: '8px 10px', textAlign: 'left', background: '#fafafa', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap', fontWeight: 600 };
  const td: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid #f5f5f5', verticalAlign: 'top' };

  const showEmpty = !loading && !error && rows.length === 0;

  return (
    <div data-testid="be02a-archives-panel" style={{ padding: 12 }}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 10 }}
        message="这里是历史售后档案，与当前在办工单分开统计；不会自动生成新工单。"
      />

      <Space wrap style={{ marginBottom: 10 }}>
        <Input
          placeholder="客户姓名 / 手机号 / 历史单号"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={search}
          style={{ width: 240 }}
          data-testid="be02a-keyword"
        />
        <Input
          placeholder="门店编码（如 S01）"
          value={storeCode}
          onChange={(e) => setStoreCode(e.target.value)}
          onPressEnter={search}
          style={{ width: 150 }}
          data-testid="be02a-store-code"
        />
        {/* ⚠️ 用两个独立 `DatePicker`，不用 `DatePicker.RangePicker`：
            后者在本项目的 antd 打包形态里取到的是 undefined（实测整块日期控件不渲染）。 */}
        {/* ⚠️ 必须用**函数式** setRange：两个控件的 onChange 读闭包里的 `range` 时，
            先设的那个值在下一次 onChange 里读不到（实测：只点出 dateFrom，dateTo 丢失）。 */}
        <DatePicker
          placeholder="开始日期"
          format="YYYY-MM-DD"
          onChange={(_v: any, s: any) => setRange((prev) => [s || '', prev[1] || ''])}
          data-testid="be02a-date-from"
        />
        <DatePicker
          placeholder="结束日期"
          format="YYYY-MM-DD"
          onChange={(_v: any, s: any) => setRange((prev) => [prev[0] || '', s || ''])}
          data-testid="be02a-date-to"
        />
        <Button type="primary" onClick={search} data-testid="be02a-search">
          查询
        </Button>
        <Button onClick={reset} data-testid="be02a-reset">
          重置
        </Button>
      </Space>

      {error ? (
        <Alert
          type="error"
          showIcon
          message={error}
          action={
            <Button size="small" onClick={() => void load(page, pageSize)}>
              重试
            </Button>
          }
          data-testid="be02a-error"
        />
      ) : null}

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center' }} data-testid="be02a-loading">
          <Spin />
        </div>
      ) : error ? null : showEmpty ? (
        <Empty
          description={keyword || storeCode || range[0] ? '没有符合条件的历史档案' : '暂无历史档案'}
          data-testid="be02a-empty"
        />
      ) : (
        <>
          <div style={{ overflowX: 'auto', border: '1px solid #f0f0f0', borderRadius: 6 }} data-testid="be02a-table">
            <table style={{ width: '100%', minWidth: 880, borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={th}>历史单号</th>
                  <th style={th}>客户姓名</th>
                  <th style={th}>客户手机号</th>
                  <th style={th}>所属门店</th>
                  <th style={th}>服务时间</th>
                  <th style={th}>产品/服务</th>
                  <th style={th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={td}>{r.archiveNo || '—'}</td>
                    <td style={td}>{r.customerName || '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.customerMobile || '—'}</td>
                    <td style={td}>{r.storeCode || '—'}</td>
                    <td style={td}>{r.serviceDate ? String(r.serviceDate).slice(0, 10) : '—'}</td>
                    <td style={{ ...td, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.deviceSummary || ''}>
                      {r.deviceSummary || '—'}
                    </td>
                    <td style={td}>
                      <Button type="link" size="small" onClick={() => void openDetail(r.id)} data-testid={`be02a-detail-${r.id}`}>
                        详情
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <span style={{ color: '#666' }} data-testid="be02a-total">
              共 {total} 条
            </span>
            <Space>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                data-testid="be02a-page-size"
                style={{ padding: '2px 6px' }}
              >
                {PAGE_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s} 条/页
                  </option>
                ))}
              </select>
              <Button size="small" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)} data-testid="be02a-prev">
                上一页
              </Button>
              <span>
                {page} / {Math.max(1, Math.ceil(total / pageSize))}
              </span>
              <Button
                size="small"
                disabled={page >= Math.ceil(total / pageSize) || loading}
                onClick={() => setPage((p) => p + 1)}
                data-testid="be02a-next"
              >
                下一页
              </Button>
            </Space>
          </div>
        </>
      )}

      <Modal
        open={detailLoading || !!detail || !!detailError}
        title="历史档案详情"
        footer={null}
        onCancel={() => {
          setDetail(null);
          setDetailError('');
          setDetailLoading(false);
        }}
        width={640}
        data-testid="be02a-detail-modal"
      >
        {detailLoading ? <Spin /> : detailError ? <Alert type="warning" showIcon message={detailError} /> : detail ? <DetailBody d={detail} request={request} onChanged={() => { void openDetail(detail.id); void load(page, pageSize); }} /> : null}
      </Modal>
    </div>
  );
}

function maskMobile(m?: string | null): string {
  const s = String(m ?? '').trim();
  if (!s) return '';
  return s.length >= 4 ? `****${s.slice(-4)}` : '****';
}

/**
 * BE-02B：历史档案详情末尾的「转为服务单」。
 *
 * 只做 **UI 接线**：幂等、权限、归属、建单、审计全部由
 * `svc:historicalConvertToTicket` 在服务端完成，前端不模拟也不重试拿新键
 * （服务端的幂等键由 `archiveId` 派生，只要不换 archiveId 就天然复用）。
 *
 * ⚠️ 前端角色判断**只用于展示**，不代替服务端权限校验：
 *    真正的 403（STORE_STAFF_ONLY / CROSS_STORE_FORBIDDEN）由服务端给。
 */
function ConversionPanel({
  d,
  request,
  onChanged,
}: {
  d: Detail;
  request: any;
  onChanged?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<{ ticketNo?: string | null; reused?: boolean } | null>(null);
  const [err, setErr] = React.useState('');

  const converted = d.conversionState === 'converted' || !!done;
  const noMobile = !String(d.customerMobile ?? '').trim();
  const reasonOk = reason.trim().length >= 4;

  if (converted) {
    return (
      <div data-testid="be02b-conversion" style={{ marginTop: 12 }}>
        <Alert
          type="success"
          showIcon
          message={
            done?.ticketNo
              ? `已转为 ${done.ticketNo}${done.reused ? '（复用已有工单，未新建）' : ''}`
              : '该档案已转成当前服务单，不可重复转换'
          }
          data-testid="be02b-converted"
        />
      </div>
    );
  }

  if (noMobile) {
    return (
      <div data-testid="be02b-conversion" style={{ marginTop: 12 }}>
        <Alert
          type="info"
          showIcon
          message="该档案缺少手机号，暂不能转为服务单"
          description="请先按现有业务流程补全手机号，再回来转换。"
          data-testid="be02b-no-mobile"
        />
        <Button disabled style={{ marginTop: 8 }} data-testid="be02b-convert-disabled">
          转为服务单
        </Button>
      </div>
    );
  }

  const submit = async () => {
    if (busy || !reasonOk) return;
    setBusy(true);
    setErr('');
    try {
      const payload = await request('svc:historicalConvertToTicket', 'post', {
        archiveId: d.id,
        reason: reason.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      const data = payload?.data ?? payload;
      if (!data || data.ticketId === undefined || data.ticketId === null) {
        throw new Error('服务端未返回工单信息，请刷新后确认是否已创建');
      }
      setDone({ ticketNo: data.ticketNo ?? null, reused: !!data.reused });
      setOpen(false);
      onChanged?.();
    } catch (e: any) {
      // 403 / 404 / 409 / 422 的文案由服务端给，原样显示，不吞
      const msg = e?.error?.message || e?.message || '转换失败';
      setErr(String(msg));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="be02b-conversion" style={{ marginTop: 12 }}>
      <Button
        type="primary"
        data-testid="be02b-convert-open"
        onClick={() => {
          setErr('');
          setOpen(true);
        }}
      >
        转为服务单
      </Button>
      <div style={{ marginTop: 6, color: '#888', fontSize: 12 }}>
        只把这一条历史记录转成当前报修单；不会批量、不会自动。
      </div>
      <Modal
        open={open}
        title="转为当前服务单"
        okText={busy ? '提交中…' : '确认转换'}
        cancelText="取消"
        confirmLoading={busy}
        okButtonProps={{ disabled: !reasonOk || busy }}
        onCancel={() => {
          if (busy) return;
          setOpen(false);
        }}
        onOk={() => void submit()}
        destroyOnClose
      >
        <div data-testid="be02b-convert-dialog" style={{ fontSize: 13 }}>
          <div style={{ padding: '4px 0' }}>客户姓名：{d.customerName || '—'}</div>
          <div style={{ padding: '4px 0' }}>联系电话：{maskMobile(d.customerMobile)}</div>
          <div style={{ padding: '4px 0' }}>原归属门店：{d.storeCode || '—'}</div>
          <div style={{ padding: '4px 0' }}>历史问题 / 设备：{d.deviceSummary || '—'}</div>
          <div style={{ padding: '4px 0' }}>历史服务日期：{d.serviceDate || '—'}</div>
          <div style={{ padding: '4px 0' }}>处理结果：{d.archiveNote || '—'}</div>
          <div style={{ padding: '4px 0' }}>
            来源：{d.sourceFileName || '—'}
            {d.sourceSheet ? ` · ${d.sourceSheet}` : ''}
            {d.sourceRow ? ` · 第 ${d.sourceRow} 行` : ''}
          </div>
          <div style={{ padding: '4px 0' }}>将创建的工单类型：<b>报修</b></div>
          <div style={{ marginTop: 8 }}>转单理由（必填，至少 4 字）：</div>
          <Input.TextArea
            data-testid="be02b-convert-reason"
            rows={3}
            value={reason}
            maxLength={200}
            placeholder="为什么这条历史事项仍需继续处理"
            onChange={(e) => setReason(e.target.value)}
          />
          <div style={{ marginTop: 8 }}>备注（选填）：</div>
          <Input
            data-testid="be02b-convert-note"
            value={note}
            maxLength={120}
            onChange={(e) => setNote(e.target.value)}
          />
          {err ? (
            <Alert style={{ marginTop: 10 }} type="error" showIcon message={err} data-testid="be02b-convert-error" />
          ) : null}
          <div style={{ marginTop: 10, color: '#888', fontSize: 12 }}>
            确认后会在当前门店下新建一张报修单，并把这条历史档案标记为已转换。
          </div>
        </div>
      </Modal>
    </div>
  );
}

function DetailBody({ d, request, onChanged }: { d: Detail; request: any; onChanged?: () => void }) {
  const item = (k: string, v: any) => (
    <div style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
      <span style={{ width: 96, color: '#888', flex: 'none' }}>{k}</span>
      <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{v === null || v === undefined || v === '' ? '—' : String(v)}</span>
    </div>
  );
  return (
    <div data-testid="be02a-detail-body">
      {item('历史单号', d.archiveNo)}
      {item('所属门店', d.storeCode)}
      {item('客户姓名', d.customerName)}
      {item('客户手机号', d.customerMobile)}
      {item('服务地址', d.customerAddress)}
      {item('产品/服务', d.deviceSummary)}
      {item('服务时间', d.serviceDate)}
      {item('处理结果', d.archiveNote)}
      {item('来源文件', d.sourceFileName)}
      {item('来源位置', [d.sourceSheet, d.sourceRow].filter(Boolean).join(' 第 ') || null)}
      {item('归档人', d.archivedBy)}
      {item('归档时间', d.archivedAt)}
      {item('批次', d.batchId)}
      <div style={{ marginTop: 10 }}>
        <Tag color={d.conversionState === 'converted' ? 'green' : 'default'}>
          转单状态：{d.conversionState || '未转换'}
        </Tag>
      </div>
      <ConversionPanel d={d} request={request} onChanged={onChanged} />
    </div>
  );
}

export function buildHistoricalArchivesModel({ BaseBlockModel, request }: { BaseBlockModel: any; request: any }) {
  class HistoricalArchivesBlockModel extends (BaseBlockModel as any) {
    render(): any {
      // ⚠️ 与 StoreWorkbenchModel 一致：直接用 build 时注入的 `request`。
      //    不要读 `this.context.request` —— 那个成员不是函数，会静默抛错（本轮踩过一次）。
      return React.createElement(HistoricalArchivesPanel, { request });
    }
  }
  HistoricalArchivesBlockModel.define?.({ label: '历史售后档案' });
  return { HistoricalArchivesBlockModel };
}
