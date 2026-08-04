import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PayChannelsService } from './paychannels.service';
import { AdminGuard, CurrentUser, JwtAuthGuard } from '../auth/auth.decorators';

@Controller()
export class PayChannelsController {
  constructor(private readonly svc: PayChannelsService) {}

  /** Public: enabled channels for checkout */
  @Get('api/payments/channels')
  listPublic() {
    return this.svc.listPublic();
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('api/admin/pay-channels')
  listAdmin() {
    return this.svc.listAdmin();
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('api/admin/pay-channels/:id')
  one(@Param('id') id: string) {
    return this.svc.getOneAdmin(id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('api/admin/pay-channels')
  create(@Body() body: any) {
    return this.svc.create(body);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Patch('api/admin/pay-channels/:id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.svc.update(id, body);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Delete('api/admin/pay-channels/:id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Patch('api/admin/pay-channels/:id/toggle')
  toggle(@Param('id') id: string, @Body() body: { enabled: boolean }) {
    return this.svc.setEnabled(id, body.enabled);
  }
}
