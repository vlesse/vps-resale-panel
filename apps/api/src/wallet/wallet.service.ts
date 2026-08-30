import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CurrencyCode, Prisma, RechargeStatus, WalletTxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { generateCode } from '../crypto/crypto.util';
import { AuthedUser } from '../auth/auth.decorators';

/**
 * 余额。
 *
 * 两条铁律，写在最前面因为这是全站唯一直接管钱的地方：
 *
 * 1. **余额只能通过这个服务改。** 任何地方直接 update users.balance_cents
 *    都是 bug —— 那样改完没有流水，事后谁也说不清钱去哪了。
 * 2. **扣款必须是带条件的原子 UPDATE。** 先查余额再扣的写法在并发下
 *    一定会扣成负数：两个请求同时读到 100，各扣 80，最后余额是 -60。
 *    这里用 updateMany + where balanceCents >= 金额，扣不动就是余额不够。
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 钱包币种。
   *
   * 只做单币种：多币种钱包要么得存一套汇率（汇率会漂，账就对不平），
   * 要么得给每个币种各开一个余额（用户会问「为什么我有 100 块却买不了 10 美元的机器」）。
   * 单币种 + 明确拒绝别的币种，是这三种里唯一不会悄悄算错钱的。
   */
  currency(): CurrencyCode {
    const c = (this.config.get<string>('WALLET_CURRENCY') ?? 'CNY').toUpperCase();
    return c === 'USD' ? CurrencyCode.USD : CurrencyCode.CNY;
  }

  // ---------- 查询 ----------

  async summary(userId: bigint) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { balanceCents: true },
    });
    const [recharged, consumed] = await Promise.all([
      this.prisma.walletTx.aggregate({
        where: { userId, type: WalletTxType.recharge },
        _sum: { amountCents: true },
      }),
      this.prisma.walletTx.aggregate({
        where: { userId, type: WalletTxType.consume },
        _sum: { amountCents: true },
      }),
    ]);
    return {
      balanceCents: user.balanceCents,
      currency: this.currency(),
      totalRechargedCents: recharged._sum.amountCents ?? 0,
      // consume 存的是负数，取绝对值给前端
      totalConsumedCents: Math.abs(consumed._sum.amountCents ?? 0),
    };
  }

  async ledger(userId: bigint, query: { page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const [total, rows] = await Promise.all([
      this.prisma.walletTx.count({ where: { userId } }),
      this.prisma.walletTx.findMany({
        where: { userId },
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, page, pageSize, rows: rows.map((t) => this.toPublicTx(t)) };
  }

  // ---------- 记账 ----------

  /**
   * 入账。充值到账、退款都走这里。
   *
   * 余额更新和流水写入放在同一个事务里 —— 中间断掉的话，
   * 要么钱加了没记账（对不上），要么记了账没加钱（用户投诉）。
   */
  async credit(
    userId: bigint,
    amountCents: number,
    meta: { type: WalletTxType; refType?: string; refNo?: string; remark?: string; operatorId?: bigint },
  ) {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new BadRequestException('入账金额必须是大于 0 的整数分');
    }
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { balanceCents: { increment: amountCents } },
        select: { balanceCents: true },
      });
      await tx.walletTx.create({
        data: {
          userId,
          type: meta.type,
          amountCents,
          balanceAfterCents: user.balanceCents,
          currency: this.currency(),
          refType: meta.refType,
          refNo: meta.refNo,
          remark: meta.remark,
          operatorId: meta.operatorId,
        },
      });
      return user.balanceCents;
    });
  }

  /**
   * 扣款。余额不够就抛错，不会扣成负数。
   *
   * 注意这里没有「先查再扣」—— 那样并发下必然超扣。
   * updateMany 带上 balanceCents >= 金额 的条件，数据库层面保证只有
   * 余额真够的那一次能改成功。
   */
  async debit(
    userId: bigint,
    amountCents: number,
    meta: { type: WalletTxType; refType?: string; refNo?: string; remark?: string; operatorId?: bigint },
  ) {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new BadRequestException('扣款金额必须是大于 0 的整数分');
    }
    return this.prisma.$transaction(async (tx) => {
      const hit = await tx.user.updateMany({
        where: { id: userId, balanceCents: { gte: amountCents } },
        data: { balanceCents: { decrement: amountCents } },
      });
      if (hit.count !== 1) {
        const cur = await tx.user.findUnique({
          where: { id: userId },
          select: { balanceCents: true },
        });
        throw new BadRequestException(
          `余额不够。需要 ${fmt(amountCents)}，当前余额 ${fmt(cur?.balanceCents ?? 0)}`,
        );
      }
      const after = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { balanceCents: true },
      });
      await tx.walletTx.create({
        data: {
          userId,
          type: meta.type,
          amountCents: -amountCents,
          balanceAfterCents: after.balanceCents,
          currency: this.currency(),
          refType: meta.refType,
          refNo: meta.refNo,
          remark: meta.remark,
          operatorId: meta.operatorId,
        },
      });
      return after.balanceCents;
    });
  }

  /** 管理员手工调整。正数加、负数减，必须写原因。 */
  async adjust(operator: AuthedUser, userId: bigint, amountCents: number, remark: string) {
    if (!remark?.trim()) {
      throw new BadRequestException('手工调整必须写原因 —— 事后对账全靠这一行字');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');

    const meta = {
      type: WalletTxType.adjust,
      refType: 'admin',
      refNo: operator.email,
      remark: remark.trim().slice(0, 255),
      operatorId: operator.id,
    };
    const balance =
      amountCents > 0
        ? await this.credit(userId, amountCents, meta)
        : await this.debit(userId, -amountCents, meta);
    this.logger.log(
      `管理员 ${operator.email} 给用户 ${user.email} 调整余额 ${amountCents} 分，原因：${remark}`,
    );
    return { ok: true, balanceCents: balance };
  }

  // ---------- 充值单 ----------

  /**
   * 建一张充值单。真正加钱是在支付回调里，不是这里。
   *
   * 同额度的待付款充值单会被复用，避免用户手抖点五次就生成五张单，
   * 然后付了其中一张、剩下四张挂在那里让人以为没付成功。
   */
  async createRecharge(user: AuthedUser, amountCents: number) {
    const min = Number(this.config.get('RECHARGE_MIN_CENTS') ?? 100);
    const max = Number(this.config.get('RECHARGE_MAX_CENTS') ?? 10_000_00);
    if (!Number.isInteger(amountCents) || amountCents < min) {
      throw new BadRequestException(`最低充值 ${fmt(min)}`);
    }
    if (amountCents > max) {
      throw new BadRequestException(`单笔最多充值 ${fmt(max)}，需要更多请分几笔`);
    }

    const minutes = Number(this.config.get('ORDER_EXPIRE_MINUTES') ?? 30);
    const reuse = await this.prisma.rechargeOrder.findFirst({
      where: {
        userId: user.id,
        status: RechargeStatus.pending_payment,
        amountCents,
        expiresAt: { gt: new Date() },
      },
      orderBy: { id: 'desc' },
    });
    if (reuse) return this.toPublicRecharge(reuse);

    const row = await this.prisma.rechargeOrder.create({
      data: {
        rechargeNo: generateCode('RCH'),
        userId: user.id,
        amountCents,
        currency: this.currency(),
        expiresAt: new Date(Date.now() + minutes * 60_000),
      },
    });
    return this.toPublicRecharge(row);
  }

  async myRecharges(userId: bigint, query: { page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const [total, rows] = await Promise.all([
      this.prisma.rechargeOrder.count({ where: { userId } }),
      this.prisma.rechargeOrder.findMany({
        where: { userId },
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, page, pageSize, rows: rows.map((r) => this.toPublicRecharge(r)) };
  }

  async findRecharge(rechargeNo: string) {
    return this.prisma.rechargeOrder.findUnique({ where: { rechargeNo } });
  }

  /**
   * 充值到账。支付回调和管理员手工确认都走这里。
   *
   * **必须幂等**：支付平台的回调会重发，重发时不能重复加钱。
   * 靠充值单的状态判断 —— 已经不是待付款了就直接返回成功。
   */
  async markRechargePaid(
    rechargeNo: string,
    payment: { channel: string; upstreamNo?: string; raw?: any; amountCents?: number },
  ): Promise<{ ok: boolean; message: string }> {
    const row = await this.prisma.rechargeOrder.findUnique({ where: { rechargeNo } });
    if (!row) throw new NotFoundException(`充值单 ${rechargeNo} 不存在`);

    if (row.status !== RechargeStatus.pending_payment) {
      this.logger.log(`充值单 ${rechargeNo} 状态已是 ${row.status}，跳过重复处理`);
      return { ok: true, message: '这笔充值已经处理过了' };
    }

    // 到账金额和单子对不上要留痕。少收了是亏，多收了也得知道。
    let remark = `充值 · ${payment.channel}`;
    if (payment.amountCents != null && payment.amountCents !== row.amountCents) {
      this.logger.error(
        `充值单 ${rechargeNo} 金额对不上！应收 ${row.amountCents}，实收 ${payment.amountCents}`,
      );
      remark += `（应收 ${fmt(row.amountCents)}，实收 ${fmt(payment.amountCents)}，请人工核对）`;
    }

    await this.prisma.rechargeOrder.update({
      where: { id: row.id },
      data: {
        status: RechargeStatus.paid,
        paidAt: new Date(),
        payChannel: payment.channel,
        upstreamNo: payment.upstreamNo,
        rawNotifyJson: (payment.raw ?? null) as Prisma.InputJsonValue,
      },
    });

    // 以单子上的金额入账，不是以对方报的金额 —— 对方报多少就加多少，
    // 等于把加钱的权力交给了回调请求的构造者。
    await this.credit(row.userId, row.amountCents, {
      type: WalletTxType.recharge,
      refType: 'recharge',
      refNo: row.rechargeNo,
      remark,
    });

    return { ok: true, message: '充值已到账' };
  }

  /** 管理员那边看到的充值单列表 */
  async adminRecharges(query: { keyword?: string; status?: RechargeStatus; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const where: Prisma.RechargeOrderWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.keyword
        ? {
            OR: [
              { rechargeNo: { contains: query.keyword } },
              { user: { email: { contains: query.keyword } } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.rechargeOrder.count({ where }),
      this.prisma.rechargeOrder.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { id: true, email: true } } },
      }),
    ]);
    return {
      total,
      page,
      pageSize,
      rows: rows.map((r) => ({
        ...this.toPublicRecharge(r),
        user: { id: r.user.id.toString(), email: r.user.email },
      })),
    };
  }

  /** 管理员手工确认到账（线下转账用） */
  async adminMarkRechargePaid(operator: AuthedUser, rechargeNo: string) {
    const r = await this.markRechargePaid(rechargeNo, { channel: 'manual' });
    this.logger.log(`管理员 ${operator.email} 手工确认充值 ${rechargeNo} 到账`);
    return r;
  }

  /** 管理员看某个用户的流水 */
  async adminLedger(userId: bigint, query: { page?: number; pageSize?: number }) {
    return this.ledger(userId, query);
  }

  // ---------- 转换 ----------

  private toPublicTx(t: {
    id: bigint;
    type: WalletTxType;
    amountCents: number;
    balanceAfterCents: number;
    currency: CurrencyCode;
    refType: string | null;
    refNo: string | null;
    remark: string | null;
    createdAt: Date;
  }) {
    return {
      id: t.id.toString(),
      type: t.type,
      amountCents: t.amountCents,
      balanceAfterCents: t.balanceAfterCents,
      currency: t.currency,
      refType: t.refType,
      refNo: t.refNo,
      remark: t.remark,
      createdAt: t.createdAt,
    };
  }

  private toPublicRecharge(r: {
    id: bigint;
    rechargeNo: string;
    amountCents: number;
    currency: CurrencyCode;
    status: RechargeStatus;
    payChannel: string | null;
    paidAt: Date | null;
    expiresAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: r.id.toString(),
      rechargeNo: r.rechargeNo,
      amountCents: r.amountCents,
      currency: r.currency,
      status: r.status,
      payChannel: r.payChannel,
      paidAt: r.paidAt,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    };
  }
}

function fmt(cents: number): string {
  return (cents / 100).toFixed(2);
}
