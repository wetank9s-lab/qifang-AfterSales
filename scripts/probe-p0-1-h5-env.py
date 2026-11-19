#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P0-1 部署方案的前置体检（**全部只读**）。

目的：在向用户提交部署方案之前，先把"能不能安全部署"的硬条件查清楚，
      避免批下来之后才发现备份做不了 / 路径不对 / 有别的容器也在读这个目录。

检查项：
  1. nginx 站点配置里 /h5/ 的真实 root 与 try_files（决定产物落哪）
  2. 该目录当前内容（有多少历史垃圾产物、总大小）
  3. 是否有其它容器也挂载了这个 h5 目录（改了会影响谁）
  4. 磁盘剩余空间（备份需要 ~200KB，不是问题，但要留证）
"""
import importlib.util

spec = importlib.util.spec_from_file_location("dep", "scripts/prod-deploy-sms-fix-01.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

H5 = "/www/wwwroot/sh.scqfls.cn/h5"

CMDS = [
    ("① nginx /h5/ 配置",
     "grep -n -A8 'location \\^~ /h5/' /www/server/panel/vhost/nginx/sh.scqfls.cn.conf"),
    ("② h5 目录内容（按时间）",
     "ls -la %s/ && echo '--- assets ---' && ls -la %s/assets/ | head -40" % (H5, H5)),
    ("③ 目录占用与文件数",
     "du -sh %s; find %s -type f | wc -l" % (H5, H5)),
    ("④ 是否有其它容器挂载该目录",
     "for c in $(docker ps --format '{{.Names}}'); do "
     "docker inspect \"$c\" --format '{{if .Mounts}}{{range .Mounts}}{{.Source}} {{end}}{{end}}' "
     "| tr ' ' '\\n' | grep -q '%s' && echo \"READER: $c\"; done; echo '(以上为空则只有 nginx 在用)'" % H5),
    ("⑤ 磁盘余量",
     "df -h %s | tail -2" % H5),
]

r = m.R()
try:
    for title, cmd in CMDS:
        o, rc = r.run(cmd, 90)
        print("=" * 78)
        print(title, "  rc=%s" % rc)
        print(o.strip() or "(空)")
        print()
finally:
    r.close()
