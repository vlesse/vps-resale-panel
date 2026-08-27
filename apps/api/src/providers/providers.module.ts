import { Global, Module } from '@nestjs/common';
import { ProviderRegistry } from './provider.registry';
import { GcpProvider } from './drivers/gcp.provider';
import { LightsailProvider } from './drivers/lightsail.provider';
import { SshProvider } from './drivers/ssh.provider';
import { ProxmoxProvider } from './drivers/proxmox.provider';

/**
 * 驱动层。设成 Global 是因为订单、控制台、到期任务、后台管理四处都要用，
 * 每个模块都 import 一遍太啰嗦。
 */
@Global()
@Module({
  providers: [GcpProvider, LightsailProvider, SshProvider, ProxmoxProvider, ProviderRegistry],
  // 绝大多数地方只该用 ProviderRegistry（按机器的 provider 字段自动分发）。
  // 单个驱动也导出，是因为个别能力天生只属于某一家：比如「测这台机器能不能 SSH 登进去」
  // 只有 ssh 驱动有，硬塞进统一接口会让另外三个驱动多出三个假实现。
  exports: [ProviderRegistry, GcpProvider, LightsailProvider, SshProvider, ProxmoxProvider],
})
export class ProvidersModule {}
