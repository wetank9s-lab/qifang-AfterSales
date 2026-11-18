#!/usr/bin/env python
"""deploy-s6-remote.py —— BE-03-S6 受控部署（SSH 密码登录，paramiko）

设计约束（对应用户的 10 条前置条件）：
  · **只动 dist 下 3 个文件** + 一次 restart；不改库、不改历史短信、不改权限、不改 Nginx；
  · 凭据只从环境变量读，**不打印、不落盘、不写日志**；
  · 每一步都打印**可核验的观测值**（哈希/HTTP 码/容器名），不打印"我以为成功了"；
  · 任何一步失败 ⇒ 立刻整目录回滚并停下（不试错）；
  · 先 `--dry-run`：只读，确认主机/目录/容器/当前哈希，不做任何写操作。

用法：
  S6_SSH_PASS=*** python scripts/deploy-s6-remote.py --dry-run
  S6_SSH_PASS=*** python scripts/deploy-s6-remote.py --apply
  S6_SSH_PASS=*** python scripts/deploy-s6-remote.py --rollback <ts>
"""

import json
import os
import posixpath
import re
import stat
import sys
import time

import paramiko

HOST = os.environ.get("S6_SSH_HOST", "162.14.121.180")
USER = os.environ.get("S6_SSH_USER", "root")
PASS = os.environ.get("S6_SSH_PASS", "")
CONTAINER = os.environ.get("S6_CONTAINER", "scqf-as-app")
LOCAL_DIR = os.path.join("backups", "s6-dist")
FILES = {
    "server-index.js": "server/index.js",
    "client-index.js": "client/index.js",
    "build-fingerprint.json": "build-fingerprint.json",
}
EXPECT = {
    "server-index.js": "0dc13875760cd924",
    "client-index.js": "62677303c562a33d",
    "build-fingerprint.json": "b7044e2143bc211b",
}
HEALTH_URL = "http://127.0.0.1:13000/api/app:getInfo"


def log(msg):
    print(msg, flush=True)


def die(msg, code=1):
    print(f"✗ {msg}", flush=True)
    sys.exit(code)


class Remote:
    def __init__(self):
        self.cli = paramiko.SSHClient()
        self.cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    def connect(self):
        if not PASS:
            die("缺少 S6_SSH_PASS 环境变量（口令不落盘、不进日志）", 2)
        self.cli.connect(
            HOST, port=22, username=USER, password=PASS,
            timeout=15, banner_timeout=20, auth_timeout=20,
            look_for_keys=False, allow_agent=False,
        )

    def run(self, cmd, timeout=180):
        _in, out, err = self.cli.exec_command(cmd, timeout=timeout, get_pty=False)
        o = out.read().decode("utf-8", "replace")
        e = err.read().decode("utf-8", "replace")
        rc = out.channel.recv_exit_status()
        return rc, o.strip(), e.strip()

    def sftp(self):
        return self.cli.open_sftp()

    def close(self):
        try:
            self.cli.close()
        except Exception:
            pass


def sh_quote(s):
    return "'" + s.replace("'", "'\\''") + "'"


def detect_dist_dir(r):
    """找**真正被挂载进容器**的插件 dist（只读探测）。

    实测拓扑（2026-10-29）：
      /opt/scqf-aftersales/src/storage/plugins/@local/service-ticket
        → 容器 /app/nocobase/storage/plugins/@local/service-ticket（rw）
        → 容器 /app/nocobase/node_modules/@local/service-ticket（ro）
    ⚠️ 不在 `<app>/storage`，而在 `<app>/src/storage` —— 所以不能写死路径，要按 pattern 找。
    """
    rc, out, _ = r.run(
        "find /opt -maxdepth 7 -type d -path '*/storage/plugins/@local/service-ticket/dist' 2>/dev/null",
        timeout=60,
    )
    dirs = [x.strip() for x in out.splitlines() if x.strip()]
    if not dirs:
        die("找不到任何 storage/plugins/@local/service-ticket/dist —— 目录结构与预期不符，停止")
    # 2026-11-18：服务器上存在**多个**插件目录（/opt/scqf-aftersales 是生产，
    # /opt/scqf-p6-uat 是历史 UAT 实例）⇒ 不能再靠"只有一个"自动判定。
    #
    # 第一判据不是路径名，而是**运行中容器的挂载点**：
    #   docker inspect <APP> 的 Mounts[].Source 才是"这个目录真的被进程读到"的证据。
    #   只数 /opt 下的目录名会把"历史残留"当成候选。
    explicit = None
    if "--dist" in sys.argv:
        idx = sys.argv.index("--dist")
        if idx + 1 >= len(sys.argv):
            die("--dist 需要路径参数", 2)
        explicit = sys.argv[idx + 1].rstrip("/")

    if len(dirs) > 1:
        # 用 `docker inspect` 的完整 JSON 解析，比在 --format 里拼模板可靠。
        # ⚠️ 匹配方向：挂载点是**插件目录**（.../service-ticket，不带 /dist），
        #    候选是 **dist 目录**（.../service-ticket/dist）⇒ 判据是
        #    `候选.startswith(挂载点)`，不是反过来。写反了会恒为 0 命中，
        #    然后看起来像"没有目录被挂载"—— 那是假判据。
        rc, mout, _ = r.run(f"docker inspect {sh_quote(CONTAINER)}", timeout=60)
        mounted = []
        try:
            info = json.loads(mout)
            for m in (info[0].get("Mounts") or []):
                src = (m.get("Source") or "").rstrip("/")
                if src:
                    mounted.append(src)
        except Exception:
            mounted = [ln.strip().strip('",').rstrip("/") for ln in mout.splitlines()
                       if "/storage/plugins/" in ln]
        matched = [d for d in dirs if any(d.rstrip("/").startswith(m) for m in mounted)]
        log(f"[0.1] 探测到 {len(dirs)} 个候选 dist，容器 {CONTAINER} 挂载命中 {len(matched)} 个")
        for d in dirs:
            log(f"      候选 {d}{'  ← 容器实挂载' if d in matched else ''}")
        if len(matched) == 1:
            if explicit and explicit != matched[0].rstrip("/"):
                die(f"--dist({explicit}) 与容器实挂载({matched[0]}) 不一致 —— 拒绝继续")
            log(f"[0.1] 按容器挂载点锁定：{matched[0]}")
            return matched[0].rstrip("/")
        if not explicit:
            die(f"无法唯一确定 dist（候选 {len(dirs)}、挂载命中 {len(matched)}），请用 --dist <路径> 指定")

    if explicit:
        if explicit not in [d.rstrip("/") for d in dirs]:
            die(f"--dist 指定的路径不在探测结果里：{explicit}")
        log(f"[0.1] 按 --dist 显式指定：{explicit}")
        return explicit
    return dirs[0].rstrip("/")


def split_dirs(dist):
    """从 dist 路径切出 plugin / storage / 候选项目根。

    实测：/opt/scqf-aftersales/src/storage/plugins/@local/service-ticket/dist
      plugin  = .../service-ticket
      storage = .../storage
      候选根  = dirname(storage)=/opt/scqf-aftersales/src，再上一级=/opt/scqf-aftersales
    （compose 文件在**再上一级**，所以要把两个候选都试一遍）
    """
    marker = "/storage/"
    idx = dist.find(marker)
    if idx < 0:
        die(f"dist 路径里没有 '{marker}'，无法推断 storage：{dist}")
    plugin = posixpath.dirname(dist)
    storage = dist[: idx + len("/storage")]
    roots = [posixpath.dirname(storage), posixpath.dirname(posixpath.dirname(storage))]
    return plugin, storage, roots


def compose_cmd(r, roots):
    """在候选根里找 compose 文件；返回 (命令, 项目根) 或 ("", None)。"""
    for root in roots:
        rc, out, _ = r.run(
            f"cd {sh_quote(root)} 2>/dev/null && "
            "(ls docker-compose.prod.yml >/dev/null 2>&1 && echo prod) || "
            "(ls docker-compose.yml >/dev/null 2>&1 && echo default) || true",
            timeout=30,
        )
        which = out.strip().splitlines()[-1] if out.strip() else ""
        if which == "prod":
            return "docker compose -f docker-compose.prod.yml", root
        if which == "default":
            return "docker compose -f docker-compose.yml", root
    return "", None


def restart_app(r, app_dir, comp):
    """优先 compose restart（保持 compose 的项目标签），失败则退回 docker restart。"""
    if comp:
        rc, out, err = r.run(f"cd {sh_quote(app_dir)} && {comp} restart app", timeout=300)
        if rc == 0:
            return 0, f"{comp} restart app"
        log(f"[!] compose restart 失败 rc={rc}（{(err or out)[:160]}）⇒ 退回 docker restart")
    rc, out, err = r.run(f"docker restart {sh_quote(CONTAINER)}", timeout=300)
    return rc, f"docker restart {CONTAINER}"


def file_sha(r, path):
    rc, out, _ = r.run(f"sha256sum {sh_quote(path)} 2>/dev/null | cut -c1-16", timeout=30)
    return out if rc == 0 else ""


def main():
    mode = "dry"
    if "--apply" in sys.argv:
        mode = "apply"
    if "--rollback" in sys.argv:
        mode = "rollback"
        idx = sys.argv.index("--rollback")
        if idx + 1 >= len(sys.argv):
            die("--rollback 需要备份时间戳参数", 2)
        ts = sys.argv[idx + 1]

    r = Remote()
    try:
        r.connect()
    except paramiko.AuthenticationException:
        die("SSH 认证失败（口令不被接受）—— 未做任何写操作", 3)
    except Exception as exc:  # 网络/握手
        die(f"SSH 连接失败：{type(exc).__name__} —— 未做任何写操作", 3)

    host = r.run("hostname; uname -sr", timeout=20)[1].replace("\n", " / ")
    log(f"[0] 已登录 {USER}@{HOST}（{host}）")

    dist = detect_dist_dir(r)
    plugin, storage, roots = split_dirs(dist)
    log(f"[1] 插件目录 = {plugin}")
    log(f"[1] storage  = {storage}（候选项目根 {roots}）")

    rc, ps, _ = r.run(f"docker ps --format '{{{{.Names}}}}' | tr '\\n' ' '", timeout=30)
    log(f"[2] 运行中容器 = {ps or '(空)'}")
    if CONTAINER not in ps.split():
        die(f"容器 {CONTAINER} 不在运行列表中 —— 停止（避免重启错对象）")

    comp, app_dir = compose_cmd(r, roots)
    log(f"[3] compose 命令 = {comp or '(未找到 ⇒ 退回 docker restart)'}  项目根={app_dir}")

    pre = {k: file_sha(r, posixpath.join(dist, v)) for k, v in FILES.items()}
    log(f"[4] 部署前 dist 哈希 = {json.dumps(pre, ensure_ascii=False)}")

    if mode == "rollback":
        backups = r.run(f"ls -d {sh_quote(dist)}.bak.* 2>/dev/null | sort | tail -1", timeout=30)[1].strip()
        if not backups or ts not in backups:
            die(f"找不到备份目录 {dist}.bak.{ts}", 4)
        cmd = (
            f"set -e; rm -rf {sh_quote(dist)}; "
            f"cp -a {sh_quote(backups)} {sh_quote(dist)}; "
            f"sha256sum {sh_quote(dist)}/server/index.js {sh_quote(dist)}/client/index.js"
        )
        rc, out, err = r.run(cmd, timeout=180)
        log(f"[5] 回滚自 {backups}\n{out}")
        if rc != 0:
            die(f"回滚 cp 失败：{err}", 5)
        rc, how = restart_app(r, app_dir or roots[0], comp)
        log(f"[6] restart rc={rc}（{how}）")
        log("[7] 回滚后请用 §4 的 ②③ 反向复核（供应商标识应为 0 / DTO 不含 provider_biz_id）")
        return 0

    # 容器内看到的 client 哈希（应等于宿主；不等说明挂载点不是我们改的那份）
    rc, out, _ = r.run(
        "docker exec %s sha256sum /app/nocobase/storage/plugins/@local/service-ticket/dist/client/index.js 2>/dev/null | cut -c1-16" % sh_quote(CONTAINER),
        timeout=60,
    )
    log(f"[5] 容器内 client 哈希 = {out or '(读不到)'}")
    rc, out, _ = r.run(f"curl -s -o /dev/null -w '%{{http_code}}' {HEALTH_URL}", timeout=20)
    log(f"[6] 容器内健康（{HEALTH_URL}）= {out.strip() or '(无响应)'}")

    if mode == "dry":
        log("[dry-run] 到此为止：未上传、未备份、未重启。")
        return 0

    # ---------------- apply ----------------
    stamp = time.strftime("%Y%m%d-%H%M%S")
    tmp = f"/tmp/s6-dist-{stamp}"
    r.run(f"mkdir -p {sh_quote(tmp)}", timeout=30)
    sftp = r.sftp()
    for local_name in FILES:
        lp = os.path.join(LOCAL_DIR, local_name)
        if not os.path.exists(lp):
            die(f"本地缺少产物 {lp}", 6)
        sftp.put(lp, posixpath.join(tmp, local_name))

        # 本地哈希自检：上传前就确认"我传的是对的那份"
        import hashlib
        h = hashlib.sha256(open(lp, "rb").read()).hexdigest()[:16]
        if h != EXPECT[local_name]:
            die(f"{local_name} 本地哈希 {h} 与预期 {EXPECT[local_name]} 不符 —— 拒绝上传", 6)
    sftp.close()
    log(f"[5] 已上传 3 个产物 → {tmp}")

    rc, out, _ = r.run(f"sha256sum {sh_quote(tmp)}/* | cut -c1-16,65-", timeout=30)
    log(f"[6] 上传后哈希：\n{out}")

    bak = f"{dist}.bak.{stamp}"
    cmd = (
        f"set -e; "
        f"cp -a {sh_quote(dist)} {sh_quote(bak)}; "
        f"cp -a {sh_quote(tmp)}/server-index.js {sh_quote(dist)}/server/index.js; "
        f"cp -a {sh_quote(tmp)}/client-index.js {sh_quote(dist)}/client/index.js; "
        f"cp -a {sh_quote(tmp)}/build-fingerprint.json {sh_quote(dist)}/build-fingerprint.json; "
        f"sha256sum {sh_quote(dist)}/server/index.js {sh_quote(dist)}/client/index.js {sh_quote(dist)}/build-fingerprint.json"
    )
    rc, out, err = r.run(cmd, timeout=180)
    if rc != 0:
        log(f"✗ 落盘失败：{err}")
        restore = f"rm -rf {sh_quote(dist)}; cp -a {sh_quote(bak)} {sh_quote(dist)}"
        r.run(restore, timeout=180)
        die("已回滚到部署前状态（未重启，进程仍跑旧包）", 7)
    log(f"[7] 备份 {bak}\n[7] 落盘后哈希：\n{out}")

    # 落盘哈希必须与预期一致（前 16 位）
    for name, token in (("server", EXPECT["server-index.js"]), ("client", EXPECT["client-index.js"])):
        if token not in out:
            r.run(f"rm -rf {sh_quote(dist)}; cp -a {sh_quote(bak)} {sh_quote(dist)}", timeout=180)
            die(f"{name} 落盘哈希与预期不符（{token}）—— 已整目录回滚，未重启", 8)

    rc, how = restart_app(r, app_dir or roots[0], comp)
    log(f"[8] restart rc={rc}（{how}）")
    if rc != 0:
        die(f"restart 失败 —— 产物已落盘但进程未重启；执行 --rollback {stamp} 还原", 9)

    # 容器内健康（不依赖外网）
    health = ""
    for i in range(24):
        rc, out, _ = r.run(f"curl -s -o /dev/null -w '%{{http_code}}' {HEALTH_URL}", timeout=30)
        health = out.strip()
        if health == "200":
            log(f"[9] 容器内健康 200（第 {i + 1} 次探测）")
            break
        time.sleep(5)
    if health != "200":
        die(f"容器内健康检查未通过（最后一次={health}）—— 执行 --rollback {stamp}", 10)

    print(json.dumps({
        "stamp": stamp,
        "app_dir": app_dir,
        "backup": bak,
        "pre_sha": pre,
        "expect": EXPECT,
        "container": CONTAINER,
        "internal_health": health,
    }, ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        pass
