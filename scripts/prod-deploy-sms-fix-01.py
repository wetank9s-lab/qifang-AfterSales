#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BE-03-SMS-FIX-01 生产部署（**最小面**：只换 3 个产物文件，无迁移、无 nginx、无 DB 改动）。

    python scripts/prod-deploy-sms-fix-01.py --apply
    python scripts/prod-deploy-sms-fix-01.py --rollback <stamp>

与 `prod-deploy-cumulative.py` 的关系：
  那边管"整包累计发布"（含迁移、nginx、预检闸）；本次用户**显式限定**只换三个文件、
  不要迁移，所以单独写一支。但硬闸照抄：
    · 挂载点唯一定位（不用 find）
    · 备份 → 上传 → **逐文件 sha256 复核** → 才重启
    · 健康判据**自证**（3 位数字），判据坏了就去 die，不回滚
    · 迁移登记数 **必须不变**（本次不许动库）
"""
import os
import sys
import posixpath
import subprocess
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

# 用户 2026-11-06 授权的目标指纹（只允许这三个文件、只允许这两个哈希）
TARGET = {
    "server/index.js": "e1fe6c8075dc224f",
    "client/index.js": "74f0ef80d5f45598",
}
EXTRA = "build-fingerprint.json"

import paramiko


def shq(s):
    return "'" + str(s).replace("'", "'\"'\"'") + "'"


def die(msg, code=1):
    print("\n⛔ " + msg)
    sys.exit(code)


class R:
    def __init__(self):
        c = paramiko.SSHClient()
        c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        c.connect(HOST, port=22, username=USER, password=PASS or None,
                  key_filename=KEY if os.path.exists(KEY) else None,
                  timeout=15, banner_timeout=20, auth_timeout=20,
                  look_for_keys=True, allow_agent=False)
        self.c = c
        self.sftp = c.open_sftp()

    def run(self, cmd, timeout=180):
        _, o, e = self.c.exec_command(cmd, timeout=timeout)
        return (o.read().decode("utf-8", "replace"), e.read().decode("utf-8", "replace"))

    def psql(self, sql, timeout=120):
        out, err = self.run(
            "docker exec -i %s psql -U %s -d %s -X -A -t -c %s"
            % (shq(PG), shq(DB_USER), shq(DB_NAME), shq(sql)), timeout)
        return out.strip(), err.strip()

    def close(self):
        try:
            self.sftp.close()
        except Exception:
            pass
        self.c.close()


def sha_local(p):
    # ⚠️ 不要 shell 出去跑 `sha256sum`：本机 Git Bash 会把输出路径前缀 `*` 转义成 `\e*`，
    #    取 split()[0] 时会连带吞掉哈希尾部（得到 15 位、末尾带 ESC），判据莫名变红。
    import hashlib
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def detect_dist(r):
    o, _ = r.run("docker inspect %s --format '{{range .Mounts}}{{.Source}}|{{.Destination}}|{{.RW}}{{println}}{{end}}'" % shq(APP), 60)
    mounts = []
    for line in o.splitlines():
        parts = line.strip().split("|")
        if len(parts) == 3:
            mounts.append({"src": parts[0], "dst": parts[1], "rw": parts[2] == "true"})
    hits = [m for m in mounts if m["dst"].rstrip("/").endswith("/storage/plugins/@local/service-ticket")]
    if len(hits) != 1:
        die("插件挂载点不是恰好 1 个：%s —— 停止，不猜" % (hits or "(无)"), 2)
    if not hits[0]["rw"]:
        die("插件目录在容器内是只读挂载，写入无效", 2)
    return posixpath.join(hits[0]["src"], "dist")


def health(r):
    o, _ = r.run("curl -s -o /dev/null -w '%%{http_code}' http://127.0.0.1:13000/api/app:getInfo", 30)
    # ⚠️ 上面用 %% 是因为本串还会过一遍 % 格式化；这里改成字符串拼接后必须写 %{http_code}
    o2, _ = r.run("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:13000/api/app:getInfo", 30)
    return o2.strip()


def main():
    stamp = time.strftime("%Y%m%d-%H%M%S")
    rollback_to = None
    if "--rollback" in sys.argv:
        rollback_to = sys.argv[sys.argv.index("--rollback") + 1]

    r = R()
    try:
        dist = detect_dist(r)
        print("[1] dist = %s" % dist)

        if rollback_to:
            bak = dist + ".bak." + rollback_to
            o, _ = r.run("test -d %s && echo YES" % shq(bak), 30)
            if "YES" not in o:
                die("备份不存在：%s" % bak, 3)
            r.run("rm -rf %s && cp -a %s %s" % (shq(dist), shq(bak), shq(dist)), 300)
            r.run("cd /opt/scqf-aftersales && docker compose -f docker-compose.prod.yml restart app", 300)
            print("✓ 已回滚到 %s" % bak)
            return 0

        # ---------- 0. 本地产物必须与授权指纹一致 ----------
        for rel, want in TARGET.items():
            got = sha_local(os.path.join(LOCAL_DIST, rel))[:16]
            if got != want:
                die("本地 %s 指纹 %s ≠ 授权 %s —— 拒绝发布" % (rel, got, want), 4)
            print("[0] 本地 %-18s %s ✓" % (rel, got))

        # ---------- 1. 现网状态（只读） ----------
        o, _ = r.run("cd %s && sha256sum server/index.js client/index.js build-fingerprint.json 2>/dev/null | awk '{print substr($1,1,16), $2}'" % shq(dist), 60)
        print("[2] 现网产物：")
        for line in o.strip().splitlines():
            print("      " + line)
        mig_before, _ = r.psql("SELECT count(*) FROM migrations")
        print("[3] 迁移登记数（部署前）= %s" % mig_before)

        # 记录改动前的 technician_task 拦截证据（用于对比）
        pre, _ = r.psql(
            "SELECT coalesce(send_status,'-')||'|'||coalesce(error_code,'-') FROM sms_logs "
            "WHERE scene='technician_task' ORDER BY id DESC LIMIT 1")
        print("[4] 最近一条 technician_task 日志 = %s" % pre)

        # ---------- 2. 备份 ----------
        bak = dist + ".bak." + stamp
        rc, err = r.run("cp -a %s %s && echo OK" % (shq(dist), shq(bak)), 300)
        if "OK" not in rc:
            die("备份失败：%s" % err, 5)
        o, _ = r.run("test -d %s && echo YES; du -sh %s | cut -f1" % (shq(bak), shq(bak)), 60)
        print("[5] 备份 %s → %s" % (bak, o.strip().replace("\n", " ")))

        # ---------- 3. 上传（先落临时目录，sha256 复核后才覆盖） ----------
        tmpd = "/root/.smsfix01-" + stamp
        r.run("mkdir -p %s" % shq(tmpd), 30)
        for rel in list(TARGET.keys()) + [EXTRA]:
            r.sftp.put(os.path.join(LOCAL_DIST, rel), posixpath.join(tmpd, rel.replace("/", "_")))
        o, _ = r.run("cd %s && sha256sum * | awk '{print substr($1,1,16), $2}'" % shq(tmpd), 60)
        got = {}
        for line in o.strip().splitlines():
            h, n = line.split(None, 1)
            got[n.strip()] = h
        print("[6] 上传后指纹：")
        for n, h in got.items():
            print("      %-24s %s" % (n, h))
        for rel, want in TARGET.items():
            n = rel.replace("/", "_")
            if got.get(n) != want:
                die("传输损坏：%s 远端 %s ≠ %s —— 未覆盖任何文件" % (n, got.get(n), want), 6)
        if EXTRA not in got:
            die("缺 %s" % EXTRA, 6)

        # ---------- 4. 落位（只覆盖这三���文件） ----------
        r.run("cp -f %s %s" % (shq(posixpath.join(tmpd, "server_index.js")), shq(posixpath.join(dist, "server/index.js"))), 60)
        r.run("cp -f %s %s" % (shq(posixpath.join(tmpd, "client_index.js")), shq(posixpath.join(dist, "client/index.js"))), 60)
        r.run("cp -f %s %s" % (shq(posixpath.join(tmpd, EXTRA)), shq(posixpath.join(dist, EXTRA))), 60)
        o, _ = r.run("cd %s && sha256sum server/index.js client/index.js build-fingerprint.json | awk '{print substr($1,1,16), $2}'" % shq(dist), 60)
        print("[7] 落位后现网：")
        onl = {}
        for line in o.strip().splitlines():
            h, n = line.split(None, 1)
            onl[n.strip()] = h
            print("      %-24s %s" % (n, h))
        for rel, want in TARGET.items():
            if onl.get(rel) != want:
                die("落位后指纹不符：%s = %s ≠ %s —— 立即回滚" % (rel, onl.get(rel), want), 7)

        # ---------- 5. 重启 ----------
        print("[8] 重启 %s …" % APP)
        r.run("cd /opt/scqf-aftersales && docker compose -f docker-compose.prod.yml restart app", 300)

        okurl = False
        for i in range(30):
            time.sleep(4)
            h = health(r)
            if not (isinstance(h, str) and h.isdigit() and len(h) == 3):
                die("健康判据自身异常：返回 %r —— 这是脚本判据坏了，不等于应用故障。"
                    "已停止自动决策，请人工复核（**未回滚**）" % (h,), 12)
            print("      t+%02ds health=%s" % ((i + 1) * 4, h))
            if h == "200":
                okurl = True
                break
        if not okurl:
            die("健康未通过 ⇒ 需要回滚。手动执行：python %s --rollback %s" % (sys.argv[0], stamp), 13)

        mig_after, _ = r.psql("SELECT count(*) FROM migrations")
        print("[9] 迁移登记数（部署后）= %s（应等于 %s）" % (mig_after, mig_before))
        if mig_after != mig_before:
            die("迁移数变化了 —— 本次不应动库！", 14)

        # ---------- 6. 代码侧硬判据：闸门必须已清空 ----------
        o, _ = r.run("grep -o 'SMS_REVIEW_PENDING_SCENES = \\[[^]]*\\]' %s | head -1" % shq(posixpath.join(dist, "server/index.js")), 60)
        print("[10] bundle 内闸门 = %s" % o.strip())
        if "SMS_REVIEW_PENDING_SCENES = []" not in o:
            die("生产 bundle 里闸门仍非空 —— 部署未生效", 15)

        print("\n✅ 部署完成（无迁移、无 nginx 改动、无 DB 改动）")
        print("   备份: %s" % bak)
        print("   回滚: python %s --rollback %s" % (sys.argv[0], stamp))
        return 0
    finally:
        r.close()


if __name__ == "__main__":
    sys.exit(main() or 0)
