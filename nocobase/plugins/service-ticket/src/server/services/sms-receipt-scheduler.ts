/**
 * 短信**送达回执**消费任务（Phase 10 / RB-8）。
 *
 * 它在整个送达链路里的位置：
 *
 *   提交（flush → provider.send）
 *     └─ sms_logs: send_status=accepted, delivery_status=pending,
 *                 provider_biz_id = 供应商 BizId   ← RB-8 新增，唯一匹配键
 *   ↓
 *   **本任务**（每分钟，长轮询 MNS 队列）
 *     └─ 回执 → 只改 delivery_status / delivered_at / error_code / error_message
 *                （绝不动 Ticket / Visit —— 见 sms-receipt-consumer.ts 文件头）
 *
 * ⚠️ 为什么**不**做成 HTTP 回调端点：阿里云的 HTTP 批量推送**不带任何签名**
 *   （官方文档核对结论，见 docs/DEVIATIONS.md DEV-100），公开端点只能靠自签或来源 IP 鉴权。
 *   MNS 队列消费由阿里云签名鉴权，且**不需要任何公网入口**。
 *
 * ⚠️ 为什么本调度器**不写一行 SQL**（与 sms-retry 同一纪律）：
 *   幂等与单调性全部落在 `applyReceipt()` 的**条件更新**里，调度器只管"什么时候跑、跑多少"。
 *   把判据写在调度器里就等于出现第二份实现。
 */
import { MnsReceiptClient, runReceiptTick, type MnsConfig, type TickResult } from './sms-receipt-consumer';
import { TASK_NAME } from '../constants';
import { TASK_RESULT, isShutdownSignal } from './task-registry';

export interface SmsReceiptConsumerDeps {
  /** 由插件在 load() 时从 env 解析；缺项 ⇒ 本任务不注册（并在生产档已被启动闸门拦下） */
  config: MnsConfig | null;
  db: any;
  /** 与 sms_logs.provider 一致的小写名（aliyun / tencent / mock） */
  provider: string;
  logger: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
    debug?: (m: string) => void;
  };
  fetchFn?: typeof fetch;
  cronTime?: string;
  /** 注册进度回调（供 health / 门禁观察"任务真的在跑"） */
  onTickComplete?: (result: TickResult) => void;
}

/**
 * 默认每分钟。
 *
 * ⚠️ 为什么不是每 5 分钟（与 sms-retry 一致）：回执的价值全在"及时"——
 *   客户说"我没收到"时，运营看到的是 pending 还是 delivered，处置动作完全不同。
 *   每分钟一轮 + 轮内长轮询，覆盖官方"开启回执后建议等待 3 分钟生效"的缓存窗口。
 */
const DEFAULT_CRON = '* * * * *';

const EMPTY: TickResult = { received: 0, applied: 0, skipped: {}, deleteFailed: 0 };

/**
 * 跑一轮回执消费。**永不抛错**（cron 库会把抛错的任务标记异常并可能停止后续触发）。
 */
export async function runSmsReceiptSweep(deps: SmsReceiptConsumerDeps): Promise<TickResult> {
  const { logger } = deps;

  // 未配置 ⇒ 直接跳过而不是报错：
  // 开发/测试档（mock 通道）本就没有队列，此时"跳过"是正确形态，不是故障。
  if (!deps.config) {
    logger.debug?.('[sms-receipt] 未配置 MNS 队列（开发/测试档或非阿里云通道），本轮跳过');
    return EMPTY;
  }

  const client = new MnsReceiptClient({
    fetchFn: deps.fetchFn ?? (globalThis.fetch as typeof fetch),
    config: deps.config,
    logger,
  });

  try {
    const result = await runReceiptTick({
      client,
      db: deps.db,
      provider: deps.provider,
      maxPerTick: deps.config.maxMessagesPerTick,
      logger,
    });
    deps.onTickComplete?.(result);
    return result;
  } catch (error) {
    if (isShutdownSignal(error)) {
      logger.debug?.(`[sms-receipt] 应用关闭中，本轮中止（非故障）：${(error as Error)?.message}`);
      return EMPTY;
    }
    logger.error?.(`[sms-receipt] 本轮整体失败（下轮重试）：${(error as Error)?.message}`);
    return EMPTY;
  }
}

export function registerSmsReceiptConsumerJob(
  app: any,
  deps: SmsReceiptConsumerDeps,
): any | null {
  if (!deps.config) {
    deps.logger.info?.(
      '[sms-receipt] 未配置 MNS 队列 ⇒ **不注册**回执消费任务（delivery_status 将一直是 pending）',
    );
    return null;
  }

  const manager = app?.cronJobManager;
  if (!manager || typeof manager.addJob !== 'function') {
    deps.logger.warn?.(
      '[sms-receipt] app.cronJobManager 不可用，回执消费**未注册** ' +
        '（delivery_status 会一直是 pending；可临时改由外部调度调用 runSmsReceiptSweep）',
    );
    return null;
  }

  const job = manager.addJob({
    cronTime: deps.cronTime ?? DEFAULT_CRON,
    onTick: () => {
      void runSmsReceiptSweep(deps);
    },
    start: false,
  });

  deps.logger.info?.(
    `[sms-receipt] 已注册送达回执消费任务（cron=${deps.cronTime ?? DEFAULT_CRON}，` +
      `provider=${deps.provider}，长轮询 ${deps.config?.waitSeconds}s）`,
  );
  return job;
}
