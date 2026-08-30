import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { JeepayDriver } from './drivers/jeepay.driver';
import { EpayDriver } from './drivers/epay.driver';
import { UsdtDriver } from './drivers/usdt.driver';
import { AdminPayChannelsController, PaymentsController } from './payments.controller';
import { OrdersModule } from '../orders/orders.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [OrdersModule, WalletModule],
  providers: [PaymentsService, JeepayDriver, EpayDriver, UsdtDriver],
  controllers: [PaymentsController, AdminPayChannelsController],
  exports: [PaymentsService],
})
export class PaymentsModule {}
