import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as https from 'https';
import {
  CredentialCheckResult,
  MachineStatusSnapshot,
  MetricSeries,
  PowerState,
  ProviderContext,
  ProviderNotCapableError,
  ProxmoxCredentials,
  ProxmoxRef,
  ProvisionRequest,
  ProvisionResult,
  ResetPasswordResult,
  VpsProvider,
} from '../provider.types';
import { buildRemoteBootstrapCommand } from '../bootstrap.util';
import { probeMachine, setRootPassword, sleep, sshExec, waitForSsh } from '../ssh-exec.util';

/**
 * Proxmox VE 驱动 —— 给你自建的虚拟化节点用。
 *
 * 为什么值得单独做一个驱动：自建 PVE 的成本远低于云厂商，适合拿来做
 * 「内网节点」「大内存低价款」这类云厂商上不划算的套餐。
 *
 * 相比 ssh 驱动的优势是**有虚拟化层**，所以：
 *   开关机可靠  走 PVE API，关了还能远程开起来（ssh 驱动做不到）
 *   重装是真的  删掉 VM 从模板重新克隆，是货真价实的全新系统
 *   数据更准    PVE 自己就记着 CPU/内存/磁盘/网络，不用进机器采
 *
 * 前提是 PVE 要能被面板访问到（8006 端口）。PVE 在家里或内网的话，
 * 用 WireGuard / Tailscale 把面板和它打通，**不要把 8006 裸奔到公网上**。
 */

interface ProxmoxSpec {
  /** cloud-init 模板机的 VMID。要做「真重装」必须配。 */
  templateVmid?: number;
  /** 克隆到哪个存储，比如 local-lvm */
  storage?: string;
  /** 网桥，一般是 vmbr0 */
  bridge?: string;
  /** 克隆出的 VM 分配多少核 / 多少内存，不填就跟模板一样 */
  cores?: number;
  memoryMb?: number;
  enableBbr?: boolean;
}

@Injectable()
export class ProxmoxProvider implements VpsProvider {
  readonly kind = 'proxmox' as const;
  readonly canProvision = true;
  readonly canRebuild = true;
  readonly hasMetrics = true;

  private readonly logger = new Logger(ProxmoxProvider.name);

  // ---------- HTTP ----------

  private http(cred: ProxmoxCredentials): AxiosInstance {
    if (!cred?.host || !cred?.tokenId || !cred?.tokenSecret) {
      throw new Error('Proxmox 账号缺少 host / tokenId / tokenSecret');
    }
    return axios.create({
      baseURL: `https://${cred.host}:${cred.port ?? 8006}/api2/json`,
      timeout: 30000,
      headers: {
        Authorization: `PVEAPIToken=${cred.tokenId}=${cred.tokenSecret}`,
      },
      // PVE 装好默认是自签证书，绝大多数人不会去换成正式证书，
      // 所以默认允许自签。想严格校验就在账号里把 rejectUnauthorized 设成 true。
      httpsAgent: new https.Agent({
        rejectUnauthorized: cred.rejectUnauthorized === true,
      }),
    });
  }

  private cred(ctx: ProviderContext): ProxmoxCredentials {
    return ctx.credentials as ProxmoxCredentials;
  }

  private pveRef(ctx: ProviderContext): ProxmoxRef {
    const ref = ctx.ref as ProxmoxRef;
    if (!ref?.vmid) throw new Error('这台机器缺少 Proxmox 的虚拟机编号（vmid），无法操作');
    return { node: ref.node || this.cred(ctx).node, vmid: Number(ref.vmid) };
  }

  // ---------- 凭据校验 ----------

  async verifyCredentials(credentials: ProxmoxCredentials): Promise<CredentialCheckResult> {
    try {
      const http = this.http(credentials);
      const version = await http.get('/version');
      const nodes = await http.get('/nodes');
      const names: string[] = (nodes.data?.data ?? []).map((n: any) => n.node);
      if (credentials.node && !names.includes(credentials.node)) {
        return {
          ok: false,
          message: `节点名 ${credentials.node} 不存在。这台 PVE 上的节点有：${names.join('、')}`,
        };
      }
      return {
        ok: true,
        message: '连接成功',
        detail: {
          PVE版本: version.data?.data?.version,
          节点: names.join('、'),
        },
      };
    } catch (err: any) {
      return { ok: false, message: this.explain(err) };
    }
  }

  // ---------- 建机（从模板克隆） ----------

  async provision(ctx: ProviderContext, req: ProvisionRequest): Promise<ProvisionResult> {
    const cred = this.cred(ctx);
    const spec = (req.spec ?? {}) as ProxmoxSpec;
    const progress = req.onProgress ?? (() => undefined);

    // 已经有 vmid 说明是库存模式（管理员提前建好的），只做初始化不建机
    if ((ctx.ref as ProxmoxRef)?.vmid) {
      return this.prepareExisting(ctx, req);
    }

    if (!spec.templateVmid) {
      throw new Error(
        '套餐没有配 cloud-init 模板机编号（templateVmid），无法自动建机。' +
          '要么在套餐里配上模板，要么把这个套餐改成库存池模式。',
      );
    }

    const http = this.http(cred);
    const node = cred.node;

    await progress(10, '申请虚拟机编号');
    const nextId = await http.get('/cluster/nextid');
    const vmid = Number(nextId.data?.data);

    await progress(20, '从模板克隆虚拟机');
    const cloneRes = await http.post(`/nodes/${node}/qemu/${spec.templateVmid}/clone`, {
      newid: vmid,
      name: req.code.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60),
      full: 1,
      ...(spec.storage ? { storage: spec.storage } : {}),
    });
    await this.waitTask(http, node, cloneRes.data?.data, 600000, (p) =>
      progress(20 + Math.round(p * 30), '克隆中'),
    );

    await progress(55, '写入 cloud-init 配置');
    await http.post(`/nodes/${node}/qemu/${vmid}/config`, {
      ciuser: 'root',
      cipassword: req.password,
      sshkeys: encodeURIComponent(req.publicKeyOpenssh),
      ipconfig0: 'ip=dhcp',
      ...(spec.cores ? { cores: spec.cores } : {}),
      ...(spec.memoryMb ? { memory: spec.memoryMb } : {}),
      ...(spec.bridge ? { net0: `virtio,bridge=${spec.bridge}` } : {}),
    });

    await progress(65, '启动虚拟机');
    const startRes = await http.post(`/nodes/${node}/qemu/${vmid}/status/start`);
    await this.waitTask(http, node, startRes.data?.data, 120000);

    await progress(75, '等待虚拟机拿到 IP');
    const ip = await this.waitForIp(http, node, vmid, 180000);

    const ref: ProxmoxRef = { node, vmid };
    const auth = {
      sshUser: 'root',
      sshPort: 22,
      password: req.password,
      privateKey: req.privateKeyPem,
    };

    await progress(88, '等待 SSH 就绪');
    await waitForSsh({ host: ip, auth }, { timeoutMs: 180000, intervalMs: 5000 });

    await progress(95, '初始化完成');
    return { ref, ip, auth, raw: { vmid, node, clonedFrom: spec.templateVmid } };
  }

  /** 库存模式：VM 已存在，只把凭据换成买家的 */
  private async prepareExisting(
    ctx: ProviderContext,
    req: ProvisionRequest,
  ): Promise<ProvisionResult> {
    const ref = this.pveRef(ctx);
    const progress = req.onProgress ?? (() => undefined);
    if (!ctx.ip || !ctx.auth) {
      throw new Error('这台 PVE 虚拟机还没录入 IP 和登录凭据，无法交付');
    }

    await progress(30, '连接虚拟机');
    const target = { host: ctx.ip, auth: ctx.auth };
    await waitForSsh(target, { timeoutMs: 60000, intervalMs: 5000 });

    await progress(60, '写入新的登录凭据');
    const res = await sshExec(
      target,
      buildRemoteBootstrapCommand({
        username: ctx.auth.sshUser || 'root',
        password: req.password,
        publicKeyOpenssh: req.publicKeyOpenssh,
        hostname: req.hostname,
        enableBbr: (req.spec as ProxmoxSpec)?.enableBbr !== false,
      }),
      90000,
    );
    if (res.code !== 0) throw new Error(`初始化脚本执行失败：${res.stderr || res.stdout}`);

    await progress(95, '初始化完成');
    return {
      ref,
      ip: ctx.ip,
      auth: {
        sshUser: ctx.auth.sshUser || 'root',
        sshPort: ctx.auth.sshPort || 22,
        password: req.password,
        privateKey: req.privateKeyPem,
      },
    };
  }

  // ---------- 状态 ----------

  async getStatus(ctx: ProviderContext): Promise<MachineStatusSnapshot> {
    const ref = this.pveRef(ctx);
    const http = this.http(this.cred(ctx));
    const res = await http.get(`/nodes/${ref.node}/qemu/${ref.vmid}/status/current`);
    const d = res.data?.data ?? {};

    const power: PowerState =
      d.status === 'running' ? 'running' : d.status === 'stopped' ? 'stopped' : 'unknown';

    // PVE 自己就记着这些数，不用进机器采 —— 而且关机状态下也读得到配额
    const snapshot: MachineStatusSnapshot = {
      power,
      ip: ctx.ip,
      checkedAt: new Date().toISOString(),
      cpuPercent: d.cpu != null ? Math.round(d.cpu * 100) : undefined,
      memUsedMb: d.mem != null ? Math.round(d.mem / 1048576) : undefined,
      memTotalMb: d.maxmem != null ? Math.round(d.maxmem / 1048576) : undefined,
      diskTotalGb: d.maxdisk != null ? Math.round(d.maxdisk / 1073741824) : undefined,
      uptimeSec: d.uptime,
      netInBytes: d.netin,
      netOutBytes: d.netout,
      raw: { pveStatus: d.status, qmpstatus: d.qmpstatus },
    };

    // 磁盘已用量 PVE 看不到（那是虚拟机内部的事），能进去就补一下
    if (power === 'running' && ctx.ip && ctx.auth) {
      try {
        const probe = await probeMachine({ host: ctx.ip, auth: ctx.auth });
        snapshot.diskUsedGb = probe.diskUsedGb;
        snapshot.loadAvg1 = probe.loadAvg1;
      } catch {
        // 采不到就算了，PVE 给的数据已经够显示了
      }
    }
    return snapshot;
  }

  // ---------- 电源 ----------

  async start(ctx: ProviderContext): Promise<void> {
    await this.power(ctx, 'start');
  }

  /** shutdown 是优雅关机（要装 guest-agent），失败就 stop 硬断电 */
  async stop(ctx: ProviderContext): Promise<void> {
    try {
      await this.power(ctx, 'shutdown');
    } catch {
      await this.power(ctx, 'stop');
    }
  }

  async reboot(ctx: ProviderContext): Promise<void> {
    try {
      await this.power(ctx, 'reboot');
    } catch {
      await this.power(ctx, 'reset');
    }
  }

  private async power(
    ctx: ProviderContext,
    action: 'start' | 'stop' | 'shutdown' | 'reboot' | 'reset',
  ): Promise<void> {
    const ref = this.pveRef(ctx);
    const http = this.http(this.cred(ctx));
    try {
      const res = await http.post(`/nodes/${ref.node}/qemu/${ref.vmid}/status/${action}`);
      await this.waitTask(http, ref.node, res.data?.data, 120000);
    } catch (err: any) {
      throw new Error(this.explain(err));
    }
  }

  // ---------- 改密 ----------

  /**
   * 优先走 guest-agent（不需要密码就能改，机器锁死了也救得回来），
   * agent 没装再退回 SSH。
   */
  async resetPassword(ctx: ProviderContext, newPassword: string): Promise<ResetPasswordResult> {
    const ref = this.pveRef(ctx);
    const http = this.http(this.cred(ctx));
    const username = ctx.auth?.sshUser || 'root';

    try {
      await http.post(`/nodes/${ref.node}/qemu/${ref.vmid}/agent/set-user-password`, {
        username,
        password: newPassword,
        crypted: 0,
      });
      return { username, password: newPassword };
    } catch (err: any) {
      this.logger.warn(`guest-agent 改密失败，退回 SSH：${err.message}`);
    }

    if (!ctx.ip || !ctx.auth) {
      throw new Error(
        '这台虚拟机没装 qemu-guest-agent，也没有可用的 SSH 凭据，改不了密码。' +
          '建议在模板机里装上 guest-agent 再重新克隆。',
      );
    }
    await setRootPassword({ host: ctx.ip, auth: ctx.auth }, username, newPassword);
    return { username, password: newPassword };
  }

  // ---------- 重装 ----------

  /** 配了模板就是真重装（删了重克隆），没配就只能软重置 */
  async rebuild(ctx: ProviderContext, req: ProvisionRequest): Promise<ProvisionResult> {
    const spec = (req.spec ?? {}) as ProxmoxSpec;
    const ref = this.pveRef(ctx);
    const progress = req.onProgress ?? (() => undefined);

    if (!spec.templateVmid) {
      throw new ProviderNotCapableError(
        'proxmox',
        '模板重装（套餐里没配 templateVmid，只能做软重置）',
      );
    }

    const http = this.http(this.cred(ctx));
    await progress(10, '销毁旧虚拟机');
    await this.power(ctx, 'stop').catch(() => undefined);
    await sleep(3000);
    const delRes = await http.delete(`/nodes/${ref.node}/qemu/${ref.vmid}`, {
      params: { purge: 1, 'destroy-unreferenced-disks': 1 },
    });
    await this.waitTask(http, ref.node, delRes.data?.data, 300000);

    await progress(25, '从模板重新克隆');
    return this.provision(
      { ...ctx, ref: undefined },
      { ...req, onProgress: async (p, s) => progress(25 + Math.round(p * 0.75), s) },
    );
  }

  // ---------- 销毁 ----------

  async release(ctx: ProviderContext): Promise<void> {
    const ref = this.pveRef(ctx);
    const http = this.http(this.cred(ctx));
    await this.power(ctx, 'stop').catch(() => undefined);
    await sleep(3000);
    try {
      const res = await http.delete(`/nodes/${ref.node}/qemu/${ref.vmid}`, {
        params: { purge: 1, 'destroy-unreferenced-disks': 1 },
      });
      await this.waitTask(http, ref.node, res.data?.data, 300000);
    } catch (err: any) {
      if (err?.response?.status === 500 && /does not exist/i.test(err?.message ?? '')) return;
      throw new Error(this.explain(err));
    }
  }

  // ---------- 监控 ----------

  async metrics(ctx: ProviderContext, hours = 24): Promise<MetricSeries[]> {
    const ref = this.pveRef(ctx);
    const http = this.http(this.cred(ctx));
    const timeframe = hours <= 1 ? 'hour' : hours <= 24 ? 'day' : hours <= 168 ? 'week' : 'month';

    const res = await http.get(`/nodes/${ref.node}/qemu/${ref.vmid}/rrddata`, {
      params: { timeframe, cf: 'AVERAGE' },
    });
    const rows: any[] = res.data?.data ?? [];

    const series = (key: MetricSeries['key'], field: string, label: string, unit: string, scale = 1) => ({
      key,
      label,
      unit,
      points: rows
        .filter((r) => r.time != null && r[field] != null)
        .map((r) => ({ t: new Date(r.time * 1000).toISOString(), v: Number(r[field]) * scale })),
    });

    return [
      series('cpu', 'cpu', 'CPU 使用率', '%', 100),
      series('net_in', 'netin', '入站流量', 'B'),
      series('net_out', 'netout', '出站流量', 'B'),
    ];
  }

  // ---------- 内部工具 ----------

  /** PVE 的写操作都返回一个任务 ID（UPID），要轮询到它结束 */
  private async waitTask(
    http: AxiosInstance,
    node: string,
    upid: string | undefined,
    timeoutMs: number,
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    if (!upid) return;
    const deadline = Date.now() + timeoutMs;
    let ticks = 0;
    while (Date.now() < deadline) {
      const res = await http.get(`/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
      const d = res.data?.data ?? {};
      if (d.status === 'stopped') {
        if (d.exitstatus && d.exitstatus !== 'OK') {
          throw new Error(`PVE 任务失败：${d.exitstatus}`);
        }
        return;
      }
      ticks++;
      onProgress?.(Math.min(95, ticks * 5));
      await sleep(3000);
    }
    throw new Error(`PVE 任务超过 ${Math.round(timeoutMs / 1000)} 秒仍未结束`);
  }

  /** 通过 guest-agent 问虚拟机自己的 IP。装了 agent 才行。 */
  private async waitForIp(
    http: AxiosInstance,
    node: string,
    vmid: number,
    timeoutMs: number,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await http.get(`/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`);
        const ifaces: any[] = res.data?.data?.result ?? [];
        for (const i of ifaces) {
          if (i.name === 'lo') continue;
          for (const a of i['ip-addresses'] ?? []) {
            if (a['ip-address-type'] === 'ipv4' && !a['ip-address'].startsWith('127.')) {
              return a['ip-address'];
            }
          }
        }
      } catch {
        // agent 还没起来，继续等
      }
      await sleep(5000);
    }
    throw new Error(
      '等了很久也没从 qemu-guest-agent 拿到 IP。请确认模板机里装了 qemu-guest-agent，' +
        '并且在虚拟机选项里启用了 Guest Agent。',
    );
  }

  private explain(err: any): string {
    const status = err?.response?.status;
    const body = err?.response?.data;
    const msg: string = body?.errors ? JSON.stringify(body.errors) : err?.message ?? String(err);

    if (status === 401) {
      return 'PVE 拒绝了这个 API Token。检查 tokenId 格式（应该像 root@pam!panel）和密钥有没有抄错';
    }
    if (status === 403) {
      return (
        'API Token 权限不够。到 PVE 的「数据中心 → 权限」里给它加上 VM.Audit、VM.PowerMgmt、' +
        'VM.Config.Options、VM.Config.Cloudinit；要做重装还需要 VM.Allocate、VM.Clone、Datastore.AllocateSpace'
      );
    }
    if (status === 596 || /ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
      return `连不上 PVE（${msg}）。检查地址和 8006 端口，PVE 在内网的话确认面板这台机器能访问到它`;
    }
    if (/self.signed|CERT_|unable to verify/i.test(msg)) {
      return 'PVE 用的是自签证书。把云账号里的 rejectUnauthorized 设成 false（或留空）即可';
    }
    return `PVE 返回错误：${msg}`;
  }
}
