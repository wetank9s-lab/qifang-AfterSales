/**
 * 路由分发。
 *
 * ===========================================================================
 * 只做三件事，一件都别多加
 * ===========================================================================
 *   ① 把 `route.name` 映到页面组件；
 *   ② 用 `<SessionProvider>` 包住需要登录的分支；
 *   ③ 未登录时统一落到登录页。
 *
 *   **不在这里写业务逻辑**、不判权限（权限判断在页面里按 `caps` 决定"显示什么"，
 *   真实裁决在服务端）、不做数据预取。
 *
 * ===========================================================================
 * 三类路由，处理方式完全不同
 * ===========================================================================
 *   · **匿名路由**（`/poc`、`/archive-query`、`/components`）：
 *       不包 SessionProvider 之外的守卫，未登录也能进。
 *       客户查询本来就是匿名功能；组件展厅是开发期工具，
 *       它**没有任何业务数据**，所以不登录也能看。
 *       ⚠️ 但 `/components` 在**生产构建**下要被挡掉 —— 见 `GALLERY_ENABLED`。
 *
 *   · **需要登录的路由**（其余全部）：未登录 ⇒ 登录页。
 *
 *   · **not-found**：不静默回首页。
 *       静默回首页会让一条旧链接（比如被改过名的 `/m/orders/1`）看起来"能打开"，
 *       而用户以为自己在看某条数据，实际看的是工作台 —— 那种错觉比 404 危险。
 */

import { useEffect } from 'react';
import { MOBILE_BRAND, pageTitle } from './brand';
import { useRoute, navigate, type RouteState } from './router';
import { SessionProvider, useSession } from './app/session-context';
import { AppShell, PageHeader } from './components/AppShell';
import { EmptyState, LoadingState } from './components/Feedback';
import PocPage from './pages/PoC';
import { LoginPage } from './pages/Login';
import { HomePage } from './pages/Home';
import { TicketListPage } from './pages/TicketList';
import { TicketDetailPage } from './pages/TicketDetail';
import { ArchiveListPage } from './pages/ArchiveList';
import { ArchiveNewPage } from './pages/ArchiveNew';
import { ArchiveDetailPage } from './pages/ArchiveDetail';
import { ArchiveQueryPage } from './pages/ArchiveQuery';
import { ServiceSearchPage } from './pages/ServiceSearch';
import { ComponentGalleryPage } from './pages/ComponentGallery';

/**
 * 组件展厅的开放条件：**开发态**，或构建时显式 `VITE_ENABLE_GALLERY=1`。
 *
 * ===========================================================================
 * 🔴 2026-11-14 收紧：删掉了 `?gallery=1` 这条 URL 开关
 * ===========================================================================
 *   它原本是为了让 `scripts/ui-verify.mjs` 能对**生产产物**跑展厅自检
 *   （`vite build` 同一个 dist、同样的分包压缩 —— "验过的就是上线的"）。
 *   这个目的本身是对的，但用 URL 参数实现它，等于：
 *     · **任何拿到地址的人**（员工、客户、路过的人）都能打开 `/m/components?gallery=1`；
 *     · 用户第七节明令："组件展厅**仅用于内部开发和设计验收，不应作为普通员工或客户入口**"。
 *   ⇒ 换一种同样能达到"生产构建可被验收"、但不留下公开入口的办法：
 *     由**验收脚本在构建时**设 `VITE_ENABLE_GALLERY=1`（见 ui-verify 的构建契约），
 *     开关在编译期被 `define` 成常量，产物里**没有**这个入口 ——
 *     不构建那个版本，门就是关着的。
 *
 *   为什么不再保留 `import.meta.env.DEV` 之外的第二条运行时判断：
 *     运行时能判断的东西，就一定能被绕过（改 localStorage / 拼 query / 改 UA）。
 *     展厅的开放与否应当是**编译期决定**，而不是**请求期决定**。
 */
function galleryEnabled(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_ENABLE_GALLERY === '1';
}

/** 匿名可访问的路由（不需要登录态） */
const ANON_ROUTES = new Set<RouteState['name']>(['archive-query', 'poc', 'components']);

export function AppRouter() {
  const route = useRoute();

  // PoC 页自带 <App>，且必须在"任何会话逻辑"之外：
  // 它的作用是证明 Konsta 能跑，不该因为登录态而看不到。
  if (route.name === 'poc') return <PocPage />;

  if (route.name === 'components' && galleryEnabled()) return <ComponentGalleryPage />;

  return (
    <SessionProvider>
      <RouteGuard route={route} />
    </SessionProvider>
  );
}

function RouteGuard({ route }: { route: RouteState }) {
  const { status } = useSession();

  /**
   * `booting` 时**不要**渲染登录页。
   *
   * 有 token 的用户刷新页面时，`auth:check` 还在飞（本地 nginx 约 200–400ms）。
   * 这一帧若渲染登录页，用户会看到"登录页闪一下然后跳进工作台" ——
   * 那会被读成"我掉线了"，然后他真的去重输密码。
   * ⇒ 引导期只给一个骨架，不给任何可点的入口。
   */
  if (status === 'booting') {
    return (
      <AppShell>
        <LoadingState rows={3} label="正在恢复登录状态…" />
      </AppShell>
    );
  }

  const needAuth = !ANON_ROUTES.has(route.name);

  if (needAuth && status === 'anonymous') {
    return <LoginPage />;
  }

  return <RouteView route={route} />;
}

function RouteView({ route }: { route: RouteState }) {
  switch (route.name) {
    case 'home':
      return <RoleHome />;

    case 'search':
      return <ServiceSearchPage />;

    case 'tickets':
      return <TicketListPage />;

    case 'ticket-detail':
      return <TicketDetailPage id={route.params.id!} />;

    case 'archives':
      return <ArchiveListPage />;

    case 'archive-new':
      return <ArchiveNewPage presetType={route.params.type} />;

    case 'archive-detail':
      return <ArchiveDetailPage id={route.params.id!} />;

    case 'archive-query':
      return <ArchiveQueryPage />;

    case 'components':
      // 走到这里说明是生产构建 + GALLERY_ENABLED 为假
      return <RouteNotFound hint="组件展厅只在开发环境开放" />;

    default:
      return <RouteNotFound />;
  }
}

/**
 * 首页按角色分流。
 *
 * ⚠️ 这是**导航分流**，不是权限分流：
 *    销售没有工单入口、售后没有建档入口 —— 与服务端能力矩阵一致。
 *    即便这里分流写错，用户点进无权的页面也只会看到"没有权限"，
 *    不会拿到数据（服务端每个请求都重新裁）。
 *
 * 无任何业务角色的账号（比如只挂了 admin 之外的空角色）⇒ 空态，
 * 而不是"随便给一个能看的页面"——那会让人误以为自己有那个岗位的权限。
 *
 * ===========================================================================
 * ⚠️ 销售的 `/` 必须 **replace 到 `/archives`**，不能直接渲染档案列表
 * ===========================================================================
 *   整改前这里是 `if (caps.archives) return <ArchiveListPage />`，
 *   于是销售账号的 `/` 与 `/archives` 渲染**同一个组件**：
 *     · 两个 URL 给出逐字节相同的页面（DEV-239 的截图哈希四组全同）；
 *     · 地址栏停在 `/`，而页面标题是"服务档案" —— 用户复制链接发同事，
 *       同事打开落到 `/`，看不出这是"档案"这个工作区；
 *     · 底栏（当时只有"档案"一项）高亮在"档案"，但 URL 是 `/` ——
 *       地址与高亮不一致，刷新后仍不一致。
 *   ⇒ 一个工作区就该只有一个地址。用 `replace`（不是 `push`）：
 *     用户按返回键不该回到一个自己刚刚被弹走的中间态。
 */
function RoleHome() {
  const { caps, user } = useSession();

  if (caps.tickets) return <HomePage />;

  /**
   * 销售：只有一个工作区（服务档案）⇒ 直接把 `/` 归一到 `/archives`。
   *
   * ⚠️ 重定向必须发生在**副作用里**（`useEffect`），不能在渲染期调 `navigate`
   *    —— 渲染期改 history 会在 React 严格模式下执行两次，
   *    而且此时组件还没提交，`popstate` 监听可能还没挂上。
   *    ⇒ 渲染期只给一个骨架，重定向交给 effect。
   */
  if (caps.archives) return <RedirectHome to="/archives" />;

  return (
    <AppShell>
      <PageHeader title={MOBILE_BRAND} subtitle={user?.nickname || undefined} />
      <EmptyState
        title="当前账号没有可用的工作台"
        description="这个账号还没有分配门店业务角色。请联系门店负责人或总部管理员开通「门店销售 / 门店售后 / 门店负责人」中的至少一个。"
      />
    </AppShell>
  );
}

/**
 * 把 `/` 归一到真正的首页。
 *
 * ⚠️ 用 `replace: true`：`/` 不是一个"用户去过的地方"，它只是入口别名。
 *    若用 push，用户按一次返回会回到 `/`，而 `/` 立刻又把他弹回 `/archives`
 *    —— 表现为"返回键坏了"（按了没反应，或闪一下又回来）。
 */
function RedirectHome({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to]);

  return (
    <AppShell>
      <LoadingState rows={3} />
    </AppShell>
  );
}

function RouteNotFound({ hint }: { hint?: string }) {
  // 外部深链接打开时 history.length 只有 1，返回首页必须能真的走
  useEffect(() => {
    document.title = pageTitle('页面不存在');
  }, []);

  return (
    <AppShell>
      <PageHeader title="页面不存在" back />
      <EmptyState
        title="这个地址没有对应的页面"
        description={hint ?? '链接可能已经失效，或者被手输错了。可以回到工作台重新进入。'}
      />
      <div className="px-6">
        <button
          className="text-svc-brand min-h-touch w-full qf-foot"
          onClick={() => navigate('/')}
          data-testid="notfound-home"
        >
          回到工作台
        </button>
      </div>
    </AppShell>
  );
}
