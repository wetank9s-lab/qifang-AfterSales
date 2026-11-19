"""nginx-merge-3blocks.py —— 按块合并生产 Nginx（只动 3 处，其余一律保持生产原样）

上下文（2026-11-06 实测）：
  生产 vhost = /www/server/panel/vhost/nginx/sh.scqfls.cn.conf，**280 行独立文件**
  仓库       = nginx/conf.d/service.conf，**1002 行**（结构完全不同，整文件覆盖会毁站）

三处待合并（缺了会导致短链 404 / 接口 404）：
  A. `location ~ "^/p/(?<svc_progress_token>[A-Za-z0-9_-]{22}(?:[A-Za-z0-9_-]{21})?)$"`
     —— 生产**已有**，原样保留（用户的第 5 条要求：保留生产已有的 /p/ 正则修复）
  B. `location ~ "^/p/t/(?<svc_short_code>[A-Za-z0-9_-]{22})$"` + `location /p/t/ { 404 }`
     —— 生产**没有**，插到 `/p/` 块之前
  C. `location /` 里 6 条 `{22}` → `?code=` 的 rewrite
     —— 生产**没有**，插到现有 6 条 `{43}` rewrite 之后

安全约束：
  · 每处插入都先断言"锚点唯一命中"，命中数 ≠ 1 直接停（不猜）；
  · 已存在则不重复插入（幂等，可重跑）；
  · 写前备份、`nginx -t` 失败即还原、成功才 reload；
  · 只改这一个文件，不碰其它站点。

用法：
    python scripts/nginx-merge-3blocks.py --check    # 只读：报告会插入几处
    python scripts/nginx-merge-3blocks.py --apply    # 执行
"""
import os
import subprocess
import sys
import time

import paramiko

HOST = os.environ.get("S6_SSH_HOST", "162.14.121.180")
USER = os.environ.get("S6_SSH_USER", "root")
KEY = os.environ.get("S6_SSH_KEY", os.path.join(os.path.expanduser("~"), ".ssh", "id_ed25519"))
PROD_CONF = "/www/server/panel/vhost/nginx/sh.scqfls.cn.conf"

# ------------------------------------------------------------------ 片段 B
BLOCK_PT = """    # ================== 师傅短信短链 /p/t/{code}（BE-03-SMS-TEMPLATE-02）======
    # `/p/t/{22}` —— 22 位短码，与客户进度 `/p/{token}` **靠路径段数区分**：
    #   · `/p/{22}`   → 客户进度页（下面那条，已保留生产原样）
    #   · `/p/t/{22}` → 师傅作业页
    # ⚠️ `/p/` 的正则要求 `[A-Za-z0-9_-]` 一直到结尾，`t/` 里的 `/` 不匹配 ⇒ 两者不会互相误吃。
    # ⚠️ 与 `/t/` 同构：302（禁 301）、`absolute_redirect off`（否则 Location 用 server_name
    #    拼绝对地址，会丢协议/端口）。短码是凭据 ⇒ 落访问日志等于把凭证写进磁盘。
    location ~ "^/p/t/(?<svc_short_code>[A-Za-z0-9_-]{22})$" {
        access_log off;
        absolute_redirect off;
        return 302 /h5/technician/visit/$svc_short_code;
    }
    # 畸形短链兜底：**不用 `^~`**（那会让合法短码也被前缀接走）。
    location /p/t/ {
        access_log off;
        return 404;
    }

"""

# ------------------------------------------------------------------ 片段 C
BLOCK_CODE_REWRITES = """
        # 🔴 BE-03-SMS-TEMPLATE-02：短码（22 位）走同一组接口、同一套授权判定。
        #    与上面 6 条 `{43}` 一一对应，只差长度与 query 参数名（`code` 而非 `token`）。
        #    服务端 `_auth.ts` 先按长度分派，再分别调 verify / verifyByCode
        #    —— 短码不是"另一条更宽松的路"。长度必须与 TECHNICIAN_SHORT_CODE.LENGTH 一致。
        #    ⚠️ 末尾 `?` 抑制原 query 被追加（与上面 `{43}` 的写法保持一致）。
        rewrite "^/api/technician/visits/([A-Za-z0-9_-]{22})/media/([A-Za-z0-9_-]{22})$"  /api/technicianVisit:media?code=$1&ref=$2? break;
        rewrite "^/api/technician/visits/([A-Za-z0-9_-]{22})/photos/([A-Za-z0-9_-]{22})/delete$" /api/technicianVisit:deletePhoto?code=$1&ref=$2? break;
        rewrite "^/api/technician/visits/([A-Za-z0-9_-]{22})/photos/([A-Za-z0-9_-]{22})$"  /api/technicianVisit:photo?code=$1&ref=$2? break;
        rewrite "^/api/technician/visits/([A-Za-z0-9_-]{22})/files$"                     /api/technicianVisit:upload?code=$1?       break;
        rewrite "^/api/technician/visits/([A-Za-z0-9_-]{22})/submit$"                    /api/technicianVisit:submit?code=$1?       break;
        rewrite "^/api/technician/visits/([A-Za-z0-9_-]{22})$"                           /api/technicianVisit:get?code=$1?          break;
"""

# 锚点：片段 C 插在这条之后（生产里唯一一条 43 位裸 token 的 rewrite）
ANCHOR_C = '        rewrite "^/api/technician/visits/([A-Za-z0-9_-]{43})$"'
# 锚点：片段 B 插在这条之前（/p/ 的 302 正则 location，生产已修好）
ANCHOR_B = '    location ~ "^/p/(?<svc_progress_token>[A-Za-z0-9_-]{22}(?:[A-Za-z0-9_-]{21})?)$"'


def log(m):
    print(m, flush=True)


def die(m, c=1):
    print("✗ %s" % m, flush=True)
    sys.exit(c)


def shq(s):
    return "'" + s.replace("'", "'\\''") + "'"


def connect():
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(HOST, port=22, username=USER, key_filename=KEY,
                timeout=15, banner_timeout=20, auth_timeout=20,
                look_for_keys=True, allow_agent=False)
    return cli


def run(cli, cmd, timeout=180):
    _i, out, err = cli.exec_command(cmd, timeout=timeout)
    o = out.read().decode("utf-8", "replace")
    e = err.read().decode("utf-8", "replace")
    return out.channel.recv_exit_status(), o, e


def merge(text):
    """返回 (新文本, 变更清单)。幂等：已存在则跳过。"""
    changes = []

    # ---- B: /p/t/ 短链 ----
    if 'location ~ "^/p/t/' in text:
        changes.append("B /p/t/ 已存在，跳过")
    else:
        n = text.count(ANCHOR_B)
        if n != 1:
            die("锚点 B（/p/ 正则 location）命中 %d 次，应恰好 1 次 —— 停止，不猜" % n, 10)
        text = text.replace(ANCHOR_B, BLOCK_PT + ANCHOR_B, 1)
        changes.append("B /p/t/ 已插入（在 /p/ 之前）")

    # ---- C: 6 条 ?code= rewrite ----
    if "/api/technicianVisit:get?code=" in text:
        changes.append("C 短码 rewrite 已存在，跳过")
    else:
        idx = text.find(ANCHOR_C)
        if idx < 0:
            die("锚点 C（43 位裸 token rewrite）未找到 —— 停止", 11)
        if text.count(ANCHOR_C) != 1:
            die("锚点 C 命中次数 ≠ 1 —— 停止", 11)
        eol = text.index("\n", idx)
        text = text[: eol + 1] + BLOCK_CODE_REWRITES + text[eol + 1:]
        changes.append("C 6 条 ?code= rewrite 已插入")

    # ---- A: /p/ 正则必须是生产现有版本（22 + 可选 21），不能被降级 ----
    if ANCHOR_B in text:
        changes.append("A /p/ 双长度正则保持生产原样（未改）")
    else:
        die("A 生产 /p/ 双长度正则丢失 —— 停止（这与'保留生产修复'相反）", 12)

    return text, changes


def main():
    apply = "--apply" in sys.argv
    cli = connect()
    rc, o, _ = run(cli, "hostname; docker ps --format '{{.Names}}' | tr '\\n' ' '")
    log("[0] %s" % o.replace("\n", " / "))

    sftp = cli.open_sftp()
    with sftp.open(PROD_CONF, "r") as f:
        raw = f.read().decode("utf-8", "replace")
    log("[1] 生产配置 %s：%d 行" % (PROD_CONF, raw.count("\n") + 1))

    new_text, changes = merge(raw)
    log("[2] 合并计划：")
    for c in changes:
        log("    · %s" % c)

    if new_text == raw:
        log("[3] 无需变更（已是最新），结束。")
        cli.close()
        return 0

    if not apply:
        log("[dry] 未写入。用 --apply 执行。")
        cli.close()
        return 0

    stamp = time.strftime("%Y%m%d-%H%M%S")
    bak = PROD_CONF + ".bak.deploy-" + stamp
    rc, o, e = run(cli, "cp -a %s %s && ls -l %s" % (shq(PROD_CONF), shq(bak), shq(bak)))
    log("[4] 备份 → %s" % (o.strip() or e.strip()))

    tmp = "/tmp/nginx-merge-%s.conf" % stamp
    with sftp.open(tmp, "w") as f:
        f.write(new_text)
    sftp.close()

    rc, o, e = run(cli, "cp -a %s %s && wc -l %s" % (shq(tmp), shq(PROD_CONF), shq(PROD_CONF)))
    log("[5] 写入完成：%s" % (o.strip() or e.strip()))

    rc, o, e = run(cli, "nginx -t 2>&1", 120)
    log("[6] nginx -t：\n%s" % (o or e))
    if rc != 0 or "successful" not in (o + e):
        run(cli, "cp -a %s %s" % (shq(bak), shq(PROD_CONF)))
        die("nginx -t 失败 ⇒ 已还原配置，未 reload", 20)

    rc, o, e = run(cli, "systemctl reload nginx && systemctl is-active nginx", 120)
    log("[7] reload：%s" % (o.strip() or e.strip()))
    if "active" not in o:
        run(cli, "cp -a %s %s && systemctl reload nginx" % (shq(bak), shq(PROD_CONF)))
        die("reload 后 nginx 未 active ⇒ 已还原", 21)

    log("[8] 完成。备份 = %s" % bak)
    cli.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
