import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrencyCode } from '@prisma/client';
import { PlansService } from './plans.service';
import { AdminGuard, JwtAuthGuard } from '../auth/auth.decorators';

@Controller()
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get('api/plans')
  list() {
    return this.plans.listPublic();
  }

  @Get('api/plans/:id')
  get(@Param('id') id: string) {
    return this.plans.getPublic(id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('api/admin/plans')
  adminList() {
    return this.plans.adminList();
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('api/admin/plans')
  adminCreate(@Body() body: any) {
    return this.plans.adminCreate(body);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Patch('api/admin/plans/:id')
  adminUpdate(@Param('id') id: string, @Body() body: any) {
    return this.plans.adminUpdate(id, body);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('api/admin/plans/:id/prices')
  upsertPrice(
    @Param('id') id: string,
    @Body() body: { currency: CurrencyCode; priceCents: number },
  ) {
    return this.plans.upsertPrice(id, body.currency, body.priceCents);
  }
}
