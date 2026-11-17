/**
 * 一次性管理引导（bootstrap）：P0-LOW-RATING-CLOSE 上线时统一关闭测试工单。
 *
 * 为什么用"引导文件"而不是 HTTP 接口：
 *   HTTP 接口在生产会长期存在，等于**永久**留一个能批量关单的入口 ——
 *   哪怕加了密钥，密钥也会泄漏在某台机器的命令行里。本方案的做法是：
 *     · 容器启动时读 `<cwd>/storage/.bootstrap/admin-close-batch.json`；
 *     · 读到 ⇒ 立刻改名成 `.running.<stamp>`（先在执行前占位，防止重入）；
 *     · 执行完 ⇒ 再改名成 `.done.<stamp>`，从此不再执行；
 *     · 文件不在 ⇒ 这一整段逻辑是死代码，零副作用。
 *   ⇒ 执行窗口只有"文件存在且容器启动"这一瞬间，跑完自动消失。
 *
 * 本模块只做三件事：
 *   1) 读并校验引导文件（JSON + 白名单字段 + 正整数 ID）；
 *   2) 按快照里**固定的 ID 列表**逐张调用 `TicketService.adminCloseTicket()`
 *      （真实领域服务 + 真事务，不是脚本里拼 SQL）；
 *   3) 把结果写成审计 JSON 落盘（storage 是 bind 挂载 ⇒ 宿主机直接可读）。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface CloseBatchResult {
  ok: boolean;
  reason?: string;
  total: number;
  closed: number;
  skipped: number;
  failed: number;
  voidedVisits: number;
  reviewRevoked: number;
  details: Array<Record<string, unknown>>;
}


/**
 * 引导目录的解析（**只解析一次**，避免"读"和"写结果"落到两个不同目录）。
 *
 * 历史上的一处误判（2026-11-06，记在这里免得再犯）：
 *   以为"宿主机 `/opt/.../src/storage/.bootstrap` ⇒ 容器内同名路径可见"，于是把文件放到
 *   挂载源根目录下。**实际不成立**：容器里能看到的只有挂载源的**那一个子目录**
 *   （`plugins/@local/service-ticket`），`/opt/...` 在容器内是独立文件系统，同名路径
 *   不存在或指向别处。表现是"文件明明传上去了，重启后毫无日志、文件原地不动"。
 *
 * 生产实际拓扑（`docker inspect scqf-as-app`）：
 *   · `/app/nocobase/storage`            ← 具名卷 `scqf-as-storage`
 *   · `/app/nocobase/storage/plugins/@local/service-ticket` ← bind 自宿主机同一卷的子路径
 *   ⇒ `process.cwd()` 是 `/app/nocobase`，所以 `storage/.bootstrap` **正好落在具名卷里**，
 *     在宿主机上的落点是
 *     `/var/lib/docker/volumes/scqf-as-storage/_data/.bootstrap`。
 *     **部署脚本往这里放文件即可**，不需要任何额外环境变量。
 *
 * ⚠️ 本函数返回的是**目录本身**（`.../storage/.bootstrap`），
 *    文件名请用 `FILE_NAME` 拼；不要再拼 `storage/.bootstrap` 那一整段
 *    —— 那样会得到 `.../storage/.bootstrap/storage/.bootstrap/xxx.json`
 *    （实测踩过：探测日志里路径重复了两遍，`存在=false`）。
 *
 * 仍然保留 `SVC_BOOTSTRAP_DIR` 覆盖项：本地演练 / 换拓扑时能显式指路，
 * 比"靠猜路径"安全 —— 猜错的失败形态（静默不执行）太难发现。
 */
function resolveBootstrapDir(): string {
  const override = String(process.env.SVC_BOOTSTRAP_DIR ?? '').trim();
  return override || path.join(process.cwd(), 'storage', '.bootstrap');
}

/** 引导文件名（目录由 `resolveBootstrapDir()` 决定） */
const FILE_NAME = 'admin-close-batch.json';

/**
 * 给启动日志用的一句话摘要（路径 + 是否存在）。
 *
 * 存在的价值：把"没读到文件"与"根本没进到引导函数"区分开。
 * 这两种沉默在日志里长得一模一样，但一个查路径、一个查上游是否抛错中断了整条链。
 */
export function describeBootstrapFile(): string {
  const file = path.join(resolveBootstrapDir(), FILE_NAME);
  return `${file} 存在=${fs.existsSync(file)}`;
}

/**
 * 引导文件 schema（多一个字段就拒绝 —— 防止"有人顺手往里塞 scope 条件"）。
 *
 * `ticketIds` 是**快照时固定**的 ID 列表，不接受 `WHERE` 这类可执行选择器：
 * 能执行选择器就意味着"每次启动关的东西可能不同"，那不是审计友好的做法。
 */
interface CloseBatchBootstrap {
  batchTag: string;
  reason: string;
  operatorUserId: number;
  operatorUsername: string;
  ticketIds: number[];
  createdAt: string;
}

function validate(raw: any): CloseBatchBootstrap {
  if (!raw || typeof raw !== 'object') throw new Error('引导文件不是 JSON 对象');
  const allowed = ['batchTag', 'reason', 'operatorUserId', 'operatorUsername', 'ticketIds', 'createdAt'];
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`引导文件含未知字段：${extra.join(', ')}`);

  const batchTag = String(raw.batchTag ?? '').trim();
  const reason = String(raw.reason ?? '').trim();
  const operatorUserId = Number(raw.operatorUserId);
  const ticketIds = Array.isArray(raw.ticketIds) ? raw.ticketIds.map((x: any) => Number(x)) : null;

  if (!batchTag) throw new Error('batchTag 不能为空');
  if (!reason) throw new Error('reason 不能为空');
  if (!Number.isInteger(operatorUserId) || operatorUserId <= 0) {
    throw new Error('operatorUserId 必须是正整数（事件要记"谁批的"）');
  }
  if (!ticketIds || ticketIds.length === 0) throw new Error('ticketIds 不能为空');
  if (ticketIds.some((x) => !Number.isInteger(x) || x <= 0)) {
    throw new Error('ticketIds 必须是正整数数组');
  }
  if (new Set(ticketIds).size !== ticketIds.length) throw new Error('ticketIds 有重复');

  return {
    batchTag,
    reason,
    operatorUserId,
    operatorUsername: String(raw.operatorUsername ?? ''),
    ticketIds,
    createdAt: String(raw.createdAt ?? ''),
  };
}

/**
 * 尝试执行引导任务。**任何异常都不抛**（启动流程不能被这个模块带崩）：
 * 引导失败时把错误写进结果文件，人工去看，而不是让 app 起不来。
 */
export async function runAdminCloseBatchOnce(app: any, services: any): Promise<CloseBatchResult | null> {
  const bootstrapDir = resolveBootstrapDir();
  const file = path.join(bootstrapDir, FILE_NAME);

  if (!fs.existsSync(file)) return null; // 常态：文件不存在 ⇒ 什么都不做

  // ⚠️ 先去掉毫秒与分隔符再截断，否则会留下一个尾点（`20261106092312.`）——
  //    文件名里带点会让 `*.done.<stamp>` 的 glob 判据变得不可靠。
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z?$/, '');
  const result: CloseBatchResult = {
    ok: false, total: 0, closed: 0, skipped: 0, failed: 0,
    voidedVisits: 0, reviewRevoked: 0, details: [],
  };

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const job = validate(raw);
    result.total = job.ticketIds.length;

    // 先"占位"：立刻改名，保证即使下面中途崩了，重启也不会再跑第二遍。
    // ⚠️ 必须**在**执行之前改名 —— 反过来就有"跑了一半、重启又从头跑"的窗口。
    expectNoop(fs.renameSync, file, file + '.running.' + stamp);

    app?.log?.info?.(`[svc-bootstrap] 开始执行统一关单任务 ${job.batchTag}（${job.ticketIds.length} 张）`);

    for (const ticketId of job.ticketIds) {
      try {
        const out = await services.tickets.adminCloseTicket({
          ticketId,
          batchTag: job.batchTag,
          reason: job.reason,
          operatorUserId: job.operatorUserId,
          operatorUsername: job.operatorUsername,
        });
        if (out.closed) {
          result.closed += 1;
          result.voidedVisits += out.voidedVisitIds.length;
          if (out.reviewRevoked) result.reviewRevoked += 1;
        } else {
          result.skipped += 1;
        }
        result.details.push(out);
      } catch (err: any) {
        result.failed += 1;
        result.details.push({ ticketId, error: String(err?.message ?? err) });
        app?.log?.warn?.(`[svc-bootstrap] 工单 ${ticketId} 关单失败：${err?.message ?? err}`);
      }
    }
    result.ok = result.failed === 0;
  } catch (err: any) {
    result.reason = String(err?.message ?? err);
    app?.log?.error?.(`[svc-bootstrap] 统一关单任务失败：${result.reason}`);
  }

  // 结果落盘（与引导文件同目录 ⇒ 宿主机直接可读，作为审计凭证）
  try {
    const outDir = bootstrapDir;
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, `admin-close-batch.result.${stamp}.json`),
      JSON.stringify({ stamp, ...result }, null, 2),
      'utf8',
    );
    if (fs.existsSync(file + '.running.' + stamp)) {
      expectNoop(fs.renameSync, file + '.running.' + stamp, file + '.done.' + stamp);
    }
  } catch (e: any) {
    app?.log?.warn?.(`[svc-bootstrap] 结果落盘失败：${e?.message ?? e}`);
  }

  app?.log?.info?.(
    `[svc-bootstrap] 统一关单任务结束：closed=${result.closed} skipped=${result.skipped} ` +
      `failed=${result.failed} voidedVisits=${result.voidedVisits} reviewRevoked=${result.reviewRevoked}`,
  );
  return result;
}

/** 让 TS 相信这是一个"同步、可能抛错"的调用点（fs.renameSync 的签名不好直接引用） */
function expectNoop(fn: (...args: any[]) => void, ...args: any[]): void {
  fn(...args);
}
