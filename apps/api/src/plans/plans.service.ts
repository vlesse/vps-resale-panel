import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  BillingCycle,
  CurrencyCode,
  Fulfillment,
  MachineStatus,
  Prisma,
  ProviderKind,
  ServiceStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistry } from '../providers/provider.registry';

/** 前台商品卡上那个角标要显示什么 */
export interface Availability {
  /** 能不能下单 */
  inStock: boolean;
  /** 给用户看的一句话：「付款后约 90 秒交付」/「现货 3 台」/「暂时缺货」 */
  label: string;
  /** 库存模式下的现货数量，按需模式为 null */
  stockCount: number | null;
  /** 缺货时说明原因，只给管理员看 */
  adminReason?: string;
}

@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProviderRegistry,
  ) {}

  // ---------- 前台 ----------

  async publicList() {
    const plans = await this.prisma.plan.findMany({
      where: { isEnabled: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: {
        prices: { where: { isEnabled: true }, orderBy: { priceCents: 'asc' } },
        cloudAccount: { select: { id: true, isEnabled: true, dailyCreateQuota: true } },
      },
    });

    return Promise.all(plans.map((p) => this.toPublicPlan(p)));
  }

  async publicDetail(id: bigint) {
    const plan = await this.prisma.plan.findFirst({
      where: { id, isEnabled: true },
      include: {
        prices: { where: { isEnabled: true }, orderBy: { priceCents: 'asc' } },
        cloudAccount: { select: { id: true, isEnabled: true, dailyCreateQuota: true } },
      },
    });
    if (!plan) throw new NotFoundException('套餐不存在或已下架');
    return this.toPublicPlan(plan);
  }

  private async toPublicPlan(plan: any) {
    const caps = this.registry.capabilities(plan.provider);
    return {
      id: plan.id.toString(),
      name: plan.name,
      slug: plan.slug,
      // 前台只说「哪个机房」，不暴露是谷歌云还是 AWS —— 那是你的进货渠道
      regionLabel: plan.regionLabel,
      cpu: plan.cpu,
      memoryMb: plan.memoryMb,
      diskGb: plan.diskGb,
      trafficGb: plan.trafficGb,
      bandwidthLabel: plan.bandwidthLabel,
      osTemplate: plan.osTemplate,
      description: plan.description,
      features: plan.featuresJson ?? [],
      prices: plan.prices.map((pr: any) => ({
        id: pr.id.toString(),
        cycle: pr.cycle,
        currency: pr.currency,
        priceCents: pr.priceCents,
      })),
      availability: await this.availability(plan),
      // 控制台上该显示哪些按钮
      capabilities: { canPowerOn: caps.canPowerOn, canRebuild: caps.canRebuild },
      sortOrder: plan.sortOrder,
    };
  }

  /**
   * 有没有货。
   *
   * 两种履约方式算法完全不同：
   *   按需  只要云账号是好的、配额没满、套餐没卖满，就永远有货
   *   库存  数池子里 ready 的机器有几台
   */
  async availability(plan: {
    id: bigint;
    fulfillment: Fulfillment;
    provider: ProviderKind;
    capacityLimit: number;
    matchRulesJson: Prisma.JsonValue;
    cloudAccount?: { id: bigint; isEnabled: boolean; dailyCreateQuota: number } | null;
  }): Promise<Availability> {
    // 套餐容量先算，两种模式都受它约束
    if (plan.capacityLimit > 0) {
      const sold = await this.prisma.service.count({
        where: {
          planId: plan.id,
          status: { in: [ServiceStatus.provisioning, ServiceStatus.active, ServiceStatus.stopped] },
        },
      });
      if (sold >= plan.capacityLimit) {
        return { inStock: false, label: '已售罄', stockCount: 0, adminReason: '达到套餐容量上限' };
      }
    }

    if (plan.fulfillment === Fulfillment.inventory) {
      const count = await this.prisma.machine.count({
        where: this.poolWhere(plan.id, plan.matchRulesJson),
      });
      if (count <= 0) {
        return { inStock: false, label: '暂时缺货', stockCount: 0, adminReason: '库存池里没有 ready 状态的机器' };
      }
      return {
        inStock: true,
        // 只剩不多时把数字亮出来，是真实信息也确实能促单
        label: count <= 5 ? `现货 ${count} 台` : '现货充足',
        stockCount: count,
      };
    }

    // 按需模式
    if (!plan.cloudAccount) {
      return { inStock: false, label: '暂时缺货', stockCount: null, adminReason: '套餐没有绑定云账号' };
    }
    if (!plan.cloudAccount.isEnabled) {
      return { inStock: false, label: '暂时缺货', stockCount: null, adminReason: '绑定的云账号已被禁用' };
    }

    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const todayCreated = await this.prisma.machine.count({
      where: { cloudAccountId: plan.cloudAccount.id, createdAt: { gte: since } },
    });
    if (todayCreated >= plan.cloudAccount.dailyCreateQuota) {
      return {
        inStock: false,
        label: '今日开通量已满，明天再来',
        stockCount: null,
        adminReason: `云账号今日建机数 ${todayCreated} 已达配额 ${plan.cloudAccount.dailyCreateQuota}`,
      };
    }

    return {
      inStock: true,
      label: plan.provider === ProviderKind.lightsail ? '付款后约 60 秒交付' : '付款后约 90 秒交付',
      stockCount: null,
    };
  }

  /** 库存池的筛选条件。allocateFromPool 里用的是同一套规则，改一处要改两处。 */
  private poolWhere(planId: bigint, matchRules: Prisma.JsonValue): Prisma.MachineWhereInput {
    const rules = (matchRules ?? {}) as {
      regions?: string[];
      minCpu?: number;
      minMemoryMb?: number;
    };
    return {
      status: MachineStatus.ready,
      ...(rules.regions?.length ? { region: { in: rules.regions } } : {}),
      ...(rules.minCpu ? { cpu: { gte: rules.minCpu } } : {}),
      ...(rules.minMemoryMb ? { memoryMb: { gte: rules.minMemoryMb } } : {}),
      ...(rules.regions?.length || rules.minCpu ? {} : { planId }),
    };
  }

  // ---------- 后台 ----------

  async adminList() {
    const plans = await this.prisma.plan.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: {
        prices: true,
        cloudAccount: { select: { id: true, name: true, isEnabled: true, dailyCreateQuota: true } },
        _count: { select: { services: true, orders: true } },
      },
    });

    return Promise.all(
      plans.map(async (p) => ({
        id: p.id.toString(),
        name: p.name,
        slug: p.slug,
        provider: p.provider,
        fulfillment: p.fulfillment,
        cloudAccount: p.cloudAccount
          ? { id: p.cloudAccount.id.toString(), name: p.cloudAccount.name, isEnabled: p.cloudAccount.isEnabled }
          : null,
        providerSpec: p.providerSpecJson,
        matchRules: p.matchRulesJson,
        regionLabel: p.regionLabel,
        cpu: p.cpu,
        memoryMb: p.memoryMb,
        diskGb: p.diskGb,
        trafficGb: p.trafficGb,
        bandwidthLabel: p.bandwidthLabel,
        osTemplate: p.osTemplate,
        description: p.description,
        features: p.featuresJson ?? [],
        capacityLimit: p.capacityLimit,
        isEnabled: p.isEnabled,
        sortOrder: p.sortOrder,
        prices: p.prices.map((pr) => ({
          id: pr.id.toString(),
          cycle: pr.cycle,
          currency: pr.currency,
          priceCents: pr.priceCents,
          isEnabled: pr.isEnabled,
        })),
        soldCount: p._count.services,
        orderCount: p._count.orders,
        availability: await this.availability(p),
      })),
    );
  }

  async create(dto: PlanInput) {
    await this.validate(dto, null);
    const plan = await this.prisma.plan.create({
      data: this.toData(dto),
    });
    if (dto.prices?.length) await this.upsertPrices(plan.id, dto.prices);
    return { id: plan.id.toString() };
  }

  async update(id: bigint, dto: Partial<PlanInput>) {
    const existing = await this.prisma.plan.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('套餐不存在');

    // 数据库字段名和接口字段名不一样（providerSpecJson vs providerSpec），
    // 直接把两个对象摊平合并的话，只改个名字也会被判成「缺建机参数」。
    // 先把数据库行翻译成接口的形状，再让请求体覆盖上去。
    const current: PlanInput = {
      name: existing.name,
      slug: existing.slug,
      provider: existing.provider,
      fulfillment: existing.fulfillment,
      cloudAccountId: existing.cloudAccountId?.toString() ?? null,
      providerSpec: (existing.providerSpecJson ?? undefined) as Record<string, any> | undefined,
      matchRules: (existing.matchRulesJson ?? undefined) as Record<string, any> | undefined,
      regionLabel: existing.regionLabel,
      cpu: existing.cpu,
      memoryMb: existing.memoryMb,
      diskGb: existing.diskGb,
    };
    await this.validate({ ...current, ...dto }, id);

    await this.prisma.plan.update({ where: { id }, data: this.toData(dto, true) });
    if (dto.prices?.length) await this.upsertPrices(id, dto.prices);
    return { ok: true };
  }

  async remove(id: bigint) {
    const live = await this.prisma.service.count({
      where: {
        planId: id,
        status: { in: [ServiceStatus.provisioning, ServiceStatus.active, ServiceStatus.stopped] },
      },
    });
    if (live > 0) {
      throw new BadRequestException(
        `还有 ${live} 个在用的服务挂在这个套餐上，删不得。想停止销售的话把「上架」关掉即可，` +
          '这样老用户不受影响，新用户也看不到它。',
      );
    }
    // 有历史订单的套餐不能真删（订单要能查回来），只能下架
    const orders = await this.prisma.order.count({ where: { planId: id } });
    if (orders > 0) {
      await this.prisma.plan.update({ where: { id }, data: { isEnabled: false } });
      return { ok: true, message: '这个套餐有历史订单，已改为下架而不是删除，订单记录仍可查询' };
    }
    await this.prisma.plan.delete({ where: { id } });
    return { ok: true, message: '已删除' };
  }

  // ---------- 内部 ----------

  private toData(dto: Partial<PlanInput>, partial = false): any {
    const d: any = {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.slug !== undefined ? { slug: dto.slug.trim().toLowerCase() } : {}),
      ...(dto.provider !== undefined ? { provider: dto.provider } : {}),
      ...(dto.fulfillment !== undefined ? { fulfillment: dto.fulfillment } : {}),
      ...(dto.cloudAccountId !== undefined
        ? { cloudAccountId: dto.cloudAccountId ? BigInt(dto.cloudAccountId) : null }
        : {}),
      ...(dto.providerSpec !== undefined ? { providerSpecJson: dto.providerSpec } : {}),
      ...(dto.matchRules !== undefined ? { matchRulesJson: dto.matchRules } : {}),
      ...(dto.regionLabel !== undefined ? { regionLabel: dto.regionLabel } : {}),
      ...(dto.cpu !== undefined ? { cpu: dto.cpu } : {}),
      ...(dto.memoryMb !== undefined ? { memoryMb: dto.memoryMb } : {}),
      ...(dto.diskGb !== undefined ? { diskGb: dto.diskGb } : {}),
      ...(dto.trafficGb !== undefined ? { trafficGb: dto.trafficGb } : {}),
      ...(dto.bandwidthLabel !== undefined ? { bandwidthLabel: dto.bandwidthLabel } : {}),
      ...(dto.osTemplate !== undefined ? { osTemplate: dto.osTemplate } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.features !== undefined ? { featuresJson: dto.features } : {}),
      ...(dto.capacityLimit !== undefined ? { capacityLimit: dto.capacityLimit } : {}),
      ...(dto.isEnabled !== undefined ? { isEnabled: dto.isEnabled } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
    };
    if (!partial) {
      d.regionLabel ??= '未填写';
      d.cpu ??= 1;
      d.memoryMb ??= 1024;
      d.diskGb ??= 20;
    }
    return d;
  }

  /**
   * 建套餐时就把配置错误拦下来。
   * 不拦的话，错误会推迟到「用户付了钱之后建机失败」才暴露 —— 那时候要退款。
   */
  private async validate(dto: PlanInput, selfId: bigint | null): Promise<void> {
    if (!dto.name?.trim()) throw new BadRequestException('套餐名不能为空');
    if (!dto.slug?.trim()) throw new BadRequestException('套餐标识（slug）不能为空');

    const dup = await this.prisma.plan.findUnique({ where: { slug: dto.slug.trim().toLowerCase() } });
    if (dup && dup.id !== selfId) throw new BadRequestException(`标识 ${dto.slug} 已经被别的套餐用了`);

    const driver = this.registry.get(dto.provider);

    if (dto.fulfillment === Fulfillment.on_demand) {
      if (!driver.canProvision) {
        throw new BadRequestException(
          `${dto.provider} 驱动没法自己创建机器，这个套餐只能用「库存池」模式。` +
            '（能自动建机的是谷歌云和 AWS Lightsail）',
        );
      }
      if (!dto.cloudAccountId) {
        throw new BadRequestException('「下单即开」的套餐必须绑定一个云账号，不然拿什么去建机');
      }
      const account = await this.prisma.cloudAccount.findUnique({
        where: { id: BigInt(dto.cloudAccountId) },
      });
      if (!account) throw new BadRequestException('绑定的云账号不存在');
      if (account.provider !== dto.provider) {
        throw new BadRequestException(
          `套餐驱动是 ${dto.provider}，但绑的是 ${account.provider} 的账号，对不上`,
        );
      }

      const spec = (dto.providerSpec ?? {}) as Record<string, any>;
      const required: Record<string, string[]> = {
        gcp: ['zone', 'machineType', 'sourceImage'],
        lightsail: ['availabilityZone', 'bundleId', 'blueprintId'],
        proxmox: ['templateVmid'],
      };
      const missing = (required[dto.provider] ?? []).filter((k) => !spec[k]);
      if (missing.length) {
        throw new BadRequestException(`还缺这些建机参数：${missing.join('、')}`);
      }
      if (dto.provider === ProviderKind.lightsail && !/[a-z]$/.test(String(spec.availabilityZone))) {
        throw new BadRequestException(
          `可用区写错了：${spec.availabilityZone}。要带结尾字母，比如 ap-southeast-1a`,
        );
      }
      if (!spec.staticIp) {
        // 不是错误，但后果严重到必须让人知道，所以用报错的方式逼他确认
        throw new BadRequestException(
          '这个套餐没开「固定公网 IP」。不开的话用户每次重装系统 IP 都会变，是投诉重灾区。' +
            '确实不想开的话，请在建机参数里显式写 "staticIp": false。',
        );
      }
    } else {
      if (!dto.matchRules && dto.provider !== ProviderKind.ssh && dto.provider !== ProviderKind.proxmox) {
        throw new BadRequestException('库存池模式请填匹配规则，或者把机器直接绑定到这个套餐上');
      }
    }
  }

  private async upsertPrices(
    planId: bigint,
    prices: { cycle: BillingCycle; currency: CurrencyCode; priceCents: number; isEnabled?: boolean }[],
  ) {
    for (const p of prices) {
      if (p.priceCents < 0) throw new BadRequestException('价格不能是负数');
      await this.prisma.planPrice.upsert({
        where: { planId_cycle_currency: { planId, cycle: p.cycle, currency: p.currency } },
        create: {
          planId,
          cycle: p.cycle,
          currency: p.currency,
          priceCents: Math.round(p.priceCents),
          isEnabled: p.isEnabled ?? true,
        },
        update: {
          priceCents: Math.round(p.priceCents),
          isEnabled: p.isEnabled ?? true,
        },
      });
    }
  }
}

export interface PlanInput {
  name: string;
  slug: string;
  provider: ProviderKind;
  fulfillment: Fulfillment;
  cloudAccountId?: string | null;
  providerSpec?: Record<string, any>;
  matchRules?: Record<string, any>;
  regionLabel: string;
  cpu: number;
  memoryMb: number;
  diskGb: number;
  trafficGb?: number;
  bandwidthLabel?: string;
  osTemplate?: string;
  description?: string;
  features?: string[];
  capacityLimit?: number;
  isEnabled?: boolean;
  sortOrder?: number;
  prices?: { cycle: BillingCycle; currency: CurrencyCode; priceCents: number; isEnabled?: boolean }[];
}
