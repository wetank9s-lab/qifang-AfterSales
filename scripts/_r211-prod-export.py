"""_r211-prod-export.py —— R2.1.1 生产配置【只读】导出

严格只读：只发 SELECT，不做任何 DDL / DML / 重启。
口令只从环境变量 S6_SSH_PASS 读，不打印、不落盘、不写日志。

导出内容（JSON，落到 storage/tmp/r211/prodcfg/）：
  - routes.json        desktopRoutes 全量（含 parentId / title / schemaUid / type / hidden）
  - roleRoutes.json    rolesDesktopRoutes 全量
  - flowModels.json    与 14 个业务页相关的 flowModels（按 routes 的 schemaUid 反查根，再取整棵子树）
  - modelTree.json     flowModelTreePath 中上述模型的祖先/后代关系
  - collections.json   serviceTickets / serviceVisits / stores 的 fields 定义（列定位用）
  - servers.json       collections 表里的业务集合清单
用法：
    S6_SSH_PASS=*** python scripts/_r211-prod-export.py
"""
import base64
import json
import os
import sys
import textwrap

import paramiko

HOST = os.environ.get("S6_SSH_HOST", "162.14.121.180")
USER = os.environ.get("S6_SSH_USER", "root")
PASS = os.environ.get("S6_SSH_PASS", "")
PG = os.environ.get("S6_PG", "scqf-as-postgres")
DBUSER = os.environ.get("S6_DB_USER", "nocobase")
DBNAME = os.environ.get("S6_DB_NAME", "nocobase")

OUT = os.path.join("storage", "tmp", "r211", "prodcfg")

# ---------------------------------------------------------------- 只读 SQL
# 每条都是 SELECT；用 ::json 让 psql 直接吐 JSON，避免 CSV 转义踩坑。
SQ = {
    "routes": r"""
SELECT coalesce(json_agg(row_to_json(t) ORDER BY t."sort", t.id), '[]'::json)
FROM (
  SELECT id, "parentId", title, tooltip, icon, "schemaUid", "menuSchemaUid",
         "tabSchemaName", type, options, "sort", "hideInMenu", "enableTabs",
         "enableHeader", "displayTitle", hidden
  FROM "desktopRoutes"
) t;
""",
    "roleRoutes": r"""
SELECT coalesce(json_agg(row_to_json(t)), '[]'::json)
FROM (SELECT "desktopRouteId", "roleName" FROM "rolesDesktopRoutes") t;
""",
    # 2026-11-17 新增：这两张表直接决定"新分组能不能出现"，必须一起快照
    #   main_desktopRoutes_path —— tree 集合的子树路径（不维护 = 新组无子节点）
    #   desktopRoutesUiLayouts  —— 路由↔布局绑定（没绑 = 被布局过滤器滤掉）
    "routePath": r"""
SELECT coalesce(json_agg(row_to_json(t) ORDER BY t."rootPk", t."nodePk"), '[]'::json)
FROM (SELECT "rootPk", "nodePk", path FROM "main_desktopRoutes_path") t;
""",
    "routeLayout": r"""
SELECT coalesce(json_agg(row_to_json(t) ORDER BY t."desktopRouteId", t."uiLayoutUid"), '[]'::json)
FROM (SELECT "desktopRouteId", "uiLayoutUid" FROM "desktopRoutesUiLayouts") t;
""",
    "collections": r"""
SELECT coalesce(json_agg(row_to_json(t)), '[]'::json)
FROM (
  SELECT name, title, options::json AS options
  FROM collections
  WHERE name IN ('serviceTickets','serviceVisits','stores','customers','serviceArchives',
                 'serviceTimeliness','banners','smsLogs','ticketEvents','storeUsers')
) t;
""",
    "fields": r"""
SELECT coalesce(json_agg(row_to_json(t)), '[]'::json)
FROM (
  -- ⚠️ 字段**名**在 f.name；f.key 是随机字段 uid（如 eglpmhisnp1）。
  --    上一版只导了 key，定位器只能拿随机 uid 当"字段名"，等于没定位。
  SELECT f."collectionName", f.name, f.key, f.type, f.interface,
         f.options::json AS options
  FROM fields f
  WHERE f."collectionName" IN ('serviceTickets','serviceVisits','stores')
    AND f.key NOT LIKE '\_%'
) t;
""",
}


def main() -> int:
    if not PASS:
        print("缺少 S6_SSH_PASS 环境变量（口令不落盘、不进日志）", file=sys.stderr)
        return 2
    os.makedirs(OUT, exist_ok=True)

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(HOST, port=22, username=USER, password=PASS, timeout=30,
                allow_agent=False, look_for_keys=False)
    print(f"[0] 已登录 {USER}@{HOST}")

    def run_sql(sql: str) -> str:
        # 关键：ssh 非交互 shell 会把双引号剥掉（实测 "desktopRoutes" 变成 desktopRoutes
        # ⇒ PG 折叠成小写 ⇒ relation does not exist）。所以 SQL 一律 base64 传，
        # 远端解码后经 stdin 喂给 psql，命令行里不出现任何引号。
        b64 = base64.b64encode(sql.encode("utf-8")).decode("ascii")
        remote = (
            f"echo {b64} | base64 -d | "
            f"docker exec -i {PG} psql -U {DBUSER} -d {DBNAME} -At -P pager=off -f -"
        )
        _in, out, err = cli.exec_command(remote, timeout=180)
        body = out.read().decode("utf-8", "replace").strip()
        ebody = err.read().decode("utf-8", "replace").strip()
        if ebody:
            print(f"    [stderr] {ebody[:400]}", file=sys.stderr)
        return body

    for name, sql in SQ.items():
        body = run_sql(sql)
        if not body:
            print(f"[!] {name}: 空结果（可能是查询失败，不当作'没有数据'）", file=sys.stderr)
            return 3
        try:
            data = json.loads(body)
        except json.JSONDecodeError as exc:
            print(f"[!] {name}: 不是合法 JSON —— {exc}\n{body[:400]}", file=sys.stderr)
            return 3
        path = os.path.join(OUT, f"{name}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        print(f"[+] {name}: {len(data)} 行 -> {path}")

    # ---- flowModels / flowModelTreePath：按 routes 的 schemaUid 找根，再取子树
    routes_path = os.path.join(OUT, "routes.json")
    routes = json.load(open(routes_path, encoding="utf-8"))
    uids = sorted({r["schemaUid"] for r in routes if r.get("schemaUid")})
    print(f"[i] routes 带 schemaUid 的共 {len(uids)} 个")

    in_list = ",".join("'" + u.replace("'", "''") + "'" for u in uids)
    # flowModels 只有 (uid,name,options) 三列、没有 parentId ⇒ 根模型就是 routes.schemaUid 本身；
    # 用 flowModelTreePath 里"没有祖先(depth>0)"二次确认它确实是根，而不是命中某个子模型。
    sql_root = (
        'SELECT coalesce(json_agg(row_to_json(t)), \'[]\'::json) FROM ('
        ' SELECT m.uid AS root, (NOT EXISTS ('
        '   SELECT 1 FROM "flowModelTreePath" p WHERE p."descendant" = m.uid AND p.depth > 0'
        ' )) AS is_root'
        f' FROM "flowModels" m WHERE m.uid IN ({in_list})'
        ') t;'
    )
    body = run_sql(sql_root)
    roots = []
    try:
        for row in json.loads(body or "[]"):
            if row.get("is_root"):
                roots.append(row["root"])
    except json.JSONDecodeError:
        print(f"[!] 根模型查询失败：{body[:300]}", file=sys.stderr)
        return 3
    print(f"[i] 命中的根模型 {len(roots)} 个：{roots[:7]}{'...' if len(roots) > 7 else ''}")
    if not roots:
        print("[!] 一个根模型都没命中 —— 停下，不猜 UID", file=sys.stderr)
        return 4

    root_list = ",".join("'" + r.replace("'", "''") + "'" for r in roots)
    # ⚠️ flowModelTreePath 是【闭包表但只存一层】——实测 A→B→C 只记 (A,B)、(B,C)，
    # 不记 (A,C)。所以取整棵子树必须递归闭包，否则每个页面只拿到 2 行（根 + 第一层）。
    closure_cte = (
        'WITH RECURSIVE d(uid) AS ('
        f' SELECT unnest(ARRAY[{root_list}]::text[])'
        ' UNION'
        ' SELECT p."descendant" FROM "flowModelTreePath" p JOIN d ON p."ancestor" = d.uid'
        ') '
    )
    sql_models = (
        'SELECT coalesce(json_agg(row_to_json(t)), \'[]\'::json) FROM ('
        ' ' + closure_cte +
        ' SELECT m.uid, m.name, m.options::json AS options'
        ' FROM "flowModels" m WHERE m.uid IN (SELECT uid FROM d)'
        ') t;'
    )
    body = run_sql(sql_models)
    try:
        models = json.loads(body)
    except json.JSONDecodeError:
        print(f"[!] 模型子树查询失败：{body[:300]}", file=sys.stderr)
        return 3
    with open(os.path.join(OUT, "flowModels.json"), "w", encoding="utf-8") as fh:
        json.dump(models, fh, ensure_ascii=False, indent=1)
    print(f"[+] flowModels(子树): {len(models)} 行")

    sql_tree = (
        'SELECT coalesce(json_agg(row_to_json(t)), \'[]\'::json) FROM ('
        ' ' + closure_cte +
        ' SELECT "ancestor","descendant",depth,async,type,sort FROM "flowModelTreePath"'
        ' WHERE "ancestor" IN (SELECT uid FROM d)'
        ') t;'
    )
    body = run_sql(sql_tree)
    try:
        tree = json.loads(body)
    except json.JSONDecodeError:
        print(f"[!] 树路径查询失败：{body[:300]}", file=sys.stderr)
        return 3
    with open(os.path.join(OUT, "modelTree.json"), "w", encoding="utf-8") as fh:
        json.dump(tree, fh, ensure_ascii=False, indent=1)
    print(f"[+] modelTree: {len(tree)} 行")

    cli.close()
    print(f"\n导出完成 -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
