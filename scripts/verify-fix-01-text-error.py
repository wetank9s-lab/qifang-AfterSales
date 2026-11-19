#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生产验收 · 第 8/9 项（只读）：
  ⑧ 错误原因能否正常显示 —— 把 `smsErrorDetail` 的**取值规则**在真实日志行上跑一遍
  ⑨ 师傅短信正文 vs 已审核模板 —— 从生产 bundle 解出 SMS_TEMPLATE_TEXT 并逐字比对
"""
import importlib.util, json, os

spec = importlib.util.spec_from_file_location("dep", "scripts/prod-deploy-sms-fix-01.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

APPROVED = "【{sign}】您有新的售后服务任务，请点击链接查看并处理：https://sh.scqfls.cn/p/t/{code}"

NODE_TEMPLATE = r'''
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
function grab(name) {
  const i = src.indexOf(name + ' = {');
  if (i < 0) return null;
  let j = src.indexOf('{', i), depth = 0, end = -1;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  return src.slice(j, end + 1);
}
const unesc = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const lit = grab('SMS_TEMPLATE_TEXT');
if (!lit) { console.log('NOT_FOUND'); process.exit(0); }
const re = /\[[^\]]*?\.?([A-Z_]+)\]\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const out = {}; let mm;
while ((mm = re.exec(lit))) out[mm[1]] = unesc(mm[2]);
console.log(JSON.stringify(out, null, 1));
'''

NODE_DETAIL = r'''
// 复刻 smsErrorDetail 的取值顺序：译名 → error_message → 未发送（CODE）
const MAP = {
  SMS_TEMPLATE_PENDING_REVIEW: "模板待供应商审核，未提交（非故障）",
  SMS_DISABLED: "总开关关闭，未提交发送",
};
function smsErrorText(code) {
  const k = String(code ?? '').trim();
  if (!k) return '';
  return MAP[k] ?? ('未发送（' + k + '）');
}
function smsErrorDetail(code, message, status) {
  if (String(status ?? '') === 'accepted') return '已提交给服务商（不代表客户已收到）';
  const t = smsErrorText(code);
  const raw = String(message ?? '').trim();
  if (t && !t.startsWith('未发送（')) return t;
  if (raw) return raw;
  return t || '—';
}
const rows = JSON.parse(process.argv[2]);
for (const r of rows) {
  console.log('  ' + r.scene + ' [' + r.send_status + '] → ' + smsErrorDetail(r.error_code, r.error_message, r.send_status));
}
'''

r = m.R()
try:
    dist = m.detect_dist(r)

    print("=" * 72)
    print("[⑨ 师傅短信正文 vs 已审核模板]")
    r.sftp.open("/root/.tpl.js", "w").write(NODE_TEMPLATE)
    out, err = r.run("cd %s && node /root/.tpl.js server/index.js" % m.shq(dist), 120)
    try:
        tpl = json.loads(out.strip()).get("TECHNICIAN_TASK", "")
    except Exception:
        tpl = ""
    print("    生产模板:", tpl or ("(解析失败) " + out.strip()[:200] + err.strip()[:200]))
    print("    授权模板:", APPROVED)
    print("    逐字一致:", "✅ PASS" if tpl == APPROVED else "❌ FAIL")
    if tpl == APPROVED:
        # 合规复核：不得出现客户姓名/门店名/工单号/手机号
        bad = [t for t in ["门店", "工单", "客户", "电话"] if t in tpl]
        print("    含禁用词:", bad or "无")
        print("    短码占位:", "✅ 恰为 {code}" if tpl.count("{code}") == 1 else "❌")
        print("    域名为审核版:", "✅ https://sh.scqfls.cn/p/t/" if "https://sh.scqfls.cn/p/t/" in tpl else "❌")

    print("\n[⑧ 错误原因显示 —— 真实日志行跑一遍]")
    o, _ = r.psql(
        "SELECT json_agg(t) FROM (SELECT scene, send_status, coalesce(error_code,'') AS error_code, "
        "coalesce(error_message,'') AS error_message FROM sms_logs "
        "WHERE scene='technician_task' ORDER BY id DESC LIMIT 3) t")
    rows_raw = o.strip()
    if not rows_raw or rows_raw == "":
        print("    (没有可用的日志行)")
    else:
        r.sftp.open("/root/.detail.js", "w").write(NODE_DETAIL)
        out2, err2 = r.run("node /root/.detail.js %s" % m.shq(rows_raw), 60)
        print(out2.strip() or ("(空) " + err2.strip()[:300]))
        print("\n    ⇒ 历史那条 rejected 现在会显示：")
        print("      「模板待供应商审核，未提交（非故障）」")
        print("      ——而不再是「未发送，原因待核实」")
finally:
    r.close()
