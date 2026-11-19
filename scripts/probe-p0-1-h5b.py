#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P0-1：定位线上 /h5 实际服务的 JS，查两版文案。只读。"""
import importlib.util, json, os, re

spec = importlib.util.spec_from_file_location("dep", "scripts/prod-deploy-sms-fix-01.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

BS = chr(92)
NEEDLES = ["处理说明（选填）", "维修措施（必填）", "维修措施", "请填写维修措施",
           "处理说明", "选填", "必填"]

PROBE = '''
import sys
bs = chr(92)
d = open(sys.argv[1], encoding='utf-8', errors='replace').read()
for w in sys.argv[2:]:
    up = ''.join(bs + 'u%04x' % ord(c) for c in w)
    up2 = ''.join(bs + 'u%04X' % ord(c) for c in w)
    print('%s | raw=%d low=%d UP=%d' % (w, d.count(w), d.count(up), d.count(up2)))
'''

r = m.R()
try:
    # root 在哪
    o, _ = r.run("grep -n 'root ' /www/server/panel/vhost/nginx/sh.scqfls.cn.conf | head -10", 60)
    print("[vhost root]")
    print(o.strip() or "(无)")

    o, _ = r.run("grep -n 'h5' /www/server/panel/vhost/nginx/sh.scqfls.cn.conf | head -20", 60)
    print("\n[vhost 里 h5 相关行]")
    print(o.strip() or "(无)")

    # 线上实际那个 js
    js = "/opt/scqf-aftersales/scqf-src/h5/dist/assets/index-B-QCspWq.js"
    o, _ = r.run("ls -la %s 2>/dev/null || echo MISSING" % m.shq(js), 30)
    print("\n[线上引用的 JS]", o.strip())

    r.sftp.open("/root/.probe-h5.py", "w").write(PROBE)
    o, err = r.run("python3 /root/.probe-h5.py %s %s"
                   % (m.shq(js), " ".join(m.shq(w) for w in NEEDLES)), 120)
    print("\n[文案命中]")
    print(o.strip() or ("(空) " + err.strip()[:200]))

    # 该 dist 的构建时间
    o, _ = r.run("stat -c '%%y %%s' %s" % m.shq(js), 30)
    print("\n[构建时间 / 大小]", o.strip())
finally:
    r.close()
