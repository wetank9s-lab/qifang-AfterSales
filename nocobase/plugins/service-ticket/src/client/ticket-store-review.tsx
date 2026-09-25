/**
 * P6-0 → P6-2 —— 门店回执区块：**只读展示** + **确认 / 驳回两个业务动作**
 * =============================================================================
 *
 * 这个文件存在的理由：P6-0 的命题**不是**"后端权限函数看起来正确"，而是
 * **"门店真的能够安全看到自己即将审核的技师回执和照片"**。所以除了 I11 / I14
 * 两个端点，还必须有一条**很薄的链路**把这件事走通。
 *
 * P6-2（2026-09-25）在这个区块的底部接上**确认 / 驳回**两个动作。它们不是
 * 新开的抽屉、也不是工单表上的第 6 个按钮 —— 就在"看到回执"的同一处收口，
 * 缩短门店动线（见下方"为什么是区块"）。确认 / 驳回都走 `svc/visits/:id/...`
 * 斜杠式写接口（nginx 两段式 rewrite），成功或 409 后把整页交回父组件重拉。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么是「区块」而不是「独立抽屉 / 新的第 6 个动作」（2026-09-25 收口）
 * ─────────────────────────────────────────────────────────────────────────────
 * `docs/PHASE-6.md` §6.3 写的是：**复用现有 H3（工单详情只读抽屉）体系**，
 * 不新建完整审核工作台；§8.1 的交付物清单里**没有**任何新 `ActionModel`、
 * 只有 `index.ts` 的 `responseType` 透传。
 *
 * 所以本文件导出的是一个**区块组件**，由 `ticket-drawer.tsx`（H3）在
 * 「当前服务」之后内联渲染 —— 而不是自己开一个抽屉、更不是在工单表上
 * 加第 6 个按钮。原因不只是"少写代码"：
 *   ① 加按钮 = 要往 `flowModels` 播种动作实例（改库），且对**所有角色/所有状态**
 *      都多一个按钮；而审核对象只在这一种状态下存在。
 *   ② 门店同事的动线本来就是"看到一张待确认的单 → 点详情"；
 *      把回执放进详情，是**缩短**动线，不是多开一个入口。
 *   ③ §6.3 明确"复用 H3 体系"，本实现按字面执行，不做解释性扩张。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 照片为什么这么取（`docs/PHASE-6.md` §4.3a，用户 2026-09-25 拍板）
 * ─────────────────────────────────────────────────────────────────────────────
 * `<img src="...">` **无法携带 Authorization 头**，而私有照片又不允许
 * 签成"脱离登录身份仍可读"的 URL。因此唯一路径是：
 *
 *   authenticated request → Blob → URL.createObjectURL() → <img src="blob:...">
 *                                                     ↘ unmount 时 revokeObjectURL()
 *
 * 浏览器里的 `blob:` 只是**内存副本**，不构成新的服务端读取权限 ——
 * 因此**登录会话失效后重新取图仍然 401**（这是验收矩阵的 S1）。
 *
 * 为什么按**每张照片**分开取、而不是一次性拉一个图片数组：
 *   I14 的授权是"照片 → Visit → Ticket → 数据范围"，逐张校验；
 *   而且 1~6 张、每张 ≤5MB，逐张取完即可显示，不必等全部到齐
 *   （门店同事先看到第一张就能开始判断）。
 *
 * ⚠️ 依赖纪律与 ticket-drawer.tsx 完全一致：只 import 运行时可解析的
 *    `react` / `antd`，排版用原生 HTML + 内联样式（不用 Descriptions/Timeline，
 *    它们的 v4/v5 写法不兼容，踩错就是整块渲染不出来）。
 */
import React, { useEffect, useState } from 'react';
import { Button, Empty, Form, Input, Modal, Space, Spin, Tag, message } from 'antd';

import {
  CONFIRMED_AMOUNT_MAX,
  PHOTO_TYPE_LABEL,
  SERVICE_RESULT_LABEL,
  STORE_CONFIRM_STATUS,
  TICKET_STATUS_LABEL,
} from '../server/constants';
// P6-2：确认/驳回是**写**动作 —— 必须带幂等请求号（X-Request-Id），
// 与 ticket-actions.tsx 的四个业务动作同一套纪律（见 svc-request.ts 顶部注释）。
// ⚠️ 注意这里**不用** sendSvcRequest：它的 URL 是冒号式 `svc:<action>`，而
//    confirm/reject 走的是**斜杠式** `svc/visits/:id/confirm`（nginx 两段式 rewrite，
//    与门禁脚本同源）。只复用 `newRequestId` 生成幂等号 + `REQUEST_ID_HEADER` 头名。
import { REQUEST_ID_HEADER, newRequestId } from '../shared/svc-request';
import { formatStamp, visitStatusText } from './ticket-display';

/**
 * 请求器形态：与 `index.ts` 注入的 `request` 同形。
 *
 * 第四个参数的 `responseType` 是**取照片必需**的（见 index.ts 的注释）——
 * 没有它，axios 会把图片二进制当文本处理，拿到一张打不开的图。
 */
export type ReviewRequester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

export interface StoreReviewSectionProps {
  /**
   * **审核对象**的 Visit id（`visit_status = SUBMITTED` 的那条）。
   *
   * ⚠️ 由调用方用 `submittedVisitOf()` 选定 —— 本组件**不猜顺序**。
   *    没有待确认回执时调用方根本不会渲染本组件（见 ticket-drawer.tsx）。
   */
  visitId: number | string;
  request: ReviewRequester;
  /**
   * P6-2：确认 / 驳回**成功**后的回调。
   *
   * 确认/驳回会推进**工单**状态（WAIT_FEEDBACK / PROCESSING）、写入时间线事件，
   * 而这些数据在父组件（ticket-drawer.tsx）手里 —— 只刷新本区块的 Visit 详情
   * 无法让"按钮消失 + 状态标签更新 + 时间线多一条"同时发生。
   * 所以这里成功后就**把整页详情交给父组件重拉**，而不是自己再拉一次 I11。
   * 409 冲突（别人已经处理）同样走这个回调：重拉即呈现最新真实状态。
   */
  onChanged?: () => void;
}

/** 门店确认状态 → 中文（服务端只存枚举，文案在展示层） */
const STORE_CONFIRM_LABEL: Record<string, string> = {
  [STORE_CONFIRM_STATUS.PENDING]: '待门店确认',
  [STORE_CONFIRM_STATUS.CONFIRMED]: '门店已确认',
  [STORE_CONFIRM_STATUS.REJECTED]: '门店已驳回',
};

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

/** 金额展示：统一 ¥ 两位小数；空值给 `—` 而不是 `¥0.00`（"没收"与"没填"不是一回事） */
export function moneyText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `¥${n.toFixed(2)}`;
}

/**
 * 单张照片缩略图：**自己取字节、自己管 blob 生命周期**。
 *
 * 为什么把 createObjectURL / revokeObjectURL 收在一个组件里：
 *   它们必须**成对**出现在同一次挂载周期内。散在父组件里写就会出现
 *   "换了 Visit 但旧 blob 没释放"（内存泄漏）或"释放早了"（图变白）。
 *   放在这里，`useEffect` 的 cleanup 天然就是配对点。
 */
export function PhotoThumb({ photoId, request }: { photoId: number; request: ReviewRequester }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let created: string | null = null;

    (async () => {
      try {
        // ⚠️ 路径**不带 `/api` 前缀**（apiClient 会自己补），也不带前导斜杠。
        //    写成 `/api/svc/photos/1` 会变成 `/api/api/svc/photos/1` → 404
        //    （这个坑在 ticket-drawer.tsx 的注释里已踩过一次，DEV-72）。
        const blob = await request(`svc/photos/${photoId}`, 'get', undefined, {
          responseType: 'blob',
        });
        if (!alive) return;
        if (!(blob instanceof Blob)) {
          // 服务端回的是 JSON 错误体（例如 404 PHOTO_NOT_FOUND）时，
          // axios 在 responseType:'blob' 下仍可能给出 Blob —— 这里只做类型兜底，
          // 真正的失败由 catch 分支呈现。
          throw new Error('响应不是图片');
        }
        created = URL.createObjectURL(blob);
        setUrl(created);
      } catch (e) {
        if (alive) setError((e as Error)?.message ?? String(e));
      }
    })();

    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [photoId, request]);

  if (error) {
    return (
      <div
        style={{
          width: 150,
          height: 150,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px dashed #ffccc7',
          borderRadius: 6,
          color: '#cf1322',
          fontSize: 12,
          padding: 8,
          textAlign: 'center',
        }}
      >
        照片读取失败
      </div>
    );
  }

  if (!url) {
    return (
      <div
        style={{
          width: 150,
          height: 150,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#fafafa',
          borderRadius: 6,
        }}
      >
        <Spin size="small" />
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={`照片 ${photoId}`}
      style={{
        width: 150,
        height: 150,
        objectFit: 'cover',
        borderRadius: 6,
        border: '1px solid #f0f0f0',
      }}
    />
  );
}

interface ReviewState {
  loading: boolean;
  error: string | null;
  visit: any;
  photos: any[];
}

/**
 * H3 详情抽屉里的「技师回执（只读）」区块。
 *
 * 只在**存在待门店确认的回执**时才由调用方渲染（见 ticket-drawer.tsx 的
 * `submittedVisitOf`）—— 也就是说，这个区块在非 `WAIT_STORE_CONFIRM` 的
 * 工单上**一次请求都不会发**，不会给普通查单增加负担。
 *
 * 字段严格按 §6.3 的清单：技师 / 服务结果 / 处理说明 / 是否收费 / 技师报费 /
 * 服务照片 / 提交时间 + Visit 标识 + 「待门店确认」。
 * ⚠️ 刻意**不重复**「服务方式 / 服务商」—— 它们在上方「当前服务」区块已经出现，
 *    而本项目有一条来自真人反馈的硬纪律：**同一件事只说一次**
 *    （见 ticket-drawer.tsx 顶部注释 ③）。审核对象永远是当前 active Visit，
 *    所以这两行在上方必定可见，不存在"漏掉"的风险。
 */
export function StoreReviewSection({ visitId, request, onChanged }: StoreReviewSectionProps) {
  const [state, setState] = useState<ReviewState>({
    loading: true,
    error: null,
    visit: null,
    photos: [],
  });
  // 确认 / 驳回两个轻量模态框的开关（各自独立，避免一个 Form 复用串状态）
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: null, visit: null, photos: [] });

    // I11 读模型：回执字段 + 照片的**安全展示元数据**（不含 storage_key）。
    // 照片**字节**由每个缩略图各自去取（I14），这里只拿"有哪几张"。
    const url = `svc/visits/${visitId}`;
    (async () => {
      try {
        const detail = await request(url);
        if (!alive) return;
        setState({
          loading: false,
          error: null,
          visit: detail?.data?.visit ?? null,
          photos: detail?.data?.photos ?? [],
        });
      } catch (error) {
        if (!alive) return;
        // 沿用 H3 的老纪律：**把实际请求的地址放进错误文案**
        // （DEV-72 之后，排障最缺的从来不是"它坏了"，而是那一行 Request URL）。
        setState({
          loading: false,
          error: `${url} → ${(error as Error)?.message ?? String(error)}`,
          visit: null,
          photos: [],
        });
      }
    })();

    return () => {
      alive = false;
    };
  }, [visitId, request]);

  const visit = state.visit ?? {};
  const confirmText =
    STORE_CONFIRM_LABEL[String(visit.store_confirm_status ?? '')] ?? '待门店确认';

  // ── P6-2 提交逻辑 ────────────────────────────────────────────────────────
  // 金额口径**必须与后端同源**（契约 L3 / O4）：`is_charged` 是 Visit 的服务事实，
  // 不收费时不出现金额输入框、也不传 amount；收费时才要求确认实际金额，
  // 且「改了技师报费」时必须填说明（§3.3 改额留痕）。
  const isCharged = visit.is_charged === true;
  const reportedAmount =
    visit.reported_charge_amount === null || visit.reported_charge_amount === undefined
      ? null
      : Number(visit.reported_charge_amount);

  /**
   * 把服务端拒绝归类成三种 UI 话术，而不是一句泛泛的"操作失败"。
   *
   * ⚠️ 409 尤其关键（用户 P6-2 明确要求）：`VISIT_NOT_REVIEWABLE` /
   *    `IDEMPOTENT_VISIT_MISMATCH` / `NO_ACTIVE_VISIT` / `CONFLICT_STATE_CHANGED`
   *    都意味着"这张回执在我打开详情到点下按钮之间，已经被别人（或另一个窗口）
   *    处理过了" —— 正确的动作是**重新拉最新状态**，而不是让门店以为系统坏了。
   */
  function messageForSubmitError(error: any): { text: string; refresh: boolean } {
    const payload = error?.response?.data ?? error?.data ?? {};
    const first = payload?.errors?.[0];
    const code = first?.code ?? payload?.code;
    const msg = first?.message ?? payload?.message ?? error?.message ?? '操作失败';
    const CONFLICT_CODES = new Set([
      'VISIT_NOT_REVIEWABLE',
      'IDEMPOTENT_VISIT_MISMATCH',
      'NO_ACTIVE_VISIT',
      'CONFLICT_STATE_CHANGED',
    ]);
    if (code && CONFLICT_CODES.has(code)) {
      return { text: '该回执已被其他人员处理，已刷新最新状态', refresh: true };
    }
    // 其余（422 金额/原因缺失、403 无权限等）是**本次输入/权限**问题，原样回显、不刷新。
    return { text: code ? `${msg}（${code}）` : msg, refresh: false };
  }

  /** 确认：`is_charged` 决定 payload 里是否带 amount（不收费 → 不带，落 NULL 而非 0.00） */
  async function submitConfirm(values: { amount?: string; note?: string }): Promise<void> {
    const body: Record<string, unknown> = {};
    if (isCharged) {
      const amount = Number(values.amount);
      body.amount = amount;
      // 改了技师报费金额 → 必填说明（后端 MISSING_CONFIRM_NOTE 会兜底，这里提前挡住）
      const changed =
        reportedAmount === null ||
        Math.abs(reportedAmount - amount) > 0.004;
      if (changed) {
        body.note = String(values.note ?? '').trim();
      }
    }
    await doSubmit('confirm', body);
  }

  /** 驳回：只带原因（后端 MISSING_REJECT_REASON 兜底） */
  async function submitReject(values: { reason?: string }): Promise<void> {
    await doSubmit('reject', { reason: String(values.reason ?? '').trim() });
  }

  async function doSubmit(action: 'confirm' | 'reject', body: Record<string, unknown>): Promise<void> {
    setSubmitting(true);
    // ⭐ 一次逻辑操作一个号：与 ticket-actions.tsx 同一套幂等纪律。
    const requestId = newRequestId();
    try {
      // 路径用**斜杠式**（svc/visits/:id/confirm），与门禁脚本、nginx rewrite 同源；
      // 注入的 request 会自己补 `/api`，nginx 再重写成 `svc:visitConfirm?filterByTk=:id`。
      // 幂等号走 `X-Request-Id` 头（服务端 requireRequestId 强制校验 UUID v4）。
      await request(`svc/visits/${visitId}/${action}`, 'post', body, {
        headers: { [REQUEST_ID_HEADER]: requestId },
      });
      message.success(action === 'confirm' ? '确认成功' : '驳回成功');
      setConfirmOpen(false);
      setRejectOpen(false);
      // 成功后**把整页交给父组件重拉**：工单状态、时间线、按钮显隐一起刷新。
      onChanged?.();
    } catch (error) {
      const { text, refresh } = messageForSubmitError(error);
      message.error(text);
      if (refresh) {
        // 409 冲突：关闭模态框并重拉，让门店看到别人已经处理的最新状态。
        setConfirmOpen(false);
        setRejectOpen(false);
        onChanged?.();
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div style={SECTION_TITLE}>技师回执</div>

      {state.loading ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin size="small" />
        </div>
      ) : state.error ? (
        // 只读区块是"锦上添花"，失败**不该**把整个详情遮成一片红；
        // 但仍如实给出地址与原因，不做"加载失败"这种无信息量的兜底文案。
        <div style={{ color: '#cf1322', fontSize: 12, lineHeight: 1.6 }}>{state.error}</div>
      ) : !state.visit ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂时读不到回执内容" />
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>
              第 {visit.visit_no ?? 1} 次上门回执
            </span>
            <Tag color="orange">{confirmText}</Tag>
          </div>
          <div style={{ color: '#8c8c8c', fontSize: 13, marginTop: 6 }}>
            技师提交时间 {formatStamp(visit.submitted_at)}
          </div>

          <Row label="技师">{visit.technician_name ?? '—'}</Row>
          <Row label="服务结果">
            {(SERVICE_RESULT_LABEL as any)[String(visit.service_result ?? '')] ?? '—'}
          </Row>
          <Row label="是否收费">{visit.is_charged ? '是' : '否'}</Row>
          <Row label="技师报费">
            {visit.is_charged ? moneyText(visit.reported_charge_amount) : '不收费'}
          </Row>
          <div style={{ ...ROW, flexDirection: 'column', gap: 4 }}>
            <div style={KEY}>处理说明</div>
            <div style={PARAGRAPH}>{String(visit.service_note ?? '').trim() || '（未填写）'}</div>
          </div>

          <div style={{ fontWeight: 600, margin: '14px 0 8px' }}>服务照片</div>
          {state.photos.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次没有上传照片" />
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {state.photos.map((p) => (
                  <div key={String(p.id)} style={{ width: 150 }}>
                    <PhotoThumb photoId={Number(p.id)} request={request} />
                    <div
                      style={{
                        fontSize: 12,
                        color: '#8c8c8c',
                        marginTop: 4,
                        textAlign: 'center',
                      }}
                    >
                      {(PHOTO_TYPE_LABEL as any)[String(p.photo_type ?? '')] ?? '照片'}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ color: '#bfbfbf', fontSize: 12, marginTop: 6 }}>
                共 {state.photos.length} 张
              </div>
            </>
          )}

          {/* Visit 标识 + 服务端状态：排障时能对上具体是哪条回执 */}
          <div style={{ color: '#bfbfbf', fontSize: 12, marginTop: 10 }}>
            回执标识：Visit ID {String(visit.id ?? '—')} · Visit 编号 {String(visit.visit_no ?? '—')} ·
            回执状态 {visitStatusText(visit.visit_status)} · 工单状态{' '}
            {(TICKET_STATUS_LABEL as any).WAIT_STORE_CONFIRM ?? '待门店确认'}
          </div>

          {/* P6-2：确认 / 驳回两个业务动作。UI 显隐只是 UX，真正的裁决永远在
              服务端（状态机 + 权限 + 金额口径）。409 时这里给出"已被处理"话术并刷新，
              而不是泛泛的"操作失败"。 */}
          <div style={{ marginTop: 16, borderTop: '1px solid #f0f0f0', paddingTop: 12 }}>
            <Space>
              <Button type="primary" onClick={() => setConfirmOpen(true)}>
                确认服务
              </Button>
              <Button danger onClick={() => setRejectOpen(true)}>
                驳回
              </Button>
            </Space>
          </div>
        </>
      )}

      {/* 确认服务模态框：金额按 `is_charged` 决定是否出现（不收费 → 不出现输入框） */}
      <ConfirmModal
        open={confirmOpen}
        isCharged={isCharged}
        reportedAmount={reportedAmount}
        submitting={submitting}
        onCancel={() => setConfirmOpen(false)}
        onSubmit={submitConfirm}
      />

      {/* 驳回模态框：只收一个必填原因 */}
      <RejectModal
        open={rejectOpen}
        submitting={submitting}
        onCancel={() => setRejectOpen(false)}
        onSubmit={submitReject}
      />
    </>
  );
}

/**
 * 确认服务模态框。
 *
 * ⚠️ 金额输入**只在 `isCharged=true` 时出现**（契约 O4 / O5）：不收费时若画一个
 *    "0.00"输入框，会让门店误以为"要填 0 元"或"可以改成收费"—— 那正是用户
 *    P6-2 明确要求避免的。收费时才预填技师报费金额，且改额后**必须填说明**
 *    （§3.3 改额留痕，后端 MISSING_CONFIRM_NOTE 兜底）。
 */
function ConfirmModal(props: {
  open: boolean;
  isCharged: boolean;
  reportedAmount: number | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (values: { amount?: string; note?: string }) => Promise<void>;
}) {
  const { open, isCharged, reportedAmount, submitting, onCancel, onSubmit } = props;
  const [form] = Form.useForm();
  // 是否改了金额：决定"说明"输入框是否出现（改额才要求留痕）
  const amountWatch = Form.useWatch('amount', form);
  const changed =
    isCharged &&
    reportedAmount !== null &&
    amountWatch !== undefined &&
    amountWatch !== '' &&
    Math.abs(reportedAmount - Number(amountWatch)) > 0.004;

  return (
    <Modal
      open={open}
      title="确认服务"
      onCancel={onCancel}
      okText="确认"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={async () => {
        let values: any;
        try {
          values = await form.validateFields();
        } catch {
          return;
        }
        await onSubmit({ amount: values.amount, note: values.note });
      }}
    >
      <div style={{ color: '#595959', fontSize: 13, marginBottom: 12 }}>
        {isCharged ? '本次服务收费，请确认实际收费金额。' : '本次服务不收费。'}
      </div>
      <Form form={form} layout="vertical">
        {isCharged ? (
          <Form.Item
            name="amount"
            label="实际收费金额（元）"
            rules={[
              { required: true, message: '请填写实际收费金额' },
              {
                validator: (_: any, value: any) => {
                  const n = Number(value);
                  if (value !== undefined && value !== '' && (!Number.isFinite(n) || n <= 0)) {
                    return Promise.reject(new Error('金额必须大于 0'));
                  }
                  if (n > CONFIRMED_AMOUNT_MAX) {
                    return Promise.reject(new Error(`金额不得超过 ${CONFIRMED_AMOUNT_MAX}`));
                  }
                  return Promise.resolve();
                },
              },
            ]}
            initialValue={reportedAmount !== null ? String(reportedAmount) : undefined}
          >
            <Input placeholder="请填写实际收费金额" />
          </Form.Item>
        ) : null}
        {changed ? (
          <Form.Item
            name="note"
            label="修改金额说明"
            rules={[{ required: true, message: '调整了金额时请填写说明' }]}
          >
            <Input.TextArea rows={2} placeholder="请说明调整金额的原因" />
          </Form.Item>
        ) : null}
      </Form>
    </Modal>
  );
}

/** 驳回模态框：只收一个必填原因（后端 MISSING_REJECT_REASON 兜底） */
function RejectModal(props: {
  open: boolean;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (values: { reason?: string }) => Promise<void>;
}) {
  const { open, submitting, onCancel, onSubmit } = props;
  const [form] = Form.useForm();
  return (
    <Modal
      open={open}
      title="驳回回执"
      onCancel={onCancel}
      okText="确认驳回"
      cancelText="取消"
      okButtonProps={{ danger: true }}
      confirmLoading={submitting}
      onOk={async () => {
        let values: any;
        try {
          values = await form.validateFields();
        } catch {
          return;
        }
        await onSubmit({ reason: values.reason });
      }}
    >
      <div style={{ color: '#595959', fontSize: 13, marginBottom: 12 }}>
        驳回后本次上门回执标记为「已驳回」，工单回到处理中，由后续派工重新处理。
      </div>
      <Form form={form} layout="vertical">
        <Form.Item
          name="reason"
          label="驳回原因"
          rules={[{ required: true, message: '请填写驳回原因' }]}
        >
          <Input.TextArea rows={3} placeholder="请说明驳回原因（如：服务未完成、照片不符等）" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
