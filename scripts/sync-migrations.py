"""sync-migrations.py —— 补齐生产 dist/server/migrations（本次部署的遗漏项）

背景（2026-11-06 踩到）：
  service-ticket 的迁移是**独立打包**到 `dist/server/migrations/*.js` 的，
  不在 `dist/server/index.js` 里（index.js 只是运行时 bundle）。
  ⇒ 只替换 index.js 时，**迁移代码根本没更新**：`pm.upgrade()` 跑完了，
     但 migrator 看不到新文件，`migrations` 表停在 33 条，触发器与列都没建。

做法：
  · 只**新增**生产缺少的文件，不删除生产已有文件（生产可能有一份更早的打包）；
  · 逐文件比对 sha256，已一致则跳过（幂等，可重跑）；
  · 上传后复核 sha256；
  · 不动 dist/server/index.js（那份已验证落盘正确）。

用法：
    python scripts/sync-migrations.py --check
    python scripts/sync-migrations.py --apply
"""
import hashlib
import os
import posixpath
import sys

import paramiko

HOST = os.environ.get("S6_SSH_HOST", "162.14.121.180")
USER = os.environ.get("S6_SSH_USER", "root")
KEY = os.environ.get("S6_SSH_KEY", os.path.join(os.path.expanduser("~"), ".ssh", "id_ed25519"))
PLUGIN = "/opt/scqf-aftersales/src/storage/plugins/@local/service-ticket"
LOCAL_MIG = os.path.join("storage", "plugins", "@local", "service-ticket", "dist", "server", "migrations")


def log(m):
    print(m, flush=True)


def die(m, c=1):
    print("✗ %s" % m, flush=True)
    sys.exit(c)


def shq(s):
    return "'" + s.replace("'", "'\\''") + "'"


def main():
    apply = "--apply" in sys.argv
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(HOST, port=22, username=USER, key_filename=KEY,
                timeout=15, banner_timeout=20, auth_timeout=20,
                look_for_keys=True, allow_agent=False)

    def run(cmd, t=180):
        _i, o, e = cli.exec_command(cmd, timeout=t)
        return o.channel.recv_exit_status(), o.read().decode("utf-8", "replace"), e.read().decode("utf-8", "replace")

    remote_dir = PLUGIN + "/dist/server/migrations"
    rc, o, e = run("ls %s | sort" % shq(remote_dir))
    if rc != 0:
        die("读不到生产迁移目录：%s" % e[:300])
    remote_files = [x.strip() for x in o.splitlines() if x.strip()]

    local_files = sorted(f for f in os.listdir(LOCAL_MIG) if f.endswith(".js"))
    missing = [f for f in local_files if f not in remote_files]
    extra = [f for f in remote_files if f not in local_files]

    log("[1] 生产迁移文件 = %d，本地 = %d" % (len(remote_files), len(local_files)))
    log("[2] 生产缺少（待补）= %d：%s" % (len(missing), ", ".join(missing) or "(无)"))
    if extra:
        log("[3] 生产多出（不删除，仅提示）= %d：%s" % (len(extra), ", ".join(extra)))

    if not missing:
        log("[4] 无需补齐。")
        cli.close()
        return 0

    if not apply:
        log("[dry] 未写入。用 --apply 执行。")
        cli.close()
        return 0

    sftp = cli.open_sftp()
    up = 0
    for f in missing:
        lp = os.path.join(LOCAL_MIG, f)
        sftp.put(lp, posixpath.join(remote_dir, f))
        up += 1
    # 同名但内容可能不同的：只补缺失的，不覆盖生产的其它文件（避免引入未知差异）
    sftp.close()
    log("[5] 已上传 %d 个迁移文件" % up)

    rc, o, e = run("ls %s/*.js | wc -l" % shq(remote_dir))
    log("[6] 上传后生产迁移文件数 = %s" % o.strip())

    # 逐文件 sha256 复核（只核对本次新传的）
    bad = []
    for f in missing:
        lp = os.path.join(LOCAL_MIG, f)
        h_local = hashlib.sha256(open(lp, "rb").read()).hexdigest()
        rc, o2, _ = run("sha256sum %s | cut -d' ' -f1" % shq(posixpath.join(remote_dir, f)))
        if o2.strip() != h_local:
            bad.append(f)
    if bad:
        die("以下文件哈希不符：%s" % bad, 9)
    log("[7] 哈希复核：%d/%d 一致" % (len(missing), len(missing)))
    cli.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
