#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
P0-1 生产部署（**最小面**：只换 H5 静态产物 3 个文件；无容器重启、无 nginx、无 DB、无迁移）。

    python scripts/prod-deploy-p01.py --dry-run
    python scripts/prod-deploy-p01.py --apply
    python scripts/prod-deploy-p01.py --rollback <stamp>

硬闸（照抄既有的 prod-deploy 规范，**不放宽**）：
  · 只允许动 /www/wwwroot/sh.scqfls.cn/h5/ 下的 index.html + 2 个 assets 文件；
  · 备份整个 h5 目录 → 上传 → **逐文件 sha256 复核**（本地算的哈希 vs 远端算的哈希）；
  · **旧 JS/CSS 一律保留**（不删，供回滚）；
  · 不重启任何容器、不碰 nginx 配置、不碰数据库；
  · 上线后回取 HTTP，断言 index.html 引用的是新文件名，且新 JS 的 sha256 与本地一致。

失败即中止，不做"看起来成功"的兜底。
"""
import hashlib
import io
import os
import sys
import time

HOST = os.environ.get("S6_HOST", "162.14.121.180")
USER = os.environ.get("S6_USER", "root")
PASS = os.environ.get("S6_SSH_PASS", "")
KEY = os.environ.get("S6_SSH_KEY", os.path.join(os.path.expanduser("~"), ".ssh", "id_ed25519"))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_DIST = os.path.join(ROOT, ".build", "p01d", "dist")

SITE_ROOT = "/www/wwwroot/sh.scqfls.cn"
H5_DIR = SITE_ROOT + "/h5"
STAMP = time.strftime("%Y%m%d-%H%M%S")

# 本次要发布的 3 个文件（相对 h5/ 的路径）
FILES = [
    "index.html",
    "assets/index-BG5kVB0x.js",
    "assets/index-DBQ7A3d6.css",
]

# 期望的新文件名（部署后 index.html 必须引用它）
NEW_JS = "index-BG5kVB0x.js"
NEW_CSS = "index-DBQ7A3d6.css"

import paramiko


def shq(s):
    return "'" + str(s).replace("'", "'\"'\"'") + "'"


def die(msg, code=1):
    print("\n[STOP] " + msg)
    sys.exit(code)


def local_sha(path):
    h = hashlib.sha256()
    with io.open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


class R:
    def __init__(self):
        c = paramiko.SSHClient()
        c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        c.connect(HOST, port=22, username=USER, password=PASS or None,
                  key_filename=KEY if os.path.exists(KEY) else None,
                  timeout=20, banner_timeout=25, auth_timeout=25,
                  allow_agent=False, look_for_keys=False)
        self.c = c

    def run(self, cmd, timeout=120):
        _in, out, err = self.c.exec_command(cmd, timeout=timeout)
        o = out.read().decode("utf-8", "replace")
        e = err.read().decode("utf-8", "replace")
        rc = out.channel.recv_exit_status()
        return rc, o, e

    def put(self, local, remote):
        sftp = self.c.open_sftp()
        try:
            sftp.put(local, remote)
        finally:
            sftp.close()

    def close(self):
        try:
            self.c.close()
        except Exception:
            pass


def check_local():
    print("=" * 78)
    print("1. 本地产物自检")
    print("=" * 78)
    shas = {}
    for rel in FILES:
        p = os.path.join(LOCAL_DIST, rel.replace("/", os.sep))
        if not os.path.exists(p):
            die("本地缺文件: %s" % p)
        s = local_sha(p)
        shas[rel] = s
        print("  %-32s %8d  %s" % (rel, os.path.getsize(p), s[:32]))
    # index.html 必须引用新文件名
    html = io.open(os.path.join(LOCAL_DIST, "index.html"), encoding="utf-8").read()
    if NEW_JS not in html or NEW_CSS not in html:
        die("index.html 未引用新产物: js=%s css=%s" % (NEW_JS in html, NEW_CSS in html))
    print("  [OK] index.html 引用 %s / %s" % (NEW_JS, NEW_CSS))
    return shas


def preflight(r):
    print()
    print("=" * 78)
    print("2. 生产侧只读预检")
    print("=" * 78)
    rc, o, e = r.run("ls -la %s" % shq(H5_DIR))
    if rc != 0:
        die("H5 目录不可访问: %s" % e)
    print(o.rstrip())
    rc, o, _ = r.run("sha256sum %s/index.html %s/assets/index-B-QCspWq.js 2>/dev/null || true" % (shq(H5_DIR), shq(H5_DIR)))
    print("  当前线上指纹:\n" + "".join("    " + l + "\n" for l in o.strip().splitlines()))
    # 断言目录可写
    rc, o, e = r.run("test -w %s && echo WRITABLE || echo READONLY" % shq(H5_DIR))
    if "WRITABLE" not in o:
        die("H5 目录不可写")
    print("  [OK] H5 目录可写")
    # 断言不重启容器：确认没有 docker 操作需求（只做记录）
    rc, o, _ = r.run("du -sh %s 2>/dev/null; df -h %s | tail -1" % (shq(H5_DIR), shq(SITE_ROOT)))
    print("  空间: " + o.replace("\n", " | ").strip())


def backup(r):
    print()
    print("=" * 78)
    print("3. 备份线上 H5 目录")
    print("=" * 78)
    bak = "%s.bak.%s" % (H5_DIR, STAMP)
    rc, o, e = r.run("cp -a %s %s && echo BACKED" % (shq(H5_DIR), shq(bak)))
    if "BACKED" not in o:
        die("备份失败: %s %s" % (o, e))
    rc, o, _ = r.run("sha256sum %s/index.html %s/assets/index-B-QCspWq.js" % (shq(bak), shq(bak)))
    print("  备份路径: %s" % bak)
    print("  备份指纹:\n" + "".join("    " + l + "\n" for l in o.strip().splitlines()))
    return bak


def upload(r, shas):
    print()
    print("=" * 78)
    print("4. 上传 + 逐文件 sha256 复核")
    print("=" * 78)
    # 确保 assets 目录在（已存在，只是保险）
    r.run("mkdir -p %s/assets" % shq(H5_DIR))
    for rel in FILES:
        lp = os.path.join(LOCAL_DIST, rel.replace("/", os.sep))
        rp = H5_DIR + "/" + rel
        r.put(lp, rp)
        rc, o, _ = r.run("sha256sum %s" % shq(rp))
        remote_sha = o.split()[0] if o.split() else ""
        ok = remote_sha == shas[rel]
        print("  %-32s %s" % (rel, "OK  " + remote_sha[:32] if ok else "FAIL local=%s remote=%s" % (shas[rel][:16], remote_sha[:16])))
        if not ok:
            die("上传后哈希不一致: %s" % rel)


def verify_http(shas):
    print()
    print("=" * 78)
    print("5. HTTP 回取验证（不重启、不改 nginx）")
    print("=" * 78)
    import subprocess
    base = "http://sh.scqfls.cn/h5"
    # index.html
    p = subprocess.run(["curl", "-sL", "--max-time", "25", base + "/"], capture_output=True)
    html = p.stdout.decode("utf-8", "replace")
    has_new_js = NEW_JS in html
    has_new_css = NEW_CSS in html
    print("  index.html 引用新 JS : %s" % has_new_js)
    print("  index.html 引用新 CSS: %s" % has_new_css)
    if not (has_new_js and has_new_css):
        die("线上 index.html 未引用新产物（可能缓存或未生效）")
    # 新 JS 内容哈希
    for rel, expect in (("assets/" + NEW_JS, shas["assets/index-BG5kVB0x.js"]),
                        ("assets/" + NEW_CSS, shas["assets/index-DBQ7A3d6.css"])):
        tmp = os.path.join(ROOT, ".probe", "_dl_" + os.path.basename(rel))
        subprocess.run(["curl", "-sL", "--max-time", "40", "-o", tmp, base + "/" + rel], check=False)
        got = local_sha(tmp)
        print("  %-32s %s" % (rel, "OK  " + got[:32] if got == expect else "FAIL got=%s" % got[:16]))
        if got != expect:
            die("HTTP 取得的 %s 与本地不一致" % rel)
        os.remove(tmp)
    # 旧文件仍可访问（回滚兜底）
    p = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                        "--max-time", "20", base + "/assets/index-B-QCspWq.js"], capture_output=True)
    code = p.stdout.decode().strip()
    print("  旧 JS 仍保留可访问: HTTP %s %s" % (code, "(OK)" if code == "200" else "(注意)"))


def rollback(r, stamp):
    bak = "%s.bak.%s" % (H5_DIR, stamp)
    print("回滚到 %s" % bak)
    rc, o, e = r.run("test -d %s && echo EXISTS" % shq(bak))
    if "EXISTS" not in o:
        die("备份目录不存在: %s" % bak)
    rc, o, e = r.run(
        "mv %s %s.broken.%s && mv %s %s && echo ROLLED_BACK"
        % (shq(H5_DIR), shq(H5_DIR), time.strftime("%Y%m%d-%H%M%S"), shq(bak), shq(H5_DIR)))
    print(o.strip() or e.strip())


def main() -> int:
    mode = "--dry-run"
    for a in sys.argv[1:]:
        if a in ("--apply", "--dry-run", "--rollback"):
            mode = a
    stamp_arg = None
    if mode == "--rollback":
        idx = sys.argv.index("--rollback")
        if idx + 1 >= len(sys.argv):
            die("--rollback 需要时间戳参数")
        stamp_arg = sys.argv[idx + 1]

    print("HOST=%s  MODE=%s" % (HOST, mode))
    r = R()
    try:
        if mode == "--rollback":
            rollback(r, stamp_arg)
            return 0

        shas = check_local()
        preflight(r)
        if mode == "--dry-run":
            print("\n[DRY-RUN] 预检通过，未做任何改动。")
            return 0

        bak = backup(r)
        upload(r, shas)
        verify_http(shas)
        print()
        print("=" * 78)
        print("部署完成")
        print("  备份: %s" % bak)
        print("  回滚: python scripts/prod-deploy-p01.py --rollback %s" % STAMP)
        print("=" * 78)
        return 0
    finally:
        r.close()


if __name__ == "__main__":
    sys.exit(main())
