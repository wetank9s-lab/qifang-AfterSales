/**
 * 暖通工程阶段：纵向进度线 + 照片上传 + 现场完成/撤回。
 *
 * ===========================================================================
 * 用户裁决（本轮 AskUserQuestion）：**移动端可现场操作**
 * ===========================================================================
 *   用户第 八 节写"当前阶段蓝色操作入口"，且要求"关键阶段仍要求照片""每阶段上限 6 张"
 *   "阶段必须按顺序完成""撤回连锁规则保持不变" —— 这些都是**写操作**。
 *   实测确认：师傅在现场是拿着手机干活的，让他"先拍照、回门店再用电脑后台点完成"
 *   等于把一条最自然的流程切成两半。⇒ 本轮做移动端现场操作。
 *
 * ===========================================================================
 * 三条服务端规则，前端**只呈现、不自创**
 * ===========================================================================
 *   ① 顺序：前一阶段未 done ⇒ 当前阶段不可完成（服务端 409 `ARCHIVE_STAGE_PRIOR_PENDING`）
 *   ② 照片：`survey/pipe/device/accept` 必须 ≥1 张（服务端 `ARCHIVE_STAGE_PHOTO_REQUIRED`）
 *   ③ 上限：每阶段 ≤6 张（服务端 `ARCHIVE_STAGE_PHOTO_MAX`）
 *
 *   ⚠️ 前端**不**复制这三条的业务判断逻辑来判断"能不能点"：
 *      能不能点只看服务端给的 `photo_required` / `photo_max` 与 `status`，
 *      真正的裁决永远在服务端。前端做提前提示，是为了少一次"填完被拒"。
 *      （同族教训：把业务规则写两份，必然有一份先漂，而漂的那份没人测。）
 *
 *   ⚠️ 但有一件事前端**必须自己算**：`expected_version`。
 *      它是乐观锁，来自当前阶段行；不传 ⇒ 409 `ARCHIVE_STAGE_STALE`。
 *      所以每次打开面板都要用**最新拉到的** stage 行，不能用页面挂载时的快照。
 *
 * ===========================================================================
 * 照片为什么必须先上传、后完成
 * ===========================================================================
 *   服务端 `completeStage` 会用"本阶段照片数"做校验。若先完成再补照片，
 *   关键阶段会直接 409。⇒ 面板的顺序固定为：**先传照片 → 再点完成**。
 *   界面上要把这个顺序表达出来（照片区在按钮上方，未满足时按钮禁用并说明原因）。
 */

import { useState } from 'react';
import { QFButton } from './primitives';
import { QFStatusBadge } from './primitives';
import { QFPhotoUploader } from './photo-uploader';
import {
  HVAC_STAGE_META,
  HVAC_STAGE_ORDER,
  type Tone,
} from '../../design/qf-tokens';
import type { ArchiveStageRow } from '../../api/archives';
/**
 * ⚠️ `HVAC_STAGE_ORDER` 在 qf-tokens 里是 `as const` 的只读元组，
 *    `indexOf(string)` 会报类型不匹配。这里统一转成 `readonly string[]` 再查 ——
 *    比 `as any` 强：仍然保留了"只可能是这六个"的含义。
 */
const ORDER: readonly string[] = HVAC_STAGE_ORDER;

/* ----------------------------------------------------------- 阶段时间线 */

/**
 * 阶段状态 → 展示。
 *
 * ⚠️ 已完成用**绿色**、当前阶段用**蓝色**、未开始**弱化** —— 用户第 八 节原文。
 *    三种状态除了颜色还有形状差异（实心勾 / 空心圈 / 灰点）：
 *    只靠颜色区分状态对色弱用户不可用，在户外强光下也不可靠。
 */
type StageVisual = { ring: string; dot: string; text: string; line: string };

function visualOf(kind: 'done' | 'active' | 'todo' | 'withdrawn'): StageVisual {
  switch (kind) {
    case 'done':
      return {
        ring: 'bg-svc-success text-white border-svc-success',
        dot: 'bg-svc-success',
        text: 'text-svc-ink',
        line: 'bg-svc-success',
      };
    case 'active':
      return {
        ring: 'bg-svc-surface text-svc-brand border-svc-brand',
        dot: 'bg-svc-brand',
        text: 'text-svc-ink',
        line: 'bg-svc-line',
      };
    case 'withdrawn':
      return {
        ring: 'bg-svc-warning-soft text-svc-warning border-svc-warning',
        dot: 'bg-svc-warning',
        text: 'text-svc-ink-2',
        line: 'bg-svc-line',
      };
    default:
      return {
        ring: 'bg-svc-surface-2 text-svc-ink-3 border-svc-line',
        dot: 'bg-svc-line-strong',
        text: 'text-svc-ink-3',
        line: 'bg-svc-line',
      };
  }
}

export interface QFStageTimelineProps {
  stages: ArchiveStageRow[];
  /** 有写权限时才显示操作入口（只读角色只看到信息） */
  canOperate?: boolean;
  /** 点击操作入口。`null` = 该阶段当前没有可执行的动作 */
  onAction?: (stage: ArchiveStageRow, action: 'complete' | 'withdraw' | null) => void;
  /** 点"看照片" */
  onViewPhotos?: (stage: ArchiveStageRow) => void;
  /** 当前展开照片筛选的阶段 code */
  activeStage?: string | null;
}

/**
 * 六阶段纵向进度线。
 *
 * ⚠️ 顺序用 `HVAC_STAGE_ORDER`（与服务端 `ARCHIVE_STAGE_ORDER` 同源），
 *    **不按返回数组的下标**排 —— 服务端某天换了排序，下标就会错位，
 *    而错位后的界面"看起来完全正常"（只是第 3 步显示成第 4 步）。
 *    正确做法：以 code 为键排序；服务端少给某个阶段时**补一个占位行**，
 *    而不是让列表变短（变短会让员工以为"这个工程只有 5 个阶段"）。
 */
export function QFStageTimeline({
  stages,
  canOperate,
  onAction,
  onViewPhotos,
  activeStage,
}: QFStageTimelineProps) {
  const byCode = new Map(stages.map((s) => [s.stage_code, s]));

  /** 当前该做哪个阶段 = 第一个未 done 的（顺序表口径） */
  const firstUndone = ORDER.find((c) => byCode.get(c)?.status !== 'done');

  return (
    <ol className="relative" data-testid="qf-stage-timeline">
      {ORDER.map((code, i) => {
        const s = byCode.get(code);
        const meta = HVAC_STAGE_META[code];
        const status = s?.status ?? 'pending';
        const done = status === 'done';
        const withdrawn = status === 'withdrawn';
        const isActive = !done && code === firstUndone;
        const kind = done ? 'done' : withdrawn ? 'withdrawn' : isActive ? 'active' : 'todo';
        const v = visualOf(kind);
        const isLast = i === ORDER.length - 1;

        /** 该阶段可执行的动作：已完成 ⇒ 撤回；当前阶段 ⇒ 完成 */
        const action: 'complete' | 'withdraw' | null = done ? 'withdraw' : isActive ? 'complete' : null;
        const showAction = Boolean(canOperate && action && s && onAction);

        return (
          <li key={code} className="relative flex gap-3 pb-4 last:pb-0" data-testid={`stage-${code}`}>
            {/* 纵向连接线（最后一条不画） */}
            {!isLast ? (
              <span
                className={`absolute top-7 left-[13px] w-0.5 ${v.line}`}
                style={{ height: 'calc(100% - 1.75rem)' }}
                aria-hidden="true"
              />
            ) : null}

            {/* 序号 / 勾 */}
            <span
              className={`relative z-[1] flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 ${v.ring}`}
              aria-hidden="true"
            >
              {done ? <CheckGlyph /> : withdrawn ? <UndoGlyph /> : <span className="qf-caption tabular font-semibold">{i + 1}</span>}
            </span>

            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className={`qf-body font-medium ${done ? 'text-svc-ink' : isActive ? 'text-svc-ink' : 'text-svc-ink-2'}`}>
                    {meta?.label ?? code}
                  </div>
                  <div className="text-svc-ink-3 qf-foot mt-0.5">
                    {done
                      ? `${formatDay(s?.completed_at ?? s?.stage_date ?? s?.done_at)} 完成`
                      : withdrawn
                        ? '已撤回'
                        : isActive
                          ? '当前阶段'
                          : '未开始'}
                    {s && s.photo_count > 0 ? ` · ${s.photo_count} 张照片` : ''}
                  </div>

                  {/*
                   * 🔴 阶段说明必须显示在时间线上。
                   *
                   * 2026-11-19 R2.2.1 端到端验收抓到：员工在手机上写完
                   * 「客厅与主卧已布管，打压 24 小时保压合格」，保存成功、刷新后
                   * 服务端也**确实下发了** `note`（`archive-stage-service.ts:408`
                   * `note: s.note`），但时间线上一个字都不显示 ——
                   * 因为这里从来没渲染过它。
                   *
                   * 这是那种「不会报错、接口 200、数据也存住了」的缺陷：
                   * 唯一的症状是员工回到现场想再看一眼自己写了什么，却看不到，
                   * 于是只能重写一遍或者干脆不写。验收时只有"刷新后再读页面"
                   * 才能发现它 —— 只查库会得到"一切正常"。
                   *
                   * 只对**已完成**的阶段显示：未开始的阶段 note 恒为 null，
                   * 撤回的阶段保留原文（撤回原因在 `withdraw_reason`，另处展示）。
                   */}
                  {done && s?.note ? (
                    <div className="text-svc-ink-2 qf-foot mt-1 leading-relaxed break-words" data-testid={`stage-note-${code}`}>
                      {s.note}
                    </div>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {s && s.photo_count > 0 && onViewPhotos ? (
                    <button
                      type="button"
                      onClick={() => onViewPhotos(s)}
                      /*
                       * ⚠️ `min-w-touch` 不能省：这类"行内文字按钮"的内容只有两个字，
                       *    宽度 = 文字宽 + px-2 = 42px。高度够 44 不代表**面积**够 ——
                       *    42×44 仍是"窄于 44 的靶子"，而 HIG 的 44pt 是**两个方向**的下限
                       *    （`accessibility.md › Touch targets`）。
                       *    加 `justify-center` 让 44 宽度里文字仍然居中，
                       *    视觉上看不出任何变化，命中区实实在在变宽了。
                       */
                      className="text-svc-brand-text qf-foot qf-pressable inline-flex min-h-touch min-w-touch items-center justify-center px-2 font-medium"
                      data-testid={`stage-photos-${code}`}
                    >
                      {activeStage === code ? '全部' : '照片'}
                    </button>
                  ) : null}
                  {showAction ? (
                    <button
                      type="button"
                      onClick={() => onAction!(s!, action)}
                      /* 同上：`min-w-touch` 保证「撤回 / 完成」也是 44×44 的靶子 */
                      className={`qf-foot qf-pressable inline-flex min-h-touch min-w-touch items-center justify-center px-2 font-semibold ${
                        action === 'withdraw' ? 'text-svc-warning' : 'text-svc-brand-text'
                      }`}
                      data-testid={`stage-action-${code}`}
                    >
                      {action === 'withdraw' ? '撤回' : '完成'}
                    </button>
                  ) : null}
                </div>
              </div>

              {/* 撤回原因：不显示的话，员工会以为"做完了又变没做" */}
              {withdrawn && s?.withdraw_reason ? (
                <div className="bg-svc-warning-soft text-svc-warning qf-foot mt-1.5 rounded-svc-sm px-2.5 py-1.5 leading-relaxed">
                  撤回原因：{s.withdraw_reason}
                </div>
              ) : null}

              {/* 说明：只在未完成的阶段显示，避免已完成的步骤占屏 */}
              {!done && meta?.hint ? (
                <div className="text-svc-ink-3 qf-caption mt-1 leading-relaxed">{meta.hint}</div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* --------------------------------------------------------- 完成阶段面板 */

/**
 * 完成阶段的表单（**照片区 + 日期 + 说明 + 提交**）。
 *
 * ⚠️ 顺序表达：照片区在上、按钮在下。关键阶段没照片时按钮**禁用并说明原因**，
 *    而不是让用户点了才被 409 拒。
 *
 * ⚠️ 提交成功/失败都**不关闭面板**：失败时用户填的日期和说明还在，
 *    关掉就得重填（那是最令人恼火的一类交互）。
 */
export function QFStageCompletePanel({
  stage,
  archiveId,
  busy,
  onUploaded,
  onSubmit,
  onCancel,
}: {
  stage: ArchiveStageRow;
  archiveId: number | string;
  busy: boolean;
  /** 上传成功后回调（让父级刷新阶段与照片） */
  onUploaded: () => void | Promise<void>;
  onSubmit: (input: { stage_date: string; note: string }) => void;
  onCancel: () => void;
}) {
  const meta = HVAC_STAGE_META[stage.stage_code];
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(stage.stage_date ?? today);
  const [note, setNote] = useState(stage.note ?? '');
  const [localErr, setLocalErr] = useState<string | null>(null);

  const need = stage.photo_required ?? false;
  const max = stage.photo_max ?? 6;
  const hasPhoto = stage.photo_count > 0;
  const photoOk = !need || hasPhoto;

  return (
    <div className="px-4 pt-3" data-testid="stage-complete-panel">
      <div className="qf-section">
        <div className="px-4 py-3">
          <div className="text-svc-ink qf-body font-medium">完成「{meta?.label ?? stage.stage_code}」</div>
          <div className="text-svc-ink-3 qf-foot mt-0.5 leading-relaxed">{meta?.hint}</div>
        </div>

        {/* 照片区 */}
        <div className="px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-svc-ink-2 qf-sub">
              现场照片
              {need ? <span className="text-svc-danger ml-0.5">*</span> : null}
            </span>
            <span className="text-svc-ink-3 qf-caption tabular">
              {stage.photo_count} / {max}
            </span>
          </div>
          <QFPhotoUploader
            archiveId={archiveId}
            stageId={stage.id}
            photoCount={stage.photo_count}
            photoMax={max}
            onUploaded={onUploaded}
            testId={`stage-uploader-${stage.stage_code}`}
          />
          {need && !hasPhoto ? (
            <div className="text-svc-warning qf-foot mt-2" role="status">
              这个阶段必须至少上传 1 张现场照片才能完成。
            </div>
          ) : null}
        </div>

        {/* 日期 */}
        <div className="px-4 py-3">
          <label className="qf-field-label" htmlFor="stage-date">
            实际完成日期<span className="text-svc-danger ml-0.5">*</span>
          </label>
          <input
            id="stage-date"
            type="date"
            className="qf-input"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            data-testid="stage-date"
          />
          {/* ⚠️ 允许补录过去日期（师傅常常当天干完、第二天才补），但不允许填未来 */}
          {date > today ? <div className="text-svc-danger qf-foot mt-1">完成日期不能晚于今天。</div> : null}
        </div>

        {/* 说明 */}
        <div className="px-4 py-3">
          <label className="qf-field-label" htmlFor="stage-note">
            阶段说明（可不填）
          </label>
          <textarea
            id="stage-note"
            className="qf-input min-h-[64px] resize-y leading-relaxed"
            value={note}
            maxLength={200}
            placeholder="如：客厅与主卧已布管，打压 24 小时保压合格"
            onChange={(e) => setNote(e.target.value)}
            data-testid="stage-note"
          />
        </div>
      </div>

      {localErr ? (
        <div className="text-svc-danger qf-foot mt-2 px-1" role="alert">
          {localErr}
        </div>
      ) : null}

      <div className="mt-3 flex gap-2 pb-4">
        <QFButton variant="tonal" onClick={onCancel} disabled={busy}>
          取消
        </QFButton>
        <div className="flex-1">
          <QFButton
            variant="primary"
            block
            busy={busy}
            disabled={!photoOk || !date || date > today}
            onClick={() => {
              if (!date) {
                setLocalErr('请填写实际完成日期');
                return;
              }
              if (date > today) {
                setLocalErr('完成日期不能晚于今天');
                return;
              }
              setLocalErr(null);
              onSubmit({ stage_date: date, note: note.trim() });
            }}
            testId="stage-complete-submit"
          >
            完成本阶段
          </QFButton>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- 撤回阶段面板 */

/**
 * 撤回阶段的面板。
 *
 * ⚠️ 必须**先说清连锁后果**再让用户确认：
 *    "撤回「管路施工」后，它后面已完成的阶段也会一起撤回，客户看到的进度会退回去。"
 *    不说这句的话，用户在列表中看到"只撤回了一个阶段"，
 *    而实际上后面三个都没了 —— 那会在下一次客户来电时变成一场事故。
 */
export function QFStageWithdrawPanel({
  stage,
  stages,
  busy,
  onSubmit,
  onCancel,
}: {
  stage: ArchiveStageRow;
  stages: ArchiveStageRow[];
  busy: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const meta = HVAC_STAGE_META[stage.stage_code];
  const [reason, setReason] = useState('');
  const [localErr, setLocalErr] = useState<string | null>(null);

  /** 会被一起撤回的后续阶段（与服务端同一判据：order ≥ 本阶段 且 已完成） */
  const idx = ORDER.indexOf(stage.stage_code);
  const cascaded = stages
    .filter((s) => {
      const i = ORDER.indexOf(s.stage_code);
      return i >= idx && s.status === 'done';
    })
    .map((s) => HVAC_STAGE_META[s.stage_code]?.label ?? s.stage_code);

  return (
    <div className="px-4 pt-3" data-testid="stage-withdraw-panel">
      <div className="qf-section">
        <div className="px-4 py-3">
          <div className="text-svc-ink qf-body font-medium">撤回「{meta?.label ?? stage.stage_code}」</div>
          <div className="text-svc-warning qf-foot mt-1.5 leading-relaxed">
            {cascaded.length > 1
              ? `撤回后，后面已完成的 ${cascaded.slice(1).join('、')} 也会一起撤回，客户看到的进度会退回去。`
              : '撤回后这个阶段会回到"未开始"，客户看到的进度会退回去。'}
          </div>
        </div>
        <div className="px-4 py-3">
          <label className="qf-field-label" htmlFor="withdraw-reason">
            撤回原因<span className="text-svc-danger ml-0.5">*</span>
          </label>
          <textarea
            id="withdraw-reason"
            className="qf-input min-h-[64px] resize-y leading-relaxed"
            value={reason}
            maxLength={200}
            placeholder="如：客户要求改走管路，需要重新施工"
            onChange={(e) => setReason(e.target.value)}
            data-testid="withdraw-reason"
          />
          <div className="text-svc-ink-3 qf-caption mt-1">撤回原因会记入档案，客户看不到。</div>
        </div>
      </div>

      {localErr ? (
        <div className="text-svc-danger qf-foot mt-2 px-1" role="alert">
          {localErr}
        </div>
      ) : null}

      <div className="mt-3 flex gap-2 pb-4">
        <QFButton variant="tonal" onClick={onCancel} disabled={busy}>
          取消
        </QFButton>
        <div className="flex-1">
          <QFButton
            variant="destructive"
            block
            busy={busy}
            onClick={() => {
              if (!reason.trim()) {
                setLocalErr('请填写撤回原因');
                return;
              }
              setLocalErr(null);
              onSubmit(reason.trim());
            }}
            testId="stage-withdraw-submit"
          >
            确认撤回
          </QFButton>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- 工具 */

function formatDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function CheckGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UndoGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden="true">
      <path d="M4 10h9a5 5 0 0 1 0 10h-3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m7.5 6.5-3.5 3.5 3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export { QFStatusBadge };
export type { Tone };
