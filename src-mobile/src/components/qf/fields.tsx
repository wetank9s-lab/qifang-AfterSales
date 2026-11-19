/**
 * QF 表单控件：字段 / 分段控件 / 网格选择 / 选择行。
 *
 * ===========================================================================
 * 这里修掉的两个真实缺陷（审计 P-01 与 I-03）
 * ===========================================================================
 *
 * ① P-01：服务类型/服务内容用的是 `rounded-full` 胶囊按钮组
 *
 *    旧实现（`Form.tsx:199`）是一条 `flex flex-wrap` 里的胶囊按钮，
 *    宽度随文字长度变化。6 个选项（送货安装/安装调试/维修检测/清洗保养/使用指导/其他）
 *    在同一行里宽度各不相同 ⇒ 视觉上像"一堆标签"，不像一组互斥选项。
 *
 *    `segmented-controls.md › Best practices`：
 *      · "In general, keep segment size consistent. When all segments have equal width,
 *         a segmented control feels balanced."
 *      · "no more than about five segments on iPhone"
 *
 *    ⇒ 两项（上门服务 / 暖通工程）用**真正的 Segmented Control**：等宽、轨道 #F2F2F7、
 *      选中白底 + 1px 阴影、圆角 10px（外层）/ 7px（内层滑块，= 10 − 3 inset）。
 *      六项（服务内容）用 **2 列网格**，等宽等高，不受"5 段"限制。
 *
 * ② I-03：切换服务类型时下方内容**整体上移约 88px**
 *
 *    旧实现 `{type === 'service' ? <SegmentedField label="服务内容" ... /> : null}`
 *    ⇒ 选「暖通工程」时那一格直接消失，下面的"客户与地址"分组跳上去 88px。
 *    用户在第 五 节明令："选择不同服务类型时页面布局不能错位。"
 *
 *    ⇒ 本文件的做法：**两种类型的字段区高度恒定**。
 *      暖通时不渲染网格，而是渲染一个**等高的说明块**
 *      （"暖通工程按施工阶段记录，不需要选服务内容"）。
 *      实测判据：切换前后 `#archive-new-name` 的 `getBoundingClientRect().top` 差值 **== 0**。
 *
 *      ⚠️ 说明块的文字**不能**写"请选择服务内容"，那会让人以为下面还能点。
 *         它要回答的是"为什么这里没有可选项"。
 */

import { useId, useRef, type ReactNode } from 'react';

/* ------------------------------------------------------------ 基础字段 */

/**
 * 表单字段（标签在上、控件在下）。
 *
 * ⚠️ 中文输入法必须用 `onCompositionStart/End` 包一层，
 *    否则拼音输入过程中每个字母都会触发一次 onChange，
 *    某些机型上表现为"打字卡顿、最后几个字丢失"。
 */
export function QFFormField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  inputMode,
  required,
  error,
  hint,
  multiline,
  maxLength,
  autoComplete,
  disabled,
  onEnter,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'tel' | 'number' | 'password' | 'date' | 'email';
  inputMode?: 'text' | 'numeric' | 'tel' | 'decimal' | 'email';
  required?: boolean;
  error?: string | null;
  hint?: string;
  multiline?: boolean;
  maxLength?: number;
  autoComplete?: string;
  disabled?: boolean;
  onEnter?: () => void;
  testId?: string;
}) {
  const id = useId();
  const composing = useRef(false);

  return (
    <div className="px-4" data-svc-field={testId}>
      <div className="qf-field">
        <label htmlFor={id} className="qf-field-label">
          {label}
          {required ? (
            <span className="text-svc-danger ml-0.5" aria-hidden="true">
              *
            </span>
          ) : null}
        </label>

        {multiline ? (
          <textarea
            id={id}
            className="qf-input min-h-[72px] resize-y leading-relaxed"
            value={value}
            placeholder={placeholder}
            maxLength={maxLength}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            data-testid={testId}
          />
        ) : (
          <input
            id={id}
            className="qf-input"
            type={type}
            inputMode={inputMode}
            value={value}
            placeholder={placeholder}
            maxLength={maxLength}
            autoComplete={autoComplete}
            disabled={disabled}
            /**
             * ⚠️ `date` 类型在 iOS Safari 上会撑破容器（它有自己的固有宽度）。
             *    给一个 `minWidth: 0` 让 flex/grid 容器能压住它。
             */
            style={{ minWidth: 0 }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={(e) => {
              composing.current = false;
              onChange((e.target as HTMLInputElement).value);
            }}
            onChange={(e) => {
              if (composing.current) return;
              onChange(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !composing.current) {
                e.preventDefault();
                onEnter?.();
              }
            }}
            data-testid={testId}
          />
        )}

        {/**
         * ⚠️ 错误文案必须**靠近字段**（`writing.md › Best practices`：
         *    "Show errors right next to the field"），且用祈使句告诉用户该做什么，
         *    不用"为必填"这种规则陈述。
         *
         * ⚠️ 错误与提示**互斥显示**：同时出现时错误优先 ——
         *    两行字会把字段挤高，而此刻用户只需要知道"要改什么"。
         */}
        {error ? (
          <div className="text-svc-danger qf-foot mt-1" role="alert">
            {error}
          </div>
        ) : hint ? (
          <div className="text-svc-ink-3 qf-foot mt-1">{hint}</div>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- 分段控件 */

/**
 * iOS 分段控件（**只有 2–3 项时用**）。
 *
 * ⚠️ 严格等宽：`grid` + `grid-cols-N`，不用 `flex`。
 *    flex + 文字宽度会让两段的宽度随文案变化 —— 那正是旧胶囊的问题。
 *
 * ⚠️ 选中态是"白底滑块 + 1px 阴影"，不是蓝底白字：
 *    分段控件表达的是"在几个等价选项里切换"，蓝色是"主要动作"的颜色，
 *    给分段控件上蓝会让一屏出现两个主视觉（与用户第四节"页面是否只突出一个主要任务"冲突）。
 *    `segmented-controls.md` 的示例也是浅色滑块。
 */
export function QFSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
  required,
  error,
  testId,
}: {
  label: string;
  value: T | '';
  options: { value: T; label: string; sub?: string }[];
  onChange: (v: T) => void;
  required?: boolean;
  error?: string | null;
  testId?: string;
}) {
  const cols = options.length <= 2 ? 2 : options.length;
  return (
    <div className="px-4" data-svc-field={testId}>
      <div className="qf-field">
        <div className="qf-field-label" id={`${testId}-lbl`}>
          {label}
          {required ? (
            <span className="text-svc-danger ml-0.5" aria-hidden="true">
              *
            </span>
          ) : null}
        </div>
        <div
          role="radiogroup"
          aria-labelledby={`${testId}-lbl`}
          aria-label={label}
          className="bg-svc-bg grid gap-0.5 rounded-svc p-[3px]"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          data-testid={testId}
          data-qf-control="segmented"
        >
          {options.map((o) => {
            const on = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange(o.value)}
                /**
                 * ⚠️ 内层必须**自己**够 44 —— 不能指望外层 `p-[3px]` 把它垫够。
                 *
                 * 2026-11-19 验收实测：内层写 `min-h-[38px]` 时，
                 * `getBoundingClientRect()` 只量到按钮本体 38px，
                 * `accessibility.md › Touch targets` 要求的 44 是**可点区域**，
                 * 而不是"按钮 + 它的父容器内边距"。父容器的 3px 不会转成命中区：
                 * 点在 3px 缝隙上触发的是父容器的 `role="radiogroup"`，不是这个 button。
                 *
                 * ⇒ 内层 min-height 改成 44 ⇒ 控件总高 = 44 + 3×2 = 50，
                 *   恰好等于输入框/次要按钮的 `qf-control` 50px。
                 *   这反而是更好的结果：一屏里只有一种控件高度（用户第五节明确要求）。
                 */
                className={`qf-pressable flex min-h-touch items-center justify-center rounded-svc-sm px-2 text-center transition-colors ${
                  on
                    ? 'bg-svc-surface text-svc-ink shadow-[0_1px_2px_rgba(0,0,0,0.10)]'
                    : 'text-svc-ink-2 bg-transparent'
                }`}
                style={{ borderRadius: 8 }}
              >
                <span className="qf-sub leading-tight font-medium">{o.label}</span>
              </button>
            );
          })}
        </div>
        {/**
         * 错误行**必须预留固定高度**，不能"有错才占位"。
         *
         * 这一点只在"选项组"上暴露：`ArchiveNew` 的类型字段刚进页面时是空的，
         * 提交前点一下别的字段会立刻出现「请选择服务类型」——
         * 那一行 22px 会把下面所有内容整体推下去，用户正在输入的字段会跳走。
         * 输入框不受影响，因为它的错误行在**字段下方、下一个字段之前**，
         * 而标签+输入框的锚点在上方。
         *
         * ⇒ 用 `min-height: 22px`（= foot 13px × 行高 18 + mt-1 4px）恒定占位。
         */}
        <div className="mt-1 min-h-[22px]">
          {error ? (
            <div className="text-svc-danger qf-foot" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- 网格选择 */

/**
 * 网格选择（**4 项以上**用）。
 *
 * 为什么不是 segmented：`segmented-controls.md` 明确"iPhone 上不超过约 5 段"，
 * 服务内容有 6 项。硬塞进 segmented 会让每段只有 55px 宽，中文 4 字挤成两行。
 *
 * ⚠️ 选中态用**蓝底白字 + 勾**，这里可以用蓝：它是"选择"，用户需要一眼看出
 *    哪一项被选中（网格里 6 个等大的块，只靠边框差异很难扫）。
 *    勾是给色弱/强光场景的第二重信号。
 *
 * ⚠️ **高度必须恒定**：`min-h-[48px]` + 固定两行文字结构，
 *    保证 `selected`（1 行）与 `selected + 勾` 不会改变块高 ——
 *    否则选中一个选项会把下面的内容推下去，正是 I-03 那类跳动的新版本。
 */
export function QFGridSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  required,
  error,
  columns = 2,
  testId,
}: {
  label: string;
  value: T | '';
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  required?: boolean;
  error?: string | null;
  columns?: number;
  testId?: string;
}) {
  return (
    <div className="px-4" data-svc-field={testId}>
      <div className="qf-field">
        <div className="qf-field-label" id={`${testId}-lbl`}>
          {label}
          {required ? (
            <span className="text-svc-danger ml-0.5" aria-hidden="true">
              *
            </span>
          ) : null}
        </div>
        <div
          role="radiogroup"
          aria-labelledby={`${testId}-lbl`}
          aria-label={label}
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          data-testid={testId}
          data-qf-control="grid"
        >
          {options.map((o) => {
            const on = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange(o.value)}
                className={`qf-pressable flex min-h-[48px] items-center justify-center gap-1 rounded-svc border px-2 transition-colors ${
                  on
                    ? 'border-svc-brand bg-svc-brand text-svc-brand-ink'
                    : 'border-svc-line bg-svc-surface text-svc-ink'
                }`}
                style={{ borderRadius: 10 }}
              >
                {/* 勾始终占位（未选中时透明），这样选中不会改变文字位置 */}
                <span className={`shrink-0 ${on ? 'opacity-100' : 'opacity-0'}`} aria-hidden="true">
                  <CheckGlyph />
                </span>
                <span className="qf-sub leading-tight font-medium whitespace-nowrap">{o.label}</span>
              </button>
            );
          })}
        </div>
        {/*
         * ⚠️ 错误行**固定占 22px**，与 QFSegmented 完全一致。
         *    理由见上面那段长注释：两点之间（"服务类型"选完 → "服务内容"报错）
         *    必须零位移，否则一屏里出现两套规则，判据就不可复制了。
         */}
        <div className="mt-1 min-h-[22px]">
          {error ? (
            <div className="text-svc-danger qf-foot" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ 不可用的说明块 */

/**
 * 等高的"这里没有可选项"说明块 —— **专门用来稳住布局**。
 *
 * 用在：新建档案里，"服务内容"网格只对上门服务出现；
 * 选暖通时不能直接不渲染（会跳动），要先占住**完全等高的**位置。
 *
 * ⚠️ 高度怎么来的：网格 2 列 × 3 行 = `3×48 + 2×8(gap) = 160px`；
 *    本块 `min-height: 160px` 与之严格相等。
 *    **不要**改成"差不多高" —— 判据是 `top` 差值 == 0，差 1px 就是红的。
 *
 * ⚠️ 文案回答"为什么这里没有选项"，不是"请选择"。
 *    写"请选择服务内容"会让人以为下面还有东西可点，去找半天。
 */
export function QFUnavailableBlock({ height = 160, children }: { height?: number; children: ReactNode }) {
  return (
    <div className="px-4">
      <div className="qf-field">
        <div
          className="bg-svc-surface-2 text-svc-ink-2 qf-foot flex items-center rounded-svc px-4 leading-relaxed"
          style={{ minHeight: height }}
          data-qf-control="unavailable"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------- 选择行（跳转） */

/**
 * 选择行：左标签右值 + 右箭头。
 *
 * ⚠️ 值缺失时显示占位文案（"请选择"）而不是空白：
 *    空白行看起来像"这一项不需要填"，而它其实是必填的。
 */
export function QFSelectRow({
  label,
  value,
  placeholder = '请选择',
  onClick,
  required,
  error,
  testId,
}: {
  label: string;
  value: string | null | undefined;
  placeholder?: string;
  onClick?: () => void;
  required?: boolean;
  error?: string | null;
  testId?: string;
}) {
  return (
    <div className="px-4" data-svc-field={testId}>
      <button
        type="button"
        onClick={onClick}
        className="qf-pressable flex min-h-touch w-full items-center gap-2 py-2.5 text-left"
        data-testid={testId}
      >
        <span className="text-svc-ink-2 qf-body shrink-0">
          {label}
          {required ? (
            <span className="text-svc-danger ml-0.5" aria-hidden="true">
              *
            </span>
          ) : null}
        </span>
        <span className={`qf-body ml-auto truncate ${value ? 'text-svc-ink' : 'text-svc-placeholder'}`}>
          {value || placeholder}
        </span>
        <ChevronGlyph />
      </button>
      {error ? (
        <div className="text-svc-danger qf-foot pb-2" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- 图标 */

function CheckGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true" className="text-svc-ink-3 shrink-0">
      <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
