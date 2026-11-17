/**
 * 应用外壳：**全应用唯一的导航栏与底部栏出处**。
 *
 * ===========================================================================
 * 这个文件存在的唯一理由：防止"双导航栏 / 双底栏 / 多算一层安全区"
 * ===========================================================================
 *   Konsta 的 `<Page>` **不画任何栏**（它只是 `absolute inset-0 overflow-auto`），
 *   栏来自我们显式渲染的 `<Navbar>` / `<Tabbar>`。
 *   于是"再画一遍"这件事在代码上毫无阻碍 ——
 *   而症状（多一条 44px 空白、底部多一条与 Home Indicator 等高的白条）
 *   在截图里看起来像"留白没调好"，很容易被当设计问题放过。
 *
 *   ⇒ 规则只有一条：**页面组件不许自己渲染 Navbar / Tabbar / Toolbar**。
 *     页面只交出 `title` / `back` / `actions` / `bottom`，由 AppShell 统一画。
 *
 * ===========================================================================
 * 安全区只算一次
 * ===========================================================================
 *   `<App safeAreas>` 会在应用根上挂 `.safe-areas`，把 `--k-safe-area-*`
 *   设成 `env(safe-area-inset-*)`。之后：
 *     · Konsta 组件用 `mx-safe-4` / `pb-safe-4` 这类**带 safe 的类**自动加内边距；
 *     · 我们自己的底部固定栏用 `pb-safe`（见 app.css）。
 *   ⚠️ 绝不能在 `<App>` 之外再包一层手动 `padding-top: env(...)` ——
 *      那会把安全区算两次，表现为"刘海下面多出一大条空白"。
 */

import { useEffect, useState, type ReactNode } from 'react';
import { App, Page, Navbar, Tabbar, TabbarLink, NavbarBackLink } from 'konsta/react';
import { navigate } from '../router';

export interface TabItem {
  key: string;
  label: string;
  path: string;
  /** 图标用内联 SVG（不引入图标库：Konsta 自带的图标集是 Material 风格，与 iOS 观感不一致） */
  icon: ReactNode;
}

export interface AppShellProps {
  children: ReactNode;
  /** 有底部 Tab 的页面才传；不传 = 不渲染底栏（客户查询、单任务页都属此类） */
  tabs?: TabItem[];
  /** 当前选中的 tab key */
  activeTab?: string;
}

/**
 * 应用根组件。
 *
 * 🔴 2026-11-14：**恒为浅色**（`dark={false}` 写死）。
 *   用户裁决："不再开发深色模式，不提供浅色/深色切换。无论手机系统设置如何，
 *   业务界面保持统一浅色。"
 *
 *   ⚠️ 这里不能写成 `dark={matchMedia(...)}` 或任何运行时判断 ——
 *      "跟随系统"本身就是一种深色模式。Konsta 的 `dark` 与 `<html class="dark">`
 *      必须同步，两边都固定为 false 才不会出现半深半浅。
 */
export function AppShell({ children, tabs, activeTab }: AppShellProps) {
  const hasTabbar = Boolean(tabs && tabs.length > 0);
  return (
    <App theme="ios" safeAreas dark={false}>
      {/**
       * ⚠️ 结构决定一切：Page 是唯一的滚动容器（`absolute inset-0 overflow-auto`）。
       *    要让底栏真的**贴底**，必须让它成为 Page 的**直接子元素** —— 这时它的
       *    `mt-auto` 才能作用在 Page 这个块级容器上（块级正常流里 margin-top:auto
       *    会把剩余空间全部推到自己上方，等效于贴底）。
       *
       *    如果把 `{children}` 和 Tabbar 一起塞进一个**没有 flex** 的中间 `<div>`，
       *    或者在两者外面再包一层，`mt-auto` 就失效了：
       *    实测底栏停在 y=520~618（视口 844），下面空着 226px，
       *    而截图里看起来只像"这页内容不多" —— 极难被发现。
       *
       *    ⇒ 这里不再包 wrapper：`{children}` 与 `<BottomTabbar>` 平铺在 `<Page>` 下。
       *       children 内部自己用 `svc-page-body` 处理"给底栏/吸底栏让位"。
       */}
      <Page className="bg-svc-bg flex flex-col">
        <div className="svc-page-body flex-1 min-h-0">{children}</div>
        {hasTabbar ? <BottomTabbar tabs={tabs!} active={activeTab} /> : null}
      </Page>
    </App>
  );
}

/**
 * 底部 Tab。
 *
 * ⚠️ 刻意**不**给匿名客户 / 师傅页面用 —— 用户原话：
 *    "不把内部员工底部 Tabbar 强行套在匿名客户或师傅的单任务页面上"。
 *    技术上也对不上：匿名页面没有"首页/工单/我的"这种并列目的地，
 *    套上去只会给用户一个"点了会跳到登录页"的陷阱入口。
 */
function BottomTabbar({ tabs, active }: { tabs: TabItem[]; active?: string }) {
  return (
    /**
     * ⚠️ `<Toolbar tabbar>` **就是** Tabbar —— Konsta 的 `Tabbar` 只是
     *    `Toolbar` 的薄封装（`react/components/Tabbar.js`：`<Toolbar tabbar {...rest}>`）。
     *    所以 `<Toolbar><Tabbar>…</Tabbar></Toolbar>` 会渲染出**两个嵌套的 `.k-toolbar`**。
     *
     *    危害不在于多一层 DOM，而在于 Konsta 用 `[class*=k-toolbar]` 的组合规则给
     *    工具栏加内边距（iOS 侧 `pb-safe-4`），**每层各加一次**：
     *    实测外层 h=98、内层 h=50，两层 padding-bottom 都是 50px（34 安全区 + 16 尾随），
     *    合计在 Tab 下方留出 66px 空洞 —— 正是用户明令不许出现的"多余留白"。
     *    （而且两层都能被 `document.querySelectorAll('.k-toolbar')` 命中，
     *      验收脚本也会把它数成"两个底栏"。）
     *
     *    ⇒ 只写一层 `<Tabbar>`，**不要**再套 `<Toolbar>`。
     *       安全区由 Konsta 自己处理（`pb-safe-4`），不要额外加 `className="pb-safe"`。
     */
    <Tabbar>
      {tabs.map((t) => (
        <TabbarLink
          key={t.key}
          active={t.key === active}
          onClick={() => navigate(t.path)}
          icon={t.icon}
          label={t.label}
          aria-current={t.key === active ? 'page' : undefined}
        />
      ))}
    </Tabbar>
  );
}

export interface PageHeaderProps {
  title: ReactNode;
  /** 传了就显示返回箭头；不传则显示为根级页面（无返回） */
  back?: boolean;
  /** 覆盖返回行为（默认 history.back，history 为空时回首页） */
  onBack?: () => void;
  subtitle?: ReactNode;
  right?: ReactNode;
}

/**
 * 页面头。
 *
 * ⚠️ 返回箭头的兜底行为很重要：用户从**外部链接**打开 `/m/tickets/123` 时
 *    `history.length` 是 1，`history.back()` 什么都不做。
 *    这时必须回首页，否则用户会卡在一个"点了没反应"的返回键上。
 */
export function PageHeader({ title, back, onBack, subtitle, right }: PageHeaderProps) {
  const handleBack = () => {
    if (onBack) return onBack();
    if (history.length > 1) history.back();
    else navigate('/');
  };

  return (
    <Navbar
      title={title}
      subtitle={subtitle}
      left={back ? <NavbarBackLink text="返回" onClick={handleBack} /> : undefined}
      right={right}
      // 无返回箭头的根级页面：留一个 44px 的占位，避免标题在视觉上偏左
      className="top-0 sticky bg-svc-surface"
    />
  );
}

/**
 * 底部固定操作栏（StickyActionBar）。
 *
 * ⚠️ 它**不是** Tabbar 的替代品，两者可以同时存在（详情页有主操作 + 有 Tab）。
 *    但它自己必须在滚动容器内 `sticky bottom-0`，
 *    且**必须**带 `pb-safe` —— 否则在 Home Indicator 机型上按钮会被压住一半。
 *
 * ⚠️ 键盘弹起时必须仍然可点：靠 `<meta viewport>` 的
 *    `interactive-widget=resizes-content`（见 index.html），
 *    内容区被压缩，sticky 栏自然上移。**不要**用 `position: fixed` +
 *    手算 `visualViewport`，那套在微信内置浏览器里行为不一致。
 */
export function StickyActionBar({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      /**
       * 🔴 2026-11-14：移除 `bg-svc-surface/95 + backdrop-blur-sm`。
       *
       *   那是"浮动玻璃"做法（半透明 + 背景模糊），用户本轮明令禁止：
       *   "Liquid Glass、毛玻璃、玻璃折射、夸张背景模糊、发光阴影、浮动玻璃胶囊导航"。
       *
       *   ⇒ 改为**实心白底 + 一条 hairline 分隔线**，这才是经典 iOS 的做法：
       *     底栏与内容靠分隔线区分层级，不靠模糊。
       *
       *   ⚠️ 顺带解决了另一个问题：`/95` 半透明在低端机滚动时会掉帧，
       *      而且当内容滚动到底部时，半透明会把内容透出来，文字互相干扰。
       */
      className={`sticky bottom-0 z-20 border-t border-svc-line bg-svc-surface pb-safe ${className}`}
      data-svc-sticky-bar="1"
    >
      <div className="flex items-center gap-2 px-4 py-3">{children}</div>
    </div>
  );
}

/**
 * **真正的**滚动容器。
 *
 * ⚠️ 这曾经是个遍布全项目的错误假设，值得写清楚：
 *
 *   大家（包括我）都以为 `.k-page` 是滚动容器 —— 因为它带着
 *   `absolute inset-0 overflow-auto`。但实测（390×520 视口）：
 *
 *     .k-page            scrollHeight=520  clientHeight=520   ← **纹丝不动**
 *     .svc-page-body     scrollHeight=702  clientHeight=520   ← 真正在滚的是它
 *
 *   原因是我们自己的 `AppShell` 在 `<Page>` 里插了一层
 *   `svc-page-body flex-1 min-h-0` —— 高度在**内层**溢出，外层永远刚好贴合。
 *
 *   代价是两处功能静默失效（都属于"代码执行了但用户看不到任何变化"）：
 *     ① 校验失败后滚到第一个错误字段 → 没滚（人在屏幕外的红字看不见）
 *     ② 换页 / 切步骤后回到顶部 → 没回（新页面接着旧位置，像内容缺失）
 *
 *   ⇒ 唯一可靠的判据是**当时的可滚性**，不是类名。
 *     找不到可滚祖先时回退到 `document.scrollingElement`，
 *     保证调用方永远拿得到目标（宁可滚不动，也不要崩）。
 */
export function findScrollContainer(from?: Element | null): HTMLElement {
  let cur: HTMLElement | null = (from?.parentElement ?? document.querySelector('.svc-page-body')) as HTMLElement | null;
  while (cur && cur !== document.body) {
    const cs = getComputedStyle(cur);
    if (cur.scrollHeight > cur.clientHeight + 1 && (cs.overflowY === 'auto' || cs.overflowY === 'scroll')) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/**
 * 滚动位置复位。
 *
 * ⚠️ Konsta 的 `<Page>` 是 `overflow:auto` 的绝对定位容器，
 *    **改 `pathname` 不会自动回到顶部**（浏览器只对 window/document 滚动复位）。
 *    后果：从列表第 40 条点进详情，详情页直接落在中间位置 ——
 *    看起来像"详情页内容缺失"，实际只是滚动位置被继承了。
 *
 * ⚠️ 2026-11-14：原先这里打的是 `.k-page`，而它**根本不滚**（见 `findScrollContainer`）
 *    ⇒ 这条"复位"一直是空转，上面描述的假象一直真实存在。
 */
export function useScrollTopOnRouteChange(key: string): void {
  useEffect(() => {
    // 路由刚切换时新页面可能还没挂载完，等一帧再找容器
    const raf = requestAnimationFrame(() => {
      findScrollContainer().scrollTo({ top: 0, behavior: 'auto' });
    });
    return () => cancelAnimationFrame(raf);
  }, [key]);
}

/**
 * 键盘可见性探针（供"输入框聚焦时避免被吸底栏遮住"用）。
 *
 * ⚠️ 只在需要"聚焦时隐藏底栏"的页面用。默认**不要**隐藏底栏：
 *    用户一边填一边要点保存，隐藏底栏会让主操作消失。
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      // 视口高度比初始高度少 150px 以上 ⇒ 大概率是键盘
      setOpen(vv.height < window.innerHeight - 150);
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);
  return open;
}
