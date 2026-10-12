/**
 * 历史 Excel 导入 —— **ZIP 膨胀守卫**（P11-3 第 2 项 · 第 4 条"文件安全与资源限制"）
 *
 * ===========================================================================
 * 为什么必须在**解压之前**拦
 * ===========================================================================
 * `.xlsx` 是一个 ZIP。攻击者（或一个不小心的"导出"）可以造出
 * **几十 KB 的 zip，解出几十 GB** —— 经典 zip-bomb。
 * 一旦交给解析库去 `readFile`，它会在**解析过程中**把条目解到内存里，
 * 那时候再检查已经晚了：进程已经 OOM。
 *
 * ⇒ 所以这里**只读 ZIP 的中央目录（central directory）**，
 *    把每个条目声明的大小加起来，超限直接拒绝。**全程不解压一个字节。**
 *
 * ⚠️ 本实现是"够用即止"的：它不追求成为通用 zip 库，
 *    只做三件事 —— 找 EOCD、读中央目录条目、累计大小/算压缩比。
 *    任何结构异常都按"损坏"拒绝（fail-closed），而不是"猜着继续读"。
 */
import { IMPORT_LIMITS, IMPORT_REJECT, HistoricalImportRejected } from './limits';

const EOCD_SIG = 0x06054b50; // PK\x05\x06
const CEN_SIG = 0x02014b50; // PK\x01\x02
const EOCD_MIN_LEN = 22;
/** 注释最长 65535，所以 EOCD 只可能出现在最后 65557 字节内 */
const EOCD_SEARCH_MAX = 65557;

export interface ZipEntriesStat {
  entryCount: number;
  /** 各条目声明的解压后大小之和 */
  totalUncompressed: number;
  /** 各条目声明的压缩后大小之和 */
  totalCompressed: number;
  /** 单个条目的最大压缩比（解压后 / 压缩后） */
  maxRatio: number;
  /** 触发拒绝时的人类可读原因（未触发则为 null） */
  violation: string | null;
}

/**
 * 扫描 zip 中央目录并做限额判定。
 *
 * 对**非 ZIP**（旧式 .xls 是 OLE2，不是 zip）返回 `null` —— 调用方据此跳过本检查，
 * 而不是把"不是 zip"当成错误。
 */
export function statZipEntries(buf: Buffer): ZipEntriesStat | null {
  if (buf.length < EOCD_MIN_LEN) return null;
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) return null;

  // ---- 1. 从尾部向前找 EOCD ----
  const from = Math.max(0, buf.length - EOCD_SEARCH_MAX);
  let eocd = -1;
  for (let i = buf.length - EOCD_MIN_LEN; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    // 有 PK 头却找不到 EOCD ⇒ 不是完整的工作簿（截断/伪装）
    return {
      entryCount: 0,
      totalUncompressed: 0,
      totalCompressed: 0,
      maxRatio: 0,
      violation: 'ZIP 结构不完整（找不到中央目录结束记录）⇒ 文件被截断或不是真正的工作簿',
    };
  }

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cenSize = buf.readUInt32LE(eocd + 12);
  const cenOffset = buf.readUInt32LE(eocd + 16);

  if (cenOffset + cenSize > buf.length || cenOffset < 0) {
    return {
      entryCount,
      totalUncompressed: 0,
      totalCompressed: 0,
      maxRatio: 0,
      violation: 'ZIP 中央目录越界 ⇒ 文件损坏',
    };
  }

  // ---- 2. 遍历中央目录条目（只读元数据，不解压）----
  let p = cenOffset;
  let seen = 0;
  let totalUncompressed = 0;
  let totalCompressed = 0;
  let maxRatio = 0;
  let violation: string | null = null;

  while (p + 46 <= cenOffset + cenSize && seen < entryCount) {
    if (buf.readUInt32LE(p) !== CEN_SIG) {
      violation = violation ?? `中央目录第 ${seen + 1} 条记录签名异常 ⇒ 文件损坏`;
      break;
    }
    const compressed = buf.readUInt32LE(p + 20);
    const uncompressed = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);

    totalCompressed += compressed;
    totalUncompressed += uncompressed;
    if (compressed > 0) {
      const ratio = uncompressed / compressed;
      if (ratio > maxRatio) maxRatio = ratio;
    }

    p += 46 + nameLen + extraLen + commentLen;
    seen += 1;

    // 命中限额就**立刻停**，不必读完目录
    if (totalUncompressed > IMPORT_LIMITS.MAX_EXPANDED_BYTES) {
      violation =
        `解压后总大小超过上限（已累计 ${totalUncompressed} 字节 > ` +
        `${IMPORT_LIMITS.MAX_EXPANDED_BYTES}）⇒ 疑似压缩膨胀`;
      break;
    }
    if (maxRatio > IMPORT_LIMITS.MAX_COMPRESSION_RATIO) {
      violation = `单条目压缩比 ${maxRatio.toFixed(1)}:1 超过上限 ${IMPORT_LIMITS.MAX_COMPRESSION_RATIO}:1 ⇒ 疑似压缩膨胀`;
      break;
    }
  }

  return { entryCount: seen, totalUncompressed, totalCompressed, maxRatio, violation };
}

/** 超限即拒绝（错误码区分"膨胀"与"损坏"） */
export function assertZipWithinLimits(stat: ZipEntriesStat | null, filename: string): void {
  if (!stat) return;
  if (!stat.violation) return;

  const isExpansion = /膨胀/.test(stat.violation);
  throw new HistoricalImportRejected(
    isExpansion ? IMPORT_REJECT.EXPANDED_TOO_LARGE : IMPORT_REJECT.CORRUPT_FILE,
    `${filename}：${stat.violation}`,
    {
      entryCount: stat.entryCount,
      totalUncompressed: stat.totalUncompressed,
      totalCompressed: stat.totalCompressed,
      maxRatio: Number(stat.maxRatio.toFixed(2)),
    },
  );
}
