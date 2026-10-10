/**
 * `pending` 孤儿回收的**调度器**（Phase 11 / P11-1 · B-16）。
 *
 * ===========================================================================
 * 它在整条短信链路里的位置（与 `sms-retry-scheduler` **互补**，别混）
 * ===========================================================================
 *
 *   首发（`flush()` → `deliverOne`）
 *     ├─ 成功/业务拒绝 ⇒ `finish()` 落终态
 *     └─ 传输层失败   ⇒ 登记内存延迟队列
 *            ↓
 *        `SMS_RETRY`（每 5 分钟）—— 捞 **`send_status='error'`**：**发过但失败了**
 *
 *   ❓ 还有一类从来没人管：
 *      事务里 `enqueue()` 写了 `pending` 行，但 **`flush()` 还没跑**进程就退了
 *      （崩溃 / 重启 / 被 kill / 调用方漏调 flush）。
 *      ⇒ 它既不是 error（没发过），也不会被任何任务捞起，**永远静默卡在 pending**。
 *            ↓
 *        **本调度器**（每 5 分钟）—— 捞 **`send_status='pending'` 且超龄**：
 *        **压根没发出去**的
 *
 * ===========================================================================
 * 为什么"发不发"不在这里决定
 * ===========================================================================
 * 与另两个调度器同一纪律：**调度器只负责"什么时候跑、跑多少"**。
 * "这条孤儿该不该补发、补发什么"是领域裁决，在
 * `sms-orphan-resolver.ts` 里；"怎么发、怎么落状态"在 `SmsService` 里。
 * 本文件**不写一行 SQL、不做一次业务判断** —— 它只把三者接起来。
 *
 * ⚠️ 为什么 cron **不写进配置**：沿用 Phase 8 的取舍（不新增旋钮）。
 *    5 分钟与 `SMS_RETRY` 同频：两者捞的是同一件事的两半，节奏没有理由不同。
 */
import type { Services } from './index';
import { SMS_PENDING_ORPHAN_AFTER_MS, TASK_NAME } from '../constants';
import { TASK_RESULT, isShutdownSignal } from './task-registry';

export interface SmsPendingRecoveryDeps {
  services: Services;
  logger: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
    debug?: (m: string) => void;
  };
  /** cron 表达式。默认每 5 分钟（与 SMS_RETRY 同频）。 */
  cronTime?: string;
  /** 单轮最多处理多少条 */
  batchLimit?: number;
}

const DEFAULT_CRON = '*/5 * * * *';
const DEFAULT_BATCH = 50;

export interface SmsPendingRecoveryRunResult {
  /** 本轮捞到的超龄孤儿数 */
  scanned: number;
  /** 抢到认领资格（真正被本进程处理）的条数 */
  claimed: number;
  /** 重建后补发成功的条数 */
  resent: number;
  /** 判定**不发**并落显式终态的条数（含"凭据已失效""通知已过期"） */
  terminal: number;
  /** 没抢到资格（另一个 worker 已处理）的条数 */
  abandoned: number;
}

/**
 * 跑一轮孤儿回收。**可重复调用**（幂等由 `SMS_RECLAIM_SQL` 的原子谓词保证）。
 *
 * ⚠️ **永不抛错**：定时任务 onTick 里抛错会让 cron 库把任务标记异常并可能停止后续触发。
 */
export async function runSmsPendingRecoverySweep(
  deps: SmsPendingRecoveryDeps,
): Promise<SmsPendingRecoveryRunResult> {
  const { services, logger } = deps;
  const empty: SmsPendingRecoveryRunResult = {
    scanned: 0,
    claimed: 0,
    resent: 0,
    terminal: 0,
    abandoned: 0,
  };

  services.tasks?.start?.(TASK_NAME.SMS_PENDING_RECOVERY);

  try {
    const stats = await services.sms.recoverOrphanedPending(deps.batchLimit ?? DEFAULT_BATCH, {
      // ⚠️ `resolveSmsOrphan` **本身就是那个函数**（不是带 `.resolve` 方法的对象）。
      //    第一版这里写成 `services.smsOrphanResolver.resolve(row)` ⇒ 运行期
      //    「is not a function」⇒ 每条孤儿都被判 `STALE` 而不补发。
      //    它的**失败方向是安全的**（保守不发，绝不乱发），但"能重建的不补发"
      //    等于 B-16 只做了一半。⇒ 字段名改成动词短语，让"再点一个 .resolve"
      //    在阅读时就显得不对。
      resolve: (row) => services.resolveSmsOrphan(row),
    });
    const result: SmsPendingRecoveryRunResult = { ...stats };

    if (result.scanned > 0) {
      logger.info?.(
        `[sms-pending-recovery] 本轮 ${result.scanned} 条孤儿：认领 ${result.claimed} / ` +
          `补发成功 ${result.resent} / 判定不发 ${result.terminal} / 让出 ${result.abandoned}`,
      );
    } else {
      logger.debug?.('[sms-pending-recovery] 本轮无超龄 pending 短信');
    }

    // 结果分类：
    //   · 有"判定不发"的 ⇒ partial（那是**需要人看**的：凭据失效 / 通知过期）
    //   · 只有补发成功的 ⇒ success
    //   · 全都没抢到（纯竞争）⇒ success（什么都没发生，不是失败）
    services.tasks?.finish?.(
      TASK_NAME.SMS_PENDING_RECOVERY,
      result.terminal > 0 ? TASK_RESULT.PARTIAL : TASK_RESULT.SUCCESS,
      { processedCount: result.resent },
    );

    return result;
  } catch (error) {
    if (isShutdownSignal(error)) {
      logger.debug?.(
        `[sms-pending-recovery] 应用关闭中，本轮中止（非故障）：${(error as Error)?.message}`,
      );
      return empty;
    }
    logger.error?.(
      `[sms-pending-recovery] 本轮整体失败（下轮重试）：${(error as Error)?.message}`,
    );
    services.tasks?.finish?.(TASK_NAME.SMS_PENDING_RECOVERY, TASK_RESULT.FAILED, {
      processedCount: 0,
      error,
    });
    return empty;
  }
}

/**
 * 把孤儿回收注册进 `app.cronJobManager`（与 `registerSmsRetryJob` 同形）。
 *
 * 注册本身**不启动**：`CronJobManager` 在 app 的 `afterStart` 统一 `start()`。
 */
export function registerSmsPendingRecoveryJob(
  app: any,
  deps: SmsPendingRecoveryDeps,
): any | null {
  const manager = app?.cronJobManager;
  if (!manager || typeof manager.addJob !== 'function') {
    deps.logger.warn?.(
      '[sms-pending-recovery] app.cronJobManager 不可用，pending 孤儿回收**未注册** ' +
        '（事务提交后进程退出的短信会继续静默卡在 pending；可临时由外部调度调用 runSmsPendingRecoverySweep）',
    );
    return null;
  }

  const job = manager.addJob({
    cronTime: deps.cronTime ?? DEFAULT_CRON,
    onTick: () => {
      // 同另两个任务：刻意不 await，异常已在 sweep 内收干净
      void runSmsPendingRecoverySweep(deps);
    },
    start: false,
  });

  deps.logger.info?.(
    `[sms-pending-recovery] 已注册 pending 孤儿回收任务（cron=${deps.cronTime ?? DEFAULT_CRON}，` +
      `超龄下限 ${SMS_PENDING_ORPHAN_AFTER_MS} ms，上限取自 sms.retry_count）`,
  );

  return job;
}
