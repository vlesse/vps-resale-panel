# Proxmox 自建节点对接说明

本面板支持把 **Proxmox VE** 虚拟机作为库存入库，用户控制台操作会走 PVE API（不是展示上游品牌）。

## 能力对照

| 控制台动作 | Proxmox 实现 | 备注 |
|---|---|---|
| 刷新状态 | `GET /nodes/{node}/qemu/{vmid}/status/current` + 可选 guest-agent 网卡 | 关机也能看到 power 状态 |
| 重启 | `POST .../status/reboot`，失败则 `reset` | 不依赖 SSH |
| 重置密码 | 优先 `agent/set-user-password`，失败回退 SSH | 需 qemu-guest-agent |
| 重装 | 有 `templateVmid`：删 VM → clone 模板 → cloud-init 密码 → start | 无模板则仅 SSH soft reinit |

## PVE 侧准备

1. 建 API Token（推荐）  
   Datacenter → Permissions → API Tokens  
   例：`root@pam!panel`，复制 Secret（只显示一次）。

2. 权限建议（最小可用）  
   - `VM.Audit`  
   - `VM.PowerMgmt`  
   - `VM.Config.Options` / `VM.Config.Cloudinit`  
   - 重装还需要：`VM.Allocate`、`VM.Clone`、`Datastore.AllocateSpace` 等

3. 客户机装好 **qemu-guest-agent**，并在 VM Options 里启用 Guest Agent。

4. （可选）准备 cloud-init 模板机，记下模板 VMID，用于「真重装」。

5. 面板服务器（百度 VPS）必须能访问 `https://PVE_IP:8006`。  
   若 PVE 在家里/内网，用 WireGuard / Tailscale / 专线打通，不要裸暴露 8006 到公网。

## 后台录入

打开 `/admin.html` → 库存管理：

- provider 选 **proxmox**
- 填：PVE Host / Node / VMID / Token
- 客户访问 IP：用户看到的 SSH IP
- 客户机密码：可选，作 guest SSH 回退与交付展示
- 模板 VMID：要「模板重装」时必填

也可用 API：

```bash
curl -X POST http://YOUR_PANEL/api/admin/inventory \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "PVE-101",
    "provider": "proxmox",
    "ip": "10.0.0.101",
    "sshPort": 22,
    "username": "root",
    "password": "optional-guest-ssh",
    "cpu": 2,
    "memoryMb": 2048,
    "diskGb": 40,
    "region": "local-pve",
    "status": "ready",
    "pve": {
      "host": "192.168.1.10",
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

测连通：

```bash
curl -X POST http://YOUR_PANEL/api/admin/inventory/{id}/test-connection \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## 与 SSH 成品机的区别

- `provider=ssh`（或 cloudcone 等非 proxmox）：状态/重启/改密/软重装走 **SSH**
- `provider=proxmox`：状态/重启走 **PVE API**；改密优先 guest-agent；重装优先模板克隆

前台对用户只展示控制面类型（hypervisor / agent），不暴露 PVE 地址。

## 安全注意

- Token/密码 AES 加密存库（`CREDENTIALS_SECRET`）
- 生产务必轮换默认 secret
- PVE 管理口仅内网可达
- 模板重装会 **销毁同 VMID 原盘**，售前说明清楚
