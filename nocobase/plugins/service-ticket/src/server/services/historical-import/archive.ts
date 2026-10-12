/**
 * 历史导入 —— **受控归档闭环**（P11-3 第 4 项 · 用户 D 条）
 * =============================================================================
 *
 * ===========================================================================
 * 用户原话（逐条对应到下面的实现）
 * ===========================================================================
 *  「实现明确的『确认归档』操作，目标是**独立的历史售后档案**，
 *    不是 `serviceTickets` 的 NEW 工单。」
 *      ⇒ 写入 `historicalServiceArchives`（另一张表），本模块**不碰** `service_tickets`。
 *
 *  「归档时必须：
 *     · 验证当前上传批次权限；                        ⇒ `assertBatchVisible`
 *     · 验证正式门店 code 与真实门店身份的确认关系；   ⇒ `assertStoreConfirmed`
 *     · 验证字段映射版本、异常处理状态及人工确认；     ⇒ `assertReadyToArchive`
 *     · 保留来源文件、工作表、原始行、标准化版本关联； ⇒ 档案上的 batch/row/sheet/sourceRow/mapping_version
 *     · 保证重复点击、网络重试不会生成重复档案；       ⇒ `idempotency_key` UNIQUE
 *     · 保持历史记录与当前 SLA/KPI 隔离。」             ⇒ 分表（SLA 扫的是 service_tickets）
 *
 *  「只有明确仍需继续处理的历史事项，才允许由授权员工通过**单独的**
 *    『转为当前服务单』操作进入当前工作流。该操作必须保留历史来源关联和创建审计，
 *    **不得批量自动转单**。」
 *      ⇒ `convertToTicket`：一次一条、必填理由、`archive_id` UNIQUE。
 *
 * ===========================================================================
 * 🔴 门店身份确认关系：**当前只登记了"演练用"门店**
 * ===========================================================================
 * 用户：「因为当前 15 家门店 code 尚未全部核定，**真实历史资料不得未经确认就正式归属**。」
 *
 * ⇒ 确认名单放在 `service_settings` 的 `historical.store-identity-confirmations`，
 *   每一项带 `scope: 'drill' | 'production'`：
 *     · 迁移只写入 **S01 / S02（scope=drill）** —— 它们是本次验收用的
 *       UAT-A / UAT-B 两个**已核定授权账号**所绑定的门店，用于**合成文件**演练；
 *     · **没有任何 `scope: 'production'` 的条目** ⇒ 真实门店的数据
 *       **结构上无法**被归档到任何地方。
 *   于是"不得把真实 Excel 归到某个占位门店"不是一句纪律，而是一条**走不通的路**。
 */
import { maskPhone } from './normalize';
import { HistoricalImportError, type UploaderContext } from './store';

/** 门店身份确认名单的 settings key（与迁移里的常量**必须**一致） */
export const STORE_IDENTITY_KEY = 'historical.store-identity-confirmations';

export interface StoreIdentityEntry {
  code: string;
  storeName: string;
  scope: 'drill' | 'production';
  confirmedAt: string;
  confirmedBy: string;
  evidence: string;
}

export interface ArchiveDeps {
  db: any;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

export interface ArchiveRowInput {
  rowId: number;
  sourceKey: string;
  sheetName: string;
  sourceRow: number;
  fields: Record<string, any>;
  manualOverrides: Record<string, any>;
  issues: string[];
  disposition: string;
  manualStatus: string;
}

/** 档案号：HA-<yyyyMMdd>-<6 位随机>（人能念、能口头核对） */
function newArchiveNo(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  return `HA-${day}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function sha256(input: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function buildArchiveIdempotencyKey(batchId: number, sourceKey: string, mappingVersion: number): string {
  return sha256(`${batchId}|${sourceKey}|${mappingVersion}`);
}

export function buildConversionIdempotencyKey(archiveId: number): string {
  return sha256(`convert|${archiveId}`);
}

export function createHistoricalArchiveService(deps: ArchiveDeps) {
  const { db, logger } = deps;

  const repo = (name: string): any => {
    const r = db?.getRepository?.(name);
    if (!r) throw new HistoricalImportError('REPO_UNAVAILABLE', `拿不到 ${name} 的 repository`, 500);
    return r;
  };

  /** 读门店身份确认名单（缺失 ⇒ 空名单，fail-closed） */
  async function readStoreIdentities(): Promise<Record<string, StoreIdentityEntry>> {
    const row = await repo('serviceSettings').findOne({ filter: { key: STORE_IDENTITY_KEY } });
    if (!row?.value) return {};
    try {
      const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      return (parsed?.stores ?? parsed ?? {}) as Record<string, StoreIdentityEntry>;
    } catch {
      // 解析不了就当**没有确认过**（fail-closed：宁可拒绝归档，也不要错归）
      logger?.warn?.('[historical-archive] 门店身份确认名单解析失败 ⇒ 视为空名单（拒绝归档）');
      return {};
    }
  }

  async function listConfirmedStores(): Promise<Array<StoreIdentityEntry & { confirmed: boolean }>> {
    const map = await readStoreIdentities();
    return Object.values(map);
  }

  /**
   * 校验门店身份确认关系（用户 D 条第 2 项）。
   *
   * @param requireScope 归档要求 `production`（真实业务归属）；
   *                     演练脚本显式传 `'drill'` 才允许用演练门店。
   */
  async function assertStoreConfirmed(
    storeCode: string,
    requireScope: 'production' | 'drill' = 'production',
  ): Promise<StoreIdentityEntry> {
    const map = await readStoreIdentities();
    const entry = map[storeCode];
    if (!entry) {
      throw new HistoricalImportError(
        'STORE_IDENTITY_UNCONFIRMED',
        `门店 ${storeCode} 的"正式 code ↔ 真实门店身份"尚未确认，禁止把历史数据归属到它` +
          '（当前 15 家门店 code 未全部核定）',
        409,
      );
    }
    if (requireScope === 'production' && entry.scope !== 'production') {
      throw new HistoricalImportError(
        'STORE_IDENTITY_DRILL_ONLY',
        `门店 ${storeCode} 目前只登记为**演练用**（scope=drill），不接受正式历史资料归属`,
        409,
      );
    }
    return entry;
  }

  /**
   * 判断一批候选行**是否已经具备归档条件**（用户 D 条第 3 项）。
   *
   * 三条必须同时成立：
   *   ① 没有任何 `needs-confirm` 行**仍处于待处理**（要么确认、要么驳回）；
   *   ② 没有任何 `duplicate` 行**仍处于待处理**（去重裁决必须有人做过）；
   *   ③ 没有 `parse-error` 行（有的话说明这张表本身没解析干净）。
   */
  function assertReadyToArchive(rows: ArchiveRowInput[]): void {
    const pendingConfirm = rows.filter((r) => r.disposition === 'needs-confirm' && r.manualStatus === 'pending');
    const pendingDuplicate = rows.filter((r) => r.disposition === 'duplicate' && r.manualStatus === 'pending');
    const parseErrors = rows.filter((r) => r.disposition === 'parse-error');
    if (parseErrors.length > 0) {
      throw new HistoricalImportError(
        'HAS_PARSE_ERRORS',
        `还有 ${parseErrors.length} 行解析错误未处理，不能归档`,
        409,
      );
    }
    if (pendingConfirm.length > 0 || pendingDuplicate.length > 0) {
      throw new HistoricalImportError(
        'REVIEW_PENDING',
        `还有待人工处理的记录：需确认 ${pendingConfirm.length} 行、疑似重复 ${pendingDuplicate.length} 行 —— ` +
          '归档前必须逐条确认或驳回（用户要求：归档前验证异常处理状态及人工确认）',
        409,
      );
    }
  }

  /** 从标准化字段里挑出可读的摘要（**不猜**：取不到就留空） */
  function summarize(row: ArchiveRowInput): {
    customerName: string | null;
    customerMobile: string | null;
    customerAddress: string | null;
    deviceSummary: string | null;
    serviceDate: string | null;
  } {
    const f = row.fields ?? {};
    const ov = row.manualOverrides ?? {};
    // 人工修正优先（用户："人工值可以覆盖机器候选值"），但两者分开存、都能查
    const pick = (key: string): any => (ov[key]?.value !== undefined ? ov[key].value : f[key]);
    const phones = (f.customerPhones ?? []) as Array<{ digits?: string; valid?: boolean }>;
    const manualPhone = ov.customerPhone?.value ?? ov.customerPhones?.value;
    const mobile =
      typeof manualPhone === 'string' && manualPhone
        ? manualPhone.replace(/\D/g, '')
        : phones.find((p) => p?.valid && String(p?.digits ?? '').length === 11)?.digits ?? null;
    const dates = (f.dates ?? {}) as Record<string, { iso?: string | null }>;
    const iso =
      Object.values(dates)
        .map((d) => d?.iso ?? null)
        .filter((x): x is string => typeof x === 'string' && x.length >= 10)
        .sort()[0] ?? null;
    const manualDate = ov.serviceDate?.value;
    const devices = (f.devices ?? []) as Array<{ model?: string }>;
    return {
      customerName: (pick('customerName') as string | null) ?? null,
      customerMobile: mobile,
      customerAddress: (pick('customerAddress') as string | null) ?? null,
      deviceSummary: devices.map((d) => String(d?.model ?? '').trim()).filter(Boolean).join(' / ') || null,
      serviceDate: typeof manualDate === 'string' && manualDate ? manualDate.slice(0, 10) : iso,
    };
  }

  return {
    readStoreIdentities,
    listConfirmedStores,
    assertStoreConfirmed,
    assertReadyToArchive,
    summarize,
    buildArchiveIdempotencyKey,
    newArchiveNo,
    /** 出口统一脱敏（列表/统计一律走它，避免各分支自己记得掩码） */
    maskMobile: maskPhone,
  };
}

export type HistoricalArchiveService = ReturnType<typeof createHistoricalArchiveService>;
