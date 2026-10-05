/**
 * 回执队列配置解析（Phase 10 / RB-8）—— **纯函数**，便于门禁离线逐字验证。
 *
 * 🔴 为什么单独一个文件、且不读 process.env：
 *   profile.ts 的纪律是"配置判定只有一处、且可离线验证"。这里同构 ——
 *   解析与使用分离，门禁能对任意 env 组合跑断言，而不必起应用。
 *
 * 环境变量（全部**必填**，缺一即视为"回执链路未配置"）：
 *   ALIYUN_SMS_RECEIPT_MNS_ENDPOINT  形如 https://<accountId>.mns.<region>.aliyuncs.com
 *                                    —— **必须从阿里云控制台复制**，不猜（不同地域/账号不同）
 *   ALIYUN_SMS_RECEIPT_MNS_QUEUE     SmsReport 队列名，形如 Alicom-Queue-xxxx-SmsReport
 *   ALIYUN_SMS_ACCESS_KEY_ID/SECRET  复用发送用的同一对 AccessKey（MNS 签名用）
 *
 * ⚠️ 刻意**不**为腾讯云预留变量：项目只落地了阿里云一个真实通道
 *   （`createSmsProvider` 里 tencent 落到 `NotImplementedSmsProvider`），
 *   为"架构对称"先写一套没有真实现支撑的配置解析，就是 DEV-92 的同型问题。
 */
import type { MnsConfig } from './sms-receipt-consumer';

export const RECEIPT_ENV_KEYS = {
  endpoint: 'ALIYUN_SMS_RECEIPT_MNS_ENDPOINT',
  queue: 'ALIYUN_SMS_RECEIPT_MNS_QUEUE',
  accessKeyId: 'ALIYUN_SMS_ACCESS_KEY_ID',
  accessKeySecret: 'ALIYUN_SMS_ACCESS_KEY_SECRET',
} as const;

export interface ReceiptConfigResolution {
  config: MnsConfig | null;
  /** 缺了哪些键（**只列键名，绝不回显值**） */
  missing: string[];
}

/** 长轮询秒数：官方建议并发长轮询要少，这里取 10（上限是 20） */
const DEFAULT_WAIT_SECONDS = 10;
/** 单轮最多处理条数：一条 tick 的尾巴不该拖到下一轮 */
const DEFAULT_MAX_PER_TICK = 50;

export function resolveReceiptConfig(
  env: Record<string, string | undefined>,
): ReceiptConfigResolution {
  const missing: string[] = [];
  const get = (k: string): string => {
    const v = String(env[k] ?? '').trim();
    if (v === '') missing.push(k);
    return v;
  };

  const endpoint = get(RECEIPT_ENV_KEYS.endpoint);
  const queueName = get(RECEIPT_ENV_KEYS.queue);
  const accessKeyId = get(RECEIPT_ENV_KEYS.accessKeyId);
  const accessKeySecret = get(RECEIPT_ENV_KEYS.accessKeySecret);

  if (missing.length > 0) return { config: null, missing };

  // ⚠️ 端点只做形状校验，不做可达性探测 ——
  //    启动期发网络请求会把"配置对不对"变成"网络好不好"，后者会随机地拒绝启动。
  //    真正的连通性由回执消费任务每轮暴露（health / 日志），不在启动期把关。
  if (!/^https:\/\/[a-z0-9.-]+\.mns\.[a-z0-9-]+\.aliyuncs\.com\/?$/i.test(endpoint)) {
    return {
      config: null,
      missing: [`${RECEIPT_ENV_KEYS.endpoint}(形状不合法：应为 https://<accountId>.mns.<region>.aliyuncs.com)`],
    };
  }

  return {
    config: {
      endpoint,
      queueName,
      accessKeyId,
      accessKeySecret,
      waitSeconds: DEFAULT_WAIT_SECONDS,
      maxMessagesPerTick: DEFAULT_MAX_PER_TICK,
    },
    missing: [],
  };
}

/**
 * production 档下"回执链路是否必须存在"的判定。
 *
 * 🔴 用户 2026-10-05 裁决（RB-8 判 A 类发布阻塞）：**没有回执，delivered 就永远没有真实输入来源**，
 *    而"accepted ≠ delivered"是本项目冻结的语义边界 ⇒ 不能让它在生产上静默失效。
 *
 * ⚠️ 只在"通道 = 阿里云"时要求：mock（开发/验收）与未实现通道（tencent）不适用 ——
 *    对它们要求回执等于要求一个不存在的供应商能力。
 */
export function receiptRequiredForProvider(provider: string): boolean {
  return String(provider ?? '').trim().toLowerCase() === 'aliyun';
}
