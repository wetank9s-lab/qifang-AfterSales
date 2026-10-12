/**
 * 全部 collection 定义的汇总入口。
 *
 * 顺序无关紧要（NocoBase 内部会处理依赖），这里按"主数据 → 业务 → 支撑"排列，
 * 便于阅读与与 docs/DATA-MODEL.md 对照。
 *
 * 共 15 张表：
 *   主数据   stores, storeUsers
 *   业务     serviceTickets, serviceVisits, serviceVisitPhotos, ticketEvents, smsLogs
 *   支撑     dailySequences, apiGuards, idempotencyRecords, serviceSettings, exportAudits
 *   历史导入 historicalImportBatches, historicalImportRows, historicalImportCandidates
 *
 * 注 1：Phase 0 的 docs/DEV-PLAN.md 中写的是"注册 9 个 collection"，
 *       而 docs/DATA-MODEL.md 定义了 11 张表。此处以数据模型文档为准（11 张），
 *       差异记入 docs/DEVIATIONS.md DEV-11。
 * 注 3：Phase 9 新增第 12 张表 `exportAudits`（导出审计，见 docs/DEVIATIONS.md DEV-91）。
 *       它**不复用 ticket_events** —— 后者 `ticket_id` 为 `allowNull:false`，
 *       而"导出"是跨工单事件。数据模型文档同步补 §13。
 * 注 4：Phase 11 / P11-3 新增第 13~15 张表 `historicalImport*` —— 历史 Excel 的
 *       **原始层 + 标准化层**双层存储。之所以是三张而不是一张：
 *         批次（一次上传的事实）/ 原始行（原样留存，永不覆盖）/
 *         标准化候选（按 mapping_version 分代，重新映射产生新结果而非覆盖旧结果）。
 *       三者职责互不重叠，合成一张表会让"不得覆盖原始数据"变成一句无法验证的空话。
 *       ⚠️ 本阶段这三张表**不产出任何正式工单**：`stage` 只有 staging/archived/voided，
 *       "转成当前 NEW 工单"是 P11-3 后续项的事。
 *
 * 注 2：配置表在文档里叫 systemSettings，本插件实际叫 serviceSettings ——
 *       因为 NocoBase 核心已占用 `systemSettings` 这个名字（会静默跳过注册）。
 *       见 docs/DEVIATIONS.md DEV-15。
 */
import stores from './stores';
import storeUsers from './storeUsers';
import serviceTickets from './serviceTickets';
import serviceVisits from './serviceVisits';
import serviceVisitPhotos from './serviceVisitPhotos';
import ticketEvents from './ticketEvents';
import smsLogs from './smsLogs';
import dailySequences from './dailySequences';
import apiGuards from './apiGuards';
import idempotencyRecords from './idempotencyRecords';
import serviceSettings from './serviceSettings';
import exportAudits from './exportAudits';
// Phase 11 / P11-3：历史 Excel 导入（批次 / 原始层 / 标准化层）
import historicalImportBatches from './historicalImportBatches';
import historicalImportRows from './historicalImportRows';
import historicalImportCandidates from './historicalImportCandidates';

export const ALL_COLLECTIONS = [
  stores,
  storeUsers,
  serviceTickets,
  serviceVisits,
  serviceVisitPhotos,
  ticketEvents,
  smsLogs,
  dailySequences,
  apiGuards,
  idempotencyRecords,
  serviceSettings,
  exportAudits,
  historicalImportBatches,
  historicalImportRows,
  historicalImportCandidates,
];

/**
 * PostgreSQL 中的实际表名。
 *
 * ⚠️ 这些下划线表名**不是** NocoBase 的默认行为 —— NocoBase 默认
 *    `underscored: false`，会把 `serviceTickets` 原样建成带双引号的驼峰表。
 *    之所以是下划线，是因为本插件所有 collection 都经 `defineAppCollection`
 *    （见 ./_helpers.ts）强制开启了 `underscored: true`。
 *    改动这个前提会让本清单、docs/DATA-MODEL.md 与 scripts/smoke-test.mjs 同时失效。
 *
 * ⚠️ 清单里**不能**出现 `system_settings` —— 那是 NocoBase 核心表名的变体，
 *    本插件的配置表已改名为 service_settings 以避开冲突（DEV-15）。
 */
export const EXPECTED_TABLE_NAMES = [
  'stores',
  'store_users',
  'service_tickets',
  'service_visits',
  'service_visit_photos',
  'ticket_events',
  'sms_logs',
  'daily_sequences',
  'api_guards',
  'idempotency_records',
  'service_settings',
  'export_audits',
  'historical_import_batches',
  'historical_import_rows',
  'historical_import_candidates',
];

export {
  stores,
  storeUsers,
  serviceTickets,
  serviceVisits,
  serviceVisitPhotos,
  ticketEvents,
  smsLogs,
  dailySequences,
  apiGuards,
  idempotencyRecords,
  serviceSettings,
  exportAudits,
  historicalImportBatches,
  historicalImportRows,
  historicalImportCandidates,
};
