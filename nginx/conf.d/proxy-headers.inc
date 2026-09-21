# =============================================================================
#  proxy-headers.inc —— 反代到 svc_app 的统一请求头（被 service.conf 各 location include）
# -----------------------------------------------------------------------------
#  为什么单独抽一个文件：nginx 没有宏，这些头本来要在 11 个 location 里各写一遍。
#  重复书写的问题不是"啰嗦"，而是**它们会漂移** —— 改了一处忘了另一处，
#  症状是"某些路由正常、某些路由莫名其妙出错"，而配置本身看起来完全一致。
#
#  ⚠️ 不要把这个文件命名为 *.conf —— nginx.conf 里有
#     `include /etc/nginx/conf.d/*.conf;`，.conf 会被当成独立 server 块加载并报语法错误。
# =============================================================================

# ------------------------------------------------------------------ Host ----
# ⚠️ 必须是 `$http_host`，不能是 `$host`。这是 2026-09-21 真机定位到的后台登录故障根因：
#
#   `$host` = 主机名，**不含端口**（nginx 文档：host name from the request line,
#             or from the Host header, or the server_name；端口被剥掉）。
#   `$http_host` = 客户端原样发来的 Host 头（`localhost:8080`，含端口）。
#
# 后果链条：
#   浏览器发 POST /api/auth:signIn 时带 `Origin: http://localhost:8080`
#   → @nocobase/auth 的 assertTrustedSignInOrigin() 调 isTrustedOrigin()
#   → 同源判定用 getRequestOrigin(ctx) = `${x-forwarded-proto || protocol}://${x-forwarded-host || host}`
#   → 我们转发的是 `Host: localhost`（端口被 $host 吃掉）→ 算出 `http://localhost`
#   → 与 `http://localhost:8080` 不相等，且 CORS_ORIGIN_WHITELIST 未配置
#   → **403 {"message":"Invalid sign-in origin"}**
#
#   现象极具误导性：登录接口用 curl 打**返回 200**（curl 不发 Origin 头，
#   走的是 referer 分支且 referer 也为空 → 直接放行），只有浏览器登录才 403。
#   也就是说**所有接口级验收全绿，而后台一个人都登不进去**。
#
#   Phase 10 换到真实域名/443 后，本行依然正确（$http_host 就是对外域名），
#   不需要跟着改 —— 这正是不能写死 PUBLIC_BASE_URL 的原因。
proxy_set_header Host              $http_host;

# ------------------------------------------------------------ 客户端地址 ----
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

# -------------------------------------------------------------- 协议 ----
# $svc_forwarded_proto 由 nginx.conf 的 map 定义：
#   优先用上游（更外层代理）给的 X-Forwarded-Proto，没有则用当前 $scheme。
# Phase 10 上 TLS 后 $scheme=https，不需要改这里。
proxy_set_header X-Forwarded-Proto $svc_forwarded_proto;

# ---------------------------------------------------------- 对外主机名 ----
# isTrustedOrigin() 优先读 X-Forwarded-Host，其次才读 Host。
# 这里显式给出，让"对外来源"这件事在链路里有一个**明确**的答案，
# 而不是依赖"Host 头刚好没被改写"。
proxy_set_header X-Forwarded-Host  $http_host;

# ⚠️ 刻意**不设置** X-Forwarded-Port：
#   nginx 容器监听的是 80，而对外映射端口（8080/443）由 docker 决定，
#   `$server_port` 在这里只会给出 80 —— 那是个**错误**的值。
#   给一个错误的头比不给更糟：下游会以为它是可信的。
#   端口信息已经完整包含在 $http_host 里。
