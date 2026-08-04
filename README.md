# VPS Resale Panel

> **库存式 VPS 转售面板** — 把从多个上游采购的 VPS 经过线路/系统优化后二次售卖，统一管理套餐、库存、订单、支付、交付与售后运维。
>
> 技术栈：NestJS 11 + Prisma 6 + MySQL 8 + JWT + 原生 HTML/JS 前端（由 NestJS 静态托管）。

[![Node](https://img.shields.io/badge/node-%E2%89%A520-green)](https://nodejs.org)
[![NestJS](https://img.shields.io/badge/NestJS-11-e0234e)](https://nestjs.com)
[![Prisma](https://img.shields.io/badge/Prisma-6-2d3748)](https://www.prisma.io)
[![License](https://img.shields.io/badge/license-ISC-blue)](#license)

---

## 目录

- [功能特性](#功能特性)
- [架构概览](#架构概览)
- [项目结构](#项目结构)
- [快速开始（本地开发）](#快速开始本地开发)
- [生产部署](#生产部署)
- [配置项（.env）](#配置项env)
- [数据库与状态机](#数据库与状态机)
- [支付集成](#支付集成)
- [前端页面](#前端页面)
- [API 速查表](#api-速查表)
- [使用指南](#使用指南)
- [运维与常用命令](#运维与常用命令)
- [测试](#测试)
- [常见问题](#常见问题)
- [License](#license)

---

## 功能特性

### 用户侧
- 📋 浏览套餐（CNY / USD 双币月付），无库存时禁止下单
- 🔐 注册 / 登录带**图形验证码**（svg-captcha，5 分钟 TTL，一次性）
- 👤 **用户中心**：查看账户信息、修改昵称/手机号、修改密码
- 🛒 下单 → 多支付方式 checkout → 支付成功自动交付
- 🖥️ **我的服务**控制台：状态检测、重启、重置密码、重装初始化、续费
- 📱 响应式前端，支持移动端 / 内嵌浏览器（IAB）

### 管理侧
- 📦 **库存管理**：录入上游 VPS（SSH / Proxmox 两种驱动），状态机驱动流转，凭据 AES-256-GCM 加密存储
- 🏷️ **套餐管理**：定义套餐规格 + `matchRulesJson` 匹配规则（region / CPU / 内存），乐观锁分配库存避免超卖
- 📜 **订单管理**：全量订单查看、手动标记已付、重试分配
- 💳 **支付通道管理**：数据库驱动的支付方式（ABA KHQR / ABA PayWay / Crypto USDT），后台可增删改、启用/禁用
- 👥 **用户管理**：查看所有注册用户、编辑资料、重置密码、改角色/状态
- 🛠️ **服务运维控制台**：管理员可对任意已售 VPS 执行状态检测/重启/重置密码/重装/停用/回收
- ⏰ **到期任务**：`POST /api/admin/tasks/expire-services` 将过期 active 服务置为 suspended

### 安全
- JWT 鉴权 + bcrypt 密码哈希
- `AdminGuard` 守卫所有 `/api/admin/*` 路由
- 库存/支付通道凭据用 `CREDENTIALS_SECRET` 派生的 AES-256-GCM 加密入库
- 图形验证码防爆破注册/登录
- 首次启动自动 bootstrap 管理员账号（通过环境变量配置）

---

## 架构概览

```
┌──────────────────────────────────────────────────────────┐
│                       浏览器 / IAB                        │
│  index.html  services.html  service.html  profile.html   │
│  login.html  register.html  pay/checkout.html  admin*.html│
└────────────────────────┬─────────────────────────────────┘
                         │ HTTP (static + /api/*)
┌────────────────────────▼─────────────────────────────────┐
│              NestJS 11  (useStaticAssets)                │
│  ┌────┐ ┌──────┐ ┌────────┐ ┌──────┐ ┌─────────┐ ┌──────┐│
│  │Auth│ │Captcha│ │Plans  │ │Orders│ │Services │ │Inv   ││
│  └────┘ └──────┘ └────────┘ └──────┘ └─────────┘ └──────┘│
│  ┌──────────┐ ┌────────┐ ┌────────────────────────────┐  │
│  │PayChannels│ │ Prisma │ │ SSH / Proxmox providers   │  │
│  └──────────┘ └────────┘ └────────────────────────────┘  │
└────────────────────────┬─────────────────────────────────┘
                         │
        ┌────────────────┼─────────────────┐
        ▼                ▼                 ▼
   ┌─────────┐    ┌────────────┐    ┌──────────────┐
   │ MySQL 8 │    │ Jeepay 网关 │    │ 目标 VPS     │
   │(Prisma) │    │  (聚合支付) │    │(SSH/PVE API) │
   └─────────┘    └────────────┘    └──────────────┘
```

**核心业务流**：

```
管理员：录入库存 (sourcing) → 优化中 (optimizing) → 可售 (ready)
用户：  选择套餐+币种 → 创建订单（库存检查）→ 支付
回调：  支付成功 → 锁定 ready 库存 → 创建 service（active）→ 交付信息
续费：  RN 订单支付 → expireAt +1 月
到期：  expire-services 任务 → suspended
回收：  suspended → recycling → ready（库存重新上架）
```

---

## 项目结构

```
vps-resale-panel/
├── apps/
│   └── api/                      # NestJS 后端 + 静态前端
│       ├── prisma/
│       │   ├── schema.prisma     # 数据模型（User/Plan/Inventory/Order/Payment/Service/...）
│       │   └── seed-pay-channels.js   # 支付通道种子脚本
│       ├── src/
│       │   ├── auth/             # 注册/登录/JWT/用户资料/改密/管理员用户管理
│       │   ├── captcha/          # 图形验证码（svg-captcha）
│       │   ├── plans/            # 套餐 CRUD + 价格
│       │   ├── inventory/        # 库存 CRUD + 状态机 + 分配器
│       │   ├── orders/           # 下单 + Jeepay/TokenPay 支付 + 回调 + 交付
│       │   ├── services/         # 我的服务 + 运维操作（SSH/Proxmox provider）
│       │   ├── paychannels/      # 支付通道管理
│       │   ├── crypto/           # AES-256-GCM 加解密工具
│       │   ├── prisma/           # PrismaService
│       │   ├── common/           # 序列化等工具
│       │   ├── app.module.ts
│       │   └── main.ts           # 启动入口（CORS + 静态托管 + Jeepay notify 中间件）
│       ├── public/               # 静态前端（NestJS useStaticAssets 直接托管）
│       │   ├── index.html        # 首页（套餐展示）
│       │   ├── services.html     # 我的服务列表
│       │   ├── service.html      # 单台服务控制台（自包含，防 IAB 缓存）
│       │   ├── profile.html      # 用户中心
│       │   ├── login.html / register.html   # 带图形验证码
│       │   ├── admin.html        # 管理后台（套餐/库存/订单）
│       │   ├── admin-users.html  # 用户管理
│       │   ├── admin-service.html# 服务运维控制台
│       │   ├── admin-pay-channels.html  # 支付通道管理
│       │   ├── pay/              # 支付流程页（checkout / aba-khqr / result）
│       │   └── assets/           # app.js + style.css + 图标 + qrcode.min.js
│       ├── test/
│       ├── .env.example          # 完整配置模板
│       ├── nest-cli.json
│       ├── tsconfig.json / tsconfig.build.json
│       └── package.json
├── docs/
│   ├── PROXMOX.md                # Proxmox 驱动对接说明
│   └── PROXMOX-SETUP-STEP-BY-STEP.md   # PVE Token 配置分步教程
├── deploy_vps_resale.sh          # 一键全量部署（含 node/mysql/pm2/nginx 安装）
├── update_vps_resale.sh          # 增量更新（已装环境的补丁部署）
├── update_paychannels.sh         # 增量更新（支付通道版）
├── flow_test.sh                  # 端到端流程测试脚本
├── PRD-v0.1.md                   # 产品需求文档
├── DATA-MODEL-v0.1.md            # 数据模型与状态机设计
└── package.json
```

> **注意**：`apps/web/` 是预留的独立前端目录（当前为空），实际前端在 `apps/api/public/`。

---

## 快速开始（本地开发）

### 前置要求
- Node.js ≥ 20
- MySQL 8（或用 Docker 起一个）
- npm

### 步骤

```bash
# 1. 克隆
git clone https://github.com/vlesse/vps-resale-panel.git
cd vps-resale-panel/apps/api

# 2. 安装依赖
npm install

# 3. 准备数据库
mysql -u root -p -e "
  CREATE DATABASE vps_resale DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE USER 'vps'@'localhost' IDENTIFIED BY 'vps_pass';
  GRANT ALL ON vps_resale.* TO 'vps'@'localhost';
  FLUSH PRIVILEGES;
"

# 4. 配置环境变量
cp .env.example .env
# 编辑 .env，至少改：DATABASE_URL、JWT_SECRET、CREDENTIALS_SECRET、BOOTSTRAP_ADMIN_*

# 5. 生成 Prisma client + 同步表结构
npx prisma generate
npx prisma db push --accept-data-loss

# 6. 启动开发服务器
npm run start:dev
# → VPS Resale API listening on :3000
```

打开浏览器访问 `http://localhost:3000/` 即可看到首页。
管理员登录：`http://localhost:3000/admin.html`（用 `.env` 里的 `BOOTSTRAP_ADMIN_EMAIL/PASSWORD`）。

---

## 生产部署

### 方式一：一键全量部署（推荐首次）

`deploy_vps_resale.sh` 会在一台干净的 Ubuntu 上自动安装 Node 20、MySQL、PM2、Nginx，并完成所有配置。

```bash
# 1. 在本地打包 API（只含 apps/api，不含 node_modules / dist / .env）
cd vps-resale-panel
tar --exclude='apps/api/node_modules' \
    --exclude='apps/api/dist' \
    --exclude='apps/api/.env' \
    -czf vps-resale-api.tgz -C apps api

# 2. 上传到目标服务器
scp vps-resale-api.tgz deploy_vps_resale.sh root@<your-server>:/tmp/

# 3. 在服务器上执行
ssh root@<your-server>
bash /tmp/deploy_vps_resale.sh /tmp/vps-resale-api.tgz
```

脚本会：
- 安装 Node 20 / MySQL / PM2 / Nginx
- 创建数据库 `vps_resale` 和专用用户
- 生成随机的 `JWT_SECRET` / `CREDENTIALS_SECRET` / 管理员密码
- `npm install` + `prisma db push` + `nest build`
- 用 PM2 启动 `vps-resale-api` 并配置开机自启
- 配置 Nginx 反向代理 80 → 3000
- 把凭据写入 `/root/vps-resale-credentials.txt`（权限 600）

部署完成后，**编辑 `.env` 填入 Jeepay 商户参数**，然后 `pm2 restart vps-resale-api`。

### 方式二：增量更新（已部署过）

```bash
# 打包新版
tar --exclude='apps/api/node_modules' --exclude='apps/api/dist' --exclude='apps/api/.env' \
    -czf vps-resale-api-update.tgz -C apps api

# 上传到服务器 /tmp/
scp vps-resale-api-update.tgz update_vps_resale.sh root@<server>:/tmp/

# 在服务器上执行（通过环境变量传入你的 Jeepay 参数，避免硬编码）
ssh root@<server> '
  APP_BASE_URL=https://your-domain.com \
  JEEPAY_MCH_NO=Mxxxxx \
  JEEPAY_APP_ID=xxxxx \
  JEEPAY_APP_SECRET=xxxxx \
  JEEPAY_NOTIFY_URL=https://your-domain.com/api/payments/jeepay/notify \
  JEEPAY_RETURN_URL=https://your-domain.com/pay/result.html \
  SERVER_NAME=your-domain.com \
  bash /tmp/update_vps_resale.sh
'
```

脚本会备份现有 `.env`，替换代码，合并环境变量，重新 `npm install` + `prisma generate` + `nest build` + `pm2 restart` + `nginx reload`。

### 方式三：用 Python 一键远程部署

```bash
pip install paramiko
python3 deploy_baidu.py --host <ip> --user root --pass '<password>'
```

（会自动上传 `vps-resale-api.tgz` 并在远端执行 `deploy_vps_resale.sh`）

---

## 配置项（.env）

完整模板见 [`apps/api/.env.example`](apps/api/.env.example)。关键项：

| 变量 | 说明 | 必填 |
|------|------|------|
| `DATABASE_URL` | MySQL 连接串 `mysql://user:pass@host:port/db` | ✅ |
| `JWT_SECRET` | JWT 签名密钥（生产用随机长字符串） | ✅ |
| `CREDENTIALS_SECRET` | AES-256-GCM 密钥派生源（≥32 字符，**写入数据后不可更改**） | ✅ |
| `BOOTSTRAP_ADMIN_EMAIL` | 首次启动自动创建的管理员邮箱 | ✅ |
| `BOOTSTRAP_ADMIN_PASSWORD` | 管理员初始密码 | ✅ |
| `PORT` | 监听端口，默认 3000 | |
| `APP_BASE_URL` | 面板公网地址 | |
| `JEEPAY_GATEWAY_URL` | Jeepay 网关地址 | 启用 Jeepay 时 |
| `JEEPAY_MCH_NO` / `JEEPAY_APP_ID` / `JEEPAY_APP_SECRET` | Jeepay 商户凭证 | 启用 Jeepay 时 |
| `JEEPAY_WAY_CODE_CNY` / `JEEPAY_WAY_CODE_USD` | 各币种使用的支付方式码 | |
| `JEEPAY_CNY_TO_KHR_RATE` | CNY → KHR 换算率（ABA KHQR 以 KHR 结算） | |
| `JEEPAY_USD_TO_CNY_RATE` | USD → CNY 换算率 | |
| `JEEPAY_NOTIFY_URL` / `JEEPAY_RETURN_URL` | 异步通知 / 同步跳转地址（需公网可达） | |
| `TOKENPAY_API_TOKEN` / `TOKENPAY_NOTIFY_URL` | TokenPay（USDT）网关，留空则禁用 | 可选 |
| `PAY_METHODS_ENABLED` | checkout 页显示的通道码，逗号分隔 | |

> ⚠️ `CREDENTIALS_SECRET` 一旦写入数据后**绝对不能改**，否则已加密的库存/支付通道凭据将无法解密。

---

## 数据库与状态机

完整设计见 [`DATA-MODEL-v0.1.md`](DATA-MODEL-v0.1.md)。核心表：

| 表 | 说明 |
|----|------|
| `users` | 用户（customer / admin）、状态、登录时间 |
| `plans` | 套餐规格 + `matchRulesJson` 匹配规则 + `featuresJson` |
| `plan_prices` | 套餐价格（CNY / USD，月付） |
| `inventory_servers` | 库存 VPS，凭据加密存储，绑定订单/服务 |
| `orders` | 订单 + 绑定的库存 + 支付通道 |
| `payments` | 支付记录 + Jeepay 回调原文 |
| `services` | 已交付的服务（绑定 user / order / inventory） |
| `service_actions` | 运维操作记录（状态检测/重启/改密/重装） |
| `pay_channels` | 支付通道配置（DB 驱动，可后台管理） |
| `operation_logs` | 操作审计日志 |

### 库存状态机

```
sourcing → optimizing → ready → reserved → sold → suspended → recycling → retired
                ↑                      │           │            │
                └──────────────────────┘           │            │
                ←──────────────────────────────────┘            │
                ←───────────────────────────────────────────────┘
```

- `ready` 才可被订单分配
- 下单时先置 `reserved`，支付成功后转 `sold` 并创建 `service`
- `suspended` → `recycling` → `ready` 完成回收上架
- 管理后台按钮根据当前状态**上下文感知**地只显示合法流转

### 套餐匹配规则（`matchRulesJson`）

```json
{
  "regions": ["us-west", "local-pve"],
  "min_cpu": 2,
  "min_memory_mb": 2048
}
```

下单时分配器用这些规则筛选 `ready` 库存，通过 Prisma 的原子 `updateMany` + `version` 乐观锁保证不超卖。

---

## 支付集成

### Jeepay（聚合支付，默认）

支持三种通道（均走 Jeepay `unifiedOrder`）：

| 通道码 | 说明 | 结算币种 |
|--------|------|----------|
| `aba_khqr` | ABA Bank KHQR 扫码 | KHR（按 `JEEPAY_CNY_TO_KHR_RATE` 换算） |
| `aba_pc` | ABA PayWay 信用卡 | USD / KHR（`JEEPAY_ABA_PC_CURRENCY`） |
| `crypto` | USDT（TRX_USDT） | USD |

流程：
1. 用户下单 → `POST /api/orders/:orderNo/pay` → 后端调 Jeepay `unifiedOrder`
2. 返回 `payData`（KHQR 是 codeUrl，PayWay 是跳转 URL）
3. 用户支付 → Jeepay 异步通知 `POST /api/payments/jeepay/notify`
4. 后端验签（MD5：参数排序 + `key=appSecret`）→ 状态 `state=2` 视为成功 → 分配库存 → 创建 service

支付通道在 `pay_channels` 表中管理（`prisma/seed-pay-channels.js` 从 `.env` 种子初始化），后台可在 `admin-pay-channels.html` 增删改、启用/禁用、调汇率。

### TokenPay（可选 USDT 网关）

若设置了 `TOKENPAY_API_TOKEN`，`crypto` 通道会走 TokenPay 而非 Jeepay。通知地址：`POST /api/payments/tokenpay/notify`。

---

## 前端页面

| 页面 | 路径 | 说明 |
|------|------|------|
| 首页 | `/` | 套餐展示、能力介绍、交付流程 |
| 登录 | `/login.html` | 带图形验证码 |
| 注册 | `/register.html` | 带图形验证码 |
| 我的服务 | `/services.html` | 已购服务列表 |
| 服务控制台 | `/service.html?id=N` | 单台 VPS 详情 + 运维操作（自包含页，防 IAB 缓存） |
| 用户中心 | `/profile.html` | 资料/改密/安全状态 |
| 结算 | `/pay/checkout.html?orderNo=X` | 多支付方式选择 |
| ABA KHQR | `/pay/aba-khqr.html` | KHQR 扫码支付页 |
| 支付结果 | `/pay/result.html` | 支付完成跳转 |
| 管理后台 | `/admin.html` | 套餐/库存/订单管理 |
| 用户管理 | `/admin-users.html` | 管理员管理所有用户 |
| 服务运维 | `/admin-service.html` | 管理员运维任意已售 VPS |
| 支付通道 | `/admin-pay-channels.html` | 支付方式管理 |

前端统一通过 `assets/app.js` 调用 API，JWT 存 `localStorage`，顶部导航显示当前用户身份 chip（下拉：资料 / 退出）。

---

## API 速查表

> 完整路由见各 controller；`🔒` = 需 JWT，`👑` = 需 admin。

### 认证 & 用户

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/auth/captcha` | 获取图形验证码 `{id, svg}` |
| POST | `/api/auth/register` | 注册（需 captchaId/code） |
| POST | `/api/auth/login` | 登录（需 captchaId/code） |
| GET | `/api/auth/me` 🔒 | 当前用户资料 |
| PATCH | `/api/auth/profile` 🔒 | 修改昵称/手机号 |
| POST | `/api/auth/change-password` 🔒 | 修改密码 |
| GET | `/api/auth/users` 👑 | 所有用户列表 |
| PATCH | `/api/auth/users/:id` 👑 | 编辑用户（资料/角色/状态/重置密码） |

### 套餐

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/plans` | 公开套餐列表 |
| GET | `/api/plans/:id` | 单个套餐 |
| GET | `/api/admin/plans` 👑 | 管理员列表 |
| POST | `/api/admin/plans` 👑 | 创建套餐 |
| PATCH | `/api/admin/plans/:id` 👑 | 更新套餐 |
| POST | `/api/admin/plans/:id/prices` 👑 | upsert 价格 |

### 库存

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/admin/inventory` 👑 | 库存列表（可 `?status=ready` 筛选） |
| POST | `/api/admin/inventory` 👑 | 录入库存 |
| POST | `/api/admin/inventory/:id/status` 👑 | 变更状态 |
| POST | `/api/admin/inventory/:id/test-connection` 👑 | 测试连接 |

### 订单 & 支付

| Method | Path | 说明 |
|--------|------|------|
| POST | `/api/orders` 🔒 | 创建订单 `{planId, currency}` |
| GET | `/api/orders` 🔒 | 我的订单 |
| GET | `/api/orders/:orderNo` 🔒 | 订单详情 |
| GET | `/api/orders/:orderNo/payment-status` 🔒 | 支付状态轮询 |
| POST | `/api/orders/:orderNo/pay` 🔒 | 发起支付 |
| GET | `/api/payments/methods` | 公开支付方式列表 |
| GET | `/api/payments/channels` | 公开启用通道 |
| POST | `/api/payments/jeepay/notify` | Jeepay 异步通知（无鉴权） |
| POST | `/api/payments/tokenpay/notify` | TokenPay 异步通知（无鉴权） |
| GET | `/api/admin/orders` 👑 | 全量订单 |
| POST | `/api/admin/orders/:id/retry-allocate` 👑 | 重试分配 |
| POST | `/api/admin/orders/:id/mark-paid` 👑 | 手动标记已付 |

### 服务

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/services` 🔒 | 我的服务 |
| GET | `/api/services/:id` 🔒 | 单个服务详情 |
| POST | `/api/services/:id/status-check` 🔒 | 状态检测 |
| POST | `/api/services/:id/reboot` 🔒 | 重启 |
| POST | `/api/services/:id/reset-password` 🔒 | 重置密码 |
| POST | `/api/services/:id/reinstall` 🔒 | 重装初始化 |
| POST | `/api/services/:id/renew` 🔒 | 续费（创建续费订单） |
| GET | `/api/admin/services` 👑 | 全量服务 |
| POST | `/api/admin/services/:id/status-check` 👑 | 管理员运维（同上 4 个操作） |
| POST | `/api/admin/services/:id/suspend` 👑 | 停用 |
| POST | `/api/admin/services/:id/recycle` 👑 | 回收 |
| POST | `/api/admin/tasks/expire-services` 👑 | 到期扫描 |

### 支付通道管理

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/admin/pay-channels` 👑 | 通道列表 |
| POST | `/api/admin/pay-channels` 👑 | 创建 |
| PATCH | `/api/admin/pay-channels/:id` 👑 | 更新 |
| DELETE | `/api/admin/pay-channels/:id` 👑 | 删除 |
| PATCH | `/api/admin/pay-channels/:id/toggle` 👑 | 启用/禁用 |

---

## 使用指南

### 管理员首次配置

1. **登录后台** → `/admin.html`（用 `.env` 里的 admin 邮箱/密码）
2. **创建套餐** → "新建套餐" 标签页
   - 名称、slug、地区展示、CPU/内存/磁盘
   - `matchRulesJson`：`{"regions":["us-west"],"min_cpu":2,"min_memory_mb":2048}`
   - CNY/USD 月价
3. **录入库存** → "库存机" 标签页
   - 填编号、驱动（`ssh` 或 `proxmox`）、IP、SSH 端口、用户名/密码
   - 状态流转：sourcing → optimizing → **ready**（只有 ready 才能售卖）
4. **配置支付通道** → `/admin-pay-channels.html`
   - 填入 Jeepay 商户参数（或运行 `node prisma/seed-pay-channels.js` 从 `.env` 种子初始化）
   - 启用需要的通道
5. **验证** → 前台访问 `/`，选套餐下单，走完支付流程

### 用户购买流程

1. 访问 `/`，浏览套餐
2. 注册/登录（带图形验证码）
3. 选套餐 + 币种 → 创建订单
4. `/pay/checkout.html` 选支付方式 → 跳转支付
5. 支付成功 → 自动交付 → `/services.html` 查看服务
6. 点"进入控制台" → `/service.html?id=N` 进行运维操作

### 管理员运维

- `/admin-service.html` 查看所有已售服务，可对任意 VPS 执行：状态检测、重启、重置密码、重装、停用、回收
- `/admin-users.html` 管理用户（改资料/角色/状态/重置密码）

### Proxmox 对接

详见 [`docs/PROXMOX-SETUP-STEP-BY-STEP.md`](docs/PROXMOX-SETUP-STEP-BY-STEP.md)：

1. 在 PVE 创建 API Token（如 `root@pam!panel`）
2. 录入库存时驱动选 `proxmox`，`authPayload` 填 `{tokenId, tokenSecret, node}`
3. 状态检测/重启走 PVE HTTP API（`:8006`），改密优先用 qemu-guest-agent

---

## 运维与常用命令

```bash
# PM2
pm2 status
pm2 logs vps-resale-api
pm2 restart vps-resale-api
pm2 stop vps-resale-api

# Nginx
nginx -t
systemctl reload nginx
tail -f /var/log/nginx/access.log

# 数据库
mysql -u vps -p vps_resale
npx prisma studio      # 可视化数据库（开发用）

# 构建
npx nest build
npx prisma generate
npx prisma db push --accept-data-loss

# 重新种子支付通道
node prisma/seed-pay-channels.js

# 端到端测试（需在 API 主机或能访问 API 的机器上）
ADMIN_EMAIL=admin@vps.local ADMIN_PASSWORD='your-pass' \
  bash flow_test.sh

# 健康检查
curl -s http://127.0.0.1/api/plans | head
curl -s http://127.0.0.1/api/auth/captcha | head -c 100
```

---

## 测试

```bash
cd apps/api

# 单元测试
npm test

# E2E 测试
npm run test:e2e

# 端到端业务流测试（需运行中的 API + Jeepay 配置）
ADMIN_EMAIL=admin@vps.local ADMIN_PASSWORD='...' \
  API_BASE=http://127.0.0.1:3000 \
  bash ../flow_test.sh
```

`flow_test.sh` 会：admin 登录 → 确保 ready 库存 → 注册买家 → 下单 → 发起支付 → 用 `JEEPAY_APP_SECRET` 签名模拟 Jeepay 通知 → 验证订单状态变为已支付 + 服务已创建。

---

## 常见问题

### Q: 忘记管理员密码？
A: 在数据库直接改，或删掉该 user 让 bootstrap 重新创建：
```sql
DELETE FROM users WHERE email='admin@vps.local';
-- 然后重启 API，bootstrap 会按 .env 重新创建
pm2 restart vps-resale-api
```

### Q: 下单提示"无库存"？
A: 库存状态必须是 `ready` 才能售卖。在后台库存管理把状态流转到 `ready`。

### Q: Jeepay 回调没收到？
A: 检查 `JEEPAY_NOTIFY_URL` 是否公网可达，Nginx 是否正确代理 `/api/`，以及 Jeepay 商户后台的回调地址配置。

### Q: `service.html` 在微信/钉钉内嵌浏览器打不开？
A: IAB 会激进缓存旧版 HTML/JS。`service.html` 已做成自包含页（自带 fallback 函数），但若仍卡在"加载中"，请用 Ctrl+F5 硬刷新，或清除 webview 缓存。

### Q: 如何切换支付通道？
A: 后台 `/admin-pay-channels.html` 增删改通道，或编辑 `.env` 的 `PAY_METHODS_ENABLED` 后重启。通道凭据在 `pay_channels` 表里 AES 加密存储。

### Q: `CREDENTIALS_SECRET` 能改吗？
A: **不能**（在已有数据后）。它是库存/支付通道凭据的加密密钥派生源，改了会无法解密历史数据。首次部署时务必设置一个足够长的随机值并妥善保管。

### Q: 如何对接新的上游 VPS？
A: 库存录入时选驱动 `ssh`（普通 SSH 主机）或 `proxmox`（PVE 虚拟机）。新增驱动类型需在 `src/services/` 实现 provider 并在 `services.service.ts` 分发。

---

## License

ISC © 2026
