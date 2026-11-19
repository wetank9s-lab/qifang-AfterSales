#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
直接验证 insight 下发的场景名：**在容器内把编译后的常量模块 require 出来**，
而不是靠 grep bundle（esbuild 保留注释，grep 会被注释骗）。

做法：node -e 里 require 生产 dist 的 server bundle，读导出的 SMS_SCENE_LABEL。
⚠️ bundle 是 CJS，且导出的是插件入口；SMS_SCENE_LABEL 不一定在顶层导出。
   ⇒ 退一步：从 bundle 文本里抓 `SMS_SCENE_LABEL` 附近的**对象字面量**并解析 key 对应值。
"""
import importlib.util, json, os, re

spec = importlib.util.spec_from_file_location("dep", "scripts/prod-deploy-sms-fix-01.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

NODE = r'''
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
// 找 SMS_SCENE_LABEL 的对象字面量：从 `SMS_SCENE_LABEL = {` 开始做括号配对
const i = src.indexOf('SMS_SCENE_LABEL = {');
if (i < 0) { console.log('NOT_FOUND'); process.exit(0); }
let j = src.indexOf('{', i), depth = 0, end = -1;
for (let k = j; k < src.length; k++) {
  if (src[k] === '{') depth++;
  else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
}
const lit = src.slice(j, end + 1);
const out = {};
// 展开 \uXXXX
const unesc = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const re = /(?:\[[^\]]*?\.?([A-Z_]+)\]|["']?([a-z_]+)["']?)\s*:\s*"((?:[^"\\]|\\.)*)"/g;
let mm;
while ((mm = re.exec(lit))) {
  const key = mm[1] || mm[2];
  out[key] = unesc(mm[3]);
}
console.log(JSON.stringify(out, null, 1));
'''

r = m.R()
try:
    dist = m.detect_dist(r)
    r.sftp.open("/root/.labels.js", "w").write(NODE)
    out, err = r.run("cd %s && node /root/.labels.js server/index.js" % m.shq(dist), 120)
    txt = out.strip()
    print("[SMS_SCENE_LABEL 生产实际值]")
    try:
        obj = json.loads(txt)
        for k in ("TECHNICIAN_TASK", "PROGRESS_LINK", "PROGRESS_UPDATE",
                  "DISPATCH_CUSTOMER", "DISPATCH_UPDATE", "REVIEW_INVITE", "MANUAL_RESEND"):
            if k in obj:
                print("   %-22s %s" % (k, obj[k]))
    except Exception:
        print(txt[:800] or ("(空) " + err.strip()[:300]))

    # 同时验 sceneSummary
    out2, _ = r.run("cd %s && node /root/.labels.js client/index.js" % m.shq(dist), 60)
finally:
    r.close()
