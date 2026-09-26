/**
 * 定时任务运行状态登记处（Phase 8 / P8-A，契约 §1）。
 *
 * ---------------------------------------------------------------------------
 * 这个模块解决什么问题
 * ---------------------------------------------------------------------------
 * Phase 8 之前，`/api/svc:health` 的 `tasks` 字段恒为 `'ok' | 'skipped'`
 * （只反映"插件 load 完了没"），**实际上没有检查任何任务**。于是最难排查的形态
 * 长期无解：**"任务到底没跑、跑失败、还是跑了但没命中"** —— 三者从外部看一模一样。
 *
 * 本模块给每个任务记录**最近一次运行**的六个字段（契约 §1 冻结）：
 *
 *   task_name            任务标识
 *   last_started_at      最近一次开始
 *   last_finished_at     最近一次结束
 *   last_result          success | partial | failed
 *   last_processed_count 最近一轮处理条数
 *   last_error           截断后的安全摘要（**不存敏感数据**）
 *   last_success_at      ⚠️ 最近一次成功 —— 比 last_result=failed 更有诊断价值：
 *                        能看出**已经连续多久没有成功执行**
 *
 * ⚠️ **只描述"最近运行情况"，不做完整 job history**（不建历史表、不做趋势）。
 *
 * ---------------------------------------------------------------------------
 * 🔴 铁律（用户 2026-09-26 明确强调）：记录失败绝不能影响任务本身的业务执行
 * ---------------------------------------------------------------------------
 * 反例（**绝不允许**）：review-expiry 已经完成领域操作（工单已 CLOSED），
 * 之后写 `last_finished_at` 失败 → 于是把**已经完成的业务事务回滚**。
 *
 * 正确形态：**任务业务结果与 observability 写入彻底解耦**。
 *   · 本模块的每一个写方法**永不抛错**（内部 try/catch 吞掉，只记日志）；
 *   · 调用方**不需要** try/catch 包裹本模块（它不会把异常抛回去）；
 *   · 写失败时，health 会显示状态**陈旧/异常**（`stale`），
 *     但**绝不让"监控任务的系统"成为任务可靠性的单点故障**。
 *
 * ⇒ 一句话：**observability 是"尽力而为"的旁路，不是事务的一部分。**
 *
 * ---------------------------------------------------------------------------
 * 为什么状态存内存而不是库
 * ---------------------------------------------------------------------------
 * 契约 O8-3 倾向"不改数据模型"。理由：
 *   · 这是**进程级运行状态**，语义上本就随进程生命周期；重启后归零是**正确的**
 *     （重启前那次运行的结果，对"当前进程的任务是否健康"没有诊断价值）；
 *   · 落库会引入"每次任务运行都写一张表"的写放大，以及多实例下的归属问题；
 *   · health 的既有口径是**查库实时判定**（针对"数据在不在"），
 *     而本模块回答的是"**本进程的任务跑得怎么样**"，两者性质不同，不矛盾。
 * ⚠️ 正因存内存，health 必须**如实标注**：重启后 `lastRunAt = null` 表示
 *    "本进程还没跑过"，**不是**"任务坏了"。
 */
import { TASK_NAME, type TaskName } from '../constants';

/** 单次运行的结果分类（契约 §1 冻结） */
export const TASK_RESULT = {
  /** 整轮无失败 */
  SUCCESS: 'success',
  /** 有失败但并非整轮失败（如 10 条里 1 条失败）—— 必须与 success 区分 */
  PARTIAL: 'partial',
  /** 整轮失败（连挑名单/读配置都没成功） */
  FAILED: 'failed',
} as const;

export type TaskResult = (typeof TASK_RESULT)[keyof typeof TASK_RESULT];

/** 每个任务的最近运行状态（契约 §1 的七个字段） */
export interface TaskRunState {
  taskName: TaskName;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastResult: TaskResult | null;
  lastProcessedCount: number;
  lastError: string | null;
  /** ⚠️ 最近一次**成功**的时刻。用于回答"已经连续多久没成功了" */
  lastSuccessAt: string | null;
  /** 本进程内累计运行轮数（排障用：确认"有没有被触发过"） */
  runCount: number;
  /** 本进程内累计失败轮数（含 partial） */
  failureCount: number;
}

/** health 里每个任务的对外形状（不含 runCount 等内部计数也一并给出，便于排障） */
export type TaskHealthSnapshot = Omit<TaskRunState, 'taskName'> & {
  /** 是否从未在本进程运行过（重启后为 true 属正常，**不代表故障**） */
  neverRan: boolean;
};

/** `last_error` 的最大长度 —— 截断以防把堆栈/大对象写进 health 响应 */
const MAX_ERROR_LENGTH = 200;

/**
 * 把任意错误消息截断成**安全摘要**。
 *
 * ⚠️ 契约 §1：`last_error` 必须是"截断后的安全摘要，不存敏感数据"。
 *    这里做两件事：① 截断长度；② 去掉换行（health 是单行 JSON，堆栈会撑爆可读性）。
 *    ⚠️ 刻意**不**做"敏感词过滤"式的假安全 —— 真正的敏感数据（token / 密钥）
 *       本来就不该出现在错误消息里（这是各服务自己的责任）。这里只负责**形态**安全。
 */
function toSafeError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })();
  const oneLine = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MAX_ERROR_LENGTH) return oneLine;
  return `${oneLine.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}

/**
 * 判断一次任务异常是否**只是"应用正在关闭/热重载"**，而非真正的业务失败。
 *
 * ⚠️ 为什么需要它（Phase 8 实测踩到）：
 *   `cronJobManager` 的 `onTick` 用 `void` 触发、不 await，因此定时任务可能在
 *   **应用关闭 / 热重载**的瞬间仍在飞。此刻 Sequelize 连接池已被 `close()`，
 *   任何 DB 查询都会抛 "ConnectionManager.getConnection was called after the
 *   connection manager was closed"。这是**关机竞态**，不是 SLA/短信坏了。
 *   若把它当 error 记日志并 `finish(FAILED)`：
 *     ① 冒烟测试的"应用就绪后无 error"断言被关机噪声打红；
 *     ② health 里 `lastResult=failed` 会误导运维以为任务真坏了。
 *   ⇒ 调度器 catch 里先判本函数，命中则**静默返回**（debug 日志），不记 FAILED。
 *
 * ⚠️ 判据刻意**收窄**：只认"连接管理器已关闭 / 正在关闭"这类明确措辞，
 *    不把"连接超时/拒绝/池耗尽"（那些是**真**故障）混进来。
 */
export function isShutdownSignal(error: unknown): boolean {
  const msg = toSafeError(error).toLowerCase();
  return (
    msg.includes('connection manager was closed') ||
    msg.includes('connection was closed') ||
    msg.includes('connection is closed') ||
    msg.includes('shutting down') ||
    msg.includes('connection closed')
  );
}

export interface TaskRegistryOptions {
  logger?: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
    debug?: (m: string) => void;
  };
  /** 时钟注入（测试用） */
  now?: () => Date;
}

/**
 * 定时任务运行状态登记处。
 *
 * ⚠️ 所有写方法**永不抛错** —— 见文件头"铁律"。
 */
export class TaskRegistry {
  private readonly states = new Map<TaskName, TaskRunState>();
  /**
   * 派生事实缓存（Phase 8 / P8-C）：任务算出的"当前事实"（如 SLA overdue 计数）。
   * ⚠️ 与 `states` 同为**进程级**，重启后清空 —— 语义一致，见 `putFact` 的说明。
   */
  private readonly facts = new Map<TaskName, { value: unknown; at: string }>();
  private readonly logger: TaskRegistryOptions['logger'];
  private readonly now: () => Date;

  constructor(taskNames: readonly TaskName[], options: TaskRegistryOptions = {}) {
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    for (const name of taskNames) {
      this.states.set(name, {
        taskName: name,
        lastStartedAt: null,
        lastFinishedAt: null,
        lastResult: null,
        lastProcessedCount: 0,
        lastError: null,
        lastSuccessAt: null,
        runCount: 0,
        failureCount: 0,
      });
    }
  }

  /**
   * 标记"本轮开始"。
   *
   * ⚠️ 与 `finish()` 一样**永不抛错**。但语义上它比 finish 更重要：
   *    如果连"开始"都没记上，读者会以为任务从没被触发；所以失败时记 error 日志。
   */
  start(taskName: TaskName): void {
    try {
      const state = this.ensure(taskName);
      state.lastStartedAt = this.now().toISOString();
      state.runCount += 1;
      // 新一轮开始 ⇒ 清掉上一轮的错误，避免"上次的错"被误读成本轮的结果。
      // （本轮若再失败，finish 会重新写入。）
      state.lastError = null;
    } catch (error) {
      this.logger?.error?.(
        `[task-registry] 记录 ${taskName} 开始失败（已忽略，不影响任务本身）：${toSafeError(error)}`,
      );
    }
  }

  /**
   * 标记"本轮结束"，并落结果。
   *
   * @param processedCount 本轮实际处理的条数（scanned 或 expired，由调用方语义决定）
   * @param error 本轮的错误（无则省略）；⚠️ 会被截断成安全摘要
   *
   * ⚠️ **永不抛错** —— 这是本模块最重要的性质。调用方在业务事务提交之后调用它，
   *    它失败**绝不能**让调用方以为"业务也失败了"。
   */
  finish(
    taskName: TaskName,
    result: TaskResult,
    options: { processedCount?: number; error?: unknown } = {},
  ): void {
    try {
      const state = this.ensure(taskName);
      const finishedAt = this.now();
      state.lastFinishedAt = finishedAt.toISOString();
      state.lastResult = result;
      state.lastProcessedCount = Number.isFinite(options.processedCount)
        ? Math.max(0, Math.trunc(options.processedCount as number))
        : 0;
      if (options.error !== undefined && options.error !== null) {
        state.lastError = toSafeError(options.error);
      } else if (result === TASK_RESULT.FAILED) {
        // 判为 failed 却没有任何 error 信息 ⇒ 至少留一句，避免"failed 但没原因"
        state.lastError = state.lastError ?? '（未提供错误详情）';
      }
      if (result !== TASK_RESULT.FAILED) {
        state.failureCount += result === TASK_RESULT.PARTIAL ? 1 : 0;
      } else {
        state.failureCount += 1;
      }
      // ⚠️ last_success_at 只在**完全成功**时推进。
      //    partial 刻意**不**推进 —— 它的语义是"有失败"，若推进就会掩盖"连续多久没全好"。
      if (result === TASK_RESULT.SUCCESS) {
        state.lastSuccessAt = finishedAt.toISOString();
      }
    } catch (error) {
      this.logger?.error?.(
        `[task-registry] 记录 ${taskName} 结束失败（已忽略，不影响任务本身）：${toSafeError(error)}`,
      );
    }
  }

  /** 读取单个任务的快照（health 用）。未登记的任务名返回 null。 */
  snapshot(taskName: TaskName): TaskHealthSnapshot | null {
    const state = this.states.get(taskName);
    if (!state) return null;
    return this.toSnapshot(state);
  }

  /** 读取全部任务的快照，按登记顺序（health 用） */
  snapshotAll(): Record<string, TaskHealthSnapshot> {
    const out: Record<string, TaskHealthSnapshot> = {};
    for (const [name, state] of this.states) {
      out[name] = this.toSnapshot(state);
    }
    return out;
  }

  /**
   * 汇总判据：是否有任务"运行过但最近一次不是 success"。
   *
   * 用途：health 的顶层 `tasks` 字段由它决定 —— 这样"某个任务红着"能被一行断言抓到，
   * 而不用去翻每个任务的明细。⚠️ `neverRan` **不算**异常（重启后正常）。
   */
  hasAttention(): boolean {
    for (const state of this.states.values()) {
      if (state.lastResult === TASK_RESULT.FAILED || state.lastResult === TASK_RESULT.PARTIAL) {
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Phase 8 / P8-C：派生事实缓存（供 health 读取，避免每次探针重算）
  // -------------------------------------------------------------------------

  /**
   * 缓存某个任务最近一次算出的**派生事实**（当前只有 SLA overdue 三个计数）。
   *
   * ⚠️ 为什么不直接每次在 health 里重算：
   *   health 是**高频探针**。每次探针都跑一遍全表扫描（还带日志）会有三个坏处：
   *     ① 浪费（探针可能每分钟数十次）；
   *     ② **日志污染**（探针本身不该产生业务日志）；
   *     ③ 口径分裂（探针算一次、定时任务算一次，两者时刻不同 ⇒ 数字对不上）。
   *   ⇒ 由**定时任务**算出后写进这里，health 只读这个缓存；
   *      若缓存为空（重启后还没到第一次 tick），health **如实标注新鲜度**，
   *      而不是假装有值、也不是当场重算。
   *
   * ⚠️ 与其它写方法同样**永不抛错**。
   */
  putFact<T>(taskName: TaskName, fact: T): void {
    try {
      this.facts.set(taskName, { value: fact, at: this.now().toISOString() });
    } catch (error) {
      this.logger?.error?.(`[task-registry] 缓存 ${taskName} 事实失败（已忽略）：${toSafeError(error)}`);
    }
  }

  /** 读取缓存的派生事实（无缓存返回 null） */
  getFact<T>(taskName: TaskName): { value: T; at: string } | null {
    const entry = this.facts.get(taskName);
    if (!entry) return null;
    return { value: entry.value as T, at: entry.at };
  }

  private toSnapshot(state: TaskRunState): TaskHealthSnapshot {
    const { taskName: _taskName, ...rest } = state;
    return { ...rest, neverRan: state.lastStartedAt === null };
  }

  /**
   * 拿到（必要时创建）某个任务的状态。
   *
   * ⚠️ 刻意**允许**未登记的名字：任务名常量与注册列表可能一时不同步，
   *    但"漏登记"不该让记录直接丢失（否则又变成"什么都查不到"）。
   */
  private ensure(taskName: TaskName): TaskRunState {
    let state = this.states.get(taskName);
    if (!state) {
      state = {
        taskName,
        lastStartedAt: null,
        lastFinishedAt: null,
        lastResult: null,
        lastProcessedCount: 0,
        lastError: null,
        lastSuccessAt: null,
        runCount: 0,
        failureCount: 0,
      };
      this.states.set(taskName, state);
      this.logger?.warn?.(`[task-registry] 未登记的任务名 ${taskName}，已动态补登`);
    }
    return state;
  }
}

/** 本项目的任务名全集（与 health 的 tasks 段一一对应） */
export const TASK_NAMES: readonly TaskName[] = [TASK_NAME.REVIEW_EXPIRY, TASK_NAME.SMS_RETRY, TASK_NAME.SLA_SCAN];

export function createTaskRegistry(options: TaskRegistryOptions = {}): TaskRegistry {
  return new TaskRegistry(TASK_NAMES, options);
}
