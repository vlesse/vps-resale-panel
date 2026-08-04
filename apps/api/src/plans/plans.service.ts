import { Injectable, NotFoundException } from '@nestjs/common';
import { BillingCycle, CurrencyCode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { serialize } from '../common/utils';

@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  listPublic() {
    return this.prisma.plan
      .findMany({
        where: { isEnabled: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        include: {
          prices: {
            where: { isEnabled: true, cycle: BillingCycle.monthly },
          },
        },
      })
      .then(serialize);
  }

  async getPublic(id: string) {
    const plan = await this.prisma.plan.findFirst({
      where: { id: BigInt(id), isEnabled: true },
      include: {
        prices: { where: { isEnabled: true, cycle: BillingCycle.monthly } },
      },
    });
    if (!plan) throw new NotFoundException('Plan not found');
    return serialize(plan);
  }

  adminList() {
    return this.prisma.plan
      .findMany({
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        include: { prices: true },
      })
      .then(serialize);
  }

  async adminCreate(body: {
    name: string;
    slug: string;
    regionLabel: string;
    cpu: number;
    memoryMb: number;
    diskGb: number;
    bandwidthLabel?: string;
    description?: string;
    featuresJson?: unknown;
    matchRulesJson?: unknown;
    sortOrder?: number;
    prices?: Array<{ currency: CurrencyCode; priceCents: number }>;
  }) {
    const plan = await this.prisma.plan.create({
      data: {
        name: body.name,
        slug: body.slug,
        regionLabel: body.regionLabel,
        cpu: body.cpu,
        memoryMb: body.memoryMb,
        diskGb: body.diskGb,
        bandwidthLabel: body.bandwidthLabel,
        description: body.description,
        featuresJson: body.featuresJson as any,
        matchRulesJson: body.matchRulesJson as any,
        sortOrder: body.sortOrder ?? 0,
        prices: body.prices
          ? {
              create: body.prices.map((p) => ({
                cycle: BillingCycle.monthly,
                currency: p.currency,
                priceCents: p.priceCents,
              })),
            }
          : undefined,
      },
      include: { prices: true },
    });
    return serialize(plan);
  }

  async adminUpdate(
    id: string,
    body: Partial<{
      name: string;
      regionLabel: string;
      cpu: number;
      memoryMb: number;
      diskGb: number;
      bandwidthLabel: string;
      description: string;
      featuresJson: unknown;
      matchRulesJson: unknown;
      isEnabled: boolean;
      sortOrder: number;
    }>,
  ) {
    const plan = await this.prisma.plan.update({
      where: { id: BigInt(id) },
      data: {
        name: body.name,
        regionLabel: body.regionLabel,
        cpu: body.cpu,
        memoryMb: body.memoryMb,
        diskGb: body.diskGb,
        bandwidthLabel: body.bandwidthLabel,
        description: body.description,
        featuresJson: body.featuresJson as any,
        matchRulesJson: body.matchRulesJson as any,
        isEnabled: body.isEnabled,
        sortOrder: body.sortOrder,
      },
      include: { prices: true },
    });
    return serialize(plan);
  }

  async upsertPrice(
    planId: string,
    currency: CurrencyCode,
    priceCents: number,
  ) {
    const price = await this.prisma.planPrice.upsert({
      where: {
        planId_cycle_currency: {
          planId: BigInt(planId),
          cycle: BillingCycle.monthly,
          currency,
        },
      },
      create: {
        planId: BigInt(planId),
        cycle: BillingCycle.monthly,
        currency,
        priceCents,
      },
      update: { priceCents, isEnabled: true },
    });
    return serialize(price);
  }
}
