#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从生产 app 容器内调 /api/svc:insight，读三场景真实 label（不建单、不发送）。"""
import importlib.util, json, os

spec = importlib.util.spec_from_file_location("dep", "scripts/prod-deploy-sms-fix-01.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

r = m.R()
try:
    # 1) 直接读生产 .env 里的总部账号口令（只用于本地登录调接口，不外传）
    o, _ = r.run("grep -E '^(UAT_HQ_PASSWORD|UAT_HQ_EMAIL)=' /opt/scqf-aftersales/.env 2>/dev/null | head -2", 30)
    envline = dict(
        (ln.split("=", 1)[0], ln.split("=", 1)[1].strip().strip('"').strip("'"))
        for ln in o.strip().splitlines() if "=" in ln
    )
    email = envline.get("UAT_HQ_EMAIL", "uat.hq@svc.local")
    pwd = envline.get("UAT_HQ_PASSWORD", "")
    if not pwd:
        print("(生产 .env 无 UAT_HQ_PASSWORD —— 跳过接口登录，改用容器内直接调用)")
        pwd = ""

    # 2) 登录并取 insight
    if pwd:
        py = r'''
import json, sys, urllib.request
base = "http://127.0.0.1:13000"
def post(p, body, hdr=None):
    req = urllib.request.Request(base + p, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **(hdr or {})})
    return json.loads(urllib.request.urlopen(req, timeout=20).read().decode())
def get(p, hdr):
    req = urllib.request.Request(base + p, headers=hdr)
    return json.loads(urllib.request.urlopen(req, timeout=20).read().decode())

r = post("/api/auth:signIn", {"email": sys.argv[1], "password": sys.argv[2]})
tok = r.get("data", {}).get("token")
if not tok:
    print("LOGIN_FAIL", json.dumps(r)[:200]); sys.exit(0)
d = get("/api/svc:insight", {"Authorization": "Bearer " + tok})
data = d.get("data", {})
scenes = data.get("scenes") or data.get("sms", {}).get("scenes") or []
print("SCENES", json.dumps([{"scene": s.get("scene"), "label": s.get("label")} for s in scenes], ensure_ascii=False))
'''
        r.sftp.open("/root/.insight.py", "w").write(py)
        out, err = r.run("python3 /root/.insight.py %s %s" % (m.shq(email), m.shq(pwd)), 120)
        print(out.strip()[:1500] or ("(空) " + err.strip()[:300]))
    else:
        print("SKIP")
finally:
    r.close()
