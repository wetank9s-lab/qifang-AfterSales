/**
 * BE-05 / BE-03 只读洞察接口（第一版）。
 *
 * 设计纪律：
 *  · **只读**：全部是 SELECT，没有任何写库路径，可以随时回滚。
 *  · **单一口径**：KPI 直接对着 service_tickets / sms_logs 聚合，
 *    不复制第二套状态机；"期间发生量"与"当前存量"分开返回，字段名自带语义。
 *  · **时间**：统一按 Asia/Shanghai 计算自然日边界（与 BE-04 一致）。
 *  · **权限**：只允许 hq_admin / hq_after_sales；其它角色 403（不靠隐藏菜单）。
 *  · **最小暴露**：不返回 token / hash / 手机号明文 / 媒体路径。
 */

import { SMS_TEMPLATE_ENV_SUFFIX, SMS_TEMPLATE_ENV_PREFIX, SMS_TEMPLATE_TEXT, SMS_SCENE_VALUES, SMS_SCENE_LABEL } from '../../constants';
import { buildSmsStatus } from '../../services/sms-status';

type Ctx = any;

// 🔴 P6：**超级管理员必须放行**（admin/root）。这条是 seed 时实测出来的：
//    后台用 admin 登录调 svc:hqOverview 直接 403 —— 因为 admin 的角色名不是 hq_admin。
//    业务口径仍是"总部只读"，但超管天然可读；门店角色（store_after_sales）依旧拒绝。
const HQ_ROLES = new Set(['hq_admin', 'hq_after_sales', 'admin', 'root']);

function fail(ctx: Ctx, status: number, code: string, message: string) {
  ctx.status = status;
  ctx.body = { errors: [{ code, message }] };
}

function rolesOf(ctx: Ctx): string[] {
  const u: any = ctx.state?.currentUser ?? null;
  if (!u) return [];
  const roles = u.roles;
  if (Array.isArray(roles)) return roles.map((r: any) => String(r?.name ?? r));
  return [];
}

function requireHq(ctx: Ctx): boolean {
  const roles = rolesOf(ctx);
  if (!roles.some((r) => HQ_ROLES.has(r))) {
    fail(ctx, 403, 'FORBIDDEN', '仅总部售后角色可访问');
    return false;
  }
  return true;
}

/** Asia/Shanghai 当日 00:00 对应的 UTC 时间（NocoBase 里 created_at 存 UTC）*/
async function dayStart(db: any, offsetDays = 0): Promise<string> {
  const rows = await db.sequelize.query(
    `SELECT to_char((date_trunc('day', (now() AT TIME ZONE 'Asia/Shanghai')) + ($1 || ' day')::interval)
       AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') AS ts`,
    { replacements: [String(offsetDays)], type: 'SELECT' },
  );
  return String((rows?.[0] as any)?.ts ?? '');
}

export function createHqOverviewHandler(): (ctx: Ctx) => Promise<void> {
  return async (ctx: Ctx) => {
    if (!requireHq(ctx)) return;
    const db = (ctx as any).db;


    // ---- 1) 五个 KPI（口径写在返回体里，前端直接展示）----
    const kpi = (
      await db.sequelize.query(
        `SELECT
           (SELECT count(*) FROM service_tickets
             WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))                                    AS new_today,
           (SELECT count(*) FROM service_tickets
             WHERE status = 'CLOSED'
               AND closed_at IS NOT NULL AND closed_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))           AS closed_today,
           (SELECT count(*) FROM service_tickets WHERE status = 'PROCESSING')     AS processing_now,
           (SELECT count(*) FROM service_tickets WHERE status = 'WAIT_STORE_CONFIRM') AS wait_confirm_now,
           (SELECT count(*) FROM service_tickets
             WHERE status NOT IN ('CLOSED','CANCELLED')
               AND closed_at IS NULL
               AND updated_at < now() - interval '24 hours')                AS overdue_now`,
        { type: 'SELECT' },
      )
    )?.[0] as any;

    // ---- 2) 15 家门店对比（LEFT JOIN，没业务的门店也必须出现且为 0）----
    const stores = await db.sequelize.query(
      `SELECT s.id, s.name,
              count(t.id) FILTER (WHERE t.created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))                                   AS new_count,
              count(t.id) FILTER (WHERE t.status = 'CLOSED'
                                    AND t.closed_at IS NOT NULL AND t.closed_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))        AS closed_count,
              count(t.id) FILTER (WHERE t.status = 'PROCESSING')                                 AS processing_now,
              count(t.id) FILTER (WHERE t.status = 'WAIT_STORE_CONFIRM')                         AS wait_confirm_now,
              count(t.id) FILTER (WHERE t.status NOT IN ('CLOSED','CANCELLED') AND t.closed_at IS NULL
                                    AND t.updated_at < now() - interval '24 hours')              AS overdue_now
         FROM stores s
         LEFT JOIN service_tickets t ON t.store_id = s.id
        GROUP BY s.id, s.name
        ORDER BY s.id`,
      { type: 'SELECT' },
    );

    // ---- 3) 近 30 天趋势（新增 / 完成）----
    const trend = await db.sequelize.query(
      `WITH d AS (
         SELECT generate_series(
           (date_trunc('day', (now() AT TIME ZONE 'Asia/Shanghai')) - interval '29 day'),
           date_trunc('day', (now() AT TIME ZONE 'Asia/Shanghai')), interval '1 day') AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              (SELECT count(*) FROM service_tickets t
                WHERE (t.created_at AT TIME ZONE 'Asia/Shanghai')::date = d.day::date) AS new_count,
              (SELECT count(*) FROM service_tickets t
                WHERE t.status = 'CLOSED' AND t.closed_at IS NOT NULL
                  AND (t.closed_at AT TIME ZONE 'Asia/Shanghai')::date = d.day::date)   AS closed_count
         FROM d ORDER BY d.day`,
      { type: 'SELECT' },
    );

    // ---- 4) 异常待办（真实需要总部关注的，不含"已完成"）----
    const alerts = await db.sequelize.query(
      `SELECT t.id, t.ticket_no, t.status, t.review_status, t.rating, t.reopen_count,
              to_char(t.updated_at AT TIME ZONE 'Asia/Shanghai', 'MM-DD HH24:MI') AS updated_local,
              s.name AS store_name,
              -- 附加信息：即使主原因被判成"评价后继续处理"，也仍要知道这条同时已超 24h 未更新
              (t.status NOT IN ('CLOSED','CANCELLED') AND t.closed_at IS NULL
                AND t.updated_at < now() - interval '24 hours') AS is_overdue,
              -- 判定顺序 = "越该先处理越靠前"。原来 overdue 在最前 ⇒ 一条"评价后被重开且已超 24h"
              -- 的工单会被标成 overdue，页面上永远看不到"评价后继续处理/低分评价"这两类
              -- （实测 50/50 全是 overdue）。只改标签判定顺序，**不改阈值、不改统计口径**。
              CASE
                WHEN t.review_status = 'submitted' AND t.status NOT IN ('CLOSED','CANCELLED') THEN 'reopened_after_review'
                WHEN t.rating IS NOT NULL AND t.rating <= 2 THEN 'low_rating'
                WHEN t.status = 'WAIT_STORE_CONFIRM' THEN 'wait_store_confirm'
                WHEN t.status NOT IN ('CLOSED','CANCELLED') AND t.closed_at IS NULL
                     AND t.updated_at < now() - interval '24 hours' THEN 'overdue'
                ELSE 'other'
              END AS alert_type
         FROM service_tickets t LEFT JOIN stores s ON s.id = t.store_id
        WHERE (t.review_status = 'submitted' AND t.status NOT IN ('CLOSED','CANCELLED'))
           OR (t.status = 'WAIT_STORE_CONFIRM')
           OR (t.rating IS NOT NULL AND t.rating <= 2)
           OR (t.status NOT IN ('CLOSED','CANCELLED') AND t.closed_at IS NULL
               AND t.updated_at < now() - interval '24 hours')
        -- 🔴 排序必须与 alert_type 的优先级**同一套权重**，否则 LIMIT 50 会先按"最近更新"
        --    把老的低分/评价后工单挤出去，"优先级"只体现在标签上等于没有。
        --    权重与前端 alertPriority() 一致：评价后 0 < 低分 1 < 待确认 2 < 超时 3 < 其他 9。
        ORDER BY
          CASE
            WHEN t.review_status = 'submitted' AND t.status NOT IN ('CLOSED','CANCELLED') THEN 0
            WHEN t.rating IS NOT NULL AND t.rating <= 2 THEN 1
            WHEN t.status = 'WAIT_STORE_CONFIRM' THEN 2
            WHEN t.status NOT IN ('CLOSED','CANCELLED') AND t.closed_at IS NULL
                 AND t.updated_at < now() - interval '24 hours' THEN 3
            ELSE 9
          END ASC,
          t.updated_at DESC
        LIMIT 50`,
      { type: 'SELECT' },
    );

    ctx.status = 200;
    ctx.body = {
      data: {
        generated_at: new Date().toISOString(),
        range: { from: '今日 00:00（Asia/Shanghai）', to: 'now', timezone: 'Asia/Shanghai' },
        kpi: {
          values: {
            new_today: Number(kpi?.new_today ?? 0),
            closed_today: Number(kpi?.closed_today ?? 0),
            processing_now: Number(kpi?.processing_now ?? 0),
            wait_confirm_now: Number(kpi?.wait_confirm_now ?? 0),
            overdue_now: Number(kpi?.overdue_now ?? 0),
          },
          // 口径随数据一起下发，避免前端或报表各写一套解释
          definitions: {
            new_today: '今日 00:00 起按 created_at 计数（期间发生量；左闭右开）',
            closed_today: '今日 00:00 起、status=CLOSED 且按 closed_at 计数（期间发生量；左闭右开）',
            processing_now: '当前 status=PROCESSING（存量）',
            wait_confirm_now: '当前 status=WAIT_STORE_CONFIRM（存量）',
            overdue_now: '未结单且 updated_at 超过 24 小时未变更（存量）',
          },
        },
        stores: (stores ?? []).map((r: any) => ({
          id: Number(r.id),
          name: String(r.name ?? ''),
          new_count: Number(r.new_count ?? 0),
          closed_count: Number(r.closed_count ?? 0),
          processing_now: Number(r.processing_now ?? 0),
          wait_confirm_now: Number(r.wait_confirm_now ?? 0),
          overdue_now: Number(r.overdue_now ?? 0),
        })),
        trend: (trend ?? []).map((r: any) => ({
          day: String(r.day),
          new_count: Number(r.new_count ?? 0),
          closed_count: Number(r.closed_count ?? 0),
        })),
        alerts: (alerts ?? []).map((r: any) => ({
          id: Number(r.id),
          ticket_no: String(r.ticket_no ?? ''),
          store_name: String(r.store_name ?? ''),
          status: String(r.status ?? ''),
          review_status: r.review_status ?? null,
          rating: r.rating == null ? null : Number(r.rating),
          reopen_count: Number(r.reopen_count ?? 0),
          alert_type: String(r.alert_type ?? 'other'),
          is_overdue: r.is_overdue === true,
          updated_local: String(r.updated_local ?? ''),
        })),
      },
    };
  };
}

/** BE-03 第一版：短信状态总览（只读）。 */
export function createSmsOverviewHandler(): (ctx: Ctx) => Promise<void> {
  return async (ctx: Ctx) => {
    if (!requireHq(ctx)) return;
    const db = (ctx as any).db;
    const settings = (ctx as any).app?.services?.config ?? null;

    // 开关：真值来自 service_settings；读不到就明确说"未知"，不默认成 true
    // ⚠️ `app.services.config` 在这个上下文取不到（实测 channel.enabled=null），
    //    直接读 `service_settings` 才是真值来源。
    let enabled: boolean | null = null;
    let provider: string | null = null;
    try {
      const rows = await db.sequelize.query(
        `SELECT key, value FROM service_settings WHERE key IN ('sms.enabled','sms.provider')`,
        { type: 'SELECT' },
      );
      for (const r of rows as any[]) {
        if (r.key === 'sms.enabled') enabled = String(r.value) === 'true' || String(r.value) === '1';
        if (r.key === 'sms.provider') provider = r.value == null ? null : String(r.value);
      }
    } catch {
      enabled = null;
    }
    void settings;

    const counts = (
      await db.sequelize.query(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE send_status = 'pending')  AS queued,
                -- ⚠️ BE-03-UX-01：这里原来写 'sent' / 'failed' —— 而 SMS_SEND_STATUS 的取值只有
                --    pending / accepted / rejected / error ⇒ 这两个计数**恒为 0**，
                --    页面"服务商已受理"会永远显示 0（错误但不报错）。改成真实取值。
                -- 🔴 受理口径：**mock 不算"服务商已受理"**（它根本没出网）。
                --    否则模拟联调的历史数据会冒充真实通道的受理量。
                count(*) FILTER (WHERE send_status = 'accepted' AND provider <> 'mock') AS accepted,
                count(*) FILTER (WHERE send_status = 'rejected') AS rejected,
                count(*) FILTER (WHERE send_status = 'error')    AS errored,
                count(*) FILTER (WHERE delivery_status = 'delivered') AS delivered,
                count(*) FILTER (WHERE error_code = 'SMS_DISABLED')  AS blocked_by_switch
           FROM sms_logs WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')`,
        {
          type: 'SELECT',
        },
      )
    )?.[0] as any;

    const scenes = await db.sequelize.query(
      `SELECT scene, count(*) AS n,
              count(*) FILTER (WHERE error_code = 'SMS_DISABLED') AS blocked,
              max(created_at) AS last_at
         FROM sms_logs WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')
        GROUP BY scene ORDER BY n DESC`,
      { type: 'SELECT' },
    );

    // 场景开关（BE-03）：从 service_settings 读 sms.scene.<scene>.enabled，默认 true
    const sceneRows = await db.sequelize.query(
      `SELECT key, value FROM service_settings WHERE key LIKE 'sms.scene.%.enabled'`,
      { type: 'SELECT' },
    );
    const sceneSwitch = new Map<string, boolean>();
    for (const r of (sceneRows ?? []) as any[]) {
      const m = /^sms\.scene\.([^.]+)\.enabled$/.exec(String(r.key));
      if (m) sceneSwitch.set(m[1], String(r.value) === 'true');
    }
    // 中文名**只覆盖真实存在的 scene**（键来自 constants.SMS_SCENE_VALUES，见下方组装）。
    // ⚠️ 之前手写表里多了一个 `technician_cancel`（常量里根本没有）⇒ 页面出现幽灵场景；
    //    现在改为以 SMS_SCENE_VALUES 为准，label 缺失时回退 scene 名并可见。
    // 🔴 BE-03-SMS-FIX-01：**直接复用 `constants.SMS_SCENE_LABEL`**，不再手抄第二份。
    //    此前这里少一个 `progress_update`（新场景），页面就显示成"未命名通知"——
    //    根因不是"漏了一行"，而是"同一个映射存在两份、其中一份没人记得同步"。
    const SCENE_LABEL: Record<string, string> = { ...SMS_SCENE_LABEL };

    // ---- 模板清单（BE-03-S2）----
    //   · 只读展示"环境变量是否已配 / 后台覆盖值 / 生效值 / 变量名"；
    //   · **绝不**下发任何凭据或密钥；
    //   · variables 来自 SMS_TEMPLATE_TEXT（与渲染同一份常量），不另造清单。
    const tplRows = await db.sequelize.query(
      `SELECT key, value FROM service_settings WHERE key LIKE 'sms.template.%.code'`,
      { type: 'SELECT' },
    );
    const tplOverride = new Map<string, string>();
    for (const r of (tplRows ?? []) as any[]) {
      const m = /^sms\.template\.([a-z_]+)\.code$/.exec(String(r.key));
      if (m) tplOverride.set(m[1], String(r.value ?? ''));
    }
    // 当前通道可能没有模板前缀（如 smsbao）—— 那就用 aliyun 的前缀作"参考名"，
    // 但仍要如实标注"当前通道无模板映射"，否则页面会把"没映射"误读成"模板没配"。
    const providerName = String(provider ?? '');
    const envPrefix = SMS_TEMPLATE_ENV_PREFIX[providerName] ?? SMS_TEMPLATE_ENV_PREFIX.aliyun ?? '';
    const templates = Object.entries(SMS_TEMPLATE_ENV_SUFFIX).map(([scene, suffix]) => {
      const envKey = envPrefix ? `${envPrefix}${suffix}` : '';
      const envConfigured = envKey ? String(process.env[envKey] ?? '').trim().length > 0 : false;
      const override = tplOverride.get(scene) ?? '';
      const text = String((SMS_TEMPLATE_TEXT as any)?.[scene] ?? '');
      const vars = Array.from(new Set((text.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).map((x) => x.slice(1, -1))));
      return {
        scene,
        label: SCENE_LABEL[scene] ?? scene,
        env_var: envKey || '(无)',
        env_configured: envConfigured,
        // 唯一事实：当前通道是否**真的消费**模板 CODE（阿里云 true / 短信宝 false）。
        // 之前那个 `provider_has_mapping` 字段已删除 —— 它对"正文型通道"没有意义，
        // 留着只会让运营把"smsbao 没有前缀"误读成"模板没配好"。
        consumes_code: providerName === 'aliyun',
        override,
        effective: override || (envConfigured ? `env:${envKey}` : ''),
        variables: vars,
        text_summary: text.length > 60 ? `${text.slice(0, 60)}…` : text,
      };
    });

    // ---- 通道诊断（只读，凭据只给"已配置/未配置"）----
    const channelStatus = buildSmsStatus(process.env, {
      enabled: enabled === null ? false : enabled,
      provider: String(provider ?? 'mock'),
      retryCount: 1,
    });

    const recent = await db.sequelize.query(
      `SELECT id, scene, send_status, delivery_status, error_code,
              left(coalesce(error_message, ''), 80) AS error_message,
              recipient_masked, provider_request_id, provider_biz_id,
              to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'MM-DD HH24:MI:SS') AS created_local
         FROM sms_logs ORDER BY id DESC LIMIT 30`,
      { type: 'SELECT' },
    );

    ctx.status = 200;
    ctx.body = {
      data: {
        generated_at: new Date().toISOString(),
        channel: {
          enabled,
          provider,
          // 明确区分"关掉了"与"没配好"：两者对业务含义不同
          verdict:
            enabled === false
              ? '短信功能已关闭，通知未发送（SMS_DISABLED）'
              : enabled === true
                ? '短信已启用'
                : '无法读取开关状态',
        },
        today: {
          total: Number(counts?.total ?? 0),
          queued: Number(counts?.queued ?? 0),
          attempted: Number(counts?.accepted ?? 0) + Number(counts?.errored ?? 0),
          provider_accepted: Number(counts?.accepted ?? 0),
          delivered: Number(counts?.delivered ?? 0),
          // ⚠️ 口径修正：`rejected` 原来把 SMS_DISABLED 也算进去 ⇒ 页面"其它拒绝"显示成 13（含 10 条开关拦截）。
          rejected_total: Number(counts?.rejected ?? 0),
          rejected_non_switch: Number(counts?.rejected ?? 0) - Number(counts?.blocked_by_switch ?? 0),
          failed: Number(counts?.errored ?? 0),
          blocked_by_switch: Number(counts?.blocked_by_switch ?? 0),
        },
        // BE-03：场景开关表**必须覆盖全部已注册场景**，而不是只列"今天有日志的"。
        // 否则今天没发过短信的场景就没有开关可点（用户原话：不能出现点不动的假按钮）。
        templates,
        channel_status: channelStatus,
        scenes: (() => {
          const stat = new Map<string, any>();
          for (const r of (scenes ?? []) as any[]) stat.set(String(r.scene ?? ''), r);
          const names = Array.from(new Set([...(SMS_SCENE_VALUES as string[]), ...stat.keys()]));
          return names.map((name) => {
            const r = stat.get(name);
            return {
              scene: name,
              label: SCENE_LABEL[name] ?? name,
              // 默认 true：与发送链路 flush() 的默认值**必须一致**，否则页面会骗人
              enabled: sceneSwitch.has(name) ? sceneSwitch.get(name) === true : true,
              count: Number(r?.n ?? 0),
              blocked: Number(r?.blocked ?? 0),
              last_at: r?.last_at ? new Date(r.last_at).toISOString() : null,
            };
          });
        })(),
        recent: (recent ?? []).map((r: any) => ({
          id: Number(r.id),
          scene: String(r.scene ?? ''),
          send_status: String(r.send_status ?? ''),
          delivery_status: String(r.delivery_status ?? ''),
          error_code: r.error_code ?? null,
          error_message: String(r.error_message ?? ''),
          recipient_masked: r.recipient_masked ?? null,
          provider_request_id: r.provider_request_id ?? null,
          // BE-03-S6：`provider_biz_id` 才是**回执匹配键**（RB-8）。短信宝把 `msgid` 记在这里，
          // 而它没有"调用追踪号"⇒ `provider_request_id` 会一直是空。页面上必须能看到这一列，
          // 否则"修好了但看不出修好了"（S5 的教训：只看到 requestId=null 就以为映射没做）。
          provider_biz_id: r.provider_biz_id ?? null,
          created_local: String(r.created_local ?? ''),
        })),
      },
    };
  };
}

/**
 * 统一的 handler set —— 与其它 `create*Handlers` 同构，交给 plugin.ts 的 handlerSets 注册。
 * 键名必须是**完整 action 名**（`svc:xxx`），否则启动断言会判定"handler 缺失"。
 */
export function createInsightHandlers(_deps?: { logger?: any }) {
  // ⚠️ 键必须是**裸 action 名**（`hqOverview`），与其它 handlerSet 的
  //    `[SVC_ACTION.X]: handler` 同一约定；写成 `svc:hqOverview` 会命中
  //    "svc action handler 缺失" 启动断言 ⇒ 整个应用 503（12:55 实测踩过）。
  return {
    hqOverview: createHqOverviewHandler(),
    smsOverview: createSmsOverviewHandler(),
  };
}
