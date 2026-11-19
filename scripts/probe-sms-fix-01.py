#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BE-03-SMS-FIX-01 第一步：只读定位 14:49:47 附近 technician_task 未发送的真实原因。

只做 SELECT。不改任何数据、不发任何短信。
"""
import os
import sys
import json

HOST = os.environ.get("S6_HOST", "162.14.121.180")
USER = os.environ.get("S6_USER", "root")
KEY = os.environ.get("S6_SSH_KEY", os.path.join(os.path.expanduser("~"), ".ssh", "id_ed25519"))
PASS = os.environ.get("S6_SSH_PASS", "")
PG = os.environ.get("S6_PG", "scqf-as-postgres")
DB_USER = os.environ.get("S6_PG_USER", "scqf_as")
DB_NAME = os.environ.get("S6_PG_DB", "scqf_aftersales_candidate")

import paramiko


def shq(s):
    return "'" + str(s).replace("'", "'\"'\"'") + "'"


class R:
    def __init__(self):
        c = paramiko.SSHClient()
        c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        c.connect(HOST, port=22, username=USER, password=PASS or None,
                  key_filename=KEY if os.path.exists(KEY) else None,
                  timeout=15, banner_timeout=20, auth_timeout=20,
                  look_for_keys=True, allow_agent=False)
        self.c = c

    def run(self, cmd, timeout=120):
        _, o, e = self.c.exec_command(cmd, timeout=timeout)
        return (o.read().decode("utf-8", "replace"), e.read().decode("utf-8", "replace"))

    def psql(self, sql, timeout=120):
        cmd = ("docker exec -i %s psql -U %s -d %s -X -A -F '|' -P pager=off -c %s"
               % (shq(PG), shq(DB_USER), shq(DB_NAME), shq(sql)))
        out, err = self.run(cmd, timeout)
        if err.strip():
            return out, err
        return out, ""

    def close(self):
        self.c.close()


def sec(t):
    print("\n" + "=" * 78)
    print(t)
    print("=" * 78)


def main():
    r = R()
    try:
        sec("[0] 环境确认")
        o, _ = r.run("hostname; docker ps --format '{{.Names}}|{{.Status}}' | grep -E 'scqf-as'")
        print(o.strip())

        sec("[1] sms_logs 表结构（只认得准列名才查得对）")
        o, e = r.psql("SELECT column_name, data_type FROM information_schema.columns "
                      "WHERE table_name='sms_logs' ORDER BY ordinal_position;")
        print(o.strip())
        if e.strip():
            print("ERR:", e.strip()[:400])

        sec("[2] 14:40–15:00 全部短信日志（只读）")
        o, e = r.psql(
            "SELECT id, to_char(created_at,'MM-DD HH24:MI:SS') AS t, scene, send_status, "
            "       delivery_status, provider, COALESCE(error_code,'-') AS err, "
            "       COALESCE(left(error_message,90),'-') AS emsg, "
            "       COALESCE(recipient_masked,'-') AS rcpt, COALESCE(ticket_id::text,'-') AS ticket "
            "FROM sms_logs WHERE created_at >= '2026-11-06 14:40:00' "
            "ORDER BY created_at;")
        print(o.strip())
        if e.strip():
            print("ERR:", e.strip()[:400])

        sec("[3] 该时段 technician_task 明细（含模板/参数/渲染结果，若有这些列）")
        o, e = r.psql("SELECT * FROM sms_logs WHERE scene='technician_task' "
                      "ORDER BY created_at DESC LIMIT 3;")
        print(o.strip()[:4000])
        if e.strip():
            print("ERR:", e.strip()[:400])

        sec("[4] 场景维度历史分布（判断 technician_task 是一直没成功还是今天才坏）")
        o, e = r.psql("SELECT scene, provider, send_status, COALESCE(error_code,'-') AS err, "
                      "       count(*) AS n, min(created_at)::date AS first, max(created_at)::date AS last "
                      "FROM sms_logs GROUP BY 1,2,3,4 ORDER BY scene, n DESC;")
        print(o.strip())
        if e.strip():
            print("ERR:", e.strip()[:400])

        sec("[5] 对应工单（14:49:47 附近）")
        o, e = r.psql("SELECT id, ticket_no, status, created_at, "
                      "       COALESCE(technician_id::text,'-') AS tech "
                      "FROM service_tickets WHERE created_at >= '2026-11-06 14:45:00' "
                      "ORDER BY created_at;")
        print(o.strip())
        if e.strip():
            print("ERR:", e.strip()[:400])

    finally:
        r.close()


if __name__ == "__main__":
    sys.exit(main() or 0)
