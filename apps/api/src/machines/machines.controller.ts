import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { MachineStatus, ProviderKind } from '@prisma/client';
import { MachinesService } from './machines.service';
import { AdminGuard } from '../auth/auth.decorators';

@Controller('api/admin/machines')
@UseGuards(AdminGuard)
export class MachinesController {
  constructor(private readonly machines: MachinesService) {}

  @Get()
  list(
    @Query()
    q: {
      status?: MachineStatus;
      provider?: ProviderKind;
      keyword?: string;
      page?: number;
      pageSize?: number;
    },
  ) {
    return this.machines.list(q);
  }

  /**
   * 疑似还在云上计费的残留实例。
   * 这个数字如果不是 0，说明有机器可能正在烧钱而面板已经不管它们了。
   */
  @Get('orphans')
  orphans() {
    return this.machines.suspectedOrphans();
  }

  @Post()
  create(@Body() dto: any) {
    return this.machines.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: any) {
    return this.machines.update(BigInt(id), dto);
  }

  @Post(':id/test-connection')
  test(@Param('id') id: string) {
    return this.machines.testConnection(BigInt(id));
  }

  @Post(':id/status')
  status(@Param('id') id: string, @Body() body: { status: MachineStatus }) {
    return this.machines.changeStatus(BigInt(id), body.status);
  }

  @Post(':id/retry-release')
  retryRelease(@Param('id') id: string) {
    return this.machines.retryRelease(BigInt(id));
  }

  @Post(':id/mark-cleaned')
  markCleaned(@Param('id') id: string, @Body() body: { note?: string }) {
    return this.machines.markCleaned(BigInt(id), body?.note);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.machines.remove(BigInt(id));
  }
}
