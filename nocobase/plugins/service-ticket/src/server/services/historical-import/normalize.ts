/**
 * 历史 Excel 导入 —— **标准化候选**（P11-3 第 2 项 · 第 3 条"原始数据绝不能丢失"）
 *
 * ===========================================================================
 * 本文件唯一不可退让的规则：**只做有依据的转换，绝不补造**
 * ===========================================================================
 * 用户原话：「不要自动补造手机号、转换含糊日期或凭空推断服务类型。
 *            任何清洗结果都应能够追溯到原始值。」
 *
 * 所以这里每个函数都返回**三件套**，缺一不可：
 *   · `raw`     —— 原始单元格值（**原样**，不 trim 不转换）
 *   · `value`   —— 标准化候选（可以没有：`null`）
 *   · `issues`  —— 为什么没能标准化（含糊/超界/非法），**必须显式列出**
 *
 * ⚠️ 最容易犯的错是"看着像日期就当日期"：真实样本里
 *    `东山电器` 的 `购机日期` 是字符串 `'46265'`（Excel 序列号），
 *    而 `康乐` 的某些列是 `'9.1'`（可能指 9 月 1 日，也可能是"9.1 折"）。
 *    对后者**一律不猜** —— 猜错会造出一条客户从未发生过的服务日期。
 *
 * ⚠️ 另一条：`raw` 里的值**允许**以 `=` 开头。SheetJS 读值时不会执行公式，
 *    但**输出到 CSV/前端**时要防"公式注入"。所以这里只做**记录**，
 *    不在这里做任何转义 —— 转义属于导出层的职责，混在一起会污染可追溯性。
 */

/** 单元格原始值 → 字符串（保持"空"与"零"的区别） */
export function rawToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** 面向展示的清理（去掉 NUL、全角空格、折叠空白、trim）——**不改语义** */
export function cleanText(raw: unknown): { raw: string; value: string; changed: boolean } {
  const s = rawToString(raw);
  const value = s
    .replace(/\u0000/g, '')
    .replace(/[\u00A0\u3000]/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
  return { raw: s, value, changed: value !== s };
}

// ---------------------------------------------------------------------------
// 手机号 / 电话
// ---------------------------------------------------------------------------

export interface PhoneCandidate {
  /** 原文中的那一段（含分隔符以外的片段） */
  raw: string;
  /** 只保留数字（去掉 - / 空格 / 括号） */
  digits: string;
  kind: 'mobile' | 'landline' | 'service-hotline' | 'invalid';
  valid: boolean;
  note?: string;
}

const MOBILE_RE = /^1[3-9]\d{9}$/;
const LANDLINE_RE = /^0\d{2,3}\d{7,8}$/;
/** 400/800 客服号：真实样本里出现在"服务人员"列（如"海尔售后 400…"），不是客户电话 */
const HOTLINE_RE = /^(400|800)\d{7,8}$/;

/**
 * 从一个单元格里拆出**全部**电话号码候选。
 *
 * 真实样本里的形态（全部来自 probe 记录，不是编的）：
 *   · `<11位>（<11位>）`    全角括号夹两个号
 *   · `<11位>/<11位>`       半角斜杠
 *   · `<11位>`              单个
 *   · `400-XXX-XXXX`（客服热线，出现在别的列）
 *
 * ⚠️ **这里刻意不写具体号码**：本文件在公开仓库里，而形态描述已经足够说明分隔符规则。
 *    2026-10-12 首版把真实样本里的号码原样抄进了注释，被
 *    `scripts/scan-commit-secrets.mjs` 抓出 7 处 —— **门禁有效，是它拦住了这次泄漏**。
 *    教训与 DEV-106 同型：**"为了说明形态"而贴真实值，等于把客户数据写进公开仓库。**
 *
 * ⚠️ 缺位 / 非法的号码**原样保留并标 invalid**，不补 0、不补区号 ——
 *    补出来的号可能正好是**别人的真实号码**，这属于造数据。
 */
export function splitPhones(cellRaw: unknown): { raw: string; candidates: PhoneCandidate[] } {
  const raw = rawToString(cellRaw);
  if (!raw.trim()) return { raw, candidates: [] };

  // 分隔符集：中英文逗号、分号、斜杠、反斜杠、顿号、竖线、空白、括号（括号只作分隔）
  const fragments = raw
    .split(/[，,、;；/\\|\s()（）[\]【】]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const candidates: PhoneCandidate[] = [];
  for (const frag of fragments) {
    const digits = frag.replace(/\D/g, '');
    if (!digits) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);

    if (MOBILE_RE.test(digits)) {
      candidates.push({ raw: frag, digits, kind: 'mobile', valid: true });
    } else if (HOTLINE_RE.test(digits)) {
      // 客服热线：**明确标出来**，避免被当成客户手机号
      candidates.push({ raw: frag, digits, kind: 'service-hotline', valid: false, note: '客服热线，非客户号码' });
    } else if (LANDLINE_RE.test(digits)) {
      candidates.push({ raw: frag, digits, kind: 'landline', valid: true });
    } else {
      candidates.push({
        raw: frag,
        digits,
        kind: 'invalid',
        valid: false,
        note: `位数 ${digits.length}，不符合手机号/座机号形态`,
      });
    }
  }
  return { raw, candidates };
}

/** 日志/报告里只允许出现掩码 */
export function maskPhone(digits: string): string {
  if (!digits) return '';
  if (digits.length < 7) return digits.slice(0, 2) + '***';
  return digits.slice(0, 3) + '****' + digits.slice(-4);
}

// ---------------------------------------------------------------------------
// 日期
// ---------------------------------------------------------------------------

export interface DateCandidate {
  raw: string;
  /** 能**确定**时给出 ISO 字符串；含糊或非法时为 null */
  iso: string | null;
  precision: 'datetime' | 'date' | 'none';
  /** 判定的依据（写进报告） */
  basis: string;
  /** 含糊：看着像日期但无法确定语义 ⇒ **不猜** */
  ambiguous: boolean;
}

/** Excel 序列号（1900 制）合理区间：约 1990-01-01 ~ 2100-12-31 */
const SERIAL_MIN = 32874;
const SERIAL_MAX = 73415;

/**
 * Excel 序列号 → ISO。
 * ⚠️ 必须传入工作簿的日期系统（1900 / 1904）。真实样本都是 1900 制，
 *    但 `wb.Workbook.WBProps.date1904 === true` 时必须走 1904 分支，
 *    否则整体偏 4 年 1 天 —— 这种错误**看起来完全正常**，最难发现。
 */
export function serialToIso(serial: number, date1904: boolean): string | null {
  if (!Number.isFinite(serial)) return null;
  const epochMs = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = epochMs + Math.round(serial) * 86400000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * 解析日期单元格。
 *
 * ⚠️ 只接受**语义无歧义**的形态；其余一律 `iso: null` + `ambiguous: true`：
 *    · `'2026-09-01 09:21:53'` / `'2026/9/1'` ⇒ 明确
 *    · 数值 46265（或纯数字字符串且在序列号区间）⇒ Excel 序列号，明确
 *    · 数值 20260901 ⇒ yyyymmdd，明确
 *    · `'9.1'` / `'9月1日'` / `'1号'` ⇒ **含糊**（缺年份）⇒ 不猜
 *      ⚠️ 真实样本的"回访"列里就有 `'1号检查显示未出库。10.4号回访已安装'` 这类自由文本，
 *         绝不能被日期解析器吞掉当成日期。
 */
export function parseDateCell(cellRaw: unknown, date1904 = false): DateCandidate {
  const raw = rawToString(cellRaw);
  const s = raw.trim();
  if (!s) return { raw, iso: null, precision: 'none', basis: '空单元格', ambiguous: false };

  // ① 已经是 Date（SheetJS 在 cellDates:true 时会给）
  if (cellRaw instanceof Date && !Number.isNaN(cellRaw.getTime())) {
    const iso = cellRaw.toISOString();
    const hasTime = iso.slice(11, 19) !== '00:00:00';
    return {
      raw,
      iso: hasTime ? iso : iso.slice(0, 10),
      precision: hasTime ? 'datetime' : 'date',
      basis: '单元格本身是日期类型',
      ambiguous: false,
    };
  }

  // ② yyyymmdd（8 位纯数字）
  if (/^\d{8}$/.test(s)) {
    const y = Number(s.slice(0, 4));
    const m = Number(s.slice(4, 6));
    const d = Number(s.slice(6, 8));
    if (y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return { raw, iso: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, precision: 'date', basis: 'yyyymmdd', ambiguous: false };
    }
  }

  // ③ 纯数字（或数字字符串）且在 Excel 序列号区间
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n >= SERIAL_MIN && n <= SERIAL_MAX) {
      const iso = serialToIso(n, date1904);
      if (iso) {
        return {
          raw,
          iso,
          precision: 'date',
          basis: `Excel 序列号(${date1904 ? '1904' : '1900'} 制)`,
          ambiguous: false,
        };
      }
    }
    // ⚠️ 落在区间外的纯数字（如 `'1'`、`'9.1'`、数量列）⇒ 不当作日期
    return { raw, iso: null, precision: 'none', basis: '纯数字但不在 Excel 序列号合理区间', ambiguous: false };
  }

  // ④ ISO / 常见分隔形态（必须能确定 年-月-日 三要素）
  const m =
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    const [, Y, Mo, D, h, mi, se] = m;
    const y = Number(Y);
    const mo = Number(Mo);
    const d = Number(D);
    if (y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const pad = (x: string | undefined, w: number) => (x ?? '').padStart(w, '0');
      const datePart = `${Y}-${pad(Mo, 2)}-${pad(D, 2)}`;
      if (h !== undefined) {
        return {
          raw,
          iso: `${datePart}T${pad(h, 2)}:${mi}:${se ?? '00'}`,
          precision: 'datetime',
          basis: '完整年月日 + 时分',
          ambiguous: false,
        };
      }
      return { raw, iso: datePart, precision: 'date', basis: '完整年月日', ambiguous: false };
    }
    return { raw, iso: null, precision: 'none', basis: '年月日在非法范围', ambiguous: true };
  }

  // ⑤ 缺年份 / 自由文本 ⇒ **一律不猜**
  const looksLikePartialDate = /(^|[^\d])\d{1,2}\s*[./月-]\s*\d{1,2}\s*([日号]|$)/.test(s);
  return {
    raw,
    iso: null,
    precision: 'none',
    basis: looksLikePartialDate ? '疑似缺少年份的日期 ⇒ 不推断' : '不是可识别的日期形态',
    ambiguous: looksLikePartialDate,
  };
}

// ---------------------------------------------------------------------------
// 牌名型号（一个单元格多台设备）
// ---------------------------------------------------------------------------

export interface DeviceCandidate {
  raw: string;
  /** 去掉数量后缀的型号文本 */
  model: string;
  /** 从 `:2完好` 之类后缀解析出的台数（解析不到就是 null，不默认 1） */
  quantity: number | null;
}

/**
 * 拆分"一个商品字段包含多台设备"。
 *
 * 真实样本形态：
 *   `'美的空调KFR-35GW/XA2:1完好 || 长虹电视43P5S-F:1完好'`
 *   `'容声冰箱BCD-502P60CZGAR清辉印:1完好 '`
 *   `'4F113三菱电机空调 XT73VFK'`（维修表，无数量后缀）
 *
 * ⚠️ 分隔符 `||` 是本仓库真实样本里出现的；同时兼容换行与 `；`。
 *    数量只在**明确写了**的情况下给出，否则 null（不默认 1）。
 */
export function splitDevices(cellRaw: unknown): { raw: string; devices: DeviceCandidate[] } {
  const raw = rawToString(cellRaw);
  if (!raw.trim()) return { raw, devices: [] };

  const parts = raw
    .split(/\|\||\r?\n|[；;]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const devices: DeviceCandidate[] = [];
  for (const part of parts) {
    let quantity: number | null = null;
    let model = part;
    const qm = /[:：]\s*(\d+)\s*(?:台|完好|台完好)?\s*$/.exec(part);
    if (qm) {
      quantity = Number(qm[1]);
      model = part.slice(0, qm.index).trim();
    }
    devices.push({ raw: part, model: model || part, quantity });
  }
  return { raw, devices };
}
