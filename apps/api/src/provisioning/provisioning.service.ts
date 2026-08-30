import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BillingCycle,
  JobKind,
  JobStatus,
  MachineStatus,
  OrderStatus,
  Prisma,
  ServiceStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { ProvisionRequest, ProvisionResult } from '../providers/provider.types';
import {
  customMachineType,
  normalizeCustomSpec,
  parseCustomConfig,
} from '../plans/custom-spec';
import {
  encryptJson,
  generateCode,
  generatePassword,
  generateSshKeyPair,
} from '../crypto/crypto.util';
import { NatEndpoint, NatService } from '../nat/nat.service';

/**
 * 建机编排 —— 从「订单付款成功」到「机器交到用户手上」之间的全部逻辑。
 *
 * 为什么要单独一层：云厂商建一台机要 30 到 90 秒，还可能失败。这段时间不能
 * 让用户的浏览器干等着，也不能失败了就把用户的钱吞掉。所以：
 *
 *   付款回调只做两件事    建 Service 占位 + 入队，然后立刻返回
 *   真正的活在队列里干    进度实时写进 ProvisionJob，前端轮询显示
 *   失败一定要回滚        半成品实例会一直计费，必须销毁掉
 *
 * 两种履约方式在这里汇合：
 *   on_demand  现调 API 建机 → 建之前先过配额闸门（这是真花钱的）
 *   inventory  从 ready 池子里用乐观锁抢一台 → 抢不到就是无货
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProviderRegistry,
    private readonly config: ConfigService,
    private readonly nat: NatService,
  ) {}

  // ============================================================
  //  入队
  // ============================================================

  /**
   * 支付成功后调这个。它只负责建占位记录和任务，不做任何耗时操作 ——
   * 支付平台的回调有超时限制，拖久了它会重发，重发会导致重复建机。
   */
  /**
   * @param force 管理员手工重试时传 true。
   *
   * 平时那道幂等保护（订单已有任务就返回旧任务号）是为了挡支付平台重发回调，
   * 但它会让「重试开通」彻底失效：返回的是已经失败的旧任务号，
   * 而队列按 provision-<id> 去重、失败的任务又要在 Redis 里留七天，
   * 于是重新入队被静默丢弃 —— 后台提示「已重新排队」，实际什么都没发生。
   * 用户付了钱、开通失败，就再也救不回来了。
   */
  async startProvision(
    orderId: bigint,
    opts: { force?: boolean } = {},
  ): Promise<{ serviceId: bigint; jobId: bigint }> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { plan: true, service: true },
    });

    // 幂等：支付平台重发回调时不能建出第二台机器
    if (order.service && !opts.force) {
      const existing = await this.prisma.provisionJob.findFirst({
        where: { orderId, kind: JobKind.provision },
        orderBy: { id: 'desc' },
      });
      if (existing) {
        this.logger.warn(`订单 ${order.orderNo} 已经有建机任务，跳过重复入队`);
        return { serviceId: order.service.id, jobId: existing.id };
      }
    }

    if (opts.force) {
      // 重试前确认没有任务正在跑，避免同一笔订单建出两台机器
      const live = await this.prisma.provisionJob.findFirst({
        where: { orderId, kind: JobKind.provision, status: { in: [JobStatus.queued, JobStatus.running] } },
      });
      if (live) {
        throw new BadRequestException('已经有一个开通任务在跑了，等它结束再重试');
      }
    }

    const service =
      order.service ??
      (await this.prisma.service.create({
        data: {
          serviceNo: generateCode('SVC'),
          userId: order.userId,
          orderId: order.id,
          planId: order.planId,
          status: ServiceStatus.provisioning,
          expireAt: this.computeExpireAt(new Date(), order.cycle),
        },
      }));

    const job = await this.prisma.provisionJob.create({
      data: {
        kind: JobKind.provision,
        orderId: order.id,
        serviceId: service.id,
        maxAttempts: this.config.get<number>('PROVISION_MAX_ATTEMPTS') ?? 3,
        step: '排队中',
      },
    });

    await this.prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.provisioning },
    });

    return { serviceId: service.id, jobId: job.id };
  }

  /** 续费：不建机，只把到期时间往后推 */
  async applyRenewal(orderId: bigint): Promise<void> {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (!order.renewServiceId) throw new Error('续费订单没有关联到任何服务');

    const service = await this.prisma.service.findUniqueOrThrow({
      where: { id: order.renewServiceId },
    });

    // 从「当前到期时间」和「现在」里取晚的那个往后推 ——
    // 提前续费不能吃掉剩余时间，过期后补费也不能把时间续到过去
    const base = service.expireAt > new Date() ? service.expireAt : new Date();

    await this.prisma.$transaction([
      this.prisma.service.update({
        where: { id: service.id },
        data: {
          expireAt: this.computeExpireAt(base, order.cycle),
          // 因为过期被停的，续费后恢复
          status:
            service.status === ServiceStatus.expired || service.status === ServiceStatus.suspended
              ? ServiceStatus.active
              : service.status,
          suspendReason: null,
        },
      }),
      this.prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.completed },
      }),
    ]);
  }

  // ============================================================
  //  执行（由队列 worker 调用）
  // ============================================================

  async runJob(jobId: bigint): Promise<void> {
    const job = await this.prisma.provisionJob.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status === JobStatus.success) return;

    await this.prisma.provisionJob.update({
      where: { id: jobId },
      data: {
        status: JobStatus.running,
        attempt: { increment: 1 },
        startedAt: job.startedAt ?? new Date(),
        step: '开始处理',
        lastError: null,
      },
    });

    try {
      switch (job.kind) {
        case JobKind.provision:
          await this.doProvision(jobId);
          break;
        case JobKind.rebuild:
          await this.doRebuild(jobId);
          break;
        case JobKind.release:
          await this.doRelease(jobId);
          break;
      }
      await this.prisma.provisionJob.update({
        where: { id: jobId },
        data: {
          status: JobStatus.success,
          progress: 100,
          step: '完成',
          finishedAt: new Date(),
        },
      });
    } catch (err: any) {
      const message = String(err?.message ?? err).slice(0, 1000);
      this.logger.error(`任务 ${jobId} 失败：${message}`);
      const fresh = await this.prisma.provisionJob.findUniqueOrThrow({ where: { id: jobId } });
      const isFinal = fresh.attempt >= fresh.maxAttempts;

      await this.prisma.provisionJob.update({
        where: { id: jobId },
        data: {
          status: isFinal ? JobStatus.failed : JobStatus.queued,
          lastError: message,
          step: isFinal ? '失败' : `第 ${fresh.attempt} 次失败，稍后重试`,
          finishedAt: isFinal ? new Date() : null,
        },
      });

      if (isFinal) await this.markOrderFailed(fresh.orderId, fresh.serviceId, message);
      throw err;
    }
  }

  // ---------- 建机 ----------

  private async doProvision(jobId: bigint): Promise<void> {
    const job = await this.prisma.provisionJob.findUniqueOrThrow({
      where: { id: jobId },
      include: {
        order: { include: { plan: { include: { cloudAccount: true } }, user: true } },
        service: true,
      },
    });
    if (!job.order || !job.service) throw new Error('任务缺少关联的订单或服务');

    const { order, service } = job;
    const plan = order.plan;
    const progress = this.progressWriter(jobId);

    await progress(3, '检查配额');
    await this.assertQuota(order.userId, plan.id);

    // 拿到（或建出）一台机器
    let machine =
      plan.fulfillment === 'inventory'
        ? await this.allocateFromPool(plan.id, plan.matchRulesJson)
        : await this.createMachineRow(
            plan,
            order.customSpecJson as { cpu: number; memoryMb: number; diskGb: number } | null,
          );

    await this.prisma.provisionJob.update({
      where: { id: jobId },
      data: { machineId: machine.id },
    });

    // 生成交付凭据。密码给用户，密钥给面板自己 —— 用户改了密码也不影响面板操作。
    const password = generatePassword(16);
    const keypair = generateSshKeyPair(`panel-${machine.code}`);
    const driver = this.registry.get(plan.provider);
    const ctx = this.registry.contextFor(machine, plan.cloudAccount);

    const spec = this.effectiveSpec(plan, order.customSpecJson);
    // NAT 套餐：地址由面板分配，不靠虚拟机自己上报
    if (spec.ipPool && !spec.assignedIp) {
      spec.assignedIp = await this.allocateNatIp(spec.ipPool, spec.gateway);
      await this.prisma.machine.update({
        where: { id: machine.id },
        data: { ip: spec.assignedIp },
      });
    }

    const req: ProvisionRequest = {
      code: machine.code,
      spec,
      hostname: machine.code.toLowerCase(),
      password,
      publicKeyOpenssh: keypair.publicKeyOpenssh,
      privateKeyPem: keypair.privateKeyPem,
      onProgress: (p, s) => progress(Math.min(97, 5 + Math.round(p * 0.92)), s),
      // 驱动在真正下达创建指令之前会先回调这里，把「打算建什么」落库。
      // 少了这一步，「已提交创建」和「确认建好」之间断掉就会留下一台
      // 云上真实存在、真实计费、而面板毫不知情的实例。
      onRefKnown: async (ref) => {
        await this.prisma.machine.update({
          where: { id: machine.id },
          data: { providerRefJson: ref as Prisma.InputJsonValue },
        });
      },
    };

    let result: ProvisionResult;
    try {
      result = await driver.provision(ctx, req);
    } catch (err) {
      await this.rollbackMachine(machine.id, plan.fulfillment, ctx, err);
      throw err;
    }

    // NAT 套餐：机器建好了但还藏在私网里，要在网关上给它开一段端口才卖得出去。
    // 放在回滚之后、落库之前 —— 端口开不出来的机器等于交付不了，
    // 不如让它跟着建机一起失败，由回滚逻辑把机器销毁掉。
    let nat: NatEndpoint | null = null;
    if (spec.natGatewayId) {
      try {
        await progress(96, '在公网入口上分配端口');
        nat = await this.nat.attach(machine.id, BigInt(spec.natGatewayId), result.ip ?? '');
      } catch (err) {
        await this.rollbackMachine(machine.id, plan.fulfillment, ctx, err);
        throw err;
      }
    }

    // 落库。机器和服务必须一起更新，中间断电会导致「机器建出来了但没人认领」。
    const authBlob = encryptJson(this.secret(), result.auth);
    const deliver = {
      // 买家看到的必须是能连上的那个地址。NAT 机器的私网地址写给他没用，
      // 但也不能藏起来 —— 他在机器里看到的网卡就是那个地址，对不上会以为被骗了。
      ip: nat ? nat.publicHost : result.ip,
      ipv6: result.ipv6,
      sshPort: nat ? nat.sshPort : result.auth.sshPort,
      username: result.auth.sshUser,
      password,
      osTemplate: result.osTemplate ?? plan.osTemplate,
      region: plan.regionLabel,
      ...(nat
        ? {
            nat: {
              internalIp: nat.internalIp,
              portStart: nat.portStart,
              portEnd: nat.portEnd,
            },
          }
        : {}),
    };

    await this.prisma.$transaction([
      this.prisma.machine.update({
        where: { id: machine.id },
        data: {
          ip: result.ip,
          ipv6: result.ipv6 ?? null,
          sshPort: result.auth.sshPort,
          providerRefJson: result.ref as Prisma.InputJsonValue,
          authPayloadEncrypted: authBlob,
          // 面板自己后续要 SSH 上去（探状态、重装前的清理），走的也是公网端口
          ...(nat ? { sshPort: nat.sshPort } : {}),
          osTemplate: result.osTemplate ?? plan.osTemplate,
          status: MachineStatus.running,
          lastError: null,
          version: { increment: 1 },
        },
      }),
      this.prisma.service.update({
        where: { id: service.id },
        data: {
          machineId: machine.id,
          status: ServiceStatus.active,
          startAt: new Date(),
          deliverPayloadJson: deliver as Prisma.InputJsonValue,
        },
      }),
      this.prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.completed },
      }),
    ]);

    await progress(100, '交付完成');
  }

  // ---------- 重装 ----------

  private async doRebuild(jobId: bigint): Promise<void> {
    const job = await this.prisma.provisionJob.findUniqueOrThrow({
      where: { id: jobId },
      include: {
        service: {
          include: {
            plan: { include: { cloudAccount: true } },
            machine: {
              include: {
                natBinding: {
                  include: { gateway: { select: { publicHost: true } } },
                },
              },
            },
            // 重装要按当初买的规格重建。不带上原订单的话，自定义档
            // 重装一次配置就掉回套餐默认值 —— 用户 8 核变 2 核。
            order: { select: { customSpecJson: true } },
          },
        },
      },
    });
    const service = job.service;
    if (!service?.machine) throw new Error('这个服务还没有绑定机器，不能重装');

    const plan = service.plan;
    const machine = service.machine;
    const progress = this.progressWriter(jobId);
    const driver = this.registry.get(machine.provider);

    if (!driver.canRebuild) throw new Error(`${machine.provider} 驱动不支持重装`);

    await this.prisma.$transaction([
      this.prisma.machine.update({
        where: { id: machine.id },
        data: { status: MachineStatus.rebuilding },
      }),
      this.prisma.service.update({
        where: { id: service.id },
        data: { status: ServiceStatus.provisioning },
      }),
    ]);

    const password = generatePassword(16);
    const keypair = generateSshKeyPair(`panel-${machine.code}`);
    const ctx = this.registry.contextFor(machine, plan.cloudAccount);

    // 重装要落回原来那个私网地址：端口映射是照地址写的，
    // 换个地址等于把买家保存的连接方式作废掉。
    const rebuildSpec = this.effectiveSpec(plan, service.order?.customSpecJson ?? null);
    if (rebuildSpec.ipPool && machine.ip) rebuildSpec.assignedIp = machine.ip;

    const result = await driver.rebuild(ctx, {
      code: machine.code,
      spec: rebuildSpec,
      hostname: machine.code.toLowerCase(),
      password,
      publicKeyOpenssh: keypair.publicKeyOpenssh,
      privateKeyPem: keypair.privateKeyPem,
      onProgress: (p, s) => progress(Math.min(97, Math.round(p * 0.97)), s),
    });

    await this.prisma.$transaction([
      this.prisma.machine.update({
        where: { id: machine.id },
        data: {
          ip: result.ip,
          providerRefJson: result.ref as Prisma.InputJsonValue,
          authPayloadEncrypted: encryptJson(this.secret(), result.auth),
          status: MachineStatus.running,
          version: { increment: 1 },
          ...(machine.natBinding ? { sshPort: machine.natBinding.sshPort } : {}),
        },
      }),
      this.prisma.service.update({
        where: { id: service.id },
        data: {
          status: ServiceStatus.active,
          deliverPayloadJson: {
            ip: machine.natBinding ? machine.natBinding.gateway.publicHost : result.ip,
            sshPort: machine.natBinding ? machine.natBinding.sshPort : result.auth.sshPort,
            username: result.auth.sshUser,
            password,
            osTemplate: result.osTemplate ?? plan.osTemplate,
            region: plan.regionLabel,
            ...(machine.natBinding
              ? {
                  nat: {
                    internalIp: result.ip,
                    portStart: machine.natBinding.portStart,
                    portEnd: machine.natBinding.portEnd,
                  },
                }
              : {}),
          } as Prisma.InputJsonValue,
        },
      }),
    ]);

    await progress(100, '重装完成');
  }

  // ---------- 销毁 ----------

  private async doRelease(jobId: bigint): Promise<void> {
    const job = await this.prisma.provisionJob.findUniqueOrThrow({
      where: { id: jobId },
      include: {
        machine: { include: { cloudAccount: true, natBinding: { select: { sshPort: true, gateway: { select: { publicHost: true } } } } } },
        service: true,
      },
    });
    const machine = job.machine;
    if (!machine) throw new Error('任务没有关联机器');

    const progress = this.progressWriter(jobId);
    await progress(20, '正在销毁');

    const driver = this.registry.get(machine.provider);
    const ctx = this.registry.contextFor(machine, machine.cloudAccount);

    await this.prisma.machine.update({
      where: { id: machine.id },
      data: { status: MachineStatus.releasing },
    });

    await driver.release(ctx);

    // 库存机是你的资产，退订后回收重新上架；云机器是真删了。
    // 回收后进 optimizing 而不是直接 ready —— 上一个用户装过什么你不知道，
    // 必须重新走一遍清理和调优才能再卖。
    const isPool = machine.provider === 'ssh';

    // NAT 机器：真删掉的要把端口段还回去，否则端口白占着，
    // 而且下一台机器分到同一段时，网关上残留的旧规则会把流量打到不存在的地址。
    // 库存机不还 —— 它回池子里继续待命，面板还得靠这段端口连上去做清理。
    if (!isPool) await this.nat.detach(machine.id);

    await this.prisma.machine.update({
      where: { id: machine.id },
      data: isPool
        ? { status: MachineStatus.optimizing, authPayloadEncrypted: null }
        : {
            status: MachineStatus.released,
            releasedAt: new Date(),
            // 机器没了，凭据留着只是风险
            authPayloadEncrypted: null,
            ip: null,
          },
    });

    if (job.serviceId) {
      await this.prisma.service.update({
        where: { id: job.serviceId },
        data: { status: ServiceStatus.cancelled },
      });
    }
    await progress(100, '已销毁');
  }

  // ============================================================
  //  内部
  // ============================================================

  /** 把进度写回数据库，前端轮询这张表画进度条 */
  private progressWriter(jobId: bigint) {
    return async (percent: number, step: string) => {
      await this.prisma.provisionJob
        .update({
          where: { id: jobId },
          data: { progress: Math.max(0, Math.min(100, percent)), step: step.slice(0, 120) },
        })
        .catch(() => undefined); // 写进度失败不该让整个建机流程挂掉
    };
  }

  private secret(): string {
    const s = this.config.get<string>('CREDENTIALS_SECRET');
    if (!s) throw new Error('.env 里没有配 CREDENTIALS_SECRET');
    return s;
  }

  /**
   * 花钱闸门。
   *
   * 「下单即开」意味着每一单都会在你的云账号上真的建出一台机器、真的开始计费。
   * 没有这道闸门，一个人写个脚本刷单就能把你的云账单刷爆。
   */
  private async assertQuota(userId: bigint, planId: bigint): Promise<void> {
    const [user, plan] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      this.prisma.plan.findUniqueOrThrow({ where: { id: planId }, include: { cloudAccount: true } }),
    ]);

    // 1. 单用户在跑的机器数
    const perUserLimit =
      user.maxActiveServices > 0
        ? user.maxActiveServices
        : Number(this.config.get('MAX_ACTIVE_SERVICES_PER_USER') ?? 5);
    const userActive = await this.prisma.service.count({
      where: {
        userId,
        status: { in: [ServiceStatus.provisioning, ServiceStatus.active, ServiceStatus.stopped] },
      },
    });
    if (userActive >= perUserLimit) {
      throw new Error(
        `你名下已经有 ${userActive} 台机器，达到了上限 ${perUserLimit} 台。` +
          '需要更多请联系客服提额。',
      );
    }

    // 2. 全平台当日建机数
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const dailyLimit = Number(this.config.get('MAX_DAILY_PROVISION') ?? 50);
    const todayCount = await this.prisma.machine.count({
      where: { createdAt: { gte: since }, provider: { in: ['gcp', 'lightsail'] } },
    });
    if (todayCount >= dailyLimit) {
      throw new Error(
        `今天已经自动创建了 ${todayCount} 台机器，达到平台每日上限。请稍后再试或联系客服。`,
      );
    }

    // 3. 该云账号当日配额
    if (plan.cloudAccount) {
      const accountCount = await this.prisma.machine.count({
        where: { cloudAccountId: plan.cloudAccount.id, createdAt: { gte: since } },
      });
      if (accountCount >= plan.cloudAccount.dailyCreateQuota) {
        throw new Error(
          `云账号「${plan.cloudAccount.name}」今日建机数已达上限 ${plan.cloudAccount.dailyCreateQuota} 台`,
        );
      }
    }

    // 4. 套餐容量
    if (plan.capacityLimit > 0) {
      const sold = await this.prisma.service.count({
        where: {
          planId: plan.id,
          status: { in: [ServiceStatus.provisioning, ServiceStatus.active, ServiceStatus.stopped] },
        },
      });
      if (sold >= plan.capacityLimit) {
        throw new Error('这个套餐已经售罄');
      }
    }
  }

  /** 按需模式：先写一行 provisioning 状态的机器，建机成功后再补上 IP 和凭据 */
  /**
   * 真正下发给驱动的建机参数。
   *
   * 自定义档下，套餐里的 machineType 和 diskGb 只是默认值，
   * 用户实际选的存在订单上 —— 必须以订单为准，否则他花 8 核的钱拿到 2 核。
   * 重装走的也是这里，所以重装出来的规格和当初买的一致。
   */
  /**
   * 从 NAT 地址池里挑一个还没被占用的地址。
   *
   * 以数据库里的 machines.ip 为准。并发下单时两个任务理论上可能挑到同一个，
   * 但建机队列是串行的，真要横向扩多个 worker 时这里得换成数据库唯一约束。
   */
  private async allocateNatIp(pool: string, gateway?: string): Promise<string> {
    const m = /^(\d+)\.(\d+)\.(\d+)\.\d+\/(\d{1,2})$/.exec(pool.trim());
    if (!m) throw new Error(`NAT 地址池写错了：${pool}。应该形如 172.31.0.0/24`);
    const [, a, b, c, bits] = m;
    const size = 2 ** (32 - Number(bits));
    if (size > 1024) throw new Error('NAT 地址池太大了，最多 /22');

    const used = new Set(
      (
        await this.prisma.machine.findMany({
          where: { ip: { startsWith: `${a}.${b}.${c}.` }, releasedAt: null },
          select: { ip: true },
        })
      ).map((x) => x.ip),
    );
    if (gateway) used.add(gateway);

    // .0 是网络号、最后一个是广播地址，都跳过
    for (let i = 2; i < size - 1; i++) {
      const ip = `${a}.${b}.${c}.${i}`;
      if (!used.has(ip)) return ip;
    }
    throw new Error(`NAT 地址池 ${pool} 已经分完了，扩大网段或者先回收一些机器`);
  }

  private effectiveSpec(
    plan: { providerSpecJson: Prisma.JsonValue; isCustom?: boolean; customConfigJson?: Prisma.JsonValue },
    customSpecJson: Prisma.JsonValue,
  ): Record<string, any> {
    const spec = { ...((plan.providerSpecJson ?? {}) as Record<string, any>) };
    if (!plan.isCustom || !customSpecJson) return spec;

    const cfg = parseCustomConfig(plan.customConfigJson);
    const chosen = normalizeCustomSpec(cfg, customSpecJson);
    spec.machineType = customMachineType(cfg, chosen);
    spec.diskGb = chosen.diskGb;
    return spec;
  }

  private async createMachineRow(plan: {
    id: bigint;
    provider: any;
    cloudAccountId: bigint | null;
    regionLabel: string;
    cpu: number;
    memoryMb: number;
    diskGb: number;
    osTemplate: string | null;
    providerSpecJson: Prisma.JsonValue;
  }, bought?: { cpu: number; memoryMb: number; diskGb: number } | null) {
    const spec = (plan.providerSpecJson ?? {}) as any;
    return this.prisma.machine.create({
      data: {
        code: generateCode('M'),
        provider: plan.provider,
        cloudAccountId: plan.cloudAccountId,
        planId: plan.id,
        region: spec.zone ?? spec.availabilityZone ?? plan.regionLabel,
        cpu: bought?.cpu ?? plan.cpu,
        memoryMb: bought?.memoryMb ?? plan.memoryMb,
        diskGb: bought?.diskGb ?? plan.diskGb,
        osTemplate: plan.osTemplate,
        status: MachineStatus.provisioning,
      },
    });
  }

  /**
   * 库存模式：从池子里抢一台。
   *
   * 用「条件更新 + 版本号」而不是「查出来再更新」—— 后者在两个人同时下单时
   * 会把同一台机器分配给两个人（经典的超卖）。这里如果 updateMany 影响行数是 0，
   * 说明被别人抢先了，换下一台重试。
   */
  private async allocateFromPool(planId: bigint, matchRules: Prisma.JsonValue) {
    const rules = (matchRules ?? {}) as {
      regions?: string[];
      minCpu?: number;
      minMemoryMb?: number;
      tagsAny?: string[];
    };

    const where: Prisma.MachineWhereInput = {
      status: MachineStatus.ready,
      ...(rules.regions?.length ? { region: { in: rules.regions } } : {}),
      ...(rules.minCpu ? { cpu: { gte: rules.minCpu } } : {}),
      ...(rules.minMemoryMb ? { memoryMb: { gte: rules.minMemoryMb } } : {}),
      // 没配匹配规则时就按套餐直接绑定的机器找
      ...(rules.regions?.length || rules.minCpu ? {} : { planId }),
    };

    for (let attempt = 0; attempt < 8; attempt++) {
      const candidates = await this.prisma.machine.findMany({
        where,
        orderBy: { id: 'asc' },
        take: 8,
      });
      if (!candidates.length) break;

      for (const c of candidates) {
        const claimed = await this.prisma.machine.updateMany({
          where: { id: c.id, status: MachineStatus.ready, version: c.version },
          data: { status: MachineStatus.reserved, version: { increment: 1 }, planId },
        });
        if (claimed.count === 1) {
          return this.prisma.machine.findUniqueOrThrow({ where: { id: c.id } });
        }
        // count 是 0 说明这台被别人抢走了，试下一台
      }
    }
    throw new Error('这个套餐当前没有可用库存，请联系客服补货或选择其它套餐');
  }

  /**
   * 建机失败的回滚。
   *
   * 按需模式必须真的把半成品实例销毁掉 —— 云厂商那边只要实例存在就在计费，
   * 建到一半失败留在那儿没人管，一个月能烧掉不少钱。
   */
  private async rollbackMachine(
    machineId: bigint,
    fulfillment: string,
    ctx: any,
    cause: unknown,
  ): Promise<void> {
    const reason = String((cause as any)?.message ?? cause).slice(0, 500);

    if (fulfillment === 'inventory') {
      // 库存机放回池子，别人还能用
      await this.prisma.machine.update({
        where: { id: machineId },
        data: { status: MachineStatus.ready, lastError: reason, version: { increment: 1 } },
      });
      return;
    }

    const rollback = String(this.config.get('PROVISION_ROLLBACK_ON_FAIL') ?? 'true') !== 'false';
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId } });

    // 只要记下过云端标识就一定要去销毁一次，哪怕根本没建成 ——
    // 删一个不存在的实例是幂等的（驱动把「找不到」当成功），
    // 但漏删一个真实存在的实例是要按小时付钱的。宁可多删一次。
    let cleaned = false;
    if (rollback && machine?.providerRefJson) {
      try {
        const driver = this.registry.get(machine.provider);
        await driver.release({ ...ctx, ref: machine.providerRefJson });
        cleaned = true;
        this.logger.log(`已回滚销毁半成品实例 ${machine.code}`);
        await this.nat.detach(machineId);
      } catch (err: any) {
        this.logger.error(
          `回滚销毁 ${machine.code} 失败！这台机器可能还在云厂商那边计费，` +
            `请到控制台手动检查并删除。标识：${JSON.stringify(machine.providerRefJson)}。错误：${err.message}`,
        );
      }
    }

    await this.prisma.machine.update({
      where: { id: machineId },
      data: {
        status: MachineStatus.error,
        // 清理成功才写销毁时间。没清理成功的留空，后台可以按这个筛出「疑似还在计费」的机器。
        releasedAt: cleaned ? new Date() : null,
        lastError: cleaned
          ? reason
          : `${reason}（回滚销毁未确认，请人工到云控制台核对是否有残留实例）`.slice(0, 500),
      },
    });
  }

  private async markOrderFailed(
    orderId: bigint | null,
    serviceId: bigint | null,
    reason: string,
  ): Promise<void> {
    if (orderId) {
      await this.prisma.order
        .update({
          where: { id: orderId },
          data: { status: OrderStatus.failed, failReason: reason.slice(0, 500) },
        })
        .catch(() => undefined);
    }
    if (serviceId) {
      await this.prisma.service
        .update({ where: { id: serviceId }, data: { status: ServiceStatus.error } })
        .catch(() => undefined);
    }
  }

  /** 按计费周期算到期时间。用 setMonth 让「1月31日 + 1月」落到 2月末而不是 3月初。 */
  computeExpireAt(from: Date, cycle: BillingCycle): Date {
    const d = new Date(from);
    const day = d.getDate();
    const add = cycle === BillingCycle.yearly ? 12 : cycle === BillingCycle.quarterly ? 3 : 1;
    d.setMonth(d.getMonth() + add);
    // 溢出了说明目标月份没有这一天（比如 1/31 + 1 月），回退到目标月最后一天
    if (d.getDate() !== day) d.setDate(0);
    return d;
  }
}
