import { Module } from '@nestjs/common';
import { ServicesService } from './services.service';
import { AdminServicesController, ServicesController } from './services.controller';
import { ProvisioningModule } from '../provisioning/provisioning.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [ProvisioningModule, WalletModule],
  providers: [ServicesService],
  controllers: [ServicesController, AdminServicesController],
  exports: [ServicesService],
})
export class ServicesModule {}
