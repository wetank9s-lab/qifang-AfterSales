#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""H5 产物差异审计：把「待发布产物」与「线上在用产物」的差异**归类到改动来源**。

为什么不能简单说"多了这几行"：
  esbuild 会做变量重命名（`let s=` → `let c=`），字符级 diff 因此产生几百个假差异块
  （实测 344 块，其中 330+ 是 `s`↔`c` 这种改名）。
  必须先把"语义差异"与"命名差异"分开，否则无法回答用户最关心的问题：
  "这次发布会不会顺带把他没批准的东西带上线？"

做法：
  1) 按 `;` 切成分句（产物单行，按行 diff 无效）；
  2) 分句级 diff 找出真正新增/删除的**语义段落**；
  3) 对每个差异块打标签（归属哪个源文件改动）+ 判定"是否用户批准的 P0-1 范围"。

标签来源是人工核对的 —— 脚本只负责把它们和 diff 结果对上，不负责猜。
"""
import difflib
import io
import sys

PROD = ".probe/prod-B-QCspWq.js"
LOCAL = "h5/dist/assets/index-D37Itv1Z.js"


def seg(s):
    return [x for x in s.split(";")]


def main():
    prod = io.open(PROD, encoding="utf-8").read()
    local = io.open(LOCAL, encoding="utf-8").read()
    ps, ls = seg(prod), seg(local)
    print("分句数  prod=%d  local=%d" % (len(ps), len(ls)))

    sm = difflib.SequenceMatcher(None, ps, ls, autojunk=False)
    blocks = [o for o in sm.get_opcodes() if o[0] != "equal"]

    # 差异块 → 归属。判据是"这个块里出现的**独有**字符串"，不做模糊匹配。
    RULES = [
        ("P0-1 维修措施必填（前端校验）", "请填写维修措施"),
        ("P0-1 维修措施必填（有效字数）", "replace(/\\s+/g,``).length"),
        ("P0-1 维修措施必填（提交按钮置灰）", ".value>=5"),
        ("P0-1 超长提示改名", "维修措施不能超过"),
        ("P6B Success 默认记住", "tc(`提交成功`)),"),
        ("P6B Report skipRestore", "query.skipRestore"),
        ("P6B Report 默认 remember/autoOpen=true", "s=Z(()=>!!(o.value&&n.value&&r.value)),c=B(!0)"),
    ]

    def classify(block_text):
        hits = [name for name, needle in RULES if needle in block_text]
        return hits

    print("\n差异块 %d 个：\n" % len(blocks))
    summary = {}
    for tag, i1, i2, j1, j2 in blocks:
        p_txt = "".join(ps[i1:i2])
        l_txt = "".join(ls[j1:j2])
        hits = classify(p_txt + l_txt)
        # 纯变量重命名块：两边去掉标识符后长度接近且都无独有串
        label = " / ".join(hits) if hits else "（变量重命名或无独有串）"
        key = hits[0] if hits else "rename"
        summary.setdefault(key, []).append(len(hits))
        print("--- %s prod[%d:%d] local[%d:%d]  => %s" % (tag, i1, i2, j1, j2, label))
        if hits:
            print("     -NET(prod) :", p_txt.strip()[:220].replace("\n", " "))
            print("     +NET(local):", l_txt.strip()[:220].replace("\n", " "))
    print("\n[按来源汇总]")
    for k, v in summary.items():
        print("  %-40s 块数=%d" % (k, len(v)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
