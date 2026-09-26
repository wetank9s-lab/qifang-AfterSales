/**
 * SMS 延迟重试的**调度器**（Phase 8 / P8-B）。
 *
 * ---------------------------------------------------------------------------
 * 它在整个重试链路里的位置
 * ---------------------------------------------------------------------------
 *   首发（`flush()` 里的 `deliverOne`）
 *     ├─ transport error / timeout
 *     │    ├─ 内联立刻重试（同一次 flush 调用内，最多 retryLimit 次）
 *     │    └─ 仍失败 ⇒ **登记进内存延迟重试队列**（`SmsService.enqueueRetry`）
 *     └─ 业务拒绝（模板没配 / 号码错误）⇒ 不登记（再试也是同样的结果）
 *   ↓
 *   **本调度器**（每 5 分钟）调 `SmsService.retryPending(batch)`
 *     └─ 逐条：**先原子 claim 取得发送资格** → 才调供应商 → 落结果
 *          ├─ 成功 ⇒ 正常结束
 *          └─ 仍失败 ⇒ **终态失败**（`send_status=error` 留库，可被 HQ / health 发现）
 *
 * ⚠️ 本调度器**不写一行 SQL**：发送资格由 `claimForRetry` 的条件更新裁决，
 *    落状态由 `finish` 完成。与 `review-expiry-scheduler` 同一纪律 ——
 *    调度器只负责"什么时候跑、跑多少"，**不负责**"什么算合法"。
 *
 * ---------------------------------------------------------------------------
 * 🔴 用户 2026-09-26 明令的硬点
 * ---------------------------------------------------------------------------
 * > **retry claim 必须先原子取得发送资格，再调用外部 SMS provider。**
 * > 不能先发短信再尝试更新 retry_count，否则两个 worker 竞争时已经重复发送，
 * > 数据库再正确也救不回来。
 * ⇒ 顺序保证落在 `SmsService.retryPending()` 内部（claim → safeSend → finish），
 *   调度器本身**不提供**任何绕过它的入口。
 *
 * ---------------------------------------------------------------------------
 * 为什么 cron 不写进配置
 * ---------------------------------------------------------------------------
 * 与 `review-expiry` 同样的取舍（契约 §5）：**不新增配置项**。
 * 重试是"尽快自愈"型任务，5 分钟粒度足够，且比首发更频繁是合理的
 * （首发由业务动作触发，本来就是即时的）。
 */
import type { Services } from './services';
import { TASK_NAME } from '../constants';
import { TASK_RESULT, isShutdownSignal } from './task-registry';

export interface SmsRetrySchedulerDeps {
  services: Services;
  logger: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
    debug?: (m: string) => void;
  };
  /** cron 表达式。默认每 5 分钟。 */
  cronTime?: string;
  /** 单轮最多处理多少条（与 review-expiry 的 batch 同口径） */
  batchLimit?: number;
}

/**
 * 默认调度：每 5 分钟。
 *
 * ⚠️ 比 `review-expiry`（每日一次）密得多，因为语义不同：
 *    那个任务处理的是"7 天窗口"，日粒度就够；本任务处理的是"刚才没发出去的短信"，
 *    越早重发越有意义（客户可能正等着作业链接）。
 */
const DEFAULT_CRON = '*/5 * * * *';
const DEFAULT_BATCH = 50;

/** 一次重试轮次的结果 */
export interface SmsRetryRunResult {
  /** 本轮从队列取出处理的条数 */
  scanned: number;
  /** 抢到发送资格（真正调了供应商）的条数 */
  claimed: number;
  /** 重试后成功受理的条数 */
  accepted: number;
  /** 未抢到资格 / 重试后仍失败 ⇒ 不再放回队列的条数 */
  abandoned: number;
  /** 通道未启用 ⇒ 本轮跳过（且放回队列等下次）的条数 */
  skipped: number;
}

/**
 * 跑一轮 SMS 延迟重试。**可重复调用**（幂等由 `claimForRetry` 的原子谓词保证）。
 *
 * ⚠️ **永不抛错**：定时任务 onTick 里抛错会让 cron 库把任务标记异常并可能停止后续触发。
 *    单条失败记 warn 并计数，主循环继续。
 */
export async function runSmsRetrySweep(deps: SmsRetrySchedulerDeps): Promise<SmsRetryRunResult> {
  const { services, logger } = deps;
  const empty: SmsRetryRunResult = {
    scanned: 0,
    claimed: 0,
    accepted: 0,
    abandoned: 0,
    skipped: 0,
  };

  // Phase 8 / P8-A：登记"本轮开始"（可选链兜底 —— 缺 observability 不该让任务跑不起来）
  services.tasks?.start?.(TASK_NAME.SMS_RETRY);

  try {
    const stats = await services.sms.retryPending(deps.batchLimit ?? DEFAULT_BATCH);
    const result: SmsRetryRunResult = {
      scanned: stats.scanned,
      claimed: stats.claimed,
      accepted: stats.accepted,
      abandoned: stats.abandoned,
      skipped: stats.skipped,
    };

    if (result.scanned > 0) {
      logger.info?.(
        `[sms-retry] 本轮 ${result.scanned} 条：取得资格 ${result.claimed} / 成功 ${result.accepted} / ` +
          `转入终态或让出 ${result.abandoned} / 跳过 ${result.skipped}`,
      );
    } else {
      logger.debug?.('[sms-retry] 本轮无待重试短信');
    }

    // ⚠️ 结果分类：
    //    · accepted > 0 且没有"重试仍失败" ⇒ success
    //    · 有重试仍失败的（abandoned 里包含"重试后仍失败"）⇒ partial
    //    由于 abandoned 也包含"没抢到资格"这种正常竞争 loser，无法从中区分，
    //    因此这里用"claimed > accepted"作为"确实有重试失败的"判据（只在真发过时才成立）。
    const hadFailure = result.claimed > result.accepted;
    services.tasks?.finish?.(
      TASK_NAME.SMS_RETRY,
      hadFailure ? TASK_RESULT.PARTIAL : TASK_RESULT.SUCCESS,
      { processedCount: result.accepted },
    );

    return result;
  } catch (error) {
    // ⚠️ 关机/热重载竞态：连接池已关，静默中止（不记 FAILED、不打 error）
    if (isShutdownSignal(error)) {
      logger.debug?.(`[sms-retry] 应用关闭中，本轮中止（非故障）：${(error as Error)?.message}`);
      return empty;
    }
    logger.error?.(`[sms-retry] 本轮整体失败（下轮重试）：${(error as Error)?.message}`);
    services.tasks?.finish?.(TASK_NAME.SMS_RETRY, TASK_RESULT.FAILED, { processedCount: 0, error });
    return empty;
  }
}

/**
 * 把 SMS 延迟重试注册进 `app.cronJobManager`。
 *
 * 与 `registerReviewExpiryJob` 同形：注册本身**不启动**，
 * `CronJobManager` 在 app 的 `afterStart` 统一 `start()`。
 */
export function registerSmsRetryJob(app: any, deps: SmsRetrySchedulerDeps): any | null {
  const manager = app?.cronJobManager;
  if (!manager || typeof manager.addJob !== 'function') {
    deps.logger.warn?.(
      '[sms-retry] app.cronJobManager 不可用，短信延迟重试**未注册** ' +
        '（失败短信不会自动补发；可临时改由外部调度调用 runSmsRetrySweep）',
    );
    return null;
  }

  const job = manager.addJob({
    cronTime: deps.cronTime ?? DEFAULT_CRON,
    onTick: () => {
      // 同 review-expiry：刻意不 await，异常已在 runSmsRetrySweep 内收干净
      void runSmsRetrySweep(deps);
    },
    start: false,
  });

  deps.logger.info?.(
    `[sms-retry] 已注册短信延迟重试任务（cron=${deps.cronTime ?? DEFAULT_CRON}，` +
      `上限取自 sms.retry_count）`,
  );

  return job;
}
