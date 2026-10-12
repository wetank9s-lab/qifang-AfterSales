/**
 * 历史 Excel 导入 —— **真实文件类型识别**（P11-3 第 2 项）
 *
 * ===========================================================================
 * 为什么不能信扩展名
 * ===========================================================================
 * 用户的验收要求里有一条明确的**反向测试**：
 *   「损坏文件、**伪造扩展名**、超限文件、异常日期、重复表头不能让解析器静默成功或误导入」。
 *
 * "伪造扩展名"在现实里极其常见，而且有两种相反的形态：
 *   A. `报价单.xls` 其实是一个 **HTML `<table>`**（很多老系统导出的就是这种），
 *      或其实是 CSV 改的名 —— 用 xlsx 库硬解会抛一个看不懂的底层错。
 *   B. `数据.xlsx` 其实是老的 **OLE2/.xls**（另存为时手改了后缀）。
 *
 * 只按后缀分派 ⇒ A 类会把错误暴露成"损坏"（误导排查方向），
 * B 类会直接失败（其实内容是好的，只需要用另一个解析器）。
 * ⇒ 因此**一律按魔数判类型**，扩展名只用于交叉核对并记 warning。
 *
 * 魔数（都是文件头，不解析内容）：
 *   · ZIP  ：`50 4B 03 04`（新式 .xlsx / .xlsm 都是 zip 容器）
 *            另有 `50 4B 05 06`（空归档）、`50 4B 07 08`（跨卷）—— 也归为 zip
 *   · OLE2 ：`D0 CF 11 E0 A1 B1 1A E1`（旧式 .xls / .doc / .ppt 共用）
 *   · HTML ：`<!DOCTYPE html` / `<html` / `<table`（前若干字节，忽略前导空白与 BOM）
 *   · 纯文本 CSV：无魔数，只能靠"可打印 ASCII/UTF-8 + 含分隔符"弱判定
 */
import { IMPORT_REJECT, HistoricalImportRejected } from './limits';

export type WorkbookKind = 'xlsx' | 'xls' | 'html' | 'csv' | 'text' | 'unknown';

export interface DetectedType {
  kind: WorkbookKind;
  /** 解析该文件应当使用的 xlsx 读取方式 */
  readAs: 'buffer' | 'string' | null;
  /** 扩展名与魔数是否一致（不一致只 warning，不拒绝 —— 内容是好的就照收） */
  extensionMatches: boolean;
  /** 命中依据（写进导入报告，便于排障；不含任何客户数据） */
  evidence: string;
}

const SIG_ZIP = [0x50, 0x4b, 0x03, 0x04];
const SIG_ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const SIG_ZIP_SPANNED = [0x50, 0x4b, 0x07, 0x08];
const SIG_OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(buf: Buffer, sig: number[]): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return false;
  return true;
}

/** 跳过 UTF-8 BOM 与前导空白后的可读前缀（只看前 512 字节） */
function headText(buf: Buffer): string {
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  const slice = buf.slice(start, Math.min(buf.length, start + 512));
  return slice.toString('utf8').replace(/^[\s\uFEFF]+/, '');
}

export function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename ?? '').trim());
  return m ? m[1].toLowerCase() : '';
}

/**
 * 识别真实类型。
 *
 * ⚠️ **不认识就拒绝**，不做"猜一个解析器试试"的兜底 ——
 *    兜底会让"其实是个 .doc"的文件被硬解成一堆垃圾行，然后当成售后数据入库。
 */
export function detectWorkbookKind(buf: Buffer, filename: string): DetectedType {
  const ext = extensionOf(filename);
  const extSaysLegacy = ext === 'xls';
  const extSaysModern = ext === 'xlsx' || ext === 'xlsm';

  if (startsWith(buf, SIG_ZIP) || startsWith(buf, SIG_ZIP_EMPTY) || startsWith(buf, SIG_ZIP_SPANNED)) {
    return {
      kind: 'xlsx',
      readAs: 'buffer',
      extensionMatches: extSaysModern,
      evidence: '魔数 ZIP(50 4B) ⇒ 新式工作簿容器',
    };
  }

  if (startsWith(buf, SIG_OLE2)) {
    return {
      kind: 'xls',
      readAs: 'buffer',
      extensionMatches: extSaysLegacy,
      evidence: '魔数 OLE2(D0 CF 11 E0) ⇒ 旧式复合文档（.xls）',
    };
  }

  const head = headText(buf).toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<table')) {
    return {
      kind: 'html',
      readAs: null,
      extensionMatches: false,
      evidence: '内容以 HTML 标签开头 ⇒ 是网页表格改名的伪 .xls/.xlsx',
    };
  }

  // OLE2 里的加密工作簿：CFB 容器存在，但内部流是 EncryptedPackage。
  // 这里只能靠 xlsx 库在读取阶段抛错来识别（见 workbook.ts），故不在本函数处理。

  if (buf.length >= 12) {
    // 无魔数：做一个**弱**文本判定，仅用于给出可读的拒绝原因，不用于放行
    const asText = buf.slice(0, 4096).toString('utf8');
    const controlChars = (asText.match(/[\u0000-\u0008\u000E-\u001F]/g) ?? []).length;
    if (controlChars === 0 && asText.trim().length > 0) {
      const firstLine = asText.split(/\r?\n/)[0] ?? '';
      const delim = [',', '\t', ';', '|'].find((d) => firstLine.split(d).length >= 3);
      if (delim) {
        return {
          kind: 'csv',
          readAs: null,
          extensionMatches: ext === 'csv',
          evidence: `无已知工作簿魔数；疑似分隔符为 ${JSON.stringify(delim)} 的纯文本`,
        };
      }
      return {
        kind: 'text',
        readAs: null,
        extensionMatches: false,
        evidence: '无已知工作簿魔数；内容是可打印文本',
      };
    }
  }

  return {
    kind: 'unknown',
    readAs: null,
    extensionMatches: false,
    evidence: `未命中任何已知工作簿魔数（前 8 字节：${buf.slice(0, 8).toString('hex')}）`,
  };
}

/** 对不支持的类型抛出**带证据**的拒绝（不是"解析失败"这种没用的信息） */
export function assertSupportedWorkbook(detected: DetectedType, filename: string): void {
  if (detected.kind === 'xlsx' || detected.kind === 'xls') return;
  throw new HistoricalImportRejected(
    IMPORT_REJECT.UNSUPPORTED_TYPE,
    `不支持的文件内容类型：${detected.kind}（${detected.evidence}）。` +
      `文件名 ${JSON.stringify(filename)}，仅接受真实的 .xlsx/.xls 工作簿。`,
    { kind: detected.kind, extension: extensionOf(filename), evidence: detected.evidence },
  );
}
