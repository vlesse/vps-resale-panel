import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  AdminGuard,
  AuthedUser,
  ClientIp,
  CurrentUser,
  Public,
} from './auth.decorators';
import {
  AdminUpdateUserDto,
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  UpdateProfileDto,
} from './dto';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto, @ClientIp() ip?: string) {
    return this.auth.register(dto, ip);
  }

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @ClientIp() ip?: string) {
    return this.auth.login(dto, ip);
  }

  @Get('me')
  me(@CurrentUser() user: AuthedUser) {
    return this.auth.me(user.id);
  }

  @Patch('profile')
  updateProfile(@CurrentUser() user: AuthedUser, @Body() dto: UpdateProfileDto) {
    return this.auth.updateProfile(user.id, dto);
  }

  @Post('change-password')
  changePassword(@CurrentUser() user: AuthedUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.id, dto);
  }
}

@Controller('api/admin/users')
@UseGuards(AdminGuard)
export class AdminUserController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  list(@Query() query: { keyword?: string; page?: number; pageSize?: number }) {
    return this.auth.listUsers(query);
  }

  /**
   * 重置某个用户的密码。
   *
   * 不带 password 就随机生成一个并在响应里返回 —— 那是唯一一次能看到它，
   * 库里存的是哈希。重置会让该用户在所有设备上掉线。
   */
  @Post(':id/reset-password')
  resetPassword(
    @CurrentUser() actor: AuthedUser,
    @Param('id') id: string,
    @Body() body: { password?: string },
  ) {
    return this.auth.adminResetPassword(actor, BigInt(id), body?.password);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: AuthedUser,
    @Param('id') id: string,
    @Body() dto: AdminUpdateUserDto,
  ) {
    return this.auth.adminUpdateUser(actor.id, BigInt(id), dto);
  }
}
