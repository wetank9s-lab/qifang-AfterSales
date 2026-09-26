/**
 * 评价超时自动关闭的**调度器**（Phase 7 / 契约 §7）。
 *
 * ---------------------------------------------------------------------------
 * 为什么调度器只负责"挑名单 + 逐条调领域服务"，自己不写一行 SQL
 * ---------------------------------------------------------------------------
 * 用户明令：**核心状态竞争与不变量放领域服务，调度器不得绕过领域服务改核心状态**。
 * 这不是形式要求 —— 如果这里写一条 `UPDATE ... SET status='CLOSED'`，就会得到
 * **第二处**状态推进逻辑，而它与 `submitReview()` 的条件更新是两套谓词。
 * 两套谓词只要有一处不一致（少写了 `feedback_token_used_at IS NULL`），
 * 就会出现"客户刚提交完评价、超时任务把它又改成 CLOSED/expired"的脏数据，
 * 且两边各自的测试都是绿的（各自测的是自己那份谓词）。
 * 因此：
 *   · 挑名单：`tickets.listReviewExpiryCandidates()`（**只读**）
 *   · 改状态：`tickets.expireReview()`（**唯一**的状态推进点，原子谓词在它内部）
 *
 * ---------------------------------------------------------------------------
 * 为什么用 `app.cronJobManager` 而不是 NocoBase Workflow
 * ---------------------------------------------------------------------------
 *   ① 本项目**未安装 workflow 插件**（真机取证：`@nocobase/plugin-workflow*`
 *      在镜像里存在，但未在 `APPEND_PRESET_BUILT_IN_PLUGINS`/启用列表里，
 *      因此 `app.pm.get('workflow')` 拿不到实例）；
 *   ② `app.cronJobManager` 是 server 包**自带**的（`application.js` 的 `init()`
 *      里 `new CronJobManager(this)`，并在 `afterStart` 自动 `start()`），
 *      零额外依赖。
 *   ③ 即便将来接了 Workflow，它也**只应调用领域服务**（如本调度器做的），
 *      不得在 Workflow 节点里直接 UPDATE 工单表。
 *
 * ---------------------------------------------------------------------------
 * 幂等与重复扫描
 * ---------------------------------------------------------------------------
 * 定时任务天然会重复运行、也可能多实例并发跑。安全性不靠"只跑一次"，
 * 而靠 `expireReview()` 里那条**原子谓词**：`affected rows = 0` ⇒ no-op。
 * 因此重复扫描**不会**产生重复事件，也不会把已提交评价的工单改成过期。
 */
import type { Services } from './services';
import { TICKET_STATUS } from '../constants';

export interface ReviewExpirySchedulerDeps {
  services: Services;
  logger: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
    debug?: (m: string) => void;
  };
  /** cron 表达式。默认每天 03:00（业务上"评价 7 天窗口"用日粒度足够） */
  cronTime?: string;
  /** 单轮最多处理多少条（防止一次扫描把整表拉进内存） */
  batchLimit?: number;
}

/** 默认调度：每天 03:00 扫一次。避开业务高峰，且与运维值班时间错开。 */
const DEFAULT_CRON = '0 3 * * *';
const DEFAULT_BATCH = 200;

/** 一次扫描的结果（写进日志，便于回答"任务到底跑没跑、关了哪些"） */
export interface ReviewExpiryRunResult {
  scanned: number;
  expired: number;
  skipped: number;
  errors: number;
}

/**
 * 跑一轮评价超时扫描。**可重复调用**（幂等），也是门禁脚本直接调用的入口。
 *
 * ⚠️ 它**永不抛错**：定时任务的 onTick 里抛错会让 `cron` 库把任务标记为
 *    异常并可能停止后续触发；而"这一轮某一条失败"绝不是"整个任务该停"的理由
 *    （下一条、下一轮仍应继续）。单条失败记 warn 并计数，主循环继续。
 */
export async function runReviewExpirySweep(
  deps: ReviewExpirySchedulerDeps,
): Promise<ReviewExpiryRunResult> {
  const { services, logger } = deps;
  const result: ReviewExpiryRunResult = { scanned: 0, expired: 0, skipped: 0, errors: 0 };

  try {
    // ⚠️ 窗口天数读**已播种**的 `feedback.wait_days`（默认 7），不新增配置项
    //    （契约 §12；`constants.ts` L1571-1576 的硬规则）。
    const days = await services.config.getInt('feedback.wait_days', 7);
    const windowDays = Number.isFinite(days) && days > 0 ? Math.trunc(days) : 7;

    const candidates = await services.tickets.listReviewExpiryCandidates(
      windowDays,
      deps.batchLimit ?? DEFAULT_BATCH,
    );
    result.scanned = candidates.length;

    for (const candidate of candidates) {
      try {
        const outcome = await services.tickets.expireReview(candidate.id, windowDays);
        if (outcome.expired) {
          result.expired += 1;
          logger.info?.(
            `[review-expiry] 工单 ${candidate.ticket_no} 超过 ${windowDays} 天未评价 → CLOSED（review_status=expired）`,
          );
        } else {
          // 命中"已被客户提交 / 已被别的扫描关掉 / 恰好同一瞬间提交了"
          // —— 这是**正常的竞争 loser**，不是错误。
          result.skipped += 1;
        }
      } catch (error) {
        result.errors += 1;
        logger.warn?.(
          `[review-expiry] 工单 ${candidate.ticket_no} 关闭失败（已跳过，不影响其它）：${
            (error as Error)?.message
          }`,
        );
      }
    }

    if (result.scanned > 0) {
      logger.info?.(
        `[review-expiry] 本轮扫描 ${result.scanned} 条：过期关闭 ${result.expired} / ` +
          `跳过 ${result.skipped} / 失败 ${result.errors}（窗口 ${windowDays} 天）`,
      );
    } else {
      logger.debug?.('[review-expiry] 本轮无待关闭工单');
    }
  } catch (error) {
    // 连"读窗口 / 挑名单"都失败（如数据库不可用）—— 记 error，但不抛。
    logger.error?.(`[review-expiry] 本轮整体失败（下轮重试）：${(error as Error)?.message}`);
  }

  return result;
}

/**
 * 把评价超时扫描注册进 `app.cronJobManager`。
 *
 * 调用点在插件 `load()`。注册本身**不启动**任务 —— `CronJobManager` 在
 * `app` 的 `afterStart` 事件里统一 `start()`（构造函数里挂的监听）。
 * 因此这里即便在 `load()` 阶段调用，真正开始调度也是在应用就绪之后。
 *
 * 返回值是 `CronJob` 实例（可用于 `removeJob`，热重载时先摘旧的）。
 */
export function registerReviewExpiryJob(
  app: any,
  deps: ReviewExpirySchedulerDeps,
): any | null {
  const manager = app?.cronJobManager;
  if (!manager || typeof manager.addJob !== 'function') {
    // 宿主没提供（测试桩 / 裁剪过的发行版）：**告警而不是抛错**。
    // 与其它启动期自检的取舍一致：缺这个能力只影响"超时自动关闭"这一条路径，
    // 不该让整个应用起不来；但它必须**被看见**，否则表现是
    // "窗口早就过了，工单还挂在 WAIT_FEEDBACK，且日志里什么都查不到"。
    deps.logger.warn?.(
      '[review-expiry] app.cronJobManager 不可用，评价超时自动关闭**未注册** ' +
        '（工单不会自动关闭；可临时改由外部调度调用 runReviewExpirySweep）',
    );
    return null;
  }

  const job = manager.addJob({
    cronTime: deps.cronTime ?? DEFAULT_CRON,
    onTick: () => {
      // ⚠️ 刻意**不 await**：cron 库不关心 onTick 的返回值，而若它返回
      //    rejected promise，Node 会报 unhandledRejection。
      //    `runReviewExpirySweep` 内部已把所有异常收成日志，因此这里安全。
      void runReviewExpirySweep(deps);
    },
    start: false,
  });

  deps.logger.info?.(
    `[review-expiry] 已注册评价超时扫描任务（cron=${deps.cronTime ?? DEFAULT_CRON}，` +
      `窗口取自 feedback.wait_days）`,
  );

  return job;
}

/** 供门禁/健康检查引用：这个任务在 WAIT_FEEDBACK 之外的工单上不该有任何动作 */
export const REVIEW_EXPIRY_SOURCE_STATUS = TICKET_STATUS.WAIT_FEEDBACK;
