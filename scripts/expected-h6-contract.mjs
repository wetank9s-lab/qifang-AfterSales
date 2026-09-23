/**
 * expected-h6-contract.mjs —— H6 六个内部写动作的**对外契约镜像**
 *
 * 与 expected-indexes.mjs / expected-sensitive-columns.mjs 同一个套路：
 *   纯 JS 的期望值放在一处，**既**给脚本用（smoke §4f 拿它构造"与 UI 完全相同的
 *   payload + header"），**又**由另一侧的断言反向锁住它不能与真实实现漂移。
 *
 * ⚠️ 它不是"第二份定义"，而是一份**会被证伪的镜像**：
 *    scripts/verify-client-logic.mjs 会把这里列出的值逐条与
 *    `src/shared/service-mode.ts` / `svc-request.ts`（UI 真正引用的模块）比对，
 *    任何一边改了而另一边没跟着改，离线验收立刻变红。
 *
 * 为什么 smoke 不直接编译 TS：smoke 的定位是"启动后的真实环境验收"，
 * 它的环境依赖（docker / psql / 已部署实例）已经够重了。
 * 再加一条 esbuild 依赖，等于给总闸多挂一个"工具没装就跑不了"的失效点。
 * 于是这里取幂等的两份存在：**TS 侧**由在线 UI 使用、**JS 侧**由验收脚本使用，
 * 两者用断言绑在一起（ DEV-58 记录了这个取舍）。
 */

/** 派工 UI 上可选的 service_mode —— 必须与服务端可派工枚举逐字一致且同序 */
export const DISPATCH_SERVICE_MODES = ['inhouse', 'manufacturer', 'third_party'];

/** service_mode 的中文文案（UI 下拉里显示的文字） */
export const DISPATCH_SERVICE_MODE_LABELS = {
  inhouse: '门店自修',
  manufacturer: '厂家',
  third_party: '第三方',
};

/** 服务方式为这两者时，provider_name 必填（前端拦 + 服务端也拦） */
export const PROVIDER_REQUIRED_MODES = ['manufacturer', 'third_party'];

/** 派工表单字段名与顺序（UI payload 的键序也按这个来） */
export const DISPATCH_FORM_FIELDS = [
  'technician_name',
  'technician_mobile',
  'expected_visit_at',
  'service_mode',
  'provider_name',
];

/** 改约表单字段 */
export const RESCHEDULE_FORM_FIELDS = ['expected_visit_at', 'reason'];

/**
 * 改派表单字段 = 派工全部字段 + `reason`（**必须单独一份，不能与派工共用**）。
 *
 * ⚠️ Phase 4-I 第二轮真人走查的 P0 缺陷就是"共用"造成的：
 *    改派复用了只含派工字段的载荷构造器 → 用户填的"改派原因"在出口被静默丢弃
 *    → 服务端回 422 MISSING_REASON（而 UI 上一切正常）。
 *    这个常量在镜像里同样要有，否则 smoke 发出的改派 body 与 UI 的不是同一个形状。
 */
export const REASSIGN_FORM_FIELDS = [...DISPATCH_FORM_FIELDS, 'reason'];

/**
 * 「预计上门日期」的规范化参数（与 `src/shared/service-mode.ts` 逐字一致）。
 *
 * 项目不采集签到/到达/GPS/排班时段，因此承诺不了"几点到"：
 * UI 只收日期，存储层把日期统一成**当日正午**（抗时区误读）。
 */
export const APPOINTMENT_CANONICAL_TIME = '12:00:00';
export const APPOINTMENT_TIMEZONE_OFFSET = '+08:00';

/** 把任意日期值折成 `YYYY-MM-DDT12:00:00+08:00`（镜像实现，逐字复刻 TS 侧） */
export function normalizeAppointmentDate(value) {
  if (value === undefined || value === null || value === '') return '';
  const text = String(value).trim();
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  let day = bare ? text : '';
  if (!day) {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    day = `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
  }
  return `${day}T${APPOINTMENT_CANONICAL_TIME}${APPOINTMENT_TIMEZONE_OFFSET}`;
}

/** 六个内部写动作都要求这个请求头 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** 命中幂等回放时服务端回写的响应头（body 仍与首次一致） */
export const IDEMPOTENCY_REPLAY_HEADER = 'X-Idempotent-Replay';

/** 内部写动作对应的六个幂等场景 */
export const INTERNAL_WRITE_SCENES = [
  'svc_accept',
  'svc_transfer',
  'svc_cancel',
  'svc_dispatch',
  'svc_reassign',
  'svc_reschedule',
];

/**
 * **与 UI 完全一致**的派工载荷构造器。
 *
 * 刻意复刻 `src/shared/service-mode.ts` 的 buildDispatchPayload()：
 *   · 只取 DISPATCH_FORM_FIELDS 里的字段（多余的键丢弃）；
 *   · trim；
 *   · 空值剔除（尤其是"门店自修"时那个空字符串的 provider_name ——
 *     服务端会把 "" 当成"填了名字"，与"没填"是两种语义）。
 *
 * 于是 smoke §4f 发出去的 body 与真人点"派工"发出去的 body 是同一个形状，
 * 而不是"测试自己编一份看起来合理的 JSON"。
 */
export function uiDispatchPayload(values) {
  return uiPayloadOf(DISPATCH_FORM_FIELDS, values);
}

/**
 * **与 UI 完全一致**的改派载荷构造器（派工字段 + reason）。
 *
 * ⚠️ 这里必须**独立一份**，不能写成 `uiDispatchPayload(values)` ——
 *    那正是 P0 缺陷的形状（reason 被白名单丢掉）。
 *    `verify-client-logic.mjs` 会断言它与 TS 侧 `buildReassignPayload` 逐字节一致。
 */
export function uiReassignPayload(values) {
  return uiPayloadOf(REASSIGN_FORM_FIELDS, values);
}

/** 与 UI 完全一致的改约载荷构造器 */
export function uiReschedulePayload(values) {
  return uiPayloadOf(RESCHEDULE_FORM_FIELDS, values);
}

/**
 * 按白名单挑字段 + trim + 丢空值 + **规范化预计上门日期**。
 *
 * ⚠️ 日期规范化必须在**出口**做（不依赖调用方自觉）：存储层为了满足
 *    datetime 字段会补一个固定时分，而那个时分不是真实承诺。
 *    让它只存在于"离开表单"之后，界面与事件文案就不可能误读它。
 */
function uiPayloadOf(fields, values) {
  const payload = {};
  for (const key of fields) {
    const raw = values?.[key];
    if (raw === undefined || raw === null) continue;
    const text = typeof raw === 'string' ? raw.trim() : raw;
    if (text === '') continue;
    payload[key] = text;
  }
  if (payload.expected_visit_at !== undefined) {
    payload.expected_visit_at = normalizeAppointmentDate(payload.expected_visit_at);
  }
  return payload;
}

/** 写请求必须带的请求头（value 由调用方给出合法 UUID v4） */
export function uiWriteHeaders(requestId) {
  return { [REQUEST_ID_HEADER]: requestId };
}
