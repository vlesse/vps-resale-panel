# 本地 Proxmox 对接面板 — 逐步操作手册

适用场景：你家里/机房有 **Proxmox VE**，想把某台虚拟机挂到  
`http://120.48.131.216`（RenrenYings 面板）上售卖，并让用户在控制台里：

- 刷新状态
- 重启
- 重置密码
- （可选）从模板真重装

> 面板 **不需要** 装在 PVE 上。面板在百度云，PVE 在本地，中间只要 **网络能通 8006**。

---

## 0. 先搞清楚三台「机器」分别是谁

| 角色 | 是什么 | 例子 |
|------|--------|------|
| A. 面板服务器 | 跑 NestJS 的百度 VPS | `120.48.131.216` |
| B. Proxmox 宿主机 | 你的虚拟化主机（管理口 8006） | `192.168.1.10` |
| C. 客户虚拟机 (VM) | 真正卖给用户的那台 Linux | VMID `101`，IP `10.0.0.101` 或公网 IP |

控制逻辑：

```
用户点「重启」
   → 面板 A 调 B 的 API（https://PVE:8006）
   → B 操作 C（虚拟机）
```

改密优先走 **Guest Agent**（B → C 的 qemu-guest-agent）；  
Agent 失败才用 **SSH**（面板 A 或 relaying 直连 C 的 22 端口——当前实现是面板服务器 SSH 到客户机 IP）。

所以长期要保证：

1. **A 能访问 B:8006**（必须，Proxmox 驱动核心）
2. **A 能 SSH 到 C**（强烈建议，改密回退 / 交付展示）
3. **用户能 SSH 到 C**（卖出去才有意义：公网 IP 或你提供的入口）

---

## 1. 网络打通（最容易卡死的一步）

面板在公网，PVE 多半在内网。**不要把 8006 裸映射到公网**。

### 方案推荐（三选一）

#### 方案 A：Tailscale（个人/小团队最省事）

1. 在 **PVE 宿主机** 安装 Tailscale，登录同一 tailnet  
2. 在 **百度面板** `120.48.131.216` 也安装 Tailscale，同一账号  
3. 记下 PVE 的 Tailscale IP，例如 `100.x.y.z`  
4. 面板里 **PVE Host** 填这个 `100.x.y.z`，不是家里的 `192.168.x.x`

验证（在百度面板上执行）：

```bash
curl -k https://100.x.y.z:8006/api2/json/version
```

有 JSON 返回（哪怕 401）就说明 TCP/TLS 通了。

#### 方案 B：WireGuard / 公司 SD-WAN

- 百度 VPS 与家中网关组网  
- 面板能路由到 PVE 内网 IP  
- Host 填内网 IP 即可

#### 方案 C：仅测试临时用（不推荐生产）

- 路由器端口转发 8006 + 强密码/Token + IP 白名单  
- 风险高，仅短测

### 本步检查清单

- [ ] 百度 SSH 登录后：`curl -k https://<PVE可达IP>:8006` 有响应  
- [ ] 不是「Connection timed out」  
- [ ] 防火墙（PVE `pve-firewall` / 家用路由 / ufw）放行来源

---

## 2. 在 Proxmox 创建 API Token

### 2.1 用网页创建（推荐）

1. 浏览器打开：`https://<PVE-IP>:8006`  
2. 用 `root@pam`（或管理员）登录  
3. 左侧点 **Datacenter（数据中心）**  
4. 点 **Permissions（权限）** → **API Tokens**  
5. 点 **Add（添加）**

填写示例：

| 字段 | 建议值 | 说明 |
|------|--------|------|
| User | `root@pam` | 也可用专用用户，更安全 |
| Token ID | `panel` | 任意英文，不要空格 |
| Privilege Separation | **勾选**（推荐） | 令牌权限可单独收紧 |
| Expire | 可空 | 空=不过期；生产建议设到期 |

6. 点添加后，会弹出 **Secret**（一长串，只显示一次）  
7. **立刻复制保存**，格式类似：  
   `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

### 2.2 你最终需要记的两样东西

- **Token ID 完整写法**：`用户!TokenID`  
  例：用户是 `root@pam`，Token ID 是 `panel` →  
  **`root@pam!panel`**
- **Token Secret**：刚才复制的那串

> 面板后台表单里：  
> - Token ID 填：`root@pam!panel`  
> - Token Secret 填：那串 secret  

### 2.3 权限（Privilege Separation 勾选时必配）

路径：**Datacenter → Permissions → Add → API Token Permission**

对 Token `root@pam!panel` 建议至少：

| Path | Role | 用途 |
|------|------|------|
| `/vms/<VMID>` 或 `/` | `PVEVMUser` 起步 | 查看/开关机往往不够 |
| 更稳妥 | 自定义角色或临时 `PVEAdmin` 测通 | 测通后再收紧 |

**功能对应权限（概念上）：**

| 面板动作 | 大致需要 |
|----------|----------|
| 刷新状态 | `VM.Audit` |
| 重启 | `VM.PowerMgmt` |
| Guest Agent 改密 | `VM.Monitor` / Agent 相关 + 客户机 agent |
| 模板重装（clone/destroy） | `VM.Allocate`, `VM.Clone`, `VM.Config.*`, `Datastore.AllocateSpace` 等 |

**建议流程：**

1. 先用较宽权限把「测连 + 状态 + 重启」跑通  
2. 再按最小权限收紧  

### 2.4 命令行创建 Token（可选）

SSH 上 PVE：

```bash
pveum user token add root@pam panel --privsep 1
```

输出里会有 `value`（Secret）。  
完整 Token ID 仍是：`root@pam!panel`。

---

## 3. 准备要出售的虚拟机（客户机 C）

### 3.1 基本要求

- 已创建 QEMU/KVM 虚拟机（不是 LXC；当前驱动按 **qemu** 写的）  
- 记下：
  - **Node 名**：PVE 网页左上角节点名，常见 `pve`  
  - **VMID**：例如 `101`  
  - **客户访问 IP**：用户 SSH 用的 IP（公网或你映射后的地址）  
  - **SSH 端口**：默认 22  
  - **root（或默认用户）密码**（可选但建议填，作回退）

### 3.2 安装并启用 qemu-guest-agent（强烈建议）

**在虚拟机 C 里面**（SSH 进客户机）执行：

#### Debian / Ubuntu

```bash
apt-get update
apt-get install -y qemu-guest-agent
systemctl enable --now qemu-guest-agent
```

#### CentOS / Rocky / Alma

```bash
yum install -y qemu-guest-agent
# 或 dnf install -y qemu-guest-agent
systemctl enable --now qemu-guest-agent
```

**在 Proxmox 网页上：**

1. 选中该 VM → **Options（选项）**  
2. **QEMU Guest Agent** → Edit → **Enabled** 勾选  
3. 如有需要，重启一次 VM  

验证（在 PVE 宿主机或 API）：

- 网页：VM 摘要里能看到 IP / Agent 信息，或  
- 命令：

```bash
qm agent 101 ping
```

`ping` 成功说明 Agent 通。

### 3.3 网络与用户可达

你要决定用户怎么登录 C：

- C 有公网 IP → 面板「客户访问 IP」填公网  
- C 只有内网 → 你需要自己做 FRP / 端口映射 / VPN 给用户，或只卖内网场景  

面板「客户访问 IP」字段 = **展示给用户、以及 SSH 回退用的地址**。

---

## 4.（可选）做 cloud-init 模板 — 才能「真重装」

不做这一步，控制台「重装」在 Proxmox 机器上会：

- 有 guest SSH → 走 SSH 基线初始化  
- 没有 → 直接失败  

### 4.1 做模板机（简要）

1. 新建一台 Ubuntu 22.04（举例），装 cloud-init、guest-agent、openssh-server  
2. 配好网卡（virtio）  
3. 关机  
4. 右键 → **Convert to template**  
5. 记下模板 **VMID**，例如 `9000`

### 4.2 面板里填

- **模板 VMID**：`9000`  
- **Clone 存储**：如 `local-lvm`（你实际用的存储名）  
- **ipconfig0**（可选）：`ip=10.0.0.101/24,gw=10.0.0.1`  
- **nameserver**（可选）：`8.8.8.8`  
- **ciUser**：一般 `root` 或 `ubuntu`（看模板）

### 4.3 重装行为（重要！先看再点）

用户点重装且配置了 templateVmid 时，面板会：

1. 停止当前 VMID  
2. **删除** 该 VMID（含磁盘 purge）  
3. 从模板 **full clone** 到 **同一个 VMID**  
4. 写 cloud-init 密码并开机  

等于「同编号重建」，**原盘数据会没**。售前必须说明。

---

## 5. 在销售面板录入库存

### 5.1 登录后台

1. 浏览器打开：  
   **http://120.48.131.216/login.html**  
2. 管理员账号（你环境当前为）：  
   - 邮箱：`admin@vps.local`  
   - 密码：部署时生成的 admin 密码（文档/此前交付记录里的 `Admin@...`）  
3. 登录后手动打开：  
   **http://120.48.131.216/admin.html**  
   （前台导航已隐藏后台入口，需自己记地址）

### 5.2 填写表单（字段对照）

上方通用字段：

| 字段 | 填什么 | 示例 |
|------|--------|------|
| 内部编号 code | 你自己的库存编号，唯一 | `PVE-101` |
| provider | 选 **proxmox** | `proxmox` |
| 客户访问 IP | 用户 SSH 的 IP | `203.0.113.10` 或 `10.0.0.101` |
| SSH 端口 | 一般 22 | `22` |
| 客户机用户名 | 系统用户 | `root` |
| 客户机密码 | 当前 root 密码（回退/交付） | `******` |
| CPU / 内存 MB / 磁盘 GB | 售卖规格展示 | `2` / `2048` / `40` |
| 地区 region | 用于套餐匹配 | `local-pve` |
| 优化标签 | 可选 | `bbr,cn-optimized` |

选 proxmox 后展开的 **Proxmox 连接**：

| 字段 | 填什么 | 示例 |
|------|--------|------|
| PVE Host | **面板能访问到的** PVE 地址 | Tailscale `100.x.y.z` 或内网 IP |
| PVE Port | 默认 8006 | `8006` |
| Node 名 | 节点名，不是随意起名 | `pve` |
| VMID | 虚拟机数字 ID | `101` |
| Token ID | `用户!名` | `root@pam!panel` |
| Token Secret | 创建时复制的 secret | `xxxx-...` |
| 模板 VMID | 可选，真重装用 | `9000` |
| Clone 存储 | 可选 | `local-lvm` |
| ipconfig0 | 可选 cloud-init | `ip=10.0.0.101/24,gw=10.0.0.1` |
| nameserver | 可选 | `8.8.8.8` |

> 没有 Token 时，可改填「API 用户 + API 密码」（`root@pam` + root 密码），**不推荐**，Token 更安全。

### 5.3 提交

点 **「添加并标 ready」**。  
成功后下方库存表应出现一行：`driver=proxmox`，状态 `ready`。

### 5.4 点「测连」

同一行操作里点 **测连**：

- 成功：弹窗里有 PVE version、VM status（running/stopped 等）  
- 失败：看报错  
  - `timeout` / `ECONNREFUSED` → 网络 8006 不通  
  - `401` / login failed → Token 错或权限不够  
  - `VM xxx not found` → Node 名或 VMID 错  

---

## 6. 套餐要能匹配到这台库存

库存 `region = local-pve` 时，套餐的 **匹配 region 列表** 里也要有 `local-pve`。

后台 → **新建套餐** 示例：

- 名称：`本地优化 2C2G`  
- slug：`local-2c2g`  
- 地区展示：`本地节点`  
- 匹配 region：`local-pve`  
- CPU/内存/磁盘与库存一致或更小规则  
- CNY/USD 月价按你定价  

保存后前台套餐列表可见；有 ready 库存才能下单。

---

## 7. 走一遍用户侧验证

1. 用普通用户注册/登录前台  
2. 购买对应套餐并完成支付（或你后台手动 mark paid / 测试支付）  
3. **我的服务** → **进入控制台**  
4. 依次测：

| 按钮 | 期望 |
|------|------|
| 刷新状态 | 显示 online/power、uptime、内存等；`source` 为 proxmox |
| 重启 | 成功后 VM 重启；稍后再刷新状态 |
| 重置密码 | 返回新密码；用新密码 SSH 客户机 |
| 重装 | 有模板：整机重建；无模板：SSH soft 或明确报错 |

控制台应显示控制面为 **hypervisor**（不暴露 PVE 地址）。

---

## 8. 用 API 录入（可选，适合批量）

先登录拿 admin token：

```bash
curl -s -X POST http://120.48.131.216/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@vps.local","password":"你的Admin密码"}'
```

创建库存：

```bash
curl -s -X POST http://120.48.131.216/api/admin/inventory \
  -H "Authorization: Bearer 这里填accessToken" \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "PVE-101",
    "provider": "proxmox",
    "ip": "10.0.0.101",
    "sshPort": 22,
    "username": "root",
    "password": "当前客户机密码可选",
    "cpu": 2,
    "memoryMb": 2048,
    "diskGb": 40,
    "region": "local-pve",
    "status": "ready",
    "optimizeTags": ["local","optimized"],
    "pve": {
      "host": "100.x.y.z",
      "port": 8006,
      "node": "pve",
      "vmid": 101,
      "tokenId": "root@pam!panel",
      "tokenSecret": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "templateVmid": 9000,
      "storage": "local-lvm",
      "ipconfig0": "ip=10.0.0.101/24,gw=10.0.0.1",
      "nameserver": "8.8.8.8",
      "ciUser": "root",
      "verifyTls": false
    }
  }'
```

测连：

```bash
curl -s -X POST http://120.48.131.216/api/admin/inventory/库存ID/test-connection \
  -H "Authorization: Bearer 这里填accessToken"
```

---

## 9. 常见问题排查

### 9.1 测连 Connection timeout

- 百度机器访问不了 PVE:8006  
- 查 Tailscale/WG 是否双方 online  
- PVE 防火墙是否放行  
- Host 是否填错成仅家用局域网 IP（面板不在同一网段时必挂）

### 9.2 401 / authentication failure

- Token ID 必须是 `user@realm!tokenid`，少写 `!panel` 会挂  
- Secret 复制少字符、多空格  
- Token 过期或被删  
- privsep 开了但没授任何权限

### 9.3 状态能刷，改密失败

- 客户机没装 guest-agent  
- VM Options 没启用 Agent  
- 客户机防火墙拦了 agent 通道（少见）  
- 填了错误的客户机用户名  
- 可再填对 SSH 密码，走回退

### 9.4 重启没反应

- Token 缺 `VM.PowerMgmt`  
- VM 已锁（备份/迁移中）  
- 看面板「最近操作」里的 errorMessage

### 9.5 重装失败

- 没填 templateVmid  
- 模板不在同一 node / 无 clone 权限  
- 存储名填错  
- 目标 VMID 被锁或磁盘清理未完成（可稍后重试）

### 9.6 用户买不到

- 库存不是 `ready`  
- 套餐 match region 与库存 region 不一致  
- CPU/内存匹配规则过严（min_cpu 等）

---

## 10. 安全建议（上线前必看）

1. **8006 只走内网/组网**，不要对全世界开放  
2. 用 **专用 API 用户 + 最小权限 Token**，不要长期用全能 root token  
3. Token Secret 只存在面板加密库；`CREDENTIALS_SECRET` 要足够强  
4. 模板重装会毁数据 → 商品页写清楚  
5. 售出后定期审计：谁点了重启/改密（`service_actions` 表）  
6. PVE 与面板都要改默认密码、关不必要端口  

---

## 11. 最短路径（你只想先测通）

按这个顺序做，30–60 分钟量级（网络已通的话更快）：

1. 百度与 PVE 装同一 Tailscale，curl 通 8006  
2. PVE 建 Token `root@pam!panel` + 临时较宽权限  
3. 客户机装 `qemu-guest-agent` 并在 Options 启用  
4. 后台 provider=proxmox 录入 Host/Node/VMID/Token + 客户 IP  
5. 点 **测连** 成功  
6. 套餐 region 对齐 → 下单交付  
7. 控制台点 **刷新状态 / 重启**  

模板重装可以第二阶段再做。

---

## 12. 你需要准备的「抄写清单」

填表前先在本子上写好：

```
PVE 可达 IP/Host: _______________
PVE Port: 8006
Node 名: _______________
VMID: _______________
Token ID: _______________@pam!_______________
Token Secret: _______________
客户访问 IP: _______________
SSH 端口: _______________
客户机用户: _______________
客户机当前密码: _______________
地区 region: local-pve
模板 VMID（可空）: _______________
存储名（可空）: _______________
```

全部齐了再打开：

**http://120.48.131.216/admin.html**

按第 5 节录入即可。

---

文档路径（仓库内）：`docs/PROXMOX-SETUP-STEP-BY-STEP.md`  
精简版：`docs/PROXMOX.md`
