#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""P0-1 生产只读探针 v2：把 bundle 里相关代码片段**原样打印**，交给人工核对。

为什么不用计数下结论（v1 的教训）：
  v1 报「请填写维修措施，至少 5 个字 → 0 次」，看起来像"文案没上线"。
  但源码里这句是**模板字符串**：
      `请填写维修措施，至少 ${SERVICE_NOTE_MIN_EFFECTIVE} 个字`
  esbuild 会把它拆成 `"请填写维修措施，至少 ".concat(n," 个字")` 之类，
  **整句原文本来就不存在**。计数为 0 是"判据写法错"，不是"产品错"。
  ⇒ 正确做法：打印片段，看结构；或把判据拆成两段分别查。

同理 `SERVICE_RESULT_NOTE_OPTIONAL` 出现 4 次，需要看清它现在**还被谁用**：
  如果只是常量定义 + 类型，那没问题；如果仍参与"是否必填"的判断，就是老规则没清干净。
"""
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("dep", "scripts/prod-deploy-sms-fix-01.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

PROBE = r'''
import sys, re
path = sys.argv[1]
d = open(path, 'r', encoding='utf-8', errors='replace').read()

def show(label, needle, before=500, after=700, limit=3):
    print('\n===== %s  (needle=%r) =====' % (label, needle))
    n = 0
    i = d.find(needle)
    while i != -1 and n < limit:
        print('--- @%d ---' % i)
        print(d[max(0, i-before):i+after])
        n += 1
        i = d.find(needle, i+1)
    if n == 0:
        print('(未找到)')

# 1) 模板字符串拆解后的真实形态
show('最短校验文案（拆段查）', '请填写维修措施')
# 2) 老常量还在被谁用
show('SERVICE_RESULT_NOTE_OPTIONAL', 'SERVICE_RESULT_NOTE_OPTIONAL', 300, 400, 4)
# 3) 校验调用点 + 事务入口的相对位置
show('validateServiceNote 调用点', 'SERVICE_NOTE_TOO_SHORT', 1800, 900, 1)
'''

r = m.R()
try:
    FIND = ("docker inspect scqf-as-app --format '{{range .Mounts}}"
            "{{if eq .Destination \"/app/nocobase/node_modules/@local/service-ticket\"}}{{.Source}}{{end}}{{end}}'")
    r.sftp.open("/root/.probe-p01-order2.py", "w").write(PROBE)
    o, _ = r.run("P=$(%s); python3 /root/.probe-p01-order2.py \"$P/dist/server/index.js\"" % FIND, 120)
    sys.stdout.write(o)
finally:
    r.close()
