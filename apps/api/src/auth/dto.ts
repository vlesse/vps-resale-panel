import { IsEmail, IsEnum, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';
import { UserRole, UserStatus } from '@prisma/client';

export class RegisterDto {
  @IsEmail({}, { message: '邮箱格式不对' })
  email: string;

  @IsString()
  @Length(8, 72, { message: '密码要 8 到 72 位' })
  password: string;

  @IsOptional()
  @IsString()
  @Length(0, 64)
  displayName?: string;

  @IsString({ message: '请先获取验证码' })
  captchaId: string;

  @IsString({ message: '请填写验证码' })
  captchaCode: string;
}

export class LoginDto {
  @IsEmail({}, { message: '邮箱格式不对' })
  email: string;

  @IsString()
  password: string;

  @IsString({ message: '请先获取验证码' })
  captchaId: string;

  @IsString({ message: '请填写验证码' })
  captchaCode: string;
}

export class UpdateProfileDto {
  @IsOptional() @IsString() @Length(0, 64) displayName?: string;
  @IsOptional() @IsString() @Length(0, 32) phone?: string;
}

export class ChangePasswordDto {
  @IsString() oldPassword: string;
  @IsString() @Length(8, 72, { message: '新密码要 8 到 72 位' }) newPassword: string;
}

export class AdminUpdateUserDto {
  @IsOptional() @IsString() @Length(0, 64) displayName?: string;
  @IsOptional() @IsString() @Length(0, 32) phone?: string;
  @IsOptional() @IsEnum(UserRole) role?: UserRole;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @IsOptional() @IsString() @Length(8, 72) newPassword?: string;
  @IsOptional() @IsInt() @Min(0) maxActiveServices?: number;
}
