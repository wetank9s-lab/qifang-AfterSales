/**
 * ConfigService —— 运行期参数读取（serviceSettings 表的唯一读取入口）
 *
 * 为什么需要它，而不是各处直接查表：
 *  1) **禁止魔法数**（工程约定）。阈值/上限/时长只能来自 serviceSettings 或 .env，
 *     任何一处写死 120、7、30 都是隐患 —— 上线后运营改了后台参数却不生效。
 *  2) **类型转换集中一处**。表里 value 一律是字符串，读取方需要 int / bool / json。
 *     散落各处的 Number(x) || 7 这种写法在 value='0' 时会退化成 7，是隐蔽 bug。
 *  3) **缺键要有确定行为**。参数没种上（首次安装失败、后台误删）时，
 *     必须回退到 DEFAULT_SETTINGS 的代码默认值并记警告，而不是抛错让接口 500。
 *
 * 缓存策略：进程内短 TTL 缓存（默认 10s）。
 *   - 为什么不是永久缓存：运营在后台改参数后不该等重启。
 *   - 为什么不是每次查库：SLA 扫描、限流判断会在一个请求内读多次。
 *   - 为什么 TTL 而不是事件失效：serviceSettings 允许被 NocoBase 原生接口直接改，
 *     挂 ORM hook 会漏掉批量更新；10s 的偏差对"阈值类参数"完全可接受。
 */
import { DEFAULT_SETTINGS, type SettingSeed } from '../constants';

export type SettingValueType = 'int' | 'bool' | 'string' | 'json';

interface CacheEntry {
  value: string | null;
  /** 是否真的查到了库里的行（false 表示回退到代码默认值） */
  fromDb: boolean;
  expiresAt: number;
}

export interface ConfigServiceOptions {
  /** 默认 10_000ms */
  ttlMs?: number;
  /** 告警回调：缺键/类型不对时调用，便于 health 与日志暴露 */
  onWarn?: (message: string) => void;
  logger?: { warn?: (msg: string) => void; debug?: (msg: string) => void };
}

export class ConfigService {
  private readonly db: any;
  private readonly ttlMs: number;
  private readonly onWarn?: (message: string) => void;
  private readonly logger?: ConfigServiceOptions['logger'];

  private readonly cache = new Map<string, CacheEntry>();

  /** 代码默认值索引，用于回退与类型推断 */
  private readonly seeds = new Map<string, SettingSeed>(
    DEFAULT_SETTINGS.map((seed) => [seed.key, seed]),
  );

  constructor(db: any, options: ConfigServiceOptions = {}) {
    this.db = db;
    this.ttlMs = options.ttlMs ?? 10_000;
    this.onWarn = options.onWarn;
    this.logger = options.logger;
  }

  /** 清空缓存（后台改完参数后可主动调用；测试里也用它隔离用例） */
  invalidate(key?: string): void {
    if (key === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(key);
  }

  /**
   * 读字符串值。查不到库里行时回退代码默认值；两者都没有则返回 fallback。
   */
  async getString(key: string, fallback?: string): Promise<string | undefined> {
    const entry = await this.read(key);
    if (entry.value !== null && entry.value !== undefined) return entry.value;

    const seed = this.seeds.get(key);
    if (seed) return seed.value;
    return fallback;
  }

  /**
   * 读整数。
   *
   * 关键点：value 存在但**解析不出整数**时（后台被填成 'abc'），
   * 走告警 + 回退默认值，而不是 NaN —— NaN 传进 SQL 的 LIMIT / INTERVAL 会直接报错。
   */
  async getInt(key: string, fallback?: number): Promise<number> {
    const raw = await this.getString(key);
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return this.intFallback(key, fallback);
    }

    const parsed = Number(String(raw).trim());
    if (!Number.isFinite(parsed)) {
      this.warn(`参数 ${key} 的值 "${raw}" 不是合法整数，已回退默认值`);
      return this.intFallback(key, fallback);
    }
    return Math.trunc(parsed);
  }

  /**
   * 读布尔。
   * 接受 '1'/'true'/'yes'/'on'（忽略大小写）为真，'0'/'false'/'no'/'off' 为假；
   * 其它值告警并回退。**不接受** JS 的隐式真值 —— 字符串 'false' 是 truthy，
   * 直接 Boolean('false') 会得到 true，这是最经典的配置坑。
   */
  async getBool(key: string, fallback?: boolean): Promise<boolean> {
    const raw = await this.getString(key);
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return this.boolFallback(key, fallback);
    }

    const normalized = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;

    this.warn(`参数 ${key} 的值 "${raw}" 不是合法布尔，已回退默认值`);
    return this.boolFallback(key, fallback);
  }

  /**
   * 读 JSON。解析失败时告警并回退，绝不抛出 ——
   * 一个坏掉的 json 参数不该让整个报表接口 500。
   */
  async getJson<T = unknown>(key: string, fallback?: T): Promise<T | undefined> {
    const raw = await this.getString(key);
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      const seed = this.seeds.get(key);
      if (seed && seed.valueType === 'json') {
        return safeParse<T>(seed.value, undefined);
      }
      return fallback;
    }
    const parsed = safeParse<T>(raw, fallback as T);
    if (parsed === undefined) {
      this.warn(`参数 ${key} 的值不是合法 JSON，已回退默认值`);
    }
    return parsed;
  }

  /**
   * 一次性读出多个键（同一 SQL），用于 SLA 扫描这类需要批量取阈值的场景。
   * 返回的 Map 只含**真实存在**的键；缺键请用 getInt/getBool 走回退。
   */
  async getMany(keys: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (keys.length === 0) return result;

    const repository = this.db.getRepository('serviceSettings');
    const rows = await repository.find({
      filter: { key: { $in: keys } },
    });

    for (const row of rows || []) {
      const key = String(row.key);
      const value = row.value === null || row.value === undefined ? '' : String(row.value);
      result.set(key, value);
      this.cache.set(key, { value, fromDb: true, expiresAt: Date.now() + this.ttlMs });
    }

    return result;
  }

  /** 读出全部参数（后台「参数配置」页用），按 key 升序 */
  async getAll(): Promise<Array<{ key: string; value: string | null; valueType: string }>> {
    const repository = this.db.getRepository('serviceSettings');
    const rows = await repository.find({ sort: ['key'] });
    return (rows || []).map((row: any) => ({
      key: String(row.key),
      value: row.value === null || row.value === undefined ? null : String(row.value),
      valueType: String(row.value_type || 'string'),
    }));
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async read(key: string): Promise<CacheEntry> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }

    let entry: CacheEntry;
    try {
      const repository = this.db.getRepository('serviceSettings');
      const row = await repository.findOne({ filter: { key } });

      entry = row
        ? {
            value: row.value === null || row.value === undefined ? '' : String(row.value),
            fromDb: true,
            expiresAt: Date.now() + this.ttlMs,
          }
        : { value: null, fromDb: false, expiresAt: Date.now() + this.ttlMs };

      if (!row && this.seeds.has(key)) {
        this.logger?.debug?.(`参数 ${key} 不在库中，回退代码默认值`);
      }
    } catch (error) {
      // 查库失败（例如启动早期表还没建好）：**不缓存**，下次重试，并回退默认值。
      // 这里刻意不抛错：配置读取失败应当降级，而不是让调用方的接口 500。
      this.warn(`读取参数 ${key} 失败，本次回退默认值：${(error as Error)?.message}`);
      return { value: null, fromDb: false, expiresAt: 0 };
    }

    this.cache.set(key, entry);
    return entry;
  }

  private intFallback(key: string, fallback?: number): number {
    const seed = this.seeds.get(key);
    if (seed) {
      const parsed = Number(seed.value);
      if (Number.isFinite(parsed)) return Math.trunc(parsed);
    }
    if (fallback !== undefined) return fallback;
    this.warn(`参数 ${key} 既不在库中也无默认值，返回 0`);
    return 0;
  }

  private boolFallback(key: string, fallback?: boolean): boolean {
    const seed = this.seeds.get(key);
    if (seed) {
      const normalized = String(seed.value).trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
      if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback ?? false;
  }

  private warn(message: string): void {
    this.onWarn?.(message);
    this.logger?.warn?.(message);
  }
}

function safeParse<T>(raw: string, fallback: T | undefined): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
