import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
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

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.payments.deleteChannel(BigInt(id));
  }
}
