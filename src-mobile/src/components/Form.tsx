/**
 * 表单基础件：字段 / 分组 / 日期选择 / 分段选择 / 未保存提醒。
 *
 * ===========================================================================
 * 为什么不用 Konsta 的 ListInput 直接写表单
 * ===========================================================================
 *   `ListInput` 是"列表里的输入行"，它没有：label 与输入的层级关系、
 *   错误态的统一呈现、必填标记、以及**受控值的统一回调**（它给的是 event）。
 *   直接用它写表单会在每个页面重复三件事，且拼写不一致：
 *   有的 `onInput={e => setX(e.target.value)}`，有的用 `onChange`（React 合成事件里
 *   这两个的语义不同，混用会导致中文输入法 composition 期间丢字）。
 *
 *   ⇒ 统一在这里收口：外部只给 `value / onChange(string)`。
 *    ⚠️ 中文输入法必须用 `onCompositionStart/End` 包一层，
 *       否则拼音输入过程中每个字母都会触发一次 onChange，
 *       某些机型上表现为"打字卡顿、最后几个字丢失"。
 */

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { List, ListItem, Toggle } from 'konsta/react';
import { findScrollContainer } from './AppShell';

/* ------------------------------------------------------------------ 字段 */

export function FieldGroup({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <div className="px-4">
      {title ? <div className="text-svc-ink-3 px-1 pt-4 pb-1.5 text-[11px] font-medium">{title}</div> : null}
      <div className="bg-svc-surface overflow-hidden rounded-svc border border-svc-line">{children}</div>
    </div>
  );
}

export interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'tel' | 'number' | 'password' | 'date' | 'email';
  required?: boolean;
  /** 错误文案；有值即显示红框 + 红字 */
  error?: string | null;
  /** 辅助说明（灰字，在输入框下方） */
  hint?: string;
  multiline?: boolean;
  maxLength?: number;
  autoComplete?: string;
  inputMode?: 'text' | 'numeric' | 'tel' | 'decimal' | 'email';
  disabled?: boolean;
  /** 回车（IME 结束后）回调：用于"最后一格回车提交" */
  onEnter?: () => void;
  testId?: string;
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  required,
  error,
  hint,
  multiline,
  maxLength,
  autoComplete,
  inputMode,
  disabled,
  onEnter,
  testId,
}: FieldProps) {
  const id = useId();
  const composing = useRef(false);

  const base =
    'w-full bg-transparent text-[15px] text-svc-ink placeholder:text-svc-ink-3 outline-none disabled:opacity-60';

  return (
    <div
      className={`border-svc-line border-b px-3.5 py-2.5 last:border-b-0 ${error ? 'bg-svc-danger-soft/40' : ''}`}
      data-svc-field={testId}
    >
      <label htmlFor={id} className="text-svc-ink-2 mb-1 block text-[12px]">
        {label}
        {required ? <span className="text-svc-danger ml-0.5">*</span> : null}
      </label>

      {multiline ? (
        <textarea
          id={id}
          className={`${base} min-h-[72px] resize-y leading-relaxed`}
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
          className={base}
          /**
           * ⚠️ `date` 类型在 iOS Safari 上会撑破容器（它有自己的固有宽度）。
           *    给一个 `min-w-0` 让 flex/grid 容器能压住它。
           */
          type={type}
          inputMode={inputMode}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          autoComplete={autoComplete}
          disabled={disabled}
          style={{ minWidth: 0 }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            onChange((e.target as HTMLInputElement).value);
          }}
          onChange={(e) => {
            // 输入法合成中不回调：否则拼音字母会被写进 state
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

      {error ? (
        /**
         * ⚠️ 错误文案提到 13px（原 11px），2026-11-13 · 用户第 ③ 条。
         *    这是**最需要被读到的一行字**：员工填错了、要改的就是这里。
         *    11px 在户外（师傅现场）和中老年用户的机器上几乎读不了。
         *    提到 13px 与正文同行高，不影响布局（提示本来就在字段下方独占一行）。
         *
         *    同时 `text-svc-danger` 也已经统一为对比度更高的 #d0342c（4.99:1）。
         */
        <div className="text-svc-danger mt-1 text-[13px]" role="alert">
          {error}
        </div>
      ) : hint ? (
        /* 提示文字同理提到 12px（比错误小一级，保持层级） */
        <div className="text-svc-ink-3 mt-1 text-[12px]">{hint}</div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- 分段选择 */

/**
 * 分段选择（替代 antd 的 Radio.Group）。
 *
 * 用原生 button + `aria-checked` 而不是 div 模拟：
 * 屏幕阅读器要靠 `role="radio"` 才能读出"第 2 项，共 3 项"。
 * 这类"看起来能用"的控件在真机上对无障碍用户是不可用的。
 */
export function SegmentedField<T extends string>({
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
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  required?: boolean;
  error?: string | null;
  testId?: string;
}) {
  return (
    <div className="border-svc-line border-b px-3.5 py-2.5 last:border-b-0" data-svc-field={testId}>
      <div className="text-svc-ink-2 mb-1.5 text-[12px]">
        {label}
        {required ? <span className="text-svc-danger ml-0.5">*</span> : null}
      </div>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2" data-testid={testId}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(o.value)}
              className={`min-h-touch rounded-full border px-3.5 text-[13px] font-medium transition-colors ${
                on
                  ? 'border-svc-brand bg-svc-brand text-white'
                  : 'border-svc-line bg-svc-surface-2 text-svc-ink-2'
              }`}
            >
              {/* ⚠️ 选中态除了填色，还给一个勾：色弱 / 强光下"填色"几乎看不出来，
                  而"已选 / 未选"恰恰是这一步最需要一眼确认的信息 */}
              {on ? (
                <span className="inline-flex items-center gap-1">
                  <CheckGlyph />
                  {o.label}
                </span>
              ) : (
                o.label
              )}
            </button>
          );
        })}
      </div>
      {error ? (
        <div className="text-svc-danger mt-1 text-[11px]" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function CheckGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 开关行（Konsta 原生 Toggle） */
export function ToggleField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <List className="my-0">
      <ListItem
        title={label}
        subtitle={hint}
        after={<Toggle checked={checked} onChange={() => onChange(!checked)} />}
        link
        onClick={() => onChange(!checked)}
      />
    </List>
  );
}

/* ------------------------------------------------------------- 未保存提醒 */

/**
 * "离开会丢失填写内容"的提醒。
 *
 * ⚠️ 只在前端做，做法是 `beforeunload`（关标签/刷新）+ 拦截应用内返回。
 *    **不要**假称"已自动保存草稿" —— 服务端没有草稿能力，
 *    谎报会让用户在新手机上打开时发现"什么都没了"，而那时已经无法补救。
 *    用户原话："如果没有后端草稿保存能力，不得虚构自动保存。"
 *
 * ⚠️ `beforeunload` 的提示文案**无法自定义**（浏览器统一显示"离开此网站？"），
 *    这是浏览器安全限制。所以真正的保护要靠应用内的自定义确认弹窗（见 `dirty` 用法）。
 */
export function useBeforeUnload(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 现代浏览器忽略返回值，但旧内核需要 returnValue 非空才弹
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}

/* -------------------------------------------------------------- 校验工具 */

/**
 * 把视线带到第一个需要修改的字段。
 *
 * ===========================================================================
 * 为什么必须有这个（用户明确要求："校验失败后自动定位具体错误"）
 * ===========================================================================
 *   整改前点"下一步"只弹一句"请先补全必填项"（2.2 秒消失），而第一屏有 4~5 个
 *   字段，用户得自己从上往下逐个找哪个是红的。手机上错误字段常常在**视口之外**
 *   （比如选了"上门服务"之后多出来的"服务类型"），于是"提交没反应"就成了
 *   最常见的投诉 —— 而代码其实**正确地拦下了非法提交**。
 *
 *   ⇒ 失败时：滚到该字段 + 聚焦（能聚焦的）+ 短暂高亮。
 *
 * ⚠️ 三个实现细节，每一个漏掉都会让它静默失效：
 *   ① **滚动容器不能写死**（见下方 `findScroller`）——
 *      这里原先写的是 `el.closest('.k-page')`，而 `.k-page` 只是
 *      `absolute inset-0 overflow-auto` 的**外层壳**：它的高度由视口撑满，
 *      `scrollHeight === clientHeight`，**它根本不滚**。
 *      真正滚的是它里面的 `.svc-page-body`（`flex-1 min-h-0`）。
 *
 *      ⚠️ 2026-11-14 实测（390×520 视口，模拟软键盘压掉可视区）：
 *         滚到底后    k-page.scrollTop=0  scrollHeight=520  clientHeight=520
 *                    .svc-page-body.scrollTop=182  scrollHeight=702
 *         点提交校验后 .svc-page-body.scrollTop 仍=182（**纹丝不动**）
 *                    「服务类型」字段 getBoundingClientRect().top = **-70**（在屏幕上方 70px，看不见）
 *      ⇒ 症状是"点了下一步，什么也没发生，红字在屏幕外" ——
 *        功能代码明明执行了，用户却以为提交按钮坏了。**这是本轮修掉的真缺陷。**
 *      ⇒ 修法：不猜哪个容器在滚，**从字段自己往上找第一个真能滚的祖先**
 *        （`scrollHeight > clientHeight + 1` 且 overflow-y 是 auto/scroll）。
 *   ② **必须 `preventScroll` 再自己滚**：直接 `focus()` 会由浏览器触发一次
 *      "滚动到可见"，与我们的滚动打架，最终停在两个位置之间。
 *   ③ `data-svc-field` 挂在**分组外壳**上（`Field`/`SegmentedField` 的根 div），
 *      不是 input 本身 —— 手机号输入框不可见时，它的外壳也一定不可见，
 *      而外壳还可能含错误文字，滚到外壳才看得见完整提示。
 *   ④ **位置用 getBoundingClientRect 差值算，不用 `offsetTop`**：
 *      `offsetTop` 是相对**最近的定位祖先**，不是相对滚动容器。
 *      只要中间任何一层有 `position: relative`，算出来的数就是错的，
 *      而且错得"看起来能滚"（滚到一个附近但不是目标的位置）。
 */

/**
 * 从元素往上找**第一个真正能滚的祖先**。
 *
 * ⚠️ 实现只有一份，在 `AppShell.tsx` 的 `findScrollContainer` ——
 *    "回到顶部"和"滚到错误字段"必须用**同一个**判据，
 *    否则两条腿迟早会有一条先掉队（工程铁律 ④：同一段逻辑出现两次 =
 *    同一个坑有两条腿；这里连"哪一层在滚"这种环境事实都算逻辑）。
 */
export function focusFirstError(fieldIds: string[]): boolean {
  for (const id of fieldIds) {
    const el = document.querySelector<HTMLElement>(`[data-svc-field="${id}"]`);
    if (!el) continue;

    // ① 自己滚：找到真正可滚的祖先，用**视口坐标差值**算目标位置
    const scroller = findScrollContainer(el);

    /**
     * 🔴 **必须减去导航栏高度**，否则字段会停在导航栏背后（DEV-252，2026-11-14）。
     *
     *   症状（用户第二节 ①）：校验失败后滚到了，但「服务类型」被顶部导航**遮住一半**。
     *   实测 390×520：字段滚到 `top = 12`，而导航栏覆盖 `0 ~ 60`
     *   ⇒ **48px 藏在导航栏背后**，员工只看到"选项没了"，
     *     不会意识到"要改的就是这里、只是被栏压住了"。
     *
     *   根因：`findScrollContainer` 返回的滚动容器 `.svc-page-body` 的
     *   `getBoundingClientRect().top` 是 **0**（它从视口顶开始），
     *   所以"把字段移到容器顶 + 12px"就等于"移到视口顶 + 12px" ——
     *   而视口顶那 60px 是导航栏的地盘。
     *
     *   `--svc-nav-offset` 由 app.css 定义（= `max(16px, 安全区) + 44px`），
     *   与导航栏自身的内边距/高度**同源**，所以刘海机型也自动正确。
     *   ⚠️ 不写死 60：刘海机上导航栏是 91px，写死会让字段又被遮 31px ——
     *      而那正是这条断言（"完整可见"）要守的东西。
     *
     *   读不到变量时（老浏览器 / 变量未定义）回退 0，
     *   退化成改动前的行为 —— 宁可"滚到但被遮一点"，也不要"完全不滚"。
     */
    const navOffset = readNavOffset();
    const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const top = Math.max(0, scroller.scrollTop + delta - navOffset - 12);
    scroller.scrollTo({ top, behavior: 'smooth' });

    // ② 聚焦（能聚焦的），并阻止浏览器自己的滚动
    const target = el.querySelector<HTMLElement>('input, textarea');
    try {
      target?.focus({ preventScroll: true });
    } catch {
      /* 老内核不支持 preventScroll：宁可滚动打架，也不要没聚焦 */
      target?.focus();
    }

    // ③ 闪一下，让"是这一格"这件事不依赖用户读红字
    el.classList.add('svc-field-flash');
    window.setTimeout(() => el.classList.remove('svc-field-flash'), 1200);

    return true;
  }
  return false;
}

/**
 * 读导航栏高度（`--svc-nav-offset`）。
 *
 * ⚠️ 单列一个函数是因为它有两个调用者（滚到错误字段 / 滚动到底部判定），
 *    而"同一段解析逻辑出现两次 = 同一个坑有两条腿"（工程铁律 ④）。
 *
 * 解析 `calc(max(16px, 0px) + 44px)` 这种 calc 值最可靠的办法是
 * **让浏览器自己算**：把值赋到一个元素上读 `getComputedStyle` 的结果。
 * 手写正则去拆 calc 会在安全区非零时算错（`max()` 的两支要比较）。
 */
export function readNavOffset(): number {
  try {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;height:var(--svc-nav-offset,0px)';
    document.body.appendChild(probe);
    const h = parseFloat(getComputedStyle(probe).height);
    probe.remove();
    return Number.isFinite(h) ? h : 0;
  } catch {
    return 0;
  }
}

/* -------------------------------------------------------------- 校验工具 */

export const validators = {
  mobile(v: string): string | null {
    const s = v.trim();
    // ⚠️ 文案是**祈使句**（"请输入手机号"），不是状态陈述（"手机号为必填"）。
    //    用户第三节明确要求：界面上不说系统内部的话。员工扫一眼就知道**该做什么**，
    //    不需要先把它翻译成动作。（同族：`客户姓名为必填` → `请输入客户姓名`）
    if (!s) return '请输入手机号';
    // 与服务端 `^1[3-9]\d{9}$` 完全一致 —— 前端只做**提前提示**，
    // 判定权仍在服务端（前端放过服务端会拒，前端拦下服务端不会收到请求）。
    if (!/^1[3-9]\d{9}$/.test(s)) return '手机号要 11 位，以 1 开头';
    return null;
  },
  /**
   * 必填校验。
   *
   * ⚠️ 产出 `请输入客户姓名` 而不是 `客户姓名为必填`：
   *    · "为必填"是**描述规则**，"请输入…"是**告诉用户做什么**。
   *      门店员工在柜台前填表，需要的是后者。
   *    · 字段名（"客户姓名"）原样进句子 —— 调用方传 label，
   *      所以新增字段自动获得一致的语气，不需要各自写文案。
   */
  required(label: string) {
    return (v: string): string | null => (v.trim() ? null : `请输入${label}`);
  },
  dateOnly(v: string): string | null {
    if (!v) return null;
    // <input type="date"> 在没有值时会退回 text，可能让用户输入非法串
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return '日期格式应为 YYYY-MM-DD';
    return null;
  },
};
