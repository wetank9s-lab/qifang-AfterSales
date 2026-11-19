#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""arc-a0-probe.py —— ARC-V1 / A0 只读环境核查

纪律：
  · **只读**：所有语句均为 SELECT / \\d / pg_catalog 查询，不含任何写操作；
  · 不打印凭据；SSH 用本机密钥；
  · SQL 通过 stdin 喂 psql，避免 ssh -> sh -> psql 三层引号被二次解析；
  · 生产库只读，不做任何 DDL/DML。
"""
import sys

import paramiko

HOST = "162.14.121.180"
USER = "root"
PG = "scqf-as-postgres"
DB = "scqf_aftersales_candidate"
PGUSER = "scqf_as"
APP = "scqf-as-app"


class R:
    def __init__(self):
        self.c = paramiko.SSHClient()
        self.c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        self.c.connect(HOST, port=22, username=USER, timeout=20,
                       banner_timeout=25, auth_timeout=25,
                       look_for_keys=True, allow_agent=True)

    def run(self, cmd, stdin=None, timeout=120):
        _i, o, e = self.c.exec_command(cmd, timeout=timeout)
        if stdin is not None:
            _i.write(stdin)
            _i.channel.shutdown_write()
        out = o.read().decode("utf-8", "replace").strip()
        err = e.read().decode("utf-8", "replace").strip()
        rc = o.channel.recv_exit_status()
        return rc, out, err

    def sql(self, statement, timeout=120):
        cmd = ("docker exec -i %s psql -U %s -d %s -v ON_ERROR_STOP=1 "
               "-A -t -F '|' -f -" % (PG, PGUSER, DB))
        return self.run(cmd, stdin=statement, timeout=timeout)

    def show(self, title, statement):
        rc, out, err = self.sql(statement)
        print("\n===== %s =====" % title)
        if rc != 0:
            print("[rc=%s] %s" % (rc, (err or out)[:500]))
            return []
        lines = [ln for ln in out.splitlines() if ln.strip()]
        for ln in lines:
            print("  " + ln)
        if not lines:
            print("  (空)")
        return lines

    def close(self):
        self.c.close()


def main():
    r = R()
    try:
        rc, out, _ = r.run('docker exec %s sh -c "ls /app/node_modules/@nocobase | grep -iE \'mobile|file-manager|sms|auth|acl\'" 2>/dev/null' % APP)
        print("===== @nocobase 相关包 =====")
        print(out or "  (未列出)")

        r.show("已启用插件", '''
SELECT name, coalesce(version, chr(45)), enabled::text
FROM "applicationPlugins" ORDER BY name;
''')

        r.show("stores 表结构", '''
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'stores' ORDER BY ordinal_position;
''')

        r.show("stores 实际数据", '''
SELECT * FROM stores ORDER BY id;
''')

        r.show("storeUsers 表结构", '''
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'storeUsers' ORDER BY ordinal_position;
''')

        r.show("storeUsers 实际数据", '''
SELECT * FROM "storeUsers" ORDER BY 1;
''')

        r.show("roles 列表", '''
SELECT id, name, title, coalesce(description, chr(45))
FROM roles ORDER BY id;
''')

        r.show("rolesUsers 分布", '''
SELECT "roleName", count(*) FROM "rolesUsers" GROUP BY "roleName" ORDER BY "roleName";
''')

        r.show("移动端路由", '''
SELECT 'mobileRoutes=' || (SELECT count(*) FROM "mobileRoutes")
    || ' rolesMobileRoutes=' || (SELECT count(*) FROM "rolesMobileRoutes");
''')

        r.show("文件存储相关表", '''
SELECT tablename FROM pg_tables WHERE schemaname='public'
  AND (tablename ILIKE '%storage%' OR tablename ILIKE '%attach%' OR tablename ILIKE '%file%')
ORDER BY 1;
''')

        r.show("短信相关表", '''
SELECT tablename FROM pg_tables WHERE schemaname='public'
  AND (tablename ILIKE '%sms%') ORDER BY 1;
''')

        r.show("业务表清单（service 前缀）", '''
SELECT tablename FROM pg_tables WHERE schemaname='public'
  AND tablename ILIKE 'service%' ORDER BY 1;
''')

        r.show("service_tickets 行数 / service_visits 行数", '''
SELECT 'service_tickets=' || (SELECT count(*) FROM service_tickets)
    || ' service_visits=' || (SELECT count(*) FROM service_visits);
''')
    finally:
        r.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
