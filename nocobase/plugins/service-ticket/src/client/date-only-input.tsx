/**
 * `DateOnlyInput` —— 「只到日」的**日期选择**控件（2026-11-11，DEV-218）
 *
 * ===========================================================================
 * 为什么需要它（用户原话）
 * ===========================================================================
 *   「提交页的预约上门日期是选填，并且是 YYYY-MM-DD 格式，客户不能理解手动输入
 *     日期格式，必须改为日期选择组件，当前输入其他格式不能提交。」
 *
 *   改之前那个控件是普通文本框 + 占位文字 `选填，YYYY-MM-DD`：
 *   门店销售/客户得自己记住格式，打错就提交不了，而且**报错还来得晚**
 *   （DEV-217 那轮真机 500 就是同一条链路上的极端形态）。
 *
 * ===========================================================================
 * 为什么不用 antd 的 `DatePicker`（这不是偷懒，是被依赖拓扑逼的）
 * ===========================================================================
 *   本区块被**两个 bundle 同时引用**：
 *     · `src/client/index.ts`      → 后台 UMD（externals 里**有** `dayjs`）
 *     · `src/client-v2/index.ts`   → 移动页 ESM（externals 里**没有** `dayjs`，
 *                                    见 `scripts/build-plugin.mjs` 的 client-v2 `external`）
 *   而仓库根目录并不存在 `node_modules/dayjs`。于是：
 *     · 一旦在这份共享代码里 `import dayjs` ⇒ **v2 构建在解析阶段直接失败**；
 *     · 把 `dayjs` 补进 v2 externals 也不行 —— 移动端 requirejs 是否注册了 `dayjs`
 *       **没有证据**（官方 client-v2 插件的 define 依赖是
 *        `["@emotion/css","@nocobase/client-v2","react","antd","@ant-design/icons","@nocobase/flow-engine"]`，
 *        不含 dayjs）。猜错的后果是运行期 "Module not found"，整个区块**白屏**，
 *        比"日期控件不好用"严重得多。
 *
 *   ⇒ 用**浏览器原生** `<input type="date">`：
 *     · 手机上点一下弹系统日历 / 滚轮，用户**完全不需要知道** `YYYY-MM-DD`；
 *     · 桌面端弹日历面板，值由浏览器归一成 `YYYY-MM-DD`；
 *     · 零依赖，两个 bundle 行为完全一致；
 *     · **结构上产不出"用户手打的奇怪格式"** —— 这正是本条要求的核心。
 *
 * ===========================================================================
 * 三条纪律（与 DEV-217 一脉相承）
 * ===========================================================================
 *   ① 显示值一律过 `parseDateOnly`：坏值不显示，但**绝不静默当成"没填"**；
 *   ② 控件返回无法识别的值（移动端 WebView 可能吐字符串 `'Invalid date'`）时，
 *      把**原样值**上抛给表单，让提交前的 `parseDateOnly` 守卫拦住并给出人话错误 ——
 *      静默变成"没填"会退化成"保存成功但内容没保存"，那是更坏的缺陷；
 *   ③ `''` 永远表示"没填 / 清空"，与"坏值"严格区分。
 *
 * ===========================================================================
 * ⚠️ 为什么这个文件**只能用 `React.createElement`，不能写 JSX**
 * ===========================================================================
 *   本文件同时被打进两个 bundle。实测（2026-11-11）：一旦在这里写 JSX，
 *   esbuild 的 automatic runtime 会给 **client-v2** 增加一条外部依赖
 *   `react/jsx-runtime`（构建输出从 `外部依赖 4 个` 变成 `5 个`）。
 *   而移动端 requirejs 是否注册过 `react/jsx-runtime` **没有任何证据**
 *   （官方 client-v2 插件的 define 依赖里只有 `react`，不是它）。
 *   猜错的后果不是"日期控件难看"，而是**整个插件在移动页加载失败**。
 *   ⇒ 统一用 `React.createElement`，让 v2 的外部依赖清单保持原样。
 */

import React from 'react';
import { parseDateOnly } from '../shared/date-only';

const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 把 `YYYY-MM-DD` 变成人话回显，让用户**确认自己选对了哪一天**。
 * 用 UTC 构造+回读取星期，避免本地时区把日期挪一天（同 `date-only.ts`）。
 */
function humanize(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== mo - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  return `${y} 年 ${mo} 月 ${d} 日 · 周${WEEKDAY_CN[probe.getUTCDay()]}`;
}

export interface DateOnlyInputProps {
  /** 由 `Form.Item` 注入：期望是 `YYYY-MM-DD` 字符串或空 */
  value?: unknown;
  /** 由 `Form.Item` 注入：向上抛 `YYYY-MM-DD` / `''` / 原样坏值 */
  onChange?: (next: string) => void;
  disabled?: boolean;
  /** 容器 `data-testid`；内部 input 自动为 `<testId>-input` */
  testId?: string;
}

export function DateOnlyInput(props: DateOnlyInputProps): any {
  const parsed = parseDateOnly(props.value);
  const broken = !parsed.ok;
  const shown = parsed.ok ? (parsed.value ?? '') : '';
  const echo = shown ? humanize(shown) : null;
  const disabled = !!props.disabled;

  const emit = (next: string) => {
    if (typeof props.onChange === 'function') props.onChange(next);
  };

  const onInput = (e: any) => {
    const raw = e && e.target ? e.target.value : '';
    const r = parseDateOnly(raw);
    if (!r.ok) {
      // 纪律 ②：不静默吞掉，原样上抛，交给提交前守卫报错
      emit(typeof raw === 'string' ? raw : String(raw ?? ''));
      return;
    }
    // `null`（空）与 `''` 都归一到 `''`，表示"没填"
    emit(r.value ?? '');
  };

  const inputStyle = {
    flex: '1 1 auto',
    minWidth: 0,
    width: '100%',
    height: 32,
    padding: '4px 11px',
    fontSize: 14,
    lineHeight: 1.5715,
    color: 'rgba(0, 0, 0, 0.88)',
    backgroundColor: disabled ? 'rgba(0, 0, 0, 0.04)' : '#fff',
    border: broken ? '1px solid #ff4d4f' : '1px solid #d9d9d9',
    borderRadius: 6,
    boxSizing: 'border-box',
    fontFamily: 'inherit',
    // 系统深色模式下原生日期控件会自己变黑，与表单其余部分不协调
    colorScheme: 'light',
    cursor: disabled ? 'not-allowed' : 'pointer',
  };

  return React.createElement(
    'div',
    { 'data-testid': props.testId },

    React.createElement(
      'div',
      { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      React.createElement('input', {
        type: 'date',
        value: shown,
        disabled,
        onChange: onInput,
        'data-testid': props.testId ? `${props.testId}-input` : undefined,
        // 样式对齐 antd Input（高度 32 / 圆角 6 / 同色边框），
        // 否则原生控件在两个 bundle 里会各自显示成不同高度，视觉上像坏掉。
        style: inputStyle,
      }),
      shown || broken
        ? React.createElement(
            'button',
            {
              type: 'button',
              disabled,
              onClick: () => emit(''),
              'data-testid': props.testId ? `${props.testId}-clear` : undefined,
              style: {
                flex: '0 0 auto',
                height: 32,
                padding: '0 10px',
                fontSize: 13,
                color: disabled ? 'rgba(0, 0, 0, 0.25)' : '#1677ff',
                background: 'transparent',
                border: '1px solid #d9d9d9',
                borderRadius: 6,
                cursor: disabled ? 'not-allowed' : 'pointer',
              },
            },
            '清除',
          )
        : null,
    ),

    // 回显：把 `2026-11-15` 翻译成「2026 年 11 月 15 日 · 周六」，
    // 用户不用再对着数字确认自己选的是哪一天
    echo
      ? React.createElement(
          'div',
          {
            'data-testid': props.testId ? `${props.testId}-echo` : undefined,
            style: { marginTop: 4, fontSize: 12, color: '#8c8c8c' },
          },
          `已选：${echo}`,
        )
      : null,

    // 默认态给一句操作提示 —— 用户原来的困惑正是"不知道该填什么格式"
    !shown && !broken
      ? React.createElement(
          'div',
          {
            'data-testid': props.testId ? `${props.testId}-hint` : undefined,
            style: { marginTop: 4, fontSize: 12, color: '#8c8c8c' },
          },
          '点一下选择日期即可，不用手动输入；选填，可留空',
        )
      : null,

    // 坏值：控件给出了无法识别的日期。不当成"没填"，明确要求重选
    broken
      ? React.createElement(
          'div',
          {
            'data-testid': props.testId ? `${props.testId}-broken` : undefined,
            style: { marginTop: 4, fontSize: 12, color: '#ff4d4f' },
          },
          '日期未能识别，请重新点选一次',
        )
      : null,
  );
}
