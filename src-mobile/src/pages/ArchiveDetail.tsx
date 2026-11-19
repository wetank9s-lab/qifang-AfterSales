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
 *   ④ 接 `QFStageTimeline` + `QFStagePanel`（完成 / 修改两模式）
 *      —— 用户裁决「移动端可现场操作」。服务端三条规则（顺序 / 照片必填 / ≤6 张）
 *      在前端**只呈现不自创**，裁决权永远在服务端。
 *
 *   ⑥ R2.2.1 §七（本轮业务重点）：已完成阶段的主操作由「撤回」改为「修改」。
 *      走 `svc:archiveStageUpdate` —— 只改 stage_date / note，状态保持 done，
 *      后续阶段**不连带撤回**，照片**保持发布**。撤回接口仍保留在服务端，
 *      但移动端时间线不再把它当作主操作（用户原文：「主操作统一『修改』」）。
 *   ⑦ 阶段名来自后台配置（`svc:archiveStageConfigGet`），改配置**不需要重建移动端**；
 *      代码常量 `HVAC_STAGE_META` 只作接口失败时的降级值。
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
  QFStagePanel,
  QFStageTimeline,
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
  HVAC_STAGE_META,
  metaOf,
  serviceTypeLabel,
} from '../design/qf-tokens';
import { fetchStageConfig } from '../api/stage-config';
import { ApiError, newRequestId } from '../api/http';
import { navigate } from '../router';
import { useSession } from '../app/session-context';

/**
 * 当前打开的面板。
 *
 * 🔴 R2.2.1 §七：`'update'` 取代了 `'withdraw'`。
 *    已完成阶段的主操作是「修改」（`svc:archiveStageUpdate`：只改日期/备注/照片，
 *    状态保持 done、后续阶段不受影响），**不是**撤回。
 *    把"修改"接到 `archiveStageWithdraw` 上 → 员工改个备注，后面三个已完成阶段
 *    会一起退回未开始，客户看到的进度当场倒退。
 */
type Panel = { kind: 'complete' | 'update'; stageId: number } | null;

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
  /** 阶段显示名（后台配置）；失败时保持 `HVAC_STAGE_META` 的代码默认名 */
  const [stageNames, setStageNames] = useState<Record<string, string>>({});

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

      const st = await ArchiveApiAdapter.stages(id).catch(() => [] as ArchiveStageRow[]);
      // ⚠️ 照片与阶段**有先后依赖**：服务端投影只给 `stage_id`，
      //    `stage_code` 要靠阶段表映射（见 `ArchiveApiAdapter.photos` 注释）。
      //    所以这里不能 Promise.all —— 拿不到阶段就会把照片全判成"无归属"，
      //    界面表现是「现场照片 0/6」而库里明明有照片。
      const ph = await ArchiveApiAdapter.photos(
        id,
        st.map((s) => ({ id: Number(s.id), stage_code: String(s.stage_code) })),
      ).catch(() => [] as ArchivePhotoRow[]);
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
   * 阶段显示名：**与档案数据分开加载**。
   *
   * ⚠️ 为什么不并进 `load()`：配置是全局的（不属于任何门店/档案），
   *    并发进档案加载会把"配置读失败"变成"档案加载失败"——
   *    而档案的日期、照片、完成状态才是业务事实，不该被一个装饰性配置拖下水。
   *    配置读失败时 `stageNames` 保持空，时间线自动回退代码默认名。
   */
  useEffect(() => {
    let alive = true;
    void fetchStageConfig().then((r) => {
      if (!alive) return;
      const map: Record<string, string> = {};
      for (const s of r.stages) map[s.code] = s.name;
      setStageNames(map);
    });
    return () => {
      alive = false;
    };
  }, []);

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

  /**
   * 修改已完成阶段的内容（§七）。
   *
   * 🔴 走 `archiveStageUpdate`，**不是** withdraw：
   *    服务层只写 `stage_date` / `note`（+ version/updated_at），
   *    `status` 进 WHERE 当乐观锁而不被写 —— 所以完成后仍是完成，
   *    后续阶段状态、照片发布状态、档案 status 一律不动。
   *
   * ⚠️ 成功后**必须重新拉**：`version` 变了，不重拉下一次提交必然 409。
   */
  const onUpdateStage = async (stage: ArchiveStageRow, input: { stage_date: string; note: string }) => {
    setBusy(true);
    try {
      await ArchiveApiAdapter.updateStage(
        id,
        stage.stage_code,
        { stage_date: input.stage_date, note: input.note || null, expected_version: stage.version ?? 0 },
        newRequestId(),
      );
      setPanel(null);
      toast.show('修改已保存');
      await load();
    } catch (e) {
      // ⚠️ 失败**不关面板**：用户填的日期和备注还在，关掉就得重填
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
              stageNames={stageNames}
              onViewPhotos={(s) => setPhotoStage((cur) => (cur === s.stage_code ? null : s.stage_code))}
              onAction={(s, action) => {
                if (!action) return;
                setPanel({ kind: action, stageId: s.id });
              }}
            />
          </div>
        </QFListSection>
      ) : null}

      {/* 阶段面板（完成 / 修改）—— §七：主操作统一「修改」，不再有「撤回」入口 */}
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
                {panel.kind === 'complete' ? '完成阶段' : '修改阶段'}
              </span>
              <button
                type="button"
                onClick={() => setPanel(null)}
                className="text-svc-brand-text qf-foot qf-pressable inline-flex min-h-touch min-w-touch items-center justify-center px-2 font-medium"
              >
                关闭
              </button>
            </div>

            {/*
              ⚠️ 两种模式共用一个组件（`QFStagePanel`），只切 `mode`：
                  · 完成 → `archiveStageComplete`（会改 status、校验照片/顺序）
                  · 修改 → `archiveStageUpdate`（只改日期/备注，状态与后续阶段不动）
                拆成两个组件会让照片区各写一套，而旧版正是这样把照片逻辑丢在了
                撤回面板外面。`key` 里带 `version`：提交成功后 version 变化，
                面板会重新挂载并拿到最新的日期/备注，而不是停在旧值上。
            */}
            <QFStagePanel
              key={`${panel.kind}-${panelStage.id}-${panelStage.version ?? 0}`}
              mode={panel.kind}
              stage={panelStage}
              archiveId={id}
              photos={photos}
              busy={busy}
              // 面板标题必须与时间线用同一份显示名（后台可改），否则一处新一处旧
              stageName={
                String(stageNames?.[panelStage.stage_code] ?? '').trim() ||
                HVAC_STAGE_META[panelStage.stage_code]?.label
              }
              onUploaded={() => load()}
              onSubmit={(input) =>
                panel.kind === 'complete'
                  ? void onCompleteStage(panelStage, input)
                  : void onUpdateStage(panelStage, input)
              }
              onCancel={() => setPanel(null)}
            />
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

/**
 * 阶段显示名（照片区脚注用）。
 *
 * ⚠️ 这里刻意**不再维护一份本地 map** —— 旧实现把六个名字抄在这个文件里，
 *    于是后台改了配置，时间线用新名字、照片区脚注还用旧名字，
 *    同一屏出现两个叫法。现在统一取自 `HVAC_STAGE_META`（代码默认），
 *    真名由 `QFStageTimeline`/`QFStagePanel` 从配置读。
 */
function stageName(code: string): string {
  return HVAC_STAGE_META[code]?.label ?? code;
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
