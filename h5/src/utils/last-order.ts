/**
 * 客户「最近工单」的本机保存（UX-LAST-ORDER-01）。
 *
 * =============================================================================
 * 三条硬约束（用户拍板的契约）
 * =============================================================================
 *   1. **默认不保存**：只有在成功页勾选「在此设备记住这张工单」后才写；页面加载/提交成功
 *      本身**绝不**自动落盘。
 *   2. **按门店 code 分区**：key = `svc.lastOrder.v1.<storeCode>`，`storeCode` 必须来自
 *      服务端解析的入口（`store-entry`），不是用户输入 ⇒ S01 的记录不会被 S02 读到。
 *   3. **只存必要数据**：工单号 / 进度 Token / 门店 code / 类型 / 创建时间 / 保存时间 /
 *      自动进入开关。**不存**姓名、手机号、地址、故障描述等任何客户资料。
 *
 * ⚠️ 进度 Token 是 bearer 凭证：勾选处必须明确告知"只在本浏览器、公共手机请勿勾选"。
 *    本模块不发送任何网络请求（校验在页面侧调用既有进度接口）。
 */

export interface LastOrderRecord {
  v: 1;
  storeCode: string;
  ticketNo: string;
  token: string;
  ticketType: 'repair' | 'complaint';
  /** 工单创建时间（ISO 字符串，页面已从 URL 拿到） */
  createdAt: string;
  /** 本机保存时间（ms） */
  savedAt: number;
  /** 是否"下次自动进入上一单"（第二个独立开关） */
  autoOpen: boolean;
}

const KEY_PREFIX = 'svc.lastOrder.v1.';
/** 本机记录最长保留 30 天（与"关闭后保留 30 天"口径一致，且防止无限期留存） */
export const LAST_ORDER_MAX_AGE_MS = 30 * 86_400_000;

const keyOf = (storeCode: string): string => `${KEY_PREFIX}${storeCode}`;

function safeStorage(): Storage | null {
  try {
    // 隐私模式下访问 localStorage 可能直接抛错
    const s = globalThis.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function isValidRecord(raw: unknown, storeCode: string): raw is LastOrderRecord {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return false;
  if (String(r.storeCode) !== storeCode) return false;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(r.token))) return false;
  if (!String(r.ticketNo)) return false;
  if (r.ticketType !== 'repair' && r.ticketType !== 'complaint') return false;
  return true;
}

/** 读本机记录；不存在/损坏/过期/门店不匹配 ⇒ null（并顺手清掉损坏项） */
export function readLastOrder(storeCode: string, now = Date.now()): LastOrderRecord | null {
  if (!storeCode) return null;
  const storage = safeStorage();
  if (!storage) return null;
  let raw: unknown = null;
  try {
    raw = JSON.parse(storage.getItem(keyOf(storeCode)) ?? 'null');
  } catch {
    removeLastOrder(storeCode);
    return null;
  }
  if (!isValidRecord(raw, storeCode)) {
    if (raw) removeLastOrder(storeCode);
    return null;
  }
  const rec = raw as LastOrderRecord;
  if (now - Number(rec.savedAt || 0) > LAST_ORDER_MAX_AGE_MS) {
    removeLastOrder(storeCode);
    return null;
  }
  return rec;
}

/** 保存（只应在用户显式勾选时调用） */
export function saveLastOrder(rec: Omit<LastOrderRecord, 'v' | 'savedAt'>): boolean {
  const storage = safeStorage();
  if (!storage || !rec.storeCode) return false;
  const value: LastOrderRecord = { ...rec, v: 1, savedAt: Date.now() };
  if (!isValidRecord(value, rec.storeCode)) return false;
  try {
    storage.setItem(keyOf(rec.storeCode), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** 更新"自动进入"开关（只有已记住的记录才存在） */
export function setLastOrderAutoOpen(storeCode: string, autoOpen: boolean): boolean {
  const rec = readLastOrder(storeCode);
  if (!rec) return false;
  return saveLastOrder({ ...rec, autoOpen });
}

export function removeLastOrder(storeCode: string): void {
  const storage = safeStorage();
  if (!storage || !storeCode) return;
  try {
    storage.removeItem(keyOf(storeCode));
  } catch {
    /* noop */
  }
}

/** 测试/排障用：列出本机所有最近工单 key（不含内容） */
export function listLastOrderKeys(): string[] {
  const storage = safeStorage();
  if (!storage) return [];
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (k && k.startsWith(KEY_PREFIX)) keys.push(k);
    }
  } catch {
    /* noop */
  }
  return keys;
}

/** 师傅端「上一单已完成」摘要（**不含 Token、不含客户资料**） */
export interface TechLastDone {
  ticketNo: string;
  completedAt: number;
}

const TECH_KEY = 'svc.tech.lastDone.v1';

export function saveTechLastDone(ticketNo: string): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    // 只存单号与时间：不存 Token、不存客户信息、不存金额
    storage.setItem(TECH_KEY, JSON.stringify({ ticketNo: String(ticketNo || ''), completedAt: Date.now() }));
  } catch {
    /* noop */
  }
}

export function readTechLastDone(): TechLastDone | null {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const raw = JSON.parse(storage.getItem(TECH_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return null;
    if (!raw.completedAt) return null;
    return { ticketNo: String(raw.ticketNo || ''), completedAt: Number(raw.completedAt) };
  } catch {
    return null;
  }
}

export function clearTechLastDone(): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.removeItem(TECH_KEY);
  } catch {
    /* noop */
  }
}
