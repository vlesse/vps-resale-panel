import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CurrencyCode } from '@prisma/client';
import { OrdersService } from './orders.service';
import { AdminGuard, CurrentUser, JwtAuthGuard } from '../auth/auth.decorators';

@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @UseGuards(JwtAuthGuard)
  @Post('api/orders')
  create(
    @CurrentUser() user: { userId: string },
    @Body()
    body: { planId: string; currency: CurrencyCode; clientRemark?: string },
  ) {
    return this.orders.createOrder(user.userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('api/orders')
  myOrders(@CurrentUser() user: { userId: string }) {
    return this.orders.myOrders(user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('api/orders/:orderNo')
  one(
    @CurrentUser() user: { userId: string },
    @Param('orderNo') orderNo: string,
  ) {
    return this.orders.getMyOrder(user.userId, orderNo);
  }

  @UseGuards(JwtAuthGuard)
  @Get('api/orders/:orderNo/payment-status')
  paymentStatus(
    @CurrentUser() user: { userId: string },
    @Param('orderNo') orderNo: string,
  ) {
    return this.orders.paymentStatus(user.userId, orderNo);
  }

  /** Public catalog for checkout (no secrets; rates only). */
  @Get('api/payments/methods')
  async payMethods() {
    return this.orders.listPayMethods();
  }

  @UseGuards(JwtAuthGuard)
  @Post('api/orders/:orderNo/pay')
  pay(
    @CurrentUser() user: { userId: string },
    @Param('orderNo') orderNo: string,
    @Body() body: { method?: string },
  ) {
    return this.orders.payOrder(user.userId, orderNo, body || {});
  }

  /** TokenPay async notify (no auth). Responds plain "ok" */
  @Post('api/payments/tokenpay/notify')
  async tokenpayNotify(@Body() body: Record<string, any>, @Req() req: any) {
    const payload = { ...(req.query || {}), ...(body || {}) };
    return this.orders.handleTokenPayNotify(payload);
  }

  /** Jeepay async notify (no auth). Accept JSON or x-www-form-urlencoded */
  @Post('api/payments/jeepay/notify')
  async jeepayNotify(@Body() body: Record<string, any>, @Req() req: any) {
    // Merge query just in case
    const payload = { ...(req.query || {}), ...(body || {}) };
    const result = await this.orders.handleJeepayNotify(payload);
    return result;
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('api/admin/orders')
  adminList() {
    return this.orders.adminList();
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('api/admin/orders/:id/retry-allocate')
  retry(@Param('id') id: string) {
    return this.orders.adminRetryAllocate(id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('api/admin/orders/:id/mark-paid')
  markPaid(
    @Param('id') id: string,
    @Body() body: { remark?: string },
  ) {
    return this.orders.adminMarkPaid(id, body?.remark);
  }
}
