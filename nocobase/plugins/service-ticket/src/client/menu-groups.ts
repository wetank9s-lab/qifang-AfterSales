/**
 * menu-groups.ts —— 后台左栏「虚拟分组」展示（R2.1.1）
 *
 * ===========================================================================
 * 为什么是"虚拟"分组，而不是原生 desktopRoutes 分组
 * ===========================================================================
 * 原生方案要动两件事：`desktopRoutes.parentId`（真实路由结构）+ `rolesDesktopRoutes`
 * （给六个角色逐个授权新组）。后果是"分组可见性 = 权限放大器"——
 * `listAccessible(tree:true)` 对被授权组会把**组下全部子页**递归展开且不再过滤，
 * 而生产 14 页的授权集合本就各不相同（3/4/5/6 角色都有），
 * 任何"多页共组"都会让某些角色凭空多看到页面。
 *
 * 用户 2026-11-17 裁决：**不接受扩大权限**，改为前端虚拟分组 ——
 *   · 路由 ID / URL / FlowModel / 角色授权 **一个都不改**；
 *   · 只把 `listAccessible` 已经返回的页（= 该角色**本来就有权看的页**）
 *     在前端按业务语义重新分桶展示；
 *   · 分组只是视觉容器，**不产生权限节点**，也不新增页面路由。
 *
 * ===========================================================================
 * 安全边界（这几条是硬约束，改代码前先读）
 * ===========================================================================
 *  ① **分组不产页**：桶里只会出现 `listAccessible` 已经给出的节点。
 *     本文件不构造任何新页面节点，因此不可能"让某人看到没授权的页"。
 *  ② **空桶自动隐藏**：某角色在"管理与设置"里一页都没有 ⇒ 该组整组不渲染。
 *     门店员工因此只看到自己有权限的组，与整改前看到的内容完全一样。
 *  ③ **失败即降级**：分桶出任何异常 ⇒ 原样返回未分组列表。
 *     菜单宁可"旧一点"也不能"出错空白"。
 *  ④ **不依赖 UID**：定位用 `title`（页面标题），不用 id/schemaUid。
 *     生产与本地 uid 不同构（实测：总部售后工作台 生产 qke3hyq3v92 / 本地 zku15hcn09u），
 *     任何写死 uid 的方案在换环境后都会静默失效。
 *
 * ===========================================================================
 * 为什么用 DOM 重组而不是覆写 layout 模型
 * ===========================================================================
 * 查过 2.2.15 客户端产物（`@nocobase/app/dist/client/assets/index-93181bbb.js`）：
 *   `toProLayoutRoute()` 返回的 `children` 每项最终由
 *   `rr()` 渲染，其中 `e._model ? 渲染菜单项 : 走降级分支 rl()` ——
 *   也就是说**菜单项必须带真实 flowModel 实例**。往 children 里塞"假分组节点"
 *   会掉进退化分支，渲染不出可折叠 submenu。
 * 要真做原生分组就得新增 flowModel + 路由（正是用户否掉的方案）。
 *
 * 因此这里采用与 `admin-style.ts` 一致的定位：**在视觉层重组已经渲染好的 DOM**。
 *   · 不碰 React 树、不碰路由、不碰权限；
 *   · 副作用只有"移动 <li> 的位置"，卸载即可还原；
 *   · 用 `data-*` 属性做幂等标记，重复执行不会叠加分组。
 *
 * ⚠️ 这一层的已知代价（写在这里，别以后当 bug 修）：
 *   DOM 重排后，antd Menu 的键盘顺序仍是原始顺序（视觉与 tab 序列可能不一致）。
 *   这是纯视觉层方案的固有取舍；比"扩权换分组"风险低得多。
 *
 * ===========================================================================
 * 导航为什么会**正常**（2026-11-18 实测澄清，曾误报过一次"点菜单不导航"）
 * ===========================================================================
 * 结论：**移动 <li> 不破坏导航**。生产 R2.1.1 与本地各实测 5/5 项全部正常跳转。
 *
 * 那次误报的根因在**测试方法**，不在产品。同一菜单项、四种触发方式对照：
 *   | 触发方式                                   | 结果 |
 *   |---|---|
 *   | 真实鼠标点 <a> 的中心点 / 右边缘            | 导航 |
 *   | JS 调 a.click()（DOM 原生 click）          | 导航 |
 *   | JS 调 .ant-menu-title-content 的 click()   | **不导航** |
 *   | JS 调 <li> 的 click()                      | **不导航** |
 *
 * 为什么后两种不导航 —— 这是 React 事件模型，不是本项目缺陷：
 *   ① 导航挂在 `<a>` 自己的 onClick 上（框架用 preventDefault + history 跳转）；
 *   ② 点 `<li>` 的**祖先**不会冒进 `<a>`（事件只向上冒泡）；
 *   ③ 点 `.ant-menu-title-content`（`<a>` 的**子元素**）时事件目标是子元素，
 *      React 的合成事件目标是=e.target，而框架的处理器只在目标就是 `<a>` 时才放行。
 *   ⇒ 只有"打到 <a> 本身"的点击才跳转，这正是真实用户点击的形态。
 *
 * ⇒ **以后验证菜单必须用真实鼠标事件**（CDP Input.dispatchMouseEvent 的
 *   mousePressed/mouseReleased），或对 `<a>` 调 `a.click()`。
 *   **不要**对 `<li>` / `.ant-menu-title-content` 调 `.click()` —— 那两条永远红，
 *   会把"测试写错"报成"产品坏了"。
 */

/** 分组定义 —— 顺序即展示顺序。`title` 是唯一键（不用 uid，理由见文件头 ④） */
export interface MenuGroup {
  key: string;
  title: string;
  /** 该组包含的页面标题（与 desktopRoutes.title 逐字一致） */
  pages: readonly string[];
}

/**
 * 日常业务：一线每天真正会点的 4 个。
 * 这 4 页在原菜单里本来就排在最前，归组后**顺序保持原样**（按此数组顺序重排）。
 *
 * R2.1.2（用户 2026-11-19）：由 6 个收敛为 **4 个** ——
 *   「派工记录」「工单事件时间线」移入管理与设置（它们是查询/审计页，不是一线日常操作）。
 */
export const GROUP_DAILY: MenuGroup = {
  key: 'daily',
  title: '日常业务',
  pages: [
    '售后服务工作台',
    '我的门店工单',
    '所有工单',
    '总部售后工作台',
  ],
};

/**
 * 管理与设置：配置类 **11 个**（R2.1.2 由 8 个扩至 10 个；R2.2.1 §八 增至 11 个）。
 * 低频，默认**折叠**——一线同事不用每天从这 11 项里划过。
 *
 * ⚠️ 这里只调整**导航分类**：`desktopRoutes` 的父子关系、`rolesDesktopRoutes`
 *    的角色授权、FlowModel 页面结构、API 权限**一个都不动**。
 *    某个角色看不到的页依然看不到（见本文件头 ① ②）。
 *
 * ⚠️ 加了新页却没在这里登记，界面表现是"页面存在、但在菜单里排到分组外面"——
 *    不报错、不白屏，最容易漏。反过来，**登记了但路由不存在**（没播种）时，
 *    这个标题永远匹配不上，分组里就少一项 —— 所以清单必须与
 *    `scripts/expected-sensitive-columns.mjs` 的 `REQUIRED_ADMIN_PAGES` 同步。
 */
export const GROUP_ADMIN: MenuGroup = {
  key: 'admin',
  title: '管理与设置',
  pages: [
    '派工记录',
    '工单事件时间线',
    '门店报修入口',
    '服务时效',
    '客户页面装修',
    '门店账号',
    '短信通知',
    '短信通知总览',
    '历史数据导入',
    '历史售后档案',
    // R2.2.1 §八：「施工阶段设置」（只授 hq_admin；其余角色看不到 ⇒ 与本文件头 ② 一致）
    '施工阶段设置',
  ],
};

export const MENU_GROUPS: readonly MenuGroup[] = [GROUP_DAILY, GROUP_ADMIN];

/** 不在任何组里的页面 → 保持原位不分组（避免"新加的页凭空消失"） */
export const GROUPED_TITLES: ReadonlySet<string> = new Set(
  MENU_GROUPS.flatMap((g) => [...g.pages]),
);

const MARK = 'data-svc-vgroup';

/**
 * 把左栏 `<li>` 按组重排。幂等：重复调用不会产生第二个分组容器。
 *
 * @param root 承载菜单的容器（默认整页，用 class 自己找）
 * @returns 统计信息，便于门禁断言（`groups` = 实际渲染出的组数）
 */
export function applyMenuGroups(root: any = document): {
  applied: boolean;
  groups: { title: string; count: number }[];
  reason?: string;
} {
  try {
    // ① 找侧栏菜单：只认 `.ant-layout-sider` 里的 ul.ant-menu。
    //    不用 `header` —— 顶部是"当前组"，侧栏才是成员列表。
    const sider = root.querySelector('.ant-layout-sider');
    if (!sider) return { applied: false, groups: [], reason: 'no-sider' };
    const menu = sider.querySelector('ul.ant-menu');
    if (!menu) return { applied: false, groups: [], reason: 'no-menu' };

    // ② 顶层 `<li>`：只取"叶子菜单项"和"已经是 submenu 的"，排除我们上次插进去的容器
    // ⚠️ 本插件刻意不声明 HTMLElement/Node 等 DOM 类型（见 types/ambient-stubs.d.ts
    //    末尾注释：避免把真拼错吞成 any）。所以这里一律用 any，不写类型谓词。
    const lis: any[] = Array.from(menu.children).filter(
      (n: any) => n && n.tagName === 'LI' && !n.hasAttribute(MARK),
    );
    if (!lis.length) return { applied: false, groups: [], reason: 'no-items' };

    // ③ 标题 → <li>（用菜单项自己的文本；`title` 在 antd 里可能是内层 span）
    const byTitle = new Map<string, any>();
    for (const li of lis) {
      const t = String(li.textContent || '').trim();
      if (t && !byTitle.has(t)) byTitle.set(t, li);
    }

    const out: { title: string; count: number }[] = [];
    let moved = 0;

    for (const g of MENU_GROUPS) {
      // ④ 只收集**当前角色真的能看见**的页。看不到的自动缺席 ⇒ 空组不渲染。
      const members: any[] = g.pages.map((p) => byTitle.get(p)).filter(Boolean);
      if (members.length === 0) continue; // ← 门店员工看不到任何一个管理页时走这里

      // ⑤ 已有同名容器 ⇒ 复用（幂等），否则新建
      let box: any = menu.querySelector(`li[${MARK}="${g.key}"]`);
      if (!box) {
        box = document.createElement('li');
        box.setAttribute(MARK, g.key);
        // 借用 antd 自己的 submenu 类名，样式与原生分组一致（不改 CSS 也能看）
        box.className = 'ant-menu-submenu ant-menu-submenu-inline ant-menu-submenu-vertical';
        box.innerHTML =
          '<div class="ant-menu-submenu-title" role="menuitem" tabindex="0">' +
          `<span class="ant-menu-title-content">${escapeHtml(g.title)}</span>` +
          '<span class="ant-menu-submenu-arrow"></span></div>' +
          '<ul class="ant-menu ant-menu-sub ant-menu-inline" role="menu"></ul>';
        menu.appendChild(box);
      }
      const sub: any = box.querySelector('ul.ant-menu-sub');
      if (!sub) continue;

      // ⑥ 把成员 <li> 移进桶里（保留原节点 = 保留原事件、原路由、原权限）
      for (const li of members) {
        if (li.parentElement !== sub) {
          sub.appendChild(li);
          moved += 1;
        }
      }
      out.push({ title: g.title, count: members.length });

      // ⑦ 管理与设置：默认折叠（低频）；日常业务：默认展开。
      //    R2.1.2 起「日常业务」只有 4 项，管理员打开后台就能直接看到全部四页，
      //    不需要先展开一次 —— 这正是用户要的"展开日常、折叠管理"。
      if (g.key === 'admin' && !box.dataset.userToggled) {
        box.classList.add('ant-menu-submenu-collapsed');
        sub.style.display = 'none';
        box.setAttribute('data-collapsed', '1');
      } else if (g.key !== 'admin') {
        box.classList.remove('ant-menu-submenu-collapsed');
        sub.style.display = '';
        box.removeAttribute('data-collapsed');
      }
    }

    return { applied: moved > 0 || out.length > 0, groups: out };
  } catch (e: any) {
    // ③ 失败即降级：不抛、不留半成品（分组容器都在最后 appendChild，
    //    异常时最多留下空容器，下一次 tick 会复用/补齐）
    return { applied: false, groups: [], reason: String(e?.message || e) };
  }
}

/**
 * 绑定分组的展开/折叠（事件委托，绑一次即可）。
 * 用委托而不是逐个绑：菜单会因路由切换重渲染，逐绑定会失效。
 */
export function bindMenuGroupToggle(doc: any = document): void {
  if (doc.body.hasAttribute('data-svc-vgroup-bound')) return;
  doc.body.setAttribute('data-svc-vgroup-bound', '1');
  doc.addEventListener('click', (ev) => {
    const t: any = ev.target;
    const head = t?.closest?.(`li[${MARK}] > .ant-menu-submenu-title`);
    if (!head) return;
    const box: any = head.parentElement;
    if (!box) return;
    const sub: any = box.querySelector('ul.ant-menu-sub');
    if (!sub) return;
    const collapsed = box.getAttribute('data-collapsed') === '1';
    box.setAttribute('data-collapsed', collapsed ? '0' : '1');
    box.dataset.userToggled = '1'; // 用户手动过就不再被默认值覆盖
    box.classList.toggle('ant-menu-submenu-collapsed', !collapsed);
    sub.style.display = collapsed ? '' : 'none';
  });
}

/**
 * 启动：等侧栏出现再应用，且路由切换后重放（SPA 不整页刷新，DOM 会重建）。
 * 用 MutationObserver 而不是 setInterval：菜单重建才会触发，空转代价低。
 */
export function startMenuGroups(): void {
  if (typeof document === 'undefined') return;
  bindMenuGroupToggle();
  let lastUrl = '';
  let timer: any = null;
  const tick = () => {
    // 路由变了 ⇒ 菜单可能重建，重置标记以便重新分桶
    if (location.pathname !== lastUrl) lastUrl = location.pathname;
    applyMenuGroups();
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; tick(); }, 120);
  };
  // 首次：等 SPA 渲染出侧栏（最多等 30s，之后放弃，不影响页面可用）
  let tries = 0;
  const boot = setInterval(() => {
    tries += 1;
    const r = applyMenuGroups();
    if (r.applied || tries > 150) {
      clearInterval(boot);
      // 之后靠 MutationObserver 跟随重建
      const mo = new MutationObserver(schedule);
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }, 200);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
