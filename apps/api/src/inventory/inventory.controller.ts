import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { InventoryStatus } from '@prisma/client';
import { InventoryService } from './inventory.service';
import { AdminGuard, JwtAuthGuard } from '../auth/auth.decorators';

@Controller('api/admin/inventory')
@UseGuards(JwtAuthGuard, AdminGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  list(@Query('status') status?: InventoryStatus) {
    return this.inventory.list(status);
  }

  @Post()
  create(@Body() body: any) {
    return this.inventory.create(body);
  }

  @Post(':id/status')
  status(
    @Param('id') id: string,
    @Body() body: { status: InventoryStatus; notes?: string },
  ) {
    return this.inventory.updateStatus(id, body.status, body.notes);
  }

  @Post(':id/test-connection')
  testConnection(@Param('id') id: string) {
    return this.inventory.testConnection(id);
  }
}
