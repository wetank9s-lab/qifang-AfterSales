#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P0-1 前置：判定生产 H5 产物到底包含哪一批改动（只读，不改生产）。

为什么需要这一步：
  仓库里 `h5/src` 有 9 个文件未提交，其中只有 Visit.vue 的「维修措施必填」是本次 P0-1 范围，
  其余（Progress.vue / ProgressReview.vue / api/review.ts / api/media.ts ...）属于 P6 系列。
  直接 `vite build` 会把它们**一起**打进产物。部署前必须知道：
    A. 线上是否**已经**跑了这些改动（若是，"全量构建"就等于"只增量了 Visit.vue"）
    B. 线上是否**没有**这些改动（若是，全量构建会顺带上线 P6，超出 P0-1 授权）

判据选取原则（见 ENGINEERING-RULES：判据太宽 = 自造假红）：
  一律用**本次改动独有的字符串常量**，不用泛词（"必填"/"选填"这类会撞上其它页面）。
  并且 raw / \\u小写 / \\u大写 三种形态都数 —— esbuild 会把中文转义。
"""
import importlib.util
import hashlib

spec = importlib.util.spec_from_file_location("dep", "scripts/prod-deploy-sms-fix-01.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

PROBE = r'''
import sys, hashlib, json
bs = chr(92)
path = sys.argv[1]
data = open(path, 'rb').read()
print('[FILE] %s  bytes=%d  sha256=%s' % (path, len(data), hashlib.sha256(data).hexdigest()[:16]))
d = data.decode('utf-8', errors='replace')

# 每条 = (标签, 该改动独有的字符串常量)
#   P0-1  : 本次要上线的那一条
#   P6B   : Progress.vue 的"这不是我的工单/清除记录"按钮 + 门店电话行
#   P6C   : Review 提交改直连 Action（/api/publicReview:submit）
#   P6D   : MediaUploader 50MiB 上限对齐
#   P6E   : 评价提交防假成功（"结果无法确认"）
NEEDLES = [
    ('P0-1 维修措施标题',      '维修措施'),
    ('P0-1 维修措施必填提示',  '请填写维修措施'),
    ('OLD  处理说明（选填）',  '处理说明（选填）'),
    ('P6B  清除本机记录按钮',  '这不是我的工单'),
    ('P6B  提交新工单入口',    '提交新工单'),
    ('P6C  评价直连Action',    'publicReview:submit'),
    ('P6E  结果无法确认',      '结果无法确认'),
    ('BASE 服务报修标题',      '服务报修'),
]
print('%-24s %6s %8s %8s' % ('needle', 'raw', 'u-lower', 'u-UPPER'))
for label, w in NEEDLES:
    lo = ''.join(bs + 'u%04x' % ord(c) for c in w)
    up = ''.join(bs + 'u%04X' % ord(c) for c in w)
    print('%-24s %6d %8d %8d' % (label, d.count(w), d.count(lo), d.count(up)))

# 维修措施上下文：确认它出现在 svc-label + 必填星号的位置，而不是别处
i = d.find('维修措施')
while i != -1:
    print('[CTX] ...' + d[max(0, i - 120):i + 60].replace('\n', ' ') + '...')
    i = d.find('维修措施', i + 1)
'''


def sha_local(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


r = m.R()
try:
    # ---- 1) 线上产物 ----
    o, _ = r.run("ls -l /www/wwwroot/sh.scqfls.cn/h5/index.html", 60)
    print("[index.html]\n" + o.strip())
    o, _ = r.run("cat /www/wwwroot/sh.scqfls.cn/h5/index.html", 60)
    print("\n[index.html 内容]\n" + o.strip())

    r.sftp.open("/root/.probe-h5d.py", "w").write(PROBE)
    print("\n[线上产物特征]")
    o, _ = r.run("cd /www/wwwroot/sh.scqfls.cn/h5 && for f in assets/*.js; do python3 /root/.probe-h5d.py \"$f\"; done", 180)
    print(o.strip())

    print("\n[线上 CSS 特征]")
    o, _ = r.run("cd /www/wwwroot/sh.scqfls.cn/h5 && for f in assets/*.css; do echo \"== $f\"; sha256sum \"$f\"; wc -c \"$f\"; done", 60)
    print(o.strip())
finally:
    r.close()

# ---- 2) 本地 10-29 构建产物 ----
print("\n[本地 h5/dist 特征]")
import subprocess
print(subprocess.run(["python", "scripts/_local_h5_feat.py"], capture_output=True, text=True).stdout or "")
