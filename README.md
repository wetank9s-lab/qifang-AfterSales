# 家电门店售后服务平台

<p>
  <img alt="status" src="https://img.shields.io/badge/status-release%20candidate-orange">
  <img alt="phase 10" src="https://img.shields.io/badge/Phase%2010-RELEASE%20HOLD-lightgrey">
  <img alt="NocoBase" src="https://img.shields.io/badge/NocoBase-2.2.15-2b6cb0">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-16-336791">
  <img alt="Nginx" src="https://img.shields.io/badge/Nginx-1.27-009639">
  <img alt="Vue" src="https://img.shields.io/badge/Vue-3-42b883">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-compose-2496ED">
</p>

> **门店售后工单中台** —— 匿名 H5 报修 → 门店派工 → 师傅上传 → 审核 → 匿名评价 → 关闭/重开。
> 单机自托管 · 服务端强制门店隔离 · 一次性 Token 匿名闭环 · 短信通知 · 总部监管


- **权威状态** → [`docs/PHASE-10.md` §状态](docs/PHASE-10.md)
- **接手 / 验收入口** → [`docs/DELIVERY.md`](docs/DELIVERY.md)（交付了什么 / 怎么验 / 还差什么）

## 技术栈（版本已冻结）

| 层 | 选型 | 冻结版本 |
|---|---|---|
| 低代码基座 | NocoBase Community | `2.2.15-full-no-nginx` |
| 数据库 | PostgreSQL | `16` |
| 网关 | Nginx | `1.27-alpine` |
| 前端 | Vue 3 + Vite | `3.4` |
| 部署 | Docker Compose（单机自托管） | 3 服务：`svc-app` / `svc-postgres` / `svc-nginx` |

> 版本的**单一事实来源**是 [`scripts/expected-versions.mjs`](scripts/expected-versions.mjs)，
> 不是本文件 —— 改版本 = 发起一次版本变更，由门禁断言拦住漏改的那一腿。

---

## 这是什么

一个**独立、轻量的「门店售后工单中台」**：

```
客户匿名 H5 报修/投诉
  → 门店售后受理 / 转店 / 派工
  → 师傅凭一次性短信链接匿名上传现场照片 + 提交处理结果与收费
  → 门店审核确认（或驳回返工）
  → 客户凭一次性链接匿名评价（含收费一致性确认）
  → 满意关闭 / 低评分或收费不一致自动重开
  → 总部全量监控 + KPI + Excel 导出
```

---

## 角色

| 角色 | 账号 | 范围 |
|---|---|---|
| 门店售后人员 | 有 | 仅被授权门店（服务端强制隔离） |
| 总部售后人员 | 有 | 全部门店 |
| 总部管理员 | 有 | 全部 + 配置/权限/导出 |
| 客户 | 无 | 匿名 H5；评价用一次性 Token |
| 师傅 | 无 | 一次性 Token H5，仅本次任务最小信息 |

---

## 目录结构

```
.
├─ nocobase/plugins/service-ticket/   后端唯一扩展插件（TypeScript 源码）
├─ h5/                                Vue3 + Vite H5（客户报修 / 师傅回执 / 客户评价）
│  └─ dist/                           构建产物（nginx 挂载点）
├─ nginx/                             反向代理、HTTPS、限流、静态托管
├─ docs/                              设计与运维文档
├─ scripts/                           build / verify / gen-secret 等工具
├─ backups/                           备份输出（不入库）
├─ storage/                           运行时持久化（含已编译插件，不入库）
│  └─ plugins/@local/service-ticket/  esbuild 编译产物（compose 挂载源）
├─ docker-compose.yml                 postgres + app(nocobase) + nginx
└─ .env.example                       全部环境变量样例
```


## 部署要求

- 对外仅暴露 **443**；`13000`（NocoBase）与 `5432`（PostgreSQL）不对公网开放
- 必须 HTTPS（微信内置浏览器要求）+ 已备案域名
- 短信签名/模板需提前完成实名资质与运营商报备
---
