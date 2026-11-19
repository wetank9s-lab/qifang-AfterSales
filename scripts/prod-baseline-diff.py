#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""B 层：本地产物源码指纹(09:25 构建) vs 生产产物源码指纹(07:13 构建) 的权威对比。

判定口径：
  · 生产有 / 本地无  ⇒ 会回退生产已有功能（阻塞）
  · 哈希不同        ⇒ 需业务语义审读（逐个给出结论）
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOC = os.path.join(ROOT, "storage/plugins/@local/service-ticket/dist/build-fingerprint.json")
PRD = os.path.join(ROOT, ".tmp-verify/prod-close-test/prod-build-fingerprint.json")

loc = json.load(open(LOC, encoding="utf-8"))
prd = json.load(open(PRD, encoding="utf-8"))

print("本地构建  fileCount=%s  builtAt=%s" % (loc["fileCount"], loc["builtAt"]))
print("生产构建  fileCount=%s  builtAt=%s" % (prd["fileCount"], prd["builtAt"]))
print()

sl, sp = set(loc["files"]), set(prd["files"])
only_local = sorted(sl - sp)
only_prod = sorted(sp - sl)
diff = [f for f in sorted(sl & sp) if loc["files"][f] != prd["files"][f]]

print("[1] 本地有 / 生产无（新增，共 %d）" % len(only_local))
for f in only_local:
    print("    +", f)
print()
print("[2] 生产有 / 本地无（回退风险，共 %d）" % len(only_prod))
for f in only_prod:
    print("    -", f)
if not only_prod:
    print("    (无 —— 本地构建不缺少生产任何源文件)")
print()
print("[3] 两份都有但哈希不同（共 %d）" % len(diff))
for f in diff:
    print("    ~", f)
    print("        本地 %s" % loc["files"][f][:16])
    print("        生产 %s" % prd["files"][f][:16])
