import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { decryptJson, encryptJson, tryDecryptJson } from '../crypto/crypto.util';
import { JeepayCredentials, JeepayDriver } from './drivers/jeepay.driver';
import { AuthedUser } from '../auth/auth.decorators';

/**
 * 支付。
 *
 * 通道配置放数据库不放 .env，因为运营过程中换支付商是常事，
 * 改 .env 要重启服务，改数据库不用。商户密钥同样加密存储。
 *
 * 目前内置两种驱动：
 *   jeepay  聚合支付网关，对接扫码/网银/信用卡等
 *   manual  线下转账，用户提交后管理员在后台手工确认
 *
 * 要接第三种，实现一个有 createPayment 和 parseNotify 的类，在 dispatch 里加一支即可。
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly jeepay: JeepayDriver,
    private readonly config: ConfigService,
  ) {}

  private secret(): string {
    const s = this.config.get<string>('CREDENTIALS_SECRET');
    if (!s) throw new Error('.env 里没有配 CREDENTIALS_SECRET');
    return s;
  }

  private baseUrl(): string {
    const u = this.config.get<string>('PUBLIC_BASE_URL');
    if (!u) {
      throw new Error(
        '.env 里没有配 PUBLIC_BASE_URL。支付回调地址是基于它拼出来的，' +
          '不配的话用户付了钱订单不会变成已支付。',
      );
    }
    return u.replace(/\/+$/, '');
  }

  // ---------- 结算页 ----------

  /** 结算页展示的支付方式。不带任何密钥。 */
  async publicChannels() {
    const rows = await this.prisma.payChannel.findMany({
      where: { isEnabled: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return rows.map((c) => ({
      code: c.code,
      name: c.name,
      icon: c.icon,
      driver: c.driver,
      settleCurrency: c.settleCurrency,
      desc: c.descText,
    }));
  }

  // ---------- 发起支付 ----------

  async pay(user: AuthedUser, orderNo: string, channelCode: string, clientIp?: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderNo },
      include: { plan: { select: { name: true, regionLabel: true } } },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.userId !== user.id) throw new NotFoundException('订单不存在');

    if (order.status !== OrderStatus.pending_payment) {
      throw new BadRequestException(
        order.status === OrderStatus.completed
          ? '这笔订单已经完成了，不用再付'
          : `订单当前状态是「${order.status}」，不能发起支付`,
      );
    }
    if (order.expiresAt && order.expiresAt < new Date()) {
      throw new BadRequestException('这笔订单已经超时了，请重新下单');
    }

    const channel = await this.prisma.payChannel.findUnique({ where: { code: channelCode } });
    if (!channel || !channel.isEnabled) throw new BadRequestException('这个支付方式当前不可用');

    if (channel.driver === 'manual') {
      return {
        kind: 'manual' as const,
        message: '请按页面提示完成转账，转账后联系客服确认，管理员确认后会自动开通',
        instructions: channel.descText,
      };
    }

    if (channel.driver !== 'jeepay') {
      throw new BadRequestException(`不认识的支付驱动 ${channel.driver}`);
    }

    const cred = decryptJson<JeepayCredentials>(this.secret(), channel.credentialsEncrypted);
    const result = await this.jeepay.createPayment(
      { ...cred, gatewayUrl: channel.gatewayUrl || cred.gatewayUrl },
      {
        orderNo: order.orderNo,
        amountCents: this.convertAmount(order.amountCents, order.currency, channel),
        currency: channel.settleCurrency || order.currency,
        wayCode: channel.wayCode || '',
        subject: `${order.plan.name}`,
        body: `${order.plan.regionLabel} · ${order.orderNo}`,
        // 回调地址必须公网可达，Jeepay 是从它自己的服务器发过来的
        notifyUrl: `${this.baseUrl()}/api/payments/jeepay/notify`,
        returnUrl: `${this.baseUrl()}/pay/result?orderNo=${order.orderNo}`,
        clientIp,
        rate: channel.rate ?? undefined,
      },
    );

    await this.prisma.order.update({
      where: { id: order.id },
      data: { payChannel: channel.code },
    });

    return {
      kind: 'gateway' as const,
      codeUrl: result.codeUrl,
      payUrl: result.payUrl,
      upstreamNo: result.payOrderId,
    };
  }

  /**
   * 换算金额。
   *
   * 有些通道只以特定货币结算（比如某些东南亚通道只收 KHR），
   * 这时候标价是 CNY 但实际扣款要换算。汇率配在通道上，运营自己维护。
   */
  private convertAmount(
    amountCents: number,
    orderCurrency: string,
    channel: { settleCurrency: string | null; rate: number | null; usdToCnyRate: number | null },
  ): number {
    if (!channel.settleCurrency || channel.settleCurrency === orderCurrency) return amountCents;
    // USD 订单走 CNY 通道时先折成 CNY
    let cents = amountCents;
    if (orderCurrency === 'USD' && channel.usdToCnyRate) {
      cents = Math.round(cents * channel.usdToCnyRate);
    }
    return cents;
  }

  // ---------- 回调 ----------

  /**
   * Jeepay 异步通知。
   *
   * 这个接口不需要登录（支付平台带不了令牌），所以**验签是唯一的防线**。
   * 验签不过一律拒绝，绝不能因为「看着像成功」就放行。
   *
   * 无论成功失败都要尽快返回，处理慢了支付平台会判超时并重发。
   * 建机这种慢活是丢进队列异步做的，这里只写库。
   */
  async handleJeepayNotify(body: Record<string, any>): Promise<string> {
    const orderNo = body?.mchOrderNo;
    this.logger.log(`收到 Jeepay 通知：订单 ${orderNo} state=${body?.state}`);

    if (!orderNo) {
      this.logger.warn('Jeepay 通知里没有 mchOrderNo，忽略');
      return 'fail';
    }

    const order = await this.prisma.order.findUnique({ where: { orderNo } });
    if (!order) {
      this.logger.warn(`Jeepay 通知的订单 ${orderNo} 在库里找不到`);
      return 'fail';
    }

    // 用订单上记着的通道去验签。不能遍历所有通道挨个试 ——
    // 那等于给了攻击者用任意一个通道的密钥去伪造任意订单的机会。
    const channel = order.payChannel
      ? await this.prisma.payChannel.findUnique({ where: { code: order.payChannel } })
      : null;
    if (!channel) {
      this.logger.error(`订单 ${orderNo} 没有记录支付通道，无法验签`);
      return 'fail';
    }

    const cred = tryDecryptJson<JeepayCredentials>(this.secret(), channel.credentialsEncrypted);
    if (!cred) {
      this.logger.error(`通道 ${channel.code} 的凭据解不开，CREDENTIALS_SECRET 可能被改过`);
      return 'fail';
    }

    const parsed = this.jeepay.parseNotify(body, cred);
    if (!parsed.valid) {
      // 验签失败要记下来，这可能是有人在试探
      this.logger.error(`订单 ${orderNo} 的 Jeepay 通知验签失败，已拒绝`);
      return 'fail';
    }
    if (!parsed.success) {
      this.logger.log(`订单 ${orderNo} 支付未成功：${parsed.reason}`);
      // 验签是对的，只是这次状态不是成功。回 success 让平台别再重发这一条。
      return 'success';
    }

    try {
      await this.orders.markPaid(orderNo, {
        channel: channel.code,
        upstreamNo: parsed.upstreamNo,
        amountCents: parsed.amountCents,
        raw: body,
      });
    } catch (err: any) {
      this.logger.error(`处理订单 ${orderNo} 支付成功时出错：${err.message}`);
      // 回 fail 让平台重发，我们下次再试。markPaid 本身是幂等的，重发不会重复建机。
      return 'fail';
    }
    return 'success';
  }

  // ---------- 通道管理 ----------

  async adminList() {
    const rows = await this.prisma.payChannel.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
    return rows.map((c) => ({
      id: c.id.toString(),
      code: c.code,
      name: c.name,
      icon: c.icon,
      driver: c.driver,
      wayCode: c.wayCode,
      settleCurrency: c.settleCurrency,
      gatewayUrl: c.gatewayUrl,
      rate: c.rate,
      usdToCnyRate: c.usdToCnyRate,
      isEnabled: c.isEnabled,
      sortOrder: c.sortOrder,
      descText: c.descText,
      // 只说配没配，不回原文
      credentialSummary: this.summarize(c.driver, c.credentialsEncrypted),
      createdAt: c.createdAt,
    }));
  }

  async createChannel(dto: ChannelInput) {
    if (await this.prisma.payChannel.findUnique({ where: { code: dto.code } })) {
      throw new BadRequestException(`通道代码 ${dto.code} 已经存在`);
    }
    this.validateChannel(dto);
    const c = await this.prisma.payChannel.create({
      data: {
        code: dto.code.trim(),
        name: dto.name.trim(),
        icon: dto.icon ?? null,
        driver: dto.driver,
        wayCode: dto.wayCode ?? null,
        settleCurrency: dto.settleCurrency ?? null,
        gatewayUrl: dto.gatewayUrl ?? null,
        credentialsEncrypted: encryptJson(this.secret(), dto.credentials ?? {}),
        rate: dto.rate ?? null,
        usdToCnyRate: dto.usdToCnyRate ?? null,
        isEnabled: dto.isEnabled ?? true,
        sortOrder: dto.sortOrder ?? 0,
        descText: dto.descText ?? null,
      },
    });
    return { id: c.id.toString(), check: await this.verifyChannel(c.id) };
  }

  async updateChannel(id: bigint, dto: Partial<ChannelInput>) {
    const existing = await this.prisma.payChannel.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('支付通道不存在');

    await this.prisma.payChannel.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
        ...(dto.wayCode !== undefined ? { wayCode: dto.wayCode } : {}),
        ...(dto.settleCurrency !== undefined ? { settleCurrency: dto.settleCurrency } : {}),
        ...(dto.gatewayUrl !== undefined ? { gatewayUrl: dto.gatewayUrl } : {}),
        ...(dto.credentials ? { credentialsEncrypted: encryptJson(this.secret(), dto.credentials) } : {}),
        ...(dto.rate !== undefined ? { rate: dto.rate } : {}),
        ...(dto.usdToCnyRate !== undefined ? { usdToCnyRate: dto.usdToCnyRate } : {}),
        ...(dto.isEnabled !== undefined ? { isEnabled: dto.isEnabled } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.descText !== undefined ? { descText: dto.descText } : {}),
      },
    });
    return dto.credentials ? { check: await this.verifyChannel(id) } : { ok: true };
  }

  async deleteChannel(id: bigint) {
    const channel = await this.prisma.payChannel.findUnique({ where: { id } });
    if (!channel) throw new NotFoundException('支付通道不存在');
    const used = await this.prisma.order.count({ where: { payChannel: channel.code } });
    if (used > 0) {
      // 删掉的话历史订单的回调就验不了签了，而且对账查不到通道信息
      await this.prisma.payChannel.update({ where: { id }, data: { isEnabled: false } });
      return { ok: true, message: `这个通道有 ${used} 笔历史订单，已改为停用而不是删除` };
    }
    await this.prisma.payChannel.delete({ where: { id } });
    return { ok: true, message: '已删除' };
  }

  async verifyChannel(id: bigint) {
    const c = await this.prisma.payChannel.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('支付通道不存在');
    if (c.driver === 'manual') {
      return { ok: true, message: '线下转账通道不需要测试' };
    }
    const cred = tryDecryptJson<JeepayCredentials>(this.secret(), c.credentialsEncrypted);
    if (!cred) return { ok: false, message: '凭据解不开，请重新填一遍' };
    return this.jeepay.verifyCredentials({
      ...cred,
      gatewayUrl: c.gatewayUrl || cred.gatewayUrl,
    });
  }

  private validateChannel(dto: ChannelInput) {
    if (dto.driver === 'jeepay') {
      const c = (dto.credentials ?? {}) as Partial<JeepayCredentials>;
      const missing = (['gatewayUrl', 'mchNo', 'appId', 'appSecret'] as const).filter(
        (k) => !c[k] && !(k === 'gatewayUrl' && dto.gatewayUrl),
      );
      if (missing.length) {
        throw new BadRequestException(`Jeepay 通道还缺这些：${missing.join('、')}`);
      }
      if (!dto.wayCode) {
        throw new BadRequestException(
          '还没填支付方式码（wayCode）。这个值要问你的 Jeepay 服务商要，' +
            '比如支付宝扫码是 ALI_QR、微信扫码是 WX_NATIVE',
        );
      }
    }
  }

  private summarize(driver: string, blob: string): Record<string, string> {
    if (driver === 'manual') return { 类型: '线下转账，无需凭据' };
    const c = tryDecryptJson<any>(this.secret(), blob);
    if (!c) return { 状态: '解密失败，需要重新填写凭据' };
    const secret = String(c.appSecret ?? '');
    return {
      商户号: c.mchNo ?? '?',
      应用ID: c.appId ?? '?',
      密钥: secret ? `${secret.slice(0, 4)}${'*'.repeat(10)}${secret.slice(-4)}` : '未配置',
    };
  }
}

export interface ChannelInput {
  code: string;
  name: string;
  icon?: string;
  driver: 'jeepay' | 'manual';
  wayCode?: string;
  settleCurrency?: string;
  gatewayUrl?: string;
  credentials?: Record<string, any>;
  rate?: number;
  usdToCnyRate?: number;
  isEnabled?: boolean;
  sortOrder?: number;
  descText?: string;
}
