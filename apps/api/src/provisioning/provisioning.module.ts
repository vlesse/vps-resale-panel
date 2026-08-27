import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ProvisioningService } from './provisioning.service';
import {
  PROVISION_QUEUE,
  ProvisionQueueService,
  ProvisioningProcessor,
} from './provisioning.processor';

@Module({
  imports: [BullModule.registerQueue({ name: PROVISION_QUEUE })],
  providers: [ProvisioningService, ProvisioningProcessor, ProvisionQueueService],
  exports: [ProvisioningService, ProvisionQueueService],
})
export class ProvisioningModule {}
