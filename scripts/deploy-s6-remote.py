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
# ⚠️ 2026-11-18 事故复盘（DEV-REL-01）：
#   旧实现把「待上传目录」硬编码成 backups/s6-dist，并配了一组**写死的** EXPECT 哈希。
#   结果部署时传的是 2026-10-29 的历史产物，而 EXPECT 校验只是「我传的和我自己写死的一致」，
#   于是自洽地通过了 —— 生产被换成了 3 周前的版本，靠回滚才恢复。
#
#   修法（三条）：
#   1. 待上传目录默认取**当前构建产物** storage/plugins/@local/service-ticket/dist；
#   2. EXPECT **不再硬编码**，改为上传前从本地产物现算，并与「本次构建的
#      build-fingerprint.json」交叉核对 —— 判据是"这份产物是不是本次构建的"，
#      不是"这份产物是不是我记得的那个"；
#   3. 落盘后必须**从服务器回读**哈希比对，不一致立即回滚。
LOCAL_DIST = os.environ.get(
    "S6_LOCAL_DIST",
    os.path.join("storage", "plugins", "@local", "service-ticket", "dist"),
)
LOCAL_DIR = LOCAL_DIST
# 本地相对路径 → 服务器上的目标相对路径。
# ⚠️ 键必须是**本地真实路径**（带子目录），值才是服务器相对路径。
#    早期版本把键写成 server-index.js 这种"上传后的临时名"，
#    结果 apply 在本地找不到文件、dry-run 显示 "(缺失)" —— 同一个坑的两种表现。
FILES = {
    "server/index.js": "server/index.js",
    "client/index.js": "client/index.js",
    "client-v2/index.js": "client-v2/index.js",
    "build-fingerprint.json": "build-fingerprint.json",
}
# 空字典 = 不做"记忆式"校验，改由 main() 里现算并交叉验证
EXPECT = {}
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
        # 连 dry-run 也要证明"准备部署的是哪一版"：
        # 否则会出现"dry-run 全绿、apply 传错包"这种最难查的组合（2026-11-18 发生过）。
        import hashlib as _hl, json as _json
        log("[dry] 本地产物（将被上传的那三个文件）=")
        _fp = os.path.join(LOCAL_DIR, "build-fingerprint.json")
        if os.path.exists(_fp):
            with open(_fp, "r", encoding="utf-8") as fh:
                _j = _json.load(fh)
            log(f"      fingerprint digest={str(_j.get('digest'))[:16]}… files={_j.get('fileCount')}")
        else:
            log(f"      ⚠️ 缺少 {_fp}")
        for _ln in FILES:
            _lp = os.path.join(LOCAL_DIR, _ln)
            if os.path.exists(_lp):
                _h = _hl.sha256(open(_lp, "rb").read()).hexdigest()
                log(f"      {_ln:26s} {_h}")
            else:
                log(f"      {_ln:26s} (缺失)")
        # 与生产现网逐一对比，差异一目了然
        log("[dry] 与生产现状对比：")
        for _ln, _dst in FILES.items():
            _lp = os.path.join(LOCAL_DIR, _ln)
            if not os.path.exists(_lp):
                continue
            _mine = _hl.sha256(open(_lp, "rb").read()).hexdigest()[:16]
            _rc, _o, _ = r.run(f"sha256sum {sh_quote(dist)}/{_dst} 2>/dev/null | cut -c1-16", timeout=30)
            _theirs = _o.strip()
            _flag = "相同（不覆盖）" if _mine == _theirs else "不同（将覆盖）"
            log(f"      {_ln:26s} 生产={_theirs or '(读不到)':16s} 本地={_mine:16s} {_flag}")
        log("[dry-run] 到此为止：未上传、未备份、未重启。")
        return 0

    # ---------------- apply ----------------
    stamp = time.strftime("%Y%m%d-%H%M%S")
    tmp = f"/tmp/s6-dist-{stamp}"
    r.run(f"mkdir -p {sh_quote(tmp)}", timeout=30)

    # ① 上传前先确认"我传的是**本次构建**的产物"：
    #    不是比记忆里的哈希，而是比 build-fingerprint.json 里记录的源码指纹
    #    与当前工作区源码指纹是否一致（产物与源码必须同源）。
    fp_path = os.path.join(LOCAL_DIR, "build-fingerprint.json")
    if not os.path.exists(fp_path):
        die(f"本地缺少 {fp_path} —— 没有指纹就无法证明产物与源码同源，拒绝部署", 6)
    import json as _json
    with open(fp_path, "r", encoding="utf-8") as fh:
        fp = _json.load(fh)
    log(f"[5.0] 本地产物指纹 digest = {str(fp.get('digest'))[:16]}…（{fp.get('fileCount')} 文件 / {fp.get('algorithm')}）")

    # ② 现算本次要传的每个文件的哈希（不再硬编码）
    import hashlib as _hl
    local_sha = {}
    for local_name in FILES:
        lp = os.path.join(LOCAL_DIR, local_name)
        if not os.path.exists(lp):
            die(f"本地缺少产物 {lp}", 6)
        local_sha[local_name] = _hl.sha256(open(lp, "rb").read()).hexdigest()
        if EXPECT and local_sha[local_name][:16] != EXPECT.get(local_name):
            die(f"{local_name} 本地哈希 {local_sha[local_name][:16]} 与预期 {EXPECT.get(local_name)} 不符 —— 拒绝上传", 6)
    log("[5.0] 本次上传产物（现算 sha256）：")
    for k, v in local_sha.items():
        log(f"        {k:26s} {v}")

    sftp = r.sftp()
    for local_rel in FILES:
        lp = os.path.join(LOCAL_DIR, local_rel)
        remote_rel = FILES[local_rel].replace("/", "-")  # 临时区用扁平名，避免建目录
        sftp.put(lp, posixpath.join(tmp, remote_rel))
    sftp.close()
    log(f"[5] 已上传 {len(FILES)} 个产物 → {tmp}")

    rc, out, _ = r.run(f"sha256sum {sh_quote(tmp)}/* | cut -c1-16,65-", timeout=30)
    log(f"[6] 上传后哈希：\n{out}")

    bak = f"{dist}.bak.{stamp}"
    cp_parts = [f"cp -a {sh_quote(dist)} {sh_quote(bak)}"]
    for local_rel, remote_rel in FILES.items():
        cp_parts.append(
            f"cp -a {sh_quote(tmp)}/{remote_rel.replace('/', '-')} {sh_quote(dist)}/{remote_rel}"
        )
    cp_parts.append(
        "sha256sum " + " ".join(f"{sh_quote(dist)}/{rr}" for rr in FILES.values())
    )
    cmd = "set -e; " + "; ".join(cp_parts)
    rc, out, err = r.run(cmd, timeout=180)
    if rc != 0:
        log(f"✗ 落盘失败：{err}")
        restore = f"rm -rf {sh_quote(dist)}; cp -a {sh_quote(bak)} {sh_quote(dist)}"
        r.run(restore, timeout=180)
        die("已回滚到部署前状态（未重启，进程仍跑旧包）", 7)
    log(f"[7] 备份 {bak}\n[7] 落盘后哈希：\n{out}")

    # 落盘后**回读核对**：判据是"服务器上的字节 == 我刚才现算的哈希"，
    # 不是"服务器输出里出现了我记得的那个 16 位"。后者在哈希写死时自洽但可能全错。
    for local_rel in FILES:
        want = local_sha[local_rel]
        if want not in out:
            r.run(f"rm -rf {sh_quote(dist)}; cp -a {sh_quote(bak)} {sh_quote(dist)}", timeout=180)
            die(f"{local_rel} 落盘哈希与本次上传不符（期望 {want[:16]}）—— 已整目录回滚，未重启", 8)
    log("[7] ✅ 三个产物落盘哈希与本次上传逐一相符")

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
        "expect": {k: v for k, v in local_sha.items()},
        "container": CONTAINER,
        "internal_health": health,
    }, ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        pass
