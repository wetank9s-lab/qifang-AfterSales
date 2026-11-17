/**
 * 文件清理任务的 Cron 注册（TECH-PHOTO-DELETE-STORAGE-01）。
 *
 * ⚠️ 2026-10-23 根因修正（读 `@nocobase/server/lib/application.js` 得到）：
 *   `beforeStop` 会在 **3 个**地方 emit：
 *     · `reInit()`（:408）—— 启动期也可能走这里：beforeStop → afterStop → disposeServices
 *       → closeLogger → `init()` → **`oldDb.close()`**；
 *     · `restart()`（:680）；· `stop()`（:702）。
 *
 *   由此得两条必须遵守的结论：
 *   ① **不能**在 `beforeStop` 里 removeJob / 置停机标志 —— reInit 也会触发它，
 *      会在正常启动流程里把 Job 摘掉（上一版就是死在这）。
 *   ② 幂等标记**不能只看"有没有 job"**：reInit 之后 `cronJobManager` 是新的，
 *      旧 job 属于已销毁的 manager。若仍跳过注册，新 manager 里**一个 Job 都没有**，
 *      Cron 永不触发（这是上一次 S14 失败的真正原因，不是停机守卫）。
 *   ⇒ 幂等键必须是 **manager 实例**：`已注册 && 同一个 manager` 才跳过。
 *
 * 停机语义：不依赖任何钩子。reInit/stop 时 manager 被销毁，tick 自然不再触发；
 * 已 in-flight 的 sweep 若撞上 `oldDb.close()`，由消费者侧按"连接已关闭"识别并放弃，
 * 其任务靠**租约**在下一轮恢复 —— 这才是真正的最终一致性来源。
 */
import { runFileDeletionSweep, type SweepDeps } from './file-deletion-consumer';

const DEFAULT_CRON = '*/5 * * * *';

export interface FileDeletionSchedulerDeps extends SweepDeps {
  cronTime?: string;
}

export function registerFileDeletionJob(app: any, deps: FileDeletionSchedulerDeps): any | null {
  const manager = app?.cronJobManager;
  if (!manager || typeof manager.addJob !== 'function') {
    deps.logger?.error?.(
      '[file-deletion] cronJobManager 不可用：文件清理任务**未注册**，' +
        '删除后的物理文件将滞留（任务仍在 pending_file_deletions 中，可被后续实例接管）',
    );
    return null;
  }

  // 幂等键 = manager 实例（reInit 后 manager 变了，必须重新注册到新 manager）
  if (app.__svcFileDeletionJob && app.__svcFileDeletionManager === manager) {
    deps.logger?.info?.('[file-deletion] 当前 manager 已持有清理任务，跳过重复注册（幂等）');
    return app.__svcFileDeletionJob;
  }

  const job = manager.addJob({
    cronTime: deps.cronTime ?? DEFAULT_CRON,
    onTick: () => {
      void runFileDeletionSweep({
        db: deps.db,
        photos: deps.photos,
        logger: deps.logger,
      }).catch((error: any) => {
        const msg = String(error?.message ?? error);
        // 停机/reInit 期间旧连接被关：这是**预期**而非故障，降级为 info，不刷 error
        if (msg.includes('connection manager was closed') || msg.includes('ConnectionManager')) {
          deps.logger?.info?.(`[file-deletion] 跳过本轮（应用正在重载/停机）：${msg}`);
          return;
        }
        deps.logger?.error?.(`[file-deletion] sweep 异常：${msg}`);
      });
    },
    start: false,
  });

  app.__svcFileDeletionJob = job;
  app.__svcFileDeletionManager = manager;
  deps.logger?.info?.(
    `[file-deletion] 已注册文件清理任务（cron=${deps.cronTime ?? DEFAULT_CRON}，租约 120s，pid=${process.pid}）`,
  );
  return job;
}
