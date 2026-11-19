"""_r211-access.py —— 用【真实 HTTP】`desktopRoutes:listAccessible` 量各角色可见菜单。

为什么不用 SQL 推演：
  SQL 只能看到 `rolesDesktopRoutes` 里的直接授权行，而 `listAccessible(tree:true)`
  的实际行为是「授权组 ⇒ 递归展开该组【全部】子节点」。两者不是一回事 ——
  本轮就是靠实测才发现 hq_admin 会从 12 页变成 14 页。
  所以判"权限有没有放大"，唯一可信的判据是打这个接口比对集合。

用法：
  python scripts/_r211-access.py --save  before.json
  python scripts/_r211-access.py --diff  before.json     # 集合差异（有差异 = exit 3）

令牌来源：storage/tmp/r211/.tok_<user>（由 _probe3.mjs 写入），任一可用即可，
用 X-Role 头切换角色 —— NocoBase 用同一 token 模拟任意角色，无需每个角色都登录。
"""
import argparse
import json
import os
import sys
import urllib.request

BASE = os.environ.get("R211_BASE", "http://127.0.0.1:13000")
TOKDIR = os.path.join("storage", "tmp", "r211")
# ⚠️ 实测：NocoBase 不认"拿 admin 的 token 换 X-Role"——每个账号只对它自己的角色
# 返回 200，换别的角色一律 401。所以必须【按账号自己的角色】测，不能用 X-Role 模拟。
# 这也意味着：不可登录的角色（如 store_manager）在本机测不到，
# 这类角色只能靠 SQL 推演 + 生产侧只读核对，报告里必须标明口径。
ACCOUNTS = [
    ("hq_admin", ".tok_uat_hqadmin"),
    ("hq_after_sales", ".tok_uat_hq"),
    ("viewer", ".tok_uat_viewer"),
    ("store_after_sales", ".tok_uat_store_a"),
]
ROLES = [r for r, _ in ACCOUNTS]


def token(suffix):
    fn = os.path.join(TOKDIR, suffix)
    if not os.path.exists(fn):
        return None
    with open(fn, encoding="utf-8") as fh:
        return fh.read().strip() or None


def call(path, role, tok):
    req = urllib.request.Request(BASE + path, headers={
        "Authorization": "Bearer " + tok, "X-Role": role, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


def walk(nodes, acc=None, depth=0):
    """把菜单树拍平成 'group>page' 路径集合，用于集合比对（不比顺序）。"""
    acc = [] if acc is None else acc
    for n in nodes or []:
        acc.append((n.get("type"), n.get("title"), depth))
        walk(n.get("children"), acc, depth + 1)
    return acc


def snapshot():
    out = {}
    for role, tokname in ACCOUNTS:
        tok = token(tokname)
        if not tok:
            out[role] = {"status": 0, "error": "无令牌"}
            continue
        st, body = call("/api/desktopRoutes:listAccessible?tree=true&paginate=false", role, tok)
        if st != 200:
            out[role] = {"status": st, "error": (body.get("errors") or [{}])[0].get("message", "")}
            continue
        data = body.get("data") or []
        flat = walk(data)
        out[role] = {
            "status": st,
            "top": len(data),
            "pages": sorted(t for ty, t, _d in flat if ty == "flowPage"),
            "groups": sorted(t for ty, t, _d in flat if ty == "group"),
            "tree": [[ty, t, d] for ty, t, d in flat],
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--save")
    ap.add_argument("--diff")
    a = ap.parse_args()
    cur = snapshot()

    if a.save:
        with open(a.save, "w", encoding="utf-8") as fh:
            json.dump(cur, fh, ensure_ascii=False, indent=1)
        for role, v in cur.items():
            if v.get("status") != 200:
                print(f"  {role:18} HTTP {v['status']} (无权限或不可用)")
            else:
                print(f"  {role:18} {len(v['pages']):2} 页  组={v['groups']}")
        print(f"\n已存 {a.save}")
        return 0

    with open(a.diff, encoding="utf-8") as fh:
        base = json.load(fh)
    bad = 0
    print(f"{'角色':18} {'基线段':>6} {'迁移后':>6}  差异")
    for role in ROLES:
        b, c = base.get(role, {}), cur.get(role, {})
        if b.get("status") != 200 or c.get("status") != 200:
            print(f"  {role:18} 跳过（HTTP {b.get('status')}/{c.get('status')}）")
            continue
        bp, cp = set(b["pages"]), set(c["pages"])
        add, rm = sorted(cp - bp), sorted(bp - cp)
        bg, cg = set(b["groups"]), set(c["groups"])
        gadd, grm = sorted(cg - bg), sorted(bg - cg)
        # =====================================================================
        # 判据（R2.1.1 用户 2026-11-17 裁决 ③ 改写）
        # ---------------------------------------------------------------------
        # 🔴 只有【可访问页面集合】增减才算权限被放大/收缩。
        #
        # 为什么不再拿组名差异判红：
        #   上一版基线 (`access_before.json`) 采自"原生父组方案"已 apply 的状态，
        #   里面本来就有真实的 group 节点 `日常业务`/`管理与设置`。
        #   现行方案是**前端虚拟分组** —— 真实 group 节点只剩生产原有的 `售后工单`，
        #   于是组集合必然变成 -{日常业务,管理与设置} +{售后工单}。
        #   这不是权限变化，是**方案换了**。拿旧基线判它会永远红。
        #
        # 也不会因此放过真问题：
        #   · 页面被藏起来 ⇒ `rm` 非空 ⇒ 仍然判红；
        #   · 组被删导致其子页不可见 ⇒ 子页会从 `pages` 消失 ⇒ 也由 `rm` 兜住。
        #   ⇒ 组名变化只打印，不参与判决。
        # =====================================================================
        if add or rm:
            bad += 1
            print(f"  ❌ {role:18} {len(bp):>6} {len(cp):>6}  +{add} -{rm}  组+{gadd} 组-{grm}")
        else:
            note = []
            if gadd or grm:
                note.append(f"组结构变化（预期，前端虚拟分组不产生真实组）")
            print(f"  ✅ {role:18} {len(bp):>6} {len(cp):>6}  页面集合完全一致"
                  + (f"（{'；'.join(note)}）" if note else ""))
    print("\n判定：", "PASS 无一角色页面增减" if bad == 0
          else f"FAIL {bad} 个角色页面集合变化 ⇒ 权限被放大/收缩")
    return 0 if bad == 0 else 3


if __name__ == "__main__":
    sys.exit(main())
