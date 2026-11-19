"""prod-db-precheck.py —— 生产数据库只读检查（BE-03 累计部署前置）

严格只读：只发 SELECT / 系统目录查询，不做任何 DDL、DML、迁移、重启。
凭据只从环境变量 S6_SSH_PASS 读取，不打印、不落盘、不写日志。

输出：把远程 psql 的结果原样打印，**不做任何"推断成功"**：
      每组查询都带一个显式分隔标记，缺哪块就说明那块没跑到。

用法（密码从环境变量来，命令行里不出现）：
    S6_SSH_PASS=*** python scripts/prod-db-precheck.py
"""
import os
import sys
import time

import paramiko

HOST = os.environ.get("S6_SSH_HOST", "162.14.121.180")
USER = os.environ.get("S6_SSH_USER", "root")
PASS = os.environ.get("S6_SSH_PASS", "")
APP = os.environ.get("S6_CONTAINER", "scqf-as-app")
PG = os.environ.get("S6_PG", "scqf-as-postgres")

# ---------------------------------------------------------------- 只读 SQL
# 每条都以 SELECT 开头；用 ### 分隔，便于回读时判断"这条到底跑没跑"。
SQ = {
    "1.迁移登记": r"""
SELECT '### 1.迁移登记'
 , count(*) AS migrations_total
FROM migrations;

SELECT '### 1b.本次涉及的迁移是否已登记'
 , name
FROM migrations
WHERE name LIKE '%20261106%'
   OR name LIKE '%20261023%'
   OR name LIKE '%20261025%'
ORDER BY name;

SELECT '### 1c.迁移文件数 vs 登记数（看是否有未执行的迁移文件）'
 , (SELECT count(*) FROM migrations) AS registered;
""",
    "2.索引": r"""
SELECT '### 2a.service_visits 索引'
 , indexname
 , indexdef
FROM pg_indexes
WHERE tablename = 'service_visits'
ORDER BY indexname;

SELECT '### 2b.service_tickets 索引'
 , indexname
 , indexdef
FROM pg_indexes
WHERE tablename = 'service_tickets'
ORDER BY indexname;

SELECT '### 2c.service_visits 列清单（看迁移要加的列是否已存在）'
 , column_name
 , data_type
 , is_nullable
FROM information_schema.columns
WHERE table_name = 'service_visits'
  AND column_name IN (
      'short_code_hash','short_code_expires_at',
      'manual_code_salt','manual_code_hash','manual_code_expires_at','manual_code_epoch',
      'access_token_hash','token_expires_at','token_used_at','visit_status')
ORDER BY column_name;
""",
    "3.触发器": r"""
SELECT '### 3a.trg_service_visits_one_assigned 是否存在'
 , t.tgname
 , c.relname AS table_name
 , p.proname AS func_name
 , t.tgenabled
 , pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE t.tgname = 'trg_service_visits_one_assigned';

SELECT '### 3b.该表上全部触发器（含版本：NocoBase 会不会随 sync 删掉）'
 , t.tgname
 , t.tgenabled
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
WHERE c.relname = 'service_visits'
  AND NOT t.tgisinternal
ORDER BY t.tgname;
""",
    "4.重复ASSIGNED": r"""
SELECT '### 4.同一工单多个 ASSIGNED（用户指定 SQL）'
 , ticket_id
 , count(*) AS assigned_count
FROM service_visits
WHERE visit_status = 'ASSIGNED'
GROUP BY ticket_id
HAVING count(*) > 1
ORDER BY ticket_id;

SELECT '### 4b.汇总：重复工单数 / 涉及行数'
 , count(*) AS dup_ticket_count
 , COALESCE(sum(assigned_count), 0) AS involved_rows
FROM (
    SELECT ticket_id, count(*) AS assigned_count
    FROM service_visits
    WHERE visit_status = 'ASSIGNED'
    GROUP BY ticket_id
    HAVING count(*) > 1
) x;

SELECT '### 4c.visit_status 分布（看整体健康度）'
 , visit_status
 , count(*) AS n
FROM service_visits
GROUP BY visit_status
ORDER BY n DESC;
""",
    "5.基础环境": r"""
SELECT '### 5a.数据库与版本'
 , current_database() AS db
 , version() AS v;

SELECT '### 5b.库大小与关键表行数'
 , pg_size_pretty(pg_database_size(current_database())) AS db_size
 , (SELECT count(*) FROM service_tickets) AS tickets
 , (SELECT count(*) FROM service_visits) AS visits
 , (SELECT count(*) FROM sms_logs) AS sms_logs;

SELECT '### 5c.短信通道当前状态（只读，判断部署不该动它）'
 , send_status
 , count(*) AS n
FROM sms_logs
GROUP BY send_status
ORDER BY n DESC;
""",
}


def main():
    if not PASS:
        print("缺少 S6_SSH_PASS 环境变量 —— 未做任何操作", flush=True)
        return 2
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        cli.connect(HOST, port=22, username=USER, password=PASS,
                    timeout=15, banner_timeout=20, auth_timeout=20,
                    look_for_keys=False, allow_agent=False)
    except Exception as exc:
        print("SSH 连接失败：%s: %s —— 未做任何操作" % (type(exc).__name__, exc), flush=True)
        return 3

    def run(cmd, timeout=180):
        _i, out, err = cli.exec_command(cmd, timeout=timeout, get_pty=False)
        o = out.read().decode("utf-8", "replace")
        e = err.read().decode("utf-8", "replace")
        return out.channel.recv_exit_status(), o.strip(), e.strip()

    print("[0] 已登录 %s@%s" % (USER, HOST), flush=True)
    rc, o, _ = run("hostname; date '+%F %T %Z'", 20)
    print("[0] 主机 %s" % o.replace("\n", " / "), flush=True)

    rc, o, _ = run("docker ps --format '{{.Names}}\t{{.Status}}'", 30)
    print("[1] 容器：\n%s\n" % o, flush=True)

    # 找 PG 容器名（不写死）
    names = [ln.split("\t")[0] for ln in o.splitlines() if ln.strip()]
    pg = PG if PG in names else next((n for n in names if "postgres" in n.lower() or "-pg" in n.lower()), PG)
    print("[2] PG 容器 = %s" % pg, flush=True)

    for title, sql in SQ.items():
        print("\n======== %s ========" % title, flush=True)
        cmd = "docker exec %s psql -U svc_app -d service_ticket -P pager=off -c %s" % (pg, shq(sql))
        rc, o, e = run(cmd, 180)
        print(o if o else "(无输出)", flush=True)
        if e:
            print("[stderr] %s" % e[:800], flush=True)
        print("[rc=%d]" % rc, flush=True)

    cli.close()
    print("\n[END] 只读检查结束（未执行任何 DDL/DML/迁移/重启）", flush=True)
    return 0


def shq(s):
    return "'" + s.replace("'", "'\\''") + "'"


if __name__ == "__main__":
    sys.exit(main())
