import {
  BadRequestException,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UserRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CaptchaService } from '../captcha/captcha.service';
import {
  AdminUpdateUserDto,
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  UpdateProfileDto,
} from './dto';
import { serialize } from '../common/utils';

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly captcha: CaptchaService,
  ) {}

  async onModuleInit() {
    const email = this.config.get<string>('BOOTSTRAP_ADMIN_EMAIL');
    const password = this.config.get<string>('BOOTSTRAP_ADMIN_PASSWORD');
    if (!email || !password) return;
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) return;
    const passwordHash = await bcrypt.hash(password, 10);
    await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: 'Admin',
        role: UserRole.admin,
        status: UserStatus.active,
      },
    });
  }

  async register(dto: RegisterDto) {
    if (!this.captcha.verify(dto.captchaId, dto.captchaCode)) {
      throw new BadRequestException({ code: 'INVALID_CAPTCHA', message: '验证码错误或已过期' });
    }
    const exists = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (exists) throw new BadRequestException('Email already registered');
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        passwordHash,
        displayName: dto.displayName,
        role: UserRole.customer,
      },
    });
    return this.tokenResponse(user.id, user.email, user.role);
  }

  async login(dto: LoginDto) {
    if (!this.captcha.verify(dto.captchaId, dto.captchaCode)) {
      throw new BadRequestException({ code: 'INVALID_CAPTCHA', message: '验证码错误或已过期' });
    }
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (!user) throw new UnauthorizedException('Invalid credentials');
    if (user.status !== UserStatus.active) {
      throw new UnauthorizedException('Account blocked');
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    return this.tokenResponse(user.id, user.email, user.role);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(userId) },
      select: {
        id: true,
        email: true,
        displayName: true,
        phone: true,
        avatarUrl: true,
        role: true,
        status: true,
        emailVerifiedAt: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    if (!user) throw new UnauthorizedException('User not found');
    return serialize(user);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const data: Record<string, unknown> = {};
    if (dto.displayName !== undefined) data.displayName = dto.displayName || null;
    if (dto.phone !== undefined) data.phone = dto.phone || null;
    if (dto.avatarUrl !== undefined) data.avatarUrl = dto.avatarUrl || null;
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Nothing to update');
    }
    const user = await this.prisma.user.update({
      where: { id: BigInt(userId) },
      data,
      select: {
        id: true,
        email: true,
        displayName: true,
        phone: true,
        avatarUrl: true,
        role: true,
        status: true,
        emailVerifiedAt: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    return serialize(user);
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(userId) },
      select: { id: true, passwordHash: true },
    });
    if (!user) throw new UnauthorizedException('User not found');
    const ok = await bcrypt.compare(dto.oldPassword, user.passwordHash);
    if (!ok) throw new BadRequestException('旧密码不正确');
    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });
    return { ok: true };
  }

  // ---- Admin: user management ----

  async adminListUsers() {
    const rows = await this.prisma.user.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        email: true,
        displayName: true,
        phone: true,
        role: true,
        status: true,
        emailVerifiedAt: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    return serialize(rows);
  }

  async adminUpdateUser(id: string, dto: AdminUpdateUserDto) {
    const uid = BigInt(id);
    const exists = await this.prisma.user.findUnique({ where: { id: uid } });
    if (!exists) throw new BadRequestException('User not found');
    const data: Record<string, unknown> = {};
    if (dto.email !== undefined) {
      const email = String(dto.email).toLowerCase().trim();
      if (!email) throw new BadRequestException('email cannot be empty');
      const dup = await this.prisma.user.findUnique({ where: { email } });
      if (dup && dup.id !== uid) throw new BadRequestException('Email already in use');
      data.email = email;
    }
    if (dto.displayName !== undefined) data.displayName = dto.displayName || null;
    if (dto.phone !== undefined) data.phone = dto.phone || null;
    if (dto.role !== undefined) {
      data.role = String(dto.role).toLowerCase() === 'admin' ? UserRole.admin : UserRole.customer;
    }
    if (dto.status !== undefined) {
      data.status = String(dto.status).toLowerCase() === 'blocked' ? UserStatus.blocked : UserStatus.active;
    }
    if (dto.newPassword !== undefined && dto.newPassword) {
      if (String(dto.newPassword).length < 8) {
        throw new BadRequestException('Password must be at least 8 chars');
      }
      data.passwordHash = await bcrypt.hash(dto.newPassword, 10);
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Nothing to update');
    }
    const user = await this.prisma.user.update({
      where: { id: uid },
      data,
      select: {
        id: true,
        email: true,
        displayName: true,
        phone: true,
        role: true,
        status: true,
        emailVerifiedAt: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    return serialize(user);
  }

  private tokenResponse(id: bigint, email: string, role: UserRole) {
    const accessToken = this.jwt.sign({
      sub: id.toString(),
      email,
      role,
    });
    return {
      accessToken,
      user: serialize({ id, email, role }),
    };
  }
}
