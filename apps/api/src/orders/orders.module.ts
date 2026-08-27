import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { AdminOrdersController, OrdersController, RenewalController } from './orders.controller';
import { PlansModule } from '../plans/plans.module';
import { ProvisioningModule } from '../provisioning/provisioning.module';

@Module({
  imports: [PlansModule, ProvisioningModule],
  providers: [OrdersService],
  controllers: [OrdersController, RenewalController, AdminOrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
