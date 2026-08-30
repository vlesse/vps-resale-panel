import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  BillingCycle,
  CurrencyCode,
  MachineStatus,
  OrderKind,
  OrderStatus,
  Prisma,
  ServiceStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PlansService } from '../plans/plans.service';
import { ProvisioningService } from '../provisioning/provisioning.service';
import { ProvisionQueueService } from '../provisioning/provisioning.processor';
import { generateCode } from '../crypto/crypto.util';
import { AuthedUser } from '../auth/auth.decorators';

/**
 * 订单。
 *
 * 一条贯穿始终的原则：**能在下单前拦住的错误，绝不留到付款后**。
 * 用户付完钱才发现没库存、超了配额、套餐配错了，就得走退款 —— 退款是最贵的错误，
 * 既伤口碑又费人工。所以创建订单时就把库存、配额、套餐配置全查一遍。
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
    private readonly provisioning: ProvisioningService,
    private readonly queue: ProvisionQueueService,
    private readonly config: ConfigService,
  ) {}

  // ---------- 下单 ----------

  async create(
    user: AuthedUser,
    dto: {
      planId: string;
      cycle?: BillingCycle;
      currency: CurrencyCode;
      remark?: string;
      /** 自定义档才有：用户选的 { cpu, memoryMb, diskGb } */
      customSpec?: { cpu: number; memoryMb: number; diskGb: number };
    },
  ) {
    const plan = await this.prisma.plan.findUnique({
      where: { id: BigInt(dto.planId) },
      include: {
        prices: true,
        cloudAccount: { select: { id: true, isEnabled: true, dailyCreateQuota: true } },
      },
    });
    if (!plan || !plan.isEnabled) throw new NotFoundException('套餐不存在或已下架');

    const cycle = dto.cycle ?? BillingCycle.monthly;
    const price = plan.prices.find(
      (p) => p.cycle === cycle && p.currency === dto.currency && p.isEnabled,
    );
    if (!price) {
      throw new BadRequestException(
        `这个套餐没有「${CYCLE_LABEL[cycle]} / ${dto.currency}」的价格，换一个周期或币种试试`,
      );
    }

    // 自定义档：规格和价格都在服务端重算一遍。
    // 前端传上来的金额一律不信 —— 改个数字就能一块钱买十六核，
    // 而这一单会在你的云账号上真建出一台机器。
    let amountCents = price.priceCents;
    let customSpec: { cpu: number; memoryMb: number; diskGb: number } | null = null;
    if (plan.isCustom) {
      const r = this.plans.computeCustomPrice(plan.customConfigJson, dto.customSpec, dto.currency);
      customSpec = r.spec;
      amountCents = r.priceCents;
    }

    // 1. 有没有货
    const availability = await this.plans.availability(plan);
    if (!availability.inStock) {
      throw new BadRequestException(`暂时无法下单：${availability.label}`);
    }

    // 2. 这个用户还能不能再买
    await this.assertUserCanBuy(user.id);

    // 3. 有没有还没付款的同款订单 —— 让他先付那一单，别攒一堆待付款订单占着库存
    const pending = await this.prisma.order.findFirst({
      where: {
        userId: user.id,
        planId: plan.id,
        status: OrderStatus.pending_payment,
        expiresAt: { gt: new Date() },
        // 自定义档下两次可能选的是完全不同的规格，只有一模一样才算「同一单」
        ...(plan.isCustom ? { amountCents } : {}),
      },
    });
    if (pending) {
      return {
        orderNo: pending.orderNo,
        reused: true,
        message: '你有一笔同款的待付款订单，已经带你回到那一单',
      };
    }

    const minutes = Number(this.config.get('ORDER_EXPIRE_MINUTES') ?? 30);
    const order = await this.prisma.order.create({
      data: {
        orderNo: generateCode('ORD'),
        kind: OrderKind.new,
        userId: user.id,
        planId: plan.id,
        planPriceId: price.id,
        cycle,
        amountCents,
        currency: price.currency,
        customSpecJson: customSpec ?? undefined,
        clientRemark: dto.remark?.slice(0, 255),
        expiresAt: new Date(Date.now() + minutes * 60000),
      },
    });

    return {
      orderNo: order.orderNo,
      amountCents: order.amountCents,
      currency: order.currency,
      expiresAt: order.expiresAt,
      reused: false,
    };
  }

  /** 续费下单。不占库存也不建机，付款后只把到期时间往后推。 */
  async createRenewal(
    user: AuthedUser,
    serviceId: bigint,
    dto: { cycle?: BillingCycle; currency: CurrencyCode },
  ) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: {
        plan: { include: { prices: true } },
        // 续费要照着当初那一单的金额和规格来，所以得把原订单带出来
        order: { select: { amountCents: true, customSpecJson: true } },
      },
    });
    if (!service) throw new NotFoundException('服务不存在');
    if (user.role !== UserRole.admin && service.userId !== user.id) {
      throw new NotFoundException('服务不存在');
    }
    if (service.status === ServiceStatus.cancelled) {
      throw new BadRequestException('这个服务已经销毁了，续费也回不来，请重新下单');
    }

    const cycle = dto.cycle ?? BillingCycle.monthly;
    const price = service.plan.prices.find(
      (p) => p.cycle === cycle && p.currency === dto.currency && p.isEnabled,
    );
    if (!price) throw new BadRequestException('这个套餐没有对应周期或币种的价格');

    const pending = await this.prisma.order.findFirst({
      where: {
        renewServiceId: serviceId,
        status: OrderStatus.pending_payment,
        expiresAt: { gt: new Date() },
      },
    });
    if (pending) {
      return { orderNo: pending.orderNo, reused: true, message: '这台机器已经有一笔待付款的续费单' };
    }

    const minutes = Number(this.config.get('ORDER_EXPIRE_MINUTES') ?? 30);
    const order = await this.prisma.order.create({
      data: {
        orderNo: generateCode('RN'),
        kind: OrderKind.renew,
        userId: service.userId,
        planId: service.planId,
        planPriceId: price.id,
        cycle,
        // 续费按这台机器当初买的规格算钱，而不是套餐的基准价 ——
        // 自定义档买的是 8 核，续费当然不能按 2 核收。
        amountCents: service.order?.amountCents ?? price.priceCents,
        currency: price.currency,
        renewServiceId: serviceId,
        expiresAt: new Date(Date.now() + minutes * 60000),
      },
    });

    return {
      orderNo: order.orderNo,
      amountCents: order.amountCents,
      currency: order.currency,
      expiresAt: order.expiresAt,
      // 让用户看到续到哪天，比只显示「续费一个月」清楚得多
      newExpireAt: this.provisioning.computeExpireAt(
        service.expireAt > new Date() ? service.expireAt : new Date(),
        cycle,
      ),
      reused: false,
    };
  }

  // ---------- 查询 ----------

  async listMine(userId: bigint) {
    const rows = await this.prisma.order.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      take: 100,
      include: { plan: { select: { name: true, regionLabel: true } } },
    });
    return rows.map((o) => this.toItem(o));
  }

  async detail(user: AuthedUser, orderNo: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderNo },
      include: {
        plan: { select: { name: true, regionLabel: true, cpu: true, memoryMb: true, diskGb: true } },
        payments: { orderBy: { id: 'desc' } },
        service: { select: { id: true, serviceNo: true, status: true } },
        jobs: { orderBy: { id: 'desc' }, take: 1 },
      },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (user.role !== UserRole.admin && order.userId !== user.id) {
      throw new NotFoundException('订单不存在');
    }

    const job = order.jobs[0];
    return {
      ...this.toItem(order),
      plan: order.plan,
      service: order.service
        ? { id: order.service.id.toString(), serviceNo: order.service.serviceNo, status: order.service.status }
        : null,
      // 开通进度，前端拿它画进度条
      provisioning: job
        ? { status: job.status, progress: job.progress, step: job.step, error: job.lastError }
        : null,
      payments: order.payments.map((p) => ({
        paymentNo: p.paymentNo,
        channel: p.channel,
        status: p.status,
        amountCents: p.amountCents,
        currency: p.currency,
        paidAt: p.paidAt,
      })),
    };
  }

  /** 支付页轮询它判断付款到账没有。刻意做得很轻，因为前端会每 2 秒调一次。 */
  async paymentStatus(user: AuthedUser, orderNo: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderNo },
      select: {
        userId: true,
        status: true,
        paidAt: true,
        failReason: true,
        service: { select: { id: true, status: true } },
        jobs: {
          orderBy: { id: 'desc' },
          take: 1,
          select: { status: true, progress: true, step: true, lastError: true },
        },
      },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (user.role !== UserRole.admin && order.userId !== user.id) {
      throw new NotFoundException('订单不存在');
    }

    const job = order.jobs[0];
    return {
      status: order.status,
      paid: !!order.paidAt,
      failReason: order.failReason,
      serviceId: order.service?.id?.toString() ?? null,
      serviceStatus: order.service?.status ?? null,
      progress: job?.progress ?? (order.status === OrderStatus.completed ? 100 : 0),
      step: job?.step ?? null,
      jobError: job?.lastError ?? null,
    };
  }

  // ---------- 状态流转 ----------

  /**
   * 标记订单已支付并触发后续动作。支付回调和管理员手工补单都走这里。
   *
   * 幂等是硬要求：支付平台在没收到成功响应时会反复重发通知，
   * 处理不当就会给一笔订单建出好几台机器 —— 每台都在烧你的云账单。
   */
  async markPaid(
    orderNo: string,
    payment: { channel: string; upstreamNo?: string; raw?: any; amountCents?: number },
  ): Promise<{ ok: boolean; message: string }> {
    const order = await this.prisma.order.findUnique({
      where: { orderNo },
      include: { payments: true },
    });
    if (!order) throw new NotFoundException(`订单 ${orderNo} 不存在`);

    if (order.status !== OrderStatus.pending_payment) {
      // 已经处理过了，直接回成功让支付平台别再重发
      this.logger.log(`订单 ${orderNo} 状态已是 ${order.status}，跳过重复处理`);
      return { ok: true, message: '订单已处理过' };
    }

    // 金额对不上是要报警的：可能是通道配错了汇率，也可能有人在改请求
    if (payment.amountCents != null && payment.amountCents !== order.amountCents) {
      this.logger.error(
        `订单 ${orderNo} 金额对不上！应收 ${order.amountCents}，实收 ${payment.amountCents}`,
      );
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          adminRemark: `金额异常：应收 ${order.amountCents} 实收 ${payment.amountCents}，需人工核对`,
        },
      });
    }

    await this.prisma.$transaction([
      this.prisma.payment.create({
        data: {
          orderId: order.id,
          paymentNo: generateCode('PAY'),
          channel: payment.channel,
          amountCents: payment.amountCents ?? order.amountCents,
          currency: order.currency,
          status: 'success',
          upstreamNo: payment.upstreamNo,
          rawNotifyJson: (payment.raw ?? null) as Prisma.InputJsonValue,
          paidAt: new Date(),
        },
      }),
      this.prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.paid, paidAt: new Date(), payChannel: payment.channel },
      }),
    ]);

    // 续费不建机，只延长到期时间，同步做完就行
    if (order.kind === OrderKind.renew) {
      await this.provisioning.applyRenewal(order.id);
      return { ok: true, message: '续费已生效' };
    }

    // 新购走队列，因为建机要一两分钟，支付平台的回调等不了
    const { jobId } = await this.provisioning.startProvision(order.id);
    await this.queue.enqueue(jobId);
    return { ok: true, message: '已受理，正在开通' };
  }

  async cancel(user: AuthedUser, orderNo: string) {
    const order = await this.prisma.order.findUnique({ where: { orderNo } });
    if (!order) throw new NotFoundException('订单不存在');
    if (user.role !== UserRole.admin && order.userId !== user.id) {
      throw new NotFoundException('订单不存在');
    }
    if (order.status !== OrderStatus.pending_payment) {
      throw new BadRequestException(
        order.status === OrderStatus.completed
          ? '这笔订单已经开通完成了，取消请走退款流程'
          : `当前状态（${order.status}）不能取消`,
      );
    }
    await this.prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.cancelled },
    });
    return { ok: true, message: '订单已取消' };
  }

  // ---------- 管理员 ----------

  async adminList(query: {
    keyword?: string;
    status?: OrderStatus;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const where: Prisma.OrderWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.keyword
        ? {
            OR: [
              { orderNo: { contains: query.keyword } },
              { user: { email: { contains: query.keyword } } },
            ],
          }
        : {}),
    };

    const [total, rows, sums] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          plan: { select: { name: true, regionLabel: true } },
          user: { select: { id: true, email: true } },
          jobs: { orderBy: { id: 'desc' }, take: 1 },
        },
      }),
      this.prisma.order.groupBy({
        by: ['currency'],
        where: { status: { in: [OrderStatus.paid, OrderStatus.completed, OrderStatus.provisioning] } },
        _sum: { amountCents: true },
        _count: true,
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      // 后台顶部那排数字：各币种已收多少
      revenue: sums.map((s) => ({
        currency: s.currency,
        totalCents: s._sum.amountCents ?? 0,
        orderCount: s._count,
      })),
      rows: rows.map((o) => ({
        ...this.toItem(o),
        user: { id: o.user.id.toString(), email: o.user.email },
        provisioning: o.jobs[0]
          ? { status: o.jobs[0].status, progress: o.jobs[0].progress, step: o.jobs[0].step, error: o.jobs[0].lastError }
          : null,
      })),
    };
  }

  /**
   * 手工补单。用户线下转账、或者支付回调丢了的时候用。
   * 走的是和自动回调完全同一条路径，所以不会出现「手工补的单和自动的单行为不一样」。
   */
  async adminMarkPaid(orderNo: string, note?: string) {
    const result = await this.markPaid(orderNo, { channel: 'manual', raw: { note } });
    await this.prisma.order.update({
      where: { orderNo },
      data: { adminRemark: `管理员手工标记已付${note ? '：' + note : ''}` },
    });
    return result;
  }

  /** 建机失败后重试。失败的机器已经在失败时回滚掉了，这里是从头重新建一台。 */
  async adminRetryProvision(orderNo: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderNo },
      include: { jobs: { orderBy: { id: 'desc' }, take: 1 }, service: true },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status === OrderStatus.completed) {
      throw new BadRequestException('这笔订单已经开通成功了，不用重试');
    }
    const retryable: OrderStatus[] = [OrderStatus.paid, OrderStatus.provisioning, OrderStatus.failed];
    if (!retryable.includes(order.status)) {
      throw new BadRequestException(`当前状态（${order.status}）不能重试开通，用户还没付款`);
    }

    const running = order.jobs[0];
    if (running && ['queued', 'running'].includes(running.status)) {
      throw new BadRequestException('已经有一个开通任务在跑了，等它结束');
    }

    // 上一次失败留下的 service 占位要复用，但任务要新建一个 ——
    // 沿用旧任务号的话，队列会按 ID 去重把这次重试丢掉。
    const { jobId } = await this.provisioning.startProvision(order.id, { force: true });
    await this.queue.enqueue(jobId);
    return { ok: true, message: '已重新排队开通', jobId: jobId.toString() };
  }

  // ---------- 定时任务 ----------

  /**
   * 每 5 分钟清理超时未付款的订单。
   *
   * 不清的话，库存模式下被 reserved 的机器会一直挂着卖不出去 ——
   * 用户点了下单没付钱就走了是常态，这个清理必须有。
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async cancelExpiredOrders() {
    const expired = await this.prisma.order.findMany({
      where: { status: OrderStatus.pending_payment, expiresAt: { lt: new Date() } },
      take: 200,
    });
    if (!expired.length) return;

    for (const o of expired) {
      await this.prisma.order.update({
        where: { id: o.id },
        data: { status: OrderStatus.cancelled, failReason: '超时未付款，已自动取消' },
      });
    }

    // 把被这些订单占着的库存机放回池子
    const released = await this.prisma.machine.updateMany({
      where: { status: MachineStatus.reserved, service: null, updatedAt: { lt: new Date(Date.now() - 3600_000) } },
      data: { status: MachineStatus.ready },
    });

    this.logger.log(
      `清理了 ${expired.length} 笔超时订单` + (released.count ? `，放回 ${released.count} 台库存机` : ''),
    );
  }

  // ---------- 内部 ----------

  private async assertUserCanBuy(userId: bigint): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const limit =
      user.maxActiveServices > 0
        ? user.maxActiveServices
        : Number(this.config.get('MAX_ACTIVE_SERVICES_PER_USER') ?? 5);

    const active = await this.prisma.service.count({
      where: {
        userId,
        status: { in: [ServiceStatus.provisioning, ServiceStatus.active, ServiceStatus.stopped] },
      },
    });
    if (active >= limit) {
      throw new BadRequestException(
        `你名下已有 ${active} 台机器，达到上限 ${limit} 台。需要更多请联系客服提额。`,
      );
    }

    // 未付款的订单也算进去，否则可以先攒 100 笔待付款订单再一起付
    const pendingCount = await this.prisma.order.count({
      where: {
        userId,
        kind: OrderKind.new,
        status: OrderStatus.pending_payment,
        expiresAt: { gt: new Date() },
      },
    });
    if (active + pendingCount >= limit) {
      throw new BadRequestException(
        `你有 ${pendingCount} 笔待付款订单，加上已有的 ${active} 台机器已经到上限了。` +
          '请先付款或取消掉不要的订单。',
      );
    }
  }

  private toItem(o: any) {
    return {
      orderNo: o.orderNo,
      kind: o.kind,
      status: o.status,
      statusLabel: STATUS_LABEL[o.status as OrderStatus] ?? o.status,
      planName: o.plan?.name,
      regionLabel: o.plan?.regionLabel,
      cycle: o.cycle,
      cycleLabel: CYCLE_LABEL[o.cycle as BillingCycle],
      amountCents: o.amountCents,
      currency: o.currency,
      payChannel: o.payChannel,
      paidAt: o.paidAt,
      expiresAt: o.expiresAt,
      failReason: o.failReason,
      createdAt: o.createdAt,
    };
  }
}

const CYCLE_LABEL: Record<BillingCycle, string> = {
  monthly: '月付',
  quarterly: '季付',
  yearly: '年付',
};

/** 状态直接给中文，前端不用再维护一份映射表 */
const STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: '待付款',
  paid: '已付款',
  provisioning: '开通中',
  completed: '已完成',
  cancelled: '已取消',
  refunded: '已退款',
  failed: '开通失败',
};
