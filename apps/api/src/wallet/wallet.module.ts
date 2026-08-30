import { Module } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { AdminWalletController, WalletController } from './wallet.controller';

@Module({
  providers: [WalletService],
  controllers: [WalletController, AdminWalletController],
  exports: [WalletService],
})
export class WalletModule {}
