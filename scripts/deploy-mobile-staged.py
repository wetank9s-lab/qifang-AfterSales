#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""deploy-mobile-staged.py —— 移动端 /m/ **分两阶段**发布（R2.2.5 §三）

=====================================================================
为什么不能直接用 deploy-mobile-remote.py
=====================================================================
那个脚本是「整目录 rm -rf + mv 原子切换」。它保证**任意时刻都是一个完整版本**，
但用户 §三 明令：

    「手机端 /m/ 必须独立部署，**先发布新资源，最后切换 index.html**。」

原子切换做不到这一点：切换那一瞬间，index.html 与新 assets 同时到位；
而在此之前用户拿到的是**旧 index + 旧 assets**。两者都不算错，但都不是
"先把新资源铺好、让 CDN/HTTP 缓存预热，再切入口"这个顺序 ——
更要紧的是，一旦新 assets 有问题，原子切换**没有观察窗口**：
切完就已经是全部用户可访问的状态。

本脚本按用户要求的顺序：

    阶段 A：上传 assets/* → 线上（此时 index.html **仍指向旧 assets**，页面行为完全不变）
    阶段 B：上传 index.html（唯一一次入口切换）+ 其余静态小文件
    阶段 C：回读全量哈希 + HTTP 自测

关键性质：阶段 A 之后、阶段 B 之前，线上是「旧 index + 旧 assets + 新 assets 并存」，
**用户看到的东西一点没变**。这是安全的观察窗口。

=====================================================================
安全约束
=====================================================================
· 不删旧 assets：留着它，回滚只需把旧 index.html 放回去（秒级）。
· 不碰 nginx：本脚本**只写 /m/ 目录**，一行配置都不改。
· 备份：先把整个 /m 与旧 index.html 拷到 backups/mobile-staged-<stamp>/。
· 每个文件落盘后**回读 sha256**，不符即停并恢复 index.html。
· 远端文件清单在写之前打印出来（dry-run 可完整预演）。

用法：
  S6_SSH_PASS=... python scripts/deploy-mobile-staged.py --dry-run
  S6_SSH_PASS=... python scripts/deploy-mobile-staged.py --apply
  S6_SSH_PASS=... python scripts/deploy-mobile-staged.py --rollback <stamp>
"""
import argparse
import hashlib
import json
import os
import posixpath
import sys
import time

import paramiko

HOST = os.environ.get("S6_SSH_HOST", "162.14.121.180")
USER = os.environ.get("S6_SSH_USER", "root")
PASS = os.environ.get("S6_SSH_PASS", "")

LOCAL_DIST = os.path.join("src-mobile", "dist")
REMOTE_DIR = "/www/wwwroot/sh.scqfls.cn/m"
BACKUP_ROOT = "/opt/scqf-aftersales/backups"

# 入口文件：**最后**才切
ENTRY = "index.html"


def die(msg, code=1):
    print("✗ " + msg, flush=True)
    sys.exit(code)


def sha_bytes(b):
    return hashlib.sha256(b).hexdigest()


def local_files():
    root = os.path.abspath(LOCAL_DIST)
    if not os.path.isdir(root):
        die("本地产物目录不存在: " + root)
    out = {}
    for dirpath, _dn, fns in os.walk(root):
        for fn in fns:
            ap = os.path.join(dirpath, fn)
            rel = os.path.relpath(ap, root).replace("\\", "/")
            with open(ap, "rb") as f:
                out[rel] = sha_bytes(f.read())
    return out


class Remote:
    def __init__(self):
        self.c = paramiko.SSHClient()
        self.c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        self.c.connect(HOST, port=22, username=USER, password=PASS, timeout=30,
                       allow_agent=False, look_for_keys=False)
        self.sftp = self.c.open_sftp()

    def run(self, cmd, timeout=180, check=False):
        _i, o, e = self.c.exec_command(cmd, timeout=timeout)
        out = o.read().decode("utf-8", "replace")
        err = e.read().decode("utf-8", "replace")
        rc = o.channel.recv_exit_status()
        if check and rc != 0:
            raise RuntimeError("命令失败 rc=%d: %s\n%s\n%s" % (rc, cmd, out[-600:], err[-600:]))
        return rc, out, err

    def live_hashes(self, sub=""):
        """返回 {相对路径: sha256}"""
        base = posixpath.join(REMOTE_DIR, sub) if sub else REMOTE_DIR
        rc, out, _ = self.run("cd %s 2>/dev/null && find . -type f | sort | xargs -r sha256sum" % base)
        h = {}
        for line in out.splitlines():
            p = line.split()
            if len(p) == 2:
                h[p[1].lstrip("./")] = p[0]
        return h

    def put(self, local_abs, remote_abs):
        parent = posixpath.dirname(remote_abs)
        self.run("mkdir -p %s" % parent, check=True)
        self.sftp.put(local_abs, remote_abs)

    def close(self):
        try:
            self.sftp.close()
        finally:
            self.c.close()


def http_codes(r, urls):
    for u in urls:
        rc, out, _ = r.run(
            "curl -s -o /dev/null -w '%%{http_code} %%{size_download}' https://sh.scqfls.cn%s" % u)
        print("    %-22s → %s" % (u, out.strip()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--rollback", default=None)
    a = ap.parse_args()
    if not PASS:
        die("缺少 S6_SSH_PASS")
    if not (a.dry_run or a.apply or a.rollback):
        die("需要 --dry-run / --apply / --rollback <stamp>")

    r = Remote()
    try:
        # ---------------------------------------------------------- 回滚
        if a.rollback:
            bdir = "%s/mobile-staged-%s" % (BACKUP_ROOT, a.rollback)
            rc, out, _ = r.run("test -d %s && echo YES || echo NO" % bdir)
            if "YES" not in out:
                die("回滚目录不存在: " + bdir)
            # 只恢复入口文件即可让流量回到旧版本（旧 assets 从未被删）
            r.run("cp -a %s/m/index.html %s/index.html" % (bdir, REMOTE_DIR), check=True)
            print("✅ 已恢复 %s/index.html（旧 assets 一直在线上，无需搬回）" % REMOTE_DIR)
            http_codes(r, ["/m/", "/m/search"])
            return

        lh = local_files()
        if not lh:
            die("本地产物为空：%s" % LOCAL_DIST)
        if ENTRY not in lh:
            die("本地产物里没有 %s，不可能是有效构建" % ENTRY)

        stage_a = sorted([k for k in lh if k.startswith("assets/")])
        stage_b = sorted([k for k in lh if not k.startswith("assets/")])
        # 阶段 B 里 index.html 必须**排最后**
        stage_b = [k for k in stage_b if k != ENTRY] + [ENTRY]

        print("本地 /m 产物 %d 个（assets %d / 其它 %d）" % (len(lh), len(stage_a), len(stage_b)))
        print("  阶段 A（先发，不改入口）:")
        for k in stage_a:
            print("    %-40s %s…" % (k, lh[k][:16]))
        print("  阶段 B（最后切入口）:")
        for k in stage_b:
            mark = "  ← 入口切换点" if k == ENTRY else ""
            print("    %-40s %s…%s" % (k, lh[k][:16], mark))

        live = r.live_hashes()
        print("\n线上现状 %d 个文件：%s" % (len(live), REMOTE_DIR))
        for k in sorted(live):
            same = "相同" if lh.get(k) == live[k] else ("本地无" if k not in lh else "不同")
            print("    %-40s %s… %s" % (k, live[k][:16], same))
        only_remote = sorted(set(live) - set(lh))
        if only_remote:
            print("  ⚠️ 仅在线上、本地没有（**不会删除**，留给回滚用）: %s" % only_remote)

        if a.dry_run:
            print("\n[DRY-RUN] 将执行：")
            print("  1) 备份 /m → %s/mobile-staged-<stamp>/" % BACKUP_ROOT)
            print("  2) 阶段 A：上传 %d 个 assets（index.html 不动，线上行为不变）" % len(stage_a))
            print("  3) 阶段 B：上传 %d 个文件，**index.html 最后**" % len(stage_b))
            print("  4) 全量回读哈希 + HTTP 自测")
            print("  不碰 nginx、不删旧 assets")
            return

        stamp = time.strftime("%Y%m%d-%H%M%S")
        bdir = "%s/mobile-staged-%s" % (BACKUP_ROOT, stamp)

        # ---------------------------------------------------- 1) 备份
        r.run("mkdir -p %s" % bdir, check=True)
        r.run("cp -a %s %s/m" % (REMOTE_DIR, bdir), check=True)
        rc, out, _ = r.run("ls -1 %s/m" % bdir)
        print("\n[1] 备份 → %s\n%s" % (bdir, out.rstrip()))
        # 备份判据：**入口文件必须在备份里**。少它就没有回滚点，
        # 而 `cp -a` 的退出码为 0 也不代表内容齐（曾经靠这个假设差点丢掉回滚）。
        rc, chk, _ = r.run("test -f %s/m/%s && echo OK || echo NO" % (bdir, ENTRY))
        if "OK" not in chk:
            die("备份里没有 %s —— 拒绝继续（回滚将无路可退）" % ENTRY)

        # ---------------------------------------------------- 2) 阶段 A
        print("\n[2] 阶段 A：上传 assets（index.html 不动）")
        for k in stage_a:
            r.put(os.path.join(LOCAL_DIST, k), posixpath.join(REMOTE_DIR, k))
        live_a = r.live_hashes("assets")
        # `live_hashes("assets")` 是在 assets/ 目录里 find 的，
        # 返回的键**不带** `assets/` 前缀 —— 这里补回去再比，
        # 不要用 str.replace（子目录里出现同名字样会被误伤）。
        bad = [(k, lh[k][:12], live_a.get(k[len("assets/"):], "(缺)")[:12]) for k in stage_a
               if live_a.get(k[len("assets/"):]) != lh[k]]
        if bad:
            die("阶段 A 回读哈希不符，未切换入口: %s" % bad)
        # 硬判据：此刻线上 index.html 必须**仍是旧的那个**
        cur_entry = r.live_hashes().get(ENTRY)
        if cur_entry == lh[ENTRY]:
            die("阶段 A 之后线上 index.html 已变成新版本 —— 顺序被破坏，停止")
        print("    ✅ %d 个 assets 已上线；index.html 仍是旧版（%s…）" % (len(stage_a), (cur_entry or "")[:16]))
        print("    观察窗口：此时页面行为与发布前完全一致")

        # ---------------------------------------------------- 3) 阶段 B
        print("\n[3] 阶段 B：切换入口")
        for k in stage_b:
            r.put(os.path.join(LOCAL_DIST, k), posixpath.join(REMOTE_DIR, k))
            if k == ENTRY:
                print("    → %s 已切换" % ENTRY)

        # ---------------------------------------------------- 4) 校验
        final = r.live_hashes()
        bad = [(k, lh[k][:12], final.get(k, "(缺)")[:12]) for k in lh if final.get(k) != lh[k]]
        if bad:
            print("❌ 全量哈希不符：", bad)
            r.run("cp -a %s/m/%s %s/%s" % (bdir, ENTRY, REMOTE_DIR, ENTRY))
            die("已恢复旧 %s，请复核后重试" % ENTRY)
        print("\n[4] ✅ 全量回读：本地 %d 个文件与线上逐一相符" % len(lh))

        print("\n[5] HTTP 自测：")
        http_codes(r, ["/m/", "/m/search", "/m/favicon.svg"])
        rc, out, _ = r.run("curl -s https://sh.scqfls.cn/m/ | grep -o '/m/assets/[a-zA-Z0-9._-]*' | head -6")
        print("  页面引用资源:\n" + out.rstrip())
        rc, out, _ = r.run(
            "curl -s https://sh.scqfls.cn/m/ | grep -o 'index-[A-Za-z0-9_-]*\\.js' | head -1")
        print("  index 实际引用的入口 chunk: %s" % out.strip())

        rec = {"stamp": stamp, "backup": bdir, "files": lh, "entry": lh[ENTRY],
               "stage_a": stage_a, "stage_b": stage_b}
        os.makedirs("storage/tmp", exist_ok=True)
        with open("storage/tmp/mobile-staged-%s.json" % stamp, "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False, indent=2)
        print("\n✅ 分两阶段发布完成 stamp=%s 备份=%s" % (stamp, bdir))
        print("   回滚：python scripts/deploy-mobile-staged.py --rollback %s" % stamp)
    finally:
        r.close()


if __name__ == "__main__":
    main()
