/**
 * B-35R · 角色切换后的移动端入口修复（ARC-V1）
 * ===========================================================================
 * 问题（已由 B-35 只读定位确证）
 * ---------------------------------------------------------------------------
 *   档案页 `n5c25yq5qlt` 的根模型在 `flowModels` 里被**钉死**：
 *
 *     options = { parentId:"n5c25yq5qlt", subKey:"page", use:"MobileRootPageModel" }
 *
 *   这个字段**不跟布局走** —— 运行时请求 `/api/flowModels:findOne?parentId=...`
 *   压根没有 layout 参数。而 `MobileRootPageModel` 只注册在 client-v2 运行时
 *   （`plugin-ui-layout/dist/client-v2/index.js` 的 `registerModelLoaders`），
 *   桌面运行时（`dist/client/index.js`，依赖 `@nocobase/client` v1）里没有这个类。
 *
 *   ⇒ 于是在桌面布局下打开 `/admin/<uid>` 必然报
 *       Model class 'MobileRootPageModel' not found.
 *
 *   而 B-34 给这条路由补挂了 `admin-layout-model` 归属之后，`store_sales`
 *   在 admin 布局下从 0 条变成 2 条 ⇒ 切换角色后前端取第一个可见 flowPage
 *   ⇒ 被导航到 `/admin/n5c25yq5qlt` ⇒ 撞上报错。
 *
 * ===========================================================================
 * 本模块做什么（方案 3：最小前端导航修补）
 * ---------------------------------------------------------------------------
 *   在**不改变服务端 ACL** 的前提下，按服务端事实判断"这个角色在桌面端无首页可用"，
 *   然后把它送到该角色**确实有权访问**的移动端页面上。
 *
 * ===========================================================================
 * 判据（全部来自服务端，不硬编码角色名、不硬编码用户 ID）
 * ---------------------------------------------------------------------------
 *   触发跳转必须**同时**满足下面四条，缺一不跳：
 *
 *     ① 当前角色在 admin 布局下**没有任何"桌面可用的业务首页"**。
 *        实现上不是简单看"条数为 0" —— 因为 B-34 之后条数可能不是 0，
 *        但那些页面**本身就属于移动端**（根模型是 MobileRootPageModel），
 *        在桌面端根本打不开。所以判据是：
 *        该角色在 admin 布局下可见的路由里，**不存在任何一个"非移动端根模型"的 flowPage**。
 *
 *     ② 当前角色在 mobile 布局下**确实有**可访问的 flowPage（目标页面的来源）。
 *
 *     ③ 目标的移动端路径**可以在 client-v2 运行时正确解析**（即目标来自 mobile 布局的返回，
 *        而不是我们凭空拼的）。目标取 mobile 布局返回里第一个 flowPage 的 schemaUid，
 *        拼成 `/v/mobile/<schemaUid>` —— 这个前缀取自 `uiLayouts.routePath`，不写死。
 *
 *     ④ 当前**不在**目标路径上（避免重定向循环）。
 *
 *   ⚠️ 第①条是关键：它保证了"只在桌面端真的没东西可用时才跳"。
 *      `store_after_sales`（20 条桌面业务路由）、`hq_admin`（27 条）都**不会**触发，
 *      因为它们在 admin 布局下有大量非移动端 flowPage。
 *
 * ===========================================================================
 * 为什么是"前端跳转"而不是"绕过 ACL"
 * ---------------------------------------------------------------------------
 *   目标页面的可见性仍然由 `desktopRoutes:listAccessible?layout=mobile-layout-model`
 *   决定 —— 它返回什么才跳什么。**服务端说不可见，这里就什么都不做。**
 *   前端只是把用户送到他本来就有权访问的地址，没有放行任何新东西。
 *
 * ===========================================================================
 * 安全约束（本项目铁律）
 * ---------------------------------------------------------------------------
 *   · `install()` **绝不抛出**：它在 SPA 启动关键路径上，抛错就是整页白屏。
 *   · 不做任何写操作：只调用两个只读接口 + 宿主 router 的导航。
 *   · 优先用宿主 **DataRouter.navigate(target, { replace: true })** 做真实导航。
 *     `history.replaceState` + 手派 `popstate` 是**降级路径**（取不到 router 时），
 *     因为 React Router v6 的 DataRouter 不监听 `popstate` 来更新自己的状态：
 *     `replaceState` 只改了浏览器地址栏，Router 内部 state 仍是旧值，
 *     下一次渲染会把地址栏**改回去**，表现为"看起来跳了其实没跳"。
 *   · 用 replace 语义：不在浏览器历史里留一条会产生循环的中间记录。
 *   · 只在**角色变化**或**首次加载**时判断一次，不在每次路由变化时反复查。
 *   · 有任何异常一律静默降级为"不跳"，并留一行可定位日志。
 */

/** 响应形状里只用到这几个字段，刻意收窄，避免把整个返回当 any 乱穿。 */
export interface RouteNode {
  id?: number | string;
  type?: string;
  schemaUid?: string;
  children?: RouteNode[];
}

export interface RoleEntryRedirectOptions {
  /** 宿主 apiClient（用于只读查询 listAccessible） */
  apiClient: any;
  /** 布局 uid 列表，默认取官方两个内置布局 */
  adminLayoutUid?: string;
  mobileLayoutUid?: string;
  /** 移动端路径前缀，默认 `/v`（NocoBase 2.2 的 modern client prefix） */
  mobilePrefix?: string;
  /**
   * 移动布局的路由段，默认 `mobile`。
   * 生产值取自 `uiLayouts`：`uid=mobile-layout-model, layoutType=mobile, routeName=mobile, routePath=/mobile`。
   * 单独抽成参数是为了万一以后改布局 routePath 时不用改代码。
   */
  mobileRoutePath?: string;
  /** 读当前角色的函数（默认 localStorage.NOCOBASE_ROLE） */
  getCurrentRole?: () => string | null;
  /** 日志前缀 */
  tag?: string;
  /** 测试注入点：替代 window.setTimeout */
  setTimeoutImpl?: (fn: () => void, ms: number) => any;
}

const DEFAULT_ADMIN_LAYOUT = 'admin-layout-model';
const DEFAULT_MOBILE_LAYOUT = 'mobile-layout-model';
const DEFAULT_MOBILE_PREFIX = '/v';
/** 移动布局的 routePath 段（生产实测：uiLayouts.routePath = '/mobile'） */
const DEFAULT_MOBILE_ROUTE_PATH = 'mobile';

/**
 * 桌面端**无法渲染**的根模型类名。
 *
 * 来源（已取证）：
 *   · `plugin-ui-layout/dist/client-v2/index.js` 的绑定表
 *       { mobile: { rootPageModelClass: 'MobileRootPageModel',
 *                   childPageModelClass: 'MobileChildPageModel' } }
 *   · 桌面运行时 `dist/client/index.js` 只依赖 `@nocobase/client`(v1)，不含这两个类。
 *
 * ⇒ 凡是根模型落在这一组里的页面，在桌面端必然 `not found`。
 */
const DESKTOP_UNRENDERABLE_ROOT_MODELS = ['MobileRootPageModel', 'MobileChildPageModel'];

/** 把 listAccessible 的树拍平成数组 */
function flatten(nodes: RouteNode[] | undefined, out: RouteNode[] = []): RouteNode[] {
  if (!Array.isArray(nodes)) return out;
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    out.push(n);
    if (Array.isArray(n.children) && n.children.length) flatten(n.children, out);
  }
  return out;
}

/** 只取有 schemaUid 的 flowPage（tabs / group 不是可导航页面） */
function flowPages(nodes: RouteNode[] | undefined): RouteNode[] {
  return flatten(nodes).filter(
    (n) => n.type === 'flowPage' && typeof n.schemaUid === 'string' && n.schemaUid.length > 0,
  );
}

function isMobileOnlyRootModel(modelName: string | undefined | null): boolean {
  if (!modelName) return false;
  return DESKTOP_UNRENDERABLE_ROOT_MODELS.indexOf(String(modelName)) >= 0;
}

/**
 * 从 React fiber 树里找出宿主的 DataRouter。
 *
 * 为什么要这么找（已取证，不是猜）：
 *   · NocoBase 2.2 桌面端用 React Router v6 的 **DataRouter**（`createBrowserRouter`），
 *     它的导航入口是 `router.navigate()`，**不通过** window 上的任何事件。
 *   · `window.app` 在 2.2 不存在（实测 `typeof window.app === 'undefined'`），
 *     所以拿 router 只能从 React 内部的 `memoizedProps.router` / `memoizedState` 里摸。
 *   · 摸到了才能做"真实导航"；摸不到就退回降级路径 —— 二者行为不同，日志里必须能区分。
 *
 * 返回 null 表示"这个运行时里没有 DataRouter 可拿"，调用方据此走降级。
 */
export function findHostRouter(): any | null {
  try {
    if (typeof document === 'undefined') return null;
    const rootEl: any =
      (document as any).getElementById && ((document as any).getElementById('root') || document.body);
    if (!rootEl) return null;

    const keys: string[] = Object.keys(rootEl).filter(
      (k: string) => k.indexOf('__reactContainer$') === 0 || k.indexOf('__reactFiber$') === 0,
    );
    if (!keys.length) return null;

    // `__reactContainer$` 上挂的就是 HostRoot fiber
    const containerKey = keys.filter((k) => k.indexOf('__reactContainer$') === 0)[0];
    let fiber: any = containerKey ? rootEl[containerKey] : null;
    if (!fiber) return null;

    const seen: any[] = [];
    const queue: any[] = [fiber];
    let guard = 0;

    while (queue.length && guard < 5000) {
      const node: any = queue.shift();
      guard += 1;
      if (!node || seen.indexOf(node) >= 0) continue;
      seen.push(node);

      const holders: any[] = [];
      if (node.memoizedProps) holders.push(node.memoizedProps);
      if (node.memoizedState) holders.push(node.memoizedState);

      for (let i = 0; i < holders.length; i += 1) {
        const h = holders[i];
        if (!h || typeof h !== 'object') continue;
        // 形态 A：直接在 props 上（useRoutes / RouterProvider 的注入）
        const direct = h.router;
        if (direct && typeof direct.navigate === 'function') return direct;
        // 形态 B：context 对象 { router }
        if (direct && typeof direct === 'object' && direct.router && typeof direct.router.navigate === 'function') {
          return direct.router;
        }
      }

      if (node.child) queue.push(node.child);
      if (node.sibling) queue.push(node.sibling);
    }
    return null;
  } catch {
    return null;
  }
}

export function installRoleEntryRedirect(options: RoleEntryRedirectOptions): () => void {
  const {
    apiClient,
    adminLayoutUid = DEFAULT_ADMIN_LAYOUT,
    mobileLayoutUid = DEFAULT_MOBILE_LAYOUT,
    mobilePrefix = DEFAULT_MOBILE_PREFIX,
    mobileRoutePath = DEFAULT_MOBILE_ROUTE_PATH,
    tag = '[service-ticket/role-entry]',
    setTimeoutImpl,
  } = options;

  // ---- 前置检查：任何一项不满足就整体不启用，而不是半启用 ----
  // ⚠️ 这里必须**出声**说明为什么没启用。曾经静默 return，
  //    结果"补丁没生效"和"补丁判定了不该跳"两种情况在日志上完全一样，无从区分。
  if (!apiClient || typeof apiClient.request !== 'function') {
    // eslint-disable-next-line no-console
    console.warn(`${tag} 未启用：apiClient 不可用（typeof=${typeof apiClient}）`);
    return () => {};
  }
  if (typeof window === 'undefined' || !window.location || !window.history) {
    // eslint-disable-next-line no-console
    console.warn(`${tag} 未启用：非浏览器环境`);
    return () => {};
  }
  // eslint-disable-next-line no-console
  console.info(`${tag} 已启用（admin=${adminLayoutUid} mobile=${mobileLayoutUid}）`);

  const setT: (fn: () => void, ms: number) => any =
    setTimeoutImpl || ((fn, ms) => window.setTimeout(fn, ms));

  const getRole =
    options.getCurrentRole ||
    (() => {
      try {
        return window.localStorage.getItem('NOCOBASE_ROLE');
      } catch {
        return null;
      }
    });

  let busy = false;
  let lastRole: string | null = null;
  let disposed = false;

  /**
   * 查某个 layout 下当前角色可见的路由。
   *
   * ⚠️ 必须走 `apiClient.request`（带登录态），不能用裸 fetch ——
   *    否则拿不到 Authorization，服务端按匿名处理，返回的可见集合是错的。
   *
   * 🔴🔴 **URL 里不能写 `/api/` 前缀。**
   *    客户端 `apiClient` 的 baseURL 已经是 `/api/`，再写一遍会拼成
   *    `/api/api/desktopRoutes:listAccessible` ⇒ **404**。
   *    这个坑本仓库已经踩过一次（见 `primary-action.tsx:173-175` 的长注释），
   *    B-35R 第一次浏览器验收又踩了同一个 —— 症状是补丁静默不生效：
   *    所有请求 404 → `decideAndRedirect` 抛异常 → 走 catch 分支"保持原状"，
   *    页面看着正常，只是永远不跳。
   *    ⇒ 只写资源路径本身：`desktopRoutes:listAccessible`。
   */
  const fetchVisible = async (layoutUid: string): Promise<RouteNode[]> => {
    const res = await apiClient.request({
      url: 'desktopRoutes:listAccessible',
      method: 'get',
      params: { tree: 'true', sort: 'sort', layout: layoutUid },
      // 这类"决定要不要跳转"的探测不必弹错误提示
      skipNotify: true,
    });
    /**
     * 🔴 **返回形状不能假设，必须实测。**
     *    `apiClient.request`（axios 封装）的拦截器可能已经解包过一层：
     *      · 若返回 `{ data: [...] }`   → 取 `res.data`
     *      · 若返回 `[...]`（已解包）   → 直接就是数组
     *    第一版写死 `(res as any)?.data`，遇到"已解包"就拿到 `undefined`
     *    ⇒ 判成 `mobile 无 flowPage` ⇒ 永远不跳，**且日志完全静默**。
     *    （B-35R 第二次浏览器验收捕获：curl 和页面内裸 fetch 都能拿到 1 条，
     *      只有走 apiClient 的那条路拿到 0 —— 差异就在解包层。）
     *    ⇒ 三种形态都认，并且**形状异常时出声**，不要静默返回空数组。
     */
    const raw: any = res;
    let data: any = raw;
    if (raw && !Array.isArray(raw) && raw.data !== undefined) data = raw.data;
    if (data && !Array.isArray(data) && Array.isArray(data.data)) data = data.data;
    if (!Array.isArray(data)) {
      // eslint-disable-next-line no-console
      console.warn(
        `${tag} listAccessible(${layoutUid}) 返回形状异常，按空处理。keys=${raw && typeof raw === 'object' ? Object.keys(raw).join(',') : typeof raw}`,
      );
      return [];
    }
    return data as RouteNode[];
  };

  /**
   * 查某一批 schemaUid 的**根模型类名**（use 字段）。
   *
   * 为什么要查：光看"条数"不够。B-34 之后 admin 布局下那 2 条**确实存在**，
   * 但它们的根模型是 MobileRootPageModel，桌面端打不开。
   * 只有查了 `use`，才能区分"有页面可用"和"有条目但打不开"。
   *
   * ⚠️ 同样不带 `/api/` 前缀（原因见 `fetchVisible`）。
   */
  const fetchRootModelNames = async (schemaUids: string[]): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    // 逐条查：flowModels:findOne 是按 (parentId, subKey) 定位的
    await Promise.all(
      schemaUids.map(async (uid) => {
        try {
          const res = await apiClient.request({
            url: 'flowModels:findOne',
            method: 'get',
            params: { parentId: uid, subKey: 'page' },
            skipNotify: true,
          });
          /**
           * 同上：不假设解包层。`findOne` 正常返回 `{ data: {...} }`，
           * 但拦截器可能已经解包成 `{...}`。两种都认；
           * 认不出 use 就**不记录**（= 根模型未知），调用方按"桌面可用"保守处理。
           */
          const raw: any = res;
          let opt: any = raw;
          if (raw && typeof raw === 'object' && !('use' in raw) && raw.data !== undefined) opt = raw.data;
          if (opt && typeof opt === 'object' && !('use' in opt) && opt.data !== undefined) opt = opt.data;
          const use = opt && typeof opt === 'object' ? opt.use : null;
          if (typeof use === 'string') out[uid] = use;
        } catch {
          // 查不到就不记录 ⇒ 该页面会被视为"根模型未知"
        }
      }),
    );
    return out;
  };

  /** 当前是否已经在目标路径 */
  const alreadyThere = (target: string): boolean => {
    const p = window.location.pathname || '/';
    return p === target || p === target.replace(/\/$/, '');
  };

  const decideAndRedirect = async (reason: string): Promise<void> => {
    if (busy || disposed) {
      // eslint-disable-next-line no-console
      console.info(`${tag} skip(${reason}) busy=${busy} disposed=${disposed}`);
      return;
    }
    const role = getRole();
    if (!role) {
      // eslint-disable-next-line no-console
      console.info(`${tag} skip(${reason}) 无当前角色`);
      return;
    }
    busy = true;
    try {
      // ---- ② 先看移动端：没有可去的页面就谈不上跳 ----
      const mobilePages = flowPages(await fetchVisible(mobileLayoutUid));
      if (mobilePages.length === 0) {
        // eslint-disable-next-line no-console
        console.info(`${tag} skip(${reason}) role=${role} mobile 无 flowPage ⇒ 不跳`);
        return;
      }

      // ---- ① 再看桌面端：是否存在"非移动端根模型"的 flowPage ----
      const adminPages = flowPages(await fetchVisible(adminLayoutUid));
      const adminUids = adminPages.map((p) => String(p.schemaUid));
      const adminRoots = await fetchRootModelNames(adminUids);

      /**
       * 判定"桌面端有可用首页"：
       *   · 根模型**不是**移动端专属模型；
       *   · 根模型**未知**（查不到）时**按"可用"处理** —— 保守。
       *     宁可让用户停在原地（可能报错），也不要把他从原本正常的桌面首页上赶走。
       */
      const hasDesktopUsable = adminPages.some((p) => {
        const use = adminRoots[String(p.schemaUid)];
        return !isMobileOnlyRootModel(use);
      });

      // eslint-disable-next-line no-console
      console.info(
        `${tag} eval(${reason}) role=${role} mobilePages=${mobilePages.length} adminPages=${adminPages.length} hasDesktopUsable=${hasDesktopUsable}`,
      );

      if (hasDesktopUsable) {
        // 桌面端有东西可用 ⇒ 一律不动。这是保证 store_after_sales / hq_admin 不受影响的关键。
        return;
      }

      // ---- ③ 目标来自 mobile 布局返回，不凭空拼 ----
      // 路径形态：`<mobilePrefix>/<routePath>/<schemaUid>`
      //   实测生产：/v/mobile/n5c25yq5qlt
      //   `routePath` 取自 `uiLayouts.routePath`（生产值 'mobile'），不是硬编码的业务名
      const target = `${mobilePrefix}/${mobileRoutePath}/${mobilePages[0].schemaUid}`;

      // ---- ④ 已在该路径则不跳（防循环）----
      if (alreadyThere(target)) return;

      // eslint-disable-next-line no-console
      console.info(`${tag} 角色 ${role} 在桌面布局下无可用首页，跳转到移动端入口（${reason}）：${target}`);

      /**
       * 导航。**这里必须跨运行时，所以只能用硬导航。**
       *
       * 🔴 关键事实（已实证，见 `p23-spa-check`）：
       *    `/admin` 与 `/v/` 是**两套完全独立的 SPA**：
       *      · /admin  → /assets/index-93181bbb.js       （@nocobase/client   v1）
       *      · /v/     → /v/assets/index-78f50a8e.js     （@nocobase/client-v2 v2）
       *    两套 HTML 不同、assets 不同、运行时不同。
       *
       *    ⇒ 在 v1 SPA 里调 **宿主 DataRouter.navigate('/v/mobile/...')** 是**错的**：
       *      v1 的 router 只认识 v1 的 routes，`/v/...` 不在其中 ⇒ 落到 v1 的 NotFound
       *      ⇒ 地址栏是 `/v/mobile/n5c25yq5qlt`，屏幕上却是「404 抱歉，你访问的页面不存在」。
       *      （实测：`Page.frameNavigated` 只有 /admin 一条，说明**从未发生真实页面跳转**，
       *        只是 v1 router 内部换了个不存在的 path。）
       *
       *    ⇒ 正确做法：`location.replace(target)` —— 浏览器发起一次真实文档导航，
       *      由服务端把 v2 的 HTML 送回来，v2 SPA 从零启动。
       *      用 `replace` 而非 `assign`：不在历史里留一条会产生循环的中间页。
       *
       *   ⚠️ 这个函数在 v1 与 v2 两个 lane 里共用，但**只有 v1 lane 会真正命中跳转逻辑**
       *      （v2 lane 的角色本来就在移动端，不需要跳）；即便如此，两个 lane 都走同一条
       *      硬导航路径，行为一致，不会出现"某一边悄悄用了 SPA 跳"。
       */
      window.location.replace(target);
      return;
    } catch (error: any) {
      /**
       * 🔴 这里曾经只写 `console.warn(tag, error)`，结果日志打印成一行 `J` ——
       *    压缩后连 message 都丢了，**故障被自己吞掉**：
       *    真实原因是所有请求 404（URL 多写了 `/api/`），
       *    但页面上什么都看不出来，只能靠抓 Network 才定位到。
       *    ⇒ 显式把 message / status / url 拎出来，让下一次排查不需要再抓包。
       */
      const detail = {
        msg: (error && (error.message || error.error)) || String(error),
        status: error && (error.status || error.statusCode),
        url: error && (error.url || (error.config && error.config.url)),
      };
      // eslint-disable-next-line no-console
      console.warn(`${tag} 判断失败，保持原状（不影响后台其余功能）：`, detail);
    } finally {
      busy = false;
    }
  };

  // ---------------------------------------------------------------------
  // 触发时机
  // ---------------------------------------------------------------------
  /**
   * ⚠️ 关于 `storage` 事件的重要事实（这一点曾被误用，记录在此避免重犯）：
   *   按 HTML 规范，`storage` 事件**只在其他浏览上下文**（其他标签页/iframe）修改
   *   localStorage 时触发，**本标签页自己改不会触发**。
   *   NocoBase 切角色是在**同一标签页**里写 `localStorage.NOCOBASE_ROLE`，
   *   所以**不能**依赖 `storage` 事件 —— 只监听它等于永远不触发。
   *
   * 真正可靠的信号是下面两条：
   *   A. 页面加载（切角色后 NocoBase 会 reload）⇒ 首次加载判断。
   *   B. 同页内角色被改写 ⇒ 劫持 `Storage.prototype.setItem` 主动通知。
   *      （这是同页内唯一能拿到通知的办法；只监控 NOCOBASE_ROLE 一个 key，影响面极小。）
   */

  // A. 首次加载：等 SPA 把路由与登录态都准备好再判断（立即判断会读到空角色）
  setT(() => void decideAndRedirect('首次加载'), 1500);

  // B. 同页角色变化：包一层 setItem，仅关心 NOCOBASE_ROLE
  let restoreSetItem: (() => void) | null = null;
  try {
    const proto: any = (window as any).Storage && (window as any).Storage.prototype;
    if (proto && typeof proto.setItem === 'function') {
      const original = proto.setItem;
      proto.setItem = function patchedSetItem(this: any, key: string, value: string) {
        const ret = original.call(this, key, value);
        try {
          if (key === 'NOCOBASE_ROLE' && value !== lastRole) {
            lastRole = value;
            void decideAndRedirect('角色变化(setItem 钩子)');
          }
        } catch {
          /* 通知失败绝不影响 setItem 本身 */
        }
        return ret;
      };
      restoreSetItem = () => {
        try {
          proto.setItem = original;
        } catch {
          /* ignore */
        }
      };
    }
  } catch {
    /* 拿不到 Storage.prototype：只保留 A 路径，不影响页面 */
  }

  // C. 兜底：从后台切回本标签页时补判一次（覆盖"在别的标签页切了角色"）
  const onVisible = () => {
    if ((document as any).visibilityState === 'visible') {
      const r = getRole();
      if (r && r !== lastRole) {
        lastRole = r;
        void decideAndRedirect('角色变化(visibility)');
      }
    }
  };
  (document as any).addEventListener('visibilitychange', onVisible);

  lastRole = getRole();

  // 返回卸载函数（宿主一般不会调，但留出干净的手）
  return () => {
    disposed = true;
    if (restoreSetItem) restoreSetItem();
    try {
      (document as any).removeEventListener('visibilitychange', onVisible);
    } catch {
      /* ignore */
    }
  };
}
