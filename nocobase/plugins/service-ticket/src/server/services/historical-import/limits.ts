/**
 * 历史 Excel 导入 —— **资源上限与拒绝语义**（P11-3 第 2 项）
 *
 * ===========================================================================
 * 为什么限额要写成"集中常量 + 明确错误码"，而不是散落在解析代码里
 * ===========================================================================
 * 用户在 P11-3 第 2 项里点名要求：
 *   「对上传文件设置大小、工作表数量、总行数和解析资源上限，识别实际文件类型，
 *     拒绝不支持或损坏的文件。不得执行 Excel 公式、宏或外部链接 …
 *     对可能导致内存耗尽、压缩膨胀或长时间阻塞的输入设置保护措施。」
 *
 * 这些话术有一个共同的失效模式：**上限写成了"注释里的约定"**。
 * 只要有一个入口忘了检查，保护就等于不存在 —— 而且不会有任何断言变红
 * （超限文件照样解析成功，只是某天把进程 OOM 掉）。
 *
 * ⇒ 因此这里把上限做成**唯一事实来源**，并要求：
 *   ① 所有入口（HTTP 上传、批处理、验收脚本）都从本文件取上限；
 *   ② 超限一律**抛带错误码的错**，不做"尽力而为的截断"——
 *      截断会让"解析成功但少了一半行"看起来像成功（本项目最忌的那种静默）。
 *
 * ⚠️ 数字的取法（别把这些当成随手填的）：
 *   · 已知最大真实样本：`康乐电器9月原始数据.xlsx` Sheet1 465 行 × 27 列；
 *     `康乐 Sheet2` 106 行 × **64 列**（右侧一堆空列/财务列）。
 *     ⇒ 行上限给到 2 万、列上限 256，是"比真实大两个数量级但仍能兜住内存"的位置。
 *   · 文件体积：真实样本都是几百 KB 级；20 MB 已经远超正常门店月度表。
 *   · `MAX_EXPANDED_BYTES` 是**防 zip 膨胀**的：.xlsx 是 zip，
 *     一个小文件可以解出几十 GB（经典 zip-bomb）。所以在真正解析前先
 *     累加各条目声明的 `uncompressedSize`，超限直接拒绝，**不落地解压**。
 */
export const IMPORT_LIMITS = {
  /** 单个上传文件字节上限 */
  MAX_FILE_BYTES: 20 * 1024 * 1024,
  /** 解压后总字节上限（zip 膨胀保护；见头部说明） */
  MAX_EXPANDED_BYTES: 200 * 1024 * 1024,
  /** 单条目最大压缩比（> 此值判为可疑，直接拒绝） */
  MAX_COMPRESSION_RATIO: 200,
  /** 工作表数量上限 */
  MAX_SHEETS: 40,
  /** 单工作表数据行上限（不含表头） */
  MAX_ROWS_PER_SHEET: 20000,
  /** 整个工作簿数据行上限 */
  MAX_TOTAL_ROWS: 60000,
  /** 列数上限 */
  MAX_COLS: 256,
  /** 单元格文本长度上限（超出即截断并记 warning，不整批失败） */
  MAX_CELL_CHARS: 2000,
  /** 单个单元格里允许拆出的手机号个数上限 */
  MAX_PHONES_PER_CELL: 6,
  /** 表头探测最多向下看多少行（真实样本里"第一行标题、第二行才是表头"） */
  MAX_HEADER_SCAN_ROWS: 10,
  /** 单次解析墙钟上限（ms）—— 超时按"拒绝"处理，不返回半成品 */
  PARSE_TIMEOUT_MS: 60_000,
} as const;

/**
 * 拒绝原因的错误码。
 *
 * ⚠️ 这些码会被**导入报告**和**验收断言**两侧共用：
 *   断言必须按码比对，不能按"错误文案里有没有某个词"比对
 *   （本项目踩过：判据太宽会撞上合法值 —— 见 DEV-140）。
 */
export const IMPORT_REJECT = {
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  EXPANDED_TOO_LARGE: 'EXPANDED_TOO_LARGE',
  SUSPICIOUS_COMPRESSION: 'SUSPICIOUS_COMPRESSION',
  UNSUPPORTED_TYPE: 'UNSUPPORTED_TYPE',
  CORRUPT_FILE: 'CORRUPT_FILE',
  ENCRYPTED_FILE: 'ENCRYPTED_FILE',
  TOO_MANY_SHEETS: 'TOO_MANY_SHEETS',
  TOO_MANY_ROWS: 'TOO_MANY_ROWS',
  TOO_MANY_COLS: 'TOO_MANY_COLS',
  NO_HEADER: 'NO_HEADER',
  PARSE_TIMEOUT: 'PARSE_TIMEOUT',
  EMPTY_WORKBOOK: 'EMPTY_WORKBOOK',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  DEPENDENCY_UNSAFE_VERSION: 'DEPENDENCY_UNSAFE_VERSION',
} as const;

export type ImportRejectCode = (typeof IMPORT_REJECT)[keyof typeof IMPORT_REJECT];

/** 带错误码的拒绝异常 —— 上层据此生成报告，**绝不吞掉** */
export class HistoricalImportRejected extends Error {
  readonly code: ImportRejectCode;
  readonly detail: Record<string, unknown>;

  constructor(code: ImportRejectCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'HistoricalImportRejected';
    this.code = code;
    this.detail = detail;
  }
}
