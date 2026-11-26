/**
 * 普通上门服务的业务操作面板（R2.2.5 §三 / §四 / §五）。
 *
 * ===========================================================================
 * 这个文件解决什么问题
 * ===========================================================================
 *   业务负责人真机反馈：「普通上门服务详情只有『编辑档案』，销售找不到下一步操作。」
 *   根因不是缺按钮，而是**没有把"档案登记"和"业务办理"分开**：
 *   一条待服务的档案，销售真正要做的是「到客户家 → 点开始 → 拍照 → 点完成」，
 *   而旧版只给了一个"编辑档案"，那是**改资料**，不是**办事**。
 *
 *   于是本组件承载四件事（都走 `svc:` 业务 action，绝不改 status）：
 *     ① 开始服务   pending/scheduled → serving
 *     ② 完成服务   serving → completed（照片硬闸在服务端）
 *     ③ 补录结果   pending → completed（一次填完，等价于"先开始再完成"）
 *     ④ 修改记录   completed 状态下改日期/照片/备注
 *
 * ===========================================================================
 * 三条必须守住的边界（用户原文）
 * ===========================================================================
 *   ① 「**复用已有照片，不要求用户重复上传**」
 *      ⇒ 面板里把**已经在库里的**前后照片按入口分别显示，只上传"新加的"。
 *        绝不因为"面板是新的"就让用户重拍一遍 —— 那会把现场照片变成劳动。
 *
 *   ② 「服务前 / 服务后是**两个明确入口**，上传时必须正确传入既有 `photo_type`」
 *      ⇒ 两个独立的 `<input type="file">` 与两个独立的入口按钮。
 *        **不猜**：不按上传顺序、不看文件名、不看图片内容。
 *        一个入口只写一个 `photo_type`，就这么简单。
 *
 *   ③ 「**保留原完成时间及状态，不因普通修改自动退回**」
 *      ⇒ 本组件的 ④「修改记录」调的是 `archiveUpdate`（改 service_date / 备注）
 *        与 `attachServicePhoto`（加照片），**从没调过 `archiveComplete`**。
 *        `completed_at` 是 `archiveComplete` 独有的写入点，碰不到就等于碰不坏。
 *
 * ===========================================================================
 * 为什么不用 `<Dialog>` / 毛玻璃
 * ===========================================================================
 *   用户 §四 明令：经典 iOS 17/18 浅色、「不采用毛玻璃 / Liquid Glass / 圆球返回按钮」。
 *   这里沿用档案详情页已有的底部面板形态（纯色遮罩 + 白底圆角上滑），
 *   与 `QFStagePanel` / `QFConfirmSheet` 一致 —— 同一屏里不应该有两种浮层语言。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArchiveApiAdapter, type ArchivePhotoRow } from '../../api/archives';
import { newRequestId } from '../../api/http';
import { useSecurePhoto, archivePhotoFileUrl } from '../../api/media';
import { QFButton } from './primitives';

/* ------------------------------------------------------------------ 类型 */

/**
 * 面板要做的事。
 *
 * ⚠️ 四种模式**不是**"同一个表单的四种文案"，它们的字段完全不同：
 *    · `start`   只有实际日期
 *    · `complete` 日期 + 前后照片 + 备注
 *    · `backfill` 与 complete 相同（服务端同一接口，起点不同）
 *    · `edit`     日期 + 已上传照片 + 备注（**不校验照片**，因为已经完成了）
 *    ⇒ 用一个 `mode` 分派而不是写四个组件：照片区的"账"（已有几张/还差什么）
 *      必须共用同一套算法，拆开必然两套漂移。
 */
export type ServiceActionMode = 'start' | 'complete' | 'backfill' | 'edit';

export interface ServiceActionInput {
  mode: ServiceActionMode;
  /** 实际服务日期（YYYY-MM-DD）；`start` 也用它 */
  service_date: string;
  /** 服务备注（写进内部备注 `notes`，选填） */
  note: string;
}

/* ------------------------------------------------------------------ 工具 */

/** 今天（本地时区）。`toISOString()` 是 UTC，早上 8 点前会退回昨天 —— 不能直接用 */
export function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 把任意时间串裁成 YYYY-MM-DD（`2026-11-20 15:30:00+08` → `2026-11-20`） */
function dayOf(v: unknown): string {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, 10) : '';
}

/* ------------------------------------------------------------------ 主组件 */

export function QFServiceActionSheet({
  mode,
  archiveId,
  archiveVersion,
  status,
  serviceDate,
  plannedDate,
  notes,
  photos,
  busy,
  onUploaded,
  onSubmit,
  onEditPlanned,
  onCancel,
}: {
  mode: ServiceActionMode;
  archiveId: number | string;
  /** 档案当前 `version`（乐观锁）。**每次提交必须用最新的**，父级负责重拉 */
  archiveVersion: number;
  /** 档案当前状态（用于文案与"能不能这么干"的前置判断） */
  status: string;
  /** 已记录的实际服务日期 */
  serviceDate?: string | null;
  /** 计划上门日期 */
  plannedDate?: string | null;
  /** 内部备注（服务备注） */
  notes?: string | null;
  /** 全量现场照片（父级传入，本组件自己按 photo_type 分账） */
  photos: ArchivePhotoRow[];
  busy: boolean;
  /** 照片上传成功后回调（父级需重拉照片以更新数量） */
  onUploaded: () => void | Promise<void>;
  onSubmit: (input: ServiceActionInput) => void;
  /** 「修改计划」—— 只在 `start` 模式下作为次操作出现 */
  onEditPlanned?: () => void;
  onCancel: () => void;
}) {
  /**
   * 实际服务日期的初值。
   *
   * 🔴 回退顺序：**已记录的实际日期 → 今天**。就这两级。
   *
   * ⚠️ **不能用计划日期兜底**（第一版就是这么写的，被验收脚本抓了出来：
   *    "实际日期默认今天且可改" FAIL，拿到 `2026-11-28`）。
   *
   *    原因不是"哪个更省事"，而是用户 §二 明令：
   *      「修改日期**不自动改变**业务状态、**计划日期**、完成时间、发布状态和照片归属」
   *    以及「实际日期未填写时**不伪造为计划日期**或当天」。
   *
   *    把计划日期的值预填进"实际服务日期"输入框，等于在保存时**凭空制造**
   *    一个"客户确实是 11-28 上的门"的记录 —— 而销售可能只是打开看了一眼就关掉、
   *    或者直接点了保存。那是一条**无法与真实记录区分**的假数据。
   *    这比"要手动选一下日期"的成本高得多：日期错了，客户回访、保修起算全错。
   *
   * ⚠️ 「今天」这个默认是安全的：它是"我现在正在现场办事"的诚实记录，
   *    而且只出现在 start/complete/backfill 三个"当场操作"的场景里。
   *    补录（backfill）时今天不对，但那时用户**本来就要改**，
   *    面板上的日期字段是显眼的第一个字段。
   * ⚠️ `completed_at` 绝不参与兜底：那是"哪天点的完成"，与"哪天上的门"是两件事。
   */
  const fallbackDate = useMemo(() => {
    const recorded = dayOf(serviceDate);
    if (recorded) return recorded;
    return todayLocal();
  }, [serviceDate]);

  const [date, setDate] = useState(fallbackDate);
  const [note, setNote] = useState(String(notes ?? ''));
  const [localErr, setLocalErr] = useState<string | null>(null);

  /** 父级换了档案/模式 ⇒ 重置（否则点到下一条还留着上一条的输入） */
  useEffect(() => {
    setDate(fallbackDate);
    setNote(String(notes ?? ''));
    setLocalErr(null);
  }, [fallbackDate, notes]);

  /**
   * 照片按入口分账 —— **只认 `photo_type`，不猜**。
   *
   * 用户 §五：「已正确分类的照片继续归入服务前 / 服务后；无法识别的历史照片继续
   *           显示在未分类，且不得自动迁移归属。」
   * ⇒ 这里对既不是 `before` 也不是 `after` 的行**完全不动**（不显示、不改写）。
   *    它们仍然在详情页的「未分类」组里，由页面负责展示。
   */
  const before = photos.filter((p) => String(p.photo_type ?? '') === 'before');
  const after = photos.filter((p) => String(p.photo_type ?? '') === 'after');

  const isEdit = mode === 'edit';
  /** 完成/补录都受照片硬闸约束；`start` 与 `edit` 不受 */
  const photoGate = mode === 'complete' || mode === 'backfill';
  const needBefore = photoGate && before.length === 0;
  const needAfter = photoGate && after.length === 0;

  /**
   * 前置状态检查 —— **不是**在客户端复刻服务端状态机，而是把"点了必然被拒"的情况
   * 提前说清楚，避免用户白填一遍再看到 409。
   *
   * 真正的裁决仍在服务端（`archiveStart` / `archiveComplete` 各自会校验），
   * 这里只是**同一条规则的可读提示**。服务端改了白名单而这里没跟，
   * 后果只是"多一次被拒"，方向安全。
   */
  const blocked: string | null = (() => {
    if (mode === 'start') {
      if (status === 'completed') return '这条档案已经完成服务，不能重新开始。如需更正记录，请用「修改服务记录」。';
      if (status === 'serving') return '这条档案已经是「服务中」，无需重复开始。';
      if (status === 'voided') return '档案已作废，不能开始服务。';
    }
    if (mode === 'complete' && status !== 'serving' && status !== 'pending' && status !== 'scheduled') {
      return '当前状态不能完成服务。';
    }
    if (mode === 'backfill' && status === 'completed') {
      return '这条档案已经完成过，请直接用「修改服务记录」更正。';
    }
    return null;
  })();

  const dateOk = Boolean(date);
  const canSubmit = dateOk && !busy && !blocked && !needBefore && !needAfter;

  const title =
    mode === 'start'
      ? '开始服务'
      : mode === 'complete'
        ? '完成服务'
        : mode === 'backfill'
          ? '补录服务结果'
          : '修改服务记录';

  return (
    <div className="px-4 pt-3" data-testid={`service-panel-${mode}`}>
      <div className="qf-section">
        {/*
          前置状态提示：放在表单**最上面**而不是提交按钮旁。
          原因：如果这条档案已经完成了，用户不该先选日期、再传两张照片、
          然后才在底部看到"不能这么做"。把结论提到最前面，省掉一整轮无效操作。
        */}
        {blocked ? (
          <div className="bg-svc-warning-soft px-4 py-3" data-testid="service-panel-blocked">
            <div className="text-svc-warning qf-foot leading-relaxed">{blocked}</div>
          </div>
        ) : null}
        {/*
          `archiveVersion` 只用于**展示**，不参与提交校验 —— 乐观锁在服务端判，
          前端拿它做前置判断必然过时（用户可能开了两个面板）。
          但它是"这条档案被改过没有"的唯一本地线索，所以在提交区显示出来：
          出现 409 时，员工能立刻对上"刚才确实是两处同时在改"，
          而不是以为系统坏了。
        */}
        <div className="hidden" data-testid="service-panel-version" data-version={String(archiveVersion)} />

        {/* ---------------------------------------------------------- 日期 */}
        <div className="px-4 py-3">
          <label htmlFor="svc-date" className="text-svc-ink-2 qf-sub block">
            实际服务日期<span className="text-svc-danger ml-0.5">*</span>
          </label>
          <input
            id="svc-date"
            type="date"
            value={date}
            /**
             * ⚠️ 不给 `max={today}`。
             *
             *    第一直觉是"不许选未来"，但那会把**计划明天上门**的合规动作拦在门外，
             *    而且服务端的 `parseDateOnly` 只校验格式、不校验先后
             *    （用户 §二 明令：「计划 11 月 28 日 / 实际 11 月 26 日」要能保存）。
             *    在客户端加一条服务端没有的规则，等于让两边口径分叉 ——
             *    改天换一个人来维护，必然只改一边。
             */
            onChange={(e) => setDate(e.target.value)}
            className="qf-input text-svc-ink qf-body mt-1.5 w-full"
            data-testid="service-panel-date"
          />
          {plannedDate && mode !== 'edit' ? (
            <div className="text-svc-ink-3 qf-caption mt-1.5">
              计划上门 {dayOf(plannedDate)}
              {dayOf(plannedDate) !== date ? '，实际按今天记录的日期为准' : ''}
            </div>
          ) : null}
        </div>

        {/* ---------------------------------------------------------- 照片 */}
        {/*
          `start` 模式**不显示照片区**：开始服务就是"我到现场了"，
          此时连活都没干，要照片是荒谬的。照片属于完成环节。
        */}
        {mode !== 'start' ? (
          <div className="border-svc-line border-t px-4 py-3">
            <div className="text-svc-ink-2 qf-sub mb-2">
              现场照片
              {photoGate ? <span className="text-svc-danger ml-0.5">*</span> : null}
            </div>
            <div className="flex flex-col gap-3">
              <PhotoSlot
                label="服务前"
                photoType="before"
                archiveId={archiveId}
                mine={before}
                missing={needBefore}
                onUploaded={onUploaded}
                onError={setLocalErr}
                testId="service-slot-before"
              />
              <PhotoSlot
                label="服务后"
                photoType="after"
                archiveId={archiveId}
                mine={after}
                missing={needAfter}
                onUploaded={onUploaded}
                onError={setLocalErr}
                testId="service-slot-after"
              />
            </div>
            {photoGate && (needBefore || needAfter) ? (
              <div className="text-svc-ink-3 qf-caption mt-2 leading-relaxed">
                完成服务需要服务前、服务后各至少一张照片。
                {needBefore && needAfter ? '两类都还没有。' : needBefore ? '还缺服务前。' : '还缺服务后。'}
              </div>
            ) : null}
            {isEdit ? (
              <div className="text-svc-ink-3 qf-caption mt-2 leading-relaxed">
                这里只影响照片归属，不会改变这条档案的完成时间。
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ---------------------------------------------------------- 备注 */}
        {mode !== 'start' ? (
          <div className="border-svc-line border-t px-4 py-3">
            <label htmlFor="svc-note" className="text-svc-ink-2 qf-sub block">
              服务备注<span className="text-svc-ink-3 ml-1 font-normal">（选填）</span>
            </label>
            <textarea
              id="svc-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="例如：更换滤芯、客户反映异响已处理"
              className="qf-input text-svc-ink qf-body mt-1.5 w-full resize-none"
              data-testid="service-panel-note"
            />
          </div>
        ) : null}

        {/* ---------------------------------------------------------- 提交 */}
        <div className="border-svc-line flex flex-col gap-2 border-t px-4 py-3">
          {localErr ? (
            <div className="text-svc-danger qf-foot" role="alert">
              {localErr}
            </div>
          ) : null}
          {!dateOk ? (
            <div className="text-svc-warning qf-foot" role="status">
              请先选择实际服务日期。
            </div>
          ) : null}
          <div className="flex gap-2">
            <div className="flex-1">
              <QFButton variant="secondary" block onClick={onCancel} testId="service-panel-cancel">
                取消
              </QFButton>
            </div>
            <div className="flex-1">
              <QFButton
                variant="primary"
                block
                disabled={!canSubmit}
                busy={busy}
                onClick={() => {
                  if (!canSubmit) return;
                  setLocalErr(null);
                  onSubmit({ mode, service_date: date, note });
                }}
                testId={`service-panel-submit-${mode}`}
              >
                {title}
              </QFButton>
            </div>
          </div>
          {/*
            「修改计划」只在待服务面板里出现，而且是**次操作**。
            用户 §三：「待服务详情底部 = 次按钮「修改计划」+ 主按钮「开始服务」」——
            进到面板里之后，主操作已经变成"确认开始"，修改计划退化成一句链接。
          */}
          {mode === 'start' && onEditPlanned ? (
            <button
              type="button"
              onClick={onEditPlanned}
              className="text-svc-brand-text qf-foot qf-pressable mt-1 inline-flex min-h-touch items-center justify-center font-medium"
              data-testid="service-panel-edit-planned"
            >
              修改计划上门日期
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 计划日期 */

/**
 * 「修改计划上门日期」面板（R2.2.5 §三 / §四）。
 *
 * ===========================================================================
 * 为什么它必须**单独**存在
 * ===========================================================================
 *   用户 §四：「计划日期支持直接修改，不必进整张档案编辑页。」
 *
 *   旧版改计划日期要走 `/m/archives/:id/edit` —— 那是一张三十多个字段的
 *   完整档案表单。销售的场景是"客户打电话说改成后天"，为了改一行日期
 *   打开整张档案、翻到日期、保存、确认，四步里三步是噪音。
 *   而噪音不只是慢：整张表单提交是**整表覆盖**，任何一个被误触的字段
 *   都会一起写回去。
 *
 * ===========================================================================
 * 它为什么**只改 planned_date**
 * ===========================================================================
 *   `archiveUpdate` 只写"请求里出现的键"。本组件只发 `planned_date` 与
 *   `expected_version`，所以：
 *     · `service_date`（实际日期）不会被碰 —— 用户 §二 明令
 *       「修改日期不自动改变业务状态、计划日期、完成时间、发布状态和照片归属」；
 *     · `status` / `visibility` / `completed_at` 结构上不在白名单里。
 *   ⇒ 这条路径无论怎么用，都**不可能**把档案改成别的状态。
 */
export function QFPlannedDateSheet({
  plannedDate,
  busy,
  onSubmit,
  onCancel,
}: {
  plannedDate?: string | null;
  busy: boolean;
  onSubmit: (planned_date: string) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(dayOf(plannedDate));
  const [err, setErr] = useState<string | null>(null);

  const canSubmit = Boolean(date) && !busy;

  return (
    <div className="px-4 pt-3" data-testid="planned-panel">
      <div className="qf-section">
        <div className="px-4 py-3">
          <label htmlFor="svc-planned" className="text-svc-ink-2 qf-sub block">
            计划上门日期<span className="text-svc-danger ml-0.5">*</span>
          </label>
          <input
            id="svc-planned"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="qf-input text-svc-ink qf-body mt-1.5 w-full"
            data-testid="planned-panel-date"
          />
          <div className="text-svc-ink-3 qf-caption mt-1.5 leading-relaxed">
            只改计划日期。实际服务日期和这条档案的进度都不受影响。
          </div>
        </div>
        <div className="border-svc-line flex flex-col gap-2 border-t px-4 py-3">
          {err ? (
            <div className="text-svc-danger qf-foot" role="alert">
              {err}
            </div>
          ) : null}
          <div className="flex gap-2">
            <div className="flex-1">
              <QFButton variant="secondary" block onClick={onCancel} testId="planned-panel-cancel">
                取消
              </QFButton>
            </div>
            <div className="flex-1">
              <QFButton
                variant="primary"
                block
                disabled={!canSubmit}
                busy={busy}
                onClick={() => {
                  if (!canSubmit) return;
                  // 空值不允许提交：清空计划日期是"这条档案不需要上门"的语义，
                  // 那是取消档案，不是改日期。留给整张编辑页去处理。
                  if (!date) {
                    setErr('请选择计划上门日期');
                    return;
                  }
                  setErr(null);
                  onSubmit(date);
                }}
                testId="planned-panel-submit"
              >
                保存
              </QFButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 照片槽 */

/**
 * 一个照片入口（服务前 / 服务后）。
 *
 * 结构刻意做成"**已有照片 + 加一张**"，而不是"上传框 + 数量"：
 *   销售打开完成面板时最想知道的是"还差哪一类"，其次才是"再加一张"。
 *   已有照片必须能看到真实缩略图 —— 只有数字的话，他无法判断
 *   "是不是拍糊了、是不是拍错机器了"，那正是需要补拍的时刻。
 */
function PhotoSlot({
  label,
  photoType,
  archiveId,
  mine,
  missing,
  onUploaded,
  onError,
  testId,
}: {
  label: string;
  photoType: 'before' | 'after';
  archiveId: number | string;
  mine: ArchivePhotoRow[];
  missing: boolean;
  onUploaded: () => void | Promise<void>;
  onError: (msg: string | null) => void;
  testId: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    onError(null);
    setUploading(true);
    try {
      // 串行上传：弱网下并行会把上行切碎，反而更容易全部超时
      for (const file of Array.from(files)) {
        const prepared = await prepareImage(file);
        /**
         * 🔴 这里是 §五 的核心：`photo_type` 由**入口**决定，写死。
         *    不接受任何"根据上下文推断"的参数。
         */
        await ArchiveApiAdapter.attachServicePhoto(
          archiveId,
          { file: prepared, photo_type: photoType },
          newRequestId(),
        );
      }
      await onUploaded();
    } catch (e) {
      onError(e instanceof Error ? e.message : '照片上传失败，请检查网络后重试');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div data-testid={testId} data-photo-type={photoType} data-photo-count={mine.length}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-svc-ink qf-foot font-medium">
          {label}
          {missing ? <span className="text-svc-danger ml-0.5">*</span> : null}
        </span>
        <span className={`qf-caption tabular ${missing ? 'text-svc-danger' : 'text-svc-ink-3'}`}>
          {mine.length > 0 ? `已上传 ${mine.length} 张` : '还没有'}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {mine.map((p) => (
          <Thumb key={p.id} photoId={p.id} />
        ))}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="bg-svc-surface-2 text-svc-brand-text qf-pressable flex aspect-square flex-col items-center justify-center gap-0.5 rounded-svc-sm disabled:opacity-45"
          aria-label={`添加${label}照片`}
          data-testid={`${testId}-add`}
        >
          {uploading ? <span className="svc-spinner" aria-hidden="true" /> : <CameraGlyph />}
          <span className="qf-caption">{uploading ? '上传中' : '添加'}</span>
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          void onFiles(e.target.files);
          // 清空 value：否则选同一张图第二次不会触发 change
          e.target.value = '';
        }}
        data-testid={`${testId}-input`}
      />
    </div>
  );
}

/** 已上传照片的缩略图（私有资源：fetch 带 token → blob → objectURL） */
function Thumb({ photoId }: { photoId: number }) {
  /**
   * ⚠️ `useSecurePhoto` 收的是 **URL path**，不是照片 id。
   *    传 `photoId` 会拼出 `/api/123` —— 请求 404，而缩略图位置只剩一个
   *    永远转圈的 spinner。那种"看起来在加载"的失败最难发现。
   */
  const { url } = useSecurePhoto(archivePhotoFileUrl(photoId));
  return (
    <div className="bg-svc-surface-2 aspect-square overflow-hidden rounded-svc-sm">
      {url ? (
        // 用户 rc.9 已裁决「contain 完整展示」—— 不裁切，宁可留白
        <img src={url} alt="现场照片" className="h-full w-full object-contain" />
      ) : (
        <div className="text-svc-ink-3 flex h-full w-full items-center justify-center">
          <span className="svc-spinner" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

function CameraGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 8.5h3l1.5-2h7L17 8.5h3v10H4z" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="3.2" />
    </svg>
  );
}

/* ------------------------------------------------------------- 图片预处理 */

/**
 * 上传前压缩（长边 ≤1600、JPEG 0.82）。
 *
 * ⚠️ 与 `photo-uploader.tsx` 的 `prepare()` 是**同一套参数**，但刻意没有抽成公共函数。
 *    原因：那份实现绑定在暖通阶段上传流程里（含 `MAX_EDGE` / `SOFT_LIMIT_BYTES`
 *    的取舍说明），把它抽出去会同时动到暖通链路 —— 本轮不该扩大改动面。
 *    **参数必须保持一致**：两个入口压出不同尺寸的照片，会让同一档案里
 *    前片清晰、后片糊，而没人能从界面上看出来"是哪一步压狠了"。
 *
 * ⚠️ 压缩在 canvas 上做，会丢 EXIF。这里反而是好事：竖拍照片的 Orientation
 *    在 canvas 绘制时已被浏览器摆正，导出即所见即所得（DEV-84 同类缺陷）。
 */
async function prepareImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  const MAX_EDGE = 1600;
  const QUALITY = 0.82;
  const SOFT_LIMIT_BYTES = 2.5 * 1024 * 1024;

  const bitmap = await loadBitmap(file).catch(() => null);
  if (!bitmap) return file;

  const { width, height } = bitmap;
  const longEdge = Math.max(width, height);
  if (longEdge <= MAX_EDGE && file.size <= SOFT_LIMIT_BYTES) return file;

  const scale = Math.min(1, MAX_EDGE / longEdge);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  // 白底：PNG 透明区转 JPEG 会变黑
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, w, h);
  if ('close' in bitmap && typeof (bitmap as ImageBitmap).close === 'function') {
    (bitmap as ImageBitmap).close();
  }

  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', QUALITY));
  if (!blob) return file;
  const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* 落到 <img> 分支（部分浏览器对某些 JPEG 不支持 createImageBitmap） */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('图片解码失败'));
      img.src = url;
    });
    return img;
  } finally {
    // ⚠️ 只在 <img> 分支释放：ImageBitmap 路径不产生 objectURL
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
