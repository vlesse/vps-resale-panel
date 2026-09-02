import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrderStatus, RechargeStatus, UsdtIntentStatus, WalletTxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { WalletService } from '../wallet/wallet.service';
import { decryptJson, encryptJson, generateCode, tryDecryptJson } from '../crypto/crypto.util';
import { JeepayCredentials, JeepayDriver } from './drivers/jeepay.driver';
import { EpayCredentials, EpayDriver } from './drivers/epay.driver';
import { UsdtCredentials, UsdtDriver } from './drivers/usdt.driver';
import { FxQuote, FxService, minorUnits } from './fx.service';
import { AuthedUser } from '../auth/auth.decorators';

/**
 * 支付。
 *
 * 通道配置放数据库不放 .env，因为运营过程中换支付商是常事，
 * 改 .env 要重启服务，改数据库不用。商户密钥同样加密存储。
 *
 * 内置五种驱动：
 *   jeepay      自建的聚合支付网关
 *   epay        易支付规范（国内大量服务商共用这套接口）
 *   usdt_trc20  链上收 USDT，靠金额唯一配对，不需要任何商户账号
 *   balance     用账户余额付，不出网
 *   manual      线下转账，管理员在后台手工确认
 *
 * 两类单据共用这一层：**套餐订单**（ORD 开头）和**充值单**（RCH 开头）。
 * 单号前缀决定钱到账后往哪走 —— 订单去建机，充值去加余额。
 */

/** 付款目标：套餐订单和充值单在支付这一层长得一样，这里抹平差异 */
interface PayTarget {
  kind: 'order' | 'recharge';
  no: string;
  userId: bigint;
  amountCents: number;
  currency: string;
  subject: string;
  body: string;
  expiresAt: Date | null;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  /**
   * 网关已经判了终局（关闭 / 撤销 / 失败 / 已退款）的单号。
   *
   * 只放内存里，不落库：进程重启后重新问一次没什么代价，而为它加一列
   * 反而要多一个「什么时候该清掉」的问题。真正要挡的是「对着死单
   * 每分钟撞一次撞一整天」。
   */
  private readonly closedAtGateway = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly wallet: WalletService,
    private readonly jeepay: JeepayDriver,
    private readonly epay: EpayDriver,
    private readonly usdt: UsdtDriver,
    private readonly fx: FxService,
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

  private siteName(): string {
    return this.config.get<string>('SITE_NAME') ?? 'VPS 面板';
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
      // 顾客扫码时实际要输入的币种。前端拿它去换「本次要付多少瑞尔」的提示。
      payCurrency: c.payCurrency,
      desc: c.descText,
      // 充值单不能用余额付（拿余额充余额没有意义），前端据此隐藏
      usableForRecharge: c.driver !== 'balance',
    }));
  }

  // ---------- 发起支付 ----------

  async pay(user: AuthedUser, orderNo: string, channelCode: string, clientIp?: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderNo },
      include: { plan: { select: { name: true, regionLabel: true } } },
    });
    if (!order || order.userId !== user.id) throw new NotFoundException('订单不存在');

    if (order.status !== OrderStatus.pending_payment) {
      throw new BadRequestException(
        order.status === OrderStatus.completed
          ? '这笔订单已经完成了，不用再付'
          : `订单当前状态是「${order.status}」，不能发起支付`,
      );
    }
    return this.start(
      {
        kind: 'order',
        no: order.orderNo,
        userId: order.userId,
        amountCents: order.amountCents,
        currency: order.currency,
        subject: order.plan.name,
        body: `${order.plan.regionLabel} · ${order.orderNo}`,
        expiresAt: order.expiresAt,
      },
      channelCode,
      clientIp,
    );
  }

  async payRecharge(user: AuthedUser, rechargeNo: string, channelCode: string, clientIp?: string) {
    const row = await this.prisma.rechargeOrder.findUnique({ where: { rechargeNo } });
    if (!row || row.userId !== user.id) throw new NotFoundException('充值单不存在');
    if (row.status !== RechargeStatus.pending_payment) {
      throw new BadRequestException(
        row.status === RechargeStatus.paid ? '这笔充值已经到账了' : `充值单状态是「${row.status}」`,
      );
    }
    return this.start(
      {
        kind: 'recharge',
        no: row.rechargeNo,
        userId: row.userId,
        amountCents: row.amountCents,
        currency: row.currency,
        subject: `账户充值 ${(row.amountCents / 100).toFixed(2)}`,
        body: `充值 · ${row.rechargeNo}`,
        expiresAt: row.expiresAt,
      },
      channelCode,
      clientIp,
    );
  }

  /** 两类单据共用的发起逻辑 */
  private async start(target: PayTarget, channelCode: string, clientIp?: string) {
    if (target.expiresAt && target.expiresAt < new Date()) {
      throw new BadRequestException('这笔单子已经超时了，请重新发起');
    }

    const channel = await this.prisma.payChannel.findUnique({ where: { code: channelCode } });
    if (!channel || !channel.isEnabled) throw new BadRequestException('这个支付方式当前不可用');

    const remember = () =>
      target.kind === 'order'
        ? this.prisma.order.update({
            where: { orderNo: target.no },
            data: { payChannel: channel.code },
          })
        : this.prisma.rechargeOrder.update({
            where: { rechargeNo: target.no },
            data: { payChannel: channel.code },
          });

    switch (channel.driver) {
      case 'manual':
        await remember();
        return {
          kind: 'manual' as const,
          message: '请按页面提示完成转账，转账后联系客服确认，管理员确认后会自动开通',
          instructions: channel.descText,
          payQuote: await this.payQuote(channel, target),
        };

      case 'balance':
        return this.payFromBalance(target, channel.code);

      case 'jeepay': {
        await remember();
        const cred = decryptJson<JeepayCredentials>(this.secret(), channel.credentialsEncrypted);

        // 再发一张码之前，先问一句上一张付掉没有。
        //
        // 用户点第二次的原因往往是「付了但页面没反应」。这时候直接给他第二张码，
        // 就等于同时有两张有效的码挂在那，他很可能两张都扫 —— 真付两笔。
        // 先问一句，付掉了就当场入账，别再出码。
        const prior = await this.settledAlready(target);
        if (prior) return prior;

        // 折算只算一次，显示和上报共用同一个结果。
        //
        // 分两次算迟早会算出两个数：显示用今天的汇率、上报用管理员上个月填的，
        // 或者两边的取整方向不一样。网关等着一个数、顾客付的是另一个数，
        // 谁也对不上谁 —— 这种错查起来极其痛苦，因为两边看各自都是对的。
        const quote = await this.payQuote(channel, target);
        const gw = this.gatewayAmount(channel, target, quote);

        const gwNo = this.gatewayNo(target.no);
        const result = await this.callGateway(channel.name, () =>
          this.jeepay.createPayment(
            { ...cred, gatewayUrl: channel.gatewayUrl || cred.gatewayUrl },
            {
              orderNo: gwNo,
              amountCents: gw.amount,
              currency: gw.currency,
              wayCode: channel.wayCode || '',
              subject: target.subject,
              body: target.body,
              notifyUrl: `${this.baseUrl()}/api/payments/jeepay/notify`,
              returnUrl: this.returnUrl(target),
              clientIp,
              // 已经折算过就别让驱动再乘一次
              rate: gw.converted ? undefined : channel.rate ?? undefined,
            },
          ),
        );
        await this.rememberGatewayRefs(target, gwNo, result.payOrderId);
        return {
          kind: 'gateway' as const,
          codeUrl: result.codeUrl,
          payUrl: result.payUrl,
          upstreamNo: result.payOrderId,
          payQuote: quote,
        };
      }

      case 'epay': {
        await remember();
        const cred = decryptJson<EpayCredentials>(this.secret(), channel.credentialsEncrypted);
        const full = { ...cred, gatewayUrl: channel.gatewayUrl || cred.gatewayUrl };
        const gwNo = this.gatewayNo(target.no);
        const req = {
          orderNo: gwNo,
          amountCents: this.convertAmount(target.amountCents, target.currency, channel),
          payType: channel.wayCode || 'alipay',
          subject: target.subject,
          notifyUrl: `${this.baseUrl()}/api/payments/epay/notify`,
          returnUrl: this.returnUrl(target),
          clientIp,
          siteName: this.siteName(),
        };
        try {
          const r = await this.epay.createPayment(full, req);
          await this.rememberGatewayRefs(target, gwNo, r.tradeNo);
          return {
            kind: 'gateway' as const,
            codeUrl: r.qrCode,
            payUrl: r.payUrl,
            upstreamNo: r.tradeNo,
            payQuote: await this.payQuote(channel, target),
          };
        } catch (err: any) {
          // 不少服务商没开 mapi.php，只提供 submit.php 的页面跳转。
          // 这不是配置错误，退回跳转方式就能正常收款，没必要让用户看见报错。
          this.logger.warn(`易支付 mapi 调用失败，改用页面跳转：${err.message}`);
          return { kind: 'gateway' as const, payUrl: this.epay.buildSubmitUrl(full, req) };
        }
      }

      case 'usdt_trc20':
        await remember();
        return this.startUsdt(target, channel);

      default:
        throw new BadRequestException(`不认识的支付驱动 ${channel.driver}`);
    }
  }

  /**
   * 提交给网关的商户单号。
   *
   * 我们自己的单号（RCH… / ORD…）是复用的：用户点五次充值只会有一张单，
   * 免得他付了其中一张、剩下四张挂在那让人以为没付成功。但网关那边
   * **同一个商户单号只收一次** —— 第二次提交直接回「商户订单已存在」，
   * 用户看到的就是点了没反应。
   *
   * 所以给网关的号后面挂一个时间戳后缀，每次提交都是新的；
   * 回调回来时把后缀削掉就还原成我们自己的单号。单号本身只有数字和
   * 十六进制字符，不含 `-`，所以按第一个 `-` 切是安全的。
   */
  private gatewayNo(no: string): string {
    return `${no}-${Date.now().toString(36).slice(-6)}`;
  }

  /**
   * 调网关，失败时把真正的原因透给用户。
   *
   * 驱动里抛的是普通 Error，NestJS 会把它一律变成 500「Internal server error」——
   * 网关宕了、域名解析到了一个死 IP、证书过期，用户看到的全都是同一句毫无信息量的话，
   * 只会以为是面板坏了然后一直点。驱动里那些报错本来就是写给人看的，别在最后一步丢掉。
   *
   * 用 503 而不是 400：这不是用户填错了什么，是我们依赖的外部服务不可用。
   */
  private async callGateway<T>(channelName: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      this.logger.error(`调用支付通道「${channelName}」失败：${msg}`);
      throw new ServiceUnavailableException(
        `${msg}。这笔钱还没扣，可以过一会儿再试，或者换一个支付方式。`,
      );
    }
  }

  /**
   * 这笔单之前提交过的那次，是不是其实已经付掉了。
   *
   * 付掉了就当场入账并返回一个「已到账」，不要再发第二张码。
   * 查不了或者没付掉就返回 null，照常往下走出码。
   *
   * 查单本身出错绝不能挡住付款：网关的查单接口挂了是它的事，
   * 用户该付的款还是得能付。
   */
  private async settledAlready(target: PayTarget) {
    const row =
      target.kind === 'recharge'
        ? await this.prisma.rechargeOrder.findUnique({ where: { rechargeNo: target.no } })
        : await this.prisma.order.findUnique({ where: { orderNo: target.no } });
    if (!row?.gatewayOrderNo && !row?.upstreamNo) return null;
    try {
      const r = await this.askGateway(row!.payChannel, {
        payOrderId: row!.upstreamNo,
        mchOrderNo: row!.gatewayOrderNo,
      });
      if (!r?.paid) return null;
      this.logger.warn(`${target.no} 用户再次点付款时发现上一笔其实已支付，补入账`);
      await this.settle(target.kind, target.no, {
        channel: row!.payChannel!,
        upstreamNo: r.payOrderId,
        amountCents: r.amountCents,
        raw: r.raw,
      });
      return {
        kind: 'paid' as const,
        message: '这笔款其实已经收到了，刚刚给你补上了，不用再付一次。',
      };
    } catch (err: any) {
      this.logger.warn(`出码前查单失败，照常出码：${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * 把「我们提交给网关的单号」和「网关给的支付单号」落库。
   *
   * 不落库的后果很实在：回调一旦丢了，我们手里就只剩自己的 RCH 号，
   * 而提交给网关的是带随机后缀的号 —— 想回头问一句「这笔到底收到没有」
   * 都问不出口，只能翻服务商后台人工对账。
   *
   * 失败不能影响付款：单号没记上顶多是回头查不了，
   * 而这里一抛异常用户当场就付不了款了。
   */
  private async rememberGatewayRefs(target: PayTarget, gatewayOrderNo: string, upstreamNo?: string) {
    const data = { gatewayOrderNo, ...(upstreamNo ? { upstreamNo } : {}) };
    try {
      if (target.kind === 'order') {
        await this.prisma.order.update({ where: { orderNo: target.no }, data });
      } else {
        await this.prisma.rechargeOrder.update({ where: { rechargeNo: target.no }, data });
      }
    } catch (err: any) {
      this.logger.warn(`记录网关单号失败（不影响本次付款）：${err?.message ?? err}`);
    }
  }

  /** 回调里带回来的号削掉后缀，还原成我们自己的单号 */
  private ownNo(gatewayNo: string): string {
    return String(gatewayNo).split('-')[0];
  }

  private returnUrl(target: PayTarget): string {
    return target.kind === 'order'
      ? `${this.baseUrl()}/pay/result?orderNo=${target.no}`
      : `${this.baseUrl()}/wallet?recharge=${target.no}`;
  }

  // ---------- 余额支付 ----------

  /**
   * 用余额付一笔套餐订单。
   *
   * 扣款和「标记已付款」不在同一个事务里 —— markPaid 里面要入队建机，
   * 把队列操作塞进数据库事务是自找麻烦。所以顺序是：先扣钱，再标记；
   * 标记失败就把钱退回去，用户看到的是「没扣成」而不是「钱没了机器也没有」。
   */
  private async payFromBalance(target: PayTarget, channelCode: string) {
    if (target.kind !== 'order') {
      throw new BadRequestException('充值不能用余额付');
    }
    const walletCurrency = this.wallet.currency();
    if (target.currency !== walletCurrency) {
      const name = walletCurrency === 'CNY' ? '人民币' : '美元';
      throw new BadRequestException(
        `账户余额是${name}账户，这笔订单按 ${target.currency} 计价，用余额付会牵扯汇率换算。` +
          `请把价格切回${name}重新下单，或者换个支付方式。`,
      );
    }

    await this.wallet.debit(target.userId, target.amountCents, {
      type: WalletTxType.consume,
      refType: 'order',
      refNo: target.no,
      remark: `购买 ${target.subject}`,
    });

    try {
      const r = await this.orders.markPaid(target.no, {
        channel: channelCode,
        amountCents: target.amountCents,
        upstreamNo: `BALANCE-${target.no}`,
      });
      return { kind: 'paid' as const, message: r.message };
    } catch (err: any) {
      // 退钱之前必须确认订单**真的没被标记成已付款**。
      // markPaid 里「改状态」和「入队建机」不是一个事务：状态改完、入队失败
      // 也会抛到这里。这时候订单已经是 paid 了，再把钱退回去就是
      // 「钱也退了、机器也能开」—— 管理员一点「重试开通」就白送一台。
      const now = await this.prisma.order.findUnique({
        where: { orderNo: target.no },
        select: { status: true },
      });
      if (now && now.status !== OrderStatus.pending_payment) {
        this.logger.error(
          `订单 ${target.no} 已经是 ${now.status} 了，但后续步骤出错：${err.message}。` +
            `钱不退（退了就是白送一台），请人工确认这一单开通到哪一步了。`,
        );
        await this.prisma.order.update({
          where: { orderNo: target.no },
          data: { adminRemark: `余额扣款成功但开通流程出错，需人工确认：${err.message}`.slice(0, 255) },
        });
        throw new BadRequestException(
          '款项已扣，但开通流程出了问题。请联系客服，不要重复下单 —— 我们会人工处理。',
        );
      }

      this.logger.error(`余额扣款后标记订单 ${target.no} 失败，正在退回：${err.message}`);
      await this.wallet
        .credit(target.userId, target.amountCents, {
          type: WalletTxType.refund,
          refType: 'order',
          refNo: target.no,
          remark: '扣款后下单失败，自动退回',
        })
        .catch((e) =>
          // 退不回去是最坏的情况，必须吼出来让人工介入
          this.logger.error(
            `严重：订单 ${target.no} 扣了款但退不回去！用户 ${target.userId}，` +
              `金额 ${target.amountCents} 分。错误：${e.message}`,
          ),
        );
      throw new BadRequestException(`下单失败，已把款项退回余额：${err.message}`);
    }
  }

  // ---------- USDT ----------

  /**
   * 发起一笔 USDT 收款。
   *
   * 同一张单重复发起会拿到**同一个金额** —— 用户刷新页面、切回来再看，
   * 看到的必须是同一个数，不然他会以为要付两笔。
   */
  private async startUsdt(
    target: PayTarget,
    channel: { code: string; credentialsEncrypted: string; usdToCnyRate: number | null },
  ) {
    const cred = decryptJson<UsdtCredentials>(this.secret(), channel.credentialsEncrypted);
    if (!this.usdt.isValidAddress(cred.address)) {
      throw new BadRequestException('这个 USDT 通道的收款地址没配对，先去后台修好');
    }

    const now = new Date();
    const exist = await this.prisma.usdtIntent.findFirst({
      where: {
        refType: target.kind,
        refNo: target.no,
        status: UsdtIntentStatus.pending,
        expiresAt: { gt: now },
      },
      orderBy: { id: 'desc' },
    });
    if (exist) return this.usdtPayload(exist, cred.address);

    const baseUnits = this.usdt.toUsdtUnits(
      target.amountCents,
      target.currency,
      channel.usdToCnyRate,
    );

    // 占用中的金额必须查全 —— 漏掉一个，两张单就可能分到同一个金额，
    // 那一笔转账会对上其中一张，另一张的用户等于白付。
    const pending = await this.prisma.usdtIntent.findMany({
      where: { address: cred.address, status: UsdtIntentStatus.pending, expiresAt: { gt: now } },
      select: { amountUnits: true },
    });
    const taken = new Set(pending.map((p) => p.amountUnits.toString()));
    let amountUnits = this.usdt.pickUniqueAmount(baseUnits, taken);

    const minutes = Number(this.config.get('USDT_EXPIRE_MINUTES') ?? 30);

    // 上面那次「查已占用的再挑一个」挡不住并发：两个请求同时读到同一份列表
    // 就可能挑到同一个金额。activeKey 上有唯一索引，真撞了这里会抛 P2002，
    // 换个金额重来即可。撞三次还不行说明这个地址上待付款已经密到不正常了。
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const intent = await this.prisma.usdtIntent.create({
          data: {
            intentNo: generateCode('UDT'),
            refType: target.kind,
            refNo: target.no,
            channelCode: channel.code,
            address: cred.address,
            amountUnits,
            activeKey: `${cred.address}:${amountUnits}`,
            sourceAmountCents: target.amountCents,
            sourceCurrency: target.currency as any,
            expiresAt: new Date(Date.now() + minutes * 60_000),
          },
        });
        return this.usdtPayload(intent, cred.address);
      } catch (err: any) {
        if (err?.code !== 'P2002') throw err;
        this.logger.warn(`USDT 金额 ${this.usdt.format(amountUnits)} 被别的单抢先占了，换一个`);
        taken.add(amountUnits.toString());
        amountUnits = this.usdt.pickUniqueAmount(baseUnits, taken);
      }
    }
    throw new BadRequestException(
      '同一时刻等待中的 USDT 付款太多，暂时分不出金额。等几分钟再试，或者换个支付方式。',
    );
  }

  private usdtPayload(
    intent: { intentNo: string; amountUnits: bigint; expiresAt: Date },
    address: string,
  ) {
    const amount = this.usdt.format(intent.amountUnits);
    return {
      kind: 'usdt' as const,
      network: 'TRC20',
      address,
      amount,
      /** 二维码内容。多数钱包认这个格式，认不了的用户手抄地址和金额也行。 */
      qrPayload: `tron:${address}?amount=${amount}`,
      intentNo: intent.intentNo,
      expiresAt: intent.expiresAt,
      notice:
        '必须转这个精确金额，多一分少一分都对不上账 —— 系统靠金额认单。' +
        '请务必走 TRC20（波场）网络，走错链的币找不回来。',
    };
  }

  /** 前端轮询这个看付款到了没 */
  async usdtStatus(user: AuthedUser, intentNo: string) {
    const i = await this.prisma.usdtIntent.findUnique({ where: { intentNo } });
    if (!i) throw new NotFoundException('这笔收款不存在');

    // 只能查自己的单
    const owner =
      i.refType === 'recharge'
        ? (await this.prisma.rechargeOrder.findUnique({ where: { rechargeNo: i.refNo } }))?.userId
        : (await this.prisma.order.findUnique({ where: { orderNo: i.refNo } }))?.userId;
    if (owner !== user.id) throw new NotFoundException('这笔收款不存在');

    return {
      intentNo: i.intentNo,
      status: i.status,
      amount: this.usdt.format(i.amountUnits),
      address: i.address,
      txId: i.txId,
      paidAt: i.paidAt,
      expiresAt: i.expiresAt,
    };
  }

  // ---------- 主动查单 ----------

  /**
   * 反过来问网关：这些还没到账的单子，你那边到底收到钱没有。
   *
   * 回调是「网关主动告诉我们」。它会丢 —— 网络抖一下、我们正好在重启、
   * 上游压根没发，都会丢。丢了如果没有第二条路，结果就是用户付了钱余额不动，
   * 而且两边日志都干干净净，谁都不知道出了事。**收款不能只有一条路。**
   *
   * 已经超时/取消的单子也照查：付款迟到得比超时晚是常事（尤其扫码要人工输金额）。
   * 查到了照样往下走 —— 充值会正常入账，订单不自动开通但会吼出来并留备注。
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async pollGatewayOrders() {
    // 一天以前的不再问了：真到那份上已经不是自动化能解决的问题，得人工对账
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [recharges, orders] = await Promise.all([
      this.prisma.rechargeOrder.findMany({
        where: {
          gatewayOrderNo: { not: null },
          status: { in: [RechargeStatus.pending_payment, RechargeStatus.expired] },
          updatedAt: { gte: since },
        },
        orderBy: { id: 'desc' },
        take: 50,
      }),
      this.prisma.order.findMany({
        where: {
          gatewayOrderNo: { not: null },
          status: { in: [OrderStatus.pending_payment, OrderStatus.cancelled] },
          updatedAt: { gte: since },
        },
        orderBy: { id: 'desc' },
        take: 50,
      }),
    ]);

    const targets = [
      ...recharges.map((r) => ({ kind: 'recharge' as const, no: r.rechargeNo, row: r })),
      ...orders.map((o) => ({ kind: 'order' as const, no: o.orderNo, row: o })),
    ];
    if (targets.length === 0) return;

    const summary: string[] = [];
    // 一个通道这一轮已经连不上了，就别再拿剩下的单子去撞它。
    //
    // 网关整个宕掉的时候，每笔查单都要等满超时（15 秒）。十笔待付款就是两分半，
    // 下一轮的定时任务已经又启动了，越堆越多。一个通道失败一次就够说明问题了。
    const deadChannels = new Set<string>();
    for (const t of targets) {
      const code = t.row.payChannel ?? '';
      if (deadChannels.has(code)) {
        summary.push(`${t.no}=跳过（这一轮通道已经连不上）`);
        continue;
      }
      // 网关已经把这笔关掉了，再问一万遍也是同一个答案
      if (this.closedAtGateway.has(t.no)) continue;
      try {
        const r = await this.askGateway(t.row.payChannel, {
          payOrderId: t.row.upstreamNo,
          mchOrderNo: t.row.gatewayOrderNo,
        });
        if (!r) continue; // 这个驱动不支持查单
        // 把网关记的金额和币种一起写出来：对账时最要紧的就是
        // 「它等的那个数」和「我们让顾客付的那个数」是不是一回事
        const amt =
          r.amountCents != null ? `，网关记的金额 ${r.amountCents} ${r.raw?.currency ?? ''}` : '';
        summary.push(`${t.no}=${r.stateText}${amt}`);
        // 3 支付失败 / 4 已撤销 / 5 已退款 / 6 订单关闭 —— 都是终局，不会再变了。
        // 不记下来的话，一张死单会被每分钟问一次、连问一整天（窗口是 24 小时），
        // 纯粹是拿别人的网关当沙包。
        if (r.state != null && [3, 4, 5, 6].includes(r.state)) {
          this.closedAtGateway.add(t.no);
        }
        if (r.paid) {
          this.logger.warn(`${t.no} 网关说已支付，但我们没收到回调 —— 现在补上`);
          await this.settle(t.kind, t.no, {
            channel: t.row.payChannel!,
            upstreamNo: r.payOrderId,
            amountCents: r.amountCents,
            raw: r.raw,
          });
        }
      } catch (err: any) {
        deadChannels.add(code);
        summary.push(`${t.no}=查单出错(${err?.message ?? err})`);
      }
    }

    // 故意每轮都记一行：一个从来不出声的轮询器，和一个坏掉的轮询器，
    // 在日志里长得一模一样。有待付款的时候最多一分钟一行，不算吵。
    if (summary.length) this.logger.log(`轮询网关 ${summary.length} 笔：${summary.join('　')}`);
  }

  /**
   * 问某个通道要一笔单子的状态。返回 null 表示这个驱动没法查。
   *
   * 目前只有 Jeepay 实现了查单。易支付各家的查单接口差异很大（有的要把密钥
   * 明文拼在 URL 上），USDT 本来就是我们自己盯链、不存在「问网关」这回事。
   */
  private async askGateway(
    channelCode: string | null,
    ref: { payOrderId?: string | null; mchOrderNo?: string | null },
  ) {
    if (!channelCode) return null;
    const channel = await this.prisma.payChannel.findUnique({ where: { code: channelCode } });
    if (!channel || channel.driver !== 'jeepay') return null;
    const cred = decryptJson<JeepayCredentials>(this.secret(), channel.credentialsEncrypted);
    return this.jeepay.queryOrder(
      { ...cred, gatewayUrl: channel.gatewayUrl || cred.gatewayUrl },
      ref,
    );
  }

  /**
   * 管理员手动问一笔。
   *
   * 轮询器一分钟跑一次，但客服在电话里对着用户查的时候等不了一分钟，
   * 而且需要看到网关的原话 —— 「订单不存在」和「支付中」是完全不同的两件事。
   */
  async adminQueryGateway(kind: 'order' | 'recharge', no: string) {
    const row =
      kind === 'recharge'
        ? await this.prisma.rechargeOrder.findUnique({ where: { rechargeNo: no } })
        : await this.prisma.order.findUnique({ where: { orderNo: no } });
    if (!row) throw new NotFoundException('单据不存在');
    if (!row.gatewayOrderNo && !row.upstreamNo) {
      return {
        ok: false,
        message: '这笔单还没提交给任何支付网关，没什么可查的',
      };
    }
    const r = await this.askGateway(row.payChannel, {
      payOrderId: row.upstreamNo,
      mchOrderNo: row.gatewayOrderNo,
    });
    if (!r) {
      return { ok: false, message: `通道 ${row.payChannel} 的驱动不支持查单` };
    }
    if (r.paid) {
      await this.settle(kind, no, {
        channel: row.payChannel!,
        upstreamNo: r.payOrderId,
        amountCents: r.amountCents,
        raw: r.raw,
      });
    }
    return {
      ok: true,
      paid: r.paid,
      found: r.found,
      message: r.paid ? `网关确认已支付，已入账：${r.stateText}` : `网关说：${r.stateText}`,
      submittedNo: row.gatewayOrderNo,
      upstreamNo: r.payOrderId ?? row.upstreamNo,
      gatewayAmount: r.amountCents,
      raw: r.raw,
    };
  }

  /**
   * 盯链。每分钟扫一次有待付款的收款地址。
   *
   * 只在真有人在等付款时才请求外部 API —— 没有待付款还去轮询，
   * 一天几千次白白撞在 TronGrid 的限流上。
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async watchUsdt() {
    const now = new Date();

    // 过期的先清掉，把它们占着的金额释放出来
    const expired = await this.prisma.usdtIntent.updateMany({
      where: { status: UsdtIntentStatus.pending, expiresAt: { lte: now } },
      data: { status: UsdtIntentStatus.expired, activeKey: null },
    });
    if (expired.count) this.logger.log(`${expired.count} 笔 USDT 待付款超时，已释放`);

    const pending = await this.prisma.usdtIntent.findMany({
      where: { status: UsdtIntentStatus.pending, expiresAt: { gt: now } },
      orderBy: { id: 'asc' },
    });
    if (pending.length === 0) return;

    const byChannel = new Map<string, typeof pending>();
    for (const p of pending) {
      const arr = byChannel.get(p.channelCode) ?? [];
      arr.push(p);
      byChannel.set(p.channelCode, arr);
    }

    for (const [code, intents] of byChannel) {
      try {
        await this.scanChannel(code, intents);
      } catch (err: any) {
        this.logger.warn(`扫 USDT 通道 ${code} 出错，下一轮再试：${err.message}`);
      }
    }
  }

  private async scanChannel(
    code: string,
    intents: {
      id: bigint;
      refType: string;
      refNo: string;
      address: string;
      amountUnits: bigint;
      createdAt: Date;
    }[],
  ) {
    const channel = await this.prisma.payChannel.findUnique({ where: { code } });
    if (!channel || !channel.isEnabled) return;
    const cred = tryDecryptJson<UsdtCredentials>(this.secret(), channel.credentialsEncrypted);
    if (!cred?.address) return;

    // 从最早那笔待付款往前推 10 分钟开始查：用户可能在我们建单之前
    // 就已经把币转出去了（先转账后回来点付款的人不少）。
    const oldest = Math.min(...intents.map((i) => i.createdAt.getTime()));
    const transfers = await this.usdt.recentIncoming(cred, {
      sinceMs: oldest - 10 * 60_000,
      limit: 100,
    });
    if (transfers.length === 0) return;

    // 只配对**当前这个收款地址**的待付款。运营中途换过地址的话，
    // 老地址的待付款不能拿新地址的转账去核销 —— 那笔钱根本没进老地址。
    const mine = intents.filter((i) => i.address === cred.address);
    const wanted = new Map(mine.map((i) => [i.amountUnits.toString(), i]));
    for (const t of transfers) {
      const hit = wanted.get(t.valueUnits.toString());
      if (!hit) continue;

      // 同一笔链上转账只能核销一张单。没这个判断的话，同一个 txId
      // 会在每一轮扫描里被重复认领 —— 一笔钱开出十台机器。
      const used = await this.prisma.usdtIntent.findFirst({ where: { txId: t.txId } });
      if (used) continue;

      const claimed = await this.prisma.usdtIntent.updateMany({
        where: { id: hit.id, status: UsdtIntentStatus.pending },
          // 释放占用键，这个金额可以给下一位用了
      data: { status: UsdtIntentStatus.paid, txId: t.txId, paidAt: new Date(), activeKey: null },
      });
      if (claimed.count !== 1) continue; // 别的进程抢先处理了

      this.logger.log(
        `USDT 到账：${this.usdt.format(t.valueUnits)} USDT → ${hit.refType} ${hit.refNo}（${t.txId}）`,
      );
      try {
        await this.settle(hit.refType as 'order' | 'recharge', hit.refNo, {
          channel: code,
          upstreamNo: t.txId,
          raw: { txId: t.txId, from: t.from, value: t.valueUnits.toString() },
        });
      } catch (err: any) {
        // 钱已经到账了，单子没走通只能人工处理。这里绝不能把 intent 改回
        // pending —— 那会让下一轮再认领一次同样的钱。
        this.logger.error(
          `USDT 到账后处理 ${hit.refType} ${hit.refNo} 失败，需要人工介入：${err.message}`,
        );
      }
      wanted.delete(t.valueUnits.toString());
    }
  }

  // ---------- 金额换算 ----------

  /**
   * 换算金额。
   *
   * 有些通道只以特定货币结算（比如某些东南亚通道只收 KHR），
   * 这时候标价是 CNY 但实际扣款要换算。汇率配在通道上，运营自己维护。
   */
  /**
   * 顾客扫码后实际要输入多少钱。
   *
   * 这是**纯展示**：报给网关的金额和币种一个字都不动。原因是这类收款码
   * （柬埔寨 ABA 的 KHQR 静态码）里根本不带金额 —— 网关那边只是记一笔账，
   * 真正决定收到多少的是顾客自己在手机上输的那个数。所以要解决的问题
   * 只有一个：把「1 元」翻译成他手机上该敲的瑞尔数字，并且写得足够大。
   *
   * 汇率算不出来绝不能挡住付款：宁可不显示这行提示，也不能让人点了付不了。
   */
  private async payQuote(
    channel: { payCurrency: string | null; payRate: number | null },
    target: PayTarget,
  ): Promise<FxQuote | null> {
    if (!channel.payCurrency) return null;
    try {
      return await this.fx.quoteFor(
        target.amountCents,
        target.currency,
        channel.payCurrency,
        channel.payRate,
      );
    } catch (err: any) {
      this.logger.warn(`折算实付金额失败，这次先不显示：${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * 报给网关的金额和币种。
   *
   * 默认原样上报 —— 只把折算后的数字给顾客看，不动真正的收款请求。
   *
   * 打开「折算后的金额也报给网关」之后，改成上报同一个折算结果。这在网关靠
   * 「等一笔金额对得上的钱」销账时是**必须**的：网关记着 1.00 元、顾客付的是
   * 603 瑞尔，它会一直等下去，订单永远停在「支付中」。
   *
   * 金额单位是该币种的最小单位：瑞尔没有小数位，603 瑞尔就报 603，
   * 按 100 去乘会变成六万多，多收一百倍。
   */
  private gatewayAmount(
    channel: { payCurrencyToGateway: boolean; settleCurrency: string | null },
    target: PayTarget,
    quote: FxQuote | null,
  ): { amount: number; currency: string; converted: boolean } {
    if (channel.payCurrencyToGateway && quote) {
      return {
        amount: Math.round(quote.amount * minorUnits(quote.currency)),
        currency: quote.currency,
        converted: true,
      };
    }
    return {
      amount: this.convertAmount(target.amountCents, target.currency, channel as any),
      currency: channel.settleCurrency || target.currency,
      converted: false,
    };
  }

  /**
   * 还没点付款时的预览。
   *
   * 让用户在选好通道、填好金额的当下就看见「大约 40,300 瑞尔」，
   * 而不是等下单之后才知道自己要掏多少 —— 后者已经晚了。
   */
  async quote(channelCode: string, amountCents: number, currency?: string) {
    const cents = Math.round(Number(amountCents));
    if (!Number.isFinite(cents) || cents <= 0) return { quote: null };
    const channel = await this.prisma.payChannel.findUnique({ where: { code: channelCode } });
    if (!channel || !channel.isEnabled || !channel.payCurrency) return { quote: null };
    try {
      const q = await this.fx.quoteFor(
        cents,
        (currency || this.wallet.currency()).toUpperCase(),
        channel.payCurrency,
        channel.payRate,
      );
      return { quote: q };
    } catch {
      return { quote: null };
    }
  }

  private convertAmount(
    amountCents: number,
    orderCurrency: string,
    channel: { settleCurrency: string | null; rate: number | null; usdToCnyRate: number | null },
  ): number {
    if (!channel.settleCurrency || channel.settleCurrency === orderCurrency) return amountCents;
    let cents = amountCents;
    if (orderCurrency === 'USD' && channel.usdToCnyRate) {
      cents = Math.round(cents * channel.usdToCnyRate);
    }
    return cents;
  }

  // ---------- 回调 ----------

  /**
   * 钱到账之后往哪走。
   *
   * 单号前缀决定去向：ORD 是套餐订单（去建机），RCH 是充值单（去加余额）。
   * 两条路都必须幂等 —— 支付平台的回调会重发，重发不能重复建机也不能重复加钱。
   */
  private async settle(
    kind: 'order' | 'recharge',
    no: string,
    payment: { channel: string; upstreamNo?: string; amountCents?: number; raw?: any },
  ) {
    const r =
      kind === 'recharge'
        ? await this.wallet.markRechargePaid(no, payment)
        : await this.orders.markPaid(no, payment);
    await this.alarmIfUncollectable(kind, no, payment);
    return r;
  }

  /**
   * 钱到了，但单子已经不能收款了。
   *
   * 最常见的是**迟到的付款**：订单 30 分钟超时被自动取消，用户第 31 分钟
   * 才转的账（USDT 尤其容易，链上确认本身就要几分钟）。这时 markPaid 会
   * 因为「状态不是待付款」而直接返回成功 —— 钱进来了，东西没给，谁都不知道。
   *
   * 这里不自动退款也不自动开通（两者都可能是错的，得看具体情况），
   * 但一定要在日志里吼出来，并且在单子上留一行字，让人能查到。
   */
  private async alarmIfUncollectable(
    kind: 'order' | 'recharge',
    no: string,
    payment: { channel: string; upstreamNo?: string },
  ) {
    if (kind === 'recharge') {
      const r = await this.prisma.rechargeOrder.findUnique({ where: { rechargeNo: no } });
      if (!r || r.status === RechargeStatus.paid) return;
      this.logger.error(
        `钱到了但充值单 ${no} 是 ${r.status} 状态，没有入账！` +
          `金额 ${(r.amountCents / 100).toFixed(2)}，通道 ${payment.channel}，` +
          `上游单号 ${payment.upstreamNo ?? '（无）'}。需要人工给用户补上。`,
      );
      return;
    }
    const o = await this.prisma.order.findUnique({ where: { orderNo: no } });
    if (!o) return;
    const collectable = [OrderStatus.paid, OrderStatus.provisioning, OrderStatus.completed];
    if (collectable.includes(o.status as any)) return;

    this.logger.error(
      `钱到了但订单 ${no} 是 ${o.status} 状态，没有开通！` +
        `金额 ${(o.amountCents / 100).toFixed(2)}，通道 ${payment.channel}，` +
        `上游单号 ${payment.upstreamNo ?? '（无）'}。多半是超时取消之后钱才到的，需要人工处理。`,
    );
    await this.prisma.order
      .update({
        where: { id: o.id },
        data: {
          adminRemark: `收到迟到付款（${payment.channel} ${payment.upstreamNo ?? ''}），订单当时已是 ${o.status}，需人工退款或补开通`.slice(0, 255),
        },
      })
      .catch(() => undefined);
  }

  private kindOf(no: string): 'order' | 'recharge' {
    return no.startsWith('RCH') ? 'recharge' : 'order';
  }

  /** 按单号找到它当初记下的支付通道。验签必须用这一个，不能挨个通道去试。 */
  private async channelFor(no: string) {
    const kind = this.kindOf(no);
    const row =
      kind === 'recharge'
        ? await this.prisma.rechargeOrder.findUnique({ where: { rechargeNo: no } })
        : await this.prisma.order.findUnique({ where: { orderNo: no } });
    if (!row) return { kind, row: null, channel: null };
    const channel = row.payChannel
      ? await this.prisma.payChannel.findUnique({ where: { code: row.payChannel } })
      : null;
    return { kind, row, channel };
  }

  /**
   * Jeepay 异步通知。
   *
   * 这个接口不需要登录（支付平台带不了令牌），所以**验签是唯一的防线**。
   * 验签不过一律拒绝，绝不能因为「看着像成功」就放行。
   */
  async handleJeepayNotify(body: Record<string, any>): Promise<string> {
    return this.handleNotify('jeepay', this.ownNo(body?.mchOrderNo ?? ''), body, (cred, params) =>
      this.jeepay.parseNotify(params, cred as JeepayCredentials),
    );
  }

  /**
   * 易支付异步通知。
   *
   * 易支付发的是 GET，参数在查询串上；返回体必须是纯文本 success，
   * 回别的内容它会认为失败并反复重发，用户那边就一直显示未支付。
   */
  async handleEpayNotify(params: Record<string, any>): Promise<string> {
    return this.handleNotify('epay', this.ownNo(params?.out_trade_no ?? ''), params, (cred, p) =>
      this.epay.parseNotify(p, cred as EpayCredentials),
    );
  }

  /** 两家网关的回调只有解析函数不同，其余流程完全一样 */
  private async handleNotify(
    driver: string,
    no: string,
    params: Record<string, any>,
    parse: (
      cred: unknown,
      params: Record<string, any>,
    ) => {
      valid: boolean;
      success: boolean;
      upstreamNo?: string;
      amountCents?: number;
      reason?: string;
    },
  ): Promise<string> {
    this.logger.log(`收到 ${driver} 通知：单号 ${no || '(空)'}`);
    if (!no) {
      this.logger.warn(`${driver} 通知里没有商户单号，忽略`);
      return 'fail';
    }

    const { kind, row, channel } = await this.channelFor(no);
    if (!row) {
      this.logger.warn(`${driver} 通知的单号 ${no} 在库里找不到`);
      return 'fail';
    }
    if (!channel) {
      this.logger.error(`单号 ${no} 没有记录支付通道，无法验签`);
      return 'fail';
    }
    if (channel.driver !== driver) {
      // 用 A 通道下的单，却收到 B 通道的回调 —— 要么配置错了，要么有人在试探
      this.logger.error(`单号 ${no} 的通道是 ${channel.driver}，却收到 ${driver} 的通知，已拒绝`);
      return 'fail';
    }

    const cred = tryDecryptJson<any>(this.secret(), channel.credentialsEncrypted);
    if (!cred) {
      this.logger.error(`通道 ${channel.code} 的凭据解不开，CREDENTIALS_SECRET 可能被改过`);
      return 'fail';
    }

    const parsed = parse({ ...cred, gatewayUrl: channel.gatewayUrl || cred.gatewayUrl }, params);
    if (!parsed.valid) {
      // 验签失败要记下来，这可能是有人在试探
      this.logger.error(`单号 ${no} 的 ${driver} 通知验签失败，已拒绝`);
      return 'fail';
    }
    if (!parsed.success) {
      this.logger.log(`单号 ${no} 支付未成功：${parsed.reason}`);
      // 验签是对的，只是这次状态不是成功。回 success 让平台别再重发这一条。
      return 'success';
    }

    try {
      await this.settle(kind, no, {
        channel: channel.code,
        upstreamNo: parsed.upstreamNo,
        amountCents: parsed.amountCents,
        raw: params,
      });
    } catch (err: any) {
      this.logger.error(`处理 ${no} 支付成功时出错：${err.message}`);
      // 回 fail 让平台重发，我们下次再试。settle 是幂等的，重发不会重复处理。
      return 'fail';
    }
    return 'success';
  }

  // ---------- 通道管理 ----------

  async adminList() {
    const rows = await this.prisma.payChannel.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return rows.map((c) => ({
      id: c.id.toString(),
      code: c.code,
      name: c.name,
      icon: c.icon,
      driver: c.driver,
      wayCode: c.wayCode,
      settleCurrency: c.settleCurrency,
      payCurrency: c.payCurrency,
      payRate: c.payRate,
      payCurrencyToGateway: c.payCurrencyToGateway,
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

  /** 前端渲染「加通道」表单要知道每种驱动需要填什么 */
  driverSpecs() {
    return DRIVER_SPECS;
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
        payCurrency: normalizeCurrency(dto.payCurrency),
        payRate: dto.payRate ?? null,
        payCurrencyToGateway: dto.payCurrencyToGateway ?? false,
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
        ...(dto.payCurrency !== undefined
          ? { payCurrency: normalizeCurrency(dto.payCurrency) }
          : {}),
        ...(dto.payRate !== undefined ? { payRate: dto.payRate || null } : {}),
        ...(dto.payCurrencyToGateway !== undefined
          ? { payCurrencyToGateway: !!dto.payCurrencyToGateway }
          : {}),
        ...(dto.gatewayUrl !== undefined ? { gatewayUrl: dto.gatewayUrl } : {}),
        ...(dto.credentials
          ? { credentialsEncrypted: encryptJson(this.secret(), dto.credentials) }
          : {}),
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
    const used =
      (await this.prisma.order.count({ where: { payChannel: channel.code } })) +
      (await this.prisma.rechargeOrder.count({ where: { payChannel: channel.code } }));
    if (used > 0) {
      // 删掉的话历史订单的回调就验不了签了，而且对账查不到通道信息
      await this.prisma.payChannel.update({ where: { id }, data: { isEnabled: false } });
      return { ok: true, message: `这个通道有 ${used} 笔历史单据，已改为停用而不是删除` };
    }
    await this.prisma.payChannel.delete({ where: { id } });
    return { ok: true, message: '已删除' };
  }

  async verifyChannel(id: bigint) {
    const c = await this.prisma.payChannel.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('支付通道不存在');
    if (c.driver === 'manual') return { ok: true, message: '线下转账通道不需要测试' };
    if (c.driver === 'balance') return { ok: true, message: '余额支付不需要测试' };

    const cred = tryDecryptJson<any>(this.secret(), c.credentialsEncrypted);
    if (!cred) return { ok: false, message: '凭据解不开，请重新填一遍' };
    const gatewayUrl = c.gatewayUrl || cred.gatewayUrl;

    switch (c.driver) {
      case 'jeepay':
        return this.jeepay.verifyCredentials({ ...cred, gatewayUrl });
      case 'epay':
        return this.epay.verifyCredentials({ ...cred, gatewayUrl });
      case 'usdt_trc20':
        return this.usdt.verifyCredentials(cred);
      default:
        return { ok: false, message: `不认识的驱动 ${c.driver}` };
    }
  }

  private validateChannel(dto: ChannelInput) {
    const c = (dto.credentials ?? {}) as Record<string, any>;
    const spec = DRIVER_SPECS.find((s) => s.driver === dto.driver);
    if (!spec) throw new BadRequestException(`不认识的支付驱动 ${dto.driver}`);

    const missing = spec.credentialFields
      .filter((f) => f.required && !c[f.key] && !(f.key === 'gatewayUrl' && dto.gatewayUrl))
      .map((f) => f.label);
    if (missing.length) {
      throw new BadRequestException(`${spec.label} 通道还缺这些：${missing.join('、')}`);
    }

    if (dto.driver === 'jeepay' && !dto.wayCode) {
      throw new BadRequestException(
        '还没填支付方式码（wayCode）。这个值要问你的 Jeepay 服务商要，' +
          '比如支付宝扫码是 ALI_QR、微信扫码是 WX_NATIVE',
      );
    }
    if (dto.driver === 'epay' && !dto.wayCode) {
      throw new BadRequestException(
        '还没填支付方式（wayCode）。易支付常见的是 alipay / wxpay / qqpay / bank',
      );
    }
    if (dto.driver === 'usdt_trc20') {
      const addr = String(c.address ?? '');
      if (!this.usdt.isValidAddress(addr)) {
        throw new BadRequestException(
          /^0x/i.test(addr)
            ? '这是以太坊（ERC20）地址。TRC20 收款地址是 T 开头的 34 位，填错链收到的币拿不回来。'
            : '收款地址格式不对，TRC20 地址是 T 开头的 34 位',
        );
      }
      if (!dto.usdToCnyRate || dto.usdToCnyRate <= 0) {
        throw new BadRequestException(
          '要填汇率（1 USDT 折多少人民币，比如 7.25）。人民币计价的订单靠它算该收多少币。',
        );
      }
    }
  }

  private summarize(driver: string, blob: string): Record<string, string> {
    if (driver === 'manual') return { 类型: '线下转账，无需凭据' };
    if (driver === 'balance') return { 类型: '账户余额，无需凭据' };
    const c = tryDecryptJson<any>(this.secret(), blob);
    if (!c) return { 状态: '解密失败，需要重新填写凭据' };

    if (driver === 'usdt_trc20') {
      const a = String(c.address ?? '');
      return {
        收款地址: a ? `${a.slice(0, 6)}…${a.slice(-6)}` : '未配置',
        接口密钥: c.apiKey ? '已配置' : '未配置（可能被限流）',
      };
    }
    if (driver === 'epay') {
      return { 商户ID: String(c.pid ?? '?'), 商户密钥: mask(c.key) };
    }
    return {
      商户号: c.mchNo ?? '?',
      应用ID: c.appId ?? '?',
      密钥: mask(c.appSecret),
    };
  }
}

function mask(v: any): string {
  const s = String(v ?? '');
  if (!s) return '未配置';
  return s.length <= 8 ? '*'.repeat(s.length) : `${s.slice(0, 4)}${'*'.repeat(8)}${s.slice(-4)}`;
}

export interface CredentialField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  hint: string;
}

export interface DriverSpec {
  driver: ChannelInput['driver'];
  label: string;
  hint: string;
  needsWayCode: boolean;
  wayCodeHint?: string;
  needsRate?: boolean;
  credentialFields: CredentialField[];
}

/** 每种驱动要填什么。前端拿它渲染表单，服务端拿它做必填校验，一处定义两处用。 */
export const DRIVER_SPECS: DriverSpec[] = [
  {
    driver: 'epay',
    label: '易支付',
    hint: '国内大量服务商共用的一套接口。填服务商给你的网关地址、商户 ID、商户密钥。',
    needsWayCode: true,
    wayCodeHint: '支付方式：alipay 支付宝 / wxpay 微信 / qqpay QQ钱包 / bank 网银',
    credentialFields: [
      {
        key: 'gatewayUrl',
        label: '网关地址',
        type: 'text',
        required: true,
        hint: '填到域名为止，比如 https://pay.example.com，不要带 /submit.php',
      },
      { key: 'pid', label: '商户 ID', type: 'text', required: true, hint: '服务商后台的 PID，一串数字' },
      {
        key: 'key',
        label: '商户密钥',
        type: 'password',
        required: true,
        hint: '服务商后台的 KEY。注意别把前后空格一起复制进来 —— 那会一直报签名错误',
      },
    ],
  },
  {
    driver: 'usdt_trc20',
    label: 'USDT（TRC20）',
    hint: '直接收到你自己的钱包地址，不需要任何商户账号。面板盯着链上，靠金额唯一认单。',
    needsWayCode: false,
    needsRate: true,
    credentialFields: [
      {
        key: 'address',
        label: '收款地址',
        type: 'text',
        required: true,
        hint: 'T 开头的 34 位波场地址。填 0x 开头的以太坊地址会收不到钱。',
      },
      {
        key: 'apiKey',
        label: 'TronGrid API Key',
        type: 'password',
        required: false,
        hint: '选填。不填也能用，但查询频繁时会被限流。在 trongrid.io 免费申请。',
      },
      {
        key: 'apiBase',
        label: '接口地址',
        type: 'text',
        required: false,
        hint: '选填，默认 https://api.trongrid.io。有自建节点可以换成自己的。',
      },
    ],
  },
  {
    driver: 'jeepay',
    label: 'Jeepay 聚合支付',
    hint: '你自己部署的 Jeepay 网关。',
    needsWayCode: true,
    wayCodeHint: '支付方式码：ALI_QR 支付宝扫码 / WX_NATIVE 微信扫码',
    credentialFields: [
      { key: 'gatewayUrl', label: '网关地址', type: 'text', required: true, hint: '填到域名为止' },
      { key: 'mchNo', label: '商户号', type: 'text', required: true, hint: '' },
      { key: 'appId', label: '应用 ID', type: 'text', required: true, hint: '' },
      { key: 'appSecret', label: '应用密钥', type: 'password', required: true, hint: '' },
    ],
  },
  {
    driver: 'balance',
    label: '账户余额',
    hint: '用户先充值再消费。加了这个通道，结算页才会出现「余额支付」。',
    needsWayCode: false,
    credentialFields: [],
  },
  {
    driver: 'manual',
    label: '线下转账',
    hint: '用户按说明转账，管理员在后台手工确认。说明文字写在「备注」里，会显示给用户。',
    needsWayCode: false,
    credentialFields: [],
  },
];

export interface ChannelInput {
  code: string;
  name: string;
  icon?: string;
  driver: 'jeepay' | 'epay' | 'usdt_trc20' | 'balance' | 'manual';
  wayCode?: string;
  settleCurrency?: string;
  /** 顾客扫码时实际要输入的币种，如 KHR。留空 = 和面板计价币种一致 */
  payCurrency?: string | null;
  /** 手工汇率，留空 = 用当日实时汇率 */
  payRate?: number | null;
  /** 折算后的金额是不是也照样报给网关 */
  payCurrencyToGateway?: boolean;
  gatewayUrl?: string;
  credentials?: Record<string, any>;
  rate?: number;
  usdToCnyRate?: number;
  isEnabled?: boolean;
  sortOrder?: number;
  descText?: string;
}

/**
 * 币种代码统一成大写三字母。空串要变成 null 而不是留着 ——
 * 留个空串在库里，`payCurrency: { not: null }` 那类查询就会把它捞出来，
 * 然后每次付款都白跑一趟汇率接口。
 */
function normalizeCurrency(v?: string | null): string | null {
  const c = (v ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : null;
}
