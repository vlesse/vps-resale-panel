# 多上游优化 VPS 转售平台 PRD v0.1

> 定位：从 CloudCone / AWS / 绿盟云 / 阿里云 / 私有服务器等上游获取机器，完成链路与环境优化后，进行二次售卖的轻量商用面板。  
> 模式：**库存式转售（Inventory-based Resale）**，不是自建虚拟化云厂商。  
> 版本目标：跑通完整基础业务闭环，不追求功能大而全。

---

## 1. 背景与目标

### 1.1 业务背景

运营方从多个上游采购或持有 VPS，经过以下增值后再销售：

- 线路/链路优化（回国、出国、分流、隧道等）
- 系统与网络环境优化（BBR、DNS、安全基线、常用组件）
- 统一交付与售后体验（一个面板查看、续费、申请重装等）

本质上是：

```text
上游机器 → 优化包装 → 统一套餐售卖 → 交付与续费运营
```

### 1.2 产品目标（v0.1）

1. 用户可浏览套餐、下单、支付、获得已优化 VPS 交付信息。
2. 后台可管理库存机、套餐、订单、用户实例、到期状态。
3. 以**库存分配**完成开通，不依赖第一版就对接全部上游 API。
4. 状态机完整，避免超卖、漏交付、到期不处理。
5. 为后续自动补货、监控（Beszel）、多支付渠道预留扩展点。

### 1.3 非目标（v0.1 明确不做）

- 自研虚拟化调度 / 超卖内核
- 一次性对接所有云厂商 API
- 完整代理商体系、复杂优惠引擎
- 按小时计费、流量包精细计费
- 自动迁移、快照中心、救援控制台大而全
- 以 Beszel 作为主业务底子（Beszel 仅后续监控附件）

---

## 2. 用户角色

| 角色 | 说明 | 核心诉求 |
|------|------|----------|
| 访客 | 未登录用户 | 看套餐、了解优化卖点 |
| 客户 | 已注册购买用户 | 下单、支付、查看实例、续费、提单 |
| 运营/管理员 | 平台运营者 | 录库存、优化标记、处理订单、停机回收 |
| 系统任务 | 定时任务 | 到期检查、库存预警、支付对账（可后置） |

v0.1 仅两类登录主体：`customer`、`admin`。

---

## 3. 核心业务对象

### 3.1 套餐 Plan（对外商品）

对外销售单元，不直接等于某台上游机器。

示例字段语义：

- 名称：如「美西优化-2C2G」
- 地区/用途标签：美国 / 回国优化 / 高可用等
- 配置展示：CPU / 内存 / 磁盘 / 带宽 / 流量口径
- 周期与价格：月付/季付/年付
- 绑定库存匹配规则：地区、配置下限、优化标签

### 3.2 库存机 Inventory Server（对内资产）

真实持有的上游机器，是转售核心。

关键点：

- 有成本、有上游到期日
- 有优化状态
- 有可售状态
- 售出后绑定用户服务

### 3.3 订单 Order

一次购买行为，连接支付与分配。

### 3.4 用户服务 Service / Instance

用户已购并正在使用（或已到期）的服务实例。

### 3.5 支付单 Payment

对接 Jeepay 或其他渠道的支付记录。

---

## 4. 主流程

### 4.1 运营侧：入库与上架

```text
上游采购/已有机器
  → 录入库存（sourcing）
  → 执行优化流水线（optimizing）
  → 验收通过（ready）
  → 可被套餐匹配售卖
```

优化流水线（标准动作，可先手工勾选完成）：

1. SSH 可达性与基础信息验收
2. 安全基线（SSH 端口/密钥/防火墙最小集，后置强制也行）
3. 网络优化（BBR/DNS/可选隧道）
4. 监控 Agent 预留（Beszel，后置）
5. 生成交付模板（默认账号策略、说明文案）
6. 标记 `ready`

### 4.2 用户侧：购买与交付

```text
选择套餐
  → 创建订单（pending_payment）
  → 发起支付
  → 支付成功（paid）
  → 锁定 1 台 ready 库存（reserved → sold）
  → 创建用户服务（active）
  → 展示交付信息（IP/端口/账密/说明）
```

若无库存（已确认规则）：

```text
下单前校验 ready 库存
  → 不足：直接拒绝创建订单（不生成待支付单，不进入 wait_stock）
```

### 4.3 续费

```text
服务到期前续费
  → 生成续费订单并支付
  → 延长 service.expire_at
```

v0.1 续费不更换机器，只延长当前服务。

### 4.4 到期与停用

```text
expire_at < now
  → service = expired/suspended
  → 库存机标记 suspended_for_customer 或进入回收流程
  → 运营决定回收重售 / 保留宽限期
```

v0.1 建议：

- 到期后状态变为 `suspended`
- 保留宽限字段（如 1–3 天）但可先不做自动回收
- 后台提供「回收到可售库存」操作

### 4.5 重装 / 改密 / 重启（v0.1 半自动）

用户提交申请工单或操作申请 → 后台处理 → 回填结果。  
第一版不要求全自动调用上游 API。

---

## 5. 状态机（必须完整）

### 5.1 库存机状态 `inventory_servers.status`

| 状态 | 含义 | 可转至 |
|------|------|--------|
| `sourcing` | 刚录入，未验收 | optimizing, retired |
| `optimizing` | 优化中 | ready, sourcing, retired |
| `ready` | 可售 | reserved, retired |
| `reserved` | 下单锁定中 | sold, ready |
| `sold` | 已售出绑定用户 | suspended, recycling |
| `suspended` | 用户侧停用/到期停 | sold(恢复), recycling |
| `recycling` | 回收清理中 | ready, retired |
| `retired` | 淘汰/上游到期丢弃 | - |

规则：

- 只有 `ready` 可被新订单锁定
- `reserved` 超时未完成交付可回滚 `ready`（防死锁）
- 禁止无状态直接超卖

### 5.2 订单状态 `orders.status`

| 状态 | 含义 |
|------|------|
| `pending_payment` | 待支付 |
| `paid` | 已支付，待分配 |
| `provisioning` | 分配/交付中 |
| `completed` | 已交付 |
| `wait_stock` | 已支付但无库存 |
| `cancelled` | 取消 |
| `refunded` | 退款（可后置完整退款流） |
| `failed` | 失败 |

主路径：

```text
pending_payment → paid → provisioning → completed
                 ↘ wait_stock → provisioning → completed
```

### 5.3 用户服务状态 `services.status`

| 状态 | 含义 |
|------|------|
| `pending` | 等待交付 |
| `active` | 正常可用 |
| `suspended` | 停用（到期/违规/欠费） |
| `expired` | 到期结束 |
| `cancelled` | 取消 |

---

## 6. 功能清单

### 6.1 用户前台

**P0（v0.1 必须）**

- 注册 / 登录 / 退出
- 套餐列表与详情
- 创建订单
- 支付跳转与支付结果页
- 我的服务列表
- 服务详情（交付信息、到期时间、状态）
- 续费入口
- 基础站内通知（可先极简）

**P1（可紧随）**

- 工单提交与查看
- 重装/改密/重启申请
- 公告

**P2（后期）**

- 优惠码
- 余额充值
- 发票
- 多用户子账号

### 6.2 管理后台

**P0**

- 管理员登录
- 套餐 CRUD
- 库存机 CRUD + 状态变更
- 订单列表与详情
- 手动分配库存
- 用户列表
- 服务列表与停用/恢复/回收
- 支付回调日志查看（排障）

**P1**

- 优化检查清单（勾选）
- 库存预警（ready 数量低于阈值）
- 上游到期预警
- 简单销售统计

**P2**

- 上游 API 驱动补货
- 批量脚本执行
- 代理商

---

## 7. 页面清单

### 7.1 用户端页面

| 页面 | 路径建议 | 说明 |
|------|----------|------|
| 首页 | `/` | 卖点与套餐入口 |
| 套餐列表 | `/plans` | 筛选地区/用途 |
| 套餐详情 | `/plans/:id` | 价格周期、说明 |
| 下单确认 | `/checkout` | 选周期、确认价格 |
| 支付中 | `/pay/:orderNo` | 跳转支付/展示二维码 |
| 支付结果 | `/pay/result` | 成功/失败 |
| 登录注册 | `/login` `/register` | |
| 我的服务 | `/services` | 列表 |
| 服务详情 | `/services/:id` | 交付信息 |
| 续费 | `/services/:id/renew` | |
| 工单列表/创建 | `/tickets` | P1 |

### 7.2 管理端页面

| 页面 | 路径建议 | 说明 |
|------|----------|------|
| 仪表盘 | `/admin` | 待处理订单、库存数 |
| 套餐管理 | `/admin/plans` | |
| 库存管理 | `/admin/inventory` | 核心页 |
| 库存详情 | `/admin/inventory/:id` | 优化项、成本、上游到期 |
| 订单管理 | `/admin/orders` | |
| 订单详情 | `/admin/orders/:id` | 手动分配 |
| 用户管理 | `/admin/users` | |
| 服务管理 | `/admin/services` | |
| 支付日志 | `/admin/payments` | |
| 系统配置 | `/admin/settings` | 站点名、阈值、宽限天数 |

---

## 8. 数据模型（逻辑模型）

> 实现时可落 MySQL。以下为 v0.1 最小完备模型。

### 8.1 `users`

- id
- email / username
- password_hash
- role: `customer` | `admin`
- status: `active` | `blocked`
- created_at, updated_at

### 8.2 `plans`

- id
- name
- slug
- region_label
- cpu / memory_mb / disk_gb / bandwidth_label
- description
- features_json（优化卖点）
- match_rules_json（匹配库存规则）
- is_enabled
- sort_order
- created_at, updated_at

### 8.3 `plan_prices`

- id
- plan_id
- cycle: `monthly` | `quarterly` | `yearly`
- price_cents
- currency: `CNY`/`USD`
- is_enabled

### 8.4 `inventory_servers`

- id
- code（内部编号）
- provider: `cloudcone` | `aws` | `lvmeng` | `aliyun` | `private` | `other`
- provider_ref（上游标识/备注）
- ip
- ssh_port
- auth_payload_encrypted（账密/密钥，加密存储）
- cpu / memory_mb / disk_gb
- region
- optimize_tags_json
- cost_cents
- upstream_expire_at
- status
- reserved_order_id nullable
- sold_service_id nullable
- notes
- created_at, updated_at

### 8.5 `orders`

- id
- order_no
- user_id
- plan_id
- plan_price_id
- cycle
- amount_cents
- currency
- status
- pay_channel
- paid_at
- inventory_server_id nullable
- remark
- created_at, updated_at

### 8.6 `payments`

- id
- order_id
- payment_no
- channel: `jeepay` | `manual` | ...
- amount_cents
- status: `pending` | `success` | `failed`
- raw_notify_json
- paid_at
- created_at, updated_at

### 8.7 `services`

- id
- service_no
- user_id
- order_id
- plan_id
- inventory_server_id
- status
- start_at
- expire_at
- deliver_payload_json（对用户可见交付信息快照）
- created_at, updated_at

### 8.8 `operation_logs`（强烈建议 P0）

- id
- actor_type: `user` | `admin` | `system`
- actor_id
- action
- target_type
- target_id
- meta_json
- created_at

### 8.9 `tickets`（P1）

- id, user_id, service_id nullable, title, content, status, created_at...

---

## 9. 关键业务规则

1. **禁止超卖（默认）**  
   分配时使用事务 + 行锁/状态条件更新：仅 `ready` → `reserved` 成功才继续。

2. **支付成功与分配解耦**  
   支付成功先落 `paid`，再异步/同步尝试分配；失败进入 `wait_stock`，不可丢单。

3. **交付快照**  
   服务创建时把 IP/端口/说明写入 `deliver_payload_json`，避免后期库存备注变更影响历史交付展示。

4. **成本可见仅后台**  
   成本、上游账号、真实 root 密码策略与前台展示分离。

5. **上游到期 > 用户体感**  
   若 `upstream_expire_at` 早于用户 `expire_at`，后台必须预警，避免卖出后断供。

6. **密码与密钥加密**  
   数据库中敏感凭据必须加密，不能明文。

7. **手动支付通道**  
   v0.1 可保留 `manual`（管理员标记已支付），便于内测。

---

## 10. 支付设计（结合现有 Jeepay）

### v0.1 路径

1. 创建订单  
2. 调用支付（Jeepay 或先 mock）  
3. 以支付回调为准更新订单  
4. 触发分配器

### 回调处理原则

- 验签
- 幂等（同一 payment_no 多次回调只处理一次）
- 先更新 payment，再驱动订单状态机
- 全量记录 raw notify

---

## 11. 分配器算法（v0.1）

输入：`plan_id` + 订单

步骤：

1. 读取 plan.match_rules
2. 查询 inventory：`status=ready` 且匹配规则
3. 排序策略（可配置）：
   - 优先上游到期更晚
   - 或优先成本更低
   - 或 FIFO
4. 条件更新锁定 1 台
5. 写 order.inventory_server_id
6. 创建 service，生成 deliver_payload
7. 库存改 `sold`，订单改 `completed`，服务改 `active`

无匹配：订单 `wait_stock`，通知管理员。

---

## 12. 权限与安全（v0.1 最小）

- 前后台分离路由
- 管理员与客户权限隔离
- 用户只能看自己的订单/服务
- 管理后台后续可加 IP 限制 / Cloudflare Access
- 操作日志保留关键动作：登录、改价、分配、停用、回收

安全加固可后置，但**凭据加密与权限隔离必须第一版就有**。

---

## 13. 监控与扩展点

- Beszel：独立部署，不进主业务库
- 后续：机器 `ready` 或 `sold` 后自动安装 agent
- Provision Driver 接口预留：

```text
ManualDriver（v0.1）
CloudConeDriver（后续）
ProxmoxDriver（后续）
AliyunDriver（后续）
```

v0.1 只实现 Manual + Inventory Allocate。

---

## 14. 合规与经营约束（写入产品认知）

1. 多上游转售可能违反部分厂商 ToS，需小范围验证与风险自担。  
2. 必须有滥用处理权：违规可 suspended。  
3. 对外展示避免虚假“自有云”表述，可写“优化 VPS / 精选节点”。  
4. 先私域/受控用户，再考虑公开售卖。  
5. 财务上区分：上游成本、售价、利润、退款。

---

## 15. MVP 范围冻结（v0.1）

### 做

- 用户注册登录
- 套餐与价格
- 库存录入与状态
- 下单
- 支付成功（可先 manual + 预留 Jeepay）
- 自动分配 ready 库存
- 我的服务与交付信息
- 续费延时
- 到期 suspended
- 后台手动处理 wait_stock
- 操作日志

### 不做

- 自动调用 AWS/阿里创建
- 完整工单系统复杂 SLA
- 代理分成
- 流量精算
- 多币种复杂税务

---

## 16. 技术默认建议（待你下一阶段确认实现）

> 你选了 A（先 PRD）。实现阶段默认如下，可改。

| 层 | 建议 |
|------|------|
| 后端 | Laravel 11（PHP）或 NestJS；若你更熟 Java 可用 Spring Boot |
| DB | MySQL 8（百度云已装） |
| 前端 | Vue3 / React 任一；后台可用现成 Admin 模板 |
| 部署 | Docker Compose 优先；当前机也可先裸机 PHP/Node |
| 支付 | Jeepay 回调对接 |
| 监控 | Beszel 独立 |

结合你已有 Jeepay / 面板运维习惯，**Laravel + MySQL + Vue** 通常最快做出这类业务台。

---

## 17. 验收标准（Definition of Done）

1. 管理员可录入 2 台库存并标 ready。  
2. 用户可下单并完成支付（或管理员 manual 支付）。  
3. 系统自动把 1 台 ready 分配给用户，库存变为 sold。  
4. 用户能在「我的服务」看到 IP/端口/说明。  
5. 第二笔订单在库存不足时进入 wait_stock，不丢单、不超卖。  
6. 续费后 expire_at 正确延长。  
7. 到期后服务变为 suspended。  
8. 关键操作有日志可查。  

---

## 18. 推荐实施顺序（A 之后）

1. 建库表与状态枚举  
2. 后台库存/套餐 CRUD  
3. 前台下单与订单状态  
4. 分配器  
5. 支付（先 manual，再 Jeepay）  
6. 我的服务与续费  
7. 到期任务  
8. 再挂 Beszel  

---

## 19. 已确认决策（2026-07-29）

1. **币种**：平台同时支持 **CNY + USD**；支付统一对接自建 **Jeepay 聚合支付**。  
2. **周期**：v0.1 **仅月付**（表结构可保留扩展，前台不开放季/年）。  
3. **无库存**：**禁止下单**（下单前校验 ready 库存，不足直接失败，不进入 wait_stock）。  
4. **技术栈**：**NestJS + Prisma + MySQL + 简易 Web 管理/用户页**（由实现方选定，便于对接 Jeepay 与快速迭代）。  
5. **支付**：**直接接 Jeepay**（unifiedOrder + 异步通知验签），不做 manual 主路径（可保留 admin 补单排障能力）。  

---

## 20. 一句话产品定义

> 一个面向多上游 VPS 的**优化转售控制台**：以库存机为中心，完成套餐售卖、支付、自动分配、交付、续费与到期停用；自动化开通与深度监控后置，先保证商业闭环正确。
