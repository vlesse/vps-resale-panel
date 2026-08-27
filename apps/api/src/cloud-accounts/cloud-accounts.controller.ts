import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString, Length, Min } from 'class-validator';
import { ProviderKind } from '@prisma/client';
import { CloudAccountsService } from './cloud-accounts.service';
import { AdminGuard } from '../auth/auth.decorators';

class CreateCloudAccountDto {
  @IsString() @Length(1, 120) name: string;
  @IsEnum(ProviderKind) provider: ProviderKind;
  @IsObject() credentials: Record<string, any>;
  @IsOptional() @IsString() defaultRegion?: string;
  @IsOptional() @IsInt() @Min(0) dailyCreateQuota?: number;
  @IsOptional() @IsString() notes?: string;
}

class UpdateCloudAccountDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsObject() credentials?: Record<string, any>;
  @IsOptional() @IsString() defaultRegion?: string;
  @IsOptional() @IsInt() @Min(0) dailyCreateQuota?: number;
  @IsOptional() @IsBoolean() isEnabled?: boolean;
  @IsOptional() @IsString() notes?: string;
}

@Controller('api/admin/cloud-accounts')
@UseGuards(AdminGuard)
export class CloudAccountsController {
  constructor(private readonly service: CloudAccountsService) {}

  /** 每家驱动支持什么、要填哪些字段 —— 前端拿它渲染表单 */
  @Get('capabilities')
  capabilities() {
    return this.service.capabilities();
  }

  @Get()
  list() {
    return this.service.list();
  }

  @Post()
  create(@Body() dto: CreateCloudAccountDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCloudAccountDto) {
    return this.service.update(BigInt(id), dto);
  }

  @Post(':id/verify')
  verify(@Param('id') id: string) {
    return this.service.verify(BigInt(id));
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(BigInt(id));
  }
}
