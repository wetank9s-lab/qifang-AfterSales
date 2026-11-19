#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""P0-1 生产后端产物 vs 本地源码：确认「旧校验分支」在线上是否真的还活着。

背景（本轮实测发现）：
  生产 server/index.js 里 428042 字符处还有一段旧规则：
      if (!SERVICE_RESULT_NOTE_OPTIONAL.includes(serviceResult) && (!serviceNote || !serviceNote.length))
          throw new ValidationError("MISSING_SERVICE_NOTE", "...时必须填写处理说明")
  而本地源码 `visit-service.ts` 里 `MISSING_SERVICE_NOTE` 已经**一次都不出现**。
  ⇒ 生产 bundle 比当前源码旧。

需要判断的只有一件事：这段旧代码**是否可达**。
  若不可达（例如被前面的 validateServiceNote 先抛掉），那就是死代码，不影响功能；
  若可达，则是一条**绕过新规则的旁路**（旧分支只看"非空"，一个空格也能过）。
本脚本只做静态取证，不改生产。
"""
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("dep", "scripts/prod-deploy-sms-fix-01.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

PROBE = r'''
import sys
path = sys.argv[1]
d = open(path, 'r', encoding='utf-8', errors='replace').read()

i = d.find('MISSING_SERVICE_NOTE')
if i == -1:
    print('[OK] 生产 bundle 里没有 MISSING_SERVICE_NOTE')
    raise SystemExit

# 往前找这个函数的起点（async xxx( 或 function xxx(），把上下文打全
start = max(0, i - 3000)
seg = d[start:i + 800]
print('[SEGMENT] len=%d' % len(seg))
print(seg)
'''

r = m.R()
try:
    FIND = ("docker inspect scqf-as-app --format '{{range .Mounts}}"
            "{{if eq .Destination \"/app/nocobase/node_modules/@local/service-ticket\"}}{{.Source}}{{end}}{{end}}'")
    r.sftp.open("/root/.probe-p01-legacy.py", "w").write(PROBE)
    o, _ = r.run("P=$(%s); python3 /root/.probe-p01-legacy.py \"$P/dist/server/index.js\"" % FIND, 120)
    sys.stdout.write(o)
finally:
    r.close()
