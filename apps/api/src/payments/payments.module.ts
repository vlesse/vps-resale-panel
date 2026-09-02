import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { JeepayDriver } from './drivers/jeepay.driver';
import { EpayDriver } from './drivers/epay.driver';
import { UsdtDriver } from './drivers/usdt.driver';
import { AbaKhqrDriver } from './drivers/aba-khqr.driver';
import { FxService } from './fx.service';
import { AdminPayChannelsController, PaymentsController } from './payments.controller';
import { OrdersModule } from '../orders/orders.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [OrdersModule, WalletModule],
  providers: [PaymentsService, JeepayDriver, EpayDriver, UsdtDriver, AbaKhqrDriver, FxService],
  controllers: [PaymentsController, AdminPayChannelsController],
  exports: [PaymentsService, FxService],
})
export class PaymentsModule {}
