#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地 h5/dist 特征计数（与 probe-p0-1-h5d.py 用同一套判据，便于逐行对比）。

单独成文件是为了让远端探针和本地探针共用一份 NEEDLES —— 两处各抄一份的话，
改判据时必然只改一处，然后得出"线上有、本地没有"的假差。
"""
import glob
import hashlib
import io

BS = chr(92)

NEEDLES = [
    ('P0-1 维修措施标题', '维修措施'),
    ('P0-1 维修措施必填提示', '请填写维修措施'),
    ('OLD  处理说明（选填）', '处理说明（选填）'),
    ('P6B  清除本机记录按钮', '这不是我的工单'),
    ('P6B  提交新工单入口', '提交新工单'),
    ('P6C  评价直连Action', 'publicReview:submit'),
    # ⚠️ 判据必须是**真实 UI 文案**，不能拿源码注释当特征：
    #    esbuild 会剥掉注释，注释里的句子在产物中永远为 0，
    #    这种"恒 0"的 needle 看起来像"功能缺失"，实际是判据自己错了。
    #    （原写 `结果无法确认`，它只存在于 Review/index.vue:469 的注释里。）
    ('P6E  感谢页文案', '感谢您的评价'),
    ('BASE 服务报修标题', '服务报修'),
]

for path in sorted(glob.glob("h5/dist/assets/*.js")):
    data = open(path, "rb").read()
    d = data.decode("utf-8", errors="replace")
    print("[FILE] %s  bytes=%d  sha256=%s" % (path, len(data), hashlib.sha256(data).hexdigest()[:16]))
    print("%-24s %6s %8s %8s" % ("needle", "raw", "u-lower", "u-UPPER"))
    for label, w in NEEDLES:
        lo = "".join(BS + "u%04x" % ord(c) for c in w)
        up = "".join(BS + "u%04X" % ord(c) for c in w)
        print("%-24s %6d %8d %8d" % (label, d.count(w), d.count(lo), d.count(up)))
    i = d.find("维修措施")
    while i != -1:
        print("[CTX] ..." + d[max(0, i - 120):i + 60].replace("\n", " ") + "...")
        i = d.find("维修措施", i + 1)

for path in sorted(glob.glob("h5/dist/assets/*.css")):
    data = open(path, "rb").read()
    print("[CSS] %s  bytes=%d  sha256=%s" % (path, len(data), hashlib.sha256(data).hexdigest()[:16]))
