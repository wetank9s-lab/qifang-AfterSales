/**
 * B 页之三：档案详情（阶段时间线 + 照片 + 现场完成/撤回）。
 *
 * ===========================================================================
 * R2.2.1 重做（用户第 7.4 / 第八节 / 第十三节）
 * ===========================================================================
 *   ① 页面标题按类型取「服务档案」/「暖通工程记录」，**档案号移到副标题**
 *      —— 用户第 7.1 条：「档案编号放次要位置」。
 *   ② 「手机号」→「客户手机号」（第 十三 节统一字段名）。
 *   ③ **预约上门日期只在普通上门服务时显示**：暖通各阶段单独记实际日期，
 *      一个"计划上门"会让门店以为"填了就会这天去"。
 *   ④ 接 `QFStageTimeline` + `QFStageCompletePanel` + `QFStageWithdrawPanel`
 *      —— 用户裁决「移动端可现场操作」。服务端三条规则（顺序 / 照片必填 / ≤6 张）
 *      在前端**只呈现不自创**，裁决权永远在服务端。
 *   ⑤ 删除「发布档案（客户可查询）」按钮 —— 保存即发布之后它没有使用场景了。
 *      存量草稿（生产实测 id=26）按用户第 7.4 条要求**不自动发布**，
 *      改由详情页给出**准确说明**而不是一个会误伤存量数据的按钮。
 *
 * ===========================================================================
 * 照片是**私有资源**，只有一种取法
 * ===========================================================================
 *   `<img src="/api/svc:archivePhotoFile?...">` 必然 401（浏览器不带 Bearer 头）。
 *   必须 `fetch(带 token) → blob → objectURL`，见 `api/media.ts` 的 `useSecurePhoto`，
 *   并且 objectURL 用完必须 revoke（否则翻十张图后开始卡）。
 *
 * ===========================================================================
 * 暖通阶段为什么必须"按顺序"
 * ===========================================================================
 *   服务端 `ARCHIVE_STAGE_ORDER` 六阶段是**业务规则本身**。前端显示的 done/pending
 *   全部来自服务端，这里不推断"跳过某个阶段"。
 */

import { useCallback, useEffect, useState } from 'react';
import { AppShell, PageHeader } from '../components/AppShell';
import { StickyActionBar } from '../components/AppShell';
import { useToast } from '../components/Feedback';
import {
  QFButton,
  QFErrorState,
  QFInfoRow,
  QFListSection,
  QFLoadingSkeleton,
  QFPhotoGrid,
  QFStageCompletePanel,
  QFStageTimeline,
  QFStageWithdrawPanel,
  QFStatusBadge,
  describeQFError,
} from '../components/qf';
import {
  ArchiveApiAdapter,
  type ArchivePhotoRow,
  type ArchiveRow,
  type ArchiveStageRow,
} from '../api/archives';
import {
  ARCHIVE_STATUS_META,
  ARCHIVE_TYPE_META,
  metaOf,
  serviceTypeLabel,
} from '../design/qf-tokens';
import { ApiError, newRequestId } from '../api/http';
import { navigate } from '../router';
import { useSession } from '../app/session-context';

/** 当前打开的面板：完成某阶段 / 撤回某阶段 */
type Panel = { kind: 'complete' | 'withdraw'; stageId: number } | null;

export function ArchiveDetailPage({ id }: { id: string }) {
  const { caps } = useSession();
  const toast = useToast();
  const [row, setRow] = useState<ArchiveRow | null>(null);
  const [stages, setStages] = useState<ArchiveStageRow[]>([]);
  const [photos, setPhotos] = useState<ArchivePhotoRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [photoStage, setPhotoStage] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 🔴 DEV-272：阶段**不能**和主数据并行发。
      // 并行时还不知道 archive_type，只能对每个档案都问一次阶段；
      // 普通上门服务档案根本没有阶段，服务端就报了 500 `ARCHIVE_STAGE_ROWS_BROKEN`。
      // ⇒ 先拿主数据，确认是 hvac 再拉阶段与照片；
      //    `archive_type` 未知时**不发**阶段请求（宁可不显示，也不制造错误日志）。
      const r = await ArchiveApiAdapter.get(id);
      setRow(r);

      const isHvac = String(r?.archive_type ?? '') === 'hvac';
      if (!isHvac) {
        const ph = await ArchiveApiAdapter.photos(id).catch(() => [] as ArchivePhotoRow[]);
        setStages([]);
        setPhotos(ph);
        return;
      }

      const [st, ph] = await Promise.all([
        ArchiveApiAdapter.stages(id).catch(() => [] as ArchiveStageRow[]),
        ArchiveApiAdapter.photos(id).catch(() => [] as ArchivePhotoRow[]),
      ]);
      setStages(st);
      setPhotos(ph);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 完成阶段。
   *
   * ⚠️ 成功后**必须重新拉阶段**：`photo_count`、`version`、`status` 都变了。
   *    只改本地 state 会让下一次提交带着旧的 `expected_version` ⇒ 409。
   */
  const onCompleteStage = async (stage: ArchiveStageRow, input: { stage_date: string; note: string }) => {
    setBusy(true);
    try {
      await ArchiveApiAdapter.completeStage(
        id,
        stage.stage_code,
        { stage_date: input.stage_date, note: input.note || null, expected_version: stage.version ?? 0 },
        newRequestId(),
      );
      setPanel(null);
      toast.show('阶段已完成');
      await load();
    } catch (e) {
      toast.show(describeQFError(e).message, 'danger');
      // ⚠️ 失败**不关面板**：用户填的日期和说明还在，关掉就得重填
    } finally {
      setBusy(false);
    }
  };

  const onWithdrawStage = async (stage: ArchiveStageRow, reason: string) => {
    setBusy(true);
    try {
      await ArchiveApiAdapter.withdrawStage(
        id,
        stage.stage_code,
        { reason, expected_version: stage.version ?? 0 },
        newRequestId(),
      );
      setPanel(null);
      setPhotoStage(null);
      toast.show('阶段已撤回');
      await load();
    } catch (e) {
      toast.show(describeQFError(e).message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  const isHvac = String(row?.archive_type ?? '') === 'hvac';
  const typeLabel = isHvac ? '暖通工程记录' : '服务档案';

  if (loading) {
    return (
      <AppShell>
        <PageHeader title="服务档案" back />
        <QFLoadingSkeleton rows={3} label="正在加载档案" />
      </AppShell>
    );
  }

  if (error) {
    return (
      <AppShell>
        <PageHeader title="服务档案" back />
        <QFErrorState
          info={describeQFError(error)}
          onRetry={() => void load()}
          onBack={() => navigate('/archives')}
          testId="archive-detail-error"
        />
      </AppShell>
    );
  }

  if (!row) {
    return (
      <AppShell>
        <PageHeader title="服务档案" back />
        <QFErrorState
          info={describeQFError(new ApiError(404, 'ARCHIVE_NOT_FOUND', '档案不存在或已被移除'))}
          onBack={() => navigate('/archives')}
        />
      </AppShell>
    );
  }

  const type = ARCHIVE_TYPE_META[String(row.archive_type ?? '')];
  const status = metaOf(ARCHIVE_STATUS_META, row.status, 'neutral');
  const shown = photoStage ? photos.filter((p) => p.stage_code === photoStage) : photos;

  const panelStage = panel ? stages.find((s) => s.id === panel.stageId) ?? null : null;
  /**
   * 能否现场操作阶段。
   *
   * ⚠️ 判据是 `caps.archiveCreate`（建档权限）—— 服务端的写权限集合
   *    `ARCHIVE_WRITE_ROLES` 当前只有 `store_sales`，与建档是同一个角色。
   *    这里不复刻角色名，只看能力位；真正的裁决仍在服务端（403）。
   */
  const canOperate = Boolean(caps.archiveCreate);

  return (
    <AppShell>
      {toast.node}
      <PageHeader title={typeLabel} subtitle={row.archive_no || `#${row.id}`} back />

      {/* 客户 / 概要 */}
      <QFListSection>
        <div className="px-4 pt-3 pb-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              {/*
                ⚠️ 客户姓名缺失时**不印 '—'**：一张写着「—」的档案头无法回答
                   "这是谁的档案"，而"（未填客户）"说明了**是什么情况**。
              */}
              <div className="text-svc-ink qf-title truncate font-semibold">
                {row.customer_name || '（未填客户）'}
              </div>
              {row.service_address ? (
                <div className="text-svc-ink-2 qf-foot mt-0.5 leading-relaxed">{row.service_address}</div>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <QFStatusBadge label={status.label} tone={status.tone} />
              {/*
                ⚠️ R2.2.1：只显示**作废**（客户再也看不到这条了，必须让人知道）。
                   「已发布」是恒态（保存即发布），显示它等于每页都写一句废话；
                   存量「草稿」按用户 7.4 要求**不自动发布**，所以仍然要显示，
                   并在下面对客户可见性给一句准确说明。
              */}
              {row.visibility === 'voided' ? <QFStatusBadge label="已作废" tone="danger" dot={false} /> : null}
              {row.visibility === 'draft' ? <QFStatusBadge label="草稿" tone="neutral" /> : null}
            </div>
          </div>
        </div>

        {row.visibility === 'draft' ? (
          <div className="bg-svc-warning-soft px-4 py-2.5">
            <div className="text-svc-warning qf-foot leading-relaxed">
              这条档案还没发布，客户查不到。它是本轮改版之前留下的草稿 ——
              如需让客户看到，请联系总部管理员处理。
            </div>
          </div>
        ) : null}

        <div className="border-svc-line border-t">
          {row.customer_mobile ? <QFInfoLine k="客户手机号" v={maskMobile(row.customer_mobile)} /> : null}
          {row.product_description ? <QFInfoLine k="产品 / 型号" v={row.product_description} /> : null}
          {row.service_type ? <QFInfoLine k="服务内容" v={serviceTypeLabel(row.service_type)} /> : null}
          {/*
            ⚠️ 用户第 7.3 / 第八节：**暖通不显示计划上门日期**。
               判据是 `archive_type === 'service'`，不是"字段有没有值"——
               历史暖通档案里可能残留这个字段，用它判会漏。
          */}
          {row.planned_date && row.archive_type === 'service' ? (
            <QFInfoLine k="预约上门日期" v={row.planned_date} />
          ) : null}
          {row.purchase_date ? <QFInfoLine k="购买日期" v={row.purchase_date} /> : null}
          {row.completed_at ? <QFInfoLine k="完成时间" v={absTime(row.completed_at)} /> : null}
          <QFInfoLine k="建档时间" v={absTime(row.created_at)} />
        </div>
      </QFListSection>

      {/* 品牌 / 类型说明（一行，不抢视线） */}
      <div className="text-svc-ink-3 qf-foot px-5 pt-2">{type?.desc}</div>

      {/* 暖通：施工阶段 */}
      {isHvac && stages.length > 0 ? (
        <QFListSection title="施工阶段" testId="archive-stages">
          <div className="px-4 py-3">
            <QFStageTimeline
              stages={stages}
              canOperate={canOperate}
              activeStage={photoStage}
              onViewPhotos={(s) => setPhotoStage((cur) => (cur === s.stage_code ? null : s.stage_code))}
              onAction={(s, action) => {
                if (!action) return;
                setPanel({ kind: action, stageId: s.id });
              }}
            />
          </div>
        </QFListSection>
      ) : null}

      {/* 阶段操作面板（完成 / 撤回） */}
      {panel && panelStage ? (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40" role="dialog" aria-modal="true">
          <button type="button" aria-label="关闭" className="flex-1" onClick={() => setPanel(null)} />
          {/*
            ⚠️ 面板用白底 + 上方圆角，**不用毛玻璃**（用户明令禁止）。
               内容可滚动：师傅手机小屏上，照片区 + 日期 + 说明 + 按钮可能超一屏。
          */}
          <div className="bg-svc-bg max-h-[88vh] overflow-y-auto rounded-t-svc-xl pb-2">
            <div className="sticky top-0 z-10 flex items-center justify-between bg-svc-bg px-4 pt-3 pb-1">
              <span className="text-svc-ink qf-foot font-medium">
                {panel.kind === 'complete' ? '完成阶段' : '撤回阶段'}
              </span>
              <button
                type="button"
                onClick={() => setPanel(null)}
                className="text-svc-brand-text qf-foot qf-pressable inline-flex min-h-touch min-w-touch items-center justify-center px-2 font-medium"
              >
                关闭
              </button>
            </div>

            {panel.kind === 'complete' ? (
              <QFStageCompletePanel
                key={`c-${panelStage.id}-${panelStage.version ?? 0}`}
                stage={panelStage}
                archiveId={id}
                busy={busy}
                onUploaded={() => load()}
                onSubmit={(input) => void onCompleteStage(panelStage, input)}
                onCancel={() => setPanel(null)}
              />
            ) : (
              <QFStageWithdrawPanel
                key={`w-${panelStage.id}`}
                stage={panelStage}
                stages={stages}
                busy={busy}
                onSubmit={(reason) => void onWithdrawStage(panelStage, reason)}
                onCancel={() => setPanel(null)}
              />
            )}
          </div>
        </div>
      ) : null}

      {/* 照片 */}
      <QFListSection
        title="现场照片"
        testId="archive-photos"
        footnote={photoStage ? `只看「${stageName(photoStage)}」的照片` : undefined}
      >
        <div className="px-3 py-3">
          {photoStage ? (
            <div className="mb-2 flex justify-end px-1">
              <button
                type="button"
                onClick={() => setPhotoStage(null)}
                className="text-svc-brand-text qf-foot qf-pressable inline-flex min-h-touch min-w-touch items-center justify-center px-2 font-medium"
                data-testid="photos-show-all"
              >
                显示全部
              </button>
            </div>
          ) : null}
          <QFPhotoGrid photos={shown} columns={3} />
        </div>
      </QFListSection>

      {/* 底部主操作：改派/编辑属于后续阶段，这里只留一条回列表的出口 */}
      <div className="h-20" />
      <StickyActionBar>
        <div className="flex-1">
          <QFButton variant="secondary" block onClick={() => navigate('/archives')} testId="archive-back-list">
            返回档案列表
          </QFButton>
        </div>
      </StickyActionBar>
    </AppShell>
  );
}

/* ------------------------------------------------------------------ 局部件 */

/**
 * 一行信息（标签左、值右）。
 *
 * ⚠️ 不自己实现左右两列，直接用 `QFInfoRow`（标签在上、值在下）。
 *    中文标签「客户手机号」在 390px 下与 11 位号码 + 标签共处一行会很挤，
 *    标签在上是 iOS 详情页处理"长标签"的常见做法，也免得每个页面各写一套列宽
 *    （用户第 十四 节：不得在不同页面重复编写同一套样式）。
 */
function QFInfoLine({ k, v }: { k: string; v: string }) {
  return <QFInfoRow label={k} value={v} />;
}

function stageName(code: string): string {
  const map: Record<string, string> = {
    survey: '现场勘察',
    plan: '方案确认',
    pipe: '管路施工',
    device: '设备安装',
    test: '调试运行',
    accept: '客户验收',
  };
  return map[code] ?? code;
}

/** 手机号掩码（防肩窥：门店柜台是公共场景） */
function maskMobile(m: string | null | undefined): string {
  const s = String(m ?? '').replace(/\s/g, '');
  if (s.length < 7) return s ? '***' : '';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/** 绝对时间（详情页用；列表用 MM-DD） */
function absTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
