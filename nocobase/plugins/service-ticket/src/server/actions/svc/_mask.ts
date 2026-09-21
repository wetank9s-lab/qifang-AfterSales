/**
 * 响应体脱敏 —— 派工（serviceVisits）相关的共享实现。
 *
 * 为什么从 dispatch.ts 里搬出来单独成文件：
 *
 *   `svc:visits`（Phase 4-H3 工单详情抽屉）与派工三动作（`dispatch` /
 *   `reassign` / `reschedule`）返回的是**同一种对象**（Visit），
 *   但两者的"该删哪些列"略有差别：
 *     · 派工动作是**写操作**的响应，返回体小一点更安全（也少一点噪音）；
 *     · 抽屉是**给人看的历史**，需要保留"这条链接为什么失效"（`token_revoked_reason`）。
 *
 *   若各写一份，就会出现"某天改了派工响应的脱敏、忘了同步抽屉"，
 *   而这类不同步**不会让任何接口报错** —— 只会让某个页面悄悄少/多一个字段。
 *   所以把差异收敛成一个**显式选项**，两处共用同一份删除清单。
 *
 * ⚠️ 删除清单的基底是 `NATIVE_READ_FIELD_DENY`（constants.ts），
 *    而不是在这里再抄一遍列名 —— 新增敏感列时只要改那一处。
 */
import { nativeReadDenyFields } from '../../constants';
import type { SvcActionDeps } from './_request';

type Permissions = SvcActionDeps['services']['permissions'];

export interface MaskVisitOptions {
  /**
   * 保留 `token_revoked_reason`。
   *
   * 该列**不是凭据**（取值是 `REASSIGNED` / `RESCHEDULED` 这类枚举），
   * 而是业务上必须看得见的：派工记录页与工单详情抽屉都要显示
   * "这条师傅链接为什么失效"。判据是"泄露了会不会被利用"，
   * 不是"名字里有没有 token"（见 scripts/expected-sensitive-columns.mjs）。
   */
  keepRevokedReason?: boolean;
}

/**
 * 把一条 Visit 变成可以交给前端的形态。
 *
 * @param permissions 用于手机号脱敏（只读角色看不到完整号码）
 */
export function maskVisitForActor(
  permissions: Permissions,
  visit: any,
  actor: any,
  opts: MaskVisitOptions = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(visit ?? {}) };

  // ① 凭据列：任何时候都不离开服务端（基底来自 NATIVE_READ_FIELD_DENY）
  for (const column of nativeReadDenyFields('serviceVisits')) {
    delete out[column];
  }

  // ② 令牌**被撤销的时间**：排障用得上，但属于内部时间线，
  //    不进每次派工的响应体（响应越小，越不容易被误当成接口契约）。
  delete out.token_revoked_at;

  // ③ 失效原因：抽屉要显示，派工响应不需要（默认关闭，按需打开）
  if (!opts.keepRevokedReason) {
    delete out.token_revoked_reason;
  }

  // ④ 师傅手机号按角色脱敏（只读角色看不到完整号码）
  out.technician_mobile = permissions.maskMobile(out.technician_mobile, actor);
  return out;
}
