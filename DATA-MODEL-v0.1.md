# 数据模型 · 状态机 · 页面清单（v0.1）

配套文档：`PRD-v0.1.md`

---

## 1. ER 关系（逻辑）

```text
users 1─N orders
users 1─N services
plans 1─N plan_prices
plans 1─N orders
plans 1─N services
orders 1─0..1 payments（可 1─N，v0.1 先 1 主支付单）
orders 0..1─0..1 inventory_servers（分配后绑定）
services 1─1 inventory_servers（售出后）
inventory_servers N─1 providers（逻辑枚举，不必独立表）
```

---

## 2. 表结构草案（MySQL）

### 2.1 users

```sql
id              BIGINT PK AI
email           VARCHAR(191) UNIQUE NOT NULL
password_hash   VARCHAR(255) NOT NULL
display_name    VARCHAR(64) NULL
role            ENUM('customer','admin') NOT NULL DEFAULT 'customer'
status          ENUM('active','blocked') NOT NULL DEFAULT 'active'
last_login_at   DATETIME NULL
created_at      DATETIME
updated_at      DATETIME
```

### 2.2 plans

```sql
id               BIGINT PK AI
name             VARCHAR(120) NOT NULL
slug             VARCHAR(120) UNIQUE NOT NULL
region_label     VARCHAR(64) NOT NULL
cpu              INT NOT NULL
memory_mb        INT NOT NULL
disk_gb          INT NOT NULL
bandwidth_label  VARCHAR(64) NULL
description      TEXT NULL
features_json    JSON NULL
match_rules_json JSON NULL
 -- 例: {"regions":["us-west"],"min_cpu":2,"min_memory_mb":2048,"tags_any":["bbr","cn-optimized"]}
is_enabled       TINYINT(1) NOT NULL DEFAULT 1
sort_order       INT NOT NULL DEFAULT 0
created_at       DATETIME
updated_at       DATETIME
```

### 2.3 plan_prices

```sql
id          BIGINT PK AI
plan_id     BIGINT NOT NULL
cycle       ENUM('monthly','quarterly','yearly') NOT NULL
price_cents INT NOT NULL
currency    CHAR(3) NOT NULL DEFAULT 'CNY'
is_enabled  TINYINT(1) NOT NULL DEFAULT 1
UNIQUE(plan_id, cycle, currency)
```

### 2.4 inventory_servers

```sql
id                      BIGINT PK AI
code                    VARCHAR(64) UNIQUE NOT NULL
provider                VARCHAR(32) NOT NULL
provider_ref            VARCHAR(128) NULL
ip                      VARCHAR(64) NOT NULL
ssh_port                INT NOT NULL DEFAULT 22
auth_payload_encrypted  TEXT NOT NULL
cpu                     INT NOT NULL
memory_mb               INT NOT NULL
disk_gb                 INT NOT NULL
region                  VARCHAR(64) NOT NULL
optimize_tags_json      JSON NULL
cost_cents              INT NULL
currency                CHAR(3) DEFAULT 'CNY'
upstream_expire_at      DATETIME NULL
status                  VARCHAR(32) NOT NULL
reserved_order_id       BIGINT NULL
sold_service_id         BIGINT NULL
notes                   TEXT NULL
optimized_checklist_json JSON NULL
created_at              DATETIME
updated_at              DATETIME

INDEX(status, region)
INDEX(upstream_expire_at)
```

### 2.5 orders

```sql
id                   BIGINT PK AI
order_no             VARCHAR(64) UNIQUE NOT NULL
user_id              BIGINT NOT NULL
plan_id              BIGINT NOT NULL
plan_price_id        BIGINT NOT NULL
cycle                VARCHAR(16) NOT NULL
amount_cents         INT NOT NULL
currency             CHAR(3) NOT NULL
status               VARCHAR(32) NOT NULL
pay_channel          VARCHAR(32) NULL
paid_at              DATETIME NULL
inventory_server_id  BIGINT NULL
client_remark        VARCHAR(255) NULL
admin_remark         VARCHAR(255) NULL
created_at           DATETIME
updated_at           DATETIME

INDEX(user_id, status)
INDEX(status, created_at)
```

### 2.6 payments

```sql
id              BIGINT PK AI
order_id        BIGINT NOT NULL
payment_no      VARCHAR(64) UNIQUE NOT NULL
channel         VARCHAR(32) NOT NULL
amount_cents    INT NOT NULL
currency        CHAR(3) NOT NULL
status          VARCHAR(32) NOT NULL
raw_notify_json JSON NULL
paid_at         DATETIME NULL
created_at      DATETIME
updated_at      DATETIME

INDEX(order_id)
```

### 2.7 services

```sql
id                    BIGINT PK AI
service_no            VARCHAR(64) UNIQUE NOT NULL
user_id               BIGINT NOT NULL
order_id              BIGINT NOT NULL
plan_id               BIGINT NOT NULL
inventory_server_id   BIGINT NOT NULL
status                VARCHAR(32) NOT NULL
start_at              DATETIME NULL
expire_at             DATETIME NOT NULL
deliver_payload_json  JSON NOT NULL
created_at            DATETIME
updated_at            DATETIME

INDEX(user_id, status)
INDEX(expire_at, status)
```

### 2.8 operation_logs

```sql
id           BIGINT PK AI
actor_type   VARCHAR(16) NOT NULL
actor_id     BIGINT NULL
action       VARCHAR(64) NOT NULL
target_type  VARCHAR(32) NULL
target_id    BIGINT NULL
ip           VARCHAR(64) NULL
meta_json    JSON NULL
created_at   DATETIME

INDEX(target_type, target_id)
INDEX(created_at)
```

---

## 3. 状态机详表

### 3.1 Inventory

```text
sourcing → optimizing → ready → reserved → sold → suspended → recycling → ready
                 ↘ retired
ready → retired
sold → recycling → retired
reserved → ready   (锁定超时释放)
```

**锁单 SQL 思想：**

```sql
UPDATE inventory_servers
SET status='reserved', reserved_order_id=:orderId
WHERE id=:id AND status='ready';
```

必须检查 affected_rows=1。

### 3.2 Order

```text
pending_payment → cancelled
pending_payment → paid → provisioning → completed
paid → wait_stock → provisioning → completed
paid/provisioning → failed
completed → refunded (P1)
```

### 3.3 Service

```text
pending → active → suspended → active
active → expired
suspended → expired
pending/active → cancelled
```

### 3.4 Payment

```text
pending → success
pending → failed
success 为终态（幂等）
```

---

## 4. API 清单（v0.1）

### Public / Customer

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET  /api/plans`
- `GET  /api/plans/:id`
- `POST /api/orders`
- `GET  /api/orders`
- `GET  /api/orders/:orderNo`
- `POST /api/orders/:orderNo/pay`
- `POST /api/payments/jeepay/notify`（回调）
- `GET  /api/services`
- `GET  /api/services/:id`
- `POST /api/services/:id/renew`

### Admin

- `CRUD /api/admin/plans`
- `CRUD /api/admin/plan-prices`
- `CRUD /api/admin/inventory`
- `POST /api/admin/inventory/:id/status`
- `GET  /api/admin/orders`
- `POST /api/admin/orders/:id/mark-paid`（manual）
- `POST /api/admin/orders/:id/assign`
- `GET  /api/admin/services`
- `POST /api/admin/services/:id/suspend`
- `POST /api/admin/services/:id/resume`
- `POST /api/admin/services/:id/recycle`
- `GET  /api/admin/dashboard`

---

## 5. 页面与接口映射（摘要）

| 页面 | 主要接口 |
|------|----------|
| 套餐列表 | GET /api/plans |
| 下单确认 | POST /api/orders |
| 支付 | POST /api/orders/:no/pay |
| 我的服务 | GET /api/services |
| 后台库存 | CRUD inventory |
| 后台订单详情 | assign / mark-paid |

---

## 6. 定时任务（v0.1 最小）

| 任务 | 频率 | 动作 |
|------|------|------|
| expire_services | 每 5–10 分钟 | active 且过期 → suspended/expired |
| release_reserved | 每 5 分钟 | reserved 超时回 ready |
| stock_alert | 每小时 | ready 数 < 阈值记日志/通知 |
| upstream_expire_alert | 每天 | 上游 7 日内到期预警 |

---

## 7. deliver_payload_json 示例

```json
{
  "ip": "203.0.113.10",
  "ssh_port": 22,
  "username": "root",
  "password": "********",
  "os": "Ubuntu 24.04",
  "optimized": ["bbr", "dns"],
  "notes": "请及时修改密码；禁止滥用。"
}
```

前台展示可对密码做首次查看/复制审计（P1）。
