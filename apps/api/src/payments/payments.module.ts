import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { JeepayDriver } from './drivers/jeepay.driver';
import { AdminPayChannelsController, PaymentsController } from './payments.controller';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [OrdersModule],
  providers: [PaymentsService, JeepayDriver],
  controllers: [PaymentsController, AdminPayChannelsController],
  exports: [PaymentsService],
})
export class PaymentsModule {}
