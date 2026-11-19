#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""三形态探针：原文 / \\uXXXX 大写 / \\uxxxx 小写。"""
import sys, os, importlib.util

spec = importlib.util.spec_from_file_location("dep", "scripts/prod-deploy-sms-fix-01.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

BS = chr(92)
NEEDLES = [
    "师傅任务通知", "客户报修成功通知", "客户处理进展通知",
    "模板待供应商审核", "原因待核实",
    "您有新的售后服务任务", "请点击链接查看并处理",
]

r = m.R()
try:
    dist = m.detect_dist(r)
    files = {"server": "server/index.js", "client": "client/index.js"}
    for tag, rel in files.items():
        path = rel  # 远端相对路径，下面 cd 到 dist
        # 用 python 远端跑：直接读文件、三种编码数一遍（不依赖 grep 的编码处理）
        code = (
            "import sys\n"
            "d=open(sys.argv[1],encoding='utf-8',errors='replace').read()\n"
            "bs=chr(92)\n"
            "for w in sys.argv[2:]:\n"
            "    up=''.join(bs+'u%04X'%ord(c) for c in w)\n"
            "    lo=''.join(bs+'u%04x'%ord(c) for c in w)\n"
            "    print(w, '|raw=', d.count(w), '|UP=', d.count(up), '|low=', d.count(lo))\n"
        )
        r.run("cat > /root/.probe-marks.py <<'PYEOF'\n" + code + "\nPYEOF", 30)
        out, err = r.run("cd %s && python3 /root/.probe-marks.py %s %s"
                         % (m.shq(dist), m.shq(path), " ".join(m.shq(w) for w in NEEDLES)), 120)
        print("=" * 60)
        print("[%s] %s" % (tag, path))
        print(out.strip() or ("(空) " + err.strip()[:300]))
finally:
    r.close()
