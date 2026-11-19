"""_r211-isolate.py —— 把生产配置做成【隔离副本】

不碰生产、不碰本地开发库。做法：
  1. 本地 PG 建独立 database `r211_iso`（drop 后重建，幂等）
  2. 从生产只读导出里还原 5 张配置表：desktopRoutes / rolesDesktopRoutes /
     flowModels / flowModelTreePath / fields（+ collections 的 name/title/options）
  3. 打印基线计数，作为"隔离副本 == 生产配置"的判据

用法：
    S6_SSH_PASS=*** python scripts/_r211-isolate.py --build
    python scripts/_r211-isolate.py --check
"""
import base64
import json
import os
import subprocess
import sys

ISO_DB = "r211_iso"
LOCAL_PG = "svc-postgres"
LOCAL_USER = "svc_app"
SRC = os.path.join("storage", "tmp", "r211", "prodcfg")


_TMP = os.path.join("storage", "tmp", "r211", "_sql")
_PLACE = "/tmp/_r211.sql"


def psql(sql, db=ISO_DB, db_user=LOCAL_USER):
    """SQL 走【文件 + docker cp】，不走命令行：
    Windows 命令行有 ~32K 上限，批量 INSERT 会被截断成"文件名太长"。
    """
    os.makedirs(_TMP, exist_ok=True)
    local = os.path.join(_TMP, "_r211.sql")
    with open(local, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(sql)
    subprocess.run(f"docker cp {local} {LOCAL_PG}:{_PLACE}", shell=True,
                   capture_output=True)
    cmd = f"docker exec {LOCAL_PG} psql -U {db_user} -d {db} -At -P pager=off -f {_PLACE}"
    p = subprocess.run(cmd, shell=True, capture_output=True)
    out = (p.stdout or b"").decode("utf-8", "replace").strip()
    err = (p.stderr or b"").decode("utf-8", "replace").strip()
    return p.returncode, out, err


def load(name):
    with open(os.path.join(SRC, f"{name}.json"), encoding="utf-8") as fh:
        return json.load(fh)


def build():
    # 1) 重建 isolation db
    rc, out, err = psql(
        f"DROP DATABASE IF EXISTS {ISO_DB};", db="postgres", db_user=LOCAL_USER
    )
    if rc != 0:
        print(f"[!] drop db 失败: {err[:300]}")
        return 2
    rc, out, err = psql(f"CREATE DATABASE {ISO_DB};", db="postgres", db_user=LOCAL_USER)
    if rc != 0:
        print(f"[!] create db 失败: {err[:300]}")
        return 2
    print(f"[+] {ISO_DB} 已重建")

    routes = load("routes")
    roleroutes = load("roleRoutes")
    models = load("flowModels")
    tree = load("modelTree")
    collections = load("collections")
    fields = load("fields")

    ddl = """
CREATE TABLE "desktopRoutes" (
  id varchar(255) PRIMARY KEY,
  "parentId" varchar(255),
  title varchar(255),
  tooltip varchar(255),
  icon varchar(255),
  "schemaUid" varchar(255),
  "menuSchemaUid" varchar(255),
  "tabSchemaName" varchar(255),
  type varchar(255),
  options jsonb,
  sort bigint,
  "hideInMenu" boolean,
  "enableTabs" boolean,
  "enableHeader" boolean,
  "displayTitle" boolean,
  hidden boolean
);
CREATE TABLE "rolesDesktopRoutes" (
  "desktopRouteId" varchar(255),
  "roleName" varchar(255),
  PRIMARY KEY ("desktopRouteId", "roleName")
);
CREATE TABLE "flowModels" (
  uid varchar(255) PRIMARY KEY,
  name varchar(255),
  options jsonb
);
CREATE TABLE "flowModelTreePath" (
  ancestor varchar(255),
  descendant varchar(255),
  depth int,
  async boolean,
  type varchar(255),
  sort int,
  PRIMARY KEY (ancestor, descendant)
);
CREATE TABLE "collections" (name varchar(255) PRIMARY KEY, title varchar(255), options jsonb);
CREATE TABLE "fields" (
  "collectionName" varchar(255), key varchar(255), type varchar(255),
  interface varchar(255), options jsonb, PRIMARY KEY ("collectionName", key)
);
"""
    rc, out, err = psql(ddl)
    if rc != 0:
        print(f"[!] DDL 失败: {err[:600]}")
        return 2
    print("[+] 6 张配置表已建")

    # ---- 逐表灌数据（用 jsonb 参数化，避免手拼引号）
    def insert_rows(table, cols, rows, value_expr):
        if not rows:
            print(f"[!] {table} 源数据为空 —— 不当作'没有数据'")
            return False
        chunk = 120
        for i in range(0, len(rows), chunk):
            batch = rows[i:i + chunk]
            vals = ",".join(value_expr(r) for r in batch)
            sql = f'INSERT INTO "{table}" ({cols}) VALUES {vals} ON CONFLICT DO NOTHING;'
            rc, out, err = psql(sql)
            if rc != 0:
                print(f"[!] {table} 写入失败: {err[:500]}")
                return False
        return True

    def j(v):
        if v is None:
            return "NULL"
        return "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb"

    def s(v):
        if v is None:
            return "NULL"
        return "'" + str(v).replace("'", "''") + "'"

    def b(v):
        return "NULL" if v is None else ("true" if v else "false")

    ok = insert_rows(
        "desktopRoutes",
        'id,"parentId",title,tooltip,icon,"schemaUid","menuSchemaUid","tabSchemaName",'
        'type,options,sort,"hideInMenu","enableTabs","enableHeader","displayTitle",hidden',
        routes,
        lambda r: "(" + ",".join([
            s(r["id"]), s(r["parentId"]), s(r["title"]), s(r["tooltip"]), s(r["icon"]),
            s(r["schemaUid"]), s(r["menuSchemaUid"]), s(r["tabSchemaName"]), s(r["type"]),
            j(r.get("options")), str(r["sort"]) if r.get("sort") is not None else "NULL",
            b(r.get("hideInMenu")), b(r.get("enableTabs")), b(r.get("enableHeader")),
            b(r.get("displayTitle")), b(r.get("hidden")),
        ]) + ")",
    )
    ok = ok and insert_rows(
        "rolesDesktopRoutes", '"desktopRouteId","roleName"', roleroutes,
        lambda r: f"({s(r['desktopRouteId'])},{s(r['roleName'])})",
    )
    ok = ok and insert_rows(
        "flowModels", "uid,name,options", models,
        lambda r: f"({s(r['uid'])},{s(r['name'])},{j(r.get('options'))})",
    )
    ok = ok and insert_rows(
        "flowModelTreePath", "ancestor,descendant,depth,async,type,sort", tree,
        lambda r: "(" + ",".join([
            s(r["ancestor"]), s(r["descendant"]), str(r["depth"]),
            b(r.get("async")), s(r.get("type")),
            str(r["sort"]) if r.get("sort") is not None else "NULL",
        ]) + ")",
    )
    ok = ok and insert_rows(
        "collections", "name,title,options", collections,
        lambda r: f"({s(r['name'])},{s(r['title'])},{j(r.get('options'))})",
    )
    ok = ok and insert_rows(
        "fields", '"collectionName",key,type,interface,options', fields,
        lambda r: "(" + ",".join([
            s(r["collectionName"]), s(r["key"]), s(r["type"]),
            s(r.get("interface")), j(r.get("options")),
        ]) + ")",
    )
    if not ok:
        return 3

    print("\n--- 隔离副本基线计数（必须与生产导出一致）---")
    expect = {
        "desktopRoutes": len(routes), "rolesDesktopRoutes": len(roleroutes),
        "flowModels": len(models), "flowModelTreePath": len(tree),
        "collections": len(collections), "fields": len(fields),
    }
    bad = False
    for t, n in expect.items():
        _rc, got, _e = psql(f'SELECT count(*) FROM "{t}";')
        got_i = int(got) if got.isdigit() else -1
        flag = "OK " if got_i == n else "BAD"
        if got_i != n:
            bad = True
        print(f"  [{flag}] {t:20} 期望 {n:5} 实际 {got_i:5}")
    return 4 if bad else 0


def check():
    print(f"--- {ISO_DB} 当前状态 ---")
    for t in ["desktopRoutes", "rolesDesktopRoutes", "flowModels", "flowModelTreePath"]:
        _rc, got, _e = psql(f'SELECT count(*) FROM "{t}";')
        print(f"  {t:20} {got}")
    _rc, got, _e = psql(
        'SELECT id||\' | \'||coalesce("parentId",\'-root-\')||\' | \'||title FROM "desktopRoutes" '
        'WHERE "parentId" IS NULL ORDER BY sort;'
    )
    print("  顶层路由:\n    " + got.replace("\n", "\n    "))
    return 0


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    sys.exit(build() if mode == "--build" else check())
