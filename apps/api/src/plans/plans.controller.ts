import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { PlansService, PlanInput } from './plans.service';
import { AdminGuard, Public } from '../auth/auth.decorators';

@Controller('api/plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  /** 首页商品列表。不登录也能看 —— 不让人先看货再注册的商城是没生意的。 */
  @Public()
  @Get()
  list() {
    return this.plans.publicList();
  }

  @Public()
  @Get(':id')
  detail(@Param('id') id: string) {
    return this.plans.publicDetail(BigInt(id));
  }
}

@Controller('api/admin/plans')
@UseGuards(AdminGuard)
export class AdminPlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  list() {
    return this.plans.adminList();
  }

  @Post()
  create(@Body() dto: PlanInput) {
    return this.plans.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: Partial<PlanInput>) {
    return this.plans.update(BigInt(id), dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.plans.remove(BigInt(id));
  }
}
