/**
 * 历史 Excel 导入（historical-import）—— 模块出口
 *
 * P11-3 第 2 项交付"解析 + 原始/标准化候选 + 报告"；
 * 第 3 项在此之上追加"人工映射 + 双层存储 + 分类/异常状态 + 隔离暂存"。
 *
 * 🔴 仍**不包含**：正式导入（写工单）、门店正式归档、跨文件自动合并 ——
 *    那些是 P11-3 后续项，按用户给的顺序逐个来。
 */
export { IMPORT_LIMITS, IMPORT_REJECT, HistoricalImportRejected } from './limits';
export type { ImportRejectCode } from './limits';
export { detectWorkbookKind, assertSupportedWorkbook, extensionOf } from './file-type';
export type { DetectedType, WorkbookKind } from './file-type';
export { statZipEntries, assertZipWithinLimits } from './zip-guard';
export type { ZipEntriesStat } from './zip-guard';
export {
  loadXlsx,
  gteSemver,
  parseSemver,
  XLSX_MIN_SAFE_VERSION,
  XLSX_MIN_SAFE_VERSIONS,
} from './version-guard';
export {
  rawToString,
  cleanText,
  splitPhones,
  parseDateCell,
  serialToIso,
  splitDevices,
  classifyReviewResult,
  REVIEW_RESULT_KNOWN,
  REVIEW_RESULT_KNOWN_FROM_SAMPLES,
  maskPhone,
} from './normalize';
export type {
  PhoneCandidate,
  DateCandidate,
  DeviceCandidate,
  ReviewResultCandidate,
} from './normalize';
export { escapeForSpreadsheet, needsSpreadsheetEscape } from './spreadsheet-escape';
export { COLUMN_SYNONYMS, mapHeader, classifySheet, parseWorkbook } from './parse';
export type {
  ColumnMapping,
  ParsedSheet,
  ParseResult,
  RowCandidate,
  SheetClass,
  SheetLedger,
  SheetQuality,
} from './parse';

// ---- P11-3 第 3 项：映射 / 分代 / 双层存储 ----
export {
  MAPPING_FIELDS,
  MAPPING_FIELD_LABELS,
  DISPOSITIONS,
  applyMapping,
  buildSourceKey,
} from './mapping';
export type {
  MappingFieldDef,
  SheetMapping,
  MappingTemplate,
  Disposition,
  StandardizedRow,
  ApplyMappingInput,
  ApplyMappingResult,
} from './mapping';
export {
  createHistoricalImportStore,
  hashFile,
  HistoricalImportError,
} from './store';
export type {
  HistoricalImportStore,
  AttributionState,
  VisibilityScope,
  BatchStage,
  UploaderContext,
  CreateBatchInput,
  StoredBatch,
  HistoricalImportStoreDeps,
} from './store';
