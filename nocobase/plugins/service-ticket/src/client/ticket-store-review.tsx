/**
 * P6-0 —— 门店回执**只读**区块（`docs/PHASE-6.md` §6.3）
 * =============================================================================
 *
 * 这个文件存在的理由：P6-0 的命题**不是**"后端权限函数看起来正确"，而是
 * **"门店真的能够安全看到自己即将审核的技师回执和照片"**。所以除了 I11 / I14
 * 两个端点，还必须有一条**很薄的只读链路**把这件事走通。
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
 * ⚠️⚠️ 严格的"不做"清单（P6-0 阶段冻结，违反即越界）：
 *   · **没有**确认按钮、**没有**驳回按钮 —— 那是 P6-1（I12/I13，M9/M10 事务）；
 *   · **没有**金额修改输入框 —— 同理；
 *   · 不渲染任何 `<form>`、不发任何写请求。本文件**只 GET**。
 *   为什么要把它写成硬约束：审核 UI 一旦先于授权落地，就会出现
 *   "按钮在、但服务端还没实现写事务"的中间态 —— 那是把状态机的一致性
 *   押在"用户不会点"上。见 `docs/PHASE-6.md` §6.3 的末段。
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
import { Empty, Spin, Tag } from 'antd';

import {
  PHOTO_TYPE_LABEL,
  SERVICE_RESULT_LABEL,
  STORE_CONFIRM_STATUS,
  TICKET_STATUS_LABEL,
} from '../server/constants';
import { formatStamp, serviceModeText, visitStatusText } from './ticket-display';

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
export function StoreReviewSection({ visitId, request }: StoreReviewSectionProps) {
  const [state, setState] = useState<ReviewState>({
    loading: true,
    error: null,
    visit: null,
    photos: [],
  });

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

          <div
            style={{
              marginTop: 12,
              padding: '8px 10px',
              background: '#fffbe6',
              border: '1px solid #ffe58f',
              borderRadius: 6,
              fontSize: 12,
              color: '#874d00',
            }}
          >
            本区块仅用于查看技师回执与照片（只读）。确认 / 驳回将在下一阶段开放。
          </div>
        </>
      )}
    </>
  );
}
