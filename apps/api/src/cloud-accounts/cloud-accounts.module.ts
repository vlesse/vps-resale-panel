import { Module } from '@nestjs/common';
import { CloudAccountsService } from './cloud-accounts.service';
import { CloudAccountsController } from './cloud-accounts.controller';

@Module({
  providers: [CloudAccountsService],
  controllers: [CloudAccountsController],
  exports: [CloudAccountsService],
})
export class CloudAccountsModule {}
