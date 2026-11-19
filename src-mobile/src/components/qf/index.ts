/**
 * QF 设计系统 · R2.2.1 统一组件
 * =============================================================================
 * 用户第 十四 节列了 15 个建议组件。本目录按**页面真实需要**落地，
 * 不为了凑数而生造 —— 每多一个"从没被用过的组件"，就多一份漂移源。
 *
 * 目录结构：
 *   primitives.tsx   基础块：QFButton / QFIconButton / QFStatusBadge / QFCard
 *   fields.tsx       表单：QFFormField / QFSegmented / QFGridSelect / QFSelectRow
 *   list.tsx         QFListSection / QFRow / QFServiceCard / QFInfoRow / QFSearchField
 *   states.tsx       QFEmptyState / QFErrorState / QFLoadingSkeleton
 *   hvac.tsx         QFStageTimeline / QFPhotoUploader（暖通现场操作）
 *   sheet.tsx        QFConfirmSheet（二次确认，经典 iOS Action Sheet 形态）
 *
 * =============================================================================
 * 三条铁律（贯穿本目录，改动前先读）
 * =============================================================================
 * ① **不许出现胶囊圆角**，除了 `QFStatusBadge`（iOS 里 tag 就是胶囊，
 *    `lists-and-tables.md › Content` 允许）。这条有门禁：
 *    `scripts/qf-design-gate.mjs` 会断言"可点元素的 border-radius ≠ 9999px，
 *    除非 class 含 qf-badge"。
 *
 * ② **字号只能来自 `qf-tokens.ts` 的 6 档**。禁止 `text-[14px]` 这种裸写 ——
 *    14 不在 Dynamic Type 表里，14 与 13/15 并列时层级就模糊了。
 *
 * ③ **触控区一律 ≥44×44**，靠 `.qf-control` / `.qf-cta` / `qf-icon-btn` 保证，
 *    不逐个写 `h-11` —— 逐个写必然漏一处，而漏掉的那处只会表现为"有点难点"，
 *    没有任何报错。
 */

export { QFButton, QFIconButton, QFStatusBadge, QFCard } from './primitives';
export { QFFormField, QFSegmented, QFGridSelect, QFSelectRow } from './fields';
export { QFListSection, QFRow, QFServiceCard, QFInfoRow, QFSearchField } from './list';
export { QFEmptyState, QFNarrowEmptyState, QFErrorState, QFLoadingSkeleton, describeQFError, ERROR_CODE_TEXT, type QFErrorInfo } from './states';
export { QFStageTimeline, QFStagePanel, QFStageCompletePanel, QFStageWithdrawPanel } from './hvac';
export { QFPhotoUploader, QFPhotoGrid, QFStagePhotoManager, type StagePhoto } from './photo-uploader';
export { QFConfirmSheet, useQFConfirm, type QFConfirmSpec } from './sheet';
export { QFUnavailableBlock } from './fields';
export { stageSummaryOf, maskMobile, absDate, stageLabel, type QFArchiveLike } from './list';
