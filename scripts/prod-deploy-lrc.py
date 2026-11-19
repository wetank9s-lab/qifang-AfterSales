#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
P0-LOW-RATING-CLOSE 生产发布（插件 server/client 3 个产物 + H5 3 个静态产物；无迁移、无 nginx、无 DB schema 改动）

    python scripts/prod-deploy-lrc.py --dry-run
    python scripts/prod-deploy-lrc.py --apply
    python scripts/prod-deploy-lrc.py --rollback <stamp>

硬闸（照抄既有的 prod-deploy 规范，不放宽）：
  · 每个文件发布前先算**本地** sha256，发布后在**远端**再算一次，逐文件比对；
  · 备份：插件 dist 整目录 + H5 整目录（回滚锚点）；
  · 迁移登记数必须**不变**（本次不动库结构）；
  · 健康判据**自证**（3 位数字），判据坏了就 die，不做自动决策；
  · bundle 内必须有本轮的业务标记（"低分不再重开"那个分支已被删除），
    否则"上去了但没生效"这种假绿会被当成 PASS。
"""
import os
import posixpath
import sys
import time

HOST = os.environ.get("S6_HOST", "162.14.121.180")
USER = os.environ.get("S6_USER", "root")
APP = os.environ.get("S6_APP", "scqf-as-app")
PG = os.environ.get("S6_PG", "scqf-as-postgres")
DB_USER = os.environ.get("S6_PG_USER", "scqf_as")
DB_NAME = os.environ.get("S6_PG_DB", "scqf_aftersales_candidate")
KEY = os.environ.get("S6_SSH_KEY", os.path.join(os.path.expanduser("~"), ".ssh", "id_ed25519"))
PASS = os.environ.get("S6_SSH_PASS", "")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_DIST = os.path.join(ROOT, "storage", "plugins", "@local", "service-ticket", "dist")
LOCAL_H5 = os.path.join(ROOT, "h5", "dist")

SITE_ROOT = "/www/wwwroot/sh.scqfls.cn"
H5_DIR = SITE_ROOT + "/h5"

# ---- 授权指纹（用户 2026-11-06 批准上线的构建产物）----
# ⚠️ 2026-11-06 17:40 二次构建：修正 bootstrap 引导目录解析（生产 `storage` 是具名卷，
#    不是宿主机 `/opt/.../src/storage`），server/client 指纹随之变化。
PLUGIN_FILES = {
    "server/index.js": "4030a9f4e08d591d",
    "client/index.js": "62b4d71f224e28db",
    "build-fingerprint.json": "bf2494777a84b1c5",
}
H5_FILES = [
    "index.html",
    "assets/index-BzQUHIgl.js",
    "assets/index-Bk_EobzV.css",
]
H5_EXPECT = {
    "index.html": "b0f20092b47f4c69",
    "assets/index-BzQUHIgl.js": "b2d51e063374280e",
    "assets/index-Bk_EobzV.css": "0ecdbfd1f0e1b34e",
}
NEW_JS = "index-BzQUHIgl.js"
NEW_CSS = "index-Bk_EobzV.css"

import paramiko


def shq(s):
    return "'" + str(s).replace("'", "'\"'\"'") + "'"


def die(msg, code=1):
    print("\n⛔ " + msg)
    sys.exit(code)


def sha_local(p):
    # ⚠️ 不要 shell 出去跑 sha256sum：Git Bash 会把输出的 `*` 前缀转义，切分时吞掉哈希尾部。
    import hashlib
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class R:
    def __init__(self):
        c = paramiko.SSHClient()
        c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        c.connect(HOST, port=22, username=USER, password=PASS or None,
                  key_filename=KEY if os.path.exists(KEY) else None,
                  timeout=20, banner_timeout=25, auth_timeout=25,
                  look_for_keys=True, allow_agent=False)
        self.c = c
        self.sftp = c.open_sftp()

    def run(self, cmd, timeout=180):
        _, o, e = self.c.exec_command(cmd, timeout=timeout)
        return (o.read().decode("utf-8", "replace"), e.read().decode("utf-8", "replace"))

    def psql(self, sql, timeout=120):
        return self.run(
            "docker exec -i %s psql -U %s -d %s -X -A -t -c %s"
            % (shq(PG), shq(DB_USER), shq(DB_NAME), shq(sql)), timeout)

    def sha_remote(self, path):
        o, _ = self.run("sha256sum %s 2>/dev/null | cut -c1-64" % shq(path), 30)
        return o.strip()

    def close(self):
        try:
            self.sftp.close()
        except Exception:
            pass
        self.c.close()


def detect_dist(r):
    o, _ = r.run("docker inspect %s --format '{{range .Mounts}}{{.Source}}|{{.Destination}}|{{.RW}}{{println}}{{end}}'" % shq(APP), 60)
    hits = []
    for line in o.splitlines():
        parts = line.strip().split("|")
        if len(parts) == 3 and parts[1].rstrip("/").endswith("/storage/plugins/@local/service-ticket"):
            hits.append(parts)
    if len(hits) != 1:
        die("插件挂载点不是恰好 1 个：%s" % (hits or "(无)"), 2)
    if hits[0][2] != "true":
        die("插件目录在容器内是只读挂载，写入无效", 2)
    return posixpath.join(hits[0][0], "dist")


def health(r):
    o, _ = r.run("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:13000/api/app:getInfo", 30)
    return o.strip()


def main():
    stamp = time.strftime("%Y%m%d-%H%M%S")
    rb = None
    if "--rollback" in sys.argv:
        rb = sys.argv[sys.argv.index("--rollback") + 1]

    r = R()
    try:
        dist = detect_dist(r)
        print("[1] dist = %s" % dist)

        if rb:
            pbak = dist + ".bak." + rb
            hbak = H5_DIR + ".bak." + rb
            o, _ = r.run("test -d %s && echo A; test -d %s && echo B" % (shq(pbak), shq(hbak)), 30)
            r.run("test -d %s && (rm -rf %s && cp -a %s %s)" % (shq(pbak), shq(dist), shq(pbak), shq(dist)), 300)
            r.run("test -d %s && (rm -rf %s && cp -a %s %s)" % (shq(hbak), shq(H5_DIR), shq(hbak), shq(H5_DIR)), 300)
            r.run("cd /opt/scqf-aftersales && docker compose -f docker-compose.prod.yml restart app", 300)
            print("✓ 已回滚（插件 %s / H5 %s，存在性：%s）" % (pbak, hbak, o.strip().replace("\n", " ")))
            return 0

        # ---------- 0. 本地产物必须与授权指纹一致 ----------
        for rel, want in PLUGIN_FILES.items():
            got = sha_local(os.path.join(LOCAL_DIST, rel))[:16]
            if got != want:
                die("本地插件 %s 指纹 %s ≠ 授权 %s —— 拒绝发布" % (rel, got, want), 4)
            print("[0a] 插件 %-24s %s ✓" % (rel, got))
        for rel, want in H5_EXPECT.items():
            got = sha_local(os.path.join(LOCAL_H5, rel))[:16]
            if got != want:
                die("本地 H5 %s 指纹 %s ≠ 授权 %s —— 拒绝发布" % (rel, got, want), 4)
            print("[0b] H5   %-24s %s ✓" % (rel, got))

        # 迁移数（本地 vs 远端）—— 本次不得变化
        mig_local = len([x for x in os.listdir(os.path.join(LOCAL_DIST, "server", "migrations")) if x.endswith(".js")])
        mig_before, _ = r.psql("SELECT count(*) FROM migrations")
        print("[2] 迁移：本地产物 %d 个 · 远端登记 %s" % (mig_local, mig_before.strip()))
        if int(mig_before.strip()) < 41:
            die("远端迁移登记数异常（%s < 41），与《部署登记簿》不符 —— 停止" % mig_before.strip(), 5)

        # 现网指纹（部署前）
        print("[3] 现网产物（部署前）：")
        onl = pgrep(r, dist, H5_DIR)
        for k, v in onl.items():
            print("      %-30s %s" % (k, v[:16] if v else "(缺)"))

        if "--dry-run" in sys.argv:
            print("\n✅ 预演完成（未改任何文件）。计划发布：")
            print("      插件 dist: %s" % dist)
            print("      H5 目录  : %s" % H5_DIR)
            print("      文件     : %s" % ", ".join(list(PLUGIN_FILES) + H5_FILES))
            return 0

        if "--apply" not in sys.argv:
            die("用法：--dry-run | --apply | --rollback <stamp>", 2)

        # ---------- 1. 备份 ----------
        pbak = dist + ".bak." + stamp
        hbak = H5_DIR + ".bak." + stamp
        o1, e1 = r.run("cp -a %s %s && echo OK" % (shq(dist), shq(pbak)), 300)
        if "OK" not in o1:
            die("插件 dist 备份失败：%s" % e1[:200], 6)
        o2, e2 = r.run("cp -a %s %s && echo OK" % (shq(H5_DIR), shq(hbak)), 300)
        if "OK" not in o2:
            die("H5 备份失败：%s" % e2[:200], 6)
        print("[4] 备份：%s" % pbak)
        print("[4] 备份：%s" % hbak)

        # ---------- 2. 上传到临时目录并逐文件核对 ----------
        tmpd = "/root/.lrc-" + stamp
        r.run("mkdir -p %s/h5/assets" % shq(tmpd), 30)
        up = []
        for rel in PLUGIN_FILES:
            up.append((os.path.join(LOCAL_DIST, rel),
                       posixpath.join(tmpd, "plugin_" + rel.replace("/", "_"))))
        for rel in H5_FILES:
            up.append((os.path.join(LOCAL_H5, rel), posixpath.join(tmpd, "h5", rel)))
        for lp, rp in up:
            r.sftp.put(lp, rp)

        for lp, rp in up:
            want = sha_local(lp)
            got = r.sha_remote(rp)
            if got != want:
                die("传输损坏：%s 远端 %s ≠ 本地 %s —— 未覆盖任何文件" % (posixpath.basename(rp), got[:16], want[:16]), 7)
        print("[5] 上传并校验 %d 个文件 ✓" % len(up))

        # ---------- 3. 落位 ----------
        for rel in PLUGIN_FILES:
            r.run("cp -f %s %s" % (shq(posixpath.join(tmpd, "plugin_" + rel.replace("/", "_"))),
                                   shq(posixpath.join(dist, rel))), 60)
        for rel in H5_FILES:
            r.run("cp -f %s %s" % (shq(posixpath.join(tmpd, "h5", rel)),
                                   shq(posixpath.join(H5_DIR, rel))), 60)
        print("[6] 落位完成（旧 JS/CSS 保留未删，供回滚）")

        # 落位后复核
        for rel, want in PLUGIN_FILES.items():
            got = r.sha_remote(posixpath.join(dist, rel))
            if got[:16] != want:
                die("落位后插件 %s = %s ≠ %s —— 立即回滚" % (rel, got[:16], want), 8)
        for rel, want in H5_EXPECT.items():
            got = r.sha_remote(posixpath.join(H5_DIR, rel))
            if got[:16] != want:
                die("落位后 H5 %s = %s ≠ %s —— 立即回滚" % (rel, got[:16], want), 8)
        print("[7] 落位后指纹复核 ✓")

        # ---------- 4. bundle 业务标记 ----------
        o, _ = r.run("grep -c 'adminCloseTicket' %s" % shq(posixpath.join(dist, "server/index.js")), 30)
        print("[8] bundle 内 adminCloseTicket 出现次数 = %s" % o.strip())
        if not o.strip().isdigit() or int(o.strip()) < 2:
            die("生产 bundle 不含本轮新增的关单方法 —— 部署未生效", 9)
        o, _ = r.run("grep -c 'low_score' %s" % shq(posixpath.join(dist, "server/index.js")), 30)
        print("[8] bundle 内 low_score 残留次数 = %s（仅统计报表口径会用到）" % o.strip())

        # ---------- 5. 重启 ----------
        print("[9] 重启 %s …" % APP)
        r.run("cd /opt/scqf-aftersales && docker compose -f docker-compose.prod.yml restart app", 300)
        ok = False
        for i in range(40):
            time.sleep(4)
            h = health(r)
            if not (isinstance(h, str) and h.isdigit() and len(h) == 3):
                die("健康判据自身异常：返回 %r —— 这是脚本判据坏了，不等于应用故障。"
                    "已停止自动决策，请人工复核（**未回滚**）" % (h,), 12)
            print("      t+%03ds health=%s" % ((i + 1) * 4, h))
            if h == "200":
                ok = True
                break
        if not ok:
            die("健康未通过 ⇒ 需要回滚：python %s --rollback %s" % (sys.argv[0], stamp), 13)

        mig_after, _ = r.psql("SELECT count(*) FROM migrations")
        print("[10] 迁移登记数：%s → %s（应不变）" % (mig_before.strip(), mig_after.strip()))
        if mig_after.strip() != mig_before.strip():
            die("迁移数变化了 —— 本次不应动库！", 14)

        print("\n✅ 部署完成（无迁移、无 nginx 改动、无 DB schema 改动）")
        print("   备份: %s" % pbak)
        print("   备份: %s" % hbak)
        print("   回滚: python %s --rollback %s" % (sys.argv[0], stamp))
        return 0
    finally:
        r.close()


def pgrep(r, dist, h5dir):
    out = {}
    for rel in PLUGIN_FILES:
        out["plugin:" + rel] = r.sha_remote(posixpath.join(dist, rel))
    for rel in H5_FILES:
        out["h5:" + rel] = r.sha_remote(posixpath.join(h5dir, rel))
    return out


if __name__ == "__main__":
    sys.exit(main() or 0)
