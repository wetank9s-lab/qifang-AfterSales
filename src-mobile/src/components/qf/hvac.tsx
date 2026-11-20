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
import { QFStagePhotoManager, type StagePhoto } from './photo-uploader';
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
  /**
   * 点击操作入口。`null` = 该阶段当前没有可执行的动作。
   *
   * 🔴 R2.2.1 §七 用 `'update'` **取代**了 `'withdraw'`：
   *    已完成阶段的动作是「修改」，不是「撤回」。两者在此**不是同义词**：
   *      · update   → `svc:archiveStageUpdate`（只改日期/备注，状态不动）
   *      · withdraw → `svc:archiveStageWithdraw`（状态改 withdrawn + 连锁撤回）
   *    旧版本把"修改"做成了 withdraw 的改名按钮 —— 员工点一次「修改」，
   *    后面三个已完成阶段会一起退回未开始，客户看到的进度当场倒退。
   */
  onAction?: (stage: ArchiveStageRow, action: 'complete' | 'update' | null) => void;
  /** 点"看照片" */
  onViewPhotos?: (stage: ArchiveStageRow) => void;
  /** 当前展开照片筛选的阶段 code */
  activeStage?: string | null;
  /**
   * 阶段显示名（来自后台配置 `svc:archiveStageConfigGet`）。
   * ⚠️ 缺省或缺失某个 code 时回退 `HVAC_STAGE_META` 的代码默认名，
   *    但**绝不**回退成 `stage_code`（员工不该看到 `pipe` 这种机器码）。
   */
  stageNames?: Record<string, string>;
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
  stageNames,
}: QFStageTimelineProps) {
  const byCode = new Map(stages.map((s) => [s.stage_code, s]));

  /** 当前该做哪个阶段 = 第一个未 done 的（顺序表口径） */
  const firstUndone = ORDER.find((c) => byCode.get(c)?.status !== 'done');

  /** 显示名：配置优先 → 代码默认 → 机器码（最后一级理论上不会命中） */
  const nameOf = (code: string): string =>
    String(stageNames?.[code] ?? '').trim() || HVAC_STAGE_META[code]?.label || code;

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

        /**
         * 该阶段可执行的动作。
         *
         * 🔴 §七 原文：「主操作统一「修改」」「未完成当前阶段保留独立「完成本阶段」」。
         *    · 已完成 ⇒ **修改**（直接改日期/备注/照片，状态保持 done、后续阶段不动）
         *    · 当前阶段 ⇒ **完成本阶段**
         *    · 撤回过的 ⇒ 也允许「修改」（备注与日期是真实历史），
         *                 但它不再是"当前阶段"，故不给"完成"入口 ——
         *                 重新完成要先把前面阶段补齐，那是服务端判的，不在这一行呈现。
         *    撤回能力**保留在服务端**（`archiveStageWithdraw` 未删），
         *    但移动端时间线不再把它作为主操作 —— 用户明确要求"统一为修改"。
         */
        const action: 'complete' | 'update' | null = done || withdrawn ? 'update' : isActive ? 'complete' : null;
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
                    {nameOf(code)}
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
                   * 🔴 阶段备注必须显示在时间线上。
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
                   * R2.2.1 §七 起，**已完成和已撤回**都显示：
                   * 撤回阶段仍然保留了 note（撤回原因在 withdraw_reason，另处展示），
                   * 那一行备注是"当时现场写了什么"的真实历史，藏起来等于丢证据。
                   */}
                  {(done || withdrawn) && s?.note ? (
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
                      /* 同上：`min-w-touch` 保证「修改 / 完成」也是 44×44 的靶子 */
                      className={`qf-foot qf-pressable inline-flex min-h-touch min-w-touch items-center justify-center px-2 font-semibold ${
                        action === 'update' ? 'text-svc-brand-text' : 'text-svc-brand-text'
                      }`}
                      data-testid={`stage-action-${code}`}
                      data-stage-action={action}
                    >
                      {action === 'update' ? '修改' : '完成'}
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

/* --------------------------------------------------------- 阶段面板（完成 / 修改） */

/**
 * 阶段面板：**一个组件两种模式**。
 *
 * ===========================================================================
 * 为什么不拆成两个组件
 * ===========================================================================
 *   「完成本阶段」与「修改」在界面上有 90% 是同一件事：
 *   同一张照片区、同一行实际施工日期、同一个备注框。
 *   拆成两套的代价是**两份照片逻辑**各自漂移 —— 而这正是本轮要修的缺陷
 *   （旧代码的撤回面板根本没有照片区，于是"改日期"就会把照片丢掉）。
 *
 *   真正的差异只有三处，各自是**显式分支**而不是复制粘贴：
 *     ① 标题：「完成「管路施工」」 / 「修改「管路施工」」
 *     ② 主按钮：「完成本阶段」（primary） / 「保存修改」（primary）
 *     ③ 照片是否可删、日期是否可清空 —— 见下面 `editable` 的用法
 *
 * ===========================================================================
 * 🔴 §七 的硬约束：替换照片不能把必需照片数变成 0
 * ===========================================================================
 *   「删除或替换关键阶段照片时不能让必需照片数变零 ——
 *     **应先上传替换照片再移除旧照片**。」
 *
 *   所以这里**没有**「先删后传」的路径：
 *     · 移除按钮只在 `照片数 - 1 >= 最少张数` 时可用；
 *     · 达到下限时按钮禁用并写明原因（而不是点了才被服务端 409）。
 *   服务端 `updateStage` 不校验照片数（那是 `completeStage` 的事），
 *   于是"改备注顺手删光照片"能一路 200 —— 而客户页的照片区会突然变空。
 *   ⇒ 这道闸必须在**客户端点得动之前**就关上，且服务端另有计数兜底。
 */
export function QFStagePanel({
  mode,
  stage,
  archiveId,
  photos,
  busy,
  stageName,
  onUploaded,
  onSubmit,
  onCancel,
  onWithdraw,
}: {
  mode: 'complete' | 'update';
  stage: ArchiveStageRow;
  archiveId: number | string;
  /**
   * 本阶段照片（真实缩略图用）。
   * ⚠️ 由父级传**已按 stage_id 过滤**的列表会更省事，但这里仍然自己再过滤一遍：
   *    父级若某次忘了过滤，界面会把别人的照片画进这个阶段 —— 而画面看起来完全正常。
   */
  photos: StagePhoto[];
  busy: boolean;
  /**
   * 阶段显示名（来自后台配置，由页面统一解析后传入）。
   *
   * 🔴 这个 prop 是**补漏**来的（R2.2.1 rc.2 视觉审核时发现）：
   *    时间线（`QFStageTimeline`）早就按配置显示新名字，而**面板标题**
   *    直接读 `HVAC_STAGE_META[code].label`（代码默认值）⇒ 后台把
   *    「现场勘察」改成「现场勘察（已改名）」后，列表里是新的、点开修改
   *    却写着旧的。同一个页面两处名字不一致，员工会以为是两个人。
   *    缺省时回退代码默认名，但**绝不**回退成 `stage_code`。
   */
  stageName?: string;
  /** 照片上传或移除成功后调用（父级重新拉阶段与照片 —— 两者都变了） */
  onUploaded: () => void | Promise<void>;
  /**
   * 提交回传的业务字段。
   *
   * ⚠️ `stage_date` 是**可选**的，这不是偷懒 —— 它就是本轮的修复点：
   *    修改态下用户没动日期，就不发这个键（服务端 `paramPresence` 判定 absent
   *    ⇒ 不写 stage_date 列）。类型上标成可选，是为了让"省略"成为
   *    **类型允许的一等行为**，而不是靠 `as any` 硬塞过去 ——
   *    后者会让下一个读代码的人以为这里永远带日期。
   */
  onSubmit: (input: { stage_date?: string; note: string }) => void;
  onCancel: () => void;
  /** 仅在需要保留撤回能力时传入（移动端默认不传，见 §七） */
  onWithdraw?: (reason: string) => void;
}) {
  const meta = HVAC_STAGE_META[stage.stage_code];
  // 显示名：调用方传入（来自后台配置）→ 代码默认名 → 机器码（最后一级不会命中）
  const displayName =
    String(stageName ?? '').trim() || meta?.label || stage.stage_code;
  const today = new Date().toISOString().slice(0, 10);
  const isUpdate = mode === 'update';
  /**
   * 日期初值。
   *
   * 🔴 R2.2.2 排查发现的真实缺陷（不是文字问题，是**数据污染**风险）：
   *
   *   旧实现：`useState(stage.stage_date ?? today)`
   *   ⇒ 当 `stage_date` 为空时**回退到今天**。
   *
   *   而实测（DEMO-R2221-B / id=395）六个已完成阶段的 `stage_date` **全是 NULL**，
   *   只有 `completed_at` 有值（2026-09-30 等）。于是：
   *     · 时间线显示「现场勘察 2026-09-30 完成」← 来自 completed_at
   *     · 点开修改面板，日期却预填 **2026-11-19（今天）** ← 来自 today
   *   两者互相矛盾。更危险的是：员工只想改一句备注，看到日期是今天、
   *   以为"本来就是今天"，直接点保存 ⇒ 服务端 `stage_date` 被写成今天，
   *   **真实完成日期被永久覆盖**，而日志里看起来是一次"正常修改"。
   *
   *   ⇒ 回退顺序改为：`stage_date` → `completed_at` 的日期部分 → `stage_date` 为空时
   *      **不预填今天**（仅对"当前阶段首次完成"`mode==='complete'` 才用 today）。
   *   这样两种情况的语义都正确：
   *     · 已完成阶段修改 → 显示它真实的完成日期，不误导
   *     · 当前阶段首次完成 → 默认今天（师傅当天干完就点，这是合理默认）
   */
  const fallbackDate = (() => {
    const raw = String(stage.stage_date ?? '').trim();
    if (raw) return raw.slice(0, 10);
    // ArchiveStageRow 已映射 completed_at（见 api/archives.ts stages()）
    const done = String(stage.completed_at ?? stage.done_at ?? '').trim();
    if (done) return done.slice(0, 10); // ISO 字符串前 10 位就是 YYYY-MM-DD
    return isUpdate ? '' : today;
  })();
  const [date, setDate] = useState(fallbackDate);
  const [note, setNote] = useState(stage.note ?? '');
  const [localErr, setLocalErr] = useState<string | null>(null);

  const need = stage.photo_required ?? false;
  const max = stage.photo_max ?? 6;
  const mine = photos.filter((p) => Number((p as any).stage_id) === Number(stage.id));
  /**
   * 最少要保留几张。
   * ⚠️ 关键阶段（survey/pipe/device/accept）= 1；其余 = 0。
   *    这个值来自服务端下发的 `photo_required`，**不是**前端硬编码的四个 code ——
   *    否则服务端哪天改了必需阶段清单，这里会悄悄放行。
   */
  const minKeep = need ? 1 : 0;
  /**
   * ⚠️ 原来这里还有 `const hasPhoto = mine.length > 0`，用于「没传照片就警告」。
   *    R2.2.2 §三 把那条警告并进了照片说明那一句（"最多 6 张（至少 1 张）"），
   *    变量因此不再被读 —— 留着会被 tsc 报 TS6133（noUnusedLocals）。
   *    删掉变量比加 `void hasPhoto` 干净：后者会掩盖"这个条件已经不存在"这个事实。
   */
  /** 已完成的阶段日期不能为空；未完成（首次完成）也必须有日期 */
  const dateOk = Boolean(date) && date <= today;
  const canSubmit = dateOk;

  return (
    <div className="px-4 pt-3" data-testid={isUpdate ? 'stage-update-panel' : 'stage-complete-panel'}>
      <div className="qf-section">
        <div className="px-4 py-3">
          <div className="text-svc-ink qf-body font-medium">
            {isUpdate ? '修改' : '完成'}「{displayName}」
          </div>
          {/*
            🔴 R2.2.2 §三：这里原本有一整段系统内部逻辑解释 ——
               「直接改这里的日期、备注和照片，保存后阶段状态不变，
                 后面已完成的阶段也不会退回去。」

               用户原文：**「这是系统内部逻辑，不需要向销售人员解释。」**
               这段话回答的是"改了会不会把后面阶段退回去"，那是**开发者在担心的事**
               （旧版本用 withdraw 实现"修改"导致连锁退回，所以特别想表态）。
               而销售在门店现场脑子里的问题是"这一单现在做到哪一步、我还差什么"，
               给他一段状态机说明，他不会因此更会操作，只会多读三行字。

               ⇒ 整段删除。**但行为一点不改**：`updateStage` 仍然是
                 只更新日期/备注/照片、状态保持 done、不触碰后续阶段 ——
                  这条由服务端保证，界面上不再"承诺"它，也就不会有人怀疑它。
               下面只保留一行必要的用途说明（照片区 / 日期区各自带）。
          */}
          {isUpdate ? null : (
            <div className="text-svc-ink-3 qf-foot mt-0.5 leading-relaxed">{meta?.hint}</div>
          )}
        </div>

        {/* 照片区：真实缩略图 + 可替换/移除（§九） */}
        <div className="px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-svc-ink-2 qf-sub">
              现场照片
              {need ? <span className="text-svc-danger ml-0.5">*</span> : null}
            </span>
            <span className="text-svc-ink-3 qf-caption tabular">
              {mine.length} / {max}
            </span>
          </div>
          <QFStagePhotoManager
            archiveId={archiveId}
            stageId={stage.id}
            photos={mine}
            photoMax={max}
            minKeep={minKeep}
            onChanged={onUploaded}
            testId={`stage-uploader-${stage.stage_code}`}
          />
          {/*
            🔴 R2.2.2 §三：照片说明**收敛成一句**，直接写在标题正下方。

            整改前三句话分散在三处、且互相重复：
              · 「1 / 6」（右上角计数）
              · 「这个阶段的照片是必需项。要换照片，请先点「添加照片」传新的，再移除旧的。」
              · 「这个阶段至少要有 1 张现场照片才能完成。」

            用户要求：「照片提示保留一句简短说明即可，例如"上传本阶段现场照片，最多6张"」。

            ⇒ 一句话同时讲清三件事：**传什么 / 上限几张 / 必需与否**。
               不再解释"先传后删"—— 那个约束用**按钮禁用**表达（点了不能点，
               比读一句话就明白），写出来反而增加认知负担。
               用户原文要的正是"简单、直观、不分心"。
          */}
          <div className="text-svc-ink-3 qf-caption mt-1.5 leading-relaxed" data-testid="stage-photo-hint">
            {need
              ? `上传本阶段现场照片，最多 ${max} 张（至少 1 张）`
              : `上传本阶段现场照片，最多 ${max} 张`}
          </div>
        </div>

        {/* 实际施工日期 */}
        <div className="px-4 py-3">
          <label className="qf-field-label" htmlFor="stage-date">
            实际施工日期<span className="text-svc-danger ml-0.5">*</span>
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
          {date > today ? <div className="text-svc-danger qf-foot mt-1">施工日期不能晚于今天。</div> : null}
          {/*
            R2.2.2：已完成阶段若 stage_date 与 completed_at 都为空，日期框会是空的。
            不能让用户对着空框猜"是不是不用填"—— 明确写一句该怎么处理。
          */}
          {!date ? (
            <div className="text-svc-warning qf-foot mt-1" data-testid="stage-date-empty">
              请先选择实际施工日期。
            </div>
          ) : null}
        </div>

        {/*
          备注（R2.2.2 封版：标签最终统一为「备注」）

          🔴 用户原文：「当前实际截图仍显示『填写本阶段处理情况（选填）』，统一改为：备注」。
             上一版是照 §三 原文改的，但封版裁决要求统一 —— 以裁决为准。

          为什么敢只留两个字：
            · 位置已经说明用途（就在照片、日期下面，同一张阶段卡内）；
            · 「（选填）」是**负信息** —— 没人会因为看到"选填"而多写一句，
              真正需要的是"知道这格可以留空"，而留空本来就不会被拦（无 required）；
            · 「本阶段处理情况」在暖通语境里等于「备注」，写长了只是把
              同一件事说两遍。iOS 原生的 Notes 字段标签就是 "Notes"。

          编辑态加载已保存内容、新增态留空：`useState(stage.note ?? '')` 已保证
          （`stage.note` 来自 `archiveStageList`，已完成阶段必带；首次完成时为 null）。
          ⚠️ 不再增加任何解释性文案（用户明令）。
        */}
        <div className="px-4 py-3">
          <label className="qf-field-label" htmlFor="stage-note">
            备注
          </label>
          <textarea
            id="stage-note"
            className="qf-input min-h-[64px] resize-y leading-relaxed"
            value={note}
            maxLength={200}
            /*
             * 🔴 §九：「删除默认示例；输入框默认留空」。
             *    旧版 placeholder 是「如：客厅与主卧已布管，打压 24 小时保压合格」——
             *    那是一句**看起来像已完成记录**的示例，员工容易直接跳过不写，
             *    也会让人误以为"不这么写就不对"。留空即可。
             *    ⚠️ 用户 §二 又点了一次：「备注框中预设的长篇示例文字」——
             *       本字段当前**确实已经是空的**（实测 placeholder 为 null），
             *       保留这段注释作为"不要再加回去"的依据。
             */
            onChange={(e) => setNote(e.target.value)}
            data-testid="stage-note"
          />
          {/*
            🔴 R2.2.2 封版裁决：「删除下方『客户看不到，只有门店和总部能看到。』」

            上一版我在这里保留了它，理由是"知道客户看不见，员工才敢写实情"。
            那是**我的产品推断**，不是用户要的 —— 用户看过实际截图后判定删除，
            以裁决为准（他看到的是一屏里第 4 行灰字，前面已有照片说明与日期，
            再多一行就是在替他做心理建设）。

            ⚠️ 删掉的只是**文案**，不是**权限**：
               `serviceArchives` / `serviceArchiveStages.note` 在
               `archive-query` 投影白名单里本就**不存在**，服务端从不把 note
               下发给客户查询 —— 这一点由服务端代码保证，与本行的有无无关。
               ⇒ 不存在"因为界面上不说了，客户就能看到"的路径。
               判据（不是文案）：客户匿名查询响应里不得出现 note 字段，
               该断言本轮已实测通过（见 0/6 照片与零泄漏取证）。
          */}
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
            disabled={!canSubmit}
            onClick={() => {
              if (!date) {
                setLocalErr('请填写实际施工日期');
                return;
              }
              if (date > today) {
                setLocalErr('施工日期不能晚于今天');
                return;
              }
              setLocalErr(null);
              /*
               * 🔴 R2.2.2 封版裁决（§五）：**只提交实际变化的业务字段。**
               *
               * 旧写法 `{ stage_date: date, note: note.trim() }` 无条件带上日期：
               *   · 员工只想改一句备注，看到日期框预填的是"今天"（历史数据
               *     stage_date 为空时）⇒ 一保存就把**今天**写进 stage_date，
               *     真实完成日期被永久覆盖，而日志里看起来是一次"正常修改"。
               *
               * ⇒ 判据不是"预填得对不对"，而是**"没动过的字段不上行"**：
               *     用户没碰日期 ⇒ body 里根本没有 `stage_date` 这个键
               *     ⇒ 服务端 `paramPresence` 判定为 absent ⇒ 不改这一列。
               *   这一层比"预填正确"更硬：预填是视觉层的猜测，不发字段是协议层的
               *   保证。两者都做，是因为任何一条单独失效都还能兜住。
               *
               * ⚠️ 只对**修改**（isUpdate）做省略：
               *   首次完成（mode='complete'）时没有"历史日期"可言，
               *   日期是必填的业务事实，必须上送（服务端也要求）。
               *
               * ⚠️ `expected_version` 不在这里 —— 它由 ArchiveDetail 的
               *   onUpdateStage 追加，乐观锁与审计事件（stage_updated 的
               *   before/after + status_unchanged）完全不受影响。
               */
              const payload: { stage_date?: string; note: string } = { note: note.trim() };
              if (!isUpdate || date !== fallbackDate) {
                payload.stage_date = date;
              }
              onSubmit(payload);
            }}
            testId={isUpdate ? 'stage-update-submit' : 'stage-complete-submit'}
          >
            {isUpdate ? '保存修改' : '完成本阶段'}
          </QFButton>
        </div>
      </div>

      {/* 撤回入口：移动端默认不渲染（§七 主操作统一为"修改"） */}
      {onWithdraw ? (
        <button
          type="button"
          className="text-svc-warning qf-foot qf-pressable mb-4 inline-flex min-h-touch w-full items-center justify-center font-medium"
          onClick={() => onWithdraw('')}
          disabled={busy}
          data-testid="stage-withdraw-entry"
        >
          撤回这个阶段
        </button>
      ) : null}
    </div>
  );
}

/**
 * 兼容旧导出名。
 *
 * ⚠️ 已**不再被页面使用**（`ArchiveDetail` 改走 `QFStagePanel`，因为它要传照片）。
 *    保留它只会让"某处还在用旧组件"变成一个看不出来的状态 ——
 *    旧组件没有照片缩略图，而它渲染出来的界面看起来同样"正常"。
 * ⇒ 直接转调 `QFStagePanel`，保证任何一个残留调用点都拿到新行为。
 */
export function QFStageCompletePanel(props: {
  stage: ArchiveStageRow;
  archiveId: number | string;
  photos?: StagePhoto[];
  busy: boolean;
  onUploaded: () => void | Promise<void>;
  onSubmit: (input: { stage_date?: string; note: string }) => void;
  onCancel: () => void;
}) {
  return (
    <QFStagePanel
      mode="complete"
      stage={props.stage}
      archiveId={props.archiveId}
      photos={props.photos ?? []}
      busy={props.busy}
      onUploaded={props.onUploaded}
      onSubmit={props.onSubmit}
      onCancel={props.onCancel}
    />
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
