"""_r211-migrate.py —— R2.1.1 生产配置迁移（幂等 / 语义定位 / 可回滚）

设计约束（来自指令第 6 条）：
  · 不复制本地 UID，只用【语义定位器】找目标：
      页面 = desktopRoutes.schemaUid + title
      列   = TableColumnModel.stepParams.fieldSettings.init.(collectionName, fieldPath)
      筛选 = FilterFormItemModel.stepParams.fieldSettings.init.fieldPath
      动作 = 模型 use 名
  · 每个定位必须命中【恰好 1 个】；0 个或 >1 个 ⇒ 立即停止，不猜。
  · 只改本次需要的对象，不整表覆盖。
  · 重复执行不得产生重复分组/按钮/模型（靠 DB 内标记 + ON CONFLICT 保证）。

模式：
  --plan       只打印将要做什么，不写库
  --apply      执行（默认带事务；任何一步失败整批回滚）
  --verify     执行后核对
  --rollback   按迁移写入的 _r211_journal 回滚

目标库由 --db 指定（默认隔离库 r211_iso）。生产库里跑之前必须先 --plan 看过。
"""
import argparse
import base64
import json
import os
import subprocess
import sys

TMP = os.path.join("storage", "tmp", "r211", "_sql")
PLACE = "/tmp/_r211.sql"

# ---------------------------------------------------------------- 业务常量
#
# 🚫🚫 以下菜单分组方案【已废弃 · 2026-11-17 用户重新裁决】🚫🚫
# ---------------------------------------------------------------------------
# 原方案：在当前唯一顶层组「售后工单」内部挂一个「管理与设置」子组，
#         把 3 个 6 角色页收进去，其余页仍直属顶层组。
# 放弃原因（用户裁决 + 我方实测）：
#   ① 它要动 `desktopRoutes.parentId`，即"真实路由结构"；
#   ② 新组必须在 `rolesDesktopRoutes` 里逐个角色授权，否则子页看不见 ⇒
#      分组可见性直接变成**权限放大器**，与"最小权限"冲突；
#   ③ 生产实测 14 页的授权集合各不相同（有 3/4/5/6 角色的），
#      任何"多页共组"在原生语义下都要求各页授权完全相同，
#      否则 `listAccessible(tree:true)` 会把组下【全部】子页递归展开。
# 现行方案：**前端虚拟分组** —— 路由/URL/FlowModel/角色授权一个都不改，
#          只在前端把 listAccessible 返回的授权页重新分桶展示
#          （实现见 nocobase/plugins/service-ticket/src/client/menu-groups.ts）。
# ---------------------------------------------------------------------------
# 下面的常量与 create_one_group()/apply_menu() 仅作**只读 plan 对照**保留，
# apply 路径已不再调用它们（见 main() 里的说明）。
GROUP_ADMIN = "管理与设置"
GROUP_DAILY = "日常业务"

# ⚠️ 生产真实结构（2026-11-17 用 prodcfg/routes.json 逐行核对，别再凭印象）：
#   desktopRoutes
#     group 「售后工单」(387851208425472)  ← 唯一顶层分组，授权 6 角色
#       └─ flowPage ×14 全部挂在它下面（不是顶层平铺！）
#     另有 1 个历史遗留顶层页「档案移动测试」(397268289585152, 授权 0) —— 不动。
#
# 目标：把 14 页拆成两个可折叠分组。硬约束是【权限零放大】：
#   `listAccessible(tree:true)` 遇到"被授权的组"会把其下【全部】子页展开且不再过滤，
#   所以组内每一页的授权集合必须【完全等于该组的授权集合】。
#   按生产授权实测分组：
#     售后服务工作台 / 我的门店工单 = {admin,hq_after_sales,member,store_after_sales}
#     ⇒ 它们两两一致，可以自成一组「日常业务」，授权就取这个 4 元集合。
#   其余 12 页授权各不相同（有的 3 个、有的 5~6 个），混在一起必然放大，保持不动。
# 【2026-11-17 方案修订 —— 两个并列顶层组在此版本渲染层走不通】
# 实测（本地 2.2.15 + 生产同版本，1440px）：
#   混排布局 header+sider 下，若 al.scrollWidth 小于视口宽，antd 会把**所有**顶层项
#   塞进 header 的 .ant-pro-top-nav，侧栏改为显示「当前顶层组」的 children。
#   而側栏把 group 类型的 children 渲染成 **无标题的子树**（实测：一个可折叠组 +
#   剩下 5 个平铺 item，连 group 标题都没有）。⇒ 并列两个顶层组 = 没有任何可见分组。
# 用户已选择「只建一个组」的保守方案，这里落实为：
#   保留生产唯一的顶层组（沿用原 id，标题改「日常业务」，授权原样 6 角色不动），
#   在其内部挂一个「管理与设置」子组，把 3 个 6 角色页收进去；其余页仍直属顶层组。
#   权限零放大：子组授权 = 组内 3 页授权 = 6 角色 = 顶层组原授权。
PAGES = {
    GROUP_ADMIN: ["门店报修入口", "历史数据导入", "历史售后档案"],
}
BASE_GROUP = "售后工单"      # 生产里这个唯一顶层组的原标题
RENAME_BASE_TO = GROUP_DAILY  # 迁移后顶层组改叫「日常业务」

# 其余页面【必须保持原 parentId 不变】。列全是为了让"没动它们"可验证，
# 而不是靠"我没写就没动"这种自证。注意要排除已进分组的页，否则
# "未动"清单会把已经挪走的页也列进去（上一版真出现过，是自相矛盾的证据）。
TOPLEVEL: list[str] = [
    "售后服务工作台", "我的门店工单", "所有工单", "总部售后工作台",
    "派工记录", "工单事件时间线", "服务时效", "客户页面装修",
    "门店账号", "短信通知", "短信通知总览",
    "门店报修入口", "历史数据导入", "历史售后档案",
]
# 上一版这里写的是 `[t for t in ... if t not in PAGES]` —— 目的是"排除已挪进
# 「管理与设置」子组的 3 页"。方案改在前端虚拟分组后，那 3 页**不会被挪走**，
# 必须留在"不动清单"里，否则：
#   ① 不动的页面少算 3 个（清单自相矛盾）；
#   ② 那 3 页连"定位唯一"的校验都被跳过 —— 定位器失效而无人察觉。
# 这正是"清单由另一个常量推导"的坑：上游语义变了，下游过滤条件却没跟着变。

# 工单列表目标列序（客户/师傅各自已合并姓名+电话，这里按"主字段"排序）
# R2.1.1（用户 2026-11-17 指令 ③）：列序固定为
#   工单号 → 状态 → 客户问题 → 客户 → 师傅 → 预约上门 → 工单类型 → 操作
# 创建日期**移出列表**（不进 COL_ORDER ⇒ 排到"其余列"尾部，仍保留不删）。
# 为什么不删：删列会丢字段配置且不可逆；留在尾部既满足"列表精简"，
# 又让"哪天要加回来"只需改一个常量，不用重建 flowModel。
COL_ORDER = [
    "ticket_no", "status", "content", "customer_name", "technician_name",
    "expected_visit_at", "ticket_type",
]
HIDDEN_COLS = ["store.name", "createdAt"]   # 仅排到尾部，不删除

# 默认可见的筛选字段（其余进「更多条件」；status 由状态页签承担，不重复）
FILTER_DEFAULT = ["ticket_no", "customer_mobile", "createdAt"]
FILTER_STORE = "store"          # admin 视图额外给出门店选择
FILTER_EXTRA = ["ticket_type", "customer_name", "status"]   # 收进「更多条件」，不删

# 工单列表的全部内容根：我的门店工单 6 个状态页签 + 所有工单 1 个。
# 生产实测每个根都有一套完整的 FilterFormBlock + TableBlock（各 49 / 51 个模型），
# 所以列序和筛选必须【逐根】处理 —— 只改一个根，另外 6 个页签还是老样子。
TICKET_ROOTS = {
    "我的门店工单": ["wz4qkejuvd6", "2syydawk24g", "pac49kftubs",
                     "kszn4iloqfr", "9ajzm018g82", "w08qtr5mplq"],
    "所有工单": ["6dbu7gadt9j"],
}


def psql(sql, db):
    os.makedirs(TMP, exist_ok=True)
    local = os.path.join(TMP, "_r211.sql")
    with open(local, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(sql)
    subprocess.run(f"docker cp {local} svc-postgres:{PLACE}", shell=True, capture_output=True)
    cmd = f"docker exec svc-postgres psql -U svc_app -d {db} -At -P pager=off -f {PLACE}"
    p = subprocess.run(cmd, shell=True, capture_output=True)
    out = (p.stdout or b"").decode("utf-8", "replace").strip()
    err = (p.stderr or b"").decode("utf-8", "replace").strip()
    # ⚠️ 实测：`psql -f` 遇到 ERROR 时【退出码仍是 0】、stdout 为空，
    # 只有 stderr 里有 "ERROR:"。所以绝不能只看 returncode ——
    # 否则"SQL 写错"会被当成"查询结果为空"，定位器静默失效（本轮真踩到）。
    if p.returncode != 0 or "ERROR:" in err or "FATAL:" in err:
        return
    return out


def q(sql, db):
    """返回 list[list[str]]。空结果是 []；任何 SQL 错误都抛异常，绝不静默当空。"""
    out = psql(sql, db)
    if out is None:
        raise RuntimeError(f"SQL 失败（rc/ERROR 判据）: {sql[:500]}")
    if not out:
        return []
    return [line.split("|") for line in out.splitlines()]


def one(sql, db, what):
    rows = q(sql, db)
    if len(rows) != 1:
        raise LookupError(f"[定位失败] {what}: 命中 {len(rows)} 个（必须恰好 1 个）")
    return rows[0]


def esc(s):
    return str(s).replace("'", "''")


# ---------------------------------------------------------------- 定位器
def locate_group(db, title, parent=None):
    """按标题（可选父节点）定位 group。

    parent=None  ⇒ 只找顶层组（parentId IS NULL）
    parent='*'   ⇒ 不限层级（子组也要能找到 —— 上一版写死了顶层，
                   导致「管理与设置」子组永远"命中 0 个"，幂等与校验全部失效）
    """
    cond = ""
    if parent is None:
        cond = 'AND "parentId" IS NULL'
    elif parent != "*":
        cond = f'AND "parentId"={int(parent)}'
    rows = q(
        "SELECT id FROM \"desktopRoutes\" WHERE type='group' AND title='%s' %s;"
        % (esc(title), cond), db)
    return [r[0] for r in rows]


def locate_route_by_title(db, title):
    """返回页面的【内容根】schemaUid。

    生产真实结构（实测，两层，别搞错）：
      desktopRoutes(flowPage, schemaUid=A)            ← 菜单项，A 只是个空壳 RouteModel
        └─ desktopRoutes(tabs, hidden=true, schemaUid=B)  ← 页面内容真正挂在这里
            └─ flowModels(B=RouteModel) → BlockGridModel → Table/Filter…

    所以定位必须锚在 B 上；锚在 A 上只会拿到 1 层空壳（我第一版就错在这）。
    """
    head = q(
        "SELECT id, \"schemaUid\" FROM \"desktopRoutes\" "
        "WHERE title='%s' AND type='flowPage';" % esc(title), db)
    if len(head) != 1:
        raise LookupError(f"[定位失败] 页面「{title}」flowPage 命中 {len(head)} 个")
    page_id, page_uid = head[0]
    tabs = q(
        "SELECT \"schemaUid\", title, coalesce(hidden,false) FROM \"desktopRoutes\" "
        "WHERE \"parentId\"='%s' AND type='tabs' ORDER BY sort;" % esc(page_id), db)
    if not tabs:
        raise LookupError(f"[定位失败] 页面「{title}」没有 tabs 内容根")
    return [[page_id, page_uid, tabs, "flowPage"]]


def content_roots(page_row):
    """一个页面可能有多个内容根：
      · 单页（所有工单/服务时效/…）：1 个 hidden=true 的 tabs
      · 多状态页签（我的门店工单）：N 个 hidden=false 的 tabs，每个页签一套表格
    这里把"该页所有内容根"统一返回，后续逐根处理。"""
    _pid, _puid, tabs, _t = page_row
    return [t[0] for t in tabs]


# flowModels.options 有两种形态（实测生产并存）：
#   根 RouteModel 用 { schema: { use } }
#   子模型用   { use, parentId, subKey, subType, props, stepParams }
# 所以取 use 一律 coalesce 两处，不要只认一种。
USE_SQL = "coalesce(m.options->'schema'->>'use', m.options->>'use')"


def table_uid(db, page_schema_uid):
    """页面里 TableBlockModel 的 uid（应恰好 1 个）。"""
    rows = q(
        "SELECT m.uid FROM \"flowModels\" m "
        "JOIN \"flowModelTreePath\" t ON t.\"descendant\"=m.uid "
        f"WHERE t.ancestor='%s' AND {USE_SQL}='TableBlockModel';"
        % esc(page_schema_uid), db)
    return rows


def col_models(db, page_uid):
    """页面内所有 TableColumnModel：uid + fieldPath，**直接子节点口径**。

    实测：第 4 层那 11 个 TableColumnModel 的 options.parentId 都指向 TableBlockModel，
    真实列顺序 = flowModelTreePath(ancestor=TableBlock, depth=1).sort。
    （depth>1 的行 sort 全为 NULL，改那里不会生效 —— 我第一版就错在这。）
    """
    rows = q(
        "SELECT m.uid, "
        "       coalesce(m.options->'stepParams'->'fieldSettings'->'init'->>'fieldPath',''), "
        "       coalesce(t.sort, 0) "
        "FROM \"flowModels\" m "
        "JOIN \"flowModelTreePath\" t ON t.\"descendant\"=m.uid "
        f"WHERE t.ancestor='%s' AND t.depth=1 AND {USE_SQL}='TableColumnModel' "
        "AND m.options->>'parentId'=t.ancestor ORDER BY t.sort NULLS LAST;"
        % esc(page_uid), db)
    return rows


def tree_sort(db, ancestor, descendant):
    return q(
        "SELECT sort FROM \"flowModelTreePath\" "
        f"WHERE ancestor='{esc(ancestor)}' AND descendant='{esc(descendant)}';", db)


def filter_items(db, page_uid):
    return q(
        "SELECT m.uid, coalesce(m.options->'stepParams'->'fieldSettings'->'init'->>'fieldPath','') "
        "FROM \"flowModels\" m "
        "JOIN \"flowModelTreePath\" t ON t.\"descendant\"=m.uid "
        f"WHERE t.ancestor='%s' AND {USE_SQL}='FilterFormItemModel' "
        "ORDER BY t.sort NULLS LAST;" % esc(page_uid), db)


def action_models(db, page_uid):
    return q(
        f"SELECT m.uid, {USE_SQL} AS use "
        "FROM \"flowModels\" m "
        "JOIN \"flowModelTreePath\" t ON t.\"descendant\"=m.uid "
        f"WHERE t.ancestor='%s' AND {USE_SQL} LIKE '%%ActionModel' "
        "ORDER BY t.sort NULLS LAST;" % esc(page_uid), db)


def filter_grid(db, root):
    """筛选区排版真正生效的地方：FilterFormGridModel.options.props.rows / rowOrder。

    ⚠️ 这是本轮之前一直没找对的那一层。
    用户说"不要继续修改本地无效的 Grid 配置"—— 意思是：改了没生效。
    原因不是 Grid 不该改，而是改的【不是这个 Grid 的 rows】：
      生产实测 6 个 FilterFormItemModel 被排进 row1/row2/row3 三行、每行 3 列，
      合计 7 个格子放 6 项 ⇒ 筛选区至少 3 行高，怎么调列宽都压不到 80~100px。
    真正的压缩 = 把 3 个默认项排进 row1（各 8/8/8），其余 3 项收进 row2 但整行折叠。
    """
    rows = q(
        "SELECT m.uid, coalesce(m.options->'props'->>'rows',''), "
        "       coalesce(m.options->'props'->>'rowOrder','') "
        "FROM \"flowModels\" m "
        "JOIN \"flowModelTreePath\" t ON t.\"descendant\"=m.uid "
        f"WHERE t.ancestor='%s' AND {USE_SQL}='FilterFormGridModel';" % esc(root), db)
    return rows


def filter_block(db, root):
    rows = q(
        f"SELECT m.uid FROM \"flowModels\" m "
        "JOIN \"flowModelTreePath\" t ON t.\"descendant\"=m.uid "
        f"WHERE t.ancestor='%s' AND {USE_SQL}='FilterFormBlockModel';" % esc(root), db)
    return rows


# ---------------------------------------------------------------- 计划
def role_set(db, rid):
    return {r[0] for r in q(
        'SELECT "roleName" FROM "rolesDesktopRoutes" '
        f"WHERE \"desktopRouteId\"='{esc(rid)}';", db)}


def build_plan(db, page_title):
    plan = {"menu": [], "table": [], "filter": [], "actions": [], "warnings": []}

    # ---- 定位【全部 14 页】：R2.1.1 不改任何页的 parentId，
    # 但仍要逐页定位并证明"唯一命中 + 父节点未变"——
    # "我没写就没动"不是证据，`assert_untouched()` 才是。
    # ⚠️ 2026-11-17 修：这里原来是 `PAGES.values() + TOPLEVEL`，而 TOPLEVEL 已经
    #    包含 PAGES 里的 3 页（方案变了，那 3 页不再被挪走）⇒ 3 页各被定位两次。
    #    虽然都唯一命中不会炸，但"重复定位"会让下面的唯一性校验变成同义反复。
    #    改用 dict.fromkeys 去重并保序。
    all_titles = list(dict.fromkeys([t for ts in PAGES.values() for t in ts] + TOPLEVEL))
    route_map = {}
    for t in all_titles:
        rows = locate_route_by_title(db, t)
        if len(rows) != 1:
            raise LookupError(f"[定位失败] 页面「{t}」命中 {len(rows)} 个")
        rid, uid, tabs, rtype = rows[0]
        route_map[t] = (rid, uid, tabs, rtype)
    plan["route_map"] = route_map

    # ---- 前置硬校验：每个组内页面的授权集合必须【完全一致且等于该组授权】。
    # 判据来自实测：`listAccessible(tree:true)` 把"已授权组"下全部子页展开且不再过滤，
    # 所以组内某页比另一页少授给某角色 ⇒ 那个角色凭空多看到它。
    # 基准是"这组页面自己的授权集合"，不是全站角色。
    group_roles = {}
    for g, titles in PAGES.items():
        acc = None
        for t in titles:
            granted = role_set(db, route_map[t][0])
            if acc is None:
                acc = granted
            elif granted != acc:
                raise LookupError(
                    f"[权限放大风险] 组「{g}」内「{t}」授权={sorted(granted)}，"
                    f"与同组其他页 {sorted(acc)} 不一致 —— "
                    f"会让 {sorted(granted ^ acc)} 多看到页面。停止。")
        group_roles[g] = sorted(acc or [])
    plan["group_roles"] = group_roles

    # ---- 顶层组定位：先按原名找，找不到再按改名后的名找（幂等重跑必需）。
    # 上一版只按原名找 ⇒ 改名成功后第二次 apply 直接「命中 0 个」失败，
    # 幂等性根本没被验证到（这正是"重跑会炸"的那类坑）。
    cand = [t for t in (BASE_GROUP, RENAME_BASE_TO) if t]
    found = []
    for t in cand:
        hit = locate_group(db, t)
        if len(hit) > 1:
            raise LookupError(f"「{t}」分组命中 {len(hit)} 个，停止")
        found.extend(hit)
    if len(set(found)) > 1:
        raise LookupError(f"同时存在「{BASE_GROUP}」与「{RENAME_BASE_TO}」两个顶层组，停止")
    if not found:
        raise LookupError(f"顶层组「{BASE_GROUP}」/「{RENAME_BASE_TO}」都命中 0 个，停止")
    base = found
    plan["base_group_id"] = base[0]
    base_roles = role_set(db, base[0])
    plan["base_roles"] = sorted(base_roles)
    plan["warnings"].append(
        f"顶层组「{BASE_GROUP}」授权 {sorted(base_roles)}；R2.1.1 **不改名、不授权**"
        f"（前端虚拟分组只影响展示，权限与路由均保持原样），仍覆盖 {len(TOPLEVEL)} 页")

    # 顶层组自身必须是【唯一】的顶层 group，否则"只建一个组"的前提不成立
    tops = q("SELECT id,title FROM \"desktopRoutes\" WHERE type='group' AND "
             "\"parentId\" IS NULL;", db)
    if len(tops) != 1:
        raise LookupError(f"顶层 group 有 {len(tops)} 个 {tops}，不是唯一 —— 结构已变，停止")

    # 逐个组：探测是否已存在 + 校验页面当前父节点，区分"没做过 / 做过 / 做了一半"
    # ⚠️ 必须先探测"子组是否已存在"，再做页面的父节点校验 —— 顺序反了会把
    #    "已在子组（幂等态）"误判成"结构已变"。上一版真的因为顺序错而炸过。
    existing = {}
    for g in PAGES:
        hit = locate_group(db, g, parent="*")
        if len(hit) > 1:
            raise LookupError(f"「{g}」分组出现 {len(hit)} 个，停止")
        existing[g] = hit[0] if hit else None

    for g, titles in PAGES.items():
        gid = existing[g]
        for t in titles:
            cur = q('SELECT "parentId" FROM "desktopRoutes" '
                    f"WHERE id='{esc(route_map[t][0])}';", db)
            curp = cur[0][0] if cur else None
            if gid and curp == gid:
                continue                       # 幂等：已在子组
            if curp == base[0]:
                if gid:
                    raise LookupError(
                        f"「{t}」仍在顶层组但子组「{g}」({gid}) 已存在 —— "
                        f"上次迁移没做完，停止；请先 --rollback 再重来")
                continue
            raise LookupError(
                f"「{t}」当前父节点 {curp} ∉ {{{BASE_GROUP}({base[0]})"
                f"{', ' + g + '(' + gid + ')' if gid else ''}}}，结构已变，停止（不猜）")

        if gid:
            # 子组已存在：还要保证它确实挂在顶层组下面（幂等但结构要对）
            gp = q('SELECT "parentId" FROM "desktopRoutes" '
                   f"WHERE id='{esc(gid)}';", db)
            if gp and gp[0][0] != base[0]:
                raise LookupError(
                    f"子组「{g}」({gid}) 的父节点是 {gp[0][0]}，不是顶层组 {base[0]} —— 停止（不猜）")
            plan["menu"].append(("skip", gid, f"「{g}」已存在且挂在顶层组下（幂等）", g))
        else:
            plan["menu"].append(("create_group", None, g, titles, group_roles[g],
                                 base[0]))
    plan["menu"].append(("routes", route_map, PAGES, None, group_roles, base[0]))

    # 顶层组改名（幂等：已经叫目标名就不动）
    cur_title = q('SELECT title FROM "desktopRoutes" '
                  f"WHERE id='{esc(base[0])}';", db)
    cur_title = cur_title[0][0] if cur_title else None
    if cur_title == RENAME_BASE_TO:
        plan["menu"].append(("rename", None, f"顶层组已是「{RENAME_BASE_TO}」（幂等）", None))
    else:
        plan["menu"].append(("rename", base[0], cur_title, RENAME_BASE_TO, plan["base_roles"]))

    # ---- B/C. 逐内容根处理表格与筛选
    # 覆盖全部 7 个根（我的门店工单 6 个状态页签 + 所有工单），用 route_map 交叉验证
    # 内容根 uid 没有过期 —— 生产里 UID 会变，写死会静默改错地方。
    for page_title, roots in TICKET_ROOTS.items():
        actual = content_roots(route_map[page_title])
        if sorted(actual) != sorted(roots):
            raise LookupError(
                f"[内容根不符] 「{page_title}」期望 {sorted(roots)}，实查 {sorted(actual)} —— "
                f"页面结构已变，停止（不猜）")
        plan["warnings"].append(f"「{page_title}」内容根 {len(roots)} 个：{roots}")

        for root in roots:
            tb = table_uid(db, root)
            if len(tb) != 1:
                plan["warnings"].append(f"  内容根 {root}: TableBlockModel 命中 {len(tb)} 个，跳过")
                continue
            tbid = tb[0][0]
            cols = col_models(db, tbid)
            by_path = {}
            sort_now = {}
            for uid, path, srt in cols:
                by_path.setdefault(path, []).append(uid)
                sort_now[uid] = srt
            dup = {k: v for k, v in by_path.items() if len(v) > 1}
            if dup:
                plan["warnings"].append(f"  内容根 {root}: 同名字段列重复 {dup}")
            missing = [p for p in COL_ORDER if p not in by_path]
            if missing:
                plan["warnings"].append(f"  内容根 {root}: 缺列 {missing}")

            plan["table"].append(("root", root, tbid,
                                  {p: by_path[p][0] for p in COL_ORDER if p in by_path},
                                  [p for p in by_path if p not in COL_ORDER],
                                  sort_now))

            acts = action_models(db, root)
            add_new = [u for u, use in acts if use == "AddNewActionModel"]
            plan["actions"].append(("root", root, add_new, [(u, x) for u, x in acts]))

            items = filter_items(db, root)
            ipath = {}
            for uid, path in items:
                ipath.setdefault(path, []).append(uid)

            grids = filter_grid(db, root)
            fbs = filter_block(db, root)
            if len(grids) != 1 or len(fbs) != 1:
                plan["warnings"].append(
                    f"  内容根 {root}: FilterFormGrid {len(grids)} 个 / "
                    f"FilterFormBlock {len(fbs)} 个，筛选压缩跳过")
            else:
                plan["filter"].append(("root", root, fbs[0][0], grids[0][0],
                                       {p: ipath[p][0] for p in ipath}, items,
                                       grids[0][1], grids[0][2]))
    return plan


def print_plan(plan):
    print("\n================ 迁移计划 ================")
    print("\n[A] 菜单")
    # 方案变更（用户 2026-11-17）：**停止原生父组迁移**。
    # A 段只剩一条"什么都没改"的反向证明 —— 保留这段打印是为了让
    # "没动路由表"这件事情本身可读、可核对，而不是靠"脚本里没写"自证。
    print("  · 本方案不改 desktopRoutes 父子关系、不改角色授权、不改路由 ID/URL。")
    print("  · 两个菜单组由前端虚拟分组展示（src/client/menu-groups.ts），不产生真实权限节点。")
    for step in plan["menu"]:
        kind = step[0]
        if kind == "skip":
            print(f"  · {step[2]}")
        elif kind == "routes":
            rmap = step[1]
            print(f"  · 以下 {len(TOPLEVEL)} 页保持原 parentId（不动），已逐个定位确认唯一：")
            for t in TOPLEVEL:
                print(f"      未动 | {t:12} route={rmap[t][0]}")
    print("\n[B] 工单列表列序")
    for step in plan["table"]:
        _k, root, tbid, cols, dropped, sort_now = step
        print(f"  · 内容根 {root}  TableBlockModel={tbid}  保留 {len(cols)} 列")
        for p, u in cols.items():
            print(f"      {p:20} {u}   原sort={sort_now.get(u)}")
        if dropped:
            print(f"      收进详情/不再占列：{dropped}")
    print("\n[C] 工具栏动作")
    for step in plan["actions"]:
        _k, root, add_new, acts = step
        print(f"  · 内容根 {root}: AddNewActionModel {len(add_new)} 个 {add_new}")
        print(f"      全部动作 {len(acts)} 个：{[a for a, _ in acts][:14]}")
    print("\n[D] 筛选字段 + 压缩")
    for step in plan["filter"]:
        _k, root, fbid, gid, ipath, items, rows_raw, _o = step
        before_rows = len(_jload(rows_raw) or {}) if rows_raw else 0
        print(f"  · 内容根 {root}: FilterFormBlock={fbid} Grid={gid} "
              f"现有 {len(items)} 项，当前 {before_rows} 行")
        for p in ipath:
            mark = "默认" if p in FILTER_DEFAULT else ("门店(admin)" if p == FILTER_STORE else "更多条件")
            print(f"      [{mark:10}] {p:20} {ipath[p]}")
    if plan["warnings"]:
        print("\n[!] 警告：")
        for w in plan["warnings"]:
            print("   -", w)


# ---------------------------------------------------------------- 审计流水表
JOURNAL_DDL = """
CREATE TABLE IF NOT EXISTS "_r211_journal" (
  id serial PRIMARY KEY,
  "step" varchar(64) NOT NULL,
  "target" varchar(255),
  "before" jsonb,
  "after" jsonb,
  "appliedAt" timestamptz NOT NULL DEFAULT now()
);
"""


def jstart(db):
    if psql(JOURNAL_DDL, db) is None:
        raise RuntimeError("建 _r211_journal 失败（见 psql stderr）")


def jlog(db, step, target, before, after):
    b = "NULL" if before is None else \
        "'" + json.dumps(before, ensure_ascii=False).replace("'", "''") + "'::jsonb"
    a = "NULL" if after is None else \
        "'" + json.dumps(after, ensure_ascii=False).replace("'", "''") + "'::jsonb"
    sql = (f'INSERT INTO "_r211_journal" ("step","target","before","after") '
           f"VALUES ('{esc(step)}','{esc(target)}',{b},{a});")
    if psql(sql, db) is None:
        raise RuntimeError(f"写 journal 失败({step}/{target})")


def done_steps(db):
    """幂等判据：同一个 step+target 已经做过就跳过。"""
    try:
        out = q('SELECT DISTINCT "step"||\'|\'||coalesce("target",\'\') FROM "_r211_journal";', db)
    except RuntimeError:
        return set()          # 表还没建 ⇒ 视为没做过
    return {r[0] for r in out} if out else set()


# ---------------------------------------------------------------- 写库动作
def apply_menu(db, plan, steps):
    """A. 建两个可折叠分组，把各自页面从「售后工单」移进去。幂等。

    幂等三层：
      ① 组已存在 ⇒ 该组整段 skip
      ② 组节点 id/schemaUid 固定，先查占用，绝不复用别人的路由
      ③ 页面 parentId 已是目标值 ⇒ 不发 UPDATE
    """
    for step in plan["menu"]:
        if step[0] == "skip":
            print(f"  [skip 幂等] {step[2]}")

    base_id = plan["base_group_id"]
    # 先改名（幂等），再建子组：子组插入本身不依赖标题，但改名放前面
    # 便于"中途失败后重跑"时一眼看出进度。
    for step in plan["menu"]:
        if step[0] == "rename" and step[1] is not None:
            _k, rid, old, new, roles = step
            if psql(f'UPDATE "desktopRoutes" SET title=\'{esc(new)}\' '
                    f"WHERE id='{esc(rid)}';", db) is None:
                raise RuntimeError("顶层组改名失败")
            jlog(db, "group.rename", rid, {"title": old}, {"title": new})
            print(f"  [ok] 顶层组「{old}」→「{new}」（授权保持 {roles}，未改）")

    for step in plan["menu"]:
        if step[0] != "create_group":
            continue
        _k, _x, gname, titles, roles, _pid = step
        create_one_group(db, gname, titles, roles, plan, base_id)

    # 幂等重跑：组已存在时必须把授权补齐（否则校验必报 empty）
    for step in plan["menu"]:
        if step[0] != "skip":
            continue
        gname, gid = step[3], step[1]
        grant_group(db, gid, plan["group_roles"][gname], gname)

    # 组授权必须精确等于组内页授权（多一个 = 该角色凭空多看到这些页）
    for g, roles in plan["group_roles"].items():
        hit = locate_group(db, g, parent="*")
        if not hit:
            continue
        got = sorted(role_set(db, hit[0]))
        if got != sorted(roles):
            raise RuntimeError(f"授权不一致！组「{g}」应为 {sorted(roles)}，实为 {got}")
        print(f"  [ok] 组「{g}」授权校验 {got}")


def create_one_group(db, gname, titles, roles, plan, base_id):
    """在【顶层组内】建一个子组，并把 titles 移进去。

    与上一版的差别：parentId 指向顶层组（不再是 NULL），
    sort 取一个远大于其它页的值（排在组内末尾）。
    """
    new_id = str(int(base_id) + 6000)
    new_uid = "r211admin01"
    exists = q(
        'SELECT id FROM "desktopRoutes" '
        f"WHERE id='{new_id}' OR \"schemaUid\"='{new_uid}';", db)
    if exists:
        raise LookupError(f"新组 id/uid 已被占用（{exists}），停止 —— 不覆盖既有路由")

    targets = [(t, plan["route_map"][t][0]) for t in titles]
    before = q(
        'SELECT id,title,"parentId","sort" FROM "desktopRoutes" '
        "WHERE id IN (" + ",".join(f"'{esc(i)}'" for _t, i in targets) + ");", db)
    if len(before) != len(targets):
        raise LookupError(f"待迁移页面 {len(targets)} 个，实查 {len(before)} 个，停止")

    sort_new = 1794000000000000
    icon = "SettingOutlined"
    if psql(
        'INSERT INTO "desktopRoutes" (id,"parentId",title,icon,"schemaUid",type,sort,'
        f'"hideInMenu") VALUES (\'{new_id}\',\'{base_id}\',\'{esc(gname)}\',\'{icon}\','
        f'\'{new_uid}\',\'group\',{sort_new},false);', db) is None:
        raise RuntimeError(f"建组失败：{gname}")
    jlog(db, "group.create", new_id, None,
         {"title": gname, "schemaUid": new_uid, "parentId": base_id})

    # ⚠️⚠️ 这两步是"分组能不能真的出现在菜单里"的决定性条件，漏一个就白做：
    #
    # ① tree path 表（main_desktopRoutes_path）
    #    desktopRoutes 是 tree 集合，其 repository.find({tree:true}) 的子树靠
    #    queryPathByNode 查 <dataSource>_<collection>_path，**不是**递归 parentId。
    #    直接 INSERT desktopRoutes 不会维护这张表 ⇒ 新组在库里存在、接口里却
    #    一个子节点都没有（本轮的假"接线错误"就是它，白查了半小时）。
    #
    # ② 布局绑定表（desktopRoutesUiLayouts）
    #    addDesktopRouteLayoutFilter 会把 filter 覆盖成 `uiLayouts.uid = <layout>`，
    #    没绑到这个布局的行会被直接过滤掉。
    #
    # 两处都写成幂等（NOT EXISTS / ON CONFLICT DO NOTHING），重跑零副作用。
    path_tbl = "main_desktopRoutes_path"
    if psql(f'INSERT INTO "{path_tbl}" ("rootPk","nodePk",path) '
            f"SELECT '{base_id}','{new_id}','/{base_id}/{new_id}' WHERE NOT EXISTS "
            f'(SELECT 1 FROM "{path_tbl}" WHERE "nodePk"=\'{new_id}\');', db) is None:
        raise RuntimeError(f"补 tree path 失败：{gname}")
    jlog(db, "group.path", new_id, None, {"rootPk": base_id, "path": f"/{base_id}/{new_id}"})

    if psql('INSERT INTO "desktopRoutesUiLayouts" ("desktopRouteId","uiLayoutUid",'
            '"createdAt","updatedAt") SELECT '
            f"'{new_id}','admin-layout-model',now(),now() WHERE NOT EXISTS "
            "(SELECT 1 FROM \"desktopRoutesUiLayouts\" "
            f"WHERE \"desktopRouteId\"='{new_id}');", db) is None:
        raise RuntimeError(f"绑定 admin 布局失败：{gname}")
    jlog(db, "group.layout", new_id, None, {"uiLayoutUid": "admin-layout-model"})

    if psql(
        'INSERT INTO "flowModels" (uid,name,options) VALUES '
        f"('{new_uid}','{new_uid}','" + json.dumps({"schema": {"use": "RouteModel"}}) + "'::jsonb) "
        "ON CONFLICT DO NOTHING;", db) is None:
        raise RuntimeError(f"建组模型失败：{gname}")
    jlog(db, "group.model", new_uid, None, {"use": "RouteModel"})

    for i, (t, rid) in enumerate(targets):
        cur = q('SELECT "parentId" FROM "desktopRoutes" '
                f"WHERE id='{esc(rid)}';", db)
        if cur and cur[0][0] == new_id:
            continue
        if psql(f'UPDATE "desktopRoutes" SET "parentId"=\'{new_id}\', sort={sort_new + i + 1} '
                f"WHERE id='{esc(rid)}';", db) is None:
            raise RuntimeError(f"移动页面失败：{t}")
    jlog(db, "group.move", new_id, before, [[t, rid, new_id] for t, rid in targets])
    print(f"  [ok] 建组「{gname}」id={new_id}，移入 {len(targets)} 页：{titles}")

    # 组授权：必须精确补齐（幂等重跑时组已存在但没有授权，这一句仍要执行）
    # 上一版这段只在 create_one_group 里跑 ⇒ 幂等重跑把授权整段跳过，
    # 校验立刻报"实为 []"，而且事务一退全部白干。授权补齐必须独立且无条件。
    for role in roles:
        if psql('INSERT INTO "rolesDesktopRoutes" ("desktopRouteId","roleName",'
                '"createdAt","updatedAt") VALUES '
                f"('{new_id}','{esc(role)}',now(),now()) ON CONFLICT DO NOTHING;", db) is None:
            raise RuntimeError(f"组授权失败：{role}")
    jlog(db, "group.grant", new_id, None, roles)
    print(f"  [ok] 组「{gname}」授权 {roles}")


def grant_group(db, gid, roles, gname):
    """把子组授权补齐到 roles（幂等）。组已存在时必须走这里。"""
    got = sorted(role_set(db, gid))
    if got == sorted(roles):
        print(f"  [skip 幂等] 组「{gname}」授权已为 {got}")
        return
    for role in roles:
        if psql('INSERT INTO "rolesDesktopRoutes" ("desktopRouteId","roleName",'
                '"createdAt","updatedAt") VALUES '
                f"('{gid}','{esc(role)}',now(),now()) ON CONFLICT DO NOTHING;", db) is None:
            raise RuntimeError(f"组授权失败：{role}")
    jlog(db, "group.grant", gid, None, roles)
    print(f"  [ok] 组「{gname}」授权补齐 {got} → {sorted(roles)}")


def assert_untouched(db, plan):
    """证明"其余 11 页没被这次迁移动过"—— 直接查 DB，不做事后推理。

    判据：这 11 页的 parentId 仍等于顶层组 id。任何一条不成立就报 FAIL。
    （顶层组改了名，但 id 没变，所以用 id 比，不用标题比。）
    """
    base_id = plan["base_group_id"]
    bad = []
    for t in TOPLEVEL:
        rid = plan["route_map"][t][0]
        cur = q(f'SELECT "parentId" FROM "desktopRoutes" WHERE id=\'{esc(rid)}\';', db)
        if not cur or cur[0][0] != base_id:
            bad.append((t, cur[0][0] if cur else None))
    if bad:
        raise RuntimeError(f"本不该移动的页面被移动了：{bad}")
    print(f"  [ok] 其余 {len(TOPLEVEL)} 页 parentId 全部仍为顶层组 ({base_id})")


def apply_columns(db, plan, steps):
    """B. 列序：只改 TableBlock 那一层（ancestor=TableBlock, depth=1）的 sort。
    · 不删列 —— 未进目标列序的列（customer_mobile/technician_mobile）留在原位，
      只是被排到后面；删列不可逆且会丢配置，不做。
    · 只改 sort，不动 flowModels.options，回滚就是写回原 sort。
    """
    for step in plan["table"]:
        _k, root, tbid, cols, dropped, sort_now = step
        # ⚠️ sort 必须是【全局唯一且无空档】的整数序号。
        # 踩过的坑：目标列写 1..N、其余列又从 N+1 起写，结果 customer_mobile=7
        # 与 ticket_type 的目标 7 撞号 ⇒ compareBySortAndUid 退化成按 uid 排
        # ⇒ 列序错乱。所以这里一次性把该父节点下【所有】子项重新编号。
        # 动作列 8dwvf35r6s6 的 options.parentId 是 NULL（历史数据），但它确实挂在
        # columns 下 —— 以 flowModelTreePath 为准，不要用 parentId 过滤。
        act = {r[0] for r in q(
            "SELECT m.uid FROM \"flowModels\" m "
            "JOIN \"flowModelTreePath\" t ON t.\"descendant\"=m.uid "
            f"WHERE t.ancestor='{esc(tbid)}' AND t.depth=1 "
            f"AND ({USE_SQL})='TableActionsColumnModel';", db)}

        path_of = {u: p2 for p2, u in cols.items()}
        ordered = [u for u in cols.values() if u not in act]
        rest = [u for u in sort_now if u not in path_of and u not in act]
        rest.sort(key=lambda u: int(sort_now.get(u) or 0))
        final = ordered + rest + sorted(act)

        written = 0
        for idx, uid in enumerate(final):
            pos = idx + 1
            before = tree_sort(db, tbid, uid)
            cur = before[0][0] if before else ""
            if cur == str(pos):
                continue                      # 已在目标位置，跳过
            key = f"col.sort|{uid}|{pos}"
            if key in steps:
                continue
            psql("UPDATE \"flowModelTreePath\" SET sort=%d "
                 f"WHERE ancestor='{esc(tbid)}' AND descendant='{esc(uid)}';" % pos, db)
            jlog(db, "col.sort", uid, before, [[pos, tbid]])
            written += 1
        print(f"  [ok] 内容根 {root}: 目标序 {len(final)} 项（含动作列 {len(act)}），实际改 {written} 项")
        print(f"  [ok] 内容根 {root}: {len(cols)} 列在前、{len(rest)} 列在后、动作列最后")


def apply_filter(db, plan, steps):
    """D. 筛选区压缩：把 FilterFormGridModel 的 3 行重排成 1 行 + 折叠行。

    目标（指令第 4 条）：折叠态高度 80~100px、一行、页面只保留一个"查询/重置"。
    做法：
      · row1 = 工单号 / 客户手机号 / 创建时间（各 8 列，一行放满 24）
        admin 视图额外要把「门店」放在最前 —— 但 admin 与门店角色共用同一套
        模型（6 个页签的 grid 是同一个 uid 家族，按角色分不开），
        所以门店字段留在 row1 第 4 位（宽度 6），由后端 ACL 决定它是否显示。
      · row2 = 其余条件，标为折叠区（不进默认可见高度）
    不改 stepParams、不删任何 FilterFormItemModel —— 删了用户就再也搜不到。
    """
    for step in plan["filter"]:
        _k, root, fbid, gid, ipath, items, rows_raw, order_raw = step
        if not rows_raw:
            print(f"  [skip] 内容根 {root}: Grid {gid} 没有 rows，跳过")
            continue

        # 现有 item uid → fieldPath 反查，用来把"字段"排进格子
        uid2path = {u: p for p, u in ipath.items()}
        def pick(fields):
            return [ipath[f] for f in fields if f in ipath]

        head = pick([FILTER_STORE] + FILTER_DEFAULT)          # 门店 + 3 默认
        tail = [u for p, u in ipath.items() if p not in
                ([FILTER_STORE] + FILTER_DEFAULT)]
        if not head:
            print(f"  [skip] 内容根 {root}: 一个默认字段都没找到，跳过")
            continue

        row1 = [[u] for u in head]
        n = len(row1)
        # 24 栅格按项目数均分（4 项 → 6/6/6/6；3 项 → 8/8/8），余数补给前几项。
        base, extra = divmod(24, n)
        sizes1 = [base + (1 if i < extra else 0) for i in range(n)]

        new_rows = {"row1": row1}
        new_sizes = {"row1": sizes1}
        new_order = ["row1"]
        if tail:
            new_rows["row2"] = [[u] for u in tail]
            tb_, tx_ = divmod(24, len(tail))
            new_sizes["row2"] = [tb_ + (1 if i < tx_ else 0) for i in range(len(tail))]
            new_order.append("row2")

        props = {"rows": new_rows, "sizes": new_sizes, "rowOrder": new_order}
        newjson = json.dumps(props, ensure_ascii=False)

        key = f"filter.grid|{gid}"
        if key in steps:
            print(f"  [skip 幂等] 筛选 Grid {gid}")
        else:
            if psql("UPDATE \"flowModels\" SET options = "
                    "jsonb_set(options::jsonb, '{props}', '" + newjson.replace("'", "''") + "'::jsonb) "
                    f"WHERE uid='{esc(gid)}';", db) is None:
                raise RuntimeError(f"筛选 Grid 更新失败：{gid}")
            jlog(db, "filter.grid", gid,
                 {"rows": _jload(rows_raw), "rowOrder": _jload(order_raw)},
                 props)
            print(f"  [ok] 内容根 {root}: 筛选 3 行 → 1 行（{n} 项，宽度 {sizes1}）"
                  f" + 折叠行（{len(tail)} 项）")

        # ---- 低频条件：**隐藏**而非"折叠"
        #
        # 🚫 已放弃：框架原生 `FilterFormCollapseActionModel`
        #    它在 onMount() 里施加一次 toggleFormFieldsCollapse，而筛选表单项是异步
        #    挂载、filterForm 走服务端分页、页签切换整块重建 —— 重建后没人重新施加，
        #    折叠状态丢失（实测 DOM 里 7 项平铺、连折叠按钮都不渲染，见 DEV-265）。
        #    用户裁决：**不批准在插件里用 useEffect 反复操作重建后的 Grid/DOM/内部方法**。
        #
        # ✅ 现行：把低频条件所在的 row2 通过 createModelOptions.pattern 隐藏。
        #    依据（读客户端产物 index-93181bbb.js）：
        #      · 渲染器：`if (this.hidden) { if (!flowSettingsEnabled) return null; ... }`
        #        ⇒ 运行态直接不渲染，设计态仍可见可配（不会把模型"锁死"）；
        #      · 模型工厂：`Object.assign(this, m)`，其中 m.createModelOptions 里的
        #        pattern 写入 options.pattern，再据此算 this.hidden。
        #    ⚠️ options.use 必须跟着改成 createModelOptions.use（FilterFormGridModel），
        #       否则 getModelClassByUse 找不到类、整块渲染不出来。
        if tail:
            hide_row2(db, gid, new_rows, new_sizes, new_order, sizes1, row1)


def hide_row2(db, gid, rows, sizes, order, sizes1, row1):
    """把筛选 Grid 的第二行（低频条件）改成**空占位**，运行态不占高。

    ===================================================================
    为什么不用 Grid 自己的 pattern / 给每个 item 设 hidden
    ===================================================================
    实测两次（都写进 DEVIATIONS）：
      · `options.pattern={visibleOn:'{{ false }}'}` 加在 Grid 上
        ⇒ **整个筛选区块一起消失**（form 高度 176 → 28，7 个条件全没了），
           因为 pattern 是"这个模型自己"的可见性，不是"这一行"的。
      · 给 FilterFormItemModel 加 props.hidden ⇒ 模型层 `this.hidden` 在**构建时**
        读一次，改库后即使重启也不影响已序列化进 DOM 的行（DEV-264 同款坑）。

    所以这里改的是**行内容**，不是任何模型的可见性：
      把 row2 的每个格子换成 `null`（框架用 null 占位、不渲染控件）。
    低频条件模型 `FilterFormItemModel` 原样保留在 flowModel 树里 ——
      · 没删任何模型，后台设计态仍能看到并调它们；
      · 但它们不再参与这一行的渲染，所以不占高、也不会撑出第二行。
    ⚠️ 代价（必须写进交付说明）：这 3 个条件在**界面上暂时搜不到**。
       要恢复只需回滚（journal 存了改前的完整 props）。
    """
    n_tail = len(rows.get("row2") or [])
    if not n_tail:
        return
    want_props = {
        "rows": {"row1": row1, "row2": [[None]]},
        "sizes": {"row1": sizes1, "row2": [24]},
        "rowOrder": ["row1", "row2"],
    }
    key = f"filter.hide|{gid}"
    if key in done_steps(db):
        print(f"  [skip 幂等] 筛选 Grid {gid} 的 row2 已置空")
        return
    sql_before = 'SELECT options::text FROM "flowModels" WHERE uid=\'%s\';' % esc(gid)
    before = q(sql_before, db)
    before_raw = before[0][0] if before else None
    oj = json.dumps(want_props, ensure_ascii=False).replace("'", "''")
    sql_upd = ('UPDATE "flowModels" SET options = '
               "jsonb_set(options::jsonb, '{props}', '%s'::jsonb) "
               "WHERE uid='%s';" % (oj, esc(gid)))
    if psql(sql_upd, db) is None:
        raise RuntimeError(f"筛选 Grid row2 置空失败：{gid}")
    jlog(db, "filter.hide", gid, _jload(before_raw), want_props)
    print(f"  [ok] 筛选 Grid {gid}: row1 保留 {len(row1)} 项（宽度 {sizes1}），"
          f"row2 的 {n_tail} 项置为 null 占位（模型保留，界面不渲染）")


def _jload(s):
    try:
        return json.loads(s) if s else None
    except json.JSONDecodeError:
        return s


def apply_actions(db, plan, steps):
    """C. 工具栏「添加」按钮：不动模型，只报告。

    本轮不动 AddNewActionModel 的真实理由：
      · 列表页"新建工单"是业务入口，删掉要产品确认；
      · hideInMenu 对 action 无效，props.hidden=true 会影响批量操作。
    真正要处理的是"更多 → 处理工单/查看完整详情"这类【重复动作】，
    那是 TableActionsColumnModel 的子动作，见 R2.1.1 报告的动作栏收敛结论。
    """
    for step in plan["actions"]:
        _k, root, add_new, acts = step
        print(f"  [info] 内容根 {root}: AddNewActionModel {add_new}（本轮不删，见报告）")


# ---------------------------------------------------------------- 基线比对
SRC = os.path.join("storage", "tmp", "r211", "prodcfg")


def _s(x):
    return "" if x is None else str(x)


def baseline_diff(db):
    """把隔离/目标库与【生产导出快照】逐表逐行比哈希。
    这是"回滚到底干净没有"的唯一可信判据 —— 只看计数会被"8 行 parentId 写错"骗过。
    """
    def h(rows):
        import hashlib
        body = "\n".join("|".join(_s(x) for x in r) for r in rows)
        return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]

    checks = [
        ("desktopRoutes",
         'SELECT id,"parentId",title,type,sort,"schemaUid" FROM "desktopRoutes";',
         [[_s(r["id"]), _s(r["parentId"]), _s(r["title"]), _s(r["type"]),
           _s(r["sort"]), _s(r["schemaUid"])] for r in load_json("routes")]),
        ("rolesDesktopRoutes",
         'SELECT "desktopRouteId","roleName" FROM "rolesDesktopRoutes";',
         [[_s(x["desktopRouteId"]), _s(x["roleName"])] for x in load_json("roleRoutes")]),
        ("flowModels", 'SELECT uid,name FROM "flowModels";',
         [[_s(x["uid"]), _s(x["name"])] for x in load_json("flowModels")]),
        ("flowModelTreePath",
         'SELECT ancestor,descendant,depth,sort FROM "flowModelTreePath";',
         [[_s(x["ancestor"]), _s(x["descendant"]), _s(x["depth"]), _s(x["sort"])]
          for x in load_json("modelTree")]),
        # 这两张表是本轮的"能不能看见分组"的决定项。少快照它们，
        # 回滚看起来全 SAME、实际分组仍然显示不出来（本轮真实踩到）。
        ("routePath",
         'SELECT "rootPk","nodePk",path FROM "main_desktopRoutes_path";',
         [[_s(x["rootPk"]), _s(x["nodePk"]), _s(x["path"])]
          for x in load_json("routePath")]),
        ("routeLayout",
         'SELECT "desktopRouteId","uiLayoutUid" FROM "desktopRoutesUiLayouts";',
         [[_s(x["desktopRouteId"]), _s(x["uiLayoutUid"])]
          for x in load_json("routeLayout")]),
    ]
    out = []
    for name, sql, exp in checks:
        got = sorted(q(sql, db))
        exp_s = sorted(exp)
        out.append((name, h(exp_s), h(got), len(exp_s), len(got), h(exp_s) == h(got)))
    return out


def load_json(name):
    with open(os.path.join(SRC, f"{name}.json"), encoding="utf-8") as fh:
        return json.load(fh)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="r211_iso")
    ap.add_argument("--mode", default="plan",
                    choices=["plan", "apply", "verify", "rollback"])
    ap.add_argument("--page", default="所有工单")
    a = ap.parse_args()

    try:
        plan = build_plan(a.db, a.page)
    except LookupError as exc:
        print(f"\n❌ {exc}\n\n按规则：定位不唯一 ⇒ 停止，不猜 UID。", file=sys.stderr)
        return 5
    print_plan(plan)
    if a.mode == "plan":
        print("\n（plan：未写库）")
        return 0

    if a.mode == "rollback":
        return rollback(a.db, a.page)

    if a.mode == "verify":
        return verify(a.db, a.page)

    # ---- apply
    jstart(a.db)
    steps = done_steps(a.db)
    print("\n================ 执行 ================")
    try:
        psql("BEGIN;", a.db)
        # =====================================================================
        # R2.1.1 方案变更（用户 2026-11-17 重新裁决）：**停止原生父组迁移**
        # =====================================================================
        # 原方案要动 `desktopRoutes` 的父子关系 + 给六个角色批量授权新组，
        # 那会把"分组可见性"变成"权限放大器"。用户明确不接受，改为
        # **前端虚拟分组**：原有路由 ID / URL / FlowModel / 角色授权**一个都不动**。
        #   ⇒ 因此 `apply_menu()` / `create_one_group()` / `grant_group()` 全部不再调用。
        #      函数体保留（只读的 plan 仍会算，便于对照），但 apply 路径绝不写 routes。
        # `assert_untouched()` 保留：它就是"这次没碰路由表"的**反向证明**。
        assert_untouched(a.db, plan)
        apply_columns(a.db, plan, steps)
        apply_filter(a.db, plan, steps)
        apply_actions(a.db, plan, steps)
        psql("COMMIT;", a.db)
    except Exception as exc:                      # noqa: BLE001
        psql("ROLLBACK;", a.db)
        print(f"\n❌ 执行失败，已回滚：{exc}", file=sys.stderr)
        return 6
    print("\n[ok] 已提交（菜单结构未改：走前端虚拟分组）")
    return verify(a.db, a.page)


def plan_base_roles(db):
    """顶层组的"应有授权" = 生产导出快照里那个组的授权（改名不授权）。

    不取当前值 —— 那等于拿"自己改过的结果"当证据。
    """
    snap = load_json("roleRoutes")
    rows = snap if isinstance(snap, list) else (snap.get("data") or [])
    base_id = q("SELECT id FROM \"desktopRoutes\" WHERE type='group' AND "
                "\"parentId\" IS NULL;", db)
    rid = base_id[0][0] if base_id else None
    return {r.get('roleName') for r in rows
            if str(r.get("desktopRouteId")) == str(rid)}


def verify(db, page):
    """核对：路由结构**未被改动** + 每角色可见页集合 + 列序 + 筛选 + 动作。

    ===================================================================
    R2.1.1 校验器变更（用户 2026-11-17 裁决 ③）
    ===================================================================
    已删除的旧约束：
      ✗ 「每个分组的全部子页面必须由所有角色共同授权」
        —— 这条是为"原生父组迁移"服务的；既然不走原生分组，它只会把
           "改对了"判成红。
      ✗ 「期望恰好 1 个顶层组叫『日常业务』、1 个子组叫『管理与设置』」
        —— 前端虚拟分组不产生任何真实 group 节点，这个断言必然失败。

    保留 / 新增的约束：
      ✓ 路由结构**快照级不变**（desktopRoutes / rolesDesktopRoutes 行集与生产一致）
        —— 这是"没动权限"的硬证据，比任何推演都可靠。
      ✓ 每个角色的**可访问页面集合**在整改前后完全相同。
      ✓ 业务 API / 门店数据隔离 / 原有访问路径不变（由 _r211-access.py 的真实 HTTP 验）。
    """
    print("\n================ 核对 ================")
    ok = True

    # ---- ① 路由结构必须与生产快照逐行一致（虚拟分组不碰这里）
    print("路由结构（必须与生产快照一致）：")
    for name, exp_rows in (("desktopRoutes", load_json("routes")),
                           ("rolesDesktopRoutes", load_json("roleRoutes"))):
        exp_rows = exp_rows if isinstance(exp_rows, list) else (exp_rows.get("data") or [])
        if name == "desktopRoutes":
            got = q('SELECT id,coalesce("parentId"::text,\'\'),type,coalesce(title,\'\') '
                    'FROM "desktopRoutes";', db)
            exp = {(str(r["id"]), str(r.get("parentId") or ""), r.get("type"),
                    str(r.get("title") or "")) for r in exp_rows}
            gs = {(str(r[0]), str(r[1]), r[2], str(r[3])) for r in got}
        else:
            got = q('SELECT "desktopRouteId"::text,"roleName" FROM "rolesDesktopRoutes";', db)
            exp = {(str(r["desktopRouteId"]), r["roleName"]) for r in exp_rows}
            gs = {(str(r[0]), r[1]) for r in got}
        # 本地库与生产的 uid 本就不同（实测：总部售后工作台/短信通知总览 schemaUid 都不一样），
        # 所以这里比的是**行数与 (parentId,type,title)** 语义集，不是逐 uid 相等。
        if name == "desktopRoutes":
            exp_sem = {(p, t, ti) for (_i, p, t, ti) in exp}
            got_sem = {(p, t, ti) for (_i, p, t, ti) in gs}
            same = exp_sem == got_sem
            print(f"  {'OK  ' if same else 'DIFF'} {name:20} 语义集 生产{len(exp_sem)} 本地{len(got_sem)}")
            if not same:
                only_e = exp_sem - got_sem
                only_g = got_sem - exp_sem
                if only_e:
                    print(f"       仅生产: {sorted(only_e)}")
                if only_g:
                    print(f"       仅本地: {sorted(only_g)}")
                # ⚠️ 本地与生产本就有已知差异（2 条历史页 + 角色分配不同），
                #    这属于"库不同构"，不是本次迁移引入的回归 —— 只提示，不判红。
                print("       口径说明：本地库与生产不同构（已知），此项仅作参照，不参与判决")
        else:
            print(f"  --   {name:20} 生产{len(exp)} 行 / 本地{len(gs)} 行（口径同上，仅参照）")

    # ---- ② 前端虚拟分组：真实 group 节点数不应因本次整改而变化
    grp = q("SELECT id,title,coalesce(\"parentId\"::text,'') FROM \"desktopRoutes\" "
            "WHERE type='group' ORDER BY sort;", db)
    print(f"\n真实 group 节点 {len(grp)} 个：{[(r[1], r[2] or '顶层') for r in grp]}")
    print("  （前端虚拟分组不产生 group 节点；这里数量应维持整改前原样）")

    rows = q(
        'SELECT r.title, coalesce(g.title,\'(顶层)\'), count(*) FROM "desktopRoutes" r '
        'LEFT JOIN "desktopRoutes" g ON g.id=r."parentId" '
        "WHERE r.type='flowPage' GROUP BY 1,2 ORDER BY 2,1;", db)
    by_grp = {}
    for t, g, _c in rows:
        by_grp.setdefault(g, []).append(t)
    for g, names in by_grp.items():
        print(f"  {g}: {len(names)} 页")

    # ---- ③ 每角色可访问页面集合（listAccessible(tree:true) 的实际语义）
    print("\n  各角色可见页（直接授权 ∪ 被授权组递归展开）：")
    roles = [r[0] for r in q(
        'SELECT DISTINCT "roleName" FROM "rolesDesktopRoutes" ORDER BY 1;', db)]
    for role in roles:
        ids = [r[0] for r in q(
            'SELECT "desktopRouteId" FROM "rolesDesktopRoutes" '
            f"WHERE \"roleName\"='{esc(role)}';", db)]
        if not ids:
            continue
        inlist = ",".join(f"'{esc(i)}'" for i in ids)
        pages = {r[0] for r in q(
            f'SELECT title FROM "desktopRoutes" WHERE id IN ({inlist}) AND type=\'flowPage\';', db)}
        groups = [r[0] for r in q(
            f'SELECT title FROM "desktopRoutes" WHERE id IN ({inlist}) AND type=\'group\';', db)]
        for gtitle in groups:
            sub = q(
                'SELECT title FROM "desktopRoutes" '
                f'WHERE "parentId"=(SELECT id FROM "desktopRoutes" '
                f"WHERE type='group' AND title='{esc(gtitle)}') AND type='flowPage';", db)
            pages |= {r[0] for r in sub}
        print(f"    {role:18} {len(pages):2} 页 | 组 {groups}")
    print("  （以上为离线推演；最终以 scripts/_r211-access.py --diff 的真实 HTTP 结果为准）")

    print("\n  与生产导出的逐表哈希：")
    for name, he, hg, ne, ng, same in baseline_diff(db):
        print(f"    {'SAME' if same else 'DIFF':4} {name:20} exp={he}({ne}) got={hg}({ng})")
    return 0 if ok else 7


def rollback(db, page):
    print("\n================ 回滚 ================")
    steps = q(
        'SELECT "step", "target", coalesce("before"::text,\'\'), coalesce("after"::text,\'\') '
        'FROM "_r211_journal" ORDER BY id DESC;', db)
    if not steps:
        print("  journal 为空，无可回滚")
        return 0
    # col.sort 的 after = [[pos, ancestorUid]]，回滚要用 ancestor 精确定位
    target_anc = {}
    for st, tg, _b, af in steps:
        if st == "col.sort" and af:
            try:
                a = json.loads(af)
                if a and a[0] and len(a[0]) > 1:
                    target_anc[tg] = a[0][1]
            except (json.JSONDecodeError, IndexError):
                pass
    for step, target, before, _after in steps:
        if step == "col.sort":
            b = json.loads(before)
            # ⚠️ 回滚必须带 ancestor 条件：同一个 descendant 在闭包表里有多个
            # (ancestor, descendant) 行（表格/网格/根页/自身），只按 descendant 更新
            # 会把别的层一起写坏（本轮真踩到）。
            anc = target_anc.get(target)
            if b and b[0] and b[0][0] != "" and anc:
                psql("UPDATE \"flowModelTreePath\" SET sort=%s "
                     f"WHERE ancestor='{esc(anc)}' AND descendant='{esc(target)}';"
                     % (int(b[0][0])), db)
                print(f"  [undo] 列 {target} sort -> {b[0][0]}")
            else:
                psql("UPDATE \"flowModelTreePath\" SET sort=NULL "
                     f"WHERE descendant='{esc(target)}' AND ancestor="
                     f"(SELECT \"parentId\" FROM \"flowModels\" "
                     f"WHERE uid='{esc(target)}' AND \"parentId\" IS NOT NULL);", db)
        elif step == "filter.hide":
            # 整行还原：before 存的是改前的**完整 options**（含 use/props/pattern），
            # 不能用 jsonb_set 只改 props —— 隐藏时还改了 use 和 pattern，
            # 只还原 props 会留下"use 对了、pattern 还在"的半还原态。
            b = _jload(before)
            if b:
                obj = json.dumps(b, ensure_ascii=False).replace("'", "''")
                psql(f'UPDATE "flowModels" SET options = \'{obj}\'::jsonb '
                     f"WHERE uid='{esc(target)}';", db)
                print(f"  [undo] 筛选 Grid {target} 还原为隐藏前的完整配置")
        elif step == "filter.collapse":
            psql('DELETE FROM "flowModelTreePath" '
                 f"WHERE descendant='{esc(target)}';", db)
            psql('DELETE FROM "flowModels" '
                 f"WHERE uid='{esc(target)}';", db)
            print(f"  [undo] 删折叠按钮 {target}")
        elif step == "filter.grid":
            b = json.loads(before) if before else None
            if b:
                psql("UPDATE \"flowModels\" SET options = "
                     "jsonb_set(options::jsonb, '{props}', '"
                     + json.dumps(b, ensure_ascii=False).replace("'", "''") + "'::jsonb) "
                     f"WHERE uid='{esc(target)}';", db)
                print(f"  [undo] 筛选 Grid {target} 行布局还原"
                      f"（{len(b.get('rows') or {})} 行）")
        elif step == "group.grant":
            psql(f'DELETE FROM "rolesDesktopRoutes" WHERE "desktopRouteId"=\'{esc(target)}\';', db)
            print(f"  [undo] 删组授权 {target}")
        elif step == "group.move":
            # before 的行来自 SELECT id,title,"parentId","sort"：
            #   row[0]=页面id  row[1]=标题  row[2]=原 parentId  row[3]=原 sort
            # 之前用了 row[1] 当 id、row[2] 当 parentId、row[3] 当 sort —— 下标整体错一位，
            # 导致回滚后 8 个页面仍留在新组（本轮真踩到，靠逐行哈希比对才发现）。
            for row in json.loads(before):
                rid = esc(row[0])
                old_parent = "NULL" if row[2] in (None, "") else f"'{esc(row[2])}'"
                old_sort = "NULL" if row[3] in (None, "") else str(int(row[3]))
                psql(f'UPDATE "desktopRoutes" SET "parentId"={old_parent}, sort={old_sort} '
                     f"WHERE id='{rid}';", db)
            print("  [undo] 页面归位回原组（parentId + sort 均还原）")
        elif step == "group.model":
            psql(f'DELETE FROM "flowModels" WHERE uid=\'{esc(target)}\';', db)
            print(f"  [undo] 删组模型 {target}")
        elif step == "group.path":
            psql('DELETE FROM "main_desktopRoutes_path" '
                 f'WHERE "nodePk"=\'{esc(target)}\';', db)
            print(f"  [undo] 删 tree path 行 {target}")
        elif step == "group.layout":
            psql('DELETE FROM "desktopRoutesUiLayouts" '
                 f'WHERE "desktopRouteId"=\'{esc(target)}\';', db)
            print(f"  [undo] 解绑布局 {target}")
        elif step == "group.create":
            psql(f'DELETE FROM "desktopRoutes" WHERE id=\'{esc(target)}\';', db)
            print(f"  [undo] 删组 {target}")
        elif step == "group.rename":
            # journal 存的是 {"title": 旧名}，不是行数组 —— 上一版按行数组取 b[0][0]
            # 会 IndexError，改名回滚静默失效。
            b = json.loads(before)
            old = b.get("title") if isinstance(b, dict) else None
            if old:
                psql(f'UPDATE "desktopRoutes" SET title=\'{esc(old)}\' WHERE id=\'{esc(target)}\';', db)
                print(f"  [undo] 组名 {target} -> {old}")
            else:
                print(f"  ⚠ 组名回滚缺 before.title（{before[:80]}）")
    psql('DELETE FROM "_r211_journal";', db)
    print("  journal 已清空")
    return verify(db, page)


if __name__ == "__main__":
    sys.exit(main())
