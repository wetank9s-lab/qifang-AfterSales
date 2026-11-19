#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P0-1 前置（只读）：确认**生产后端**是否已包含维修措施必填校验。

为什么必须先查这个：
  用户要求"后端同步非空校验（不能只靠前端）"。
  仓库源码里 action 层 + service 层都已调用 validateServiceNote，但源码 ≠ 线上。
  本轮 15:20 刚部署过 server/index.js（指纹 e1fe6c8075dc224f），它是否含这条规则
  决定 P0-1 到底是"只发 H5" 还是"还要再发一次 server"。

判据（精确到错误码，不用泛词）：
  SERVICE_NOTE_TOO_SHORT / SERVICE_NOTE_TOO_LONG / 请填写维修措施
  —— 三者同时出现才判"后端已含"；只出现一个不足以定论（可能是别的分支的残余）。
"""
import importlib.util

spec = importlib.util.spec_from_file_location("dep", "scripts/prod-deploy-sms-fix-01.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

PROBE = r'''
import sys, hashlib, os, json
bs = chr(92)
root = sys.argv[1]
files = ['server/index.js', 'client/index.js']
NEEDLES = [
    ('SERVICE_NOTE_TOO_SHORT',  'SERVICE_NOTE_TOO_SHORT'),
    ('SERVICE_NOTE_TOO_LONG',   'SERVICE_NOTE_TOO_LONG'),
    ('msg 请填写维修措施',       '请填写维修措施'),
    ('msg 维修措施不能超过',     '维修措施不能超过'),
    ('P0-1 前端标题 维修措施',   '维修措施'),
    ('OLD 处理说明（选填）',     '处理说明（选填）'),
    ('BE-03 SMS 闸门已清空标记', 'SMS_REVIEW_PENDING_SCENES'),
]
for f in files:
    p = os.path.join(root, f)
    if not os.path.exists(p):
        print('[MISS]', p); continue
    data = open(p, 'rb').read()
    d = data.decode('utf-8', errors='replace')
    print('[FILE] %s bytes=%d sha256=%s' % (f, len(data), hashlib.sha256(data).hexdigest()[:16]))
    for label, w in NEEDLES:
        lo = ''.join(bs + 'u%04x' % ord(c) for c in w)
        up = ''.join(bs + 'u%04X' % ord(c) for c in w)
        print('   %-26s raw=%-3d lo=%-3d up=%-3d' % (label, d.count(w), d.count(lo), d.count(up)))
'''

r = m.R()
try:
    # 按 docker inspect 的挂载点定位，**不要** find /opt（生产有 4 个同名 dist）
    o, _ = r.run(
        "docker inspect scqf-as-app --format '{{range .Mounts}}{{.Source}} => {{.Destination}}{{\"\\n\"}}{{end}}'", 60)
    print("[挂载点]\n" + o.strip())

    # ⚠️ 挂载目的地带 `/app/nocobase` 前缀（实测），不是 `/app/node_modules/...`
    FIND = ("docker inspect scqf-as-app --format '{{range .Mounts}}"
            "{{if eq .Destination \"/app/nocobase/node_modules/@local/service-ticket\"}}{{.Source}}{{end}}{{end}}'")
    o, _ = r.run("P=$(%s); echo \"plugin_source=$P\"; ls -l \"$P/dist\"; ls -l \"$P/dist/migrations\" | tail -3" % FIND, 60)
    print("\n[插件挂载]\n" + o.strip())

    r.sftp.open("/root/.probe-p01-server.py", "w").write(PROBE)
    o, _ = r.run("P=$(%s); python3 /root/.probe-p01-server.py \"$P/dist\"" % FIND, 120)
    print("\n[产物特征]\n" + o.strip())
finally:
    r.close()
