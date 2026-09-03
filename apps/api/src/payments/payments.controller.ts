import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PaymentsService, ChannelInput } from './payments.service';
import { AdminGuard, AuthedUser, ClientIp, CurrentUser, Public } from '../auth/auth.decorators';

@Controller('api/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** 结算页要展示哪些支付方式。不登录也能看，方便未登录用户先了解。 */
  @Public()
  @Get('channels')
  channels() {
    return this.payments.publicChannels();
  }

  /** 每种支付驱动要填哪些字段。后台加通道的表单靠它渲染。 */
  @Public()
  @Get('driver-specs')
  driverSpecs() {
    return this.payments.driverSpecs();
  }

  /**
   * 「这笔钱换成瑞尔是多少」的预览。
   *
   * 不登录也能问：它只做一次汇率折算，不碰任何单据，也不吐用户数据。
   * 页面上要在用户改金额的当下就更新，走认证只会多一层没必要的失败点。
   */
  @Public()
  @Get('quote')
  quote(@Query() q: { channel?: string; amountCents?: string; currency?: string }) {
    return this.payments.quote(q?.channel ?? '', Number(q?.amountCents), q?.currency);
  }

  /** 充值单付款。和订单付款走同一套通道，只是单子不同。 */
  @Post('recharge/:rechargeNo/pay')
  payRecharge(
    @CurrentUser() user: AuthedUser,
    @Param('rechargeNo') no: string,
    @Body() body: { channel: string },
    @ClientIp() ip?: string,
  ) {
    return this.payments.payRecharge(user, no, body?.channel, ip);
  }

  /**
   * 外部程序把银行到账通知推过来。
   *
   * 必须是 @Public —— 推的是一个 telethon 监听器之类的东西，带不了登录令牌。
   * 安全完全依赖通道上配的那个密钥，而那个密钥等于收款入账的钥匙。
   * 密钥不对一律返回 404，不给探测的人任何反馈。
   */
  @Public()
  @Post('khqr/:code/notice')
  inboundNotice(
    @Param('code') code: string,
    @Body() body: { secret?: string; text?: string },
    @Req() req: any,
  ) {
    // 密钥放 header 里更顺手，两种都收
    const secret = body?.secret ?? req?.headers?.['x-panel-secret'] ?? '';
    return this.payments.submitInboundNotice(code, String(secret), body?.text ?? '');
  }

  /** 前端轮询这个看扫码付款认出来没有 —— 靠金额认单，没有回调 */
  @Get('khqr/:intentNo')
  khqrStatus(@CurrentUser() user: AuthedUser, @Param('intentNo') no: string) {
    return this.payments.khqrStatus(user, no);
  }

  /** 前端轮询这个看 USDT 到账没有 —— 链上收款没有回调，只能问 */
  @Get('usdt/:intentNo')
  usdtStatus(@CurrentUser() user: AuthedUser, @Param('intentNo') no: string) {
    return this.payments.usdtStatus(user, no);
  }

  @Post(':orderNo/pay')
  pay(
    @CurrentUser() user: AuthedUser,
    @Param('orderNo') orderNo: string,
    @Body() body: { channel: string },
    @ClientIp() ip?: string,
  ) {
    return this.payments.pay(user, orderNo, body?.channel, ip);
  }

  /**
   * Jeepay 异步通知。
   *
   * 必须是 @Public —— 支付平台带不了登录令牌。安全完全依赖签名校验。
   * 返回体必须是纯文本 success，Jeepay 收到别的内容会认为失败并反复重发。
   */
  @Public()
  @Post('jeepay/notify')
  async jeepayNotify(@Req() req: any, @Body() body: Record<string, any>) {
    // Jeepay 可能发 JSON 也可能发表单，两种都收
    const params = { ...(body ?? {}), ...(req.query ?? {}) };
    return this.payments.handleJeepayNotify(params);
  }

  /**
   * 易支付异步通知。
   *
   * 易支付发的是 GET，参数在查询串上；但有些服务商改成了 POST，
   * 所以两个方法都挂上，合并 query 和 body 一起处理。
   * 返回体必须是纯文本 success，回别的内容它会一直重发。
   */
  @Public()
  @Get('epay/notify')
  epayNotifyGet(@Query() query: Record<string, any>) {
    return this.payments.handleEpayNotify(query ?? {});
  }

  @Public()
  @Post('epay/notify')
  epayNotifyPost(@Req() req: any, @Body() body: Record<string, any>) {
    return this.payments.handleEpayNotify({ ...(req.query ?? {}), ...(body ?? {}) });
  }
}

@Controller('api/admin/pay-channels')
@UseGuards(AdminGuard)
export class AdminPayChannelsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  list() {
    return this.payments.adminList();
  }

  @Post()
  create(@Body() dto: ChannelInput) {
    return this.payments.createChannel(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: Partial<ChannelInput>) {
    return this.payments.updateChannel(BigInt(id), dto);
  }

  @Post(':id/verify')
  verify(@Param('id') id: string) {
    return this.payments.verifyChannel(BigInt(id));
  }

  /**
   * 反过来问网关：这笔到底收到钱没有。
   *
   * 回调丢了的时候这是唯一能自证清白的东西 —— 用户说付了，
   * 我们这边余额没动，网关的原话能立刻分出是谁的问题。
   * 查到已支付会当场入账。
   */
  /**
   * 手工录一条银行到账通知。
   *
   * 自动读取那条路断掉的时候（群改了、bot 被踢了、Telegram 抽风），
   * 钱照样在进账户 —— 得有地方能把手里那条通知原文录进去。
   * 走的是和自动匹配同一段代码，不会绕开金额匹配和幂等判断。
   */
  @Post('khqr/:code/notice')
  submitNotice(@Param('code') code: string, @Body() body: { text?: string }) {
    return this.payments.adminSubmitNotice(code, body?.text ?? '');
  }

  @Post('query/:kind/:no')
  queryGateway(@Param('kind') kind: string, @Param('no') no: string) {
    return this.payments.adminQueryGateway(kind === 'order' ? 'order' : 'recharge', no);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.payments.deleteChannel(BigInt(id));
  }
}
