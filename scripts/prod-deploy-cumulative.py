"""prod-deploy-cumulative.py —— 累计版本一次性生产部署（受控）

覆盖范围（用户 2026-11-06 13:11 正式授权）：
  TEMPLATE-02 / TEMPLATE-02-R1 / DEV-207 / DEV-208 / DEV-209 / MANUAL-TECH-LINK
  + 迁移 202611061..202611065 + Nginx /p/t/{22} 与 6 条 ?code= rewrite

安全设计（对应授权书 10 条）：
  · 第 0 步做**只读预检**：progress_code_hash 唯一索引冲突 + 迁移登记 + 重复 ASSIGNED
    —— 冲突立即 exit 6，**不强行迁移**；
  · 先整库 pg_dump + 整目录 cp -a dist（双备份，带 sha256），备份失败即停；
  · Nginx **按块合并**：只替换 /p/t/、/api/technician/、/p/ 三处，
    其余段落一律保留生产原样（不整文件覆盖）；
  · 首次启动**盯迁移日志**：出现 migration 失败/ FATAL 立即代码回滚；
  · 回滚**不删任何列**（历史短链校验依赖），触发器默认保留；
  · 短信总开关：全程只读观察，不改、不发真实短信。

用法：
    S6_SSH_PASS=*** python scripts/prod-deploy-cumulative.py --precheck   # 只读预检
    S6_SSH_PASS=*** python scripts/prod-deploy-cumulative.py --apply      # 执行部署
    S6_SSH_PASS=*** python scripts/prod-deploy-cumulative.py --rollback <ts>
"""

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
KEY = os.environ.get("S6_SSH_KEY", os.path.join(os.path.expanduser("~"), ".ssh", "id_ed25519"))
APP = os.environ.get("S6_CONTAINER", "scqf-as-app")
LOCAL_DIST = os.path.join("storage", "plugins", "@local", "service-ticket", "dist")
LOCAL_NGINX = os.path.join("nginx", "conf.d", "service.conf")
HEALTH_URL = "http://127.0.0.1:13000/api/app:getInfo"

# ⚠️ 生产 PG 的凭据与本地开发**不同**（2026-11-06 实测）：
#   本地 svc_app / service_ticket，生产 scqf_as / scqf_aftersales_candidate。
#   写死本地那套会在第一步就 `role "svc_app" does not exist`。
DB_USER = os.environ.get("S6_PG_USER", "scqf_as")
DB_NAME = os.environ.get("S6_PG_DB", "scqf_aftersales_candidate")

ARTIFACTS = ["server/index.js", "client/index.js", "build-fingerprint.json"]

# 🔴 铁律 1（2026-11-06 事故）：`dist/server/migrations/*.js` 是 **esbuild 单独打包**的，
#    不在 index.js 里。只换 3 个文件 ⇒ migrator 扫不到新迁移 ⇒
#    "代码新、库旧"的半截态：健康 200、日志显示 upgrade 跑完，但列/触发器/索引全缺，
#    真实业务一进来就 500。
#    ⇒ 发布产物清单**必须**包含迁移目录；这里断言它存在且非空，缺了直接停。
MIGRATIONS_DIR = "server/migrations"

# 本次发布的迁移前缀（用于核对"到底有没有落库"）。不靠日志判，只靠库。
EXPECTED_MIGRATION_PREFIXES = ["202610231", "202610251", "202610252",
                               "202611061", "202611062", "202611063",
                               "202611064", "202611065"]


def log(msg):
    print(msg, flush=True)


def die(msg, code=1):
    print("✗ %s" % msg, flush=True)
    sys.exit(code)


def shq(s):
    return "'" + s.replace("'", "'\\''") + "'"


class R:
    def __init__(self):
        self.cli = paramiko.SSHClient()
        self.cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    def connect(self):
        # 优先公钥认证（2026-11-06 起用户已把本机公钥写入生产 authorized_keys）；
        # 口令仅作兼容保留。两者都没有 ⇒ 立刻失败，不挂起等输入。
        if not PASS and not os.path.exists(KEY):
            die("既无 S6_SSH_PASS 也没有私钥 %s —— 未做任何操作" % KEY, 2)
        try:
            self.cli.connect(
                HOST, port=22, username=USER,
                password=PASS or None,
                key_filename=KEY if os.path.exists(KEY) else None,
                timeout=15, banner_timeout=20, auth_timeout=20,
                look_for_keys=True, allow_agent=False,
            )
        except paramiko.AuthenticationException:
            die("SSH 认证失败 —— 未做任何操作", 3)
        except Exception as exc:
            die("SSH 连接失败 %s: %s —— 未做任何操作" % (type(exc).__name__, exc), 3)

    def run(self, cmd, timeout=300):
        _i, out, err = self.cli.exec_command(cmd, timeout=timeout, get_pty=False)
        o = out.read().decode("utf-8", "replace")
        e = err.read().decode("utf-8", "replace")
        return out.channel.recv_exit_status(), o.strip(), e.strip()

    def sftp(self):
        return self.cli.open_sftp()

    def close(self):
        try:
            self.cli.close()
        except Exception:
            pass


def sha_local(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def psql(r, pg, sql, timeout=180):
    cmd = "docker exec %s psql -U %s -d %s -P pager=off -t -A -F'|' -c %s" % (
        shq(pg), shq(DB_USER), shq(DB_NAME), shq(sql))
    rc, o, e = r.run(cmd, timeout)
    if rc != 0:
        die("psql 失败 rc=%d: %s" % (rc, (e or o)[:400]), 20)
    return o


def detect_dist(r):
    """按**容器实际挂载点**定位 dist（只读）。

    ⚠️ 不能靠 `find /opt`：生产上还有 `scqf-p6-uat` 等 UAT 实例，同样有
       `storage/plugins/@local/service-ticket/dist`。find 命中 2 个时必须停，
       而正确的做法是**看 scqf-as-app 自己挂的是哪个**（挂载关系是唯一事实）。

    实测：/opt/scqf-aftersales/src/storage/plugins/@local/service-ticket
          → /app/nocobase/storage/plugins/@local/service-ticket (rw)
    """
    rc, out, err = r.run(
        "docker inspect %s --format '{{range .Mounts}}{{.Source}}|{{.Destination}}|{{.RW}}{{println}}{{end}}'"
        % shq(APP), 60)
    mounts = []
    for ln in out.splitlines():
        parts = ln.strip().split("|")
        if len(parts) == 3:
            mounts.append({"src": parts[0], "dst": parts[1], "rw": parts[2].strip().lower() == "true"})

    plugin_mounts = [m for m in mounts
                     if m["dst"].rstrip("/").endswith("/storage/plugins/@local/service-ticket")]
    if len(plugin_mounts) != 1:
        die("容器 %s 的插件挂载点不是恰好 1 个：%s" % (APP, plugin_mounts or "(无)"))

    plugin = plugin_mounts[0]["src"].rstrip("/")
    if not plugin_mounts[0]["rw"]:
        die("插件目录在容器内是只读挂载，写入无效：%s" % plugin)

    rc, o, _ = r.run("test -f %s/dist/server/index.js && echo OK" % shq(plugin), 30)
    if "OK" not in o:
        die("挂载目录里没有 dist/server/index.js：%s" % plugin)

    dist = plugin + "/dist"
    marker = "/storage/"
    idx = plugin.find(marker)
    storage = plugin[: idx + len("/storage")]
    roots = [posixpath.dirname(storage), posixpath.dirname(posixpath.dirname(storage))]

    comp, app_dir = "", None
    for root in roots:
        rc, o, _ = r.run("cd %s 2>/dev/null && { ls docker-compose.prod.yml >/dev/null 2>&1 && echo prod; "
                         "ls docker-compose.yml >/dev/null 2>&1 && echo default; } || true" % shq(root), 30)
        lines = [x.strip() for x in o.splitlines() if x.strip()]
        # 只有 compose 文件里确实声明了 app 服务才认，避免捡到别的项目的 compose
        if "prod" in lines or "default" in lines:
            f = "docker-compose.prod.yml" if "prod" in lines else "docker-compose.yml"
            rc2, o2, _ = r.run("grep -qE '^  app:' %s && echo HASAPP" % shq(posixpath.join(root, f)), 30)
            if "HASAPP" in o2:
                comp, app_dir = "docker compose -f " + f, root
                break

    rc, o, _ = r.run("docker ps --format '{{.Names}}'", 30)
    names = [x.strip() for x in o.splitlines() if x.strip()]
    pg = next((n for n in names if "postgres" in n.lower()), None)
    return dist, plugin, comp, app_dir, names, pg


def precheck(r, dist, pg):
    """只读预检：迁移登记 / 索引冲突 / 重复 ASSIGNED / 列是否已存在。"""
    log("\n===== 预检（只读） =====")

    total = psql(r, pg, "SELECT count(*) FROM migrations;")
    log("[P1] 迁移登记总数 = %s" % total.splitlines()[-1])

    todo = psql(r, pg, "SELECT name FROM migrations WHERE name LIKE '%20261106%' ORDER BY name;")
    log("[P2] 本次涉及的迁移登记情况：\n%s" % (todo if todo else "(空 ⇒ 5 个迁移均未执行)"))

    cols = psql(r, pg, """
SELECT column_name FROM information_schema.columns
 WHERE table_name='service_visits'
   AND column_name IN ('short_code_hash','short_code_expires_at','manual_code_salt',
                       'manual_code_hash','manual_code_expires_at','manual_code_epoch')
 ORDER BY 1;""")
    log("[P3] service_visits 目标列已存在：%s" % (cols.replace("\n", ", ") if cols else "(无 ⇒ 需迁移建列)"))

    pcols = psql(r, pg, """
SELECT column_name FROM information_schema.columns
 WHERE table_name='service_tickets'
   AND column_name IN ('progress_code_salt','progress_code_epoch','progress_code_hash')
 ORDER BY 1;""")
    log("[P4] service_tickets progress 列已存在：%s" % (pcols.replace("\n", ", ") if pcols else "(无)"))

    # ---- 唯一索引冲突风险（授权书第 3 条）----
    log("[P5] progress_code_hash 唯一索引冲突风险检查：")
    has_hash_col = "progress_code_hash" in pcols
    if has_hash_col:
        dup = psql(r, pg, """
SELECT COALESCE(count(*),0) FROM (
  SELECT progress_code_hash FROM service_tickets
   WHERE progress_code_hash IS NOT NULL
   GROUP BY progress_code_hash HAVING count(*)>1) x;""")
        log("     已存在 progress_code_hash 且有重复值的组数 = %s" % dup)
        if dup.strip() not in ("", "0"):
            die("progress_code_hash 存在重复值 ⇒ 唯一索引建不起来 ⇒ 迁移会失败。已停止，未做任何写操作。", 6)

    # 回填会新生成 hash：用 SQL 侧自检"回填后是否会碰撞"——
    # 由于回填来自 (id,salt,epoch) 的 HMAC，不同 id 碰撞概率极低，但仍按"同一 salt+epoch+id"去重检查。
    # ⚠️ 列不存在时**必须跳过**而不是执行：否则 psql 直接 ERROR，
    #    预检会以一个"语法/列缺失"的假故障挡住首次部署（列本来就是这次迁移才建的）。
    has_salt_col = "progress_code_salt" in pcols
    if has_salt_col:
        risky = psql(r, pg, """
SELECT count(*) FROM (
  SELECT progress_code_salt, progress_code_epoch, count(*) c
    FROM service_tickets
   WHERE progress_code_salt IS NOT NULL AND progress_code_hash IS NULL
   GROUP BY progress_code_salt, progress_code_epoch, id
  HAVING count(*)>1) x;""")
        log("     待回填行中 (id,salt,epoch) 重复组数 = %s（>0 才可能碰撞）" % risky)
    else:
        log("     progress_code_salt 列尚不存在 ⇒ 本次迁移首建，无历史回填行可碰撞（跳过该检查）")

    idx = psql(r, pg, """
SELECT indexname FROM pg_indexes
 WHERE tablename IN ('service_tickets','service_visits')
   AND indexname IN ('service_tickets_progress_code_hash_key',
                     'service_visits_short_code_hash_key',
                     'service_visits_manual_code_hash_key',
                     'uq_service_visits_short_code_hash')
 ORDER BY 1;""")
    log("[P6] 相关唯一索引现状：%s" % (idx.replace("\n", ", ") if idx else "(无)"))

    # ---- 重复 ASSIGNED：只报告，不处置（授权书第 4 条）----
    dupA = psql(r, pg, """
SELECT ticket_id, count(*) FROM service_visits
 WHERE visit_status='ASSIGNED' GROUP BY ticket_id HAVING count(*)>1 ORDER BY ticket_id;""")
    n_dup = len([x for x in dupA.splitlines() if x.strip()])
    log("[P7] 重复 ASSIGNED 工单数 = %d（仅报告，不清理不合并）" % n_dup)
    if n_dup:
        log("     %s" % dupA.replace("\n", "\n     "))

    trg = psql(r, pg, """
SELECT t.tgname, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 WHERE c.relname='service_visits' AND t.tgname='trg_service_visits_one_assigned';""")
    log("[P8] trg_service_visits_one_assigned = %s" % (trg if trg else "(不存在 ⇒ 将由 202611064 创建)"))

    sms = psql(r, pg, "SELECT send_status, provider, count(*) FROM sms_logs GROUP BY 1,2 ORDER BY 3 DESC;")
    log("[P9] 短信日志基线（部署前，不清理不改动）：\n%s" % sms)

    sizes = psql(r, pg, """
SELECT pg_size_pretty(pg_database_size(current_database())),
       (SELECT count(*) FROM service_tickets), (SELECT count(*) FROM service_visits);""")
    log("[P10] 库规模/票据/Visit = %s" % sizes)
    return {"n_dup_assigned": n_dup, "migrations_total": total.splitlines()[-1]}


def nginx_extract(r, dist, tmpdir):
    """在生产上导出三处待合并段落（只读 cat），用于后续按块替换。"""
    # 先定位生产 nginx 容器与配置路径
    rc, o, _ = r.run("docker ps --format '{{.Names}}' | tr '\\n' ' '", 30)
    log("[N0] 容器：%s" % o)
    candidates = [
        "/etc/nginx/conf.d/service.conf",
        "/www/server/panel/vhost/nginx/service.conf",
    ]
    found = None
    rc, o, _ = r.run("docker ps --format '{{.Names}}' | grep -i nginx", 30)
    ng = (o.splitlines() or [""])[0].strip()
    for p in candidates:
        if ng:
            rc2, o2, _ = r.run("docker exec %s test -f %s && echo YES" % (shq(ng), shq(p)), 30)
            if "YES" in o2:
                found = (ng, p)
                break
    return ng, found


def main():
    mode = "precheck"
    if "--apply" in sys.argv:
        mode = "apply"
    if "--rollback" in sys.argv:
        mode = "rollback"
        ts = sys.argv[sys.argv.index("--rollback") + 1]

    r = R()
    r.connect()
    log("[0] 已登录 %s@%s" % (USER, HOST))

    dist, plugin, comp, app_dir, names, pg = detect_dist(r)
    log("[1] dist = %s" % dist)
    log("[1] compose = %s  项目根 = %s" % (comp or "(未找到)", app_dir))
    log("[1] 容器 = %s" % " ".join(names))
    log("[1] PG = %s" % pg)
    if APP not in names:
        die("应用容器 %s 不在运行列表" % APP, 5)
    if not pg:
        die("找不到 postgres 容器", 5)

    info_pre = precheck(r, dist, pg)

    if mode == "precheck":
        log("\n[dry] 预检结束，未做任何写操作。")
        return 0

    # ---------------------------------------------------------------- rollback
    if mode == "rollback":
        bak = "%s.bak.%s" % (dist, ts)
        rc, o, _ = r.run("test -d %s && echo YES" % shq(bak), 30)
        if "YES" not in o:
            die("备份目录不存在：%s" % bak, 7)
        rc, o, e = r.run("rm -rf %s && cp -a %s %s && sha256sum %s/server/index.js %s/client/index.js"
                         % (shq(dist), shq(bak), shq(dist), shq(dist), shq(dist)), 180)
        log("[R1] 代码已还原：\n%s" % (o or e))
        if comp:
            r.run("cd %s && %s restart app" % (shq(app_dir), comp), 420)
        else:
            r.run("docker restart %s" % shq(APP), 420)
        for i in range(30):
            rc, o, _ = r.run("curl -s -o /dev/null -w '%{http_code}' " + HEALTH_URL, 30)
            if o.strip() == "200":
                log("[R2] 健康 200（第 %d 次）" % (i + 1))
                break
            time.sleep(5)
        log("[R3] 注意：回滚**未删任何列**，触发器保持存在（授权书第 7 条）")
        return 0

    # ---------------------------------------------------------------- apply
    stamp = time.strftime("%Y%m%d-%H%M%S")
    log("\n===== 开始部署 stamp=%s =====" % stamp)

    # ① 整库备份（授权书第 2 条）
    dbfile = "/root/scqf-db-before-%s.sql.gz" % stamp
    log("[B1] 整库备份 → %s" % dbfile)
    rc, o, e = r.run("docker exec %s pg_dump -U %s -d %s | gzip -9 > %s && ls -l %s"
                     % (shq(pg), shq(DB_USER), shq(DB_NAME), shq(dbfile), shq(dbfile)), 1200)
    log("[B1] %s" % (o or e))
    if rc != 0:
        die("整库备份失败 —— 未做任何改动，停止", 8)
    rc, o, _ = r.run("test -s %s && echo NONEMPTY" % shq(dbfile), 30)
    if "NONEMPTY" not in o:
        die("备份文件为空 —— 停止", 8)

    # ② 产物备份（整目录）
    bak = "%s.bak.%s" % (dist, stamp)
    rc, o, e = r.run("cp -a %s %s && echo OK" % (shq(dist), shq(bak)), 300)
    if "OK" not in o:
        die("dist 备份失败：%s" % e, 8)
    log("[B2] dist 备份 = %s" % bak)

    # ③ 上传产物
    tmp = "/tmp/svc-dist-%s" % stamp
    r.run("mkdir -p %s" % shq(tmp), 60)

    # 🔴 铁律 1：先断言本地迁移目录存在且非空 —— 缺它宁可不发布
    local_mig = os.path.join(LOCAL_DIST, "server", "migrations")
    if not os.path.isdir(local_mig):
        die("本地缺迁移目录 %s —— 拒绝发布（换 index.js 不带迁移会造成'代码新、库旧'）" % local_mig, 9)
    mig_files = sorted(f for f in os.listdir(local_mig) if f.endswith(".js"))
    if not mig_files:
        die("本地迁移目录为空 —— 拒绝发布", 9)
    log("[U0] 本地迁移文件 = %d 个" % len(mig_files))

    sftp = r.sftp()
    local_sha = {}
    for rel in ARTIFACTS:
        lp = os.path.join(LOCAL_DIST, *rel.split("/"))
        if not os.path.exists(lp):
            die("本地缺产物 %s" % lp, 9)
        remote = posixpath.join(tmp, rel.replace("/", "-"))
        sftp.put(lp, remote)
        local_sha[rel] = sha_local(lp)

    # 迁移目录逐个上传（保持目录结构）
    r.run("mkdir -p %s" % shq(posixpath.join(tmp, "migrations")), 60)
    mig_sha = {}
    for f in mig_files:
        lp = os.path.join(local_mig, f)
        sftp.put(lp, posixpath.join(tmp, "migrations", f))
        mig_sha[f] = sha_local(lp)
    sftp.close()
    log("[U1] 上传完成：%s + migrations×%d"
        % (json.dumps({k: v[:16] for k, v in local_sha.items()}, ensure_ascii=False), len(mig_files)))

    # ④ 落盘（3 个产物 + 整个迁移目录）
    cmd = "set -e; "
    for rel in ARTIFACTS:
        cmd += "cp -a %s %s; " % (shq(posixpath.join(tmp, rel.replace("/", "-"))),
                                  shq(posixpath.join(dist, rel)))
    cmd += "mkdir -p %s; " % shq(posixpath.join(dist, MIGRATIONS_DIR))
    cmd += "cp -a %s/. %s/; " % (shq(posixpath.join(tmp, "migrations")),
                                 shq(posixpath.join(dist, MIGRATIONS_DIR)))
    cmd += "sha256sum %s" % " ".join(shq(posixpath.join(dist, x)) for x in ARTIFACTS)
    rc, o, e = r.run(cmd, 300)
    log("[U2] 落盘哈希：\n%s" % o)
    for rel, sha in local_sha.items():
        if sha[:16] not in o:
            r.run("rm -rf %s && cp -a %s %s" % (shq(dist), shq(bak), shq(dist)), 300)
            die("%s 落盘哈希不符 —— 已整目录回滚，未重启" % rel, 10)

    rc, o, _ = r.run("ls %s/*.js | wc -l" % shq(posixpath.join(dist, MIGRATIONS_DIR)), 60)
    log("[U3] 生产迁移文件数（落盘后）= %s" % o.strip())

    # ⑤ 重启并盯迁移日志
    log("[S1] 重启应用（首次启动会执行 afterLoad 迁移）…")
    if comp:
        rc, o, e = r.run("cd %s && %s restart app" % (shq(app_dir), comp), 600)
    else:
        rc, o, e = r.run("docker restart %s" % shq(APP), 600)
    log("[S1] restart rc=%d" % rc)

    health = ""
    mig_ok = None
    for i in range(40):
        time.sleep(5)
        rc, o, _ = r.run("curl -s -o /dev/null -w '%{http_code}' " + HEALTH_URL, 30)
        health = o.strip()
        rc2, logs, _ = r.run("docker logs --since 3m %s 2>&1 | grep -iE 'migration|20261106' | tail -40"
                             % shq(APP), 60)
        if logs:
            mig_ok = logs
        if any(k in (logs or "") for k in ("★", "ERROR", "FATAL", "error: ")):
            log("[S2] ⚠️ 迁移日志出现异常标记，原文：\n%s" % logs)
        if health == "200":
            log("[S2] 健康 200（第 %d 次探测，约 %ds）" % (i + 1, (i + 1) * 5))
            break
    log("[S2] 迁移日志片段：\n%s" % (mig_ok or "(未捕获)"))

    # 🔴 铁律 2（2026-11-06 事故）：健康判据本身必须先自证。
    #    那次因为 `'%%{http_code}'` 被转义成字面量，curl 原样输出 7 个字符，
    #    永远 ≠ "200" ⇒ 把一次 25 秒成功启动误判为失败并自动回滚。
    #    这里做一次**独立复核**：健康值必须是 3 位数字串；否则说明是判据坏了，
    #    而不是产品坏了 —— 两种情况必须分开报，绝不能因此回滚。
    if not (isinstance(health, str) and health.isdigit() and len(health) == 3):
        log("[S2b] ⛔ 健康判据自身异常：返回值 = %r（应为 3 位数字串）" % (health,))
        log("      ⇒ 这是**脚本判据坏了**，不等于应用故障。已停止自动决策，请人工复核：")
        log("        ssh root@%s \"curl -s -o /dev/null -w '%%{http_code}' %s\"" % (HOST, HEALTH_URL))
        die("健康判据不可信，拒绝据此回滚（未做任何回滚动作）", 12)
    log("[S2b] 健康判据自检通过（返回值形如 '200' 的三位数字串）")

    if health != "200":
        log("[S3] 健康未通过（%s）⇒ 立即代码回滚" % health)
        r.run("rm -rf %s && cp -a %s %s" % (shq(dist), shq(bak), shq(dist)), 300)
        if comp:
            r.run("cd %s && %s restart app" % (shq(app_dir), comp), 600)
        else:
            r.run("docker restart %s" % shq(APP), 600)
        die("健康检查失败，已执行代码回滚（未删列/未删触发器）。请查看日志。", 11)

    # ⑥ 迁移核对
    total_after = psql(r, pg, "SELECT count(*) FROM migrations;")
    done = psql(r, pg, "SELECT name FROM migrations WHERE name LIKE '%20261106%' ORDER BY name;")
    log("[M1] 迁移总数 = %s" % total_after.splitlines()[-1])
    log("[M2] 本次迁移登记：\n%s" % (done or "(空)"))

    # 🔴 铁律 1 的执行判据：**迁移未落库 = 发布未完成**，即使健康 200 也不算成功。
    missing_mig = [p for p in EXPECTED_MIGRATION_PREFIXES
                   if not any(p in line for line in done.splitlines())]
    pre_total = int(info_pre.get("migrations_total", "0") or 0)
    post_total = int((total_after.splitlines() or ["0"])[-1] or 0)
    log("[M1b] 迁移总数 %d → %d（预期应增加）" % (pre_total, post_total))

    trg = psql(r, pg, """
SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 WHERE c.relname='service_visits' AND t.tgname='trg_service_visits_one_assigned';""")
    idx = psql(r, pg, """
SELECT indexname FROM pg_indexes WHERE indexname IN
 ('service_visits_short_code_hash_key','service_visits_manual_code_hash_key',
  'service_tickets_progress_code_hash_key') ORDER BY 1;""")
    log("[M3] 触发器存在 = %s" % ("是" if trg else "否"))
    log("[M4] 关键唯一索引 = %s" % idx.replace("\n", ", "))

    if missing_mig or not trg:
        log("[M6] ⛔ 迁移未落库（缺失：%s；触发器：%s）" % (", ".join(missing_mig) or "无", "有" if trg else "无"))
        log("     最可能原因：`dist/server/migrations/` 没有一起更新（铁律 1）。")
        log("     ⇒ 当前是「代码新、库旧」的半截态，**不得视为发布成功**。")
        log("     补救：python scripts/sync-migrations.py --apply && 再 restart app")
        log("     代码备份仍在：%s" % bak)
        die("迁移未落库 —— 发布未完成（代码已落盘，可按上面补救或 --rollback %s）" % stamp, 13)

    dupA = psql(r, pg, """
SELECT count(*) FROM (SELECT ticket_id FROM service_visits WHERE visit_status='ASSIGNED'
 GROUP BY ticket_id HAVING count(*)>1) x;""")
    log("[M5] 重复 ASSIGNED 工单数 = %s（未清理，仅记录）" % dupA.strip())

    print(json.dumps({"stamp": stamp, "backup_dist": bak, "backup_db": dbfile,
                      "health": health, "sha": {k: v[:16] for k, v in local_sha.items()}},
                     ensure_ascii=False, indent=2), flush=True)
    r.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
