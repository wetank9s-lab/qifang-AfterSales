/**
 * 历史 Excel 导入（historical-import）—— 模块出口
 *
 * P11-3 第 2 项只交付"解析 + 原始/标准化候选 + 报告"，
 * **不包含**字段映射交互、预览、去重、正式导入、转服务单 ——
 * 那些是 P11-3 第 3~8 项的内容，按用户给的顺序逐个来。
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
  maskPhone,
} from './normalize';
export type { PhoneCandidate, DateCandidate, DeviceCandidate } from './normalize';
export { escapeForSpreadsheet, needsSpreadsheetEscape } from './spreadsheet-escape';
export { COLUMN_SYNONYMS, mapHeader, classifySheet, parseWorkbook } from './parse';
export type { ColumnMapping, ParsedSheet, ParseResult, RowCandidate, SheetClass } from './parse';
