/**
 * 角色种子 —— 把 docs/API.md §4 的四个业务角色落进 NocoBase 的角色体系。
 *
 * 为什么必须真的建角色（而不是只在 PermissionService 里判断角色名）：
 *   1) 用户能"是"某个角色，靠的是 NocoBase 的 `rolesUsers` 关联；
 *      而 `setCurrentRole` 中间件只认 `users.roles` 关联读出来的角色名，
 *      角色不落 `roles` 表，用户就没法被赋这个角色，ctx.state.currentRoles 永远是空，
 *      PermissionService 拿到的角色列表也是空 → 数据范围恒为 none（什么也看不到）。
 *   2) ACL 的粗粒度判定（能不能调这个 action）读的是 `acl.roles`，
 *      它由 `acl.define()` 建立；不建角色则这些用户连后台列表都打不开。
 *
 * 落库分两处（NocoBase 自己的机制，缺一不可）：
 *   · `roles`             —— 角色本体（名称/中文名/snippets/allowConfigure）
 *   · `dataSourcesRoles`  —— **strategy** 的权威来源。`RoleModel.writeToAcl()` 里
 *     写 strategy 的分支被硬编码成 `withOutStrategy: true`（@nocobase/plugin-acl
 *     dist/server/server.js writeRoleToACL），真正调用 `role.setStrategy()`
 *     的是 `DataSourcesRolesModel.writeToAcl()`。只写 roles 表会出现
 *     "角色在后台看得见、但 ACL 里没有 strategy → 所有 action 都 403" 的怪现象。
 *
 * 另外，写完库后还会**显式**把角色刷进内存 ACL（`applyRoleToAcl`）：
 *   不依赖 DB 钩子是否被触发，部署完立即生效，也不必重启。
 *
 * 幂等语义：**只增不改**。已存在的角色/策略一律跳过，
 *   运营在后台调过的角色策略不会被重新部署冲掉。
 */
import {
  ROLE,
  ROLE_ACL_ACTIONS,
  ROLE_NATIVE_READ_ACTIONS,
  ROLE_NATIVE_READ_RESOURCES,
  ROLE_TITLE,
  type RoleName,
} from '../constants';

/**
 * 一个角色在某个资源上的授权条目（落 `dataSourcesRolesResources`）。
 *
 * 这是 NocoBase 判定的**第二级**：strategy.actions 只说明"这个 action 名整体允许"，
 * 具体到某个资源还得有一条资源级记录，否则该资源一律
 * `403 {"errors":[{"message":"No permissions"}]}`。
 */
export interface RoleResourceSeed {
  /** 资源名（= collection 名，如 serviceTickets） */
  resource: string;
  /** 该资源上放行的 action，如 ['list','get'] */
  actions: string[];
  /** 是否使用细粒度 action 配置（true = 只用 actions 里列的，不用 strategy 兜底） */
  usingActionsConfig: boolean;
}

export interface RoleSeed {
  name: RoleName;
  title: string;
  /** roles.description，后台角色管理页的说明文字 */
  description: string;
  /** 写入 NocoBase ACL 的 strategy.actions */
  actions: string[];
  /** 允许进入后台配置界面 */
  allowConfigure: boolean;
  /** 后台菜单/配置片段权限 */
  snippets: string[];
  /** 该角色在原生接口上的资源级只读授权（见 constants.ROLE_NATIVE_READ_*） */
  resources: RoleResourceSeed[];
}

/** 与内置 `admin` 角色一致：可进后台配置区 */
const PM_SNIPPETS = ['ui.*', 'pm', 'pm.*'];
/** 与内置 `member` 一致：进得了后台界面，但看不到配置区 */
const NO_PM_SNIPPETS = ['!ui.*', '!pm', '!pm.*'];

/**
 * 四个业务角色共享同一份"原生只读"资源授权。
 *
 * 为什么四个角色一模一样、还要逐角色各写一份（而不是共享一个常量引用）：
 *   NocoBase 的资源授权是**按角色**存的行，四个角色必须各有自己的行；
 *   共享引用只是省内存，反而会让"某角色单独放开一张表"这种运营调整
 *   在下次部署时被悄悄改回去。这里按值构造，语义就是"四个角色各自持有一份"。
 */
export function resourceSeedsOf(): RoleResourceSeed[] {
  return ROLE_NATIVE_READ_RESOURCES.map((resource) => ({
    resource,
    actions: [...ROLE_NATIVE_READ_ACTIONS],
    usingActionsConfig: true,
  }));
}

export const ROLE_SEEDS: RoleSeed[] = [
  {
    name: ROLE.STORE_AFTER_SALES,
    title: ROLE_TITLE[ROLE.STORE_AFTER_SALES],
    description: '门店售后：只能查看/处理被授权门店的工单（范围由 store_users 授权表决定）',
    actions: ROLE_ACL_ACTIONS[ROLE.STORE_AFTER_SALES],
    allowConfigure: false,
    snippets: NO_PM_SNIPPETS,
    resources: resourceSeedsOf(),
  },
  {
    name: ROLE.HQ_AFTER_SALES,
    title: ROLE_TITLE[ROLE.HQ_AFTER_SALES],
    description: '总部售后：全量数据，含强制转店与重开已关闭工单',
    actions: ROLE_ACL_ACTIONS[ROLE.HQ_AFTER_SALES],
    allowConfigure: false,
    snippets: NO_PM_SNIPPETS,
    resources: resourceSeedsOf(),
  },
  {
    name: ROLE.HQ_ADMIN,
    title: ROLE_TITLE[ROLE.HQ_ADMIN],
    description: '总部管理员：在总部售后能力之外，可维护参数/用户/门店并导出',
    actions: ROLE_ACL_ACTIONS[ROLE.HQ_ADMIN],
    allowConfigure: true,
    snippets: PM_SNIPPETS,
    resources: resourceSeedsOf(),
  },
  {
    name: ROLE.VIEWER,
    title: ROLE_TITLE[ROLE.VIEWER],
    description: '只读管理层：全量只读，手机号默认脱敏',
    actions: ROLE_ACL_ACTIONS[ROLE.VIEWER],
    allowConfigure: false,
    snippets: NO_PM_SNIPPETS,
    resources: resourceSeedsOf(),
  },
];

/** 供离线校验断言：角色条数必须等于常量里的角色数 */
export const ROLE_SEED_COUNT = ROLE_SEEDS.length;

/** 提交给 ACL 的 strategy（NocoBase 会包成 ACLAvailableStrategy） */
export function strategyOf(seed: RoleSeed): { actions: string[] } {
  return { actions: [...seed.actions] };
}
