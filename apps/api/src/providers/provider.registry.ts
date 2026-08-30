import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decryptJson, tryDecryptJson } from '../crypto/crypto.util';
import {
  MachineAuth,
  ProviderContext,
  ProviderCredentials,
  ProviderKindValue,
  ProviderRef,
  VpsProvider,
} from './provider.types';
import { GcpProvider } from './drivers/gcp.provider';
import { LightsailProvider } from './drivers/lightsail.provider';
import { ProxmoxProvider } from './drivers/proxmox.provider';
import { SshProvider } from './drivers/ssh.provider';

/** 上层只跟这两个形状打交道，不用 import Prisma 的类型，方便单测 */
export interface MachineLike {
  id?: bigint | number;
  provider: string;
  ip?: string | null;
  sshPort?: number | null;
  providerRefJson?: unknown;
  authPayloadEncrypted?: string | null;
  /**
   * NAT 机器的对外落点。机器本身待在私网里，面板从公网连不到它的 ip，
   * 只能连网关映射出来的那个端口。查询时 include 了这一层就会自动用上，
   * 没 include 就当普通机器处理（对有公网 IP 的机器来说本来就是对的）。
   */
  natBinding?: { sshPort: number; gateway: { publicHost: string } } | null;
}

export interface CloudAccountLike {
  id?: bigint | number;
  provider: string;
  credentialsEncrypted: string;
}

/**
 * 驱动注册表。
 *
 * 上层（订单、控制台、到期任务）拿到一台机器，问这里要对应的驱动和调用上下文，
 * 然后统一调 provider.reboot(ctx) 这样的方法 —— 完全不需要知道机器是哪家云的。
 *
 * 加一家新云厂商只要做三件事：写一个实现 VpsProvider 的类、在这里注册、
 * 在 Prisma 的 ProviderKind 枚举里加一项。上层代码一行都不用改。
 */
@Injectable()
export class ProviderRegistry {
  private readonly drivers: Record<ProviderKindValue, VpsProvider>;

  constructor(
    private readonly config: ConfigService,
    gcp: GcpProvider,
    lightsail: LightsailProvider,
    ssh: SshProvider,
    proxmox: ProxmoxProvider,
  ) {
    this.drivers = { gcp, lightsail, ssh, proxmox };
  }

  /** 按类型取驱动 */
  get(kind: string): VpsProvider {
    const driver = this.drivers[kind as ProviderKindValue];
    if (!driver) {
      throw new Error(
        `不认识的驱动类型「${kind}」。目前支持：${Object.keys(this.drivers).join('、')}`,
      );
    }
    return driver;
  }

  all(): VpsProvider[] {
    return Object.values(this.drivers);
  }

  /** 能凭空建机的驱动。套餐选「下单即开」时只能选这些。 */
  provisionable(): VpsProvider[] {
    return this.all().filter((d) => d.canProvision);
  }

  private secret(): string {
    const s = this.config.get<string>('CREDENTIALS_SECRET');
    if (!s) throw new Error('.env 里没有配 CREDENTIALS_SECRET，无法解密凭据');
    return s;
  }

  /** 解开云账号的密钥。密钥被篡改会抛错，不会静默返回错数据。 */
  decryptCredentials(account?: CloudAccountLike | null): ProviderCredentials {
    if (!account?.credentialsEncrypted) return {};
    return decryptJson<ProviderCredentials>(this.secret(), account.credentialsEncrypted);
  }

  /** 解开机器的 SSH 凭据。解不开就当没有，让驱动自己报「缺少凭据」。 */
  decryptAuth(machine?: MachineLike | null): MachineAuth | undefined {
    if (!machine?.authPayloadEncrypted) return undefined;
    const auth = tryDecryptJson<MachineAuth>(this.secret(), machine.authPayloadEncrypted);
    if (!auth) return undefined;
    return {
      sshUser: auth.sshUser || 'root',
      // NAT 机器的凭据里存的是机器自己的 22 —— 那是私网里的事实，
      // 从面板这边过去要走网关映射出来的端口，所以映射优先。
      sshPort: machine.natBinding?.sshPort || auth.sshPort || machine.sshPort || 22,
      password: auth.password,
      privateKey: auth.privateKey,
    };
  }

  /** 面板该往哪个地址连这台机器。NAT 机器连的是网关，不是它自己的私网地址。 */
  reachableHost(machine: MachineLike): string | undefined {
    return machine.natBinding?.gateway.publicHost ?? machine.ip ?? undefined;
  }

  /** 把一台机器 + 它所属的云账号，组装成驱动能用的调用上下文 */
  contextFor(machine: MachineLike, account?: CloudAccountLike | null): ProviderContext {
    return {
      credentials: this.decryptCredentials(account),
      ref: (machine.providerRefJson ?? {}) as ProviderRef,
      auth: this.decryptAuth(machine),
      ip: this.reachableHost(machine),
    };
  }

  /** 后台点「测试连接」用：只有凭据，还没有具体机器 */
  contextForAccount(account: CloudAccountLike): ProviderContext {
    return { credentials: this.decryptCredentials(account) };
  }

  /** 前端要显示「这台机器能点哪些按钮」，靠这个 */
  capabilities(kind: string) {
    const d = this.get(kind);
    return {
      kind: d.kind,
      canProvision: d.canProvision,
      canRebuild: d.canRebuild,
      hasMetrics: d.hasMetrics,
      // ssh 驱动没有带外管理，关机了就叫不醒，所以不给开机按钮
      canPowerOn: d.kind !== 'ssh',
    };
  }
}
