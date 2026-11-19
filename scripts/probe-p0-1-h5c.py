#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P0-1：查 /www/wwwroot/sh.scqfls.cn/h5 实际产物里的文案。只读。"""
import importlib.util

spec = importlib.util.spec_from_file_location("dep", "scripts/prod-deploy-sms-fix-01.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

PROBE = '''
import sys
bs = chr(92)
d = open(sys.argv[1], encoding='utf-8', errors='replace').read()
for w in sys.argv[2:]:
    lo = ''.join(bs + 'u%04x' % ord(c) for c in w)
    up = ''.join(bs + 'u%04X' % ord(c) for c in w)
    print('%s | raw=%d low=%d UP=%d' % (w, d.count(w), d.count(lo), d.count(up)))
'''

NEEDLES = ["处理说明（选填）", "维修措施", "请填写维修措施", "维修措施（必填）", "选填", "必填"]

r = m.R()
try:
    o, _ = r.run("ls -la /www/wwwroot/sh.scqfls.cn/h5/ /www/wwwroot/sh.scqfls.cn/h5/assets/ | head -25", 60)
    print("[目录]")
    print(o.strip())

    r.sftp.open("/root/.probe-h5.py", "w").write(PROBE)
    o, _ = r.run(
        "for f in /www/wwwroot/sh.scqfls.cn/h5/assets/*.js; do echo \"== $f\"; "
        "python3 /root/.probe-h5.py \"$f\" %s; done" % " ".join(m.shq(w) for w in NEEDLES), 180)
    print("\n[文案命中]")
    print(o.strip())
finally:
    r.close()
