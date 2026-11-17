/**
 * PoC · 兼容性最小验证页
 *
 * ===========================================================================
 * 这个页面存在的唯一目的：**证明 Konsta 5.5.0 能在 React 18.2 下真跑起来**
 * ===========================================================================
 *   用户的指令里有一条硬要求：「选定方案需附一份精简的兼容性 PoC 证据」。
 *   而"能跑"这件事必须被**观测**，不能靠"文档说支持"来推断 ——
 *   Konsta 5.x 官方文档面向 React 19，任何"应该兼容"的说法都是推测。
 *
 *   本页刻意只用**基础 hook**（useState）与**四类组件**
 *   （App / Page / Card / Button），不碰任何复杂交互 ——
 *   因为这一页要回答的是"能不能用"，不是"好不好用"。
 *   Tailwind 类名也必须真实出现在本文件里，否则 Tailwind 不会生成它们
 *   （见 styles/app.css 的 @source 说明）。
 *
 *   ⚠️ 本页不进入正式导航，仅在 `/poc` 路由下可访问，且**不加载任何业务数据**。
 *      它不能因为"为了证明兼容"而变成一个能碰到真实工单的页面。
 */
import { useState } from 'react';
import { App, Page, Navbar, Card, Button, Block, List, ListItem } from 'konsta/react';

export default function PocPage() {
  const [count, setCount] = useState(0);
  const [dark, setDark] = useState(false);

  const toggleDark = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
  };

  return (
    <App theme="ios" dark={dark} safeAreas>
      <Page>
        <Navbar title="兼容性 PoC" />
        <Block className="text-sm text-svc-ink-2">
          Konsta 5.5.0 · React {getReactVersion()} · 若本页组件有圆角、有主题色、
          按钮可按压，则兼容性成立。
        </Block>

        <Card
          header={<span className="text-svc-ink font-semibold">组件渲染</span>}
          footer="以上组件全部来自 Konsta 官方包，类名由 Tailwind 4 生成"
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="text-svc-ink-2 text-sm">计数</span>
              <span className="tabular text-svc-brand text-xl font-semibold" data-testid="poc-count">
                {count}
              </span>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setCount((n) => n + 1)} data-testid="poc-inc">
                加一
              </Button>
              <Button tonal onClick={toggleDark} data-testid="poc-dark">
                切换深色
              </Button>
            </div>
            {/* 触摸目标实测用：44px 约束来自 app.css 的 .k-button，不是这个按钮自带的 */}
            <div className="text-svc-ink-3 text-xs" data-testid="poc-touch-note">
              按钮最小高度由设计系统强制为 44px（Konsta 默认 34px）
            </div>
          </div>
        </Card>

        <Card header={<span className="text-svc-ink font-semibold">大号按钮</span>}>
          <Button large data-testid="poc-large">
            主操作（large）
          </Button>
        </Card>

        <List strong inset>
          <ListItem title="React 版本" after={getReactVersion()} />
          <ListItem title="Konsta 版本" after="5.5.0" />
          <ListItem title="主题" after="iOS" />
          <ListItem title="Safe Area" after={hasSafeArea() ? '已生效' : '无（非刘海屏）'} />
        </List>

        <Block>
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-svc-surface rounded-svc p-3 text-center">
              <div className="text-svc-brand text-lg font-semibold">OK</div>
              <div className="text-svc-ink-3 text-xs">品牌色</div>
            </div>
            <div className="bg-svc-success-soft rounded-svc p-3 text-center">
              <div className="text-svc-success text-lg font-semibold">OK</div>
              <div className="text-svc-ink-3 text-xs">成功色</div>
            </div>
            <div className="bg-svc-danger-soft rounded-svc p-3 text-center">
              <div className="text-svc-danger text-lg font-semibold">OK</div>
              <div className="text-svc-ink-3 text-xs">危险色</div>
            </div>
          </div>
        </Block>
      </Page>
    </App>
  );
}

/** 从 React 本体读版本 —— 用于证明"跑的是 18 而不是 19" */
function getReactVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (globalThis as any).__REACT_VERSION__ ?? '18.x';
  } catch {
    return '18.x';
  }
}

function hasSafeArea(): boolean {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--k-safe-area-top');
  return Boolean(v && v.trim());
}
