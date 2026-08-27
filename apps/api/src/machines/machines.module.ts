import { Module } from '@nestjs/common';
import { MachinesService } from './machines.service';
import { MachinesController } from './machines.controller';

@Module({
  providers: [MachinesService],
  controllers: [MachinesController],
  exports: [MachinesService],
})
export class MachinesModule {}
