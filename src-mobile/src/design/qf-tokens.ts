/**
 * R2.2.1 · 经典 iOS 浅色设计体系 —— **Token 唯一事实来源**
 * =============================================================================
 * 用户原话（第十七节）：
 *   "所有页面必须复用 Token，**不得每页自行决定字号、边距、圆角、按钮尺寸**。
 *    小字必须可读，不能用过浅灰色。"
 *
 * 本文件与 `src/styles/app.css` 的 `@theme` 段是**一一对应的两份**：
 *   · 这里给运行时（TS 里要拼内联 style、要算对比度、要给测试断言取值）；
 *   · 那边给构建期（Tailwind 4 的 `@theme` 是编译期指令，不能从 JS 拼出来）。
 *
 * ⚠️ 改一处必须同时改另一处。目前这件事靠人工同步 —— 我们**不假装有门禁**。
 *    真实的门禁在 `scripts/design-parity.mjs`（跨端同源 + 状态色对比度 + 无深色），
 *    以及本轮新增的 `scripts/qf-design-gate.mjs`（字号集合 / 圆角集合 / 触控下限）。
 *
 * =============================================================================
 * 相对 `tokens.ts` 的**三处取值变更**（每条都是实测得出的，不是审美）
 * =============================================================================
 *
 * ① `ink-3` 由 `#8E8E93` → `#6E6E73`，并**拆出** `placeholder`（仍是 #8E8E93）
 *
 *    为什么拆：`tokens.ts` 旧注释写着「iOS placeholderText，不受正文对比度约束」——
 *    这句话**是错的**。实测 `#8E8E93` 在白底 3.26:1、`#F2F2F7` 上 2.92:1，
 *    而它在本项目里承担的是**真实文字**（档案编号、时间、"共 N 条"、"已经到底了"），
 *    不是占位符。WCAG AA 对 <17pt 文字要求 4.5:1（`accessibility.md › Vision`）。
 *
 *    新值实测（`#6E6E73`）：白 5.07 / `#F2F2F7` 4.54 / `#F7F7FA` 4.74 / `#EAF3FF` 4.53
 *    ⇒ 四种真实底色**全部达标**。它仍是"看着像 iOS 次要灰"的同一支灰，
 *      只是不再浅到读不清。
 *
 *    `placeholder` 单独保留 `#8E8E93`：占位符是"还没填"的空位提示，
 *    它的可读性需求与正文不同，且**不能**与已填内容抢注意力。
 *    ⚠️ 但即使如此，本项目的输入框一律**标签 + 占位符并用**
 *      （`text-fields.md › Best practices`：标签说明"这是什么"，占位符给"格式示例"），
 *      所以占位符永远不会是唯一的信息来源。
 *
 * ② 新增 `brand-text = #0062CC`（`brand` 仍是 `#007AFF`，**不改系统蓝本身**）
 *
 *    `#007AFF` 作为**填充底色**（白字压在上面）是达标的：
 *    按钮文字是 17px Semibold（Large 档 Bold）⇒ 门槛 3:1，实测 4.02:1 ✅
 *    （`accessibility.md` 对比度表第三行 "All / Bold / 3:1"）。
 *
 *    但作为**文字**（13–15px 的「清空」「看照片」「查看全部」）就**不达标**：
 *    白 4.02 / `#F2F2F7` 3.60 / `#EAF3FF` 3.59，全部 <4.5。
 *
 *    ⇒ 分离两种用途，各自达标：
 *      `brand`      #007AFF  填充底 / 图标 / 进度条 / 焦点环（**非文字**）
 *      `brand-text` #0062CC  可点文字（白 5.80 / 灰 5.20 / 软底 5.18，全达标）
 *    两者视觉上是同一支蓝，`#0062CC` 只是深一档 —— 用户看到的是"同一个品牌色"。
 *
 * ③ 新增 `neutral = #63636B`（原 `#6b7280` 在自己的软底 `#E9E9EB` 上只有 3.99:1）
 *
 *    `neutral` 用于"无状态/已取消"徽标与空态图标。`#6b7280` 在 `#E9E9EB` 上不达标。
 *    新值 `#63636B`：软底 4.91 / 白 5.95 / `#F2F2F7` 5.33。
 *    ⚠️ 它刻意与 `ink-2`(#5F6670) **区分**：ink-2 是带蓝的冷灰（次要正文），
 *      neutral 是纯中性灰（状态语义），两者在同一张卡片里可能相邻出现。
 *
 * =============================================================================
 * 字号：从「10 档散落 108 处」收敛为 **6 档**
 * =============================================================================
 * 旧实测：13×32 / 12×29 / 11×23 / 15×11 / 14×5 / 16×3 / 17×2 / 10×2 / 9×1 / 28×1
 *   · `14px` 不在 iOS Dynamic Type 表里（13 与 15 之间挤进一个 14 ⇒ 层级模糊）
 *   · `9px` / `10px` 低于 `typography.md › Ensuring legibility` 的最小 11pt
 *   · 辅助文字大量是 11–12px，违反用户规范「辅助文字 14px 左右」
 *
 * 新集合（每个都能在 `typography.md › iOS Dynamic Type sizes › Large` 里找到）：
 *   display 28 = Title1 · title 20 = Title3 · body 17 = Body
 *   sub 15 = Subhead · foot 13 = Footnote · caption 12 = Caption1
 *
 * ⚠️ 这会让现有界面**整体变大**（11→12、12→13、13→15 为主）。
 *    390px 下是否溢出必须**实测**，不能靠推断 —— 见 `scripts/r221-visual-verify.mjs`。
 *
 * ⚠️ 允许集合是**封闭的**：`{12,13,15,17,20,28}`。
 *    新增一档必须先证明它对应 Dynamic Type 的某一档，否则就是审美漂移。
 */

/* ------------------------------------------------------------------ 颜色 */

/**
 * 品牌主色 hex 形态 —— 喂给 Konsta 生成调色板。
 * ⚠️ 必须是 `#RRGGBB`：Konsta 的 `plugin-colors.js` 用 material-color-utilities
 *    解析它，填 oklch 会让构建直接抛 `unexpected hex`（这是好事，比静默错色强）。
 */
export const BRAND_HEX = '#007AFF';

export const lightTokens = {
  brand: '#007AFF',
  /** 可点文字专用（含按压态）—— 见文件头 ② */
  'brand-text': '#0062CC',
  'brand-strong': '#0062CC',
  'brand-soft': '#EAF3FF',
  'brand-ink': '#ffffff',

  ink: '#000000',
  'ink-2': '#5F6670',
  /** 三级文字（真实信息，不是占位符）—— 见文件头 ① */
  'ink-3': '#6E6E73',
  /** 占位符 / 禁用态专用。**不得**用于任何真实业务文字 */
  placeholder: '#8E8E93',

  bg: '#F2F2F7',
  surface: '#ffffff',
  'surface-2': '#F7F7FA',
  line: '#E5E5EA',
  'line-strong': '#C6C6C8',

  success: '#0e7245',
  'success-soft': '#e9f8f0',
  warning: '#915500',
  'warning-soft': '#fff4e5',
  danger: '#b62d26',
  'danger-soft': '#fdecea',
  info: '#1668b8',
  'info-soft': '#eaf4fe',
  neutral: '#63636B',
  'neutral-soft': '#E9E9EB',
} as const;

export type ColorToken = keyof typeof lightTokens;

/**
 * 每个文字色**允许出现在哪些底色上**。
 *
 * ⚠️ 这不是文档，是 `scripts/qf-design-gate.mjs` 真正会读的判据表。
 *    它存在的理由：对比度不是一个孤立属性（"#6E6E73 是 4.54:1"这种说法没有意义），
 *    必须"前景 + 底色"成对才成立。把允许的组合写死，才能让"把 ink-3 用在深色块上"
 *    这类组合在门禁里直接变红，而不是等截图时才发现。
 *
 * 门槛来源：`accessibility.md › Vision`
 *   ≤17pt 全字重 → 4.5:1；≥18pt 或 Bold → 3:1
 * 本表一律按 **4.5** 收（保守），唯一例外在 `LARGE_TEXT_EXEMPT`。
 */
export const CONTRAST_PAIRS: { fg: ColorToken; bg: ColorToken; min: number }[] = [
  { fg: 'ink', bg: 'surface', min: 4.5 },
  { fg: 'ink', bg: 'bg', min: 4.5 },
  { fg: 'ink-2', bg: 'surface', min: 4.5 },
  { fg: 'ink-2', bg: 'bg', min: 4.5 },
  { fg: 'ink-2', bg: 'surface-2', min: 4.5 },
  { fg: 'ink-3', bg: 'surface', min: 4.5 },
  { fg: 'ink-3', bg: 'bg', min: 4.5 },
  { fg: 'ink-3', bg: 'surface-2', min: 4.5 },
  { fg: 'brand-text', bg: 'surface', min: 4.5 },
  { fg: 'brand-text', bg: 'bg', min: 4.5 },
  { fg: 'brand-text', bg: 'brand-soft', min: 4.5 },
  { fg: 'success', bg: 'success-soft', min: 4.5 },
  { fg: 'warning', bg: 'warning-soft', min: 4.5 },
  { fg: 'danger', bg: 'danger-soft', min: 4.5 },
  { fg: 'info', bg: 'info-soft', min: 4.5 },
  { fg: 'neutral', bg: 'neutral-soft', min: 4.5 },
  { fg: 'success', bg: 'surface', min: 4.5 },
  { fg: 'warning', bg: 'surface', min: 4.5 },
  { fg: 'danger', bg: 'surface', min: 4.5 },
];

/**
 * 允许 3:1 的特殊组合（**只允许这几条**）。
 *
 * `brand-ink`(白) on `brand`(#007AFF) = 4.02:1。
 * 它成立的前提是：**填充按钮上的文字必须是 17px Semibold**（Large 档 Bold）。
 * 若哪天有人把按钮文字改成 15px Regular，这条豁免就不成立了 ——
 * 所以这里写清楚前提，而不是含糊地说"主按钮例外"。
 */
export const LARGE_TEXT_EXEMPT: { fg: ColorToken; bg: ColorToken; min: number; 前提: string }[] = [
  { fg: 'brand-ink', bg: 'brand', min: 3.0, 前提: '按钮文字 17px Semibold（body + font-semibold）' },
];

/* ------------------------------------------------------------------ 字号 */

/**
 * 6 档字号。**封闭集合** —— 见文件头。
 * 值单位 px（`text-[17px]` 这种写法会被门禁拦下，统一走 `text-qf-body`）。
 */
export const TYPE_SCALE = {
  display: 28,
  title: 20,
  body: 17,
  sub: 15,
  foot: 13,
  caption: 12,
} as const;

export type TypeStep = keyof typeof TYPE_SCALE;

/** 允许出现在 `text-[Npx]` 里的数值集合（门禁读它） */
export const ALLOWED_PX = new Set<number>(Object.values(TYPE_SCALE));

/**
 * 每档对应的行高倍数。
 *
 * 来源：`typography.md › iOS Dynamic Type sizes › Large`
 *   Title1 28/34 → 1.214 · Title3 20/25 → 1.25 · Body 17/22 → 1.294
 *   Subhead 15/20 → 1.333 · Footnote 13/18 → 1.385 · Caption1 12/16 → 1.333
 * 取**整数像素行高**而不是倍数，避免浏览器四舍五入后两档之间差 1px 却看不出。
 */
export const LEADING_PX = {
  display: 34,
  title: 25,
  body: 22,
  sub: 20,
  foot: 18,
  caption: 16,
} as const;

/* ------------------------------------------------------------------ 尺寸 */

/**
 * 尺寸与动效。
 *
 * ⚠️ `touch = 44px` 是 iOS HIG 的**下限**（`accessibility.md › Mobility`：
 *    "Controls … 44x44 pt"），不是"看着舒服"的取值。
 *    低于它在真机上必然误触 —— 师傅戴手套、单手、走路时更明显。
 */
export const metrics = {
  /** 最小有效触控区 */
  touch: 44,
  /** 标准控件高度（输入框 48–50） */
  control: 50,
  /** 主 CTA 高度 */
  cta: 52,
  /** 导航栏内容高度 */
  nav: 44,
  /** 底部 Tab 内容高度 */
  tab: 50,
  /** 页面水平边距 */
  pageX: 16,
  /** 表单行内水平内边距 */
  rowX: 12,
  easeIos: 'cubic-bezier(0.32, 0.72, 0, 1)',
  pressMs: 110,
} as const;

/**
 * 圆角刻度：`8 / 10 / 12 / 14`。
 *
 * ⚠️ iOS 的"连续圆角"（squircle）在 CSS 里表达不了 —— `border-radius` 是**圆弧**。
 *    本项目的处理办法是：**刻度内取值 + 同族元素用同一档**，
 *    让视觉半径在整个界面里可预期，而不是追求逐像素的 squircle。
 *
 * `inset` 是**同族嵌套**用的：内层 = 外层 − 内边距。
 *   例：segmented 轨道 10px + padding 3px ⇒ 内层滑块 7px。
 *   （`toolbars.md › Best practices`："ensure that its corner radius is also
 *     concentric with the bar's corners"）
 *   ⇒ 原先 `ServiceSearch.tsx` 裸写 `rounded-[7px]`，算法是对的、缺的是命名。
 *     写进 token 后，任何新的嵌套控件都能算出正确值而不用猜。
 */
export const radius = {
  sm: 8,
  md: 10,
  lg: 12,
  xl: 14,
  /** 同族嵌套缩进量（外层半径 − 内边距 = 内层半径） */
  inset: 3,
  /** 只允许出现在状态徽标上（tag/badge 在 iOS 里就是胶囊） */
  pill: 9999,
} as const;

/** 间距刻度：只允许 4 / 8 / 12 / 16 / 24 */
export const space = [4, 8, 12, 16, 24] as const;

/* -------------------------------------------------------------- 映射表 */

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand';

/**
 * tone → 类名。
 *
 * ⚠️ 用**字面量映射**而不是 `bg-svc-${tone}-soft` 拼字符串：
 *    Tailwind 4 是静态扫描，拼出来的类名它看不见 ⇒ 生成不了 ⇒ 界面无背景色，
 *    而且构建**零报错**。这类 bug 在桌面模拟里很容易被当成"设计就是这样"。
 */
export const TONE_CLASS: Record<Tone, { bg: string; text: string; border: string; dot: string; solid: string }> = {
  success: {
    bg: 'bg-svc-success-soft',
    text: 'text-svc-success',
    border: 'border-svc-success',
    dot: 'bg-svc-success',
    solid: 'bg-svc-success',
  },
  warning: {
    bg: 'bg-svc-warning-soft',
    text: 'text-svc-warning',
    border: 'border-svc-warning',
    dot: 'bg-svc-warning',
    solid: 'bg-svc-warning',
  },
  danger: {
    bg: 'bg-svc-danger-soft',
    text: 'text-svc-danger',
    border: 'border-svc-danger',
    dot: 'bg-svc-danger',
    solid: 'bg-svc-danger',
  },
  info: {
    bg: 'bg-svc-info-soft',
    text: 'text-svc-info',
    border: 'border-svc-info',
    dot: 'bg-svc-info',
    solid: 'bg-svc-info',
  },
  neutral: {
    bg: 'bg-svc-neutral-soft',
    text: 'text-svc-neutral',
    border: 'border-svc-neutral',
    dot: 'bg-svc-neutral',
    solid: 'bg-svc-neutral',
  },
  brand: {
    bg: 'bg-svc-brand-soft',
    /** ⚠️ 文字用 brand-text（可读），填充用 brand */
    text: 'text-svc-brand-text',
    border: 'border-svc-brand',
    dot: 'bg-svc-brand',
    solid: 'bg-svc-brand',
  },
};

/* ------------------------------------------------ 业务语义（展示层翻译） */

/**
 * 业务语义映射 —— **只做展示层翻译，不改变任何后端状态值**。
 *
 * ⚠️ 未知值必须**原样显示**（`metaOf` 兜底），不能显示"未知"：
 *    后端新增一个 `REOPENED` 显示成 `REOPENED` 至少能被搜到、被报告；
 *    显示成"未知"就彻底丢了信息，而且界面看起来"很干净"，没人会报这个 bug。
 */

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

export const ARCHIVE_STATUS_META: Record<string, { label: string; tone: Tone }> = {
  pending: { label: '待开始', tone: 'neutral' },
  serving: { label: '服务中', tone: 'info' },
  completed: { label: '已完成', tone: 'success' },
  accepted: { label: '已验收', tone: 'success' },
  voided: { label: '已作废', tone: 'danger' },
};

/**
 * 档案可见性。
 *
 * ⚠️ R2.2.1 起 `visibility` **不再是用户可见的概念**（保存即发布 ⇒ 新建档案恒为
 *    `published`）。用户第 7.1 条明令："不显示草稿筛选、已发布筛选、草稿标签、已发布标签"。
 *
 *    本表仍然保留，用途只剩两个：
 *      ① 存量草稿（生产实测 id=26）在详情页需要一个准确的说明；
 *      ② 作废（voided）必须显示 —— 它是"客户看不到这条了"的真实业务状态。
 *    ⇒ **列表卡片不再渲染 visibility 徽标**（见 `QFServiceCard`）。
 */
export const ARCHIVE_VISIBILITY_META: Record<string, { label: string; tone: Tone }> = {
  draft: { label: '草稿', tone: 'neutral' },
  published: { label: '已发布', tone: 'success' },
  voided: { label: '已作废', tone: 'danger' },
};

/**
 * 暖通六阶段。顺序即 `stage_order`，**不可重排**（与服务端 `ARCHIVE_STAGE_ORDER` 一致）。
 *
 * `short` 是进度条上的 2–4 字缩写。R2.2.1 统一为 **4 字以内**并提到 12px ——
 * 旧版是 `text-[10px]` 的 `勘察/方案/管道/设备/调试/验收`，低于 11px 下限。
 */
export const HVAC_STAGE_META: Record<string, { label: string; short: string; hint: string }> = {
  survey: { label: '现场勘察', short: '勘察', hint: '上门查看现场，确定施工条件' },
  plan: { label: '方案确认', short: '方案', hint: '确认设备型号、管路走向与报价' },
  pipe: { label: '管路施工', short: '管路', hint: '开槽、布管、保压测试' },
  device: { label: '设备安装', short: '设备', hint: '室内外机就位、连接、固定' },
  test: { label: '调试运行', short: '调试', hint: '抽真空、加注冷媒、试运行' },
  accept: { label: '客户验收', short: '验收', hint: '客户现场确认并签字' },
};

export const HVAC_STAGE_ORDER = ['survey', 'plan', 'pipe', 'device', 'test', 'accept'] as const;

/**
 * 阶段图标（`/public/qf-stage-*.svg`，R2.2.1 §六 设计素材）。
 *
 * ⚠️ 图标**只有图形、没有文字** —— 设计包 README 写明「六阶段 SVG 不内嵌固定的
 *    阶段标题，标题和说明必须由后台配置动态渲染」。
 *    所以这里 `HVAC_STAGE_META.label` 只是**代码默认值**，真实名称一律来自
 *    `svc:archiveStageConfigGet`；图标按 `stage_code` 取，不随显示名变化。
 */
export const HVAC_STAGE_ICON: Record<string, string> = {
  survey: 'qf-stage-survey.svg',
  plan: 'qf-stage-plan.svg',
  pipe: 'qf-stage-pipe.svg',
  device: 'qf-stage-device.svg',
  test: 'qf-stage-test.svg',
  accept: 'qf-stage-accept.svg',
};

/**
 * 暖通提示区两个插画（`/public/`）。**同样不含任何阶段名称文字。**
 * `intro` 72×72 空调图标；`flow` 360×60 六圆点虚线流程。
 */
export const HVAC_INTRO_ART = '/qf-hvac-intro.svg';
export const HVAC_FLOW_ART = '/qf-hvac-six-stages.svg';

/**
 * 阶段显示配置（`svc:archiveStageConfigGet` 的响应形状）。
 *
 * ⚠️ `code` / `order` 是**契约**（来自服务端 `ARCHIVE_STAGE_ORDER`），
 *    只有 `name` / `description` 可改。前端永远按 `order` 排序渲染，
 *    不按数组下标 —— 数组顺序是传输细节，不是业务事实。
 */
export interface HvacStageConfig {
  code: string;
  order: number;
  name: string;
  description: string;
}

/** 必须上传照片才能完成的阶段（与服务端 `ARCHIVE_STAGE_PHOTO_REQUIRED` 一致） */
export const HVAC_STAGE_PHOTO_REQUIRED: readonly string[] = ['survey', 'pipe', 'device', 'accept'];

/** 每阶段照片上限（与服务端 `ARCHIVE_STAGE_PHOTO_MAX` 一致） */
export const HVAC_STAGE_PHOTO_MAX = 6;

export const ARCHIVE_TYPE_META: Record<string, { label: string; short: string; desc: string }> = {
  service: { label: '上门服务', short: '上门服务', desc: '送货安装、维修检测、清洗保养等单次上门' },
  hvac: { label: '暖通工程', short: '暖通工程', desc: '中央空调、地暖等分阶段施工的工程' },
};

/** 上门服务内容（`service_type`）。值来自服务端 `ARCHIVE_SERVICE_TYPE`，暖通**不用**这个字段 */
export const SERVICE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'delivery', label: '送货安装' },
  { value: 'install', label: '安装调试' },
  { value: 'repair', label: '维修检测' },
  { value: 'clean', label: '清洗保养' },
  { value: 'guide', label: '使用指导' },
  { value: 'other', label: '其他' },
];

/** 服务内容代码 → 中文（详情页/卡片用；未知**原样返回**） */
export function serviceTypeLabel(v: string | null | undefined): string {
  const k = String(v ?? '').trim();
  if (!k) return '';
  return SERVICE_TYPE_OPTIONS.find((o) => o.value === k)?.label ?? k;
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
 * 家电品类 —— 用户可见名称。
 * ⚠️ 未知值**不渲染**（返回 undefined），而不是原样打印代码 ——
 *    宁可少一行信息，也不要让店员看到 `appliance_x9`。
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

export function applianceLabel(code: string | null | undefined): string | undefined {
  const k = String(code ?? '').trim();
  return k ? APPLIANCE_LABEL[k] : undefined;
}

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
 * 短信发送状态。
 * ⚠️ 服务端取值是 `pending | accepted | rejected | error` —— **没有 `sent`**。
 *    `accepted` 只表示"服务商已受理"，**不等于送达**，所以译"服务商已受理"。
 *    说成"已发送"会让"客户说没收到"的投诉永远查不出来。
 */
export const SMS_SEND_STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  accepted: '服务商已受理',
  rejected: '未发送',
  error: '提交失败',
};

/* -------------------------------------------------------------- 工具函数 */

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

export function labelOf(table: Record<string, string>, raw: unknown): string {
  const key = String(raw ?? '');
  return table[key] ?? key;
}

/** WCAG 相对亮度（0=黑 1=白） */
export function relLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = v.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  // ⚠️ 按下标取而不是解构：`lin` 是 number[]，解构会推断成可能 undefined
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

/** WCAG 对比度（1:1 ~ 21:1） */
export function contrastRatio(fg: string, bg: string): number {
  const a = relLuminance(fg);
  const b = relLuminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
