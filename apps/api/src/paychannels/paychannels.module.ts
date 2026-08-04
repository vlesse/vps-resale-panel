import { Module } from '@nestjs/common';
import { PayChannelsService } from './paychannels.service';
import { PayChannelsController } from './paychannels.controller';

@Module({
  providers: [PayChannelsService],
  controllers: [PayChannelsController],
  exports: [PayChannelsService],
})
export class PayChannelsModule {}
