#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""P0-1 生产只读探针：核实"直接调接口提交空值会被拒"的**执行顺序**是否在线上成立。

为什么不直接 POST 一下看 422：
  生产上要拿到"维修措施校验"这一步，必须先通过
    ① 一次性师傅 Token（提交成功即失效 —— 会毁掉真实师傅的作业链接）
    ② 照片 ≥1 张
  也就是说，真发一次请求**不可避免地要消耗一条真实作业链接**。
  用户明确禁止"为了验证而向真实客户或师傅发送测试短信 / 建测试工单"。
  ⇒ 所以这里**不发写请求**，改为在生产 bundle 里核对**控制流顺序**：
      `validateServiceNote` 的抛错必须在 `technicianSubmit` 调用之前，
      且不能有任何 `consumeToken` / 写 Visit 的动作夹在中间。

判据（每条都是"能在坏实现上变红"的硬条件）：
  A. bundle 里存在 `SERVICE_NOTE_TOO_SHORT` / `SERVICE_NOTE_TOO_LONG` 两个错误码；
  B. 必填文案「请填写维修措施，至少 5 个字」存在（\u 转义形态也要认）；
  C. 老规则痕迹必须消失：不能有"resolved 可留空"的分支把校验绕过去；
  D. 提取 `parseSubmitDto` 附近的代码片段，人工核对顺序（打印出来供比对）。
"""
import importlib.util

spec = importlib.util.spec_from_file_location("dep", "scripts/prod-deploy-sms-fix-01.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

PROBE = r'''
import sys, os, re, hashlib
bs = chr(92)
path = sys.argv[1]
d = open(path, 'r', encoding='utf-8', errors='replace').read()

def has(w):
    lo = ''.join(bs + 'u%04x' % ord(c) for c in w)
    up = ''.join(bs + 'u%04X' % ord(c) for c in w)
    return d.count(w) + d.count(lo) + d.count(up)

print('[CODES]')
for w in ['SERVICE_NOTE_TOO_SHORT', 'SERVICE_NOTE_TOO_LONG', 'INVALID_IS_CHARGED']:
    print('   %-24s %d' % (w, d.count(w)))
print('[MESSAGES]')
for w in ['请填写维修措施，至少 5 个字', '维修措施不能超过 500 字', '请选择本次是否收费']:
    print('   %-28s %d' % (w, has(w)))

# 老规则的痕迹：曾经按 service_result 决定"是否必填 / 是否可留空"
print('[LEGACY-TRACES]')
for w in ['SERVICE_RESULT_NOTE_OPTIONAL', 'note_required']:
    print('   %-30s %d' % (w, d.count(w)))

# 顺序证据：把 validateServiceNote 的调用点前后各 1200 字符打出来
idx = [m.start() for m in re.finditer('SERVICE_NOTE_TOO_SHORT', d)]
print('[ORDER-PROOF] occurrences=%d' % len(idx))
for i, p in enumerate(idx[:2]):
    seg = d[max(0, p-1500):p+600]
    for kw in ['technicianSubmit', 'validateServiceNote', 'consume', 'serviceNote']:
        print('   window%d  %-20s %s' % (i, kw, kw in seg))
'''

r = m.R()
try:
    FIND = ("docker inspect scqf-as-app --format '{{range .Mounts}}"
            "{{if eq .Destination \"/app/nocobase/node_modules/@local/service-ticket\"}}{{.Source}}{{end}}{{end}}'")
    r.sftp.open("/root/.probe-p01-order.py", "w").write(PROBE)
    o, _ = r.run("P=$(%s); python3 /root/.probe-p01-order.py \"$P/dist/server/index.js\"" % FIND, 120)
    print(o.strip())
finally:
    r.close()
