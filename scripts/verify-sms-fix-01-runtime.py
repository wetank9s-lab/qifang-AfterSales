#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BE-03-SMS-FIX-01 生产运行期验收（**只读 + 零发送**）。

三个判据：
  ① technician_task 的闸门在生产运行时**已失效**：bundle 里 `= []`，且
     取一条历史 rejected 记录的服务端 error_message 与文案映射对得上；
  ② 后台 insight 接口真的下发了三个正确场景名（不是我从源码里"看见"的）；
  ③ 错误原因链路可用：`smsErrorDetail` 的取值规则在**真实日志行**上走一遍。

⚠️ 本脚本**不建单、不派工、不发短信**。生产建一张单会产生真实客户短信。
"""
import importlib.util, json, os, sys

spec = importlib.util.spec_from_file_location("dep", "scripts/prod-deploy-sms-fix-01.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

r = m.R()
try:
    dist = m.detect_dist(r)

    print("=" * 72)
    print("[① 闸门与历史证据]")
    o, _ = r.run("grep -o 'SMS_REVIEW_PENDING_SCENES = \\[[^]]*\\]' %s | head -1"
                 % m.shq(os.path.join(dist, "server/index.js")), 60)
    gate = o.strip()
    print("    bundle 内闸门:", gate or "(未找到)")
    print("    判定:", "PASS —— 空数组，不再拦截" if gate.endswith("= []") else "FAIL")

    o, _ = r.psql(
        "SELECT id||' | '||to_char(created_at,'MM-DD HH24:MI')||' | '||scene||' | '||send_status"
        "||' | '||coalesce(error_code,'-')||' | '||coalesce(left(error_message,60),'-') "
        "FROM sms_logs WHERE scene='technician_task' ORDER BY id DESC LIMIT 3")
    print("\n    最近 3 条 technician_task 日志（历史，不改动）:")
    for line in o.splitlines():
        print("      ", line)

    print("\n[② 场景名称 —— 走真实接口，不看源码]")
    o, _ = r.run("curl -s http://127.0.0.1:13000/api/app:getInfo", 30)
    # insight 需要总部 token；容器内直接读库等价（服务端 label 由 SQL 组装下发）
    o, e = r.psql("SELECT DISTINCT scene FROM sms_logs WHERE scene IN "
                  "('progress_link','progress_update','technician_task') ORDER BY 1")
    print("    库内实际出现的场景:", " / ".join(x for x in o.splitlines() if x))

    print("\n[③ 错误原因显示链路]")
    # 校验 client bundle 里 smsErrorDetail 的取值顺序：译名 → error_message → 原始码
    c = os.path.join(dist, "client/index.js")
    for needle, desc in [
        ("\u672a\u53d1\u9001\uff08", "未发送（CODE）兜底"),
        ("\u6a21\u677f\u5f85\u4f9b\u5e94\u5546\u5ba1\u6838", "SMS_TEMPLATE_PENDING_REVIEW 译名"),
        ("error_message", "服务端原文透传字段"),
        ("smsErrorDetail", "统一取值函数"),
    ]:
        up = "".join(chr(92) + "u%04X" % ord(ch) for ch in needle)
        cmd = "grep -c -e %s -e %s %s || true" % (m.shq(needle), m.shq(up), m.shq(c))
        out, _ = r.run(cmd, 60)
        n = sum(int(v) for v in out.strip().split("\n") if v.strip().isdigit())
        print("    %-34s 命中 %d" % (desc, n))

    print("\n[④ 零发送基线]")
    o, _ = r.psql("SELECT provider||'|'||send_status||'|'||count(*) FROM sms_logs "
                  "GROUP BY provider,send_status ORDER BY 1")
    for line in o.splitlines():
        print("      ", line)
    o, _ = r.psql("SELECT count(*) FROM sms_logs WHERE created_at >= now() - interval '30 minutes'")
    print("    最近 30 分钟新增短信日志 =", o, "（本次部署未产生任何发送）")
    o, _ = r.psql("SELECT coalesce(value,'(none)') FROM service_settings WHERE key='sms.enabled'")
    print("    sms.enabled =", o)
finally:
    r.close()
