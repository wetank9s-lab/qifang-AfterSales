/**
 * 历史导入 —— **异常确认**（B）与**去重预览**（C）
 * =============================================================================
 *
 * ===========================================================================
 * B 用户原话（摘要）
 * ===========================================================================
 *  「员工需要能看到每份文件的：售后候选记录数量；排除的非售后记录数量；
 *    疑似重复数量；**需要人工确认的唯一记录数量**；**主要异常类型及对应原始行**。
 *    异常应支持查看原始值、修正标准化候选值、确认或保持待处理。
 *    不得覆盖原始层，**不得凭猜测补手机号、年份、服务结果**。
 *    康乐 Sheet2 的"来电表扬"等原始结果必须保留，**不得强制伪装成另一个标准业务结果**。
 *    异常核对操作要记录**真实操作人、时间、原值及新值**。」
 *
 * ===========================================================================
 * C 用户原话（摘要）
 * ===========================================================================
 *  「跨文件可根据**客户联系方式、业务日期、家电信息**等提示疑似重复，
 *    但**不得只凭手机号相同就合并** —— 同一客户可能有多次真实售后。
 *    去重结果允许人工确认保留两条或标记重复。**不能自动删除原始记录**，
 *    不能让**不同门店的客户资料互相泄漏**。」
 *
 * ===========================================================================
 * 本模块的三条设计决定
 * ===========================================================================
 *  ① **"需要人工确认的唯一记录数"** —— 用 `Set<rowId>` 数，不是把各类异常相加。
 *     这与用户第 A.1 条是同一条纪律；在界面上更危险，因为人会把
 *     "多手机号 215 + 含糊日期 1290 + …" 直接读成"有 2192 条要处理"。
 *  ② **修正 = 另存，不是覆盖**。人工值写进 `manual_overrides_json`，
 *     机器结果 `fields_json` 与原始层 `cells_json` 一个字节都不动。
 *     ⇒ "这是机器算的"与"这是人填的"永远分得清（用户：不得伪装成标准业务结果）。
 *  ③ **疑似重复必须给得出理由**，且理由里必须体现"不只凭手机号"：
 *     `sharedPhone` 单独出现时只能算 `weak`，必须再有 `sharedDate` / `sharedDevice`
 *     / `sharedName` 之一才算 `strong`。**"合并"这个动作本阶段根本不提供** ——
 *     只提供"标记重复 / 两条都保留"。
 */
import { maskPhone } from './normalize';
import { DISPOSITIONS } from './mapping';

/** 一批候选行的最简形态（从库里读出来后喂进来） */
export interface CandidateLite {
  id: number;
  rowId: number;
  sheetName: string;
  sourceRow: number;
  disposition: string;
  fields: Record<string, any>;
  issues: string[];
  manualStatus: string;
  manualOverrides: Record<string, { value: unknown; by?: string | null; at?: string | null; note?: string | null }>;
}

export interface BatchSummary {
  /** 售后候选记录数量（`disposition = importable`） */
  importableCount: number;
  /** 排除的非售后记录数量（`disposition = excluded`） */
  excludedCount: number;
  /** 疑似重复数量（`disposition = duplicate`） */
  duplicateCount: number;
  /** 解析错误数量 */
  parseErrorCount: number;
  /**
   * **需要人工确认的记录数** —— `disposition = needs-confirm` 的**记录条数**。
   * ⚠️ 与下面那个"唯一原始行数"不是一个东西，见 `needsConfirmUniqueRowCount`。
   */
  needsConfirmCount: number;
  /**
   * 🔴 **需要人工确认的唯一原始行数**（用户 B 条点名的那个数字）。
   * 一张工作表可能有多个映射版本/多个候选指向同一原始行 ⇒ 必须按 rowId 去重。
   */
  needsConfirmUniqueRowCount: number;
  /** 五个分类之和（互斥、可求和） */
  dispositionSum: number;
  /** 候选总行数（应等于 dispositionSum） */
  candidateCount: number;
  /** 主要异常类型 + 各自涉及的行数（**命中次数**口径，会与"唯一行数"不同） */
  anomalyTypes: Array<{ key: string; label: string; hitCount: number; sampleRows: Array<{ rowId: number; sheetName: string; sourceRow: number }> }>;
  /** 至少命中一类异常的**唯一原始行数** */
  anomalyUniqueRowCount: number;
  /** 异常**命中次数**（各行类别相加） */
  anomalyHitCount: number;
}

const ANOMALY_LABELS: Record<string, string> = {
  multiPhone: '一格多个号码',
  ambiguousDate: '日期含糊（缺年份/两位年份）',
  missingPhone: '缺手机号或号码形态异常',
  abnormalReviewResult: '服务结果为空或取值不在已知集合内',
};

/**
 * 按 `issues_json` 里的**人话原因**归类。
 *
 * ⚠️ 判据是"原因文本里出现了什么"，而不是错误码 —— 因为 `issues` 本来就是
 *    写给人看的（`mapping.ts` 里逐条构造）。这里**不新增一套码**，
 *    避免"码与文案"两份事实来源漂移。
 */
function classifyIssue(issue: string): string | null {
  if (/一格里有\s*\d+\s*个号码/.test(issue)) return 'multiPhone';
  if (/保留原值|世纪无法确定|缺年份|两位年份/.test(issue)) return 'ambiguousDate';
  if (/电话列/.test(issue)) return 'missingPhone';
  if (/服务结果/.test(issue)) return 'abnormalReviewResult';
  return null;
}

export function buildBatchSummary(candidates: CandidateLite[]): BatchSummary {
  const byDisposition: Record<string, number> = Object.fromEntries(DISPOSITIONS.map((d) => [d.value, 0]));
  for (const c of candidates) byDisposition[c.disposition] = (byDisposition[c.disposition] ?? 0) + 1;

  const needsConfirmRowIds = new Set<number>();
  const anomalyRowIds = new Set<number>();
  const anomalyHits: Record<string, { hitCount: number; rows: Set<number>; sample: Array<{ rowId: number; sheetName: string; sourceRow: number }> }> = {};

  for (const c of candidates) {
    if (c.disposition === 'needs-confirm') needsConfirmRowIds.add(c.rowId);
    for (const issue of c.issues ?? []) {
      const key = classifyIssue(issue);
      if (!key) continue;
      anomalyRowIds.add(c.rowId);
      if (!anomalyHits[key]) anomalyHits[key] = { hitCount: 0, rows: new Set(), sample: [] };
      anomalyHits[key].hitCount += 1;
      anomalyHits[key].rows.add(c.rowId);
      if (anomalyHits[key].sample.length < 5) {
        anomalyHits[key].sample.push({ rowId: c.rowId, sheetName: c.sheetName, sourceRow: c.sourceRow });
      }
    }
  }

  const anomalyTypes = Object.entries(anomalyHits)
    .map(([key, v]) => ({
      key,
      label: ANOMALY_LABELS[key] ?? key,
      hitCount: v.hitCount,
      sampleRows: v.sample,
    }))
    .sort((a, b) => b.hitCount - a.hitCount);

  return {
    importableCount: byDisposition.importable ?? 0,
    excludedCount: byDisposition.excluded ?? 0,
    duplicateCount: byDisposition.duplicate ?? 0,
    parseErrorCount: byDisposition['parse-error'] ?? 0,
    needsConfirmCount: byDisposition['needs-confirm'] ?? 0,
    needsConfirmUniqueRowCount: needsConfirmRowIds.size,
    dispositionSum: Object.values(byDisposition).reduce((a, b) => a + b, 0),
    candidateCount: candidates.length,
    anomalyTypes,
    anomalyUniqueRowCount: anomalyRowIds.size,
    anomalyHitCount: anomalyTypes.reduce((a, t) => a + t.hitCount, 0),
  };
}

// ---------------------------------------------------------------------------
// 去重（跨文件疑似重复）
// ---------------------------------------------------------------------------

export type DuplicateStrength = 'strong' | 'weak';

export interface DuplicateMember {
  rowId: number;
  batchId: number;
  candidateId: number;
  sheetName: string;
  sourceRow: number;
  customerName: string | null;
  mobileMasked: string | null;
  serviceDate: string | null;
  deviceSummary: string | null;
  /** 该行所属批次（**只在本主体可见范围内**） */
  batchNo: string;
}

export interface DuplicateGroup {
  groupKey: string;
  strength: DuplicateStrength;
  /** 命中的判据（**给人看**，例如「手机号相同 + 家电型号相同」） */
  reasons: string[];
  members: DuplicateMember[];
}

/** 抽取一把用于比对的"业务指纹" */
export function fingerprintOf(c: CandidateLite): {
  mobile: string | null;
  date: string | null;
  device: string | null;
  name: string | null;
} {
  const phones = (c.fields?.customerPhones ?? []) as Array<{ digits?: string; valid?: boolean }>;
  const mobile = phones.find((p) => p?.valid && String(p?.digits ?? '').length === 11)?.digits ?? null;
  const dates = (c.fields?.dates ?? {}) as Record<string, { iso?: string | null }>;
  const date =
    Object.values(dates)
      .map((d) => d?.iso ?? null)
      .filter((x): x is string => typeof x === 'string' && x.length >= 10)
      .sort()[0] ?? null;
  const devices = (c.fields?.devices ?? []) as Array<{ model?: string }>;
  const device = devices.map((d) => String(d?.model ?? '').trim()).filter(Boolean).sort()[0] ?? null;
  const name = (c.fields?.customerName as string | null) ?? null;
  return { mobile, date, device, name };
}

/**
 * 跨文件疑似重复分组。
 *
 * 🔴 **不能只凭手机号**：`sharedPhone` 单独出现时判 `weak`；
 *    必须再有 `sharedDate` / `sharedDevice` / `sharedName` 之一才算 `strong`。
 *    理由是用户点名的那句话 ——「同一客户可能有多次真实售后」：
 *    同一个手机号在同一个月的维修表与安装表里各出现一次，是**两次真实服务**，
 *    不是重复记录。只有"号码 + 日期 + 型号"都对得上，才更像同一件事被录了两遍。
 *
 * ⚠️ 输入 `candidates` 必须**已经按可见范围裁剪过**（调用方负责）——
 *    本函数不查库、不判权限，避免"检测逻辑里混进权限逻辑"这种最难审计的形态。
 */
export function detectDuplicates(
  candidates: Array<CandidateLite & { batchId: number; batchNo: string }>,
): DuplicateGroup[] {
  const bucket = new Map<string, Array<CandidateLite & { batchId: number; batchNo: string }>>();
  for (const c of candidates) {
    // 只对"可能进档案"的行做去重提示：排除的非售后行不参与
    if (c.disposition === 'excluded' || c.disposition === 'parse-error') continue;
    const fp = fingerprintOf(c);
    if (!fp.mobile) continue; // 没有可用手机号就无法做"以号码为主键"的相似提示
    const list = bucket.get(fp.mobile) ?? [];
    list.push(c);
    bucket.set(fp.mobile, list);
  }

  const groups: DuplicateGroup[] = [];
  for (const [mobile, list] of bucket) {
    if (list.length < 2) continue;

    // 同一号码下再按"业务指纹"两两比较，逐对给出理由
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        const fa = fingerprintOf(a);
        const fb = fingerprintOf(b);
        const reasons: string[] = ['手机号相同'];
        let extra = 0;
        if (fa.name && fb.name && fa.name === fb.name) {
          reasons.push('姓名相同');
          extra += 1;
        }
        if (fa.date && fb.date && fa.date === fb.date) {
          reasons.push('业务日期相同');
          extra += 1;
        }
        if (fa.device && fb.device && fa.device === fb.device) {
          reasons.push('家电型号相同');
          extra += 1;
        }
        // ⚠️ 同一条原始行（同批次同表同行）不算重复，那是同一行的两条记录
        const sameRow = a.batchId === b.batchId && a.sheetName === b.sheetName && a.sourceRow === b.sourceRow;
        if (sameRow) continue;

        groups.push({
          groupKey: `${mobile}|${a.rowId}|${b.rowId}`,
          strength: extra >= 1 ? 'strong' : 'weak',
          reasons,
          members: [a, b].map((c) => {
            const fp = fingerprintOf(c);
            return {
              rowId: c.rowId,
              batchId: c.batchId,
              candidateId: c.id,
              sheetName: c.sheetName,
              sourceRow: c.sourceRow,
              customerName: fp.name,
              mobileMasked: fp.mobile ? maskPhone(fp.mobile) : null,
              serviceDate: fp.date,
              deviceSummary: fp.device,
              batchNo: c.batchNo,
            };
          }),
        });
      }
    }
  }

  // 强证据在前；同一强度按第一个成员的行号排，输出稳定（便于断言与人工比对）
  return groups.sort((x, y) => {
    if (x.strength !== y.strength) return x.strength === 'strong' ? -1 : 1;
    return x.groupKey.localeCompare(y.groupKey);
  });
}

/**
 * 人工修正值是否**被允许**。
 *
 * 🔴 用户：「不得凭猜测补手机号、年份、服务结果。」
 *
 * 本函数**不判断人填得对不对**（那不可能自动化），它只挡三类**结构性**的错误录入：
 *   ① 空值 —— "清空"不是修正，是删除；要删除请用 reject / keep-pending；
 *   ② 手机号必须长得像手机号（否则就是把一段别的东西塞进了电话列）；
 *   ③ 日期必须是**完整**的年月日（不接受 `9.1` 这种"补上年份"的输入形态，
 *      因为那正是用户禁止的"自动补年份"的人工版本）。
 */
export function validateManualValue(field: string, value: unknown): { ok: boolean; why?: string } {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  if (!text) return { ok: false, why: '修正值不能为空（要清空请改用"驳回"或"保持待处理"）' };
  if (field === 'customerPhone' || field === 'customerPhones') {
    const digits = text.replace(/\D/g, '');
    if (!/^1[3-9]\d{9}$/.test(digits)) {
      return { ok: false, why: '手机号必须是 11 位大陆手机号形态；不接受缺位/带其它数字的输入' };
    }
  }
  if (/Date$/.test(field) || field === 'serviceDate') {
    if (!/^\d{4}-\d{2}-\d{2}/.test(text)) {
      return { ok: false, why: '日期必须写完整年月日（YYYY-MM-DD）；不接受"9.1"这类缺年份的写法' };
    }
  }
  if (field === 'reviewResult') {
    // ⚠️ **不**强制映射到已知集合：用户明令"不得强制伪装成另一个标准业务结果"。
    //    这里只要求"不能为空"，其余照收 —— 取值是否标准由人来判断，
    //    系统记录它，并在档案里如实标注 source=manual。
    if (text.length > 32) return { ok: false, why: '服务结果最多 32 字' };
  }
  return { ok: true };
}
