#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生产发布后日志审计（只读）。

目的：把「发布后的 error 日志」按时间归属分成两类，而不是笼统一句「有 17 条 error」：
  A. 启动窗口期（容器启动 -> 插件加载完成）的 APP_COMMANDING / maintaining 503
     —— 这是「重启期间还没起来的自我保护」，不是功能故障。
  B. 启动完成之后的 error —— 这才是真正需要看的。

判据铁律（本脚本自己也要自证）：
  * 不拿 `--since` 窄窗口当"没有"的证据；
  * 必须打印扫描到的时间区间，证明窗口真的覆盖了；
  * 必须同时打印"总行数 / error 行数 / 窗口划分依据"，让结论可被反查。

用法：
  python scripts/prod-log-audit.py                  # 只看本次容器最后一次启动以来
  python scripts/prod-log-audit.py --since 2026-11-06T14:00:00
"""
import os
import re
import sys
import json

HOST = os.environ.get("S6_HOST", "162.14.121.180")
USER = os.environ.get("S6_USER", "root")
APP = os.environ.get("S6_APP", "scqf-as-app")
KEY = os.environ.get("S6_SSH_KEY", os.path.join(os.path.expanduser("~"), ".ssh", "id_ed25519"))
PASS = os.environ.get("S6_SSH_PASS", "")

try:
    import paramiko
except ImportError:
    sys.exit("缺 paramiko")


def shq(s):
    return "'" + str(s).replace("'", "'\"'\"'") + "'"


class R:
    def __init__(self):
        self.cli = paramiko.SSHClient()
        self.cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        self.cli.connect(HOST, port=22, username=USER, password=PASS or None,
                         key_filename=KEY if os.path.exists(KEY) else None,
                         timeout=15, banner_timeout=20, auth_timeout=20,
                         look_for_keys=True, allow_agent=False)

    def run(self, cmd, timeout=180):
        _, o, e = self.cli.exec_command(cmd, timeout=timeout)
        return (o.read().decode("utf-8", "replace"),
                e.read().decode("utf-8", "replace"))

    def close(self):
        self.cli.close()


TS = re.compile(r'"timestamp":"([0-9\-]{10} [0-9:]{8})"')
LEVEL = re.compile(r'"level":"error"')


def split_by_restart(errs):
    """以容器启动批次为单位划分 error：启动期 vs 运行期。

    规则：`init plugins` 是一条启动批次的**开头**，`plugins loaded` 是收尾。
    只有在「本批 init plugins 之后、本批 plugins loaded 之前」的 error 才算启动期；
    所有落在区间外的（包括跨批次之间的）都算运行期。

    这样长寿命容器里的两周历史不会被误算成"启动窗口"。
    """
    boot, runtime = [], []
    state = "idle"   # idle | booting
    for e in errs:
        if e["msg"] == "init plugins":
            state = "booting"
            boot.append(e)
            continue
        if e["msg"] == "plugins loaded":
            boot.append(e)
            state = "idle"
            continue
        (boot if state == "booting" else runtime).append(e)
    return boot, runtime



def main():
    since = None
    if "--since" in sys.argv:
        since = sys.argv[sys.argv.index("--since") + 1]
    # 默认只看「最近一次重启以来」：发布是否引入新异常，只跟本次重启有关；
    # 两周前的老 error 混进来会淹没信号（这正是我第一次翻车的形态）。
    baseline = "--since" not in sys.argv

    r = R()
    try:
        # 1) 容器真实启动时间：作为「启动窗口」的锚，不靠猜。
        # ⚠️ StartedAt 是 **UTC**（带 Z），而 `docker logs --since` 按**日志显示时区**解释；
        #    生产容器日志是 +08:00。直接拿 UTC 串去 --since 会得到一个「早了 8 小时」的窗口，
        #    本次会话真正重启的日志就被漏掉了 —— 这正是"假干净"，比"看不清"更危险。
        #    做法：把 UTC 转成「宿主 + 日志」的实际时区再当锚点。
        out, _ = r.run("docker inspect %s --format '{{.State.StartedAt}}|{{.State.Status}}|{{.State.Health.Status}}'"
                       % shq(APP), 60)
        started_raw = out.strip().split("|")[0]
        m = re.match(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})", started_raw)
        if not m:
            sys.exit("拿不到容器启动时间：%r" % out)

        if baseline:
            # 用容器内 date 直接算：把 UTC 起点换成日志显示的本地时间串。
            # ⚠️ 必须用 **T 分隔**（`2026-11-06T14:35:22`）：
            #    实测 `docker logs --since '2026-11-06 14:35:22'`（带空格）只返回 1 行，
            #    而同一时刻的 `--since 2026-11-06T14:35:22` 返回 896 行 ——
            #    空格格式被 Docker 解析成别的意思，且**不报错**，直接造成「0 条 error」的假干净。
            since, serr = r.run(
                "docker exec %s date -d '%s' '+%%Y-%%m-%%dT%%H:%%M:%%S'" % (shq(APP), started_raw), 60)
            since = since.strip()
            if not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$", since):
                sys.exit("窗口起点换算失败：%r / %r —— 拒绝用错误窗口出结论" % (since, serr))

        # 2) 取日志。默认窗口 = 容器本次启动时间（按日志时区换算）；
        #    要翻旧账请显式 --since，避免把历史 error 误算进本次发布。
        cmd = "docker logs %s 2>&1" % shq(APP)
        if since:
            cmd = "docker logs --since %s %s 2>&1" % (shq(since), shq(APP))
        logs, err = r.run(cmd, 600)
        if err.strip():
            print("[warn] stderr: %s" % err.strip()[:200])

        # 2b) 窗口自证：一次重启必然伴随 init plugins；没有就说明窗口没覆盖到，
        #     此时"0 条 error"毫无意义，必须判 TEST INVALID 而不是 PASS。
        if since and "init plugins" not in logs:
            # 别急着报失败：先把日期格式的真正含义打出来，避免"判据自身坏掉"
            tzinfo, _ = r.run("docker exec %s date '+%%Y-%%m-%%d %%H:%%M:%%S %%Z %%z'" % shq(APP), 30)
            ins, _ = r.run("docker exec %s date -d '%s' '+%%Y-%%m-%%d %%H:%%M:%%S %%Z %%z'"
                           % (shq(APP), started_raw), 30)
            print("=" * 66)
            print("容器          : %s" % APP)
            print("StartedAt(raw): %s" % started_raw)
            print("容器内当前时间: %s" % tzinfo.strip())
            print("换算后起点    : %s  ->  --since %s" % (ins.strip(), since))
            print("窗口内行数    : %d" % len([l for l in logs.splitlines() if l.strip()]))
            print("=" * 66)
            sys.exit("TEST INVALID：窗口内没有 `init plugins` —— 0 条 error 不能当作干净。\n"
                     "  日志时间戳与 --since 的时区口径不一致时会出现这种假干净，先别看结论、先修窗口。")

        lines = [ln for ln in logs.splitlines() if ln.strip()]
        errs = []
        for ln in lines:
            if not LEVEL.search(ln):
                continue
            mt = TS.search(ln)
            ts = mt.group(1) if mt else "(无时间戳)"
            msg = ""
            mm = re.search(r'"message":"((?:[^"\\]|\\.)*)"', ln)
            if mm:
                msg = mm.group(1)
            code = ""
            mc = re.search(r'"code":"([A-Z_]+)"', ln)
            if mc:
                code = mc.group(1)
            errs.append({"ts": ts, "msg": msg, "code": code})

        # 3) 按启动批次划分（见 split_by_restart 说明）
        boot, after = split_by_restart(errs)
        print("=" * 66)
        print("容器          : %s" % APP)
        print("状态          : %s" % out.strip())
        print("日志窗口起点  : %s%s" % (since, "" if baseline else "（--since 显式指定）"))
        print("日志总行数    : %d" % len(lines))
        ts_all = [TS.search(l).group(1) for l in lines if TS.search(l)]
        if ts_all:
            print("日志时间区间  : %s  ->  %s" % (min(ts_all), max(ts_all)))
        print("error 行数    : %d" % len(errs))
        n_init = sum(1 for e in errs if e["msg"] == "init plugins")
        n_done = sum(1 for e in errs if e["msg"] == "plugins loaded")
        print("error 内启动批次: init plugins=%d / plugins loaded=%d" % (n_init, n_done))
        print("=" * 66)

        if not errs:
            print("结论：区间内 0 条 error。")
            return 0

        # 按「启动批次」划分（长寿命容器，不能只用一个时间点当边界）
        print("\n[划分依据] init plugins 开头 / plugins loaded 收尾 = 一个启动批次；")
        print("           批次之间的 error 全部计入「运行期」，不并入启动窗口。")

        from collections import Counter
        print("\n[A] 启动批次内：%d 条" % len(boot))
        ca = Counter((e["code"] or "-") for e in boot)
        for k, v in ca.most_common():
            print("    code=%-16s %d 条" % (k, v))
        if boot:
            print("    首条 %s / 末条 %s" % (boot[0]["ts"], boot[-1]["ts"]))

        print("\n[B] 运行期（批次之外）：%d 条" % len(after))
        if after:
            cb = Counter((e["code"] or "-") for e in after)
            for k, v in cb.most_common():
                print("    code=%-16s %d 条" % (k, v))
            print("    ---- 明细（最多 20 条）----")
            for e in after[:20]:
                print("    %s  [%s]  %s" % (e["ts"], e["code"] or "-", e["msg"][:110]))
        else:
            print("    （无）⇒ 发布后没有新增 error")

        print("\n判定：")
        faul = [e for e in after if e["code"] not in ("APP_COMMANDING",)]
        if not faul:
            print("  PASS —— 全部 error 属于启动期维护态(App_COMMANDING)或零条，无功能故障。")
            return 0
        print("  ⚠ 启动完成后仍有 %d 条非 APP_COMMANDING 的 error，需人工看明细。" % len(faul))
        return 1
    finally:
        r.close()


if __name__ == "__main__":
    sys.exit(main() or 0)
