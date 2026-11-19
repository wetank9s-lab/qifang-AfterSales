"""
只读查询生产库：确认「所有工单」页在生产上是否也只有一个「查看」，以及主按钮模型的挂载位置。
不做任何写操作。
"""
import os
import sys

import paramiko

HOST = os.environ.get("S6_SSH_HOST", "162.14.121.180")
USER = os.environ.get("S6_SSH_USER", "root")
PASS = os.environ.get("S6_SSH_PASS", "")

SQL = r"""
\pset pager off
\pset border 0

SELECT '--- 主按钮模型挂到哪些页面 ---';
SELECT DISTINCT dr.title || '  [' || dr.type || ']'
FROM "flowModels" fm
JOIN "flowModelTreePath" t ON t.descendant = fm.name
JOIN "desktopRoutes" dr ON dr."schemaUid" = t.ancestor
WHERE COALESCE(fm.options->>'use', fm.options->'schema'->>'use') = 'TicketPrimaryActionModel'
ORDER BY 1;

SELECT '--- 「所有工单」页的表格块与动作模型 ---';
SELECT COALESCE(fm.options->>'use', fm.options->'schema'->>'use') || '  d' || t2.depth
FROM "desktopRoutes" dr
JOIN "flowModelTreePath" t2 ON t2.ancestor = dr."schemaUid"
JOIN "flowModels" fm ON fm.name = t2.descendant
WHERE dr.title = '所有工单' AND dr.type = 'flowPage'
  AND COALESCE(fm.options->>'use', fm.options->'schema'->>'use') IS NOT NULL
ORDER BY t2.depth, 1;

SELECT '--- 六个状态页签挂在哪条路由下面 ---';
SELECT dr.title || '  parentTitle=' || COALESCE((SELECT p.title FROM "desktopRoutes" p WHERE p.id = dr."parentId"), 'null')
FROM "desktopRoutes" dr
WHERE dr.title IN ('全部','待处理','处理中','待门店确认','待客户评价','已结束')
ORDER BY 1;
"""

if not PASS:
    print("需要 S6_SSH_PASS")
    sys.exit(1)

cli = paramiko.SSHClient()
cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cli.connect(HOST, username=USER, password=PASS, timeout=25)

cmd = (
    "docker exec -i scqf-as-postgres psql -U scqf_as -d scqf_aftersales_candidate "
    "-v ON_ERROR_STOP=1 -t -A"
)
stdin, stdout, stderr = cli.exec_command(cmd, timeout=90)
stdin.write(SQL)
stdin.channel.shutdown_write()
out = stdout.read().decode("utf-8", "replace")
err = stderr.read().decode("utf-8", "replace")
print(out)
if err.strip():
    print("STDERR:", err[:800])
cli.close()
