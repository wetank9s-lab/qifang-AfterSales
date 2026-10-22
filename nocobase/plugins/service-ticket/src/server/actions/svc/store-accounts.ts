/**
 * SEC-STORE-01：门店账号 ↔ 授权门店（受控动作）。
 *
 * `svc:storeAccounts`         —— 列出**门店角色账号**与其当前门店（只读；仅 hq_admin）
 * `svc:updateStoreAccountStores` —— 整体替换某账号的门店集合（写；仅 hq_admin；事务+并发+幂等+审计）
 *
 * 为什么必须走受控动作而不是原生 `storeUsers` 写：
 *   · 原生写要么全关（业务角色），要么只能给 root —— hq_admin 目前连 `storeUsers:list` 都是 403；
 *   · 授权变更是**安全边界变更**，必须带白名单校验、并发控制、幂等与审计；
 *   · 不开放 `users` / `roles` / `storeUsers` 的原生读写，避免绕过 B-8。
 */
import { CAPABILITY } from '../../services/permission-service';
import {
  listStoreAccounts,
  updateStoreAccountStores,
  type UpdateStoreAccountResult,
} from '../../services/store-account-service';
import { ValidationError } from '../../services/ticket-service';
import { fail, ok } from './_http';
import {
  createWrapper,
  param,
  paramPresence,
  requireRequestId,
  usernameOf,
  type ActionHandler,
  type SvcActionDeps,
} from './_request';

export interface StoreAccountDeps extends SvcActionDeps {
  db: any;
}

function intOf(raw: unknown, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError('STORE_ACCOUNT_BAD_USER', `${label} 必须是正整数（实际 ${JSON.stringify(raw ?? null)}）`);
  }
  return n;
}

export function createStoreAccountHandlers(deps: StoreAccountDeps): Record<string, ActionHandler> {
  const { services, logger, db } = deps;
  const { permissions } = services;
  const wrap = createWrapper(deps);

  /** 只读：门店角色账号 + 当前门店 + 全部门店选项 */
  const storeAccounts = wrap('storeAccounts', async (ctx, actor) => {
    permissions.assertCapability(actor, CAPABILITY.ADMIN);
    const data = await listStoreAccounts(db);
    ok(ctx, data);
  });

  /** 写：整体替换授权门店（事务 + 并发 + 幂等 + 审计） */
  const updateStoreAccountStoresHandler = wrap('updateStoreAccountStores', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'updateStoreAccountStores');
    if (!requestId) return;
    permissions.assertCapability(actor, CAPABILITY.ADMIN);

    const userId = intOf(param(ctx, 'user_id'), 'user_id');
    const storePresence = paramPresence(ctx, ['store_ids']);
    if (!storePresence.present || !Array.isArray(storePresence.raw)) {
      throw new ValidationError('STORE_ACCOUNT_BAD_STORES', 'store_ids 必须是数组（空数组表示撤销全部门店）');
    }
    const expectedPresence = paramPresence(ctx, ['expected_store_ids']);
    if (!expectedPresence.present || !Array.isArray(expectedPresence.raw)) {
      throw new ValidationError('STORE_ACCOUNT_BAD_EXPECTED', 'expected_store_ids 必须是数组（用于并发控制）');
    }

    const result: UpdateStoreAccountResult = await updateStoreAccountStores(db, {
      userId,
      storeIds: storePresence.raw,
      expectedStoreIds: expectedPresence.raw,
      requestId,
      operatorUserId: Number(actor.userId) || null,
      operatorName: usernameOf(actor) ?? null,
    });

    logger.info?.(
      `[svc:storeAccounts] 账号 ${userId} 门店授权 → [${result.store_codes.join(', ')}]` +
        `（${result.replayed ? '幂等回放' : '已更新'}，操作者 ${usernameOf(actor) ?? actor.userId}）`,
    );
    ok(ctx, { data: result });
  });

  return {
    storeAccounts,
    updateStoreAccountStores: updateStoreAccountStoresHandler,
  };
}
