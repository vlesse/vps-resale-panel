import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BillingCycle,
  CurrencyCode,
  InventoryStatus,
  OrderStatus,
  ServiceActionStatus,
  ServiceActionType,
  ServiceStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { addMonths, genOrderNo, serialize } from '../common/utils';
import {
  decryptJson,
  encryptJson,
  ProxmoxAuthConfig,
  ServerAuthPayload,
} from '../crypto/crypto.util';
import {
  collectHostStatus,
  genPassword,
  rebootHost,
  resetRootPassword,
  softReinitHost,
  SshAuth,
} from './ssh.util';
import {
  pveCollectStatus,
  pveReboot,
  pveReinstallFromTemplate,
  pveResetPassword,
  resolvePveConfig,
} from './proxmox.util';
import { controlPlaneLabel, normalizeProvider } from './provider.util';

@Injectable()
export class ServicesService {
  private readonly logger = new Logger(ServicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private secret() {
    return this.config.get<string>('CREDENTIALS_SECRET') || 'dev-secret';
  }

  private async getOwnedService(userId: string, id: string, asAdmin = false) {
    const where: any = { id: BigInt(id) };
    if (!asAdmin) where.userId = BigInt(userId);
    const row = await this.prisma.service.findFirst({
      where,
      include: {
        plan: true,
        order: true,
        inventoryServer: true,
        actions: { orderBy: { id: 'desc' }, take: 20 },
      },
    });
    if (!row) throw new NotFoundException('Service not found');
    return row;
  }

  private assertControllable(svc: { status: ServiceStatus; expireAt: Date }) {
    if (svc.status === ServiceStatus.expired || svc.status === ServiceStatus.cancelled) {
      throw new BadRequestException('Service is not active');
    }
    if (svc.expireAt.getTime() < Date.now() && svc.status !== ServiceStatus.reinstalling) {
      throw new BadRequestException('Service expired');
    }
  }

  private readAuth(encrypted: string, deliverPayloadJson?: any): ServerAuthPayload {
    try {
      return decryptJson<ServerAuthPayload>(this.secret(), encrypted);
    } catch {
      const d = deliverPayloadJson || {};
      return {
        username: d.username || 'root',
        password: d.password || undefined,
      };
    }
  }

  private buildSshAuth(svc: {
    inventoryServer: {
      ip: string;
      sshPort: number;
      authPayloadEncrypted: string;
    };
    deliverPayloadJson: any;
  }): SshAuth {
    const auth = this.readAuth(
      svc.inventoryServer.authPayloadEncrypted,
      svc.deliverPayloadJson,
    );
    return {
      host: svc.inventoryServer.ip,
      port: svc.inventoryServer.sshPort || 22,
      username: auth.username || 'root',
      password: auth.password,
      privateKey: auth.privateKey,
    };
  }

  private buildPve(svc: {
    inventoryServer: {
      provider: string;
      providerRef: string | null;
      authPayloadEncrypted: string;
    };
    deliverPayloadJson: any;
  }): ProxmoxAuthConfig {
    const auth = this.readAuth(
      svc.inventoryServer.authPayloadEncrypted,
      svc.deliverPayloadJson,
    );
    if (!auth.pve) {
      throw new BadRequestException(
        'This inventory item is marked proxmox but pve credentials are missing',
      );
    }
    const cfg = resolvePveConfig(auth.pve, svc.inventoryServer.providerRef);
    if (!cfg.host || !cfg.node || !cfg.vmid) {
      throw new BadRequestException('Proxmox host/node/vmid incomplete');
    }
    return cfg;
  }

  private driverOf(provider: string) {
    return normalizeProvider(provider);
  }

  private capabilitiesFor(provider: string, auth: ServerAuthPayload) {
    const driver = this.driverOf(provider);
    if (driver === 'proxmox') {
      const canFullReinstall = Boolean(auth.pve?.templateVmid);
      return {
        statusCheck: true,
        reboot: true,
        resetPassword: true,
        reinstall: canFullReinstall ? 'proxmox_template_clone' : 'soft_or_unavailable',
        reinstallNote: canFullReinstall
          ? '将从 Proxmox 模板重建虚拟机（同 VMID），并写入 cloud-init 密码'
          : '未配置 templateVmid：无法模板重装；若有 SSH 凭据可走基线初始化',
        renew: true,
        controlPlane: 'hypervisor',
        driver: 'proxmox',
      };
    }
    return {
      statusCheck: true,
      reboot: true,
      resetPassword: true,
      reinstall: 'soft_reinit',
      reinstallNote: '当前为 SSH 基线初始化+重启；完整 ISO/模板重装需 Hypervisor 驱动',
      renew: true,
      controlPlane: 'agent',
      driver: 'ssh',
    };
  }

  async myServices(userId: string) {
    const rows = await this.prisma.service.findMany({
      where: { userId: BigInt(userId) },
      orderBy: { id: 'desc' },
      include: {
        plan: true,
        inventoryServer: {
          select: {
            id: true,
            code: true,
            ip: true,
            sshPort: true,
            provider: true,
            region: true,
            cpu: true,
            memoryMb: true,
            diskGb: true,
            status: true,
          },
        },
      },
    });
    return serialize(
      rows.map((s) => ({
        ...s,
        summary: {
          ip: (s.deliverPayloadJson as any)?.ip || s.inventoryServer?.ip,
          sshPort:
            (s.deliverPayloadJson as any)?.ssh_port ||
            s.inventoryServer?.sshPort ||
            22,
          // do not expose raw upstream brand to customers
          controlPlane: controlPlaneLabel(s.inventoryServer?.provider),
          region: s.inventoryServer?.region || s.plan?.regionLabel,
          online: (s.lastStatusJson as any)?.online ?? null,
          lastCheckedAt: s.lastCheckedAt,
        },
      })),
    );
  }

  async myService(userId: string, id: string) {
    const row = await this.getOwnedService(userId, id);
    const deliver = (row.deliverPayloadJson || {}) as any;
    const auth = this.readAuth(
      row.inventoryServer.authPayloadEncrypted,
      row.deliverPayloadJson,
    );
    return serialize({
      id: row.id,
      serviceNo: row.serviceNo,
      status: row.status,
      startAt: row.startAt,
      expireAt: row.expireAt,
      osTemplate: row.osTemplate || deliver.os || 'Linux',
      plan: row.plan,
      order: {
        orderNo: row.order.orderNo,
        amountCents: row.order.amountCents,
        currency: row.order.currency,
        paidAt: row.order.paidAt,
      },
      server: {
        inventoryId: row.inventoryServer.id,
        code: row.inventoryServer.code,
        ip: row.inventoryServer.ip,
        sshPort: row.inventoryServer.sshPort,
        controlPlane: controlPlaneLabel(row.inventoryServer.provider),
        region: row.inventoryServer.region,
        cpu: row.inventoryServer.cpu,
        memoryMb: row.inventoryServer.memoryMb,
        diskGb: row.inventoryServer.diskGb,
        optimizeTags: row.inventoryServer.optimizeTagsJson,
      },
      access: {
        username: deliver.username || auth.username || 'root',
        password: deliver.password || null,
        ssh_port: deliver.ssh_port || row.inventoryServer.sshPort,
        ip: deliver.ip || row.inventoryServer.ip,
        notes: deliver.notes || null,
      },
      liveStatus: row.lastStatusJson,
      lastCheckedAt: row.lastCheckedAt,
      recentActions: row.actions,
      capabilities: this.capabilitiesFor(row.inventoryServer.provider, auth),
    });
  }

  private async recordAction(params: {
    serviceId: bigint;
    userId: bigint;
    action: ServiceActionType;
    request?: any;
    run: () => Promise<any>;
  }) {
    const actionRow = await this.prisma.serviceAction.create({
      data: {
        serviceId: params.serviceId,
        userId: params.userId,
        action: params.action,
        status: ServiceActionStatus.running,
        requestJson: params.request || {},
      },
    });
    try {
      const result = await params.run();
      const updated = await this.prisma.serviceAction.update({
        where: { id: actionRow.id },
        data: {
          status: ServiceActionStatus.success,
          resultJson: result,
          finishedAt: new Date(),
        },
      });
      return serialize(updated);
    } catch (e: any) {
      const updated = await this.prisma.serviceAction.update({
        where: { id: actionRow.id },
        data: {
          status: ServiceActionStatus.failed,
          errorMessage: String(e?.message || e).slice(0, 500),
          finishedAt: new Date(),
        },
      });
      this.logger.error(
        `service action failed ${params.action} svc=${params.serviceId}`,
        e?.message || e,
      );
      throw new BadRequestException({
        code: 'SERVICE_ACTION_FAILED',
        message: String(e?.message || e),
        actionId: updated.id.toString(),
      });
    }
  }

  async checkStatus(userId: string, id: string, asAdmin = false) {
    const svc = await this.getOwnedService(userId, id, asAdmin);
    this.assertControllable(svc);
    const driver = this.driverOf(svc.inventoryServer.provider);
    return this.recordAction({
      serviceId: svc.id,
      userId: BigInt(asAdmin ? 0 : userId),
      action: ServiceActionType.status_check,
      request: { driver, admin: asAdmin },
      run: async () => {
        let status: any;
        if (driver === 'proxmox') {
          const pve = this.buildPve(svc);
          status = await pveCollectStatus(pve);
        } else {
          const auth = this.buildSshAuth(svc);
          status = await collectHostStatus(auth);
          status.source = 'ssh';
        }
        await this.prisma.service.update({
          where: { id: svc.id },
          data: {
            lastStatusJson: status,
            lastCheckedAt: new Date(),
          },
        });
        return status;
      },
    });
  }

  async reboot(userId: string, id: string, asAdmin = false) {
    const svc = await this.getOwnedService(userId, id, asAdmin);
    this.assertControllable(svc);
    if (svc.status !== ServiceStatus.active && svc.status !== ServiceStatus.maintenance) {
      throw new BadRequestException('Only active service can reboot');
    }
    const driver = this.driverOf(svc.inventoryServer.provider);
    return this.recordAction({
      serviceId: svc.id,
      userId: BigInt(asAdmin ? 0 : userId),
      action: ServiceActionType.reboot,
      request: { driver, admin: asAdmin },
      run: async () => {
        let result: any;
        if (driver === 'proxmox') {
          result = await pveReboot(this.buildPve(svc));
        } else {
          result = await rebootHost(this.buildSshAuth(svc));
        }
        await this.prisma.service.update({
          where: { id: svc.id },
          data: {
            lastStatusJson: {
              ...(typeof svc.lastStatusJson === 'object' && svc.lastStatusJson
                ? (svc.lastStatusJson as object)
                : {}),
              online: false,
              note: 'reboot requested',
              source: driver,
            },
            lastCheckedAt: new Date(),
          },
        });
        return result;
      },
    });
  }

  async resetPassword(userId: string, id: string, body: { password?: string }, asAdmin = false) {
    const svc = await this.getOwnedService(userId, id, asAdmin);
    this.assertControllable(svc);
    const newPassword = (body.password || genPassword(16)).trim();
    if (newPassword.length < 8) {
      throw new BadRequestException('Password too short (min 8)');
    }
    const driver = this.driverOf(svc.inventoryServer.provider);
    return this.recordAction({
      serviceId: svc.id,
      userId: BigInt(asAdmin ? 0 : userId),
      action: ServiceActionType.reset_password,
      request: { passwordLength: newPassword.length, driver, admin: asAdmin },
      run: async () => {
        const stored = this.readAuth(
          svc.inventoryServer.authPayloadEncrypted,
          svc.deliverPayloadJson,
        );
        const username = stored.username || 'root';
        let method = 'ssh';

        if (driver === 'proxmox') {
          const pve = this.buildPve(svc);
          try {
            await pveResetPassword(pve, username, newPassword);
            method = 'proxmox-guest-agent';
          } catch (e: any) {
            // fallback to guest SSH if available
            const ssh = this.buildSshAuth(svc);
            if (!ssh.password && !ssh.privateKey) {
              throw new Error(
                `Proxmox guest-agent password failed and no SSH fallback: ${e?.message || e}`,
              );
            }
            await resetRootPassword(ssh, newPassword);
            method = 'ssh-fallback';
          }
        } else {
          const auth = this.buildSshAuth(svc);
          if (!auth.password && !auth.privateKey) {
            throw new Error('No SSH credentials stored for this server');
          }
          await resetRootPassword(auth, newPassword);
        }

        const newAuth: ServerAuthPayload = {
          ...stored,
          username,
          password: newPassword,
        };
        const deliver = {
          ...((svc.deliverPayloadJson as any) || {}),
          username,
          password: newPassword,
        };
        await this.prisma.$transaction(async (tx) => {
          await tx.inventoryServer.update({
            where: { id: svc.inventoryServerId },
            data: {
              authPayloadEncrypted: encryptJson(this.secret(), newAuth),
            },
          });
          await tx.service.update({
            where: { id: svc.id },
            data: { deliverPayloadJson: deliver },
          });
        });
        return {
          ok: true,
          password: newPassword,
          method,
          message: 'Password updated on instance and panel',
        };
      },
    });
  }

  async reinstall(
    userId: string,
    id: string,
    body: { osTemplate?: string; password?: string },
    asAdmin = false,
  ) {
    const svc = await this.getOwnedService(userId, id, asAdmin);
    this.assertControllable(svc);
    const osTemplate = body.osTemplate || svc.osTemplate || 'ubuntu-22.04';
    const newPassword = (body.password || genPassword(16)).trim();
    const driver = this.driverOf(svc.inventoryServer.provider);
    const stored = this.readAuth(
      svc.inventoryServer.authPayloadEncrypted,
      svc.deliverPayloadJson,
    );

    await this.prisma.service.update({
      where: { id: svc.id },
      data: { status: ServiceStatus.reinstalling, osTemplate },
    });

    try {
      const action = await this.recordAction({
        serviceId: svc.id,
        userId: BigInt(asAdmin ? 0 : userId),
        action: ServiceActionType.reinstall,
        request: {
          osTemplate,
          driver,
          mode:
            driver === 'proxmox' && stored.pve?.templateVmid
              ? 'proxmox_template_clone'
              : 'soft_reinit',
        },
        run: async () => {
          let result: any;
          let finalPassword = newPassword;

          if (driver === 'proxmox' && stored.pve?.templateVmid) {
            const pve = this.buildPve(svc);
            result = await pveReinstallFromTemplate(pve, {
              name: svc.inventoryServer.code,
              newPassword,
              osLabel: osTemplate,
            });
            finalPassword = result.password || newPassword;
          } else if (driver === 'proxmox' && !stored.pve?.templateVmid) {
            // no template: try SSH soft reinit if possible, else error clearly
            const ssh = this.buildSshAuth(svc);
            if (!ssh.password && !ssh.privateKey) {
              throw new Error(
                'Proxmox inventory missing templateVmid and guest SSH credentials; cannot reinstall',
              );
            }
            result = await softReinitHost(ssh, {
              newPassword,
              osLabel: osTemplate,
            });
            result.note =
              (result.note || '') +
              ' | Proxmox templateVmid not set; used SSH soft reinit';
          } else {
            const auth = this.buildSshAuth(svc);
            if (!auth.password && !auth.privateKey) {
              throw new Error('No SSH credentials stored for this server');
            }
            result = await softReinitHost(auth, {
              newPassword,
              osLabel: osTemplate,
            });
          }

          const newAuth: ServerAuthPayload = {
            ...stored,
            username: stored.username || stored.pve?.ciUser || 'root',
            password: finalPassword,
          };
          const deliver = {
            ...((svc.deliverPayloadJson as any) || {}),
            username: newAuth.username,
            password: finalPassword,
            os: osTemplate,
            notes:
              driver === 'proxmox' && stored.pve?.templateVmid
                ? 'Reinstalled from Proxmox template. Verify SSH/cloud-init after boot.'
                : 'Soft reinit completed (not full ISO reinstall). Verify SSH after reboot.',
          };
          await this.prisma.$transaction(async (tx) => {
            await tx.inventoryServer.update({
              where: { id: svc.inventoryServerId },
              data: {
                authPayloadEncrypted: encryptJson(this.secret(), newAuth),
              },
            });
            await tx.service.update({
              where: { id: svc.id },
              data: {
                status: ServiceStatus.active,
                osTemplate,
                deliverPayloadJson: deliver,
                lastStatusJson: {
                  online: false,
                  note: 'rebooting/starting after reinstall',
                  source: driver,
                },
                lastCheckedAt: new Date(),
              },
            });
          });
          return { ...result, password: finalPassword };
        },
      });
      return action;
    } catch (e) {
      await this.prisma.service.update({
        where: { id: svc.id },
        data: { status: ServiceStatus.active },
      });
      throw e;
    }
  }

  async renew(userId: string, serviceId: string, currency: CurrencyCode) {
    const svc = await this.prisma.service.findFirst({
      where: { id: BigInt(serviceId), userId: BigInt(userId) },
      include: { plan: { include: { prices: true } } },
    });
    if (!svc) throw new NotFoundException('Service not found');
    if (
      svc.status !== ServiceStatus.active &&
      svc.status !== ServiceStatus.suspended
    ) {
      throw new BadRequestException('Service not renewable');
    }
    const price = svc.plan.prices.find(
      (p) =>
        p.currency === currency &&
        p.cycle === BillingCycle.monthly &&
        p.isEnabled,
    );
    if (!price) throw new BadRequestException('Price not found');

    const order = await this.prisma.order.create({
      data: {
        orderNo: genOrderNo('RN'),
        userId: BigInt(userId),
        planId: svc.planId,
        planPriceId: price.id,
        cycle: BillingCycle.monthly,
        amountCents: price.priceCents,
        currency,
        status: OrderStatus.pending_payment,
        inventoryServerId: svc.inventoryServerId,
        clientRemark: `renew service ${svc.serviceNo}`,
      },
    });
    return serialize({
      ...order,
      renewServiceId: svc.id.toString(),
      hint: 'Pay this order; on success expireAt extends by 1 month',
    });
  }

  async applyRenewalIfNeeded(orderId: bigint) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || !order.orderNo.startsWith('RN')) return null;
    if (!order.inventoryServerId) return null;
    const svc = await this.prisma.service.findFirst({
      where: {
        userId: order.userId,
        inventoryServerId: order.inventoryServerId,
      },
    });
    if (!svc) return null;
    const base =
      svc.expireAt.getTime() > Date.now() ? svc.expireAt : new Date();
    const expireAt = addMonths(base, 1);
    const updated = await this.prisma.service.update({
      where: { id: svc.id },
      data: {
        expireAt,
        status: ServiceStatus.active,
      },
    });
    await this.prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.completed, paidAt: order.paidAt || new Date() },
    });
    if (order.inventoryServerId) {
      await this.prisma.inventoryServer.update({
        where: { id: order.inventoryServerId },
        data: { status: InventoryStatus.sold },
      });
    }
    return serialize(updated);
  }

  async expireDue() {
    const now = new Date();
    const res = await this.prisma.service.updateMany({
      where: {
        status: ServiceStatus.active,
        expireAt: { lt: now },
      },
      data: { status: ServiceStatus.suspended },
    });
    return { suspended: res.count };
  }

  adminList() {
    return this.prisma.service
      .findMany({
        orderBy: { id: 'desc' },
        include: { user: true, plan: true, inventoryServer: true },
        take: 100,
      })
      .then(serialize);
  }

  async adminSuspend(id: string) {
    const row = await this.prisma.service.update({
      where: { id: BigInt(id) },
      data: { status: ServiceStatus.suspended },
    });
    await this.prisma.inventoryServer.update({
      where: { id: row.inventoryServerId },
      data: { status: InventoryStatus.suspended },
    });
    return serialize(row);
  }

  async adminRecycle(id: string) {
    const svc = await this.prisma.service.findUnique({
      where: { id: BigInt(id) },
    });
    if (!svc) throw new NotFoundException('Service not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.service.update({
        where: { id: svc.id },
        data: { status: ServiceStatus.expired },
      });
      await tx.inventoryServer.update({
        where: { id: svc.inventoryServerId },
        data: {
          status: InventoryStatus.recycling,
          soldServiceId: null,
          reservedOrderId: null,
        },
      });
    });
    return { ok: true };
  }
}
