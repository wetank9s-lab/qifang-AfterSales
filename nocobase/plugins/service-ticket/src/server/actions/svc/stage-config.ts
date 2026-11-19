/**
 * 暖通施工阶段显示配置的受控读写（R2.2.1 §八）
 *
 * 两个动作：
 *   · `svc:archiveStageConfigGet`  —— 读（登录即可；只回六个名称与说明）
 *   · `svc:archiveStageConfigSave` —— 写（**仅 hq_admin**；同事务审计；保存即生效）
 *
 * ===========================================================================
 * 为什么"读"不需要门店隔离
 * ===========================================================================
 * 这份配置**不属于任何门店**：它是"暖通工程六个阶段叫什么"，
 * 全公司只有一份。移动端销售打开任何一家店的暖通档案，看到的阶段名必须一样。
 * ⇒ 读侧只做登录校验，不加 `store_id` 条件；写侧只做角色校验，同样不加。
 *
 * 反过来说，如果哪天要做"按门店自定义阶段名"，那是一次**数据模型变更**
 * （配置要有 store_id 维度），不是在这个 handler 里加个 if 能算数的。
 *
 * ===========================================================================
 * 写入的六条纪律（逐条对应 §八 的原话）
 * ===========================================================================
 *   ① **固定六个 stage_code 与顺序，不允许增删** —— 校验强制提交全部六项、
 *      code 必须来自 `ARCHIVE_STAGE_ORDER`；入库只存 name/description，不存 code/order。
 *   ② **保存即生效** —— 写完立刻 `config.invalidate()`，下一次读拿到新值（无需重启）。
 *   ③ **不做版本流程** —— 没有草稿态、没有发布态；但**留审计**（可追溯）。
 *   ④ **改显示名不重写档案数据** —— 本 handler 一行都不碰 `service_archives`。
 *   ⑤ **不改员工备注** —— 同上（备注在 `service_archive_stages.note`，不属于本路径）。
 *   ⑥ **不删历史** —— 同上（历史在 `service_archive_events`，不属于本路径）。
 *
 * 这四条"不碰"不是靠自觉，是靠**这个文件里不出现那些表的仓库名**。
 * 一旦有人在这里 import 档案服务，就说明越界了。
 */
import { CAPABILITY, ForbiddenError } from '../../services/permission-service';
import { STAGE_CONFIG_KEY, normalizeStageConfig, toStagePatch, validateStageSubmit } from '../../services/stage-config-service';
import { ValidationError } from '../../services/ticket-service';
import { fail, ok } from './_http';
import { createWrapper, requireRequestId, usernameOf, type ActionHandler, type SvcActionDeps } from './_request';

/**
 * 依赖：在 `SvcActionDeps` 之上补一个 `db`。
 *
 * ⚠️ 为什么不直接把 `db` 加进 `SvcActionDeps`：那个接口被 20 多个 handler 共用，
 *    加一个可选字段会让"哪些 handler 真的用到 db"变得看不出来。
 *    本仓库的既有做法就是每个需要的模块自己 `& { db: any }`（archive.ts 同构）。
 */
export type StageConfigDeps = SvcActionDeps & { db: any };

export function createStageConfigHandlers(deps: StageConfigDeps): Record<string, ActionHandler> {
  const { permissions } = deps.services;
  const wrap = createWrapper(deps);

  /**
   * 读：登录即可。缺行 / 脏数据一律归一成"默认六行"，不让页面因为配置没写过就空白。
   *
   * ⚠️ 必须带 `can_edit`：后端「施工阶段设置」页要据此决定"显示保存按钮"还是
   *    "显示只能查看"。**不能**让前端自己按角色名猜 —— 两个理由：
   *      ① 授权口径在 `permission-service` 里是唯一事实来源，前端抄一份必然分叉；
   *      ② 前端猜错的两个方向都难看：猜宽了给一个永远 403 的按钮，
   *         猜窄了让管理员以为没权限、转而去改角色（把简单问题变成权限事故）。
   *    这里只暴露"能不能改这一项配置"，不暴露角色名（也就不用担心信息泄露）。
   */
  const archiveStageConfigGet = wrap('archiveStageConfigGet', async (ctx, actor) => {
    const db = deps.db;
    const repo = db.getRepository('serviceSettings');

    // ⚠️ 走仓库而不是 ConfigService 的缓存：配置页保存后要**立刻**看到新值，
    //    而 ConfigService 有 10 秒 TTL。这里的查询是单行主键命中，成本可以忽略。
    const row = await repo.findOne({ filter: { key: STAGE_CONFIG_KEY } });
    const p: any = row ? (typeof row.toJSON === 'function' ? row.toJSON() : row) : null;

    let parsed: unknown = null;
    if (p?.value) {
      try {
        parsed = JSON.parse(String(p.value));
      } catch {
        // 库里的 JSON 坏了 ⇒ 回退默认名，**不**报错。
        // 理由：这一行只是"显示名覆盖"，坏了不影响任何业务事实；
        // 让整个暖通页面 500 是拿一个装饰性配置去换核心功能。
        parsed = null;
      }
    }

    ok(ctx, {
      stages: normalizeStageConfig(parsed),
      // 有 override 才有 updated_at；没有就是"从未配置过，用默认名"。
      // ⚠️ 是 `updatedAt`（驼峰，NocoBase 的时间戳字段名），不是库里的 `updated_at` 列名 ——
      //    这里拿到的是 toJSON() 出来的对象，键已经被映射成驼峰。写成 `updated_at` 会恒为 null。
      updated_at: p?.updatedAt ? new Date(p.updatedAt).toISOString() : null,
      // 明确告诉前端"这六行是库里的还是代码默认的" —— 界面好据此显示来源
      source: p?.value ? 'database' : 'default',
      // 与 `archiveStageConfigSave` **同一个**判断（`CAPABILITY.ADMIN`）：
      // 这里若换了另一种判据，界面上就会出现"能改但存不了"或"能存但没按钮"。
      can_edit: Boolean(actor) && permissions.can(actor as any, CAPABILITY.ADMIN),
    });
  });

  /** 写：仅 hq_admin。整体提交 + 同事务审计 + 立刻失效缓存。 */
  const archiveStageConfigSave = wrap('archiveStageConfigSave', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'archiveStageConfigSave');
    if (!requestId) return;
    // ① 能力闸门：总部售后（hq_after_sales）**也不行** —— 它负责"处理"，不负责"改系统口径"。
    //    与 updateSetting 同一条线（那里也是 CAPABILITY.ADMIN）。
    permissions.assertCapability(actor, CAPABILITY.ADMIN);

    const body = (ctx?.action?.params?.values ?? {}) as any;
    const input = body?.stages;
    const invalid = validateStageSubmit(input);
    if (invalid) {
      fail(ctx, 422, invalid.code, invalid.message);
      return;
    }

    const db = deps.db;
    const repo = db.getRepository('serviceSettings');
    const auditRepo = db.getRepository('configChangeAudits');
    const operatorName = usernameOf(actor) ?? String(actor.userId);

    // 幂等回放：同一个 X-Request-Id 重试不写第二条审计、不重复改
    const prior = await auditRepo.findOne({ filter: { request_id: requestId, key: STAGE_CONFIG_KEY } });
    if (prior) {
      const q: any = typeof prior.toJSON === 'function' ? prior.toJSON() : prior;
      ok(ctx, { stages: normalizeStageConfig(safeParse(q.new_value)), replayed: true });
      return;
    }

    // 归一化后再入库：`code`/`order` 由常量决定，库里只见 name/description
    const normalized = normalizeStageConfig(
      Object.fromEntries(
        (input as any[]).map((s) => [String(s.code), { name: s.name, description: s.description ?? '' }]),
      ),
    );
    const patchJson = JSON.stringify(toStagePatch(normalized));

    let oldValue: string | null = null;
    let created = false;
    try {
      await db.sequelize.transaction(async (t: any) => {
        const existing = await repo.findOne({ filter: { key: STAGE_CONFIG_KEY }, transaction: t });
        const ep: any = existing ? (typeof existing.toJSON === 'function' ? existing.toJSON() : existing) : null;
        oldValue = ep?.value ?? null;

        // 无变化 ⇒ 不写库、不写审计。理由同 archiveStageUpdate：
        // "只点了保存没改字"不该在审计表里留下一条"从 A 改到 A"的噪声，
        // 那会让"谁改过配置"这个问题的答案变得不可读。
        if (oldValue === patchJson) return;

        if (existing) {
          await repo.update(
            { filter: { key: STAGE_CONFIG_KEY }, values: { value: patchJson, value_type: 'json', updated_by: operatorName } },
            { transaction: t },
          );
        } else {
          // ⚠️ NocoBase `Repository.create` 的入参必须是 `{ values }`。
          //    直接 `create({ key, value, ... })` 不会报"参数错"，而是把整个对象
          //    当成 options 吃掉 —— 于是 `values` 为 undefined、每列都是默认值/空，
          //    最终在 `key NOT NULL` 上炸成 500（2026-11-19 实测，B4a）。
          await repo.create(
            {
              values: {
                key: STAGE_CONFIG_KEY,
                value: patchJson,
                value_type: 'json',
                description: '暖通工程六个阶段的显示名称与说明（R2.2.1 §八）',
                updated_by: operatorName,
              },
            },
            { transaction: t },
          );
          created = true;
        }

        // 审计同样必须 `{ values }`（config-settings.ts 里也是这个形状）。
        await auditRepo.create(
          {
            values: {
              key: STAGE_CONFIG_KEY,
              old_value: oldValue,
              new_value: patchJson,
              operator_user_id: actor.userId,
              operator_name: operatorName,
              scene: 'update',
              request_id: requestId,
              note: '暖通阶段显示配置',
            },
          },
          { transaction: t },
        );
      });
    } catch (error) {
      // 审计表有 (request_id, key) 唯一索引：并发下同一 requestId 的第二次写入会撞
      // ⇒ 那说明第一次已经成功，按"回放"回答，而不是报 500。
      const msg = String((error as Error)?.message ?? '');
      if (/unique|duplicate/i.test(msg)) {
        ok(ctx, { stages: normalized, replayed: true });
        return;
      }
      throw error;
    }

    // ② 保存即生效：清掉 ConfigService 缓存。虽然本 handler 走仓库直读，
    //    但别的地方（如移动端的阶段名渲染若走 config）可能有缓存副本。
    try {
      deps.services.config?.invalidate?.(STAGE_CONFIG_KEY);
    } catch {
      // 缓存失效失败不影响"已入库"这个事实；下一次 TTL 到期自然生效
    }

    ok(ctx, { stages: normalized, replayed: false });
  });

  return {
    archiveStageConfigGet,
    archiveStageConfigSave,
  };
}

function safeParse(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
