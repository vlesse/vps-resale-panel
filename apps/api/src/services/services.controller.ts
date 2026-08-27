import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ServiceStatus } from '@prisma/client';
import { ServicesService } from './services.service';
import { AdminGuard, AuthedUser, CurrentUser } from '../auth/auth.decorators';

@Controller('api/services')
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get()
  listMine(@CurrentUser() user: AuthedUser) {
    return this.services.listMine(user.id);
  }

  @Get(':id')
  detail(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.services.detail(user, BigInt(id), refresh === '1' || refresh === 'true');
  }

  @Get(':id/metrics')
  metrics(@CurrentUser() user: AuthedUser, @Param('id') id: string, @Query('hours') hours?: string) {
    return this.services.metrics(user, BigInt(id), Math.min(720, Number(hours) || 24));
  }

  @Post(':id/start')
  start(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.services.power(user, BigInt(id), 'start');
  }

  @Post(':id/stop')
  stop(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.services.power(user, BigInt(id), 'stop');
  }

  @Post(':id/reboot')
  reboot(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.services.power(user, BigInt(id), 'reboot');
  }

  @Post(':id/reset-password')
  resetPassword(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.services.resetPassword(user, BigInt(id));
  }

  /** 重装要把机器编号原样抄一遍，防误触 —— 这一步会清空整块盘 */
  @Post(':id/rebuild')
  rebuild(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() body: { confirm: string },
  ) {
    return this.services.rebuild(user, BigInt(id), body?.confirm ?? '');
  }
}

@Controller('api/admin/services')
@UseGuards(AdminGuard)
export class AdminServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get()
  list(
    @Query() query: { keyword?: string; status?: ServiceStatus; page?: number; pageSize?: number },
  ) {
    return this.services.listAll(query);
  }

  @Post(':id/suspend')
  suspend(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.services.suspend(user, BigInt(id), body?.reason ?? '');
  }

  @Post(':id/resume')
  resume(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.services.resume(user, BigInt(id));
  }

  @Post(':id/release')
  release(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() body: { confirm: string },
  ) {
    return this.services.release(user, BigInt(id), body?.confirm ?? '');
  }
}
