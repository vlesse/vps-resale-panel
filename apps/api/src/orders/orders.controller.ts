import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BillingCycle, CurrencyCode, OrderStatus } from '@prisma/client';
import { OrdersService } from './orders.service';
import { AdminGuard, AuthedUser, CurrentUser } from '../auth/auth.decorators';

class CustomSpecDto {
  @IsInt() @Min(1) cpu: number;
  @IsInt() @Min(256) memoryMb: number;
  @IsInt() @Min(1) diskGb: number;
}

class CreateOrderDto {
  @IsString() planId: string;
  @IsOptional() @IsEnum(BillingCycle) cycle?: BillingCycle;
  @IsEnum(CurrencyCode) currency: CurrencyCode;
  @IsOptional() @IsString() @Length(0, 255) remark?: string;
  /** 自定义档才有。这里只做类型和下限校验，真正的范围和价格由服务端按套餐配置重算。 */
  @IsOptional() @ValidateNested() @Type(() => CustomSpecDto) customSpec?: CustomSpecDto;
}

class RenewDto {
  @IsOptional() @IsEnum(BillingCycle) cycle?: BillingCycle;
  @IsEnum(CurrencyCode) currency: CurrencyCode;
}

@Controller('api/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(@CurrentUser() user: AuthedUser, @Body() dto: CreateOrderDto) {
    return this.orders.create(user, dto);
  }

  @Get()
  listMine(@CurrentUser() user: AuthedUser) {
    return this.orders.listMine(user.id);
  }

  @Get(':orderNo')
  detail(@CurrentUser() user: AuthedUser, @Param('orderNo') orderNo: string) {
    return this.orders.detail(user, orderNo);
  }

  /** 支付页每两秒轮询这个，所以刻意做得很轻 */
  @Get(':orderNo/payment-status')
  status(@CurrentUser() user: AuthedUser, @Param('orderNo') orderNo: string) {
    return this.orders.paymentStatus(user, orderNo);
  }

  @Post(':orderNo/cancel')
  cancel(@CurrentUser() user: AuthedUser, @Param('orderNo') orderNo: string) {
    return this.orders.cancel(user, orderNo);
  }
}

@Controller('api/services')
export class RenewalController {
  constructor(private readonly orders: OrdersService) {}

  @Post(':id/renew')
  renew(@CurrentUser() user: AuthedUser, @Param('id') id: string, @Body() dto: RenewDto) {
    return this.orders.createRenewal(user, BigInt(id), dto);
  }
}

@Controller('api/admin/orders')
@UseGuards(AdminGuard)
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@Query() q: { keyword?: string; status?: OrderStatus; page?: number; pageSize?: number }) {
    return this.orders.adminList(q);
  }

  /** 线下转账、或者回调丢了的时候手工补单 */
  @Post(':orderNo/mark-paid')
  markPaid(@Param('orderNo') orderNo: string, @Body() body: { note?: string }) {
    return this.orders.adminMarkPaid(orderNo, body?.note);
  }

  @Post(':orderNo/retry-provision')
  retry(@Param('orderNo') orderNo: string) {
    return this.orders.adminRetryProvision(orderNo);
  }
}
