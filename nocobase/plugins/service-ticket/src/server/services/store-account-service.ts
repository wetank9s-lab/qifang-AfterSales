/**
 * `store-account-service` —— 门店账号 ↔ 授权门店（SEC-STORE-01）。
 *
 * =============================================================================
 * 背景
 * =============================================================================
 * 数据隔离的**唯一依据**是 `store_users`（user_id ↔ store_id）。后端一直按它算
 * `scopeOf(actor).storeIds`，但此前**没有任何后台入口**能维护它 —— 只能靠 SQL/种子。
 * 结果是：账号有了 `store_after_sales` 角色、却没有门店绑定 ⇒ `scope=none`（fail-closed，
 * 看不到任何业务），而管理员无从修复。
 *
 * 本服务只做两件事：
 *   · `listStoreAccounts`：列出**门店角色账号**及其当前授权门店（含"未绑定"标记）；
 *   · `updateStoreAccountStores`：**整体替换**某账号的授权门店集合（事务 + 并发 + 幂等 + 审计）。
 *
 * =============================================================================
 * 边界（不得越过）
 * =============================================================================
 *   · 只处理**已是 `store_after_sales`** 的账号：给总部/只读账号加门店绑定没有意义，
 *     反而会让"他为什么能看这家店"变得说不清 ⇒ 422。
 *   · 只改 `store_users`，**不碰 `rolesUsers`**（角色是另一件事）。
 *   · 不开放原生 `users` / `roles` / `storeUsers` 的写权限；写只走本服务对应的 svc 动作。
 *   · 空集合是合法的（= 撤销全部门店）—— 语义是"该账号暂时无任何门店权限"，仍然是 fail-closed。
 */
import { ROLE } from '../constants';
import { NotFoundError } from './permission-service';
import { StateConflictError, ValidationError } from './ticket-service';

const plain = (row: any): any => (typeof row?.toJSON === 'function' ? row.toJSON() : { ...(row ?? {}) });
const sortedIds = (ids: unknown): number[] =>
  [...new Set((Array.isArray(ids) ? ids : []).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))].sort(
    (a, b) => a - b,
  );

export interface StoreAccountRow {
  user_id: number;
  email: string;
  nickname: string | null;
  username: string | null;
  roles: string[];
  store_ids: number[];
  store_codes: string[];
  unbound: boolean;
}

export interface StoreOption {
  id: number;
  code: string;
  name: string;
  active: boolean;
}

/** 门店角色账号 + 当前授权门店。**只读**，不返回任何口令/Token。 */
export async function listStoreAccounts(
  db: any,
): Promise<{ accounts: StoreAccountRow[]; stores: StoreOption[] }> {
  const roleRows = await db.getRepository('rolesUsers').find({
    filter: { roleName: ROLE.STORE_AFTER_SALES },
  });
  const userIds = [...new Set((roleRows ?? []).map((r: any) => Number(plain(r).userId)))].filter(
    (n) => Number.isInteger(n) && n > 0,
  );

  // 这些账号的**全部**角色（不只门店角色）：新建用户默认带 `member`，
  // 而 ACL 的"当前角色"取角色列表第一个 ⇒ 可能出现"有门店角色却处处 403"的情况。
  // 页面必须**如实显示**，不能假装它们只有 store_after_sales。
  const allRoleRows =
    userIds.length > 0
      ? (await db.getRepository('rolesUsers').find({ filter: { userId: { $in: userIds } } })) ?? []
      : [];
  const rolesByUser = new Map<number, string[]>();
  for (const row of allRoleRows) {
    const p = plain(row);
    const uid = Number(p.userId);
    if (!rolesByUser.has(uid)) rolesByUser.set(uid, []);
    rolesByUser.get(uid)!.push(String(p.roleName));
  }

  const stores = (await db.getRepository('stores').find({ sort: ['sort_order', 'code'] })) ?? [];
  const storeList: StoreOption[] = (stores ?? []).map((s: any) => {
    const p = plain(s);
    return { id: Number(p.id), code: String(p.code), name: String(p.name), active: p.active !== false };
  });
  const storeById = new Map(storeList.map((s) => [s.id, s]));

  if (userIds.length === 0) return { accounts: [], stores: storeList };

  const users = (await db.getRepository('users').find({
    filter: { id: { $in: userIds } },
    fields: ['id', 'email', 'nickname', 'username'],
  })) ?? [];
  const userById = new Map((users ?? []).map((u: any) => [Number(plain(u).id), plain(u)]));

  const bindings = (await db.getRepository('storeUsers').find({
    filter: { user_id: { $in: userIds } },
  })) ?? [];
  const byUser = new Map<number, number[]>();
  for (const row of bindings ?? []) {
    const p = plain(row);
    const uid = Number(p.user_id);
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid)!.push(Number(p.store_id));
  }

  const accounts: StoreAccountRow[] = userIds
    .map((id) => {
      const u = userById.get(id) ?? {};
      const storeIds = sortedIds(byUser.get(id) ?? []);
      return {
        user_id: id,
        email: String(u.email ?? ''),
        nickname: u.nickname == null ? null : String(u.nickname),
        username: u.username == null ? null : String(u.username),
        roles: [...new Set(rolesByUser.get(id) ?? [ROLE.STORE_AFTER_SALES])].sort(),
        store_ids: storeIds,
        store_codes: storeIds.map((sid) => storeById.get(sid)?.code ?? `#${sid}`),
        unbound: storeIds.length === 0,
      };
    })
    .sort((a, b) => a.user_id - b.user_id);

  return { accounts, stores: storeList };
}

export interface UpdateStoreAccountResult {
  user_id: number;
  store_ids: number[];
  store_codes: string[];
  replayed: boolean;
}

/**
 * **整体替换**某账号的授权门店集合。
 *
 * 并发：调用方必须带 `expected_store_ids`（当前集合）；与库中不一致 ⇒ 409。
 * 幂等：同 `request_id` + 同新集合 ⇒ 回放；同号不同集合 ⇒ 409 `IDEMPOTENT_PAYLOAD_MISMATCH`。
 * 事务：删旧绑定 + 插新绑定 + 写审计，同一事务。
 */
export async function updateStoreAccountStores(
  db: any,
  params: {
    userId: number;
    storeIds: unknown;
    expectedStoreIds: unknown;
    requestId: string;
    operatorUserId?: number | null;
    operatorName?: string | null;
    scene?: string;
  },
): Promise<UpdateStoreAccountResult> {
  const userId = Number(params.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new ValidationError('STORE_ACCOUNT_BAD_USER', `用户 ID 非法（${JSON.stringify(params.userId)}）`);
  }
  const nextIds = sortedIds(params.storeIds);
  const expectedIds = sortedIds(params.expectedStoreIds);

  const storeRows = (await db.getRepository('stores').find({ filter: { id: { $in: nextIds } } })) ?? [];
  if (nextIds.length > 0 && storeRows.length !== nextIds.length) {
    const found = new Set((storeRows ?? []).map((r: any) => Number(plain(r).id)));
    const missing = nextIds.filter((id) => !found.has(id));
    throw new ValidationError('STORE_ACCOUNT_UNKNOWN_STORE', `门店不存在：${missing.join(', ')}`);
  }

  const user = await db.getRepository('users').findOne({ filter: { id: userId } });
  if (!user) throw new NotFoundError('账号不存在');
  const u = plain(user);

  const roleRows = await db.getRepository('rolesUsers').find({
    filter: { userId, roleName: ROLE.STORE_AFTER_SALES },
  });
  if ((roleRows ?? []).length === 0) {
    throw new ValidationError(
      'STORE_ACCOUNT_NOT_STORE_ROLE',
      '该账号没有「门店售后」业务角色，配置门店归属没有意义（请先在角色管理中分配角色）',
    );
  }

  const sequelize = db?.sequelize;
  if (!sequelize || typeof sequelize.transaction !== 'function') {
    throw new ValidationError('STORE_ACCOUNT_TX_UNAVAILABLE', '数据库事务不可用，写入已中止', 500);
  }

  return sequelize.transaction(async (t: any) => {
    // 🔴 先锁**用户行**：并发改绑必须串行化。
    //    没有这一步会怎样（实测）：两个请求都读到旧集合、都通过 expected 校验，
    //    各自删旧插新，最后**两个都返回 200**，实际结果取决于提交顺序（丢失更新）。
    const usersModel = db.getCollection('users')?.model;
    if (!usersModel || typeof usersModel.findOne !== 'function') {
      throw new ValidationError('STORE_ACCOUNT_USER_MODEL_UNAVAILABLE', '用户表模型不可用，写入已中止', 500);
    }
    await usersModel.findOne({ where: { id: userId }, transaction: t, lock: t.LOCK?.UPDATE });

    const auditRepo = db.getRepository('storeAccountAudits');

    // ① 幂等：同请求号
    const prior = await auditRepo.findOne({ filter: { request_id: params.requestId }, transaction: t });
    if (prior) {
      const p = plain(prior);
      const priorNew = sortedIds(p.new_store_ids);
      if (JSON.stringify(priorNew) === JSON.stringify(nextIds)) {
        return {
          user_id: userId,
          store_ids: priorNew,
          store_codes: priorNew.map((sid) => {
            const s = storeRows.find((r: any) => Number(plain(r).id) === sid);
            return s ? String(plain(s).code) : `#${sid}`;
          }),
          replayed: true,
        };
      }
      throw new StateConflictError(
        '同一个 X-Request-Id 被用于不同的门店授权变更（请求号必须唯一标识一次操作）',
        'IDEMPOTENT_PAYLOAD_MISMATCH',
        { request_id: params.requestId },
      );
    }

    // ② 并发：当前集合适配 expected
    const currentRows = (await db.getRepository('storeUsers').find({ filter: { user_id: userId }, transaction: t })) ?? [];
    const currentIds = sortedIds((currentRows ?? []).map((r: any) => plain(r).store_id));
    if (JSON.stringify(currentIds) !== JSON.stringify(expectedIds)) {
      throw new StateConflictError(
        '该账号的门店授权刚刚被其他管理员修改，请刷新后重试',
        'STORE_ACCOUNT_CONFLICT',
        { current_store_ids: currentIds },
      );
    }

    // ③ 整体替换（删旧 → 插新）；空集合 = 撤销全部
    const linkRepo = db.getRepository('storeUsers');
    if (currentIds.length > 0) {
      await linkRepo.destroy({ filter: { user_id: userId }, transaction: t });
    }
    if (nextIds.length > 0) {
      await linkRepo.create({
        values: nextIds.map((storeId) => ({ user_id: userId, store_id: storeId })),
        transaction: t,
      });
    }

    // ④ 同事务审计
    await auditRepo.create({
      values: {
        user_id: userId,
        user_email: u.email ? String(u.email) : null,
        old_store_ids: currentIds,
        new_store_ids: nextIds,
        operator_user_id: params.operatorUserId ?? null,
        operator_name: params.operatorName ?? null,
        scene: params.scene ?? 'update',
        request_id: params.requestId,
      },
      transaction: t,
    });

    return {
      user_id: userId,
      store_ids: nextIds,
      store_codes: nextIds.map((sid) => {
        const s = storeRows.find((r: any) => Number(plain(r).id) === sid);
        return s ? String(plain(s).code) : `#${sid}`;
      }),
      replayed: false,
    };
  });
}
