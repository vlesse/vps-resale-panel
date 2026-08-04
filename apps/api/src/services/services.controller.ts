import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrencyCode } from '@prisma/client';
import { ServicesService } from './services.service';
import { AdminGuard, CurrentUser, JwtAuthGuard } from '../auth/auth.decorators';

@Controller()
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @UseGuards(JwtAuthGuard)
  @Get('api/services')
  list(@CurrentUser() user: { userId: string }) {
    return this.services.myServices(user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('api/services/:id')
  one(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.services.myService(user.userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('api/services/:id/status-check')
  statusCheck(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.services.checkStatus(user.userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('api/services/:id/reboot')
  reboot(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.services.reboot(user.userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('api/services/:id/reset-password')
  resetPassword(
    @CurrentUser() user: { userId: string },
    @Param('id') id: string,
    @Body() body: { password?: string },
  ) {
    return this.services.resetPassword(user.userId, id, body || {});
  }

  @UseGuards(JwtAuthGuard)
  @Post('api/services/:id/reinstall')
  reinstall(
    @CurrentUser() user: { userId: string },
    @Param('id') id: string,
    @Body() body: { osTemplate?: string; password?: string },
  ) {
    return this.services.reinstall(user.userId, id, body || {});
  }

  @UseGuards(JwtAuthGuard)
  @Post('api/services/:id/renew')
  renew(
    @CurrentUser() user: { userId: string },
    @Param('id') id: string,
    @Body() body: { currency: CurrencyCode },
  ) {
    return this.services.renew(user.userId, id, body.currency);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('api/admin/services')
  adminList() {
    return this.services.adminList();
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('api/admin/services/:id/status-check')
  adminStatusCheck(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.services.checkStatus(user.userId, id, true);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('api/admin/services/:id/reboot')
  adminReboot(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.services.reboot(user.userId, id, true);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('api/admin/services/:id/reset-password')
  adminResetPassword(
    @CurrentUser() user: { userId: string },
    @Param('id') id: string,
    @Body() body: { password?: string },
  ) {
    return this.services.resetPassword(user.userId, id, body || {}, true);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('api/admin/services/:id/reinstall')
  adminReinstall(
    @CurrentUser() user: { userId: string },
    @Param('id') id: string,
    @Body() body: { osTemplate?: string; password?: string },
  ) {
    return this.services.reinstall(user.userId, id, body || {}, true);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('api/admin/services/:id/suspend')
  suspend(@Param('id') id: string) {
    return this.services.adminSuspend(id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('api/admin/services/:id/recycle')
  recycle(@Param('id') id: string) {
    return this.services.adminRecycle(id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('api/admin/tasks/expire-services')
  expire() {
    return this.services.expireDue();
  }
}
