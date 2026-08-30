import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { NatService } from './nat.service';
import { AdminGuard } from '../auth/auth.decorators';

class CreateGatewayDto {
  @IsString() @Length(1, 64) name: string;
  @IsString() @Length(1, 128) publicHost: string;
  @IsOptional() @IsString() @Length(1, 128) sshHost?: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535) sshPort?: number;
  @IsOptional() @IsString() sshUser?: string;
  @IsOptional() @IsString() password?: string;
  @IsOptional() @IsString() privateKey?: string;
  @IsString() @Length(9, 32) subnet: string;
  @IsInt() @Min(1024) @Max(65535) portStart: number;
  @IsInt() @Min(1024) @Max(65535) portEnd: number;
  @IsOptional() @IsInt() @Min(1) @Max(1000) portsPerMachine?: number;
  @IsOptional() @IsString() @Length(0, 128) webDomain?: string;
}

class UpdateGatewayDto {
  @IsOptional() @IsString() @Length(1, 64) name?: string;
  @IsOptional() @IsString() @Length(1, 128) publicHost?: string;
  @IsOptional() @IsString() @Length(1, 128) sshHost?: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535) sshPort?: number;
  @IsOptional() @IsString() sshUser?: string;
  @IsOptional() @IsString() password?: string;
  @IsOptional() @IsString() privateKey?: string;
  @IsOptional() @IsString() @Length(9, 32) subnet?: string;
  @IsOptional() @IsInt() @Min(1024) @Max(65535) portStart?: number;
  @IsOptional() @IsInt() @Min(1024) @Max(65535) portEnd?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1000) portsPerMachine?: number;
  @IsOptional() @IsString() @Length(0, 128) webDomain?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@Controller('api/admin/nat-gateways')
@UseGuards(AdminGuard)
export class NatController {
  constructor(private readonly service: NatService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.service.detail(BigInt(id));
  }

  @Post()
  create(@Body() dto: CreateGatewayDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateGatewayDto) {
    return this.service.update(BigInt(id), dto);
  }

  /** 连上去看看能不能用：转发开了没、到私网的路由通不通 */
  @Post(':id/test')
  test(@Param('id') id: string) {
    return this.service.test(BigInt(id));
  }

  /** 手工重新下发一遍规则。网关重装、别人手动改过之后用得上。 */
  @Post(':id/sync')
  sync(@Param('id') id: string) {
    return this.service.sync(BigInt(id));
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(BigInt(id));
  }
}
