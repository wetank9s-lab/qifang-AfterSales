/**
 * 设计 Token —— 样式侧的唯一入口（`styles/app.css`）。
 *
 * 为什么拆成两份文件（本文件 + `app.css`）：
 * ---------------------------------------------------------------------------
 * Tailwind 4 的 `@theme` 是**构建期指令**：它必须在 CSS 里，不能在 JS 里等待拼接。
 * 而运行时（TS 里需要算对比度、拼内联 style 的地方）又需要同一批值。
 *
 * 所以本文件与 `app.css` 的 `@theme` 段是**一一对应的两份**。
 * ⚠️ 改一处必须同时改另一处 —— 这是这组文件唯一的维护负担。
 *
 * ⚠️ 此处原写"验收脚本 `scripts/design-consistency.mjs` 会拿两边比对" ——
 *    **那个脚本从来没有存在过**（2026-11-14 核实）。这是一句写了两年的假承诺：
 *    注释描述了一道门，门却不在，于是"改一处忘另一处"始终没人拦。
 *    现在真实存在的是 `scripts/design-parity.mjs`：它确实会读本文件的
 *    `lightTokens` 与 h5 的 `:root` 逐项比对，并对状态色/圆角/深色模式下断言。
 *    （本文件与 app.css 的一致性目前靠人工同步 + `npm run build` 后的产物核查；
 *      若要把"两份必须相等"也变成门禁，应当**新建**断言而不是再改这句话。）
 *
 * a11y：为什么 Konsta 的 `--color-primary` 要用 hex 而不是 oklch
 * ---------------------------------------------------------------------------
 * Konsta 的 `plugin-colors.js` 拿 `--color-brand-primary` 去跑 **material-color-utilities**
 * 生成一整套 Material 调色板，那个库只认 `#RRGGBB`。
 * 填 oklch 会直接抛 `unexpected hex oklch(...)`，构建**当场失败**（这是好事，
 * 比静默生成一堆错误颜色强）。⇒ 品牌主色的**唯一事实来源写成 hex**，
 * oklch 只用于我们自己的语义色（Konsta 不读那些）。
 */

/** 品牌主色的 hex 形态 —— 喂给 Konsta 生成调色板，必须与 `app.css` 一致 */
/**
 * 经典 iOS 浅色设计 Token（2026-11-14 产品裁决）
 * =============================================================================
 *   · 视觉方向锁定 iOS 17/18 **经典浅色**；
 *   · **不做深色模式**、不提供切换 —— 无论系统设置如何，界面恒为浅色；
 *   · 禁止 Liquid Glass / 毛玻璃 / 折射 / 夸张模糊 / 发光阴影 / 浮动玻璃胶囊。
 *
 * ⚠️ 为什么主色从 `#1652c8` 换成 `#007AFF`：
 *   两端（员工端 src-mobile / 客户师傅端 h5）此前各有一套蓝，且
 *   `design-parity.mjs` 里曾有一条断言**要求两者必须不同** —— 那是把
 *   "门店装修可配置"的旧约束误当成了设计原则。本轮用户明确取消该判据：
 *   "门店品牌色可以用于门店标识，但不得成为两个前端布局和组件不一致的理由"。
 *   ⇒ 统一取 iOS 系统蓝 `#007AFF`，两端同值。
 */
export const BRAND_HEX = '#007AFF';

/** 浅色主题（语义 token）。键名 = `app.css` 里 `--color-svc-<键名>` */
export const lightTokens = {
  brand: '#007AFF',
  'brand-strong': '#0062CC',
  'brand-soft': '#EAF3FF',
  'brand-ink': '#ffffff',

  /** 正文：iOS `label`（浅色为纯黑）。层级靠字号与字重，不靠把字调灰。 */
  ink: '#000000',
  /**
   * 次要文字：iOS `secondaryLabel` 在浅色下约为 #8E8E93（白底 3.0:1），
   * **不达标**（小字需 ≥4.5:1）。本项目已验收的可读值优先：
   * 保留 #5F6670（白底 5.8:1），它是"看着像 iOS 次要灰、又真的看得清"的折中。
   */
  'ink-2': '#5F6670',
  /** 占位符/禁用：iOS `placeholderText`，不受正文对比度约束 */
  'ink-3': '#8E8E93',

  /** iOS `systemGroupedBackground` */
  bg: '#F2F2F7',
  /** iOS `secondarySystemGroupedBackground`（分组卡片） */
  surface: '#ffffff',
  /** 组内次级面（分段控件轨道、内嵌块） */
  'surface-2': '#F7F7FA',
  /** iOS `separator`（浅色 hairline） */
  line: '#E5E5EA',
  /** iOS `opaqueSeparator` */
  'line-strong': '#C6C6C8',

  /**
   * ⚠️ success / warning 两个**浅色**值在 2026-11-13（KONSTA-UI UX-FINAL 第一节）
   *    由 `#128f57` → `#0e7245`、`#b56a00` → `#915500`。
   *
   *    原因：状态徽标 = `bg-svc-X-soft` + `text-svc-X`，而徽标文字是 **11~12px 小字**
   *    （`font-medium`，未达 WCAG "大字号"门槛）⇒ 按 AA 正文 4.5:1 要求。
   *    实测原值在**自己的浅色底上**只有 3.76 / 3.84 —— 客户手机上根本读不清。
   *
   *    新值怎么来的（不是随手挑的）：
   *      · 在 HSL 空间**色相与饱和度完全保持**（153° / 35°），只降明度 7 个点
   *        ⇒ 仍是同一支绿、同一支橙，只是更沉稳（用户明令"不许改成黑/深灰"）；
   *      · 目标对比度定 **5:1 以上**（用户要求 ≥5，不要卡在 4.5 边缘），
   *        实测 5.45 / 5.52，白卡片上 5.98 / 5.99。
   *    求解与复核脚本：`scripts/design-parity.mjs`（含门禁断言，会守着这几个值）。
   *
   *    ⚠️ 深色模式（`darkTokens`）**不动**：它已是 `#4fd18b` / `#f0b357`，
   *       在深色底上 7.95 / 8.42 —— 本就是达标的。深浅两套独立取值才对，
   *       把浅色改深的同时若"顺手同步"深色，反而会让深色下的文字变刺眼或变暗。
   */
  success: '#0e7245',
  'success-soft': '#e9f8f0',
  warning: '#915500',
  'warning-soft': '#fff4e5',
  /**
   * ⚠️ danger 也在 2026-11-13 由 `#d0342c` → `#b62d26`。
   *
   *    为什么"用户只点了两个色"却动了第三个（必须摊开讲，不是偷偷扩范围）：
   *      `design-parity.mjs` 门禁把**同一批状态色**放进**同一门槛**，
   *      结果它红了 —— `#d0342c` 在**自己的软底** `#fdecea` 上只有 **4.36:1，
   *      连 AA 4.5 的底线都不达**（白卡片上 4.99 也只是勉强压线）。
   *      而这不是理论风险：`Login.tsx:84` 就是
   *      `bg-svc-danger-soft + text-svc-danger + 13px` 的真实满软底用法，
   *      h5 侧也有 `.svc-error` / `.rv-state-mark` 这类「软底 + 状态色文字」。
   *
   *    定性：属用户第 ⑥ 条授权的"**必要的文字可读性问题**"，
   *      且是**一个色值**的修正 —— 不动结构、不动布局、不加组件。
   *      不修它，第 ④ 条"统一走 Token、统一标准"就是假的：
   *      同批色里两个达 5:1、一个连 4.5 都不达，那不叫统一。
   *
   *    值与 success/warning **同一套解法**：色相 2.9°（差 0.01°）、饱和度 65%
   *      分毫未动，只降明度 49%→43% ⇒ 仍是同一支红，不是黑/灰（用户第 ② 条）。
   *      软底 5.41:1、白卡片 6.19:1 —— 与另两色（5.45/5.52）余量一致。
   *    求解脚本：`scripts/design-token-solve.mjs`；门禁：`scripts/design-parity.mjs`。
   */
  danger: '#b62d26',
  'danger-soft': '#fdecea',
  info: '#1668b8',
  'info-soft': '#eaf4fe',
  neutral: '#6b7280',
  'neutral-soft': '#eef0f4',
} as const;

/**
 * 深色主题 —— **已移除**（2026-11-14 产品裁决）
 * =============================================================================
 *   用户明确："不再开发深色模式，不提供浅色/深色切换。无论手机系统设置如何，
 *   业务界面保持统一浅色。"
 *
 *   ⇒ 这里保留一段说明而不是留一个"暂时不用的 darkTokens"：
 *     留着的代价是下一个人看到 `darkTokens` 就以为系统仍支持深色，
 *     然后去修一个**产品上不存在**的场景。（本项目铁律：宁可知道没有，
 *     也不要以为有。）
 *
 *   ⚠️ 若要恢复深色，必须同时处理三处，缺一处就会出现"半深半浅"：
 *     ① 本文件的深色色值；② `app.css` 的 `.dark` 变量覆盖；
 *     ③ `AppShell` 的 `<App dark>` 与 `<html class="dark">`。
 */

/**
 * 尺寸与动效 —— 经典 iOS 档位。
 *
 * ⚠️ `touch` = 44px 是 iOS HIG 的**下限**，不是"看着舒服"的取值；
 *    主操作按钮按用户裁决取 50–52（iOS 标准按钮高度 50pt）。
 *
 * ⚠️ 圆角全部收敛到三档，禁止页面自行决定：
 *    8（小控件/chip）· 10（按钮/输入框/卡片）· 14（弹层/大面）
 */
export const metrics = {
  touch: '44px',
  /** 标准按钮高度（iOS 50pt） */
  control: '50px',
  /** 主 CTA 高度 */
  touchLg: '52px',
  radiusSm: '8px',
  radius: '10px',
  radiusLg: '14px',
  navHeight: '44px',
  tabHeight: '50px',
  /** 页面水平边距（用户裁决 16px） */
  pageX: '16px',
  easeIos: 'cubic-bezier(0.32, 0.72, 0, 1)',
  pressMs: '110ms',
} as const;

/**
 * 间距刻度 —— 只允许 4 / 8 / 12 / 16 / 24 五档。
 * 页面里出现这五个以外的 padding/margin，就是"随手写的"漂移。
 */
export const space = {
  s1: '4px',
  s2: '8px',
  s3: '12px',
  s4: '16px',
  s6: '24px',
} as const;

/**
 * 文字层级 —— 对齐 iOS 默认 Dynamic Type（Large）。
 * Body 17 / Subheadline 15 / Footnote 13；辅助文字不低于 14。
 */
export const type = {
  title1: '28px',
  title2: '22px',
  title3: '20px',
  headline: '17px',
  body: '17px',
  callout: '16px',
  subhead: '15px',
  footnote: '14px',
  caption: '13px',
} as const;

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand';

/**
 * tone → 类名。
 *
 * 用**字面量映射**而不是 `bg-svc-${tone}-soft` 拼字符串：
 * Tailwind 4 是静态扫描，拼出来的类名它看不见 ⇒ 生成不了 ⇒ 界面无背景色，
 * 而且构建**零报错**。这类 bug 在桌面模拟里很容易被当成"设计就是这样"。
 *
 * ⚠️ 原写"`design-consistency.mjs` 会扫描本文件确认每个 tone 都有完整类名" ——
 *    该脚本**不存在**（2026-11-14 核实）。真实的判据在
 *    `scripts/design-parity.mjs`：它比对两端 Token 值，不扫类名完整性。
 *    ⇒ 也就是说"tone 少写一个类名"目前**没有门禁**，只会在界面上表现为缺色。
 *      这里如实记录，不假装有门（宁可知道没门，也不要以为有门）。
 */
export const TONE_CLASS: Record<Tone, { bg: string; text: string; border: string; dot: string }> = {
  success: {
    bg: 'bg-svc-success-soft',
    text: 'text-svc-success',
    border: 'border-svc-success',
    dot: 'bg-svc-success',
  },
  warning: {
    bg: 'bg-svc-warning-soft',
    text: 'text-svc-warning',
    border: 'border-svc-warning',
    dot: 'bg-svc-warning',
  },
  danger: {
    bg: 'bg-svc-danger-soft',
    text: 'text-svc-danger',
    border: 'border-svc-danger',
    dot: 'bg-svc-danger',
  },
  info: {
    bg: 'bg-svc-info-soft',
    text: 'text-svc-info',
    border: 'border-svc-info',
    dot: 'bg-svc-info',
  },
  neutral: {
    bg: 'bg-svc-neutral-soft',
    text: 'text-svc-neutral',
    border: 'border-svc-neutral',
    dot: 'bg-svc-neutral',
  },
  brand: {
    bg: 'bg-svc-brand-soft',
    text: 'text-svc-brand',
    border: 'border-svc-brand',
    dot: 'bg-svc-brand',
  },
};

/**
 * 业务语义映射 —— **只做展示层翻译，不改变任何后端状态值**。
 *
 * ⚠️ 未知值必须**原样显示**（`metaOf` 的兜底），不能显示"未知"：
 *    一个后端新增的 `REOPENED` 显示成 `REOPENED` 至少能被搜到、被报告；
 *    显示成"未知"就彻底丢了信息，而且界面看起来"很干净"，没人会报这个 bug。
 */

/** 工单状态 */
export const TICKET_STATUS_META: Record<string, { label: string; tone: Tone; order: number }> = {
  // ⚠️ 大小写**都要有**：生产库同时存在 `new`(4 条) 与 `NEW`(243 条)，是历史导入留下的
  NEW: { label: '待受理', tone: 'warning', order: 1 },
  new: { label: '待受理', tone: 'warning', order: 1 },
  PROCESSING: { label: '处理中', tone: 'info', order: 2 },
  WAIT_STORE_CONFIRM: { label: '待门店确认', tone: 'warning', order: 3 },
  WAIT_FEEDBACK: { label: '待客户评价', tone: 'info', order: 4 },
  CLOSED: { label: '已闭环', tone: 'success', order: 5 },
  CANCELLED: { label: '已取消', tone: 'neutral', order: 6 },
};

/** 档案生命周期状态 */
export const ARCHIVE_STATUS_META: Record<string, { label: string; tone: Tone }> = {
  pending: { label: '待开始', tone: 'neutral' },
  serving: { label: '服务中', tone: 'info' },
  completed: { label: '已完成', tone: 'success' },
  accepted: { label: '已验收', tone: 'success' },
  voided: { label: '已作废', tone: 'danger' },
};

/** 档案可见性（客户能不能看到，取决于它） */
export const ARCHIVE_VISIBILITY_META: Record<string, { label: string; tone: Tone }> = {
  draft: { label: '草稿', tone: 'neutral' },
  published: { label: '已发布', tone: 'success' },
  voided: { label: '已作废', tone: 'danger' },
};

/** 暖通六阶段。顺序即 `stage_order`，**不可重排** */
export const HVAC_STAGE_META: Record<string, { label: string; short: string }> = {
  survey: { label: '勘察', short: '勘察' },
  plan: { label: '方案', short: '方案' },
  pipe: { label: '管道施工', short: '管道' },
  device: { label: '设备安装', short: '设备' },
  test: { label: '调试检测', short: '调试' },
  accept: { label: '竣工验收', short: '验收' },
};

/** 暖通阶段的固定顺序（与服务端 `ARCHIVE_STAGE_ORDER` 一致） */
export const HVAC_STAGE_ORDER = ['survey', 'plan', 'pipe', 'device', 'test', 'accept'] as const;

/** 档案类型 */
export const ARCHIVE_TYPE_META: Record<string, { label: string; short: string }> = {
  service: { label: '上门服务', short: '上门服务' },
  hvac: { label: '暖通工程', short: '暖通工程' },
};

/**
 * 上门服务类型（`service_type`）。
 * 值来自服务端 `ARCHIVE_SERVICE_TYPE`，**暖通不填这个字段**。
 */
export const SERVICE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'delivery', label: '送货安装' },
  { value: 'install', label: '安装调试' },
  { value: 'repair', label: '维修检测' },
  { value: 'clean', label: '清洗保养' },
  { value: 'guide', label: '使用指导' },
  { value: 'other', label: '其他' },
];

/**
 * 工单类型（服务端 `ticket_type` 的业务面，仅做中文展示）。
 * 注意：匿名客户面只允许 repair / complaint 两类，内部还有其他分类 —— 本表不含约束语义。
 */
/**
 * 家电品类 —— 用户可见名称。
 *
 * 🔴 2026-11-14：此前卡片直接渲染数据库枚举（实测界面上出现过 air_conditioner）。
 *   用户明令禁止向用户展示数据模型里的词。
 *
 * ⚠️ 未知值**不渲染**（返回 undefined），而不是原样打印代码 ——
 *    宁可少一行信息，也不要让店员看到 appliance_x9 这种字符串。
 */
export const APPLIANCE_LABEL: Record<string, string> = {
  air_conditioner: '空调',
  washer: '洗衣机',
  refrigerator: '冰箱',
  tv: '电视',
  water_heater: '热水器',
  range_hood: '油烟机',
  gas_stove: '燃气灶',
  dryer: '干衣机',
  other: '其他',
};

/** 品类代码 → 中文名；未知返回 undefined（调用方据此不渲染） */
export function applianceLabel(code: string | null | undefined): string | undefined {
  const k = String(code ?? '').trim();
  return k ? APPLIANCE_LABEL[k] : undefined;
}
export const TICKET_TYPE_META: Record<string, string> = {
  repair: '报修',
  complaint: '投诉',
  install: '安装',
  maintenance: '保养',
  consult: '咨询',
  other: '其他',
};

/**
 * 短信场景（`sms_logs.scene`）的中文展示名。
 *
 * ⚠️ 为什么前端也要有一份（服务端 `SMS_SCENE_LABEL` 已有一份）：
 *    工单详情 DTO 的 `sms[].scene` 是**原始代码值**（`technician_task` 这种），
 *    DTO 里没有 label 字段。前端不翻译就只能把 `technician_task` 直接印在屏幕上 ——
 *    用户第三节明确禁止"界面直接展示代码枚举"。
 *    ⇒ 这份表是**展示层翻译**，不改任何后端值（`docs/API.md` 契约不动）。
 *
 * ⚠️ 取值必须与服务端 `constants.ts: SMS_SCENE_LABEL` **逐字一致**：
 *    两处漂移的后果是同一个场景在后台与移动端显示两个名字，
 *    而验收时几乎撞不到（分属两个界面）。
 *    已核对 8 个真实取值（`select distinct scene from sms_logs` 实测得到）。
 */
export const SMS_SCENE_LABEL: Record<string, string> = {
  dispatch_customer: '派工通知（客户）',
  technician_task: '师傅任务通知',
  technician_assignment_cancelled: '改派取消通知',
  dispatch_update: '改约通知',
  review_invite: '评价邀请',
  manual_resend: '人工重发',
  progress_link: '客户报修成功通知',
  progress_update: '客户处理进展通知',
  archive_verify: '档案查询验证码',
};

/**
 * 短信发送状态（`sms_logs.send_status`）的中文展示名。
 *
 * 🔴 这是本轮修的一个**真实显示缺陷**（2026-11-14）：
 *    移动端原写法是 `send_status === 'sent' ? '已发送' : send_status === 'pending' ? '排队中' : s.send_status`。
 *    但服务端 `SMS_SEND_STATUS` 的取值是 `pending | accepted | rejected | error` ——
 *    **根本没有 `sent` 这个值**（实测库里 958 条全是 `accepted`(497) / `rejected`(461)）。
 *    ⇒ 两个已知分支永远命中不了，全部落到最后的 `?? '—'` 兜底，
 *      员工在"通知记录"里看到的是 **`accepted` / `rejected` 这种英文码**。
 *    （同族教训：判据/分支落到一个**不存在的取值**上，它不会报错，只会永远走兜底。）
 *
 * ⚠️ 特别注意 `accepted` 的含义：它只表示"服务商已受理"，**不等于送达**
 *    （送达由 `delivery_status` 表达，本项目当前通道无回执接口）。
 *    所以这里译成「服务商已受理」而不是「已发送」——
 *    把 accepted 说成"已发送"，会让"客户说没收到"的投诉永远查不出来。
 *    文案与服务端 `page-logic.ts: smsSendStatusText` 保持一致。
 */
export const SMS_SEND_STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  accepted: '服务商已受理',
  rejected: '未发送',
  error: '提交失败',
};

/**
 * 通用兜底：未知值显示原值
 */
export function metaOf<T extends { label: string }>(
  table: Record<string, T>,
  raw: unknown,
  fallbackTone: Tone = 'neutral',
): { label: string; tone: Tone } {
  const key = String(raw ?? '');
  const hit = table[key];
  if (hit) {
    return { label: hit.label, tone: ('tone' in hit ? (hit as any).tone : fallbackTone) as Tone };
  }
  return { label: key || '—', tone: fallbackTone };
}

/**
 * 代码值 → 中文展示名（短信场景 / 发送状态用）。
 *
 * ⚠️ 与 `metaOf` 的区别：这里**没有 tone**，因为它服务的是纯文本位置（列表行尾）。
 * ⚠️ 未知值**原样返回**（不返回"未知"）：后端新增一个场景时，
 *    页面显示 `new_scene_code` 至少能被看见、被报告；
 *    显示成"未知"就彻底丢了信息，而且界面看起来"很干净"，没人会报这个 bug。
 */
export function labelOf(table: Record<string, string>, raw: unknown): string {
  const key = String(raw ?? '');
  return table[key] ?? key;
}
