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
  exports: [ProviderRegistry],
})
export class ProvidersModule {}
