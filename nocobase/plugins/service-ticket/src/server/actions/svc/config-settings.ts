/**
 * UX-01C：总部**配置设置**的受控读写（`svc:listSettingSpecs` / `svc:updateSetting`）。
 *
 * 设计（用户 §二）——**不新造规则引擎**，只做"受控写入 serviceSettings + 审计"：
 *   1. 服务端校验 `hq_admin`（`CAPABILITY.ADMIN`）—— 总部售后 / 门店 / viewer 一律 403；
 *   2. **白名单**：只允许 `SETTING_EDIT_SPECS` 里的键；其它键一律 422（前端拿不到任意键写入能力）；
 *   3. 按 `value_type` 校验：int 必为整数、**拒绝 NaN / 负值 / 非法单位**，且有 `[min,max]` 范围；
 *   4. 并发：调用方可带 `expected_value`；与当前值不符 ⇒ 409 `CONFIG_CONFLICT`
 *      （防"管理员覆盖他人刚做的修改"）；
 *   5. **事务一致**：更新 `serviceSettings` 与写入 `configChangeAudits` 在**同一事务**；
 *   6. 恢复（restore）= 用同一个受控接口把值写回旧值，并**再留一条审计**（scene=restore）。
 *
 * ⚠️ 不实现"任意键 + 任意值"的通用写接口；新增可写配置 = 在 `SETTING_EDIT_SPECS` 里登记一条，
 *    并**确认它有真实消费点**（本轮登记的 3 个键都在 `sla-scan-scheduler.ts` 被读取）。
 */
import { CAPABILITY } from '../../services/permission-service';
import { buildSmsStatus } from '../../services/sms-status';
import { StateConflictError, ValidationError } from '../../services/ticket-service';
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

/** 一个**可写配置项**的元数据（中文名 / 单位 / 范围 / 说明 / 生效时机）。 */
export interface SettingEditSpec {
  key: string;
  label: string;
  /** int 的单位；bool/enum 可省略 */
  unit?: string;
  /** int 的范围；bool/enum 不使用 */
  min?: number;
  max?: number;
  type: 'int' | 'bool' | 'enum';
  /** enum 的合法取值（**唯一事实来源**：服务端校验与前端下拉共用） */
  options?: Array<{ label: string; value: string }>;
  effect: string;
  consumer: string;
  /** 是否存在真实业务消费者；false ⇒ 登记时就必须拒绝（不制造"可存不生效"的假设置） */
  supported: boolean;
}

/**
 * 可写配置白名单（**唯一事实来源**，服务端与页面共用）。
 * ⚠️ 每条都必须有真消费点，否则不得登记（本轮 3 条均见 `consumer`）。
 */
export const SETTING_EDIT_SPECS: readonly SettingEditSpec[] = [
  {
    key: 'sla.accept_minutes',
    label: '新工单首次受理时限',
    unit: '分钟',
    min: 5,
    max: 1440,
    type: 'int',
    effect: '保存后，下一次时效扫描即时使用新值',
    consumer: 'services/sla-scan-scheduler.ts:226（readInt）',
    supported: true,
  },
  {
    key: 'sla.appointment_overdue_grace_minutes',
    label: '预约上门超时宽限',
    unit: '分钟',
    min: 0,
    max: 1440,
    type: 'int',
    effect: '保存后，下一次时效扫描即时使用新值',
    consumer: 'services/sla-scan-scheduler.ts:227（readInt）',
    supported: true,
  },
  {
    key: 'sla.store_confirm_hours',
    label: '师傅提交后门店确认时限',
    unit: '小时',
    min: 1,
    max: 168,
    type: 'int',
    effect: '保存后，下一次时效扫描即时使用新值',
    consumer: 'services/sla-scan-scheduler.ts:228（readInt）',
    supported: true,
  },
  // -------------------------------------------------------------------------
  // UX-01C-R8：短信通知（**只登记真实有消费点的三项**，其余列 PENDING）
  // -------------------------------------------------------------------------
  {
    key: 'sms.enabled',
    label: '短信功能开关',
    type: 'bool',
    effect: '保存后**下一次发送**立即生效（SmsService.flush 每次读参数，10s 配置缓存）',
    consumer: 'services/sms-service.ts:509（getBool）',
    supported: true,
  },
  {
    key: 'sms.provider',
    label: '短信通道',
    type: 'enum',
    options: [
      { label: '模拟（不真实发送）', value: 'mock' },
      { label: '阿里云短信', value: 'aliyun' },
      { label: '短信宝（当前不可用：缺模板映射）', value: 'smsbao' },
    ],
    effect: '保存后 10s 内（配置缓存 TTL）生效；已构造的旧通道实例会被新实例替换',
    consumer: 'services/sms-service.ts:296（getString → createSmsProvider）',
    supported: true,
  },
  {
    key: 'sms.retry_count',
    label: '发送失败重试次数',
    type: 'int',
    unit: '次',
    min: 0,
    // 契约冻结值：文档要求"最多重试 1 次"（sms-service RETRYABLE_ERROR_CODES）
    max: 1,
    effect: '保存后下一次发送立即生效（只重试传输层失败：SMS_TRANSPORT_ERROR / SMS_TIMEOUT）',
    consumer: 'services/sms-service.ts:510（getInt）· sms-retry-scheduler',
    supported: true,
  },
] as const;

const SPEC_BY_KEY = new Map(SETTING_EDIT_SPECS.map((s) => [s.key, s]));

/** 按 spec 校验并规范化值 —— 纯函数，便于单测。 */
export function validateSettingValue(
  spec: SettingEditSpec,
  raw: unknown,
): { ok: true; value: string } | { ok: false; message: string } {
  // ---- bool：只接受明确布尔（`true`/`false` 或它们的字符串形态）----
  // ⚠️ 不接受 1/0 / yes/no：那会让"开关"在库里出现第三种表示，
  //    而 SmsService 只认 config.getBool 的解析结果。
  if (spec.type === 'bool') {
    if (raw === true || raw === 'true') return { ok: true, value: 'true' };
    if (raw === false || raw === 'false') return { ok: true, value: 'false' };
    return {
      ok: false,
      message: `「${spec.label}」必须是 true 或 false（实际收到 ${JSON.stringify(raw)}）`,
    };
  }

  // ---- enum：只接受登记过的取值 ----
  if (spec.type === 'enum') {
    const text = String(raw ?? '').trim();
    const allowed = (spec.options ?? []).map((o) => o.value);
    if (!allowed.includes(text)) {
      return {
        ok: false,
        message: `「${spec.label}」只能是 ${allowed.join(' / ')}（实际收到「${text || '(空)'}」）`,
      };
    }
    return { ok: true, value: text };
  }

  // ---- int：与既有 SLA 行为完全一致（不改冻结口径）----
  if (raw === undefined || raw === null) return { ok: false, message: `「${spec.label}」不能为空` };
  const text = String(raw).trim();
  if (text === '') return { ok: false, message: `「${spec.label}」不能为空` };
  if (!/^-?\d+$/.test(text)) {
    return { ok: false, message: `「${spec.label}」必须是整数（单位：${spec.unit}），实际收到「${text}」` };
  }
  const n = Number(text);
  if (!Number.isFinite(n) || Number.isNaN(n)) return { ok: false, message: `「${spec.label}」不是有效数字` };
  const min = spec.min ?? 0;
  const max = spec.max ?? 0;
  if (n < min || n > max) {
    return { ok: false, message: `「${spec.label}」必须在 ${min} ~ ${max} ${spec.unit ?? ''} 之间（实际 ${n}）` };
  }
  return { ok: true, value: String(n) };
}

export function createConfigSettingHandlers(deps: SvcActionDeps): Record<string, ActionHandler> {
  const { services, logger } = deps;
  const { permissions } = services;
  const wrap = createWrapper(deps);

  /** 只读：把可写清单（含中文名/单位/范围/说明/生效时机/消费点）交给页面渲染 —— 不暴露敏感项。 */
  const listSettingSpecs = wrap('listSettingSpecs', async (ctx, actor) => {
    permissions.assertCapability(actor, CAPABILITY.ADMIN);
    ok(ctx, { specs: SETTING_EDIT_SPECS.map((s) => ({ ...s })) });
  });

  /** 受控写入：白名单 + 类型/范围校验 + 并发检测 + **同事务审计**。 */
  /**
   * R8：短信通道**可发送性**（只读）。前端只显示，不自行判断。
   * 只回"是否配置/缺哪些键名/缺哪些场景模板"，**绝不回显凭证值**。
   */
  const smsStatus = wrap('smsStatus', async (ctx, actor) => {
    permissions.assertCapability(actor, CAPABILITY.ADMIN);
    const db = (ctx.app as any).db;
    const rows = await db.getRepository('serviceSettings').find({
      filter: { key: { $in: ['sms.enabled', 'sms.provider', 'sms.retry_count'] } },
    });
    const map = new Map<string, string>();
    for (const r of rows ?? []) {
      const p: any = typeof r.toJSON === 'function' ? r.toJSON() : r;
      map.set(String(p.key), String(p.value ?? ''));
    }
    const status = buildSmsStatus(process.env, {
      enabled: String(map.get('sms.enabled') ?? 'false') === 'true',
      provider: String(map.get('sms.provider') ?? 'mock'),
      retryCount: Number(map.get('sms.retry_count') ?? 1),
    });
    ok(ctx, status);
  });

  const updateSetting = wrap('updateSetting', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'updateSetting');
    if (!requestId) return;

    // ① 能力闸门：只有总部管理员（hq_admin）能改全局配置。
    permissions.assertCapability(actor, CAPABILITY.ADMIN);

    const key = String(param(ctx, 'key') ?? '').trim();
    const spec = SPEC_BY_KEY.get(key);
    if (!spec || !spec.supported) {
      fail(ctx, 422, 'SETTING_NOT_WRITABLE', `配置键「${key}」不在可写白名单内（或尚无业务消费点，不支持修改）`);
      return;
    }
    // 🔴 `param()` 会把 `false` / `''` 当"没传" —— 对 bool 开关是致命的（DEV-206 同族）。
    const valuePresence = paramPresence(ctx, ['value']);
    const checked = validateSettingValue(spec, valuePresence.present ? valuePresence.raw : undefined);
    if (!checked.ok) {
      fail(ctx, 422, 'SETTING_VALUE_INVALID', checked.message);
      return;
    }
    // ── R8：**幂等回放** ─────────────────────────────────────────────────
    //  同一个 `X-Request-Id` 重试不得写第二条审计、也不得再改一次；
    //  审计表另有唯一索引 (request_id, key) 兜底。
    const db0 = (ctx.app as any).db;
    const prior = await db0.getRepository('configChangeAudits').findOne({
      filter: { request_id: requestId, key },
    });
    if (prior) {
      const q: any = typeof prior.toJSON === 'function' ? prior.toJSON() : prior;
      ok(ctx, {
        data: {
          key,
          value: q.new_value == null ? null : String(q.new_value),
          old_value: q.old_value == null ? null : String(q.old_value),
          scene: String(q.scene ?? 'update'),
          replayed: true,
        },
      });
      return;
    }

    // ── R8：**开启 / 切换通道前的可发送性闸门** ─────────────────────────
    //  用户要求"凭证缺失的服务商不能被误判为正常可用"。这里拦的是
    //  "把系统置成 enabled=true、但当前通道根本发不出去" —— 否则会产出一批
    //  SMS_PROVIDER_NOT_CONFIGURED 的 rejected 记录，而后台开关看起来还开着。
    if (key === 'sms.enabled' || key === 'sms.provider') {
      const rows = await db0.getRepository('serviceSettings').find({
        filter: { key: { $in: ['sms.enabled', 'sms.provider'] } },
      });
      const map = new Map<string, string>();
      for (const r of rows ?? []) {
        const p: any = typeof r.toJSON === 'function' ? r.toJSON() : r;
        map.set(String(p.key), String(p.value ?? ''));
      }
      const nextEnabled = key === 'sms.enabled' ? checked.value === 'true' : map.get('sms.enabled') === 'true';
      const nextProvider = key === 'sms.provider' ? checked.value : String(map.get('sms.provider') ?? 'mock');
      if (nextEnabled) {
        const st = buildSmsStatus(process.env, {
          enabled: true,
          provider: nextProvider,
          retryCount: Number(map.get('sms.retry_count') ?? 1),
        });
        if (!st.effective.canSend) {
          fail(ctx, 422, 'SMS_PROVIDER_NOT_READY', `无法开启：${st.effective.reason}`);
          return;
        }
      }
    }

    const scene = String(param(ctx, 'scene') ?? 'update') === 'restore' ? 'restore' : 'update';
    const expectedRaw = param(ctx, 'expected_value');
    const hasExpected = expectedRaw !== undefined && expectedRaw !== null;

    const db = (ctx.app as any).db;
    const operatorName = usernameOf(actor) ?? String(actor.userId);

    let outcome: { key: string; value: string; old_value: string } | null = null;
    try {
      outcome = await db.sequelize.transaction(async (t: any) => {
        const repo = db.getRepository('serviceSettings');
        const row = await repo.findOne({ filter: { key }, transaction: t });
        if (!row) throw new ValidationError('NOT_FOUND', `配置 ${key} 不存在`);
        const oldValue = (row as any).value == null ? '' : String((row as any).value);

        // ④ 并发检测：调用方看到的旧值与库里当前值不一致 ⇒ 拒绝（不让后者静默覆盖前者）。
        if (hasExpected && String(expectedRaw) !== oldValue) {
          throw new StateConflictError(
            `该配置已被他人修改（当前「${oldValue}」，你看到的是「${String(expectedRaw)}」），请刷新后重试`,
            'CONFIG_CONFLICT',
          );
        }

        // ⑤ 同一事务里"改值 + 留痕"。
        // 🔴 **并发原子性**：WHERE 里带上 `value = oldValue` 做**条件更新** ——
        //    仅靠"先读后判"在 READ COMMITTED 下**不安全**：两个并发请求可能都读到旧值、
        //    都通过 `expected_value` 判定，于是双写成功、后者覆盖前者（丢失更新 + 审计失真）。
        //
        // ⚠️ 2026-10-17（UX-01C 第五轮）实测推翻了上一版的两处假设：
        //    ① `repo.update()` 的返回值**不是** Sequelize 的 `[affectedCount]`：
        //       NocoBase `Repository.update` 的默认分支（容器内
        //       `@nocobase/database/lib/repository.js:544-575`）是
        //       `find()` 出实例、逐个 `updateModelByValues()`，最后 **返回实例数组**。
        //       上一版按 `Number(updated[0])` 取"影响行数" ⇒ 恒为 NaN ⇒
        //       **每一次正确写入都被判成 409**（连 `120 → 121` 都保存不了）。
        //    ② `repo.update({ filter })` 的 filter **只用于 SELECT**，真正的 UPDATE 是
        //       `WHERE id = ?` —— 所以"把期望值压进 WHERE 让数据库裁决"这句话在
        //       这条路径上**不成立**，并发下仍会双写。
        //    ⇒ 改用 Sequelize 的 `Model.update(values, { where: { key, value: oldValue } })`：
        //       条件真的进了 UPDATE 的 WHERE（Postgres 行锁裁决），返回值是 `[affectedCount]`。
        //       影响行数 0 ⇒ 说明值已变 ⇒ 409。
        const collection = (db as any).getCollection?.('serviceSettings');
        const model = collection?.model;
        if (!model || typeof model.update !== 'function') {
          throw new ValidationError('SETTING_MODEL_UNAVAILABLE', '配置表模型不可用，写入已中止');
        }
        const [affected] = await model.update(
          { value: checked.value, updated_by: operatorName },
          {
            where: { key, value: oldValue },
            transaction: t,
            // 值已由 validateSettingValue 校验；这里不再跑模型的整行校验/钩子
            validate: false,
            hooks: false,
            individualHooks: false,
          },
        );
        if (Number(affected) !== 1) {
          throw new StateConflictError(
            '该配置刚刚被他人修改（并发写入被拒绝），请刷新后重试',
            'CONFIG_CONFLICT',
          );
        }
        await db.getRepository('configChangeAudits').create({
          values: {
            key,
            old_value: oldValue,
            new_value: checked.value,
            operator_user_id: actor.userId,
            operator_name: operatorName,
            scene,
            request_id: requestId,
          },
          transaction: t,
        });
        return { key, value: checked.value, old_value: oldValue };
      });
    } catch (error) {
      // 冲突/校验错误交给统一错误映射（409/422/404）。
      throw error;
    }

    logger.info?.(
      `[svc:updateSetting] ${key}：${outcome?.old_value} → ${outcome?.value}（${scene}，操作者 ${operatorName}）`,
    );
    ok(ctx, { data: { ...outcome, scene, spec: { label: spec.label, unit: spec.unit, min: spec.min, max: spec.max } } });
  });

  return { listSettingSpecs, updateSetting, smsStatus };
}
