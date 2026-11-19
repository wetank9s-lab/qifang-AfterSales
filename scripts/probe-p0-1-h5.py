#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P0-1 前置排查：生产 H5 到底渲染的是「维修措施」还是「处理说明（选填）」。只读。"""
import importlib.util, json, os, re

spec = importlib.util.spec_from_file_location("dep", "scripts/prod-deploy-sms-fix-01.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

r = m.R()
try:
    # 1) nginx 把 /h5 指到哪个目录
    o, _ = r.run("grep -n -A6 'location /h5' /www/server/panel/vhost/nginx/sh.scqfls.cn.conf | head -30", 60)
    print("[nginx /h5]")
    print(o.strip() or "(未找到 location /h5)")

    # 2) 找 H5 产物目录
    o, _ = r.run("ls -la /opt/scqf-aftersales/src/h5/dist 2>/dev/null | head -10; "
                 "find /opt/scqf-aftersales -maxdepth 4 -type d -name 'dist' -path '*h5*' 2>/dev/null | head -5", 120)
    print("\n[h5 dist 候选]")
    print(o.strip() or "(未找到)")

    # 3) 现网 H5 资源里查两个文案
    for needle, label in [("处理说明（选填）", "旧文案"), ("维修措施", "新文案"),
                          ("请填写维修措施", "必填提示")]:
        o, _ = r.run(
            "grep -rl %s /opt/scqf-aftersales/src/h5/dist/assets 2>/dev/null | head -5"
            % m.shq(needle), 120)
        print("\n[%s 「%s」命中文件]" % (label, needle))
        print(o.strip() or "(无)")

    # 4) 直接访问页面，看真实返回
    o, _ = r.run("curl -s -o /dev/null -w '%{http_code}' https://sh.scqfls.cn/h5/ --resolve sh.scqfls.cn:443:127.0.0.1", 30)
    print("\n[/h5 首页 HTTP]", o.strip())
    o, _ = r.run("curl -s https://sh.scqfls.cn/h5/ --resolve sh.scqfls.cn:443:127.0.0.1 | head -30", 30)
    print(o.strip()[:800])
finally:
    r.close()
