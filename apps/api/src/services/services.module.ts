import { Module } from '@nestjs/common';
import { ServicesService } from './services.service';
import { AdminServicesController, ServicesController } from './services.controller';
import { ProvisioningModule } from '../provisioning/provisioning.module';

@Module({
  imports: [ProvisioningModule],
  providers: [ServicesService],
  controllers: [ServicesController, AdminServicesController],
  exports: [ServicesService],
})
export class ServicesModule {}
