import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { RechargeStatus } from '@prisma/client';
import { WalletService } from './wallet.service';
import { AdminGuard, AuthedUser, CurrentUser } from '../auth/auth.decorators';

class CreateRechargeDto {
  /** 单位分。前端填的是元，换算在前端做，这里只认分。 */
  @IsInt() @Min(1) @Max(100_000_00) amountCents: number;
}

class AdjustDto {
  /** 正数加钱，负数扣钱，单位分 */
  @IsInt() amountCents: number;
  @IsString() @Length(1, 255) remark: string;
}

@Controller('api/wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  summary(@CurrentUser() user: AuthedUser) {
    return this.wallet.summary(user.id);
  }

  @Get('ledger')
  ledger(@CurrentUser() user: AuthedUser, @Query() q: { page?: number; pageSize?: number }) {
    return this.wallet.ledger(user.id, q);
  }

  @Get('recharges')
  recharges(@CurrentUser() user: AuthedUser, @Query() q: { page?: number; pageSize?: number }) {
    return this.wallet.myRecharges(user.id, q);
  }

  /** 建一张充值单。建完拿返回的 rechargeNo 去 /api/payments/recharge/:no/pay 付款。 */
  @Post('recharges')
  createRecharge(@CurrentUser() user: AuthedUser, @Body() dto: CreateRechargeDto) {
    return this.wallet.createRecharge(user, dto.amountCents);
  }
}

@Controller('api/admin/wallet')
@UseGuards(AdminGuard)
export class AdminWalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('recharges')
  recharges(
    @Query() q: { keyword?: string; status?: RechargeStatus; page?: number; pageSize?: number },
  ) {
    return this.wallet.adminRecharges(q);
  }

  /** 线下转账时管理员手工确认到账 */
  @Post('recharges/:rechargeNo/mark-paid')
  markPaid(@CurrentUser() user: AuthedUser, @Param('rechargeNo') no: string) {
    return this.wallet.adminMarkRechargePaid(user, no);
  }

  @Get('users/:id/ledger')
  ledger(@Param('id') id: string, @Query() q: { page?: number; pageSize?: number }) {
    return this.wallet.adminLedger(BigInt(id), q);
  }

  /** 手工加减余额。补偿、退款、纠错都走这里，必须写原因。 */
  @Post('users/:id/adjust')
  adjust(@CurrentUser() user: AuthedUser, @Param('id') id: string, @Body() dto: AdjustDto) {
    return this.wallet.adjust(user, BigInt(id), dto.amountCents, dto.remark);
  }
}
