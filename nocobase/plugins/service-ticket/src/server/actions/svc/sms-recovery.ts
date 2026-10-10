/**
 * `svc:smsRecoverySweep` —— **按需跑一轮 `pending` 孤儿回收**（Phase 11 / P11-1 · B-16）。
 *
 * ===========================================================================
 * 为什么需要这个 action（两个理由，缺一个都不值得开它）
 * ===========================================================================
 * ① **真实验收需要确定性触发**。
 *    B-16 的验收必须走"真的让进程在事务提交后退出 → 重启 → 回收收敛"这条路，
 *    而定时任务是 **5 分钟**一次。若不提供按需入口，验收只能靠 sleep 等一个
 *    cron tick —— 那会让门禁既慢又脆（sleep 猜时机正是本项目反复吃亏的形状）。
 *    注意：**这里跑的是与 cron 完全相同的那个函数**，不是"给测试用的另一条路径"。
 *
 * ② **运维需要手动兜底**。
 *    在线恢复一条被误判/漏判的短信，不该要求运维等 5 分钟或重启服务。
 *
 * ===========================================================================
 * 安全形态：与 `svc:faultInject` / `guardQuota` **同一把锁**
 * ===========================================================================
 *   · **已登录**（进 `AUTHENTICATED_SVC_ACTIONS`，不进匿名白名单）；
 *   · **共享密钥** `X-Svc-Diag-Key` == 进程内 `SIGN_SECRET`，不匹配一律 **404**
 *     （与 guardQuota 同口径：语义唯一 —— 对外就是"没有这个接口"）；
 *   · **production 下不注册**（进 `PRODUCTION_FORBIDDEN_SVC_ACTIONS`：
 *     攻击面不存在，比 ACL 正确更强）。
 *
 * ⚠️ 它**只跑回收**，不接受任何"发给谁 / 发什么"的参数 ——
 *    参数化就等于开了一个"给人发任意短信"的口子。要补发什么，由
 *    `sms-orphan-resolver.ts` 按业务表裁决，不由调用方指定。
 */
import { DIAG_KEY_HEADER, SVC_ACTION } from '../../constants';
import { fail, ok } from './_http';
import { runSmsPendingRecoverySweep } from '../../services/sms-pending-recovery-scheduler';

export interface SmsRecoveryActionDeps {
  services: any;
  logger?: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
    debug?: (m: string) => void;
  };
}

export function createSmsRecoverySweepHandler(deps: SmsRecoveryActionDeps): any {
  return async (ctx: any) => {
    const expected = String(process.env.SIGN_SECRET ?? '').trim();
    const provided = String(ctx?.get?.(DIAG_KEY_HEADER) ?? '').trim();
    if (!expected || provided !== expected) {
      fail(ctx, 404, 'NOT_FOUND', 'Not Found');
      return;
    }

    const stats = await runSmsPendingRecoverySweep({
      services: deps.services,
      logger: deps.logger ?? {},
    });
    ok(ctx, { action: SVC_ACTION.SMS_RECOVERY_SWEEP, ...stats });
  };
}
