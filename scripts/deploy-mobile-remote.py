#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""deploy-mobile-remote.py —— 移动端 /m/ 静态站受控部署（R2.2.0 融合）

做三件事，全部可 dry-run / 可回滚：
  1) 上传 src-mobile/dist/* → /www/wwwroot/sh.scqfls.cn/m/（先传临时目录，再原子切换）
  2) **增量**插入 nginx 的 /m/ location（不改动任何现有 location 一行）
  3) 落盘后回读核对哈希 + nginx -t + reload + HTTP 自测

⚠️ 不整份覆盖线上 nginx：只做「锚点插入」，锚点是 h5 段结束后的空行。
   插入前必须确认目标文件里**尚无** `location ^~ /m/`，否则直接失败（幂等保护）。

用法：
  S6_SSH_PASS=... python scripts/deploy-mobile-remote.py --dry-run
  S6_SSH_PASS=... python scripts/deploy-mobile-remote.py --apply
  S6_SSH_PASS=... python scripts/deploy-mobile-remote.py --rollback <stamp>
"""
import argparse
import hashlib
import io
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
REMOTE_WWW = "/www/wwwroot/sh.scqfls.cn"
REMOTE_DIR = REMOTE_WWW + "/m"
BACKUP_ROOT = "/opt/scqf-aftersales/backups"
NGINX_CONF = "/www/server/panel/vhost/nginx/sh.scqfls.cn.conf"

# ⚠️ 复用 h5 段的写法（root 而不是 alias；`^~` 前缀而非正则）。
#    `try_files ... /m/index.html` 是 SPA 回退，必须保留，否则直接刷新 /m/search 会 404。
NGINX_BLOCK = """
    # =====================================================================
    #  R2.2.0 融合：员工移动端（Konsta UI，独立 Vite 构建，共享同一后端）
    # ---------------------------------------------------------------------
    #  与 /h5/ 同构：都是**外部构建的静态站**，不经过应用容器。
    #  为什么必须单独一段：不写它，`/m/xxx` 会落到 `location /` 被反代给应用，
    #  得到 NocoBase 的 SPA 加载壳（HTTP 200、2508 字节）—— 看起来"能打开"，
    #  实际是一个与移动端毫无关系的后台页面，而日志里全是 200。
    #
    #  内部工作台 ⇒ 同时发 X-Robots-Tag 与 Referrer-Policy no-referrer。
    #  add_header 不叠加：子块一旦出现 add_header，父级全部失效，
    #  所以这里**重新声明** server 级的安全头。
    # =====================================================================
    location = /m {
        return 301 /m/$is_args$args;
    }

    location ^~ /m/ {
        root /www/wwwroot/sh.scqfls.cn;
        index index.html;
        # SPA 回退：/m/search、/m/tickets、/m/archives/1 等都没有对应文件，
        # 一律回落到 index.html 由前端路由接管。
        try_files $uri $uri/ /m/index.html;

        add_header Cache-Control "no-store, must-revalidate" always;
        add_header X-Robots-Tag  "noindex, nofollow"         always;
        add_header Referrer-Policy "no-referrer" always;
        add_header X-Content-Type-Options   "nosniff"    always;
        add_header X-Frame-Options          "SAMEORIGIN" always;

        # Vite 产物文件名带内容哈希，可放心长缓存。
        # ⚠️ 不用 `expires`：它会自己再发一条 Cache-Control，与 add_header 叠加成两个头。
        location ~* ^/m/assets/ {
            root /www/wwwroot/sh.scqfls.cn;
            add_header Cache-Control "public, max-age=2592000, immutable" always;
            add_header X-Content-Type-Options "nosniff" always;
            access_log off;
        }
    }
"""


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def local_files():
    """本地产物清单（相对路径 → 绝对路径）"""
    out = {}
    root = os.path.abspath(LOCAL_DIST)
    if not os.path.isdir(root):
        raise SystemExit("本地产物目录不存在: %s" % root)
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            ap = os.path.join(dirpath, fn)
            rel = os.path.relpath(ap, root).replace("\\", "/")
            out[rel] = ap
    return out


def local_hashes():
    h = {}
    for rel, ap in local_files().items():
        with open(ap, "rb") as f:
            h[rel] = sha256_bytes(f.read())
    return h


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
            raise RuntimeError("命令失败 rc=%d: %s\n%s\n%s" % (rc, cmd, out[-800:], err[-800:]))
        return rc, out, err

    def close(self):
        try:
            self.sftp.close()
        finally:
            self.c.close()


def read_nginx(r):
    rc, out, _ = r.run("cat %s" % NGINX_CONF)
    if rc != 0:
        raise SystemExit("读不到 nginx 配置")
    return out


def nginx_status(r):
    rc, out, _ = r.run("grep -c 'location ^~ /m/' %s || true" % NGINX_CONF)
    has = out.strip() not in ("", "0")
    rc, out2, _ = r.run("grep -c 'location ^~ /h5/' %s || true" % NGINX_CONF)
    has_h5 = out2.strip() not in ("", "0")
    return has, has_h5


def plan_nginx_insert(conf):
    """把 /m/ 段插到 h5 段结束之后（即 h5 的 `location ~* ^/h5/assets/` 子块的闭合 `}` 之后）"""
    lines = conf.splitlines(keepends=True)
    marker = "location ~* ^/h5/assets/"
    mi = None
    for i, ln in enumerate(lines):
        if marker in ln:
            mi = i
            break
    if mi is None:
        raise SystemExit("找不到 h5 assets 子块锚点，拒绝插入（避免插错位置）")
    depth = 0
    started = False
    end = None
    for j in range(mi, len(lines)):
        depth += lines[j].count("{") - lines[j].count("}")
        if "{" in lines[j]:
            started = True
        if started and depth == 0:
            end = j
            break
    if end is None:
        raise SystemExit("h5 assets 子块未闭合，拒绝插入")
    return "".join(lines[: end + 1]) + NGINX_BLOCK + "".join(lines[end + 1:])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--rollback", default=None)
    a = ap.parse_args()
    if not PASS:
        raise SystemExit("缺少 S6_SSH_PASS")
    if not (a.dry_run or a.apply or a.rollback):
        raise SystemExit("需要 --dry-run / --apply / --rollback <stamp>")

    r = Remote()
    try:
        if a.rollback:
            bdir = "%s/mobile-%s" % (BACKUP_ROOT, a.rollback)
            rc, out, err = r.run("test -d %s && echo YES || echo NO" % bdir)
            if "YES" not in out:
                raise SystemExit("回滚目录不存在: %s" % bdir)
            print("回滚目录:", bdir)
            rc, out, _ = r.run("ls -1 %s" % bdir)
            print(out)
            if a.rollback and not a.dry_run:
                r.run("rm -rf %s && mkdir -p %s" % (REMOTE_DIR, REMOTE_DIR), check=True)
                r.run("cp -a %s/m/. %s/ 2>/dev/null || true" % (bdir, REMOTE_DIR), check=True)
                r.run("cp -a %s/nginx.conf %s" % (bdir, NGINX_CONF), check=True)
                rc, out, err = r.run("nginx -t")
                print(out, err)
                if rc != 0:
                    raise SystemExit("nginx -t 失败，未 reload")
                r.run("nginx -s reload")
                print("✅ 已回滚并 reload")
            return

        files = local_files()
        if not files:
            raise SystemExit("本地产物为空：%s" % LOCAL_DIST)
        lh = local_hashes()
        print("本地 /m 产物 %d 个文件：%s" % (len(files), posixpath.join(LOCAL_DIST)))
        for rel in sorted(lh):
            print("  %-40s %s" % (rel, lh[rel][:32] + "…"))

        has_m, has_h5 = nginx_status(r)
        print("\nnginx 现状: /m/ 段=%s  /h5/ 段=%s" % (has_m, has_h5))
        if not has_h5:
            raise SystemExit("生产没有 /h5/ 段，环境与预期不符，停止")

        conf = read_nginx(r)
        os.makedirs("storage/tmp", exist_ok=True)
        with io.open("storage/tmp/nginx-before.conf", "w", encoding="utf-8", newline="\n") as f:
            f.write(conf)
        if has_m:
            print("⚠️ nginx 已有 /m/ 段 ⇒ 只更新静态文件，不改配置")
            newconf = conf
        else:
            newconf = plan_nginx_insert(conf)
            with io.open("storage/tmp/nginx-after.conf", "w", encoding="utf-8", newline="\n") as f:
                f.write(newconf)
            print("已生成待插入配置 storage/tmp/nginx-after.conf（%d → %d 字节）" % (len(conf), len(newconf)))
            # 静态自检：新增内容必须只多不少，且原有每个 location 都在
            old_locs = [l.strip() for l in conf.splitlines() if l.strip().startswith("location")]
            new_locs = [l.strip() for l in newconf.splitlines() if l.strip().startswith("location")]
            missing = [l for l in old_locs if l not in new_locs]
            if missing:
                raise SystemExit("插入后丢失了原有 location，拒绝: %s" % missing[:5])
            print("配置静态自检通过：原 %d 个 location 全部保留，新增 %d 个" %
                  (len(old_locs), len(new_locs) - len(old_locs)))

        # 远端现状
        rc, out, _ = r.run("ls -1 %s 2>/dev/null | wc -l" % REMOTE_DIR)
        print("远端 %s 现有文件数: %s" % (REMOTE_DIR, out.strip()))

        if a.dry_run:
            print("\n[DRY-RUN] 将执行：")
            print("  1) 备份当前 /m（若存在）+ nginx.conf → %s/mobile-<stamp>/" % BACKUP_ROOT)
            print("  2) 上传 %d 个文件到 %s/.staging-<stamp>/ 后原子切换" % (len(files), REMOTE_DIR))
            print("  3) %s" % ("写入新的 nginx 段" if not has_m else "跳过 nginx 改动"))
            print("  4) nginx -t → reload → HTTP 自测 /m/ 与 /m/search")
            return

        stamp = time.strftime("%Y%m%d-%H%M%S")
        bdir = "%s/mobile-%s" % (BACKUP_ROOT, stamp)
        staging = REMOTE_WWW + "/.m-staging-" + stamp

        # ---- 1) 备份 ----
        r.run("mkdir -p %s" % bdir, check=True)
        if not has_m or True:
            r.run("test -d %s && cp -a %s %s/m || true" % (REMOTE_DIR, REMOTE_DIR, bdir), check=True)
        r.run("cp -a %s %s/nginx.conf" % (NGINX_CONF, bdir), check=True)
        rc, out, _ = r.run("ls -1 %s" % bdir)
        print("备份 →", bdir)
        print(out)

        # ---- 2) 上传到 staging ----
        r.run("rm -rf %s && mkdir -p %s" % (staging, staging), check=True)
        for rel, ap in files.items():
            dst = posixpath.join(staging, rel)
            parent = posixpath.dirname(dst)
            if parent:
                r.run("mkdir -p %s" % parent, check=True)
            r.sftp.put(ap, dst)
        # 回读核对
        rc, out, _ = r.run("cd %s && find . -type f | sort | xargs sha256sum" % staging)
        remote_h = {}
        for line in out.splitlines():
            parts = line.split()
            if len(parts) == 2:
                remote_h[parts[1].lstrip("./")] = parts[0]
        bad = []
        for rel, h in lh.items():
            if remote_h.get(rel) != h:
                bad.append((rel, h[:12], (remote_h.get(rel) or "(缺)")[:12]))
        if bad:
            print("❌ 上传后哈希不符:", bad)
            raise SystemExit("上传校验失败，未切换")
        print("✅ 上传 %d 个文件，回读哈希全部一致" % len(lh))

        # ---- 3) 原子切换 ----
        r.run("rm -rf %s && mv %s %s" % (REMOTE_DIR, staging, REMOTE_DIR), check=True)
        rc, out, _ = r.run("cd %s && find . -type f | sort | xargs sha256sum" % REMOTE_DIR)
        live_h = {}
        for line in out.splitlines():
            parts = line.split()
            if len(parts) == 2:
                live_h[parts[1].lstrip("./")] = parts[0]
        if live_h != lh:
            print("❌ 切换后哈希不符，立即恢复")
            r.run("rm -rf %s" % REMOTE_DIR)
            r.run("test -d %s/m && cp -a %s/m %s || true" % (bdir, bdir, REMOTE_DIR))
            raise SystemExit("切换校验失败，已恢复")
        print("✅ 已切换，%d 个文件哈希与本地逐一相符" % len(lh))

        # ---- 4) nginx ----
        if not has_m:
            sftp = r.sftp
            tmpconf = "/tmp/sh.scqfls.cn.conf.new"
            with sftp.open(tmpconf, "w") as f:
                f.write(newconf)
            rc, out, err = r.run("diff <(cat %s) %s | head -20" % (NGINX_CONF, tmpconf))
            print("待合入 diff 摘要:\n", out[:1200])
            r.run("cp -a %s %s" % (tmpconf, NGINX_CONF), check=True)
        rc, out, err = r.run("nginx -t")
        print("nginx -t:", (out + err).strip()[-500:])
        if rc != 0:
            print("❌ nginx -t 失败 ⇒ 恢复配置")
            r.run("cp -a %s/nginx.conf %s" % (bdir, NGINX_CONF))
            raise SystemExit("nginx 配置校验失败，已恢复")
        r.run("nginx -s reload", check=True)
        time.sleep(2)

        # ---- 5) HTTP 自测 ----
        for u in ["/m/", "/m/search", "/m/favicon.svg"]:
            rc, out, _ = r.run("curl -s -o /dev/null -w '%%{http_code} %%{size_download}' https://sh.scqfls.cn%s" % u)
            print("  %-16s → %s" % (u, out))
        rc, out, _ = r.run("curl -s https://sh.scqfls.cn/m/ | grep -o '/m/assets/[a-zA-Z0-9._-]*' | head -5")
        print("  页面引用资源:\n", out.strip())

        json.dump({"stamp": stamp, "backup": bdir, "files": lh, "nginx_changed": not has_m},
                  open("storage/tmp/mobile-deploy-%s.json" % stamp, "w"), ensure_ascii=False, indent=2)
        print("\n✅ 部署完成 stamp=%s 备份=%s" % (stamp, bdir))
    finally:
        r.close()


if __name__ == "__main__":
    main()
