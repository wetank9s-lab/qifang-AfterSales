/**
 * UX-01C-R7：**门店资料**的受控读写（`svc:storeProfile` / `svc:updateStoreProfile`）。
 *
 * ===========================================================================
 * 设计（复用 UX-01C「服务时效」已验证的模式，不另造一套设置系统）
 * ===========================================================================
 *   ① 角色：只允许 `hq_admin`（`CAPABILITY.ADMIN`）；其余角色 403；
 *   ② 字段：只允许 `name / contact_phone / address / active` —— `code` **不可写**
 *      （它是签名二维码的输入，改了已印发的码就失效）；
 *   ③ 校验：按真实 schema 的长度 + 业务格式（电话兼容手机/座机/客服号，可为空）；
 *   ④ 并发：`expected_value` + **数据库原子条件更新**（`UPDATE ... WHERE id=? AND <field>=<旧值>`）；
 *   ⑤ 事务：更新与审计**同一事务**（`storeProfileAudits`）；
 *   ⑥ 幂等：同一 `X-Request-Id` 的重试**不产生第二条审计**、不重复覆盖；
 *   ⑦ 恢复：`scene=restore` 只是**再写一条审计**，不回改历史。
 *
 * ⚠️ 与 DEV-203 的区别（同样的坑不再踩一次）：
 *   NocoBase 的 `Repository.update()` 默认返回**实例数组**、且 filter 只用于 SELECT，
 *   UPDATE 实际按主键下发的 —— 那样"影响行数"与"条件更新"都不成立。
 *   这里直接用 Sequelize `Model.update(values, { where: {id, [field]: oldValue} })`，
 *   让条件真的进 WHERE，并用返回的 `affectedCount` 裁决并发。
 */
import { CAPABILITY } from '../../services/permission-service';
import { ValidationError, StateConflictError } from '../../services/ticket-service';
import {
  STORE_PROFILE_FIELDS,
  STORE_PROFILE_SPECS,
  type StoreProfileField,
} from '../../constants';
import { fail, ok } from './_http';
import {
  createWrapper,
  param,
  paramPresence,
  paramsOf,
  requireRequestId,
  usernameOf,
  type ActionHandler,
  type SvcActionDeps,
} from './_request';

/** 与 schema 对齐的字段长度（`collections/stores.ts`） */
const MAX = { name: 64, contact_phone: 20, address: 200 } as const;

/**
 * 电话格式：兼容真实世界的写法，而不是"只收 11 位手机号"。
 *
 * 允许：手机 `13800000000`、座机 `028-12345678`、客服 `400-800-1234`、
 *      带国际区号 `+86 28 12345678`、分机 `028-12345678#123`（`#` 用 `转` 或 `x`）。
 * 规则刻意**宽而明确**：字符集只允许数字与常见分隔符，且至少 5 位数字；
 * 不校验号段真实性（那是运营商的事，写死只会误伤新号段）。
 */
const PHONE_ALLOWED = /^[0-9+\-()#* 转xX]{5,20}$/;

export interface ValidatedValue {
  /** 落库值：字符串或布尔或 null */
  value: string | boolean | null;
  /** 审计里的字符串形态（布尔统一 true/false，null 统一 NULL） */
  audit: string | null;
}

export function validateStoreField(field: StoreProfileField, raw: unknown): ValidatedValue {
  if (field === 'active') {
    // "必须是明确的布尔值"：接受 boolean 与字面量 'true'/'false'，其余一律拒绝
    if (raw === true || raw === 'true') return { value: true, audit: 'true' };
    if (raw === false || raw === 'false') return { value: false, audit: 'false' };
    throw new ValidationError(
      'STORE_ACTIVE_INVALID',
      `「启用状态」必须是 true 或 false（实际收到 ${JSON.stringify(raw)}）`,
      422,
    );
  }

  const text = String(raw ?? '').trim();
  const spec = STORE_PROFILE_SPECS[field];

  if (field === 'name') {
    if (text.length === 0) {
      throw new ValidationError('STORE_NAME_REQUIRED', '门店名称不能为空', 422);
    }
    if (text.length > MAX.name) {
      throw new ValidationError('STORE_NAME_TOO_LONG', `门店名称最多 ${MAX.name} 字（当前 ${text.length}）`, 422);
    }
    if (/[\r\n\t]/.test(text)) {
      throw new ValidationError('STORE_NAME_INVALID', '门店名称不能包含换行或制表符', 422);
    }
    return { value: text, audit: text };
  }

  if (field === 'contact_phone') {
    // 未配置电话 ⇒ 保持为空，**不生成任何假号码**
    if (text.length === 0) return { value: null, audit: null };
    if (text.length > MAX.contact_phone) {
      throw new ValidationError(
        'STORE_PHONE_TOO_LONG',
        `对外服务电话最多 ${MAX.contact_phone} 个字符（当前 ${text.length}）`,
        422,
      );
    }
    if (!PHONE_ALLOWED.test(text) || (text.match(/\d/g) ?? []).length < 5) {
      throw new ValidationError(
        'STORE_PHONE_INVALID',
        '对外服务电话只能包含数字、空格与 + - ( ) # * 转 x，且至少 5 位数字（例如 13800000000 / 028-12345678 / 400-800-1234）',
        422,
      );
    }
    return { value: text, audit: text };
  }

  if (field === 'address') {
    if (text.length === 0) return { value: null, audit: null };
    if (text.length > MAX.address) {
      throw new ValidationError('STORE_ADDRESS_TOO_LONG', `门店地址最多 ${MAX.address} 字（当前 ${text.length}）`, 422);
    }
    return { value: text, audit: text };
  }

  throw new ValidationError('STORE_FIELD_NOT_WRITABLE', `字段「${String(field)}」不在可写白名单内`, 422);
}

/**
 * 值 → 审计字符串（布尔 true/false；空 → null）。
 *
 * 🔴 2026-10-17 实测修正：**空字符串必须归一成 NULL**。
 *    `contact_phone` / `address` 是可空列，前端表单未填时拿到的是 `''`；
 *    若把 `''` 当成期望值，就会与库里的 `NULL` 判不相等 ⇒ 每次保存都误报 409。
 *    （这个 bug 是门禁在"弹窗显示空电话 → 保存"这一步抓到的，不是靠读代码看出来的。）
 */
function auditOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value);
  return text.trim() === '' ? null : text;
}

/** 解析正整数 id（`filterByTk` 或显式 `store_id`） */
function readStoreId(ctx: any): number | null {
  const raw = param(ctx, 'store_id') ?? paramsOf(ctx)?.filterByTk;
  const id = Number(raw);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) return null;
  return id;
}

function notFoundStore(ctx: any): void {
  fail(ctx, 404, 'STORE_NOT_FOUND', '门店不存在');
}

export function createStoreProfileHandlers(deps: SvcActionDeps): Record<string, ActionHandler> {
  const { services, logger } = deps;
  const { permissions } = services;
  const wrap = createWrapper(deps);

  /** 读：只回可编辑字段 + code（供弹窗显示"当前值"与"编码不可改"） */
  const storeProfile = wrap('storeProfile', async (ctx, actor) => {
    permissions.assertCapability(actor, CAPABILITY.ADMIN);
    const id = readStoreId(ctx);
    if (id === null) return notFoundStore(ctx);

    const db = (ctx.app as any).db;
    const row = await db.getRepository('stores').findOne({ filter: { id } });
    if (!row) return notFoundStore(ctx);
    const p: any = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };

    ok(ctx, {
      store: {
        id: Number(p.id),
        code: String(p.code),
        name: String(p.name ?? ''),
        contact_phone: p.contact_phone == null ? null : String(p.contact_phone),
        address: p.address == null ? null : String(p.address),
        active: p.active === true,
      },
      fields: STORE_PROFILE_FIELDS.map((f) => ({ field: f, ...STORE_PROFILE_SPECS[f] })),
    });
  });

  /** 写：白名单 + 校验 + 原子条件更新 + 同事务审计 + 幂等 */
  const updateStoreProfile = wrap('updateStoreProfile', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'updateStoreProfile');
    if (!requestId) return;

    permissions.assertCapability(actor, CAPABILITY.ADMIN);

    const storeId = readStoreId(ctx);
    if (storeId === null) return notFoundStore(ctx);

    const fieldRaw = String(param(ctx, 'field') ?? '').trim();
    if (!STORE_PROFILE_FIELDS.includes(fieldRaw as StoreProfileField)) {
      // code 单独给一句人话（它是最容易被误点的）
      if (fieldRaw === 'code') {
        fail(
          ctx,
          422,
          'STORE_CODE_READONLY',
          '门店编码是签名二维码的输入，不能修改（修改会让已印发的二维码全部失效）',
        );
        return;
      }
      fail(ctx, 422, 'STORE_FIELD_NOT_WRITABLE', `字段「${fieldRaw || '(空)'}」不在可写白名单内`);
      return;
    }
    const field = fieldRaw as StoreProfileField;

    // 🔴 必须用 `paramPresence`：`param()` 会把 `false` / `''` / `null` 当作"没传"，
    //    于是「停用门店」会被读成空值、「清空电话」会被读成没传 —— 两个都是静默错误。
    const valuePresence = paramPresence(ctx, ['value']);
    if (!valuePresence.present) {
      fail(ctx, 422, 'STORE_VALUE_REQUIRED', `缺少「${STORE_PROFILE_SPECS[field].label}」的值`);
      return;
    }
    const checked = validateStoreField(field, valuePresence.raw);

    const scene = String(param(ctx, 'scene') ?? 'update') === 'restore' ? 'restore' : 'update';
    const expectedPresence = paramPresence(ctx, ['expected_value']);
    const hasExpected = expectedPresence.present;
    const expectedAudit = hasExpected ? auditOf(expectedPresence.raw) : null;

    const db = (ctx.app as any).db;
    const operatorName = usernameOf(actor) ?? String(actor.userId);

    let outcome: {
      store_id: number;
      code: string;
      field: string;
      old_value: string | null;
      value: string | boolean | null;
      scene: string;
      replayed: boolean;
    } | null = null;

    outcome = await db.sequelize.transaction(async (t: any) => {
      const repo = db.getRepository('stores');
      const row = await repo.findOne({ filter: { id: storeId }, transaction: t });
      if (!row) throw new ValidationError('STORE_NOT_FOUND', `门店 #${storeId} 不存在`, 404);
      const p: any = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
      const code = String(p.code);

      // ---- 幂等：同一 request id + 门店 + 字段已经成功过 ⇒ 直接回放，不再写审计 ----
      const prior = await db.getRepository('storeProfileAudits').findOne({
        filter: { request_id: requestId, store_id: storeId, field },
        transaction: t,
      });
      if (prior) {
        const q: any = typeof prior.toJSON === 'function' ? prior.toJSON() : prior;
        return {
          store_id: storeId,
          code,
          field,
          old_value: q.old_value == null ? null : String(q.old_value),
          value: field === 'active' ? q.new_value === 'true' : q.new_value == null ? null : String(q.new_value),
          scene: String(q.scene ?? scene),
          replayed: true,
        };
      }

      const oldRaw = p[field];
      const oldAudit = auditOf(oldRaw);

      // 值没变 ⇒ 不写审计、不更新（避免"点两次保存"产生两条无意义审计）
      if (oldAudit === checked.audit) {
        return { store_id: storeId, code, field, old_value: oldAudit, value: checked.value, scene, replayed: true };
      }

      // 并发：调用方看到的旧值与库里当前值不一致 ⇒ 409
      if (hasExpected && expectedAudit !== oldAudit) {
        throw new StateConflictError(
          `门店资料已被其他管理员修改（当前「${oldAudit ?? '空'}」，你看到的是「${expectedAudit ?? '空'}」），请刷新后重试`,
          'STORE_PROFILE_CONFLICT',
        );
      }

      // ---- 原子条件更新：条件必须真的进 WHERE（DEV-203 的反面教材）----
      const model = db.getCollection('stores')?.model;
      if (!model || typeof model.update !== 'function') {
        throw new ValidationError('STORE_MODEL_UNAVAILABLE', '门店表模型不可用，写入已中止', 500);
      }
      const [affected] = await model.update(
        { [field]: checked.value },
        {
          where: { id: storeId, [field]: oldRaw ?? null },
          transaction: t,
          validate: false,
          hooks: false,
          individualHooks: false,
        },
      );
      if (Number(affected) !== 1) {
        throw new StateConflictError(
          '门店资料刚刚被其他管理员修改（并发写入被拒绝），请刷新后重试',
          'STORE_PROFILE_CONFLICT',
        );
      }

      await db.getRepository('storeProfileAudits').create({
        values: {
          store_id: storeId,
          store_code: code,
          field,
          old_value: oldAudit,
          new_value: checked.audit,
          operator_user_id: actor.userId,
          operator_name: operatorName,
          scene,
          request_id: requestId,
        },
        transaction: t,
      });

      return {
        store_id: storeId,
        code,
        field,
        old_value: oldAudit,
        value: checked.value,
        scene,
        replayed: false,
      };
    });

    logger.info?.(
      `[svc:updateStoreProfile] 门店 ${outcome.code} ${field}：${outcome.old_value ?? '空'} → ` +
        `${auditOf(outcome.value) ?? '空'}（${scene}${outcome.replayed ? '，幂等回放' : ''}，操作者 ${operatorName}）`,
    );
    ok(ctx, { data: outcome });
  });

  return {
    storeProfile,
    updateStoreProfile,
  };
}
