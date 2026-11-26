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
import { pageTitle } from '../brand';

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
    /**
     * ⚠️ `className="svc-app-root"` 是**玻璃层封锁的锚点**（R2.2.1 §2.3）：
     *    app.css 里 `.svc-app-root [class*='backdrop-blur'] { backdrop-filter: none !important }`
     *    依赖它。去掉这个类 = 自动解除封锁，Konsta 的 bgBlur 一旦被开启就会生效。
     */
    <App theme="ios" safeAreas dark={false} className="svc-app-root">
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

/* --------------------------------------------------- 返回箭头（iOS 简洁风） */
/**
 * 经典 iOS 返回箭头：**细线条** + 品牌色，而不是 Konsta 默认那个
 * `fill: currentColor` 的粗块状 chevron。
 *
 * 为什么自己画而不用 `NavbarBackLink` 的 `text=` 隐藏图标：
 *   它内部 `<BackIcon>` 是**实心填充**的（path 直接 fill），
 *   在 retina 上放大看是一条粗黑的三角，与 iOS 15+ 的
 *   「‹ 浅色细箭头」完全是两种东西。用户要的是后者。
 *
 * ⚠️ 尺寸 12×20 与 Konsta 原图标一致 ⇒ 换图标**不改变布局几何**
 *    （`<a>` 44×44 由 padding + h-full 决定，不由这个 svg 决定）。
 * ⚠️ 用 `stroke` 而不是 `fill`，`strokeWidth={2}`：
 *    在 20px 高的图标上，1.9~2.2 是 iOS 系统返回箭头的实际粗细区间。
 */
function QFBackChevron() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="20"
      viewBox="0 0 12 20"
      fill="none"
      aria-hidden="true"
      data-testid="qf-back-chevron"
    >
      <path
        d="M10.2 2.6 L2.6 10 L10.2 17.4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
  /**
   * R2.2.1 第十二条：**在所有页面上统一浏览器标题**。
   *
   * 为什么挂在 `PageHeader` 而不是每个页面各写一行 `useEffect`：
   *   移动端有十来个页面，逐页添加时只要漏一个，那个页面的浏览器标签、
   *   以及 iOS「添加到主屏」后弹出的快捷方式名就会退回 `index.html` 里的
   *   `<title>服务工作台</title>` —— 而这种事**不会报错**，只能靠人偶然看见。
   *   挂在唯一的公共入口上，就不存在"新加的页面忘了写"。
   *
   * ⚠️ 只在 `title` 是字符串时同步：`PageHeader` 的 `title` 允许 ReactNode
   *    （如工单号徽标），那种情况取不到文案，保持上一个标题比塞进
   *    `[object Object]` 好。根级无返回页面用「七方上门服务」，有返回的
   *    子页面用「页面名 · 七方上门服务」。
   */
  const titleText = typeof title === 'string' ? title.trim() : '';
  useEffect(() => {
    if (!titleText) return;
    document.title = pageTitle(titleText);
  }, [titleText]);

  const handleBack = () => {
    if (onBack) return onBack();
    if (history.length > 1) history.back();
    else navigate('/');
  };

  return (
    <Navbar
      title={title}
      subtitle={subtitle}
      left={
        back ? (
          /**
           * ⚠️ `text` 传入但 `showText` 不传 ⇒ Konsta 不会渲染文字
           *    （`{showText && <span>{text}</span>}`），只用于无障碍标签与
           *    "这是个返回链接"的语义。
           *
           * 🔴 这里**必须**用 `children` 而不是 `text` 当作视觉内容 ——
           *    `NavbarBackLink` 的结构是 `[<span>{内置 BackIcon}</span>, ...children]`，
           *    内置图标**没有任何 prop 能关掉**。第一版我传了 children 又没管内置图标，
           *    实测截图里出现**两个箭头**（先量了 `^.k-navbar-back-link svg path[d^="M10.6737904"]`
           *    仍有 1 个 ⇒ 证明内置图标还在）。判据是"图标个数"，不是"看起来对不对"。
           *
           * ⇒ 用父级 `[&>span:first-child]:hidden` 精确藏掉**那一个**内置图标 span：
           *     · 不用全局 CSS（用户明令"只改移动端现有相关按钮组件"）；
           *     · 不用 `text-[0px]` / `opacity-0` 之类会让它仍占位或仍可读的写法；
           *     · 选择器钉在 `.k-navbar-back-link` 内部，别的 Glass/Popover 不受影响。
           *   `[&>...]` 的产物类名里含 `>`，Tailwind 已安全转义，实测生效。
           */
          <NavbarBackLink
            text="返回"
            className="text-svc-brand-text [&>span:first-child]:hidden"
            onClick={handleBack}
          >
            <QFBackChevron />
          </NavbarBackLink>
        ) : undefined
      }
      right={right}
      /**
       * 🔴 R2.2.1：Konsta 的 subtitle 类里写死了 `leading-none`（line-height: 1）+
       *    `text-sm`（14px）+ `opacity-75`，三个都不合本项目 Token：
       *      · 14px 不在封闭字号集合里（{12,13,15,17,20,28}）；
       *      · line-height:1 在中文里会把「档案号 DA-20261109-0009」的下沿切掉一点点，
       *        因为中文有字身框（em box）大于字形的情况，iOS 中文本该 1.2~1.3。
       *      · opacity-75 把 #636366 压到 3.4:1（白底不达标，需 4.5:1）。
       *    `subtitleClassName` 是 Konsta **留出的唯一口子**（`subtitle: cls('leading-none', subtitleClassName)`），
       *    它拼在 `text-sm` 后面 ⇒ 同为工具类，后者胜出。所以这里能真实覆盖。
       */
      /**
       * 🔴 R2.2.2 封版裁决（§二）：「返回按钮仍有明显的圆形底色和悬浮阴影，
       *    调整为经典 iOS 浅色风格的简洁返回箭头。取消装饰性阴影与玻璃质感，
       *    不使用 backdrop-filter。」
       *
       * 罪魁不是我们的 CSS，是 **Konsta 的 Navbar 自己**包了一层：
       *   `Navbar.js:190` → `<Glass className={c.left}>{left}</Glass>`
       * `Glass` 在 iOS 下无条件加：
       *   `rounded-full bg-ios-light-glass shadow-ios-light-glass backdrop-blur-lg`
       * 实测那一层是 **44×44、bg rgba(255,255,255,.75)、radius 极大值**
       * —— 正好是用户看到的那颗"玻璃圆球"。
       *
       * ⇒ 修法：用 `leftClassName`（Konsta 留的口子，`cls(leftClassName || leftClass)`
       *   拼在 c.left 后面，同为工具类、后者胜出）把三者抹平。
       *     · `shadow-none`      —— 去掉悬浮阴影
       *     · `bg-transparent`   —— 去掉 75% 白玻璃底
       *     · `backdrop-blur-0`  —— 不用毛玻璃（全局虽已封死 `backdrop-filter`，
       *                              但类名留着就等于"语义上还想要玻璃"，下一个
       *                              解除封锁的人会立刻复现这个圆球）
       *     · `rounded-none`     —— 圆角一并去掉，避免高亮态又冒出一个圆
       *
       * ⚠️ **只改移动端这个按钮组件**（`PageHeader`），不做全局 CSS 覆盖
       *    —— 用户明令。其它页面的 Glass 用法（Popover / Dialog）不受影响。
       * ⚠️ 不动返回路由与导航逻辑：`handleBack` 一个字没改。
       * ⚠️ 44×44 点击区不靠这层撑：`<a>` 自己就是 `px-4 h-full max-h-12`
       *    + `justify-center items-center`，实测 44×44（改前改后一致）。
       */
      leftClassName="bg-transparent shadow-none backdrop-blur-0 rounded-none"
      /**
       * 🔴 R2.2.5 §四：`right` 槽位**同样**会被 Konsta 包一层 `Glass`。
       *
       *    上面那段长注释（R2.2.2 封版裁决）只修了 `leftClassName`，
       *    于是详情页右上角的「编辑档案」一挂上去，立刻冒出一颗
       *    **白色圆球 + 悬浮阴影**（`Glass` 的
       *    `rounded-full bg-ios-light-glass shadow-ios-light-glass backdrop-blur-lg`）。
       *    390px 截图里非常显眼 —— 正是用户明确禁止的"圆球 / 浮动玻璃"。
       *
       *    ⇒ 与左侧同口径：透明底、无阴影、无模糊、无圆角。
       *    ⚠️ 这不是"顺手美化"，是**同一个缺陷在两处只修了一处**。
       *       `right` 是最近才被真正用起来的槽位，修左侧时它还不存在。
       */
      rightClassName="bg-transparent shadow-none backdrop-blur-0 rounded-none"
      subtitleClassName="qf-foot leading-[17px] opacity-100 text-svc-ink-3 font-normal"
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
