#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""远端标记探针：把待查串转成 \\uXXXX 后逐个数，避免 shell/grep 编码问题。"""
import importlib.util, os

spec = importlib.util.spec_from_file_location("dep", "scripts/prod-deploy-sms-fix-01.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

BS = chr(92)
NEEDLES = [
    "师傅任务通知", "客户报修成功通知", "客户处理进展通知",
    "模板待供应商审核", "原因待核实", "smsErrorDetail", "error_message",
    "您有新的售后服务任务",
]
GATE = "SMS_REVIEW_PENDING_SCENES = []"
GATE_ALT = "SMS_REVIEW_PENDING_SCENES=[]"

PROBE = '''
import sys
bs = chr(92)
path = sys.argv[1]
d = open(path, encoding='utf-8', errors='replace').read()
for w in sys.argv[2:]:
    up = ''.join(bs + 'u%04X' % ord(c) for c in w)
    lo = ''.join(bs + 'u%04x' % ord(c) for c in w)
    print('%s | raw=%d up=%d low=%d' % (w, d.count(w), d.count(up), d.count(lo)))
'''

r = m.R()
try:
    dist = m.detect_dist(r)
    # 写探针脚本（heredoc 内无变量展开风险，用单引号）
    r.sftp.open("/root/.probe2.py", "w").write(PROBE)
    for tag, rel in [("server", "server/index.js"), ("client", "client/index.js")]:
        cmd = ("cd %s && python3 /root/.probe2.py %s %s"
               % (m.shq(dist), m.shq(rel), " ".join(m.shq(w) for w in NEEDLES)))
        out, err = r.run(cmd, 120)
        print("=" * 66)
        print("[%s]" % tag)
        print(out.strip() or ("(空) " + err.strip()[:300]))
        if tag == "server":
            o, _ = r.run("cd %s && grep -c 'SMS_REVIEW_PENDING_SCENES' server/index.js" % m.shq(dist), 60)
            print("    SMS_REVIEW_PENDING_SCENES 出现次数 =", o.strip())
            o, _ = r.run("cd %s && grep -o 'SMS_REVIEW_PENDING_SCENES[^,;]\\{0,40\\}' server/index.js | head -4" % m.shq(dist), 60)
            print("    上下文:", o.strip().replace("\n", " || "))
finally:
    r.close()
