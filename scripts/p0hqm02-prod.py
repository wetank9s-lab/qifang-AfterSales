#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""p0hqm02-prod.py —— P0-HQ-MENU-02 生产部署（定向增量，只加不删）

设计纪律：
  · 只用密钥认证（本机 id_ed25519 已被生产接受），口令/密钥不进命令行、不落盘；
  · SQL 通过 stdin 喂给 psql，避免多层引号被 ssh / sh 二次解析（本地已被这个坑咬过）；
  · **只 INSERT，不 DELETE**：任何要删除的意图都直接拒绝并退出；
  · 先 --snapshot（只读），再 --plan（预演），最后 --apply（写）。
"""
import json
import os
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
        """把 SQL 从 stdin 喂给 psql：-A -t -F '|'，无插值、无二次解析。"""
        cmd = (
            "docker exec -i %s psql -U %s -d %s -v ON_ERROR_STOP=1 "
            "-A -t -F '|' -f -" % (PG, PGUSER, DB)
        )
        return self.run(cmd, stdin=statement, timeout=timeout)

    def close(self):
        self.c.close()


def rows(text):
    return [ln for ln in text.splitlines() if ln.strip()]


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--snapshot"
    r = R()
    try:
        if mode == "--snapshot":
            rc, out, err = r.sql(
                'SELECT "roleName", count(*) FROM "rolesDesktopRoutes" '
                'GROUP BY "roleName" ORDER BY "roleName";'
            )
            print("[逐角色行数] rc=%s" % rc)
            print(out or err)
            rc2, out2, _ = r.sql('SELECT count(*) FROM "rolesDesktopRoutes";')
            print("[total] %s" % out2)

            rc3, out3, _ = r.sql(
                'SELECT d.type, d.title, d.id FROM "rolesDesktopRoutes" r '
                'JOIN "desktopRoutes" d ON d.id = r."desktopRouteId" '
                'WHERE r."roleName" = \'hq_admin\' ORDER BY d.id;'
            )
            print("[hq_admin 明细] rc=%s" % rc3)
            print(out3)

            for label, sql in [
                ("flowModels",
                 'SELECT count(*), md5(string_agg(uid, chr(124) ORDER BY uid)) FROM "flowModels";'),
                ("desktopRoutes",
                 'SELECT count(*), md5(string_agg(id::text, chr(124) ORDER BY id)) FROM "desktopRoutes";'),
                ("uiSchemas",
                 'SELECT count(*), md5(string_agg("x-uid" || chr(126) || coalesce(name, chr(0)) '
                 '|| chr(126) || schema::text, chr(124) ORDER BY "x-uid")) FROM "uiSchemas";'),
            ]:
                rc4, out4, err4 = r.sql(sql)
                print("[%s] rc=%s %s" % (label, rc4, out4 or err4))

            rc5, out5, _ = r.sql('SELECT count(*) FROM service_tickets;')
            print("[service_tickets] %s" % out5)
            rc6, out6, _ = r.sql('SELECT count(*) FROM store_users;')
            print("[store_users] %s" % out6)
            return 0

        print("未知模式 %s" % mode)
        return 2
    finally:
        r.close()


if __name__ == "__main__":
    sys.exit(main())
