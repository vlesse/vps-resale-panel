import { Module } from '@nestjs/common';
import { NatService } from './nat.service';
import { NatController } from './nat.controller';

@Module({
  providers: [NatService],
  controllers: [NatController],
  exports: [NatService],
})
export class NatModule {}
