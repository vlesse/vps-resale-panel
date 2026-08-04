import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  CurrencyCode,
  InventoryStatus,
  OrderStatus,
  PaymentStatus,
  ServiceStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { PayChannelsService } from '../paychannels/paychannels.service';
import { createHash } from 'crypto';
import {
  addMonths,
  genOrderNo,
  jeepaySign,
  serialize,
} from '../common/utils';
import { decryptJson, ServerAuthPayload } from '../crypto/crypto.util';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly payChannels: PayChannelsService,
    private readonly config: ConfigService,
  ) {}

  private publicBase(): string {
    // Prefer explicit public base; fall back to IP-friendly default for Baidu VPS
    return (
      this.config.get<string>('PUBLIC_BASE_URL') ||
      this.config.get<string>('APP_BASE_URL') ||
      'http://120.48.131.216'
    ).replace(/\/$/, '');
  }

  async createOrder(
    userId: string,
    body: { planId: string; currency: CurrencyCode; clientRemark?: string },
  ) {
    if (body.currency !== CurrencyCode.CNY && body.currency !== CurrencyCode.USD) {
      throw new BadRequestException('currency must be CNY or USD');
    }

    const plan = await this.prisma.plan.findFirst({
      where: { id: BigInt(body.planId), isEnabled: true },
      include: {
        prices: {
          where: {
            currency: body.currency,
            cycle: 'monthly',
            isEnabled: true,
          },
        },
      },
    });
    if (!plan) throw new NotFoundException('Plan not found');
    const price = plan.prices[0];
    if (!price) {
      throw new BadRequestException(`No monthly price for ${body.currency}`);
    }

    // New purchase consumes stock; renew orders are created elsewhere
    const stock = await this.inventory.countReadyForPlan(plan.id);
    if (stock < 1) {
      throw new BadRequestException({
        code: 'OUT_OF_STOCK',
        message: 'Out of stock for this plan',
        planId: body.planId,
      });
    }

    const order = await this.prisma.order.create({
      data: {
        orderNo: genOrderNo('VR'),
        userId: BigInt(userId),
        planId: plan.id,
        planPriceId: price.id,
        cycle: 'monthly',
        amountCents: price.priceCents,
        currency: body.currency,
        status: OrderStatus.pending_payment,
        clientRemark: body.clientRemark,
      },
    });
    return serialize({
      ...order,
      stockAvailable: stock,
      next: 'POST /api/orders/:orderNo/pay',
    });
  }

  async myOrders(userId: string) {
    const rows = await this.prisma.order.findMany({
      where: { userId: BigInt(userId) },
      orderBy: { id: 'desc' },
      include: { plan: true, payments: true, service: true },
    });
    return serialize(rows);
  }

  async getMyOrder(userId: string, orderNo: string) {
    const order = await this.prisma.order.findFirst({
      where: { orderNo, userId: BigInt(userId) },
      include: { plan: true, payments: true, service: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    return serialize(order);
  }

  /** Public list of enabled pay channels for checkout UI (from DB). */
  async listPayMethods() {
    const channels = await this.payChannels.listPublic();
    return {
      methods: channels,
      rates: {
        cnyToKhr: this.findRate(channels, 'ABA_KHQR') || 560,
        usdToCny: this.findUsdToCny(channels) || 7.2,
      },
    };
  }

  /** Pick a channel-level rate for KHQR conversion, else env fallback. */
  private findRate(channels: any[], wayContains: string): number | undefined {
    const c = channels.find((x) =>
      String(x.wayCode || '').toUpperCase().includes(wayContains),
    );
    return c?.rate != null ? Number(c.rate) : undefined;
  }

  private findUsdToCny(channels: any[]): number | undefined {
    const c = channels.find((x) => x.usdToCnyRate != null);
    return c?.usdToCnyRate != null ? Number(c.usdToCnyRate) : undefined;
  }

  /** Resolve legacy method id → pay_channels.code (kept stable). */
  private async resolveChannelCode(method?: string): Promise<string | null> {
    const channels = await this.payChannels.listPublic();
    if (!channels.length) return null;
    const m = String(method || '').trim().toLowerCase();
    if (!m) return channels[0].code;
    // direct code match
    const direct = channels.find((c: any) => c.code.toLowerCase() === m);
    if (direct) return direct.code;
    // legacy id alias
    const legacy: Record<string, string> = {
      aba_khqr: 'aba_khqr',
      aba_pc: 'aba_pc',
      crypto: 'crypto',
    };
    const alias = legacy[m];
    if (alias && channels.find((c: any) => c.code === alias)) return alias;
    // fallback: match by keyword in wayCode/name
    const kw = channels.find(
      (c: any) =>
        String(c.wayCode || '').toLowerCase().includes(m) ||
        String(c.name || '').toLowerCase().includes(m),
    );
    return kw?.code || null;
  }

  /** Convert list price (CNY/USD cents) → CNY major for FX */
  private toCnyMajor(
    amountCents: number,
    currency: CurrencyCode,
    usdToCny?: number,
  ): number {
    if (currency === CurrencyCode.USD) {
      const rate =
        usdToCny ||
        Number(this.config.get<string>('JEEPAY_USD_TO_CNY_RATE') || 7.2);
      return (amountCents / 100) * rate;
    }
    return amountCents / 100;
  }

  private buildKhrMeta(
    order: {
      amountCents: number;
      currency: CurrencyCode;
      orderNo: string;
      plan: { name: string };
    },
    rate: number,
    usdToCny?: number,
  ) {
    const cnyMajor = this.toCnyMajor(order.amountCents, order.currency, usdToCny);
    const khrMajor = Math.max(1, Math.ceil(cnyMajor * rate));
    return {
      listCurrency: order.currency,
      listAmountCents: order.amountCents,
      listMajor: order.amountCents / 100,
      cnyMajor: Number(cnyMajor.toFixed(2)),
      khrMajor,
      rate,
      payCurrency: 'KHR',
      payAmountCents: khrMajor * 100,
      subject: `${order.plan.name} ${cnyMajor.toFixed(2)} CNY(≈${khrMajor} KHR)`,
      body: `order ${order.orderNo}; ${order.currency} ${(
        order.amountCents / 100
      ).toFixed(2)} => KHR ${khrMajor} @${rate}`,
    };
  }

  async payOrder(
    userId: string,
    orderNo: string,
    body: { method?: string } = {},
  ) {
    const order = await this.prisma.order.findFirst({
      where: { orderNo, userId: BigInt(userId) },
      include: { plan: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.pending_payment) {
      throw new BadRequestException({
        code: 'INVALID_ORDER_STATUS',
        message: `Order status is ${order.status}`,
        status: order.status,
      });
    }

    const isRenew = order.orderNo.startsWith('RN');
    if (!isRenew) {
      const stock = await this.inventory.countReadyForPlan(order.planId);
      if (stock < 1) {
        throw new BadRequestException({
          code: 'OUT_OF_STOCK',
          message: 'Out of stock, cannot pay',
        });
      }
    }

    const code = await this.resolveChannelCode(body.method);
    if (!code) {
      throw new BadRequestException({
        code: 'PAY_METHOD_DISABLED',
        message: 'No enabled payment channel',
      });
    }
    const active = await this.payChannels.getActiveByCode(code);
    if (!active) {
      throw new BadRequestException({
        code: 'PAY_METHOD_DISABLED',
        message: `Payment method not available: ${code}`,
      });
    }
    return this.payWithChannel(order, code, active.row, active.credentials);
  }

  /** Backward-compatible alias */
  async payWithJeepay(userId: string, orderNo: string) {
    return this.payOrder(userId, orderNo, { method: 'aba_khqr' });
  }

  private async ensurePaymentRow(
    order: { id: bigint; amountCents: number; currency: CurrencyCode },
    channel: string,
    wayCode: string,
  ) {
    let payment = await this.prisma.payment.findFirst({
      where: {
        orderId: order.id,
        channel,
        wayCode,
        status: PaymentStatus.pending,
      },
      orderBy: { id: 'desc' },
    });
    if (!payment) {
      payment = await this.prisma.payment.create({
        data: {
          orderId: order.id,
          paymentNo: genOrderNo('PAY'),
          channel,
          wayCode,
          amountCents: order.amountCents,
          currency: order.currency,
          status: PaymentStatus.pending,
        },
      });
    }
    return payment;
  }

  /**
   * Unified payment dispatch driven by pay_channels row.
   * - channel=jeepay → Jeepay unifiedOrder (ABA_KHQR / ABA_PC / TRX_USDT ...)
   * - channel=tokenpay → TokenPay CreateOrder (legacy path, kept for compat)
   * KHQR wayCode builds a local 说明页 with the real KHR amount.
   */
  private async payWithChannel(
    order: {
      id: bigint;
      orderNo: string;
      amountCents: number;
      currency: CurrencyCode;
      userId: bigint;
      plan: { name: string };
      planId: bigint;
    },
    code: string,
    row: any,
    credentials: Record<string, any>,
  ) {
    const channel = String(row.channel || '').toLowerCase();
    if (channel === 'tokenpay') {
      return this.payWithTokenPay(order, row, credentials);
    }
    return this.payWithJeepayChannel(order, code, row, credentials);
  }

  private async payWithJeepayChannel(
    order: {
      id: bigint;
      orderNo: string;
      amountCents: number;
      currency: CurrencyCode;
      userId: bigint;
      plan: { name: string };
      planId: bigint;
    },
    code: string,
    row: any,
    credentials: Record<string, any>,
  ) {
    const gateway = (String(row.gatewayUrl || credentials.gatewayUrl || '')).replace(
      /\/$/,
      '',
    );
    const mchNo = String(credentials.mchNo || '');
    const appId = String(credentials.appId || '');
    const appSecret = String(credentials.appSecret || '');
    if (!gateway || !mchNo || !appId || !appSecret) {
      throw new BadRequestException({
        code: 'JEEPAY_NOT_CONFIGURED',
        message: `Jeepay channel ${code} missing gateway/mchNo/appId/appSecret`,
      });
    }

    const wayCode = String(row.wayCode || 'ABA_KHQR');
    const usdToCny = row.usdToCnyRate != null ? Number(row.usdToCnyRate) : undefined;
    const settle = String(row.settleCurrency || '').toUpperCase();
    const rate = row.rate != null ? Number(row.rate) : undefined;

    const payment = await this.ensurePaymentRow(order, 'jeepay', wayCode);

    const notifyUrl =
      this.config.get<string>('JEEPAY_NOTIFY_URL') ||
      `${this.publicBase()}/api/payments/jeepay/notify`;
    const returnUrl =
      this.config.get<string>('JEEPAY_RETURN_URL') ||
      `${this.publicBase()}/pay/result.html?orderNo=${encodeURIComponent(
        order.orderNo,
      )}`;

    let payAmount = order.amountCents;
    let payCurrency: string = order.currency;
    let subject = `${order.plan.name} monthly`;
    let jeepayBody = `order ${order.orderNo}`;
    let displayMeta: Record<string, any> = {
      method: code,
      channelCode: code,
      listCurrency: order.currency,
      listAmountCents: order.amountCents,
      listMajor: order.amountCents / 100,
    };

    const w = wayCode.toUpperCase();
    if (w.includes('KHQR')) {
      const khrRate = rate ?? 560;
      const khr = this.buildKhrMeta(order, khrRate, usdToCny);
      payAmount = khr.payAmountCents;
      payCurrency = 'KHR';
      subject = khr.subject;
      jeepayBody = khr.body;
      displayMeta = { ...displayMeta, ...khr };
    } else if (w.includes('ABA_PC')) {
      const settleCur = settle || 'USD';
      const r = rate ?? (settleCur === 'KHR' ? 560 : 0.14);
      const cnyMajor = this.toCnyMajor(order.amountCents, order.currency, usdToCny);
      if (settleCur === 'KHR') {
        const major = Math.max(1, Math.ceil(cnyMajor * r));
        payAmount = major * 100;
        payCurrency = 'KHR';
        subject = `${order.plan.name} ${cnyMajor.toFixed(2)} CNY(≈${major} KHR)`;
        jeepayBody = `order ${order.orderNo}; CNY ${cnyMajor.toFixed(
          2,
        )} => KHR ${major} @${r}`;
        displayMeta = {
          ...displayMeta,
          cnyMajor: Number(cnyMajor.toFixed(2)),
          settleMajor: major,
          khrMajor: major,
          rate: r,
          payCurrency: 'KHR',
          payAmountCents: payAmount,
        };
      } else {
        const major = Math.max(0.01, Math.round(cnyMajor * r * 100) / 100);
        payAmount = Math.round(major * 100);
        payCurrency = settleCur;
        subject = `${order.plan.name} ${cnyMajor.toFixed(2)} CNY(≈${major.toFixed(
          2,
        )} ${settleCur})`;
        jeepayBody = `order ${order.orderNo}; CNY ${cnyMajor.toFixed(
          2,
        )} => ${settleCur} ${major.toFixed(2)} @${r}`;
        displayMeta = {
          ...displayMeta,
          cnyMajor: Number(cnyMajor.toFixed(2)),
          settleMajor: major,
          rate: r,
          payCurrency: settleCur,
          payAmountCents: payAmount,
        };
      }
    } else {
      // crypto / generic Jeepay wayCode (TRX_USDT ...): pass list currency as-is
      payAmount = order.amountCents;
      payCurrency = order.currency;
      subject = `${order.plan.name} ${order.currency} ${(order.amountCents / 100).toFixed(2)}`;
      jeepayBody = `order ${order.orderNo}; ${order.currency} ${(order.amountCents / 100).toFixed(2)}`;
      displayMeta = {
        ...displayMeta,
        payCurrency: order.currency,
        payAmountCents: order.amountCents,
      };
    }

    // Unique mchOrderNo per channel retry to avoid Jeepay "already exists".
    // Suffix letter identifies the channel family for resolveOrderNo().
    const suffixLetter = this.channelSuffixLetter(wayCode);
    const mchOrderNo = `${order.orderNo}${suffixLetter}${String(
      Date.now(),
    ).slice(-6)}`;

    const params: Record<string, string | number> = {
      mchNo,
      appId,
      mchOrderNo,
      wayCode,
      amount: payAmount,
      currency: payCurrency,
      subject,
      body: jeepayBody,
      notifyUrl,
      returnUrl,
      reqTime: String(Date.now()),
      version: '1.0',
      signType: 'MD5',
    };
    params.sign = jeepaySign(params, appSecret);

    this.logger.log(
      `Jeepay unifiedOrder order=${order.orderNo} channel=${code} way=${wayCode} amount=${payAmount} ${payCurrency}`,
    );

    let json: any;
    try {
      const raw = await axios.post(`${gateway}/api/pay/unifiedOrder`, params, {
        timeout: 45000,
        validateStatus: () => true,
        headers: { 'Content-Type': 'application/json' },
      });
      json = raw.data;
    } catch (e: any) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.failed,
          rawNotifyJson: { error: String(e?.message || e) },
        },
      });
      throw new BadRequestException({
        code: 'JEEPAY_NETWORK_ERROR',
        message: `Jeepay network error: ${e?.message || e}`,
      });
    }

    if (!json || json.code != 0) {
      this.logger.error(`Jeepay unifiedOrder fail order=${order.orderNo}`, json);
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.failed, rawNotifyJson: json ?? {} },
      });
      throw new BadRequestException({
        code: 'JEEPAY_ORDER_FAILED',
        message: `Jeepay order failed: ${json?.msg || 'unknown'}`,
        jeepay: json,
      });
    }

    const data = json.data || {};
    let payData = data.payData || data.payUrl || data.payDataUrl || '';
    let payDataType = data.payDataType || null;
    let payMode = 'redirect';

    // KHQR: do NOT open raw codeUrl — build local tip/说明页 with KHR amount
    if (w.includes('KHQR')) {
      const expectAmount =
        this.extractExpectAmount(data) || String(displayMeta.khrMajor || '');
      const qrContent =
        payDataType === 'payUrl' && String(payData).startsWith('http')
          ? ''
          : String(payData || '');
      if (qrContent) {
        const tip = new URL(`${this.publicBase()}/pay/aba-khqr.html`);
        tip.searchParams.set('cny', String(displayMeta.cnyMajor ?? ''));
        tip.searchParams.set(
          'list',
          `${displayMeta.listMajor ?? ''} ${order.currency}`,
        );
        tip.searchParams.set('khr', String(displayMeta.khrMajor || ''));
        tip.searchParams.set('rate', String(displayMeta.rate || ''));
        tip.searchParams.set('qr', qrContent);
        tip.searchParams.set('trade', order.orderNo);
        tip.searchParams.set(
          'return',
          `${this.publicBase()}/pay/result.html?orderNo=${encodeURIComponent(order.orderNo)}`,
        );
        if (expectAmount) tip.searchParams.set('expect', expectAmount);
        payData = tip.toString();
        payDataType = 'payUrl';
        payMode = 'tip_page';
        displayMeta.expectAmount = expectAmount;
        displayMeta.tipPage = true;
      }
    }

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.pending,
        wayCode,
        jeepayPayOrderId: data.payOrderId || null,
        rawNotifyJson: {
          unifiedOrder: json,
          displayMeta,
          mchOrderNo,
          channelCode: code,
        },
      },
    });
    await this.prisma.order.update({
      where: { id: order.id },
      data: { payChannel: `jeepay:${code}` },
    });

    return {
      orderNo: order.orderNo,
      paymentNo: payment.paymentNo,
      status: 'pending_payment',
      method: code,
      payData,
      payDataType,
      payMode,
      payOrderId: data.payOrderId || null,
      wayCode,
      notifyUrl,
      returnUrl,
      displayMeta,
      raw: data,
      hint:
        payMode === 'tip_page'
          ? 'Open tip page: shows KHR amount + QR instructions'
          : payData
            ? 'Open payData to complete payment'
            : 'No payData returned',
    };
  }

  /** Single stable suffix letter per channel family for mchOrderNo routing. */
  private channelSuffixLetter(wayCode: string): string {
    const w = String(wayCode || '').toUpperCase();
    if (w.includes('KHQR')) return 'Q';
    if (w.includes('ABA_PC')) return 'P';
    if (w.includes('USDT') || w.includes('TRX')) return 'U';
    return 'X';
  }

  private extractExpectAmount(data: any): string {
    try {
      let attach = data?.channelAttach;
      if (typeof attach === 'string') attach = JSON.parse(attach);
      if (attach && attach.expectAmount) return String(attach.expectAmount);
    } catch {
      /* ignore */
    }
    return '';
  }

  private tokenPaySign(params: Record<string, any>, apiToken: string): string {
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (k === 'Signature' || k === 'signature') continue;
      if (v === null || v === undefined || v === '') continue;
      filtered[k] = String(v);
    }
    const keys = Object.keys(filtered).sort();
    const qs = keys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(filtered[k])}`)
      .join('&');
    // Match TokenPay / v2board: urldecode(http_build_query) + token
    const str = decodeURIComponent(qs) + apiToken;
    return createHash('md5').update(str, 'utf8').digest('hex');
  }

  /** Strip channel/retry suffixes from Jeepay mchOrderNo → panel orderNo.
   *  Suffix letters: Q=KHQR, P=ABA_PC, U=USDT/TRX, X=other */
  private resolveOrderNo(mchOrderNo: string): string {
    const raw = String(mchOrderNo || '');
    const m = raw.match(/^(.*?)([QPUXR]\d{6,})$/);
    if (m) return m[1];
    return raw;
  }

  private async payWithTokenPay(
    order: {
      id: bigint;
      orderNo: string;
      amountCents: number;
      currency: CurrencyCode;
      userId: bigint;
      plan: { name: string };
    },
    row: any,
    credentials: Record<string, any>,
  ) {
    const apiBase = (String(row.gatewayUrl || '')).replace(/\/$/, '');
    const apiToken = String(credentials.apiToken || '');
    const currency = String(row.wayCode || 'USDT_TRC20');
    if (!apiBase || !apiToken) {
      throw new BadRequestException({
        code: 'TOKENPAY_NOT_CONFIGURED',
        message: `TokenPay channel ${row.code} missing gatewayUrl/apiToken`,
      });
    }

    const code = String(row.code || 'crypto');
    const payment = await this.ensurePaymentRow(order, 'tokenpay', currency);
    const notifyUrl =
      this.config.get<string>('TOKENPAY_NOTIFY_URL') ||
      `${this.publicBase()}/api/payments/tokenpay/notify`;
    const returnUrl =
      this.config.get<string>('JEEPAY_RETURN_URL') ||
      `${this.publicBase()}/pay/result.html?orderNo=${encodeURIComponent(
        order.orderNo,
      )}`;

    // TokenPay ActualAmount is fiat major (usually CNY)
    const cnyMajor = Number(
      this.toCnyMajor(
        order.amountCents,
        order.currency,
        row.usdToCnyRate != null ? Number(row.usdToCnyRate) : undefined,
      ).toFixed(2),
    );
    const actualAmount = Math.max(0.01, cnyMajor);

    const params: Record<string, any> = {
      OutOrderId: order.orderNo,
      OrderUserKey: String(order.userId),
      ActualAmount: actualAmount,
      Currency: currency,
      NotifyUrl: notifyUrl,
      RedirectUrl: returnUrl,
    };
    params.Signature = this.tokenPaySign(params, apiToken);

    this.logger.log(
      `TokenPay CreateOrder order=${order.orderNo} amount=${actualAmount} ${currency}`,
    );

    let json: any;
    try {
      const raw = await axios.post(`${apiBase}/CreateOrder`, params, {
        timeout: 45000,
        validateStatus: () => true,
        headers: { 'Content-Type': 'application/json' },
      });
      json = raw.data;
    } catch (e: any) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.failed,
          rawNotifyJson: { error: String(e?.message || e) },
        },
      });
      throw new BadRequestException({
        code: 'TOKENPAY_NETWORK_ERROR',
        message: `TokenPay network error: ${e?.message || e}`,
      });
    }

    if (!json || !json.success) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.failed, rawNotifyJson: json ?? {} },
      });
      throw new BadRequestException({
        code: 'TOKENPAY_ORDER_FAILED',
        message: `TokenPay failed: ${json?.message || 'unknown'}`,
        tokenpay: json,
      });
    }

    const payData = typeof json.data === 'string' ? json.data : json.data?.url || '';
    const displayMeta = {
      method: code,
      channelCode: code,
      listCurrency: order.currency,
      listAmountCents: order.amountCents,
      listMajor: order.amountCents / 100,
      cnyMajor: actualAmount,
      payCurrency: currency,
      tokenPayUrl: payData,
    };

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.pending,
        wayCode: currency,
        rawNotifyJson: { createOrder: json, displayMeta },
      },
    });
    await this.prisma.order.update({
      where: { id: order.id },
      data: { payChannel: `tokenpay:${code}` },
    });

    return {
      orderNo: order.orderNo,
      paymentNo: payment.paymentNo,
      status: 'pending_payment',
      method: code,
      payData,
      payDataType: 'payUrl',
      payMode: 'redirect',
      wayCode: currency,
      displayMeta,
      raw: json,
      hint: 'Open TokenPay checkout to complete crypto payment',
    };
  }

  async handleTokenPayNotify(body: Record<string, any>) {
    const apiToken = this.config.get<string>('TOKENPAY_API_TOKEN') || '';
    const sign = body.Signature || body.signature || '';
    const check = { ...body };
    delete check.Signature;
    delete check.signature;
    const expect = this.tokenPaySign(check, apiToken);
    if (String(sign).toLowerCase() !== expect.toLowerCase()) {
      this.logger.warn(`bad tokenpay sign expect=${expect} got=${sign}`);
      return 'bad sign';
    }
    const status = String(body.Status ?? body.status ?? '');
    if (status !== '1') return 'ignored';

    const orderNo = String(body.OutOrderId || body.outOrderId || '');
    const order = await this.prisma.order.findUnique({
      where: { orderNo },
      include: { plan: true },
    });
    if (!order) {
      this.logger.warn(`tokenpay order not found: ${orderNo}`);
      return 'order not found';
    }
    if (order.status === OrderStatus.completed) return 'ok';

    const payment = await this.prisma.payment.findFirst({
      where: { orderId: order.id, channel: 'tokenpay' },
      orderBy: { id: 'desc' },
    });
    if (payment) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          rawNotifyJson: body,
          status: PaymentStatus.success,
          paidAt: new Date(),
          jeepayPayOrderId: String(body.Id || body.id || '') || payment.jeepayPayOrderId,
        },
      });
    }

    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.paid,
        paidAt: new Date(),
        payChannel: 'tokenpay',
      },
    });

    try {
      if (order.orderNo.startsWith('RN')) {
        await this.applyRenewal(order.id);
      } else {
        await this.allocateAndDeliver(order.id);
      }
    } catch (e: any) {
      this.logger.error(`allocate failed order=${orderNo}`, e?.message || e);
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.failed,
          adminRemark: `allocate failed: ${e?.message || e}`,
        },
      });
    }
    return 'ok';
  }

  /**
   * Jeepay async notify. state=2 means success.
   * Accepts JSON or form body.
   */
  async handleJeepayNotify(body: Record<string, any>) {
    const appSecret = this.config.get<string>('JEEPAY_APP_SECRET') || '';
    const sign = body.sign || '';
    const check = { ...body };
    delete check.sign;
    const expect = jeepaySign(check, appSecret);
    if (String(sign).toUpperCase() !== expect) {
      this.logger.warn(`bad jeepay sign expect=${expect} got=${sign}`);
      return 'bad sign';
    }

    const mchOrderNo = String(body.mchOrderNo || '');
    const orderNo = this.resolveOrderNo(mchOrderNo);
    const state = String(body.state || '');
    const order = await this.prisma.order.findUnique({
      where: { orderNo },
      include: { plan: true },
    });
    if (!order) {
      this.logger.warn(
        `notify order not found: mch=${mchOrderNo} resolved=${orderNo}`,
      );
      return 'order not found';
    }

    // idempotent success
    if (order.status === OrderStatus.completed) return 'success';

    const payment = await this.prisma.payment.findFirst({
      where: { orderId: order.id, channel: 'jeepay' },
      orderBy: { id: 'desc' },
    });
    if (payment) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          rawNotifyJson: body,
          jeepayPayOrderId: body.payOrderId || payment.jeepayPayOrderId,
          status: state === '2' ? PaymentStatus.success : PaymentStatus.failed,
          paidAt: state === '2' ? new Date() : null,
        },
      });
    }

    if (state !== '2') {
      this.logger.log(`notify ignored state=${state} order=${orderNo}`);
      return 'ignored';
    }

    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.paid,
        paidAt: new Date(),
        payChannel: 'jeepay',
      },
    });

    try {
      if (order.orderNo.startsWith('RN')) {
        await this.applyRenewal(order.id);
      } else {
        await this.allocateAndDeliver(order.id);
      }
    } catch (e: any) {
      this.logger.error(`allocate failed order=${orderNo}`, e?.message || e);
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.failed,
          adminRemark: `allocate failed: ${e?.message || e}`,
        },
      });
      // ack success to stop jeepay retries; admin can retry-allocate
    }
    return 'success';
  }

  /** Admin: mark paid + allocate (manual complement when callback blocked) */
  async adminMarkPaid(orderId: string, remark?: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: BigInt(orderId) },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === OrderStatus.completed) {
      return serialize(order);
    }
    if (
      order.status !== OrderStatus.pending_payment &&
      order.status !== OrderStatus.paid &&
      order.status !== OrderStatus.failed &&
      order.status !== OrderStatus.provisioning
    ) {
      throw new BadRequestException(`Cannot mark paid from ${order.status}`);
    }

    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.paid,
        paidAt: new Date(),
        payChannel: order.payChannel || 'manual',
        adminRemark: remark || order.adminRemark || 'admin mark paid',
      },
    });

    const payment = await this.prisma.payment.findFirst({
      where: { orderId: order.id },
      orderBy: { id: 'desc' },
    });
    if (payment && payment.status !== PaymentStatus.success) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.success,
          paidAt: new Date(),
          channel: payment.channel || 'manual',
        },
      });
    } else if (!payment) {
      await this.prisma.payment.create({
        data: {
          orderId: order.id,
          paymentNo: genOrderNo('MAN'),
          channel: 'manual',
          amountCents: order.amountCents,
          currency: order.currency,
          status: PaymentStatus.success,
          paidAt: new Date(),
        },
      });
    }

    if (order.orderNo.startsWith('RN')) {
      await this.applyRenewal(order.id);
    } else {
      await this.allocateAndDeliver(order.id);
    }

    const fresh = await this.prisma.order.findUnique({
      where: { id: order.id },
      include: { payments: true, service: true },
    });
    if (!fresh) throw new NotFoundException('Order missing after mark-paid');
    return serialize(fresh);
  }

  private async applyRenewal(orderId: bigint) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order?.inventoryServerId) {
      throw new BadRequestException('Renew order missing inventory');
    }
    const svc = await this.prisma.service.findFirst({
      where: {
        userId: order.userId,
        inventoryServerId: order.inventoryServerId,
      },
    });
    if (!svc) throw new BadRequestException('Service for renew not found');
    const base =
      svc.expireAt.getTime() > Date.now() ? svc.expireAt : new Date();
    const expireAt = addMonths(base, 1);
    await this.prisma.$transaction(async (tx) => {
      await tx.service.update({
        where: { id: svc.id },
        data: { expireAt, status: ServiceStatus.active },
      });
      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.completed },
      });
      await tx.inventoryServer.update({
        where: { id: order.inventoryServerId! },
        data: { status: InventoryStatus.sold },
      });
      await tx.operationLog.create({
        data: {
          actorType: 'system',
          action: 'renew_service',
          targetType: 'service',
          targetId: svc.id,
          metaJson: { orderNo: order.orderNo, expireAt: expireAt.toISOString() },
        },
      });
    });
  }

  async allocateAndDeliver(orderId: bigint) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { plan: true },
    });
    if (!order) throw new NotFoundException('Order missing');
    if (order.status === OrderStatus.completed && order.inventoryServerId) {
      return serialize(order);
    }

    await this.prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.provisioning },
    });

    const candidates = await this.inventory.findReadyCandidates(order.planId, 30);
    if (!candidates.length) {
      throw new BadRequestException({
        code: 'NO_READY_INVENTORY',
        message: 'No ready inventory at allocate time',
      });
    }

    let locked: (typeof candidates)[0] | null = null;
    for (const c of candidates) {
      const res = await this.prisma.inventoryServer.updateMany({
        where: { id: c.id, status: InventoryStatus.ready },
        data: {
          status: InventoryStatus.reserved,
          reservedOrderId: order.id,
        },
      });
      if (res.count === 1) {
        locked = c;
        break;
      }
    }
    if (!locked) {
      throw new BadRequestException({
        code: 'LOCK_INVENTORY_FAILED',
        message: 'Failed to lock inventory (race)',
      });
    }

    const secret = this.config.get<string>('CREDENTIALS_SECRET') || 'dev-secret';
    let auth: ServerAuthPayload = { username: 'root' };
    try {
      auth = decryptJson<ServerAuthPayload>(
        secret,
        locked.authPayloadEncrypted,
      );
    } catch {
      this.logger.warn(`decrypt auth failed for inventory ${locked.id}`);
    }

    const now = new Date();
    const expireAt = addMonths(now, 1);
    const deliver = {
      ip: locked.ip,
      ssh_port: locked.sshPort,
      username: auth.username || 'root',
      password: auth.password || null,
      os: 'Linux',
      optimized: locked.optimizeTagsJson || [],
      notes: 'Please change password after login. No abuse.',
      provider: locked.provider,
      region: locked.region,
    };

    const service = await this.prisma.$transaction(async (tx) => {
      const svc = await tx.service.create({
        data: {
          serviceNo: genOrderNo('SVC'),
          userId: order.userId,
          orderId: order.id,
          planId: order.planId,
          inventoryServerId: locked!.id,
          status: ServiceStatus.active,
          startAt: now,
          expireAt,
          deliverPayloadJson: deliver,
        },
      });
      await tx.inventoryServer.update({
        where: { id: locked!.id },
        data: {
          status: InventoryStatus.sold,
          soldServiceId: svc.id,
          reservedOrderId: order.id,
        },
      });
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.completed,
          inventoryServerId: locked!.id,
        },
      });
      await tx.operationLog.create({
        data: {
          actorType: 'system',
          action: 'allocate_inventory',
          targetType: 'order',
          targetId: order.id,
          metaJson: {
            inventoryId: locked!.id.toString(),
            serviceNo: svc.serviceNo,
          },
        },
      });
      return svc;
    });

    return serialize(service);
  }

  async adminList() {
    return this.prisma.order
      .findMany({
        orderBy: { id: 'desc' },
        include: { user: true, plan: true, payments: true, service: true },
        take: 100,
      })
      .then(serialize);
  }

  async adminRetryAllocate(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: BigInt(orderId) },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (
      order.status !== OrderStatus.paid &&
      order.status !== OrderStatus.failed &&
      order.status !== OrderStatus.provisioning
    ) {
      throw new BadRequestException('Order not allocatable');
    }
    if (order.orderNo.startsWith('RN')) {
      await this.applyRenewal(order.id);
      return { ok: true, type: 'renew' };
    }
    return this.allocateAndDeliver(order.id);
  }

  async paymentStatus(userId: string, orderNo: string) {
    const order = await this.prisma.order.findFirst({
      where: { orderNo, userId: BigInt(userId) },
      include: {
        payments: { orderBy: { id: 'desc' }, take: 3 },
        service: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return serialize({
      orderNo: order.orderNo,
      status: order.status,
      paidAt: order.paidAt,
      service: order.service,
      latestPayment: order.payments[0] || null,
    });
  }
}
