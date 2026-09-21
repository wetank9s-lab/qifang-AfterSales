/**
 * **前后端共享**的派工契约（service_mode + provider_name 条件必填）
 *
 * ⚠️ 本文件必须是**零依赖纯模块**（不 import 任何 NocoBase / Node 运行时模块）：
 *    · 服务端（`src/server`）与浏览器端（`src/client`）都从这里取值；
 *    · scripts/verify-client-logic.mjs 可以用 esbuild 编译后在 Node 里直接跑断言。
 *
 * ---------------------------------------------------------------------------
 * 为什么必须有这么一个文件（2026-09-21 复核方抓到的**阻塞缺陷**）：
 *
 *   `0db9fcc` 的 H6 派工弹窗里，服务方式的下拉选项是手写的：
 *       { value: 'self',        label: '自营' }
 *       { value: 'third_party', label: '第三方/厂家' }
 *   而服务端唯一合法的派工取值是 `inhouse / manufacturer / third_party`
 *   （`remote` 明确不走派工，见下面 DISPATCHABLE_SERVICE_MODES 的理由）。
 *
 *   后果是三条：
 *     ① 选「自营」会提交 `self` → 服务端必然 422 INVALID_ENUM；
 *     ② 「厂家」被客户端合并进 `third_party` → **永远产生不出 manufacturer 数据**，
 *        后续按 service_mode 统计"厂家 vs 第三方"直接失真；
 *     ③ 服务端要求 manufacturer / third_party 必填 provider_name，
 *        客户端却把它定义为非必填 → 连"最后一轮提醒"都交给了服务端。
 *
 *   这类缺陷的共同点是：**它不会让任何测试变红，只会在真人点下去的那一刻爆**。
 *   所以修法不是"把两处都改对"，而是让两处**不可能各自存在** ——
 *   枚举、文案、是否必填全部收敛到本文件，由自动化断言盯住契约本身。
 *
 * 使用约定：
 *   · 服务端继续从 `../../constants` 取（那里 re-export 本文件的值），改动面最小；
 *   · 客户端直接 import 本文件；
 *   · 新增/调整 service_mode 必须同时跑 scripts/verify-client-logic.mjs。
 */

/** 服务方式：门店自修 / 厂家 / 第三方 / 远程指导 */
export const SERVICE_MODE = {
  INHOUSE: 'inhouse',
  MANUFACTURER: 'manufacturer',
  THIRD_PARTY: 'third_party',
  REMOTE: 'remote',
} as const;

export type ServiceMode = (typeof SERVICE_MODE)[keyof typeof SERVICE_MODE];

export const SERVICE_MODE_VALUES: string[] = Object.values(SERVICE_MODE);

/**
 * 允许经 `dispatch`（M3）派工的 `service_mode` —— **不含 remote**。
 *
 * 为什么要把 remote 排除在外（这是对 docs/STATE-MACHINE.md M3 的一处**更正**，
 * 见 docs/DEVIATIONS.md DEV-42）：
 *
 *   原 M3 的"前置校验"写的是「非 remote 时 预约时间/师傅姓名/手机号必填」，
 *   字面上允许 remote 走派工且允许这三个字段为空。但 Visit 表的这三列都是
 *   `NOT NULL`（`technician_name` / `technician_mobile` / `expected_visit_at`），
 *   而 remote 流程在 M11 里**本来就会自己建一条 `is_remote=true` 的 Visit**。
 *   两条路都建 Visit，结果就是一张工单上出现两条互相矛盾的 Visit
 *   （一条"有师傅但远程"、一条"无 Token 的远程"），后台无法解释。
 *
 *   因此口径收敛为一句话：**远程处理不进派工，走 M11（Phase 6）**。
 *   在 Phase 6 交付前，`dispatch(service_mode=remote)` 一律被拒（422 `REMOTE_MODE_DEFERRED`），
 *   而不是"先建一条字段全空的 Visit 等以后收拾"——后者会留下无法自愈的脏数据。
 *
 * ⚠️ 待 Phase 6 实现 M11 时，若届时决定让 remote 也复用 dispatch，
 *    必须同时把这三列改成 nullable 并重新评审 Visit 的唯一性语义；
 *    在那之前不要悄悄把这个数组改宽。
 */
export const DISPATCHABLE_SERVICE_MODES: string[] = [
  SERVICE_MODE.INHOUSE,
  SERVICE_MODE.MANUFACTURER,
  SERVICE_MODE.THIRD_PARTY,
];

/**
 * `service_mode` 的中文名（**界面与服务端文案共用一份**）。
 *
 * ⚠️ 2026-09-21 更正：原客户端把 "厂家" 与 "第三方" 合并成一个选项，
 *    并把门店自营写成 "自营 / self"。现在的三个文案与服务端枚举**一一对应**，
 *    保证统计口径（service_visits.service_mode）能被真实数据填满。
 *
 * `remote` 的文案带"（不派工）"是刻意的：它出现在服务端日志与事件 summary 里，
 * 让人一眼看出这单是按远程处理的，而不是漏填了服务方式。
 */
export const SERVICE_MODE_LABEL: Record<string, string> = {
  [SERVICE_MODE.INHOUSE]: '门店自修',
  [SERVICE_MODE.MANUFACTURER]: '厂家',
  [SERVICE_MODE.THIRD_PARTY]: '第三方',
  [SERVICE_MODE.REMOTE]: '远程指导（不派工）',
};

/** 下拉框选项（**Phase 4 派工 UI 的唯一取值来源**，`remote` 不在其中） */
export function dispatchServiceModeOptions(): Array<{ value: string; label: string }> {
  return DISPATCHABLE_SERVICE_MODES.map((value) => ({
    value,
    label: SERVICE_MODE_LABEL[value] ?? value,
  }));
}

/**
 * 该 service_mode 是否**必须**填写 `provider_name`。
 *
 * 判据：只要不是门店自己的师傅（厂家/第三方），就必须留下**谁修的** ——
 * 否则工单上只有"师傅李四"，后续对账、追责、回访都找不到主体。
 */
export function requiresProviderName(serviceMode: unknown): boolean {
  return (
    serviceMode === SERVICE_MODE.MANUFACTURER || serviceMode === SERVICE_MODE.THIRD_PARTY
  );
}

// ---------------------------------------------------------------------------
// 派工表单：字段清单 / 缺失判定 / 提交载荷
// ---------------------------------------------------------------------------

/**
 * 派工（dispatch / reassign）表单的字段清单。
 *
 * 字段名刻意与服务端 `dispatchInputOf()` 接受的 snake_case 契约**逐字相同**：
 * 前端不用做字段映射，也就没有"映射表里漏一行"这种漂移位置。
 */
export const DISPATCH_FORM_FIELDS = [
  'technician_name',
  'technician_mobile',
  'expected_visit_at',
  'service_mode',
  'provider_name',
] as const;

/** 改约只需要这两个字段（改约不换人，所以没有 service_mode / provider_name） */
export const RESCHEDULE_FORM_FIELDS = ['expected_visit_at', 'reason'] as const;

/**
 * 派工类表单的必填判定。
 *
 * ✦ 这是**条件必填**的唯一实现点：前端弹窗、离线断言、服务端
 *   `TicketService.assertDispatchInput()` 三处都按同一条规则
 *   （manufacturer / third_party ⇒ provider_name 必填）。
 *
 * ⚠️ 前端拦了不等于服务端可以放松：服务端仍然保留 `MISSING_PROVIDER` 兜底，
 *    因为绕过 UI（curl / 自动化 / 旧的前端产物）是常态，不是异常。
 *    UI 校验的价值是"让用户立刻知道"，不是"让系统安全"。
 */
export function missingDispatchFields(values: Record<string, unknown>): string[] {
  const missing: string[] = [];
  const text = (key: string): string => String(values?.[key] ?? '').trim();

  for (const key of ['technician_name', 'technician_mobile', 'expected_visit_at', 'service_mode']) {
    if (!text(key)) missing.push(key);
  }
  if (requiresProviderName(values?.service_mode) && !text('provider_name')) {
    missing.push('provider_name');
  }
  return missing;
}

/** 改约表单的必填判定（时间与原因缺一不可：没有原因的改约无法复盘） */
export function missingRescheduleFields(values: Record<string, unknown>): string[] {
  const missing: string[] = [];
  if (!String(values?.expected_visit_at ?? '').trim()) missing.push('expected_visit_at');
  if (!String(values?.reason ?? '').trim()) missing.push('reason');
  return missing;
}

/**
 * 组装提交给 `/api/svc:*` 的载荷（**只挑契约里的字段，且丢弃空值**）。
 *
 * 为什么过滤空值：`provider_name` 在"门店自修"时是空字符串，
 * 原样发出去会让服务端把它当成"填了名字"（ albeit 空串），
 * 与"没填"是两种不同的语义 —— 空串应当在出口之前就消失。
 */
export function buildDispatchPayload(values: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of DISPATCH_FORM_FIELDS) {
    const raw = values?.[key];
    if (raw === undefined || raw === null) continue;
    const text = typeof raw === 'string' ? raw.trim() : raw;
    if (text === '') continue;
    payload[key] = text;
  }
  return payload;
}

/** 组装改约载荷（只含 expected_visit_at + reason） */
export function buildReschedulePayload(values: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of RESCHEDULE_FORM_FIELDS) {
    const raw = values?.[key];
    if (raw === undefined || raw === null) continue;
    const text = typeof raw === 'string' ? raw.trim() : raw;
    if (text === '') continue;
    payload[key] = text;
  }
  return payload;
}
