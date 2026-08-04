import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  AdminUpdateUserDto,
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  UpdateProfileDto,
} from './dto';
import { AdminGuard, CurrentUser, JwtAuthGuard } from './auth.decorators';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Browser GET helper: login is POST-only JSON API */
  @Get('login')
  loginHelp() {
    return {
      ok: true,
      message:
        'This is an API endpoint. Use POST /api/auth/login with JSON {email,password,captchaId,captchaCode}, or open /login.html',
      method: 'POST',
      path: '/api/auth/login',
      webLogin: '/login.html',
      webAdmin: '/admin.html',
    };
  }

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: { userId: string }) {
    return this.auth.me(user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('profile')
  updateProfile(
    @CurrentUser() user: { userId: string },
    @Body() dto: UpdateProfileDto,
  ) {
    return this.auth.updateProfile(user.userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  changePassword(
    @CurrentUser() user: { userId: string },
    @Body() dto: ChangePasswordDto,
  ) {
    return this.auth.changePassword(user.userId, dto);
  }

  // ---- Admin: user management ----

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('users')
  adminListUsers() {
    return this.auth.adminListUsers();
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Patch('users/:id')
  adminUpdateUser(
    @Param('id') id: string,
    @Body() dto: AdminUpdateUserDto,
  ) {
    return this.auth.adminUpdateUser(id, dto);
  }
}
