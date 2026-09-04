import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  JobKind,
  MachineStatus,
  OrderStatus,
  Prisma,
  ServiceActionStatus,
  ServiceActionType,
  ServiceStatus,
  UserRole,
  WalletTxType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { encryptJson, generatePassword } from '../crypto/crypto.util';
import { ProvisionQueueService } from '../provisioning/provisioning.processor';
import { WalletService } from '../wallet/wallet.service';
import { AuthedUser } from '../auth/auth.decorators';

/**
 * 用户和管理员对已交付机器的运维操作。
 *
 * 这一层只做三件事：查权限、查状态能不能做这个动作、记一条操作流水，
 * 然后把活交给驱动。至于这台机器是谷歌云的还是自有的，这里完全不关心。
 */
@Injectable()
export class ServicesService {
  private readonly logger = new Logger(ServicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProviderRegistry,
    private readonly config: ConfigService,
    private readonly queue: ProvisionQueueService,
    private readonly wallet: WalletService,
  ) {}

  /** 无理由退货的时限，从机器交付那一刻算起 */
  private refundWindowMinutes(): number {
    const n = Number(this.config.get('REFUND_WINDOW_MINUTES') ?? 10);
    return Number.isFinite(n) && n >= 0 ? n : 10;
  }

  // ---------- 查询 ----------

  async listMine(userId: bigint) {
    const rows = await this.prisma.service.findMany({
      where: { userId, status: { not: ServiceStatus.cancelled } },
      orderBy: { id: 'desc' },
      include: { plan: true, machine: { include: { natBinding: { include: { gateway: { select: { publicHost: true } } } } } } },
    });
    return rows.map((s) => this.toListItem(s));
  }

  async listAll(query: { keyword?: string; status?: ServiceStatus; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const where: Prisma.ServiceWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.keyword
        ? {
            OR: [
              { serviceNo: { contains: query.keyword } },
              { machine: { ip: { contains: query.keyword } } },
              { user: { email: { contains: query.keyword } } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.service.count({ where }),
      this.prisma.service.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          plan: true,
          machine: { include: { natBinding: { include: { gateway: { select: { publicHost: true } } } } } },
          user: { select: { id: true, email: true } },
        },
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      rows: rows.map((s) => ({
        ...this.toListItem(s),
        user: { id: s.user.id.toString(), email: s.user.email },
        // 只有管理员看得到这台机器实际在哪家云、成本多少
        provider: s.machine?.provider,
        machineCode: s.machine?.code,
      })),
    };
  }

  async detail(actor: AuthedUser, id: bigint, refresh = false) {
    const service = await this.load(actor, id);
    // 没有绑定机器时返回 null 而不是「全 false」。全 false 会被前端误读成
    // 「这是一台没有带外管理的机器」，于是给用户看一段完全不相干的解释。
    const caps = service.machine
      ? this.registry.capabilities(service.machine.provider)
      : null;

    let status: unknown = service.lastStatusJson;
    let statusError: string | null = null;
    if (refresh && service.machine) {
      try {
        status = await this.refreshStatus(service.id);
      } catch (e) {
        // 实时探测失败绝不能让整个控制台打不开。机器只要网络抖一下、
        // 或者云厂商那边慢一拍，用户看到的就会是一个 500 —— 他连自己的
        // IP、到期时间、操作按钮都看不到，只会以为机器没了。
        // 这里退回上一次拿到的读数，并把失败原因带给前端说明。
        statusError = e instanceof Error ? e.message : '状态获取失败';
        this.logger.warn(`服务 ${service.serviceNo} 实时状态获取失败：${statusError}`);
      }
    }

    const actions = await this.prisma.serviceAction.findMany({
      where: { serviceId: id },
      orderBy: { id: 'desc' },
      take: 10,
    });

    // 正在建机/重装时，把进度带上，前端画进度条
    const job = await this.prisma.provisionJob.findFirst({
      where: { serviceId: id, status: { in: ['queued', 'running'] } },
      orderBy: { id: 'desc' },
    });

    return {
      ...this.toListItem(service),
      deliver: this.deliverFor(actor, service),
      // 还能不能退货、还剩多久。前端拿它画倒计时，也拿它决定按钮显不显示 ——
      // 让人点了才被拒绝，比压根不显示更让人恼火。
      refundWindow: this.refundWindow(service),
      liveStatus: status,
      statusError,
      lastCheckedAt: service.lastCheckedAt,
      capabilities: caps,
      job: job
        ? { id: job.id.toString(), kind: job.kind, progress: job.progress, step: job.step, status: job.status }
        : null,
      recentActions: actions.map((a) => ({
        id: a.id.toString(),
        action: a.action,
        status: a.status,
        error: a.errorMessage,
        createdAt: a.createdAt,
        finishedAt: a.finishedAt,
      })),
    };
  }

  /** 主动去机器上采一次实时数据，写回库并返回 */
  async refreshStatus(serviceId: bigint) {
    const service = await this.prisma.service.findUniqueOrThrow({
      where: { id: serviceId },
      include: { machine: { include: { cloudAccount: true, natBinding: { select: { sshPort: true, gateway: { select: { publicHost: true } } } } } } },
    });
    if (!service.machine) throw new BadRequestException('这个服务还没有绑定机器');

    const driver = this.registry.get(service.machine.provider);
    const ctx = this.registry.contextFor(service.machine, service.machine.cloudAccount);

    const snapshot = await driver.getStatus(ctx);

    await this.prisma.$transaction([
      this.prisma.service.update({
        where: { id: serviceId },
        data: { lastStatusJson: snapshot as any, lastCheckedAt: new Date() },
      }),
      this.prisma.machine.update({
        where: { id: service.machine.id },
        data: {
          lastStatusJson: snapshot as any,
          lastCheckedAt: new Date(),
          // 云厂商说它关机了，库里的状态也要跟上，否则前端显示的是过期状态
          ...(snapshot.power === 'running'
            ? { status: MachineStatus.running }
            : snapshot.power === 'stopped'
              ? { status: MachineStatus.stopped }
              : {}),
        },
      }),
    ]);
    return snapshot;
  }

  async metrics(actor: AuthedUser, id: bigint, hours = 24) {
    const service = await this.load(actor, id);
    if (!service.machine) throw new BadRequestException('这个服务还没有绑定机器');

    const driver = this.registry.get(service.machine.provider);
    if (!driver.hasMetrics || !driver.metrics) {
      return {
        supported: false,
        message: '这台机器所在的平台不提供历史监控数据，控制台上只显示实时状态',
        series: [],
      };
    }
    const ctx = this.registry.contextFor(service.machine, service.machine.cloudAccount);
    return { supported: true, series: await driver.metrics(ctx, hours) };
  }

  // ---------- 操作 ----------

  async power(actor: AuthedUser, id: bigint, action: 'start' | 'stop' | 'reboot') {
    const service = await this.load(actor, id);
    const machine = this.requireMachine(service);
    const driver = this.registry.get(machine.provider);

    if (action === 'start' && !this.registry.capabilities(machine.provider).canPowerOn) {
      throw new BadRequestException(
        '这台机器没有带外管理，关机之后没法远程开机。请联系客服到机房手动开机。',
      );
    }
    this.assertOperable(service);

    const typeMap = {
      start: ServiceActionType.start,
      stop: ServiceActionType.stop,
      reboot: ServiceActionType.reboot,
    } as const;

    return this.record(service.id, actor, typeMap[action], async () => {
      const ctx = this.registry.contextFor(machine, machine.cloudAccount);
      await driver[action](ctx);
      await this.prisma.machine.update({
        where: { id: machine.id },
        data: {
          status: action === 'stop' ? MachineStatus.stopped : MachineStatus.running,
        },
      });
      await this.prisma.service.update({
        where: { id: service.id },
        data: { status: action === 'stop' ? ServiceStatus.stopped : ServiceStatus.active },
      });
      return { ok: true, message: ACTION_DONE[action] };
    });
  }

  async resetPassword(actor: AuthedUser, id: bigint) {
    const service = await this.load(actor, id);
    const machine = this.requireMachine(service);
    this.assertOperable(service);

    return this.record(service.id, actor, ServiceActionType.reset_password, async () => {
      const driver = this.registry.get(machine.provider);
      const ctx = this.registry.contextFor(machine, machine.cloudAccount);
      const newPassword = generatePassword(16);

      const result = await driver.resetPassword(ctx, newPassword);

      // 库里两个地方都要更新：机器的凭据（面板自己用）和服务的交付信息（用户看的）
      const auth = { ...(ctx.auth ?? { sshUser: 'root', sshPort: 22 }), password: result.password };
      const deliver = { ...((service.deliverPayloadJson ?? {}) as any), password: result.password };

      await this.prisma.$transaction([
        this.prisma.machine.update({
          where: { id: machine.id },
          data: { authPayloadEncrypted: encryptJson(this.secret(), auth) },
        }),
        this.prisma.service.update({
          where: { id: service.id },
          data: { deliverPayloadJson: deliver },
        }),
      ]);

      return {
        ok: true,
        message: '密码已重置',
        username: result.username,
        password: result.password,
      };
    });
  }

  /**
   * 重装。走队列而不是同步执行 —— 谷歌云和 Lightsail 的重装是「销毁再重建」，
   * 要一两分钟，HTTP 请求等不了那么久。
   */
  async rebuild(actor: AuthedUser, id: bigint, confirm: string) {
    const service = await this.load(actor, id);
    const machine = this.requireMachine(service);
    const driver = this.registry.get(machine.provider);

    if (!driver.canRebuild) {
      throw new BadRequestException(`${machine.provider} 平台的机器不支持重装`);
    }
    // 重装会清空整块盘。这是不可逆的，必须让用户把机器编号抄一遍才放行。
    if (confirm !== machine.code) {
      throw new BadRequestException(
        `重装会清空整块系统盘且无法恢复。确认请把机器编号 ${machine.code} 原样填进确认框。`,
      );
    }
    this.assertOperable(service);

    const existing = await this.prisma.provisionJob.findFirst({
      where: { serviceId: id, status: { in: ['queued', 'running'] } },
    });
    if (existing) throw new BadRequestException('这台机器已经有一个任务在跑了，等它结束再操作');

    const job = await this.prisma.provisionJob.create({
      data: {
        kind: JobKind.rebuild,
        serviceId: service.id,
        machineId: machine.id,
        step: '排队中',
      },
    });
    await this.queue.enqueue(job.id);

    await this.prisma.serviceAction.create({
      data: {
        serviceId: service.id,
        actorType: actor.role === UserRole.admin ? 'admin' : 'user',
        actorId: actor.id,
        action: ServiceActionType.rebuild,
        status: ServiceActionStatus.queued,
        requestJson: { jobId: job.id.toString() },
      },
    });

    return {
      ok: true,
      message: '重装已开始，大约需要 1 到 3 分钟。完成后这个页面会显示新的登录密码。',
      jobId: job.id.toString(),
    };
  }

  // ---------- 无理由退货 ----------

  /**
   * 这台机器现在还能不能退，以及还剩多久。
   *
   * 给前端画倒计时用。窗口过了就别再显示那个按钮 —— 让用户点了才被拒绝，
   * 比一开始就不显示更让人恼火。
   */
  refundWindow(service: { status: ServiceStatus; startAt: Date | null; createdAt: Date }) {
    const minutes = this.refundWindowMinutes();
    if (minutes <= 0) return { enabled: false, eligible: false, secondsLeft: 0, minutes };
    // 从交付那一刻算，不是下单那一刻 —— 建机要花一两分钟，
    // 从下单算等于把试用时间偷偷扣掉一截。
    const from = service.startAt ?? service.createdAt;
    const deadline = from.getTime() + minutes * 60_000;
    const secondsLeft = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    const eligible = service.status === ServiceStatus.active && secondsLeft > 0;
    return { enabled: true, eligible, secondsLeft, minutes };
  }

  /**
   * 用户自助退货：销毁机器，钱退回账户余额。
   *
   * 几条底线：
   *
   * - **只退一次**。靠订单状态上的条件更新兜底，不是靠先查再改 ——
   *   用户连点两下、或者两个标签页各点一次，先查后改会退两笔钱出去。
   * - **先断访问再退钱**。顺序反过来的话，中间那段时间用户既拿着钱
   *   又用着机器。所以先尽力关机、把服务标成已取消，最后才入队真删。
   * - **退到余额，不原路退回**。ABA 扫码、线下转账这些通道压根没有退款接口，
   *   假装能原路退只会变成一堆客服工单。页面上写清楚就行。
   * - 建机还没完成的不让退。那时候云上可能已经有一台在计费的机器了，
   *   而我们还没拿到它的标识 —— 这时候删是删不干净的。
   */
  async refund(actor: AuthedUser, id: bigint) {
    const service = await this.load(actor, id);

    const win = this.refundWindow(service);
    if (!win.enabled) throw new BadRequestException('本站没有开放无理由退货');
    if (service.status === ServiceStatus.provisioning) {
      throw new BadRequestException('机器还在开通中，等它开通完成再退');
    }
    if (service.status !== ServiceStatus.active) {
      throw new BadRequestException(`当前状态是「${service.status}」，不能退货`);
    }
    if (!win.eligible) {
      throw new BadRequestException(
        `无理由退货只在交付后 ${win.minutes} 分钟内有效，这台已经超过了。有问题请联系客服。`,
      );
    }

    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: service.orderId } });
    if (order.status === OrderStatus.refunded) {
      throw new BadRequestException('这笔订单已经退过款了');
    }
    const walletCurrency = this.wallet.currency();
    if (order.currency !== walletCurrency) {
      throw new BadRequestException(
        `这笔订单按 ${order.currency} 计价，而账户余额是 ${walletCurrency} 的，` +
          `自助退款会牵扯汇率换算。请联系客服处理。`,
      );
    }

    // 只退一次的闸门：条件更新，抢到的那个才继续往下走
    const claimed = await this.prisma.order.updateMany({
      where: { id: order.id, status: { not: OrderStatus.refunded } },
      data: { status: OrderStatus.refunded },
    });
    if (claimed.count === 0) throw new BadRequestException('这笔订单已经退过款了');

    // 先断访问。关机失败不影响后面的流程 —— 反正马上就要整台删掉了，
    // 但能早关一秒是一秒。
    if (service.machine) {
      const driver = this.registry.get(service.machine.provider);
      const ctx = this.registry.contextFor(service.machine, service.machine.cloudAccount);
      await driver
        .stop(ctx)
        .catch((err) => this.logger.warn(`退货时关机失败（不影响销毁）：${err.message}`));
    }
    await this.prisma.service.update({
      where: { id: service.id },
      data: { status: ServiceStatus.cancelled, suspendReason: '用户自助退货' },
    });

    // 退钱。走到这里订单已经被标成 refunded 了，所以入账失败必须吼出来 ——
    // 那意味着用户机器没了、钱也没回来。
    let balanceAfter: number | null = null;
    try {
      balanceAfter = await this.wallet.credit(service.userId, order.amountCents, {
        type: WalletTxType.refund,
        refType: 'order',
        refNo: order.orderNo,
        remark: `退货：${service.plan?.name ?? ''} ${service.serviceNo}`.trim(),
      });
    } catch (err: any) {
      this.logger.error(
        `订单 ${order.orderNo} 已标记退款但退钱失败，必须人工补：${err?.message ?? err}`,
      );
      throw new BadRequestException(
        '退款没能入账，机器不会被销毁。请联系客服处理，把订单号给客服即可。',
      );
    }

    // 最后才真删。前面几步都成功了，这一步失败也只是留一台待清理的机器，
    // 会在后台的失败任务里露头，不会让用户白白损失。
    let jobId: string | null = null;
    if (service.machine) {
      const job = await this.prisma.provisionJob.create({
        data: {
          kind: JobKind.release,
          serviceId: service.id,
          machineId: service.machine.id,
          step: '排队中',
        },
      });
      await this.queue.enqueue(job.id);
      jobId = job.id.toString();
    }

    await this.prisma.serviceAction.create({
      data: {
        serviceId: service.id,
        actorType: actor.role === UserRole.admin ? 'admin' : 'user',
        actorId: actor.id,
        action: ServiceActionType.refund,
        status: ServiceActionStatus.queued,
        requestJson: { orderNo: order.orderNo, amountCents: order.amountCents },
      },
    });

    this.logger.log(
      `退货：${service.serviceNo} 退回 ${(order.amountCents / 100).toFixed(2)} 到用户 ${service.userId} 的余额`,
    );
    return {
      ok: true,
      message: `已退款 ${(order.amountCents / 100).toFixed(2)}，钱已经回到你的账户余额。机器正在销毁。`,
      refundedCents: order.amountCents,
      balanceAfterCents: balanceAfter,
      jobId,
    };
  }

  // ---------- 管理员专用 ----------

  async suspend(actor: AuthedUser, id: bigint, reason: string) {
    const service = await this.prisma.service.findUniqueOrThrow({
      where: { id },
      include: { machine: { include: { cloudAccount: true, natBinding: { select: { sshPort: true, gateway: { select: { publicHost: true } } } } } } },
    });
    if (service.machine) {
      const driver = this.registry.get(service.machine.provider);
      const ctx = this.registry.contextFor(service.machine, service.machine.cloudAccount);
      // 停用要真的把机器关掉，否则云厂商那边还在计费
      await driver.stop(ctx).catch((err) => this.logger.warn(`停用时关机失败：${err.message}`));
    }
    await this.prisma.service.update({
      where: { id },
      data: { status: ServiceStatus.suspended, suspendReason: reason?.slice(0, 255) || '管理员停用' },
    });
    return { ok: true, message: '已停用并关机' };
  }

  async resume(actor: AuthedUser, id: bigint) {
    const service = await this.prisma.service.findUniqueOrThrow({
      where: { id },
      include: { machine: { include: { cloudAccount: true, natBinding: { select: { sshPort: true, gateway: { select: { publicHost: true } } } } } } },
    });
    if (service.expireAt < new Date()) {
      throw new BadRequestException('这个服务已经过期了，让用户续费后会自动恢复');
    }
    if (service.machine) {
      const driver = this.registry.get(service.machine.provider);
      const ctx = this.registry.contextFor(service.machine, service.machine.cloudAccount);
      await driver.start(ctx).catch((err) => this.logger.warn(`恢复时开机失败：${err.message}`));
    }
    await this.prisma.service.update({
      where: { id },
      data: { status: ServiceStatus.active, suspendReason: null },
    });
    return { ok: true, message: '已恢复' };
  }

  /** 彻底销毁。云机器是真删，库存机是回收再上架。 */
  async release(actor: AuthedUser, id: bigint, confirm: string) {
    const service = await this.prisma.service.findUniqueOrThrow({
      where: { id },
      include: { machine: true },
    });
    if (!service.machine) throw new BadRequestException('这个服务没有绑定机器');
    if (confirm !== service.machine.code) {
      throw new BadRequestException(
        `销毁不可恢复，机器和上面的数据都会没有。确认请把机器编号 ${service.machine.code} 原样填进确认框。`,
      );
    }

    const job = await this.prisma.provisionJob.create({
      data: {
        kind: JobKind.release,
        serviceId: service.id,
        machineId: service.machine.id,
        step: '排队中',
      },
    });
    await this.queue.enqueue(job.id);
    return { ok: true, message: '销毁任务已提交', jobId: job.id.toString() };
  }

  // ---------- 到期任务 ----------

  /**
   * 每小时扫一次到期。
   *
   * 到期不立刻销毁，先停机挂起 —— 用户很可能只是忘了续费，
   * 直接删机器数据就没了，这种投诉是没法解释的。
   * 真正的销毁交给管理员在后台确认，或者按你的策略再加一个宽限期任务。
   */
  @Cron(CronExpression.EVERY_HOUR)
  async expireOverdueServices() {
    const now = new Date();
    const overdue = await this.prisma.service.findMany({
      where: {
        expireAt: { lt: now },
        status: { in: [ServiceStatus.active, ServiceStatus.stopped] },
      },
      include: { machine: { include: { cloudAccount: true, natBinding: { select: { sshPort: true, gateway: { select: { publicHost: true } } } } } } },
      take: 100,
    });
    if (!overdue.length) return;

    this.logger.log(`发现 ${overdue.length} 个到期服务，开始挂起`);
    for (const s of overdue) {
      try {
        if (s.machine) {
          const driver = this.registry.get(s.machine.provider);
          const ctx = this.registry.contextFor(s.machine, s.machine.cloudAccount);
          await driver.stop(ctx).catch((err) => this.logger.warn(`到期关机失败：${err.message}`));
          await this.prisma.machine.update({
            where: { id: s.machine.id },
            data: { status: MachineStatus.suspended },
          });
        }
        await this.prisma.service.update({
          where: { id: s.id },
          data: { status: ServiceStatus.expired, suspendReason: '已到期，续费后自动恢复' },
        });
      } catch (err: any) {
        this.logger.error(`处理到期服务 ${s.serviceNo} 出错：${err.message}`);
      }
    }
  }

  // ---------- 内部 ----------

  private secret(): string {
    const s = this.config.get<string>('CREDENTIALS_SECRET');
    if (!s) throw new Error('.env 里没有配 CREDENTIALS_SECRET');
    return s;
  }

  /** 取服务并校验归属。管理员能看所有人的，普通用户只能看自己的。 */
  private async load(actor: AuthedUser, id: bigint) {
    const service = await this.prisma.service.findUnique({
      where: { id },
      include: { plan: true, machine: { include: { cloudAccount: true, natBinding: { select: { sshPort: true, gateway: { select: { publicHost: true } } } } } } },
    });
    if (!service) throw new NotFoundException('服务不存在');
    if (actor.role !== UserRole.admin && service.userId !== actor.id) {
      // 不说「这是别人的」，说「不存在」—— 否则可以拿它遍历出别人有多少台机器
      throw new NotFoundException('服务不存在');
    }
    return service;
  }

  private requireMachine(service: { machine: any; status: ServiceStatus }) {
    if (!service.machine) {
      throw new BadRequestException(
        service.status === ServiceStatus.provisioning
          ? '机器还在开通中，请等开通完成后再操作'
          : '这个服务没有绑定机器',
      );
    }
    return service.machine;
  }

  private assertOperable(service: { status: ServiceStatus; expireAt: Date }) {
    if (service.status === ServiceStatus.suspended) {
      throw new ForbiddenException('这个服务已被停用，请联系客服');
    }
    if (service.status === ServiceStatus.expired || service.expireAt < new Date()) {
      throw new ForbiddenException('这个服务已经到期，请先续费');
    }
    if (service.status === ServiceStatus.provisioning) {
      throw new BadRequestException('正在开通中，请稍候');
    }
  }

  /** 执行一个动作并记流水。成功失败都留痕，出了纠纷能查。 */
  private async record<T>(
    serviceId: bigint,
    actor: AuthedUser,
    action: ServiceActionType,
    fn: () => Promise<T>,
  ): Promise<T> {
    const row = await this.prisma.serviceAction.create({
      data: {
        serviceId,
        actorType: actor.role === UserRole.admin ? 'admin' : 'user',
        actorId: actor.id,
        action,
        status: ServiceActionStatus.running,
      },
    });
    try {
      const result = await fn();
      await this.prisma.serviceAction.update({
        where: { id: row.id },
        data: {
          status: ServiceActionStatus.success,
          // 结果里可能有新密码，不能原样记进流水
          resultJson: this.scrubResult(result),
          finishedAt: new Date(),
        },
      });
      return result;
    } catch (err: any) {
      await this.prisma.serviceAction.update({
        where: { id: row.id },
        data: {
          status: ServiceActionStatus.failed,
          errorMessage: String(err?.message ?? err).slice(0, 500),
          finishedAt: new Date(),
        },
      });
      throw err;
    }
  }

  private scrubResult(result: any): any {
    if (!result || typeof result !== 'object') return result;
    const { password, ...rest } = result;
    return password ? { ...rest, password: '（已隐去）' } : rest;
  }

  private toListItem(s: any) {
    return {
      id: s.id.toString(),
      serviceNo: s.serviceNo,
      status: s.status,
      planName: s.plan?.name,
      regionLabel: s.plan?.regionLabel,
      cpu: s.plan?.cpu,
      memoryMb: s.plan?.memoryMb,
      diskGb: s.plan?.diskGb,
      // NAT 机器列在这里的必须是买家能连的那个地址。写私网地址等于没写 ——
      // 他复制粘贴一个 172.31 的地址，怎么试都连不上。
      ip: s.machine?.natBinding?.gateway.publicHost ?? s.machine?.ip ?? null,
      sshPort: s.machine?.natBinding?.sshPort ?? s.machine?.sshPort ?? 22,
      isNat: !!s.machine?.natBinding,
      startAt: s.startAt,
      expireAt: s.expireAt,
      daysLeft: Math.ceil((new Date(s.expireAt).getTime() - Date.now()) / 86400000),
      suspendReason: s.suspendReason,
    };
  }

  /** 交付信息（含密码）只给机器的主人和管理员 */
  private deliverFor(actor: AuthedUser, service: any) {
    if (actor.role !== UserRole.admin && service.userId !== actor.id) return null;
    return service.deliverPayloadJson ?? null;
  }
}

const ACTION_DONE = {
  start: '开机指令已发出',
  stop: '关机指令已发出',
  reboot: '重启指令已发出',
} as const;
