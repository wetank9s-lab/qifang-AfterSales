/**
 * 历史 Excel 导入 —— **人工映射 + 标准化分代**（P11-3 第 3 项 · 3.3 / 3.4）
 *
 * ===========================================================================
 * 这一层回答三件事
 * ===========================================================================
 *  ① 门店人员在界面上把"Excel 第几列"指给"哪个业务字段" ⇒ `applyMapping()`
 *  ② 指完之后每行**会被洗成什么样** ⇒ 产出 `fields`（标准化候选）+ `rawRefs`（原始引用）
 *  ③ 这一行**归哪一类**（可导入 / 需人工确认 / 疑似重复 / 非售后排除 / 解析错误）
 *
 * ===========================================================================
 * 🔴 三条不可退让的边界（用户 2026-10-12 第 3/4 条）
 * ===========================================================================
 *  ① **不同文件的列顺序可以完全不同** ⇒ 映射是 `{ 逻辑字段: 列下标 }` 的字典，
 *     不是"第 1 列必须是姓名"的位置约定。七份真实文件的表头本来就各不相同。
 *  ② **东山的 849 行销售/配送不会因为改映射变成售后** ⇒ `disposition` 由
 *     **工作表的表头结构**裁决（见 parse.ts 的 classifySheet），
 *     **与映射无关**：你把「购机日期」映射到"服务日期"、把「物流送货人员」
 *     映射到"师傅"，那一行的 `disposition` 仍然是 `excluded`。
 *     ⚠️ 这必须**结构性地**成立，而不是"记得别那么做" —— 所以本文件里
 *     `disposition` 的计算**根本不读** mapping，只读 sheet 的分类。
 *  ③ **一格多号保留原文、标异常，不猜哪个是客户的**；
 *     **含糊日期保留原值，绝不补年份、绝不转成确定日期**。
 *
 * ===========================================================================
 * 关于"重新映射要生成新的可追溯结果"
 * ===========================================================================
 * 本模块**只产出**结果（纯函数），**不写库**；写库在 `store.ts`。
 * 纯函数是刻意的：同一份 (原始行, 映射) 无论算多少次结果都一样 ——
 * 于是"v1 和 v3 的差异"只可能来自映射本身，可以放心做前后对照。
 */
import { splitPhones, parseDateCell, splitDevices, classifyReviewResult, cleanText, rawToString } from './normalize';

/** 可被映射的**业务字段**（界面上就是这些下拉项） */
export interface MappingFieldDef {
  field: string;
  label: string;
  /** 不映射它会怎样（界面提示用，写给非技术人员看） */
  requiredFor: 'import' | 'confirm' | 'none';
  hint: string;
}

/**
 * ⚠️ 这份清单同时是**界面**与**服务端**的唯一来源 —— 两边各写一份的下场是
 *    "页面上能选、服务端不认"（或反过来），而两种都不会报错。
 */
export const MAPPING_FIELDS: MappingFieldDef[] = [
  { field: 'customerName', label: '客户姓名', requiredFor: 'import', hint: '服务对象的称呼' },
  { field: 'customerPhone', label: '联系电话', requiredFor: 'import', hint: '拆不出合法手机号的行会被标成需人工确认' },
  { field: 'customerAddress', label: '服务地址', requiredFor: 'confirm', hint: '上门位置' },
  { field: 'device', label: '牌名型号', requiredFor: 'confirm', hint: '一个格子写了多台设备时会自动拆开' },
  { field: 'quantity', label: '数量', requiredFor: 'none', hint: '台数' },
  { field: 'serviceKind', label: '服务性质', requiredFor: 'none', hint: '维修 / 安装 之类' },
  { field: 'purchaseDate', label: '购机日期', requiredFor: 'none', hint: '两位年份的日期不会被补成 20xx' },
  { field: 'deliveryDate', label: '配送/安装日期', requiredFor: 'none', hint: '' },
  { field: 'receiveDate', label: '接件日期', requiredFor: 'none', hint: '' },
  { field: 'finishDate', label: '完工日期', requiredFor: 'none', hint: '' },
  { field: 'dispatchDate', label: '派单日期', requiredFor: 'none', hint: '' },
  { field: 'reviewDate', label: '回访日期', requiredFor: 'none', hint: '' },
  { field: 'fault', label: '报修故障', requiredFor: 'none', hint: '' },
  { field: 'measure', label: '维修措施', requiredFor: 'none', hint: '' },
  { field: 'technician', label: '服务人员', requiredFor: 'none', hint: '' },
  { field: 'reviewResult', label: '服务结果', requiredFor: 'none', hint: '空着或不认识的取值不会猜' },
  { field: 'reviewNote', label: '回访记录', requiredFor: 'none', hint: '' },
  { field: 'storeHint', label: '销售单位', requiredFor: 'none', hint: '⚠️ 仅供参考，**不会**据此写归属门店' },
];

export const MAPPING_FIELD_LABELS: Record<string, string> = Object.fromEntries(
  MAPPING_FIELDS.map((f) => [f.field, f.label]),
);

/** 日期型字段（解析时要带上工作簿的日期系统） */
const DATE_FIELDS = [
  'purchaseDate',
  'deliveryDate',
  'receiveDate',
  'finishDate',
  'dispatchDate',
  'reviewDate',
];

/** 一张工作表的映射（**每份文件每张表各一份**） */
export interface SheetMapping {
  headerRow: number;
  fields: Record<string, number>;
}

export interface MappingTemplate {
  /** 键是工作表名 */
  sheets: Record<string, SheetMapping>;
}

/** 处置分类（互斥、可求和） */
export type Disposition = 'importable' | 'needs-confirm' | 'duplicate' | 'excluded' | 'parse-error';

export const DISPOSITIONS: Array<{ value: Disposition; label: string }> = [
  { value: 'importable', label: '可导入候选' },
  { value: 'needs-confirm', label: '需人工确认' },
  { value: 'duplicate', label: '疑似重复' },
  { value: 'excluded', label: '非售后排除' },
  { value: 'parse-error', label: '解析错误' },
];

export interface StandardizedRow {
  /** 原始行在库里的 id（写入后回填；纯计算阶段为 null） */
  rowId: number | null;
  batchId: number | null;
  sheetName: string;
  sourceRow: number;
  disposition: Disposition;
  /** 为什么归这一类（给人看） */
  dispositionReason: string;
  /** 标准化候选（缺依据为 null） */
  fields: Record<string, unknown>;
  /** 每个标准化值指回原始单元格 */
  rawRefs: Record<string, { col: number; header: string; raw: string | null }>;
  /** 异常原因（给人看，不是错误码） */
  issues: string[];
}

export interface ApplyMappingInput {
  sheetName: string;
  /** 工作表的表头（原始字符串数组） */
  header: string[];
  /** 🔴 由 **classifySheet** 判定，与映射无关 —— 这是"改映射不会把销售变售后"的结构性保证 */
  sheetClass: string;
  mapping: SheetMapping;
  /** 原始行（来自 parse 的 RowCandidate，或库里读回的 cells） */
  rows: Array<{ sourceRow: number; cells: Record<string, string | null> }>;
  /** 工作簿的日期系统（1904 制必须传 true，否则整体偏 4 年 1 天） */
  date1904?: boolean;
  /** 疑似重复的源标识集合（跨批次/批次内） */
  duplicateSourceKeys?: Set<string>;
  fileHash?: string;
}

export interface ApplyMappingResult {
  rows: StandardizedRow[];
  /** 按 disposition 求和（互斥，加起来 == rows.length） */
  counts: Record<Disposition, number>;
  /** 该版本的字段质量异常（与分类无关，一行可命中多项） */
  quality: { multiPhoneRows: number; ambiguousDateRows: number; missingPhoneRows: number; abnormalReviewRows: number };
}

const emptyCounts = (): Record<Disposition, number> => ({
  importable: 0,
  'needs-confirm': 0,
  duplicate: 0,
  excluded: 0,
  'parse-error': 0,
});

/** 稳定源标识：同一（文件 + 工作表 + 原始行号）永远得到同一个值 */
export function buildSourceKey(fileHash: string, sheetName: string, sourceRow: number): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('node:crypto');
  return crypto
    .createHash('sha256')
    .update(`${fileHash}|${sheetName}|${sourceRow}`)
    .digest('hex');
}

/**
 * 按映射把原始行洗成标准化候选，并给出**互斥**的处置分类。
 *
 * ⚠️ 纯函数：不写库、不读库、不产生副作用。同一输入永远同一输出。
 */
export function applyMapping(input: ApplyMappingInput): ApplyMappingResult {
  const {
    sheetName,
    header,
    sheetClass,
    mapping,
    rows,
    date1904 = false,
    duplicateSourceKeys,
    fileHash = '',
  } = input;

  const out: StandardizedRow[] = [];
  const counts = emptyCounts();
  const quality = {
    multiPhoneRows: 0,
    ambiguousDateRows: 0,
    missingPhoneRows: 0,
    abnormalReviewRows: 0,
  };

  const isServiceSheet = sheetClass === 'service-install' || sheetClass === 'service-repair';
  const isSalesSheet = sheetClass === 'sales-or-delivery';
  const cellAt = (cells: Record<string, string | null>, field: string): string | null => {
    const idx = mapping.fields[field];
    if (idx === undefined) return null;
    const v = cells[`c${idx}`];
    return v === undefined ? null : v;
  };

  for (const row of rows) {
    const issues: string[] = [];
    const rawRefs: Record<string, { col: number; header: string; raw: string | null }> = {};
    const fields: Record<string, unknown> = {};

    const ref = (field: string): void => {
      const idx = mapping.fields[field];
      if (idx === undefined) return;
      rawRefs[field] = {
        col: idx,
        header: header[idx] ?? `第 ${idx + 1} 列`,
        raw: row.cells[`c${idx}`] ?? null,
      };
    };

    // ---- 姓名 / 地址 ----
    const nameRaw = cellAt(row.cells, 'customerName');
    fields.customerName = nameRaw === null ? null : cleanText(nameRaw).value || null;
    ref('customerName');
    const addrRaw = cellAt(row.cells, 'customerAddress');
    fields.customerAddress = addrRaw === null ? null : cleanText(addrRaw).value || null;
    ref('customerAddress');

    // ---- 电话：一格多号**保留全部**，不猜哪个是客户的 ----
    const phoneRaw = cellAt(row.cells, 'customerPhone');
    const parsed = splitPhones(phoneRaw);
    fields.customerPhones = parsed.candidates.map((p) => ({
      digits: p.digits,
      kind: p.kind,
      valid: p.valid,
    }));
    ref('customerPhone');
    const phoneMapped = mapping.fields.customerPhone !== undefined;
    const validMobiles = parsed.candidates.filter((p) => p.kind === 'mobile' && p.valid);
    if (parsed.candidates.length > 1) {
      quality.multiPhoneRows += 1;
      // 🔴 明确说"不猜"，而不是默默取第一个 —— 取第一个就是猜
      issues.push(`一格里有 ${parsed.candidates.length} 个号码，未判断哪个是客户本人的`);
    }
    if (phoneMapped && validMobiles.length === 0) {
      quality.missingPhoneRows += 1;
      issues.push(phoneRaw && phoneRaw.trim() !== '' ? '电话列有值，但拆不出合法手机号' : '电话列为空');
    }

    // ---- 日期：含糊的一律保留原值 ----
    const dates: Record<string, { iso: string | null; basis: string; ambiguous: boolean; raw: string }> = {};
    let rowAmbiguous = false;
    for (const field of DATE_FIELDS) {
      const v = cellAt(row.cells, field);
      if (v === null || v.trim() === '') continue;
      const d = parseDateCell(v, date1904);
      dates[field] = { iso: d.iso, basis: d.basis, ambiguous: d.ambiguous, raw: v };
      ref(field);
      if (d.ambiguous) {
        rowAmbiguous = true;
        // 依据里已经写了为什么不转；这里补一句"保留原值"让人放心
        issues.push(`${MAPPING_FIELD_LABELS[field]}「${v}」${d.basis} ⇒ 保留原值`);
      }
    }
    fields.dates = dates;
    if (rowAmbiguous) quality.ambiguousDateRows += 1;

    // ---- 设备 ----
    const devRaw = cellAt(row.cells, 'device');
    fields.devices = splitDevices(devRaw).devices;
    ref('device');
    const qtyRaw = cellAt(row.cells, 'quantity');
    fields.quantity = qtyRaw === null || qtyRaw.trim() === '' ? null : Number(qtyRaw.replace(/[^\d.]/g, '')) || null;
    ref('quantity');

    // ---- 其余文本字段 ----
    for (const field of ['serviceKind', 'fault', 'measure', 'technician', 'reviewNote', 'storeHint']) {
      const v = cellAt(row.cells, field);
      (fields as Record<string, unknown>)[field] = v === null ? null : cleanText(v).value || null;
      ref(field);
    }

    // ---- 服务结果 ----
    if (mapping.fields.reviewResult !== undefined) {
      const r = classifyReviewResult(cellAt(row.cells, 'reviewResult'));
      fields.reviewResult = { value: r.value, state: r.state };
      ref('reviewResult');
      if (r.state !== 'ok') {
        quality.abnormalReviewRows += 1;
        issues.push(r.state === 'empty' ? '服务结果为空' : `服务结果「${rawToString(cellAt(row.cells, 'reviewResult')).trim()}」不在已知取值内`);
      }
    } else {
      fields.reviewResult = null;
    }

    // ---------------- 处置分类（**不读 mapping**）----------------
    //
    // 🔴 这一段是"东山的 849 行销售配送不会因为改映射变成售后"的落地点：
    //    它只读 `sheetClass`（来自 parse 的表头结构判定），
    //    映射成什么都不影响结论。想让它变成售后，必须**改工作表分类**，
    //    而那需要显式的业务证据与人工确认（本阶段不提供）。
    let disposition: Disposition;
    let reason: string;
    if (isSalesSheet) {
      disposition = 'excluded';
      reason = '这张表按表头结构判定为销售/配送资料，整表不进售后';
    } else if (!isServiceSheet) {
      disposition = 'excluded';
      reason = '这张表的业务类型尚未确定，暂不进售后（需人工确认工作表类型）';
    } else if (duplicateSourceKeys?.has(buildSourceKey(fileHash, sheetName, row.sourceRow))) {
      disposition = 'duplicate';
      reason = '同一文件同一工作表的同一行此前已存在';
    } else if (phoneMapped && validMobiles.length === 0) {
      disposition = 'needs-confirm';
      reason = '取不到合法手机号，需人工确认';
    } else if (validMobiles.length > 1) {
      disposition = 'needs-confirm';
      reason = '一格里有多个号码，需人工确认哪个是客户本人的';
    } else {
      disposition = 'importable';
      reason = '可导入候选（仍需人工确认后才正式归档）';
    }
    counts[disposition] += 1;

    out.push({
      rowId: null,
      batchId: null,
      sheetName,
      sourceRow: row.sourceRow,
      disposition,
      dispositionReason: reason,
      fields,
      rawRefs,
      issues,
    });
  }

  return { rows: out, counts, quality };
}
