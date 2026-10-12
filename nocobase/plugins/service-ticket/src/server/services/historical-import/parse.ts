/**
 * 历史 Excel 导入 —— **解析编排**（P11-3 第 2 项主体）
 *
 * ===========================================================================
 * 它做什么 / 绝不做什么
 * ===========================================================================
 * 做：
 *   ① 限额校验（文件大小 / 解压膨胀 / 工作表数 / 行数 / 列数）
 *   ② **按魔数**识别真实类型，伪造扩展名、HTML、CSV 一律拒绝
 *   ③ 用受控选项读工作簿（不算公式、不取宏、不抓外链）
 *   ④ 表头探测（真实样本里"第一行是标题、第二行才是表头"）
 *   ⑤ 抽出**原始行**（Excel 原始行号 + 原始单元格值）
 *   ⑥ 生成**标准化候选**（手机 / 日期 / 牌名型号），含糊的一律不猜
 *   ⑦ 按表头结构把每张工作表分成 售后 / 销售配送 / 待人工确认
 *   ⑧ 产出可读报告：每张表多少行、跳过了什么、为什么
 *
 * 绝不（用户原话）：
 *   · 不把销售 / 送货记录强行转成售后工单 ⇒ 分类为 `sales-or-delivery` 的表，
 *     **一行都不会进入 serviceRows**，只在报告里如实记数；
 *   · 不自动补造手机号 / 转换含糊日期 / 凭空推断服务类型；
 *   · 不创建任何正式工单、不写任何业务表 —— 那是 P11-3 后续项的事。
 *
 * ⚠️ 关于墙钟上限（如实说明能力边界）：
 *   SheetJS 的 `read()` 是**同步**的，一旦进入就无法中断。
 *   所以"长时间阻塞"真正的防线是**前置的字节上限 + zip 膨胀上限**
 *   （见 limits.ts / zip-guard.ts）；`PARSE_TIMEOUT_MS` 只能在
 *   **工作表之间**的边界上检查，超时就拒绝并返回已完成的报告。
 *   把这句话写清楚，比假装有超时更重要。
 */
import {
  IMPORT_LIMITS,
  IMPORT_REJECT,
  HistoricalImportRejected,
} from './limits';
import { detectWorkbookKind, extensionOf, assertSupportedWorkbook } from './file-type';
import { assertZipWithinLimits, statZipEntries } from './zip-guard';
import { loadXlsx } from './version-guard';
import {
  splitPhones,
  parseDateCell,
  splitDevices,
  classifyReviewResult,
  cleanText,
  rawToString,
  maskPhone,
} from './normalize';

// ---------------------------------------------------------------------------
// 列名同义词表
// ---------------------------------------------------------------------------
/**
 * ⚠️ 这份表的**唯一合法来源**是真实样本表头（2026-10-12 从七份门店文件逐列提取）。
 *    不要凭"可能还有别的叫法"往里加 —— 加错的后果是**静默错配**：
 *    比如把 `安装维修费`（康乐 Sheet2 的费用列）当成师傅列，就会把费用金额
 *    写进"服务人员"，而且不会有任何断言变红。
 *
 *    要加新同义词，先在真实文件里看到它，再连同"出自哪个文件哪一列"一起登记。
 */
export const COLUMN_SYNONYMS: Record<string, string[]> = {
  customerName: ['用户姓名', '姓名', '客户', '用户'],
  customerPhone: ['用户电话', '电话', '联系手机', '手机号', '顾客电话', '联系电话'],
  customerAddress: ['用户地址', '地址', '详细地址', '顾客地址'],
  device: ['牌名型号', '机器信息', '品牌型号'],
  quantity: ['数量', '台数', '机器台数'],
  serviceKind: ['性质', '单据性质', '维修性质'],
  purchaseDate: ['购机日期', '购买日期'],
  deliveryDate: ['配送时间', '安装时间', '要求送货日期', '要求期限'],
  receiveDate: ['接件日期'],
  finishDate: ['完工日期'],
  dispatchDate: ['派单日期'],
  fault: ['报修故障', '故障'],
  measure: ['维修措施', '处理方式'],
  technician: ['服务人员', '师傅', '送货人', '业务人员', '安装维修费'],
  reviewResult: ['回访结果', '服务评价'],
  reviewNote: ['回访说明', '回访记录', '回访备注'],
  reviewDate: ['回访日期', '回访时间'],
  storeHint: ['销售单位', '结算单位'],
};

/** 反查：列名 → 逻辑字段 */
const SYNONYM_TO_FIELD: Array<[string, string]> = [];
for (const [field, names] of Object.entries(COLUMN_SYNONYMS)) {
  for (const n of names) SYNONYM_TO_FIELD.push([n, field]);
}

/** 去掉空白/全角空格后匹配（真实表头里有 `机器\n台数` 与 `品牌 型号`） */
function canonicalHeader(h: string): string {
  return String(h ?? '').replace(/[\s\u00A0\u3000]+/g, '');
}

export interface ColumnMapping {
  /** 逻辑字段 → 该表里的列下标（未匹配到就没有该键） */
  fields: Record<string, number>;
  /** 未识别的列（如实列出，供人工映射阶段处理） */
  unmapped: Array<{ index: number; header: string }>;
  /** 同一逻辑字段命中了多个列（真实样本：康乐 Sheet2 `备注`×2） */
  ambiguous: Array<{ field: string; indexes: number[]; headers: string[] }>;
}

export function mapHeader(header: string[]): ColumnMapping {
  const fields: Record<string, number> = {};
  const ambiguous: ColumnMapping['ambiguous'] = [];
  const hits: Record<string, Array<{ index: number; header: string }>> = {};

  for (let i = 0; i < header.length; i++) {
    const raw = header[i] ?? '';
    const canon = canonicalHeader(raw);
    if (!canon) continue;
    for (const [name, field] of SYNONYM_TO_FIELD) {
      if (canonicalHeader(name) === canon) {
        (hits[field] = hits[field] || []).push({ index: i, header: raw });
        break;
      }
    }
  }

  const unmapped: ColumnMapping['unmapped'] = [];
  const recognized = new Set<number>();
  for (const [, list] of Object.entries(hits)) for (const h of list) recognized.add(h.index);

  for (const [field, list] of Object.entries(hits)) {
    if (list.length > 1) {
      ambiguous.push({ field, indexes: list.map((x) => x.index), headers: list.map((x) => x.header) });
    }
    // 多列同名时**取第一个**，并把其余列登记为 ambiguous ——
    // 不静默丢弃（真实样本里 `备注`×2，第二列往往是另一批跟进记录）
    fields[field] = list[0].index;
  }
  for (let i = 0; i < header.length; i++) {
    if (!recognized.has(i) && canonicalHeader(header[i] ?? '')) unmapped.push({ index: i, header: header[i] });
  }
  return { fields, unmapped, ambiguous };
}

// ---------------------------------------------------------------------------
// 工作表分类
// ---------------------------------------------------------------------------

export type SheetClass = 'service-install' | 'service-repair' | 'sales-or-delivery' | 'needs-review';

/** 售后信号（出现即说明这张表在记服务） */
const SERVICE_SIGNALS = [
  '安装时间', '接件日期', '完工日期', '报修故障', '维修措施', '处理日期',
  '机器信息', '派单日期', '服务人员', '师傅', '回访结果', '要求送货日期',
];
/** 销售 / 配送资料信号（与"购机日期"同时出现即基本可判定） */
const SALES_SIGNALS = ['收尾款金额', '物流送货人员', '单据号', '促销员', '业务员'];

/**
 * 分类**必须给出依据**，并且 `needs-review` 是**默认的安全值**。
 *
 * 为什么默认是 `needs-review` 而不是 `service-*`：
 *   用户要求"不得将所有非空行直接当成售后业务"。如果判不出来就当成售后，
 *   就等于把销售记录写成了服务记录 —— 而这种错误**事后极难发现**
 *   （销售单和服务单看起来都是"某人 + 电话 + 型号"）。
 */
export function classifySheet(header: string[], sheetName: string): { class: SheetClass; basis: string } {
  const canon = header.map(canonicalHeader);
  const has = (name: string) => canon.some((h) => h === canonicalHeader(name));
  const serviceHits = SERVICE_SIGNALS.filter(has);
  const salesHits = SALES_SIGNALS.filter(has);
  const name = canonicalHeader(sheetName);

  const repairSignals = ['接件日期', '完工日期', '报修故障', '维修措施', '处理日期', '机器信息'].filter(has);
  const installSignals = ['安装时间', '要求送货日期', '服务人员', '派单日期'].filter(has);

  if (repairSignals.length >= 2) {
    return { class: 'service-repair', basis: `维修类表头信号：${repairSignals.join('、')}` };
  }
  if (installSignals.length >= 2) {
    return { class: 'service-install', basis: `安装类表头信号：${installSignals.join('、')}` };
  }
  if (has('购机日期') && salesHits.length >= 1 && serviceHits.length === 0) {
    return {
      class: 'sales-or-delivery',
      basis: `有「购机日期」+ 销售/配送信号（${salesHits.join('、')}）且无任何售后信号 ⇒ 销售/配送资料`,
    };
  }
  if (serviceHits.length > 0) {
    return { class: 'service-install', basis: `售后信号较弱：${serviceHits.join('、')}；按安装类收下，仍需人工确认` };
  }
  if (name === '安装' || name === '维修') {
    return { class: name === '维修' ? 'service-repair' : 'service-install', basis: `工作表名为「${sheetName}」` };
  }
  return { class: 'needs-review', basis: '表头未命中任何已知售后/销售信号 ⇒ 需人工确认，不得自动导入' };
}

// ---------------------------------------------------------------------------
// 输出结构
// ---------------------------------------------------------------------------

export interface RowCandidate {
  /** Excel 原始行号（1-based，含表头行本身）—— **回溯用的锚** */
  sourceRow: number;
  /** 原始单元格值（已截断到 MAX_CELL_CHARS；null = 空单元格） */
  raw: Record<string, string | null>;
  /** 标准化候选（缺依据时为 null，**绝不填默认值**） */
  candidate: {
    customerName: string | null;
    customerPhones: Array<{ digits: string; kind: string; valid: boolean }>;
    customerAddress: string | null;
    devices: Array<{ model: string; quantity: number | null }>;
    serviceKind: string | null;
    dates: Record<string, { iso: string | null; basis: string; ambiguous: boolean }>;
    fault: string | null;
    measure: string | null;
    technician: string | null;
    reviewNote: string | null;
    /**
     * 服务结果（回访结果 / 服务评价）。
     *
     * ⚠️ 2026-10-12 前**没有**这个字段：`reviewResult` 明明被 `mapHeader` 映射到了
     *    （康乐 Sheet1 的第 20 列「回访结果」），却没人把它取出来 ——
     *    结果是"映射成功"与"结果可用"被混为一谈，整列为空也照样算干净数据。
     *    用户同一轮点名：**「业务类型待确认 0」不代表字段质量异常 0。**
     */
    reviewResult:
      | {
          value: string | null;
          state: 'ok' | 'empty' | 'unrecognized';
          /** 原始文本（**未识别时也要带上**，否则界面上只会显示"（空）"） */
          raw: string;
          note: string;
        }
      | null;
  };
  /** 这一行的处理提示（不含客户数据） */
  notes: string[];
}

/**
 * 一张工作表的**互斥台账**。
 *
 * ===========================================================================
 * 为什么必须有它（2026-10-12 用户第 1 条，这是一次真实的对账事故）
 * ===========================================================================
 * 报告里出现过「5 份 xlsx 合计 **3196** 数据行」与「逐文件相加 **3172**」
 * 相差 **24 行**却都被写成"对上了"。根因是同一份数据里混用了**两种口径**：
 *
 *   东山 Sheet1 的 `excelRows` = **873**（Excel 实际范围的物理行数）
 *   东山 Sheet1 的 `dataRows`  = **849**（873 扣掉 1 个表头行 + 23 个重复表头行）
 *
 *   873 + 831 + 569 + 341 + 582 = **3196**（物理行口径）
 *   849 + 831 + 569 + 341 + 582 = **3172**（数据行口径）
 *
 * 而「总 3953」「扣东山后 2323」用的都是**数据行**口径 —— 于是同一段文字里
 * 两种口径并存，且都自称正确。
 *
 * ⇒ 唯一出路是**一张能自证的台账**：每一行的物理行数必须等于
 *   各分类之和，差一点就报出来（见 `balance`）。
 *   **绝不允许靠改期望值把两个口径"对齐"** —— 那是把账做平，不是把账算对。
 */
export interface SheetLedger {
  /** Excel 实际范围的**物理行数**（含标题、表头、空行、重复表头） */
  excelRows: number;
  /** 标题行 + 表头行：`headerRow` 是 1-based 行号，它前面正好有 headerRow-1 行 */
  headerRows: number;
  /** 中途重复打出来的表头行 */
  repeatedHeaderRows: number;
  /** 全空行 */
  blankRows: number;
  /** 已分类为**售后**的数据行 */
  afterSalesRows: number;
  /** 已分类为**销售/配送**等被排除的数据行 */
  excludedRows: number;
  /** 业务类型**待判断**的数据行（既不售后也不销售配送） */
  undeterminedRows: number;
  /** 平衡校验：`excelRows` 减去上面六项之和，**必须为 0** */
  balance: number;
}

/**
 * 一张工作表的**字段质量异常**计数。
 *
 * ⚠️ 与 `SheetLedger` **刻意分开**：台账回答"这一行算哪一类"（互斥、可求和），
 *    质量回答"这一行的字段有多干净"（一行可同时命中多项，**不互斥**）。
 *    混在一张表里就会得出"售后 3104 行 = 干净 3104 行"这种错误结论。
 */
export interface SheetQuality {
  // ---------------------------------------------------------------------------
  // 四项**分类计数**（各自回答"这一类命中了多少行"）
  // ---------------------------------------------------------------------------
  /** 一格多个号码（不猜哪个是客户的） */
  multiPhoneRows: number;
  /** 至少一个日期字段含糊（缺年份 / 两位年份 / 自由文本） */
  ambiguousDateRows: number;
  /** 电话列存在但取不到合法手机号（含整列为空） */
  missingPhoneRows: number;
  /** 服务结果列存在但为空或取值不在已知集合内 */
  abnormalReviewRows: number;

  // ---------------------------------------------------------------------------
  // 🔴 两个**总量**口径 —— 2026-10-12 用户第 A.1 条点名要求区分
  // ---------------------------------------------------------------------------
  /**
   * **异常命中次数** = 四项之和。
   *
   * ⚠️ 它数的是"字段实例"，不是"行"。同一行同时"日期含糊 + 缺手机号 + 服务结果为空"
   *    会在这里 +3。
   */
  anomalyHits: number;
  /**
   * **涉及的唯一原始行数** = 至少命中一项的行数（每行**最多算一次**）。
   *
   * ===========================================================================
   * 为什么必须与 `anomalyHits` 分开（用户原话）
   * ===========================================================================
   *  「多手机号、含糊日期、缺手机号、服务结果异常**可能同时出现在同一行**，
   *    不得简单求和并称为唯一异常行数。」
   *
   * 这条要求指向一个非常容易被写出来的错误：把四个数字相加，然后写成
   * 「唯一异常行 N 行」。真实样本里这种**多重命中**确实存在
   * （例如一行既缺手机号、服务结果又为空），于是"求和"会把同一行数两遍，
   * 报出一个**大于该表实际行数**的"唯一行数"—— 而它看起来完全正常。
   *
   * ⇒ 两个口径同时给出，并且门禁断言 `anomalyHits >= rowsWithAnyAnomaly`；
   *    在真实样本上还要断言**确实不相等**（否则说明要么数据里没有多重命中、
   *    要么其中一项根本没被统计 —— 两种情况都要人看一眼）。
   */
  rowsWithAnyAnomaly: number;
}

export interface ParsedSheet {
  file: string;
  sheet: string;
  sheetIndex: number;
  /** Excel 实际范围的行数 / 列数 */
  excelRows: number;
  excelCols: number;
  /** 探测到的表头所在行（1-based Excel 行号）；0 = 没找到 */
  headerRow: number;
  header: string[];
  mapping: ColumnMapping;
  classification: SheetClass;
  classificationBasis: string;
  dataRowCount: number;
  blankRowCount: number;
  /** 重复表头出现的 Excel 行号（真实样本：东山 Sheet1 有 23 处） */
  repeatedHeaderRows: number[];
  mergedRangeCount: number;
  /** **互斥台账**（物理行 = 各分类之和，见 SheetLedger 的头部说明） */
  ledger: SheetLedger;
  /** **字段质量异常**（与台账分开，一行可命中多项） */
  quality: SheetQuality;
  /** 数据行（原始值 + 标准化候选） */
  rows: RowCandidate[];
}

export interface ParseResult {
  ok: boolean;
  file: { name: string; bytes: number; detectedKind: string; extension: string; extensionMatches: boolean };
  parser: { name: string; version: string; date1904: boolean };
  sheets: ParsedSheet[];
  totals: {
    sheets: number;
    dataRows: number;
    serviceRows: number;
    salesOrDeliveryRows: number;
    needsReviewRows: number;
    blankRows: number;
    repeatedHeaderRows: number;
    mergedRanges: number;
    // ---- 以下四项是**字段质量**计数，与"分类"无关（见 SheetQuality 的说明）----
    multiPhoneRows: number;
    ambiguousDateRows: number;
    missingPhoneRows: number;
    abnormalReviewRows: number;
    /**
     * 异常**命中次数**（四项之和）。
     * ⚠️ 这个数字**不是**"有多少行有问题" —— 下面那个才是。
     */
    anomalyHits: number;
    /** **涉及的唯一原始行数**（每行最多算一次）—— 要写"多少行有问题"就用它 */
    rowsWithAnyAnomaly: number;
    truncatedCells: number;
  };
  /** 汇总台账（把各表的 ledger 相加；`balance` 同样必须为 0） */
  ledger: SheetLedger;
  /** 汇总字段质量 */
  quality: SheetQuality;
  skipped: Array<{ sheet: string; reason: string }>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 表头探测：第 1 行非空数 ≤ 2 时，第 2 行才是真表头（真实样本：易田「9月维修回访表」） */
function findHeaderRow(aoa: Array<Array<unknown>>): { index: number; header: string[] } {
  for (let i = 0; i < Math.min(aoa.length, IMPORT_LIMITS.MAX_HEADER_SCAN_ROWS); i++) {
    const row = aoa[i] || [];
    const nonEmpty = row.filter((v) => rawToString(v).trim() !== '').length;
    if (nonEmpty >= 3) {
      return { index: i, header: row.map((v) => rawToString(v)) };
    }
  }
  return { index: -1, header: [] };
}

function truncateCell(value: string | null, counter: { n: number }): string | null {
  if (value === null) return null;
  if (value.length <= IMPORT_LIMITS.MAX_CELL_CHARS) return value;
  counter.n += 1;
  return value.slice(0, IMPORT_LIMITS.MAX_CELL_CHARS);
}

/**
 * 解析一个工作簿。
 *
 * ⚠️ 入口只接受 `Buffer`，**不接受路径**：调用方（上传层）必须先做大小检查。
 *    允许传路径的话，"限额"就变成一句空话 —— 任何人都能传一个 2 GB 的文件名进来。
 */
export function parseWorkbook(filename: string, buf: Buffer): ParseResult {
  const warnings: string[] = [];

  // ---- ① 文件大小 ----
  if (buf.length > IMPORT_LIMITS.MAX_FILE_BYTES) {
    throw new HistoricalImportRejected(
      IMPORT_REJECT.FILE_TOO_LARGE,
      `文件 ${buf.length} 字节超过上限 ${IMPORT_LIMITS.MAX_FILE_BYTES} 字节`,
      { bytes: buf.length, limit: IMPORT_LIMITS.MAX_FILE_BYTES },
    );
  }

  // ---- ② 真实类型（魔数）----
  const detected = detectWorkbookKind(buf, filename);
  if (detected.kind !== 'xlsx' && detected.kind !== 'xls') {
    throw new HistoricalImportRejected(
      IMPORT_REJECT.UNSUPPORTED_TYPE,
      `文件内容类型 ${detected.kind}（${detected.evidence}）不受支持`,
      { kind: detected.kind, evidence: detected.evidence },
    );
  }
  assertSupportedWorkbook(detected, filename);
  if (!detected.extensionMatches) {
    warnings.push(
      `扩展名 .${extensionOf(filename)} 与实际内容（${detected.kind}）不一致；` +
        '已按**实际内容**解析（内容是对的，只是名字起错了）',
    );
  }

  // ---- ③ zip 膨胀守卫（.xls 是 OLE2，跳过）----
  const zipStat = detected.kind === 'xlsx' ? statZipEntries(buf) : null;
  assertZipWithinLimits(zipStat, filename);

  // ---- ④ 依赖 + 版本守卫 ----
  const { version, module: XLSX } = loadXlsx();

  // ---- ⑤ 读工作簿（受控选项）----
  let wb: any;
  try {
    wb = XLSX.read(buf, {
      type: 'buffer',
      // 不算公式：SheetJS 只读缓存值，这里连公式串都不取出来
      cellFormula: false,
      // 不取 HTML 富文本（很多门店表里塞了 `<b>` 之类的垃圾）
      cellHTML: false,
      // 不加载宏 / 外部链接 / 其它嵌入对象
      bookVBA: false,
      bookDeps: false,
      bookFiles: false,
      // 稠密存储，减少对象数量（.xls 大表上内存差一倍以上）
      dense: true,
    });
  } catch (err) {
    const msg = (err as Error).message ?? '';
    const encrypted = /password|encrypt/i.test(msg);
    throw new HistoricalImportRejected(
      encrypted ? IMPORT_REJECT.ENCRYPTED_FILE : IMPORT_REJECT.CORRUPT_FILE,
      `工作簿读取失败：${(err as Error).name} ${msg}`,
      { encrypted },
    );
  }

  if (!wb || !Array.isArray(wb.SheetNames) || wb.SheetNames.length === 0) {
    throw new HistoricalImportRejected(IMPORT_REJECT.EMPTY_WORKBOOK, '工作簿里没有任何工作表', {});
  }
  if (wb.SheetNames.length > IMPORT_LIMITS.MAX_SHEETS) {
    throw new HistoricalImportRejected(
      IMPORT_REJECT.TOO_MANY_SHEETS,
      `工作表数 ${wb.SheetNames.length} 超过上限 ${IMPORT_LIMITS.MAX_SHEETS}`,
      { sheets: wb.SheetNames.length, limit: IMPORT_LIMITS.MAX_SHEETS },
    );
  }

  const date1904 = !!(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);
  if (date1904) {
    warnings.push('工作簿使用 1904 日期系统；已按 1904 制转换序列号（否则整体偏 4 年 1 天）');
  }

  const sheets: ParsedSheet[] = [];
  const skipped: ParseResult['skipped'] = [];
  const truncateCounter = { n: 0 };
  const startedAt = Date.now();
  let totalRowsSeen = 0;

  for (let si = 0; si < wb.SheetNames.length; si++) {
    const sheetName = wb.SheetNames[si];
    const ws = wb.Sheets[sheetName];

    // 墙钟上限：只能在**工作表边界**检查（见头部的能力边界说明）
    if (Date.now() - startedAt > IMPORT_LIMITS.PARSE_TIMEOUT_MS) {
      throw new HistoricalImportRejected(
        IMPORT_REJECT.PARSE_TIMEOUT,
        `解析超过 ${IMPORT_LIMITS.PARSE_TIMEOUT_MS} ms 仍未完成，已拒绝（不返回半成品）`,
        { completedSheets: sheets.length, totalSheets: wb.SheetNames.length },
      );
    }

    if (!ws || !ws['!ref']) {
      skipped.push({ sheet: sheetName, reason: '空工作表（无单元格范围）' });
      continue;
    }

    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows = range.e.r - range.s.r + 1;
    const cols = range.e.c - range.s.c + 1;

    if (cols > IMPORT_LIMITS.MAX_COLS) {
      skipped.push({ sheet: sheetName, reason: `列数 ${cols} 超过上限 ${IMPORT_LIMITS.MAX_COLS}` });
      continue;
    }
    if (rows - 1 > IMPORT_LIMITS.MAX_ROWS_PER_SHEET) {
      throw new HistoricalImportRejected(
        IMPORT_REJECT.TOO_MANY_ROWS,
        `工作表「${sheetName}」数据行 ${rows - 1} 超过上限 ${IMPORT_LIMITS.MAX_ROWS_PER_SHEET}`,
        { sheet: sheetName, rows: rows - 1, limit: IMPORT_LIMITS.MAX_ROWS_PER_SHEET },
      );
    }

    const aoa: Array<Array<unknown>> = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      blankrows: true, // **保留空行**：必须如实计入，不能悄悄吃掉
      defval: null,
      raw: false,
    });

    const found = findHeaderRow(aoa);
    if (found.index < 0) {
      skipped.push({ sheet: sheetName, reason: `前 ${IMPORT_LIMITS.MAX_HEADER_SCAN_ROWS} 行内找不到 ≥3 列非空的表头` });
      continue;
    }
    const header = found.header.slice(0, cols);
    const mapping = mapHeader(header);
    const cls = classifySheet(header, sheetName);
    const headerNorm = header.map((h) => canonicalHeader(h));

    const mergedRangeCount = Array.isArray(ws['!merges']) ? ws['!merges'].length : 0;
    if (mergedRangeCount > 0) {
      warnings.push(
        `工作表「${sheetName}」有 ${mergedRangeCount} 个合并单元格；` +
          '合并只在左上角有值，其余为 null —— 本阶段**不**做向下填充（fill 属后续清洗项）',
      );
    }

    const rowOut: RowCandidate[] = [];
    const repeatedHeaderRows: number[] = [];
    let blankRowCount = 0;
    let multiPhoneRows = 0;
    let ambiguousDateRows = 0;
    let missingPhoneRows = 0;
    let abnormalReviewRows = 0;
    /**
     * 🔴 本行是否命中**任意**一项异常 —— 每行**最多计一次**。
     *
     * ⚠️ 它必须与上面四个分类计数**同时**维护，不能在末尾用"四项之和"推出来：
     *    四项之和是"命中次数"，而这里是"涉及的行数"，两者在有行多重命中时不相等。
     *    （用户第 A.1 条点名的就是这个混用。）
     */
    let rowsWithAnyAnomaly = 0;

    for (let i = found.index + 1; i < aoa.length; i++) {
      const row = aoa[i] || [];
      const excelRow = i + 1; // Excel 是 1-based
      const nonEmpty = row.filter((v) => rawToString(v).trim() !== '').length;
      if (nonEmpty === 0) {
        blankRowCount += 1;
        continue;
      }
      // 与表头完全相同的行 ⇒ 中途重复打出来的表头（真实样本：东山 Sheet1 有 23 处）
      if (header.length && row.slice(0, header.length).every((v, k) => rawToString(v).trim() === headerNorm[k])) {
        repeatedHeaderRows.push(excelRow);
        continue;
      }

      totalRowsSeen += 1;
      if (totalRowsSeen > IMPORT_LIMITS.MAX_TOTAL_ROWS) {
        throw new HistoricalImportRejected(
          IMPORT_REJECT.TOO_MANY_ROWS,
          `整个工作簿数据行超过上限 ${IMPORT_LIMITS.MAX_TOTAL_ROWS}`,
          { limit: IMPORT_LIMITS.MAX_TOTAL_ROWS },
        );
      }

      const notes: string[] = [];
      const raw: Record<string, string | null> = {};
      for (let c = 0; c < Math.min(header.length, cols); c++) {
        raw[header[c] ? `c${c}` : `c${c}`] = truncateCell(row[c] == null ? null : rawToString(row[c]), truncateCounter);
      }
      const cellAt = (field: string): string | null => {
        const idx = mapping.fields[field];
        if (idx === undefined) return null;
        const v = row[idx];
        return v == null ? null : rawToString(v);
      };

      // ---- 本行的异常命中标记（每行最多计一次）----
      //
      // ⚠️ 刻意**不**用"四个计数是否有人加过"来推 —— 那样一旦将来新增一类异常
      //    而忘了在这里置位，总数就会静默变小（而分类计数是对的，看不出矛盾）。
      //    这里显式维护，并在下面与四项**分别**断言。
      let rowHasAnomaly = false;

      // 手机号
      const phoneCell = cellAt('customerPhone');
      const phoneParsed = splitPhones(phoneCell);
      if (phoneParsed.candidates.length > 1) {
        multiPhoneRows += 1;
        rowHasAnomaly = true;
      }
      const validMobiles = phoneParsed.candidates.filter((p) => p.kind === 'mobile' && p.valid);
      const phoneColumnMapped = mapping.fields.customerPhone !== undefined;
      // ⚠️ 判据是"**拆不出合法手机号**"，不是"单元格为空"：
      //    整列为空（映射到了但一个值都没有）同样属于"取不到手机号"，
      //    而它恰恰是最容易被漏掉的一种 —— 因为分类照样成功。
      if (phoneColumnMapped && validMobiles.length === 0) {
        missingPhoneRows += 1;
        rowHasAnomaly = true;
        notes.push(
          phoneCell && phoneCell.trim() !== ''
            ? '电话列有值但拆不出合法手机号'
            : '电话列为空',
        );
      }

      // 日期（每个映射到的日期字段各解析一次，互不干扰）
      const dates: Record<string, { iso: string | null; basis: string; ambiguous: boolean }> = {};
      let rowAmbiguous = false;
      for (const field of ['purchaseDate', 'deliveryDate', 'receiveDate', 'finishDate', 'dispatchDate', 'reviewDate']) {
        const cell = cellAt(field);
        if (cell === null || cell.trim() === '') continue;
        const parsed = parseDateCell(cell, date1904);
        dates[field] = { iso: parsed.iso, basis: parsed.basis, ambiguous: parsed.ambiguous };
        if (parsed.ambiguous) rowAmbiguous = true;
      }
      if (rowAmbiguous) {
        ambiguousDateRows += 1;
        rowHasAnomaly = true;
      }

      // 牌名型号
      const deviceParsed = splitDevices(cellAt('device'));

      const nameParsed = cleanText(cellAt('customerName'));
      const addrParsed = cleanText(cellAt('customerAddress'));

      // 服务结果：列映射到了才判；没映射就不算异常（没有这个字段 ≠ 字段有质量问题）
      const reviewMapped = mapping.fields.reviewResult !== undefined;
      const reviewParsed = reviewMapped ? classifyReviewResult(cellAt('reviewResult')) : null;
      if (reviewParsed && reviewParsed.state !== 'ok') {
        abnormalReviewRows += 1;
        rowHasAnomaly = true;
        notes.push(reviewParsed.state === 'empty' ? '服务结果为空' : '服务结果取值不在已知集合内');
      }

      if (rowHasAnomaly) rowsWithAnyAnomaly += 1;

      rowOut.push({
        sourceRow: excelRow,
        raw,
        candidate: {
          customerName: nameParsed.value || null,
          customerPhones: phoneParsed.candidates.map((p) => ({ digits: p.digits, kind: p.kind, valid: p.valid })),
          customerAddress: addrParsed.value || null,
          devices: deviceParsed.devices,
          serviceKind: cleanText(cellAt('serviceKind')).value || null,
          dates,
          fault: cleanText(cellAt('fault')).value || null,
          measure: cleanText(cellAt('measure')).value || null,
          technician: cleanText(cellAt('technician')).value || null,
          reviewNote: cleanText(cellAt('reviewNote')).value || null,
          reviewResult: reviewParsed
            ? {
                value: reviewParsed.value,
                state: reviewParsed.state,
                raw: reviewParsed.raw,
                note: reviewParsed.note,
              }
            : null,
        },
        notes,
      });
    }

    const isService = cls.class === 'service-install' || cls.class === 'service-repair';
    const isExcluded = cls.class === 'sales-or-delivery';
    const isUndetermined = cls.class === 'needs-review';
    const ledger: SheetLedger = {
      excelRows: rows,
      headerRows: found.index + 1,
      repeatedHeaderRows: repeatedHeaderRows.length,
      blankRows: blankRowCount,
      afterSalesRows: isService ? rowOut.length : 0,
      excludedRows: isExcluded ? rowOut.length : 0,
      undeterminedRows: isUndetermined ? rowOut.length : 0,
      balance: 0, // 下一行立刻算出真值
    };
    ledger.balance =
      ledger.excelRows -
      (ledger.headerRows +
        ledger.repeatedHeaderRows +
        ledger.blankRows +
        ledger.afterSalesRows +
        ledger.excludedRows +
        ledger.undeterminedRows);

    sheets.push({
      file: filename,
      sheet: sheetName,
      sheetIndex: si,
      excelRows: rows,
      excelCols: cols,
      headerRow: found.index + 1,
      header,
      mapping,
      classification: cls.class,
      classificationBasis: cls.basis,
      dataRowCount: rowOut.length,
      blankRowCount,
      repeatedHeaderRows,
      mergedRangeCount,
      ledger,
      quality: {
        multiPhoneRows,
        ambiguousDateRows,
        missingPhoneRows,
        abnormalReviewRows,
        // 「命中次数」= 四项之和；「涉及行数」= 独立统计（每行最多一次）。
        // ⚠️ 两者**不是**同一个东西：有行多重命中时前者大于后者。
        anomalyHits: multiPhoneRows + ambiguousDateRows + missingPhoneRows + abnormalReviewRows,
        rowsWithAnyAnomaly,
      },
      rows: rowOut,
    });
  }

  const serviceRows = sheets.filter((s) => s.classification === 'service-install' || s.classification === 'service-repair')
    .reduce((n, s) => n + s.dataRowCount, 0);
  const salesRows = sheets.filter((s) => s.classification === 'sales-or-delivery')
    .reduce((n, s) => n + s.dataRowCount, 0);
  const reviewRows = sheets.filter((s) => s.classification === 'needs-review')
    .reduce((n, s) => n + s.dataRowCount, 0);

  const sumLedger = (key: keyof SheetLedger): number =>
    sheets.reduce((n, s) => n + (s.ledger[key] as number), 0);
  const sumQuality = (key: keyof SheetQuality): number =>
    sheets.reduce((n, s) => n + (s.quality[key] as number), 0);

  const totalLedger: SheetLedger = {
    excelRows: sumLedger('excelRows'),
    headerRows: sumLedger('headerRows'),
    repeatedHeaderRows: sumLedger('repeatedHeaderRows'),
    blankRows: sumLedger('blankRows'),
    afterSalesRows: sumLedger('afterSalesRows'),
    excludedRows: sumLedger('excludedRows'),
    undeterminedRows: sumLedger('undeterminedRows'),
    balance: 0,
  };
  totalLedger.balance =
    totalLedger.excelRows -
    (totalLedger.headerRows +
      totalLedger.repeatedHeaderRows +
      totalLedger.blankRows +
      totalLedger.afterSalesRows +
      totalLedger.excludedRows +
      totalLedger.undeterminedRows);

  return {
    ok: true,
    file: {
      name: filename,
      bytes: buf.length,
      detectedKind: detected.kind,
      extension: extensionOf(filename),
      extensionMatches: detected.extensionMatches,
    },
    parser: { name: 'xlsx', version, date1904 },
    sheets,
    totals: {
      sheets: sheets.length,
      dataRows: sheets.reduce((n, s) => n + s.dataRowCount, 0),
      serviceRows,
      salesOrDeliveryRows: salesRows,
      needsReviewRows: reviewRows,
      blankRows: sheets.reduce((n, s) => n + s.blankRowCount, 0),
      repeatedHeaderRows: sheets.reduce((n, s) => n + s.repeatedHeaderRows.length, 0),
      mergedRanges: sheets.reduce((n, s) => n + s.mergedRangeCount, 0),
      // ⚠️ 四项质量计数**全部**取自 `sheet.quality`（单一来源）。
      //    本文件曾经在 `totals` 里按 `candidate` 重新算一遍多手机号与含糊日期 ——
      //    那正是"同一段解析逻辑出现两次"（DEV-106 同型）：两处判据只要漂移一点，
      //    报告里就会出现两个互相矛盾的数字，而**两个都自称是对的**。
      multiPhoneRows: sumQuality('multiPhoneRows'),
      ambiguousDateRows: sumQuality('ambiguousDateRows'),
      missingPhoneRows: sumQuality('missingPhoneRows'),
      abnormalReviewRows: sumQuality('abnormalReviewRows'),
      anomalyHits: sumQuality('anomalyHits'),
      rowsWithAnyAnomaly: sumQuality('rowsWithAnyAnomaly'),
      truncatedCells: truncateCounter.n,
    },
    ledger: totalLedger,
    quality: {
      multiPhoneRows: sumQuality('multiPhoneRows'),
      ambiguousDateRows: sumQuality('ambiguousDateRows'),
      missingPhoneRows: sumQuality('missingPhoneRows'),
      abnormalReviewRows: sumQuality('abnormalReviewRows'),
      // ⚠️ 汇总口径与单表口径必须**同构**：
      //    这里同样给出"命中次数"与"涉及行数"两个数字，不在汇总层把它们混起来。
      //    （此前 `totals` 里只给了四项分类计数，用的人很容易顺手相加 —— 那是错的。）
      anomalyHits: sumQuality('anomalyHits'),
      rowsWithAnyAnomaly: sumQuality('rowsWithAnyAnomaly'),
    },
    skipped,
    warnings,
  };
}

/** 供报告/日志脱敏使用（重新导出，避免调用方各自抄一份） */
export { maskPhone };
