#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""BE-03-SMS-FIX-01 部署后验收（只读）。"""
import importlib.util, json, sys, os

spec = importlib.util.spec_from_file_location("dep", "scripts/prod-deploy-sms-fix-01.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

r = m.R()
try:
    dist = m.detect_dist(r)
    print("=" * 70)
    o, _ = r.run("cd %s && sha256sum server/index.js client/index.js build-fingerprint.json" % m.shq(dist), 60)
    print("[指纹]")
    for line in o.strip().splitlines():
        print("   ", line[:16], line.split()[-1])

    o, _ = r.run("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:13000/api/app:getInfo", 30)
    print("[健康-容器内]", o.strip())
    o, _ = r.run("curl -sL -o /dev/null -w '%{http_code}' https://sh.scqfls.cn/api/app:getInfo --resolve sh.scqfls.cn:443:127.0.0.1", 30)
    print("[健康-域名]", o.strip())
    o, _ = r.run("docker inspect scqf-as-app --format '{{.State.Status}}|{{.State.Health.Status}}'", 30)
    print("[容器]", o.strip())

    print("\n[闸门]")
    o, _ = r.run("grep -o 'SMS_REVIEW_PENDING_SCENES = \\[[^]]*\\]' %s | head -1" % m.shq(os.path.join(dist, "server/index.js")), 60)
    print("   ", o.strip())

    print("\n[场景名称 - client bundle 三形态]")
    c = "/opt/scqf-aftersales/src/storage/plugins/@local/service-ticket/dist/client/index.js"
    for want in ["客户报修成功通知", "客户处理进展通知", "师傅任务通知"]:
        # esbuild 会把中文字面量转成 \uXXXX，也可能保留原文；三种形态都查
        esc_u = "".join("\\u%04X" % ord(ch) for ch in want)   # 大写
        esc_l = "".join("\\u%04x" % ord(ch) for ch in want)   # 小写
        cmd = ("grep -c -e %s -e %s -e %s %s || true" %
               (m.shq(want), m.shq(esc_u), m.shq(esc_l), m.shq(c)))
        o, _ = r.run(cmd, 60)
        vals = [v for v in o.strip().split("\n") if v.strip()]
        total = sum(int(v) for v in vals if v.isdigit())
        print("    %-14s 命中 %d 处" % (want, total))

    print("\n[错误原因译名 - client bundle]")
    for want in ["模板待供应商审核", "未发送（"]:
        esc_u = "".join("\\u%04X" % ord(ch) for ch in want)
        esc_l = "".join("\\u%04x" % ord(ch) for ch in want)
        cmd = ("grep -c -e %s -e %s -e %s %s || true" %
               (m.shq(want), m.shq(esc_u), m.shq(esc_l), m.shq(c)))
        o, _ = r.run(cmd, 60)
        vals = [v for v in o.strip().split("\n") if v.strip()]
        total = sum(int(v) for v in vals if v.isdigit())
        print("    %-18s 命中 %d 处" % (want, total))
    # 旧兜底文案必须已经不在（这条要能变红）
    for gone in ["原因待核实"]:
        esc_u = "".join("\\u%04X" % ord(ch) for ch in gone)
        cmd = ("grep -c -e %s -e %s %s || true" % (m.shq(gone), m.shq(esc_u), m.shq(c)))
        o, _ = r.run(cmd, 60)
        vals = [v for v in o.strip().split("\n") if v.strip()]
        total = sum(int(v) for v in vals if v.isdigit())
        print("    旧文案「%s」残留 %d 处（期望 0）" % (gone, total))

    print("\n[师傅短信正文 - server bundle]")
    o, _ = r.run("grep -o '您有新的售后服务任务[^\"]*' %s | head -1" % m.shq(os.path.join(dist, "server/index.js")), 60)
    print("    原文形态:", (o.strip() or "(中文被转义，查 \\u 形态)"))
    esc = "".join("\\u%04X" % ord(ch) for ch in "您有新的售后服务任务")
    o, _ = r.run("grep -c -e %s -e %s %s || true" % (m.shq(esc), m.shq(esc.lower()),
                 m.shq(os.path.join(dist, "server/index.js"))), 60)
    print("    转义形态命中:", o.strip().split("\n"))

    print("\n[短信总开关 / 零发送基线]")
    o, e = r.psql("SELECT coalesce(value,'(none)') FROM service_settings WHERE key='sms.enabled'")
    print("    sms.enabled =", o or "(查不到：可能非该表)")
    o, _ = r.psql("SELECT provider||'|'||send_status||'|'||count(*) FROM sms_logs GROUP BY provider,send_status ORDER BY 1")
    print("    sms_logs 分布:")
    for line in o.splitlines():
        print("      ", line)
    o, _ = r.psql("SELECT count(*) FROM migrations")
    print("    migrations =", o)
finally:
    r.close()
