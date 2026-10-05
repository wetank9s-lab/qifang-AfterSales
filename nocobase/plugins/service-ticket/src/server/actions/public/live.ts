/**
 * **存活**探针 action（Phase 10 / P10-B，liveness）
 *
 * 路径：GET /api/svc:live
 *
 * ---------------------------------------------------------------------------
 * 它与 `svc:health` 是**两个不同问题的答案**，不要合并、也不要互相替代
 * ---------------------------------------------------------------------------
 *   liveness（`svc:live`）   —— **进程活着吗**
 *   readiness（`svc:health`）—— **能接生产流量吗**
 *
 * 合成一个字段会同时产生两种真实故障：
 *   · 只有 readiness ⇒ DB 抖动时被判"不健康"，编排系统重启一个本来健康的进程
 *     （把一次抖动放大成一次重启风暴）；
 *   · 只有 liveness ⇒ 生产依赖不满足（禁止的 mock provider、关键配置缺失、
 *     基线数据没播）时照样放行流量 —— 攻击面已经敞开才被发现。
 *
 * ---------------------------------------------------------------------------
 * 🔴 本 handler 的硬约束（由 `scripts/verify-config.mjs` 静态钉住）
 * ---------------------------------------------------------------------------
 *   ① **不得触碰任何外部依赖**：不查库（`ctx.app.db`）、不查表、不读文件、不发网络请求。
 *      它必须在"数据库已经彻底不可用"时仍然 200 —— 否则它就不是 liveness。
 *   ② **响应体恒为 `{ status: 'ok' }`**：不回版本号、任务名、表数、profile、
 *      更不回任何异常细节。它是公网匿名可达的，可泄露信息必须为零。
 *   ③ **不得抛错**：任何内部异常都要被吞掉并仍然回 200。
 *      "探针自己崩了"不能表现成 500 —— 那会让编排系统重启一个活着的进程。
 *
 * ⚠️ 为什么连 `ctx.app.log` 都不写：它是高频探针（与 health 同频），
 *    每次写日志会刷满日志卷，也会让"日志无 error"类断言被噪声淹没。
 */
import { PKG_NAME } from '../../constants';

/** 进程启动时刻（模块加载即求值，不依赖任何运行时状态） */
const BOOTED_AT = new Date().toISOString();
const BOOT_MS = Date.now();

export interface LiveRuntime {
  pluginVersion?: string;
}

export function createLiveHandler(runtime: LiveRuntime = {}) {
  return async function svcLive(ctx: any, next: any): Promise<void> {
    // ⚠️ 刻意**不**读 ctx.app.db / ctx.app.resourcer / 任何外部依赖。
    //    这里每多一次 IO，liveness 就少一分意义。
    const uptimeSeconds = Math.round((Date.now() - BOOT_MS) / 1000);
    const version = runtime.pluginVersion || 'unknown';

    // 🔴 响应体只有 status —— 版本/启动时刻**只进响应头**，不进 body。
    //    理由：body 会被任意匿名请求原样取走（公网可达），而 `X-Svc-*` 头
    //    只在运维抓包/排障时有用，且不含任何部署拓扑信息。
    //    ⚠️ 即便如此也**不回** profile / 表名 / 任务名 —— 那些是 readiness 的详情档内容。
    if (typeof ctx.set === 'function') {
      ctx.set('X-Svc-Plugin', `${PKG_NAME}@${version}`);
      ctx.set('X-Svc-Uptime', String(uptimeSeconds));
      ctx.set('X-Svc-Booted-At', BOOTED_AT);
      // 明确告诉抓取方"这是 liveness 不是 readiness"，避免有人拿它当上线判据
      ctx.set('X-Svc-Probe', 'liveness');
    }

    ctx.status = 200;
    ctx.body = { status: 'ok' };

    await next();
  };
}
