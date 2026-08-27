import { Module } from '@nestjs/common';
import { PlansService } from './plans.service';
import { AdminPlansController, PlansController } from './plans.controller';

@Module({
  providers: [PlansService],
  controllers: [PlansController, AdminPlansController],
  exports: [PlansService],
})
export class PlansModule {}
