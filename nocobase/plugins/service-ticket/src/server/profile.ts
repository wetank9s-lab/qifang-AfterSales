/**
 * 运行 profile 的**唯一判定源**（Phase 10 · §4.2 RB-4 / P10-B）
 *
 * 为什么必须有这一个文件（契约实测结论）：
 *   此前全插件源码 `grep isProduction|APP_ENV` **零命中**，容器里 `APP_ENV` / `NODE_ENV`
 *   **都没有设置** ⇒ 系统无法区分「我在开发」与「我在生产」，
 *   因此也**不可能**"在生产上拒绝启动"。根因不是某个开关没关，而是**没有开关**。
 *
 * 🔒 三条硬约束（用户 2026-10-05 裁决）：
 *   ① **唯一**：profile 只能由 `APP_ENV` 判定。不得再出现「compose 看 NODE_ENV、
 *      插件看另一个变量、health 自己猜环境」的三套判定 —— 本文件之外的任何
 *      `NODE_ENV === 'production'` 都属违规（由 verify-config 静态断言钉住）。
 *   ② **不偷偷退回 development**：`APP_ENV` 缺失 ⇒ 判为 **production**（fail-closed 默认），
 *      非法值（如 `prod` / `staging` / `Production ` 之外的任何串）⇒ **直接抛错拒绝启动**，
 *      而不是"当作 development 继续跑"，也不是"当作 production 默默继续跑"。
 *   ③ **fail-closed 发生在启动/ready 阶段**，不是"等某个请求碰到短信才失败"
 *      （后者会让应用在 production 下先正常提供业务，攻击面已经敞开了才报错）。
 *
 * 为什么选 `APP_ENV` 而不是新造变量：`@nocobase/logger/lib/config.js:48,53` **已经在用它**
 * （`LOGGER_LEVEL || (APP_ENV === 'development' ? 'debug' : 'info')`、`LOGGER_FORMAT` 同理），
 * 本阶段只是把它**显式化**，不引入第二套开关。
 */

import { PUBLIC_ACTION, SVC_ACTION } from './constants';
import { RECEIPT_ENV_KEYS, receiptRequiredForProvider } from './sms-receipt-config';

export const PROFILE_ENV_KEY = 'APP_ENV';

export const APP_PROFILE = {
  DEVELOPMENT: 'development',
  TEST: 'test',
  PRODUCTION: 'production',
} as const;

export type AppProfile = (typeof APP_PROFILE)[keyof typeof APP_PROFILE];

const ALLOWED_PROFILES: readonly AppProfile[] = [
  APP_PROFILE.DEVELOPMENT,
  APP_PROFILE.TEST,
  APP_PROFILE.PRODUCTION,
];

/** 解析结果。保留 `raw` 是为了让"它是怎么判出来的"可被审计（日志/门禁都能看到）。 */
export interface ResolvedProfile {
  profile: AppProfile;
  /** 原始值（未 trim）；缺失时为 '' */
  raw: string;
  /** 是否因为缺失而落到 production —— 这种"默认成生产"必须在日志里看得见 */
  missing: boolean;
}

/**
 * 解析 profile。**纯函数**：不读 process.env，入参决定一切（便于门禁离线验证与反证）。
 *
 * @throws 非法值 ⇒ 抛错（不静默降级）
 */
export function resolveProfile(raw: string | undefined | null): ResolvedProfile {
  const source = raw === undefined || raw === null ? '' : String(raw);
  const normalized = source.trim().toLowerCase();

  // ① 缺失 ⇒ production（fail-closed 默认），但**标记**出来让人看得见
  if (normalized === '') {
    return { profile: APP_PROFILE.PRODUCTION, raw: source, missing: true };
  }

  // ② 合法值
  if ((ALLOWED_PROFILES as readonly string[]).includes(normalized)) {
    return { profile: normalized as AppProfile, raw: source, missing: false };
  }

  // ③ 非法值 ⇒ 拒绝。为什么不"容错成 production"：
  //    写 `prod` / `staging` 的人**以为**自己在表达某个环境，静默当成 production 会让
  //    他以为配置生效了；而当成 development 更糟（直接关掉所有生产约束）。
  //    唯一诚实的做法是停下来让他改对。
  throw new Error(
    `[service-ticket] ${PROFILE_ENV_KEY}=${JSON.stringify(source)} 非法。` +
      `允许值：${ALLOWED_PROFILES.join(' | ')}（缺失 ⇒ 按 production 处理）。` +
      `不允许静默降级为 development —— 那会让生产约束整体失效。`,
  );
}

/** 从环境读（唯一入口） */
export function resolveProfileFromEnv(env: Record<string, string | undefined> = process.env): ResolvedProfile {
  return resolveProfile(env[PROFILE_ENV_KEY]);
}

export function isProduction(profile: AppProfile): boolean {
  return profile === APP_PROFILE.PRODUCTION;
}

/**
 * production 下**不得注册**的测试 / 诊断能力（🔒 用户裁决：不注册优于注册了但 403）。
 *
 * > 攻击面不存在，比 ACL 正确更强。
 *
 * 名单来源：Phase 10 契约 §4.2 的实测表（当前唯一闸是 `SMS_PROVIDER=mock`，
 * 而**模板出厂默认就是 mock** —— 等于这个闸默认是开的）。
 */
export const PRODUCTION_FORBIDDEN_SVC_ACTIONS: readonly string[] = [
  SVC_ACTION.TOKEN_CHECK, // 探针：仅 mock 短信通道"可达"（自毁闸）
  SVC_ACTION.SMS_OUTBOX, // 探针：同上
  SVC_ACTION.FAULT_INJECT, // 故障注入：无自毁闸，仅靠 X-Svc-Diag-Key
  SVC_ACTION.GUARD_QUOTA, // 限流额度只读诊断：匿名 + diag key
];

export const PRODUCTION_FORBIDDEN_PUBLIC_ACTIONS: readonly string[] = [
  PUBLIC_ACTION.REVIEW_SWEEP_PROBE, // 匿名 sweep 探针
];

/**
 * 匿名白名单里的一条（`[resource, action]`）是否在 production 下被禁。
 *
 * ⚠️ 为什么 ACL 侧也要过滤，而不只是"不注册 handler"：
 *    放行一个不存在的 action 本身无害（404），但 ACL 白名单是
 *    **对外暴露面的唯一事实来源**（docs/API.md §0）。留着它，
 *    这份清单就在生产下**声称**开放了一个并不存在的端点 ——
 *    下次有人照着清单补回 handler，攻击面就无声地回来了。
 */
export function isProductionForbiddenEntry(resource: string, action: string): boolean {
  if (resource === 'svc') return PRODUCTION_FORBIDDEN_SVC_ACTIONS.includes(action);
  if (resource === 'publicReview') return PRODUCTION_FORBIDDEN_PUBLIC_ACTIONS.includes(action);
  return false;
}

/**
 * 生产 readiness 违规项（**纯函数**，返回全部违规而不是第一条 —— 
 * 一次把问题看全，避免"改一个、重启、再撞下一个"的循环）。
 */
export interface ProductionViolation {
  code: string;
  detail: string;
}

/** 被视为"测试凭据注入"的环境变量前缀（production 下不得出现非空值） */
const TEST_CREDENTIAL_ENV_PREFIXES = ['SMOKE_', 'UAT_'];

export function collectProductionViolations(input: {
  env: Record<string, string | undefined>;
  /** 实际已注册的测试/诊断 action 名（正常应为空） */
  registeredForbiddenActions?: readonly string[];
  /**
   * Phase 10 / RB-8：送达回执链路是否已配置。
   *
   * ⚠️ 传 `undefined` 表示"本调用点不掌握这个事实"（例如离线纯函数调用）⇒ **不判**；
   *    传 `false` 才是"确认未配置"⇒ 违规。
   *    这个三态是有意的：把"不知道"当成"没配置"会逼所有调用方都必须先解析配置，
   *    而把"没配置"当成"不知道"则会让生产静默放行 —— 那正是要防的事故。
   */
  receiptConfigured?: boolean;
}): ProductionViolation[] {
  const { env } = input;
  const violations: ProductionViolation[] = [];

  // ① mock 短信通道 —— §4.2 条件 1
  //    ⚠️ 缺省即 mock（health.ts 用 `|| 'mock'`），所以**空值也必须算违规**，
  //       否则"SMS_PROVIDER 没配"会被读成"配了别的"，恰好绕过这一条。
  const smsProvider = String(env.SMS_PROVIDER ?? '').trim().toLowerCase();
  if (smsProvider === '' || smsProvider === 'mock') {
    violations.push({
      code: 'SMS_PROVIDER_MOCK',
      detail:
        `SMS_PROVIDER=${JSON.stringify(env.SMS_PROVIDER ?? '')}（空值与 mock 同罪）` +
        ` —— 生产不得使用 mock 短信通道：` +
        `它同时是 4 个测试/诊断端点唯一的自毁闸，mock 在线等于这些端点在线`,
    });
  }

  // ② 测试 / 诊断能力仍被注册 —— §4.2 条件 2
  const forbidden = (input.registeredForbiddenActions ?? []).filter(Boolean);
  if (forbidden.length > 0) {
    violations.push({
      code: 'TEST_CAPABILITY_REGISTERED',
      detail: `以下测试/诊断 action 仍被注册：${forbidden.join(', ')} —— production 要求**不注册**（404），不是"注册了但 403"`,
    });
  }

  // ③ 测试凭据仍处于注入状态 —— §4.2 条件 3
  const injected = Object.keys(env)
    .filter((k) => TEST_CREDENTIAL_ENV_PREFIXES.some((p) => k.startsWith(p)))
    .filter((k) => String(env[k] ?? '').trim() !== '');
  if (injected.length > 0) {
    violations.push({
      code: 'TEST_CREDENTIALS_PRESENT',
      detail: `production 环境仍注入测试凭据变量：${injected.sort().join(', ')}（容器内任意代码 / docker inspect 可读）`,
    });
  }

  // ④ 必要 secret 缺失 —— §4.2 条件 4
  const signSecret = String(env.SIGN_SECRET ?? '').trim();
  if (signSecret === '') {
    violations.push({
      code: 'SIGN_SECRET_MISSING',
      detail: 'SIGN_SECRET 为空 —— 短链/评价 Token 签名与限流诊断的密钥缺失',
    });
  }

  // ⑤ 明确的开发配置被 production 使用 —— §4.2 条件 5
  const baseUrl = String(env.PUBLIC_BASE_URL ?? '').trim();
  if (baseUrl === '') {
    violations.push({ code: 'PUBLIC_BASE_URL_MISSING', detail: 'PUBLIC_BASE_URL 未配置' });
  } else if (!/^https:\/\//.test(baseUrl)) {
    violations.push({
      code: 'PUBLIC_BASE_URL_NOT_PRODUCTION',
      detail:
        `PUBLIC_BASE_URL=${JSON.stringify(baseUrl)} —— production 必须是 https 且非 localhost` +
        `（短信链接与照片 URL 会直接把它发给客户/师傅，配成 localhost 等于链接全废）`,
    });
  } else if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl)) {
    violations.push({
      code: 'PUBLIC_BASE_URL_LOCALHOST',
      detail: `PUBLIC_BASE_URL=${JSON.stringify(baseUrl)} 指向本机 —— 客户/师傅打不开`,
    });
  }

  // ⑥ 送达回执链路未配置（Phase 10 / RB-8）—— **只在阿里云通道下要求**
  //
  //    为什么这一条是 A 类发布阻塞而不是可观测性缺口：
  //    `delivery_status` 只能由供应商回执更新（`SmsSendResult.deliveryStatus`
  //    的类型就是 `'pending'`）。没有回执链路 ⇒ `accepted` 有来源、`delivered/failed`
  //    **没有** ⇒ 冻结的语义边界「accepted ≠ delivered」在生产上无法成立。
  //
  //    ⚠️ 只对阿里云要求：mock 通道（开发/验收）与未实现通道（tencent 落
  //    `NotImplementedSmsProvider`）客观上不存在回执能力，对它们要求等于
  //    要求一个不存在的供应商能力 —— 那会逼人把配置填成假的。
  const provider = String(env.SMS_PROVIDER ?? '').trim().toLowerCase();
  if (receiptRequiredForProvider(provider) && input.receiptConfigured === false) {
    violations.push({
      code: 'DELIVERY_RECEIPT_UNCONFIGURED',
      detail:
        `SMS_PROVIDER=${provider} 但未配置 MNS 送达回执队列` +
        `（${RECEIPT_ENV_KEYS.endpoint} / ${RECEIPT_ENV_KEYS.queue}）—— ` +
        '没有它 delivery_status 永远是 pending，"已送达"在生产上没有真实输入来源',
    });
  }

  return violations;
}

/**
 * 启动期 fail-closed 闸门：production 且有违规 ⇒ **抛错**（拒绝启动）。
 *
 * ⚠️ 为什么抛错而不是 warning（契约 🔒）：
 *    warning 意味着应用照常起来、照常服务业务，只是日志里有一行没人看的话 ——
 *    那正是"攻击面已经敞开"的状态。
 */
export function assertProductionReady(input: {
  profile: AppProfile;
  env: Record<string, string | undefined>;
  registeredForbiddenActions?: readonly string[];
  /** RB-8：三态语义见 collectProductionViolations 的注释 */
  receiptConfigured?: boolean;
}): { ok: true; violations: [] } | never {
  if (!isProduction(input.profile)) return { ok: true as const, violations: [] as [] };

  const violations = collectProductionViolations(input);
  if (violations.length === 0) return { ok: true as const, violations: [] as [] };

  throw new Error(
    `[service-ticket] production profile 拒绝启动（${violations.length} 项不可接受的配置）：\n` +
      violations.map((v, i) => `  ${i + 1}. [${v.code}] ${v.detail}`).join('\n') +
      `\n  ⇒ 这不是 warning：应用必须停下来，而不是带着这些配置继续提供业务。`,
  );
}
