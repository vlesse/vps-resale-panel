import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UserRole, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { generatePassword } from '../crypto/crypto.util';
import { CaptchaService } from '../captcha/captcha.service';
import { AuthedUser } from './auth.decorators';

const BCRYPT_ROUNDS = 12;

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  /** 签发时间（秒）。jwt 库自动带上，用来判断令牌是不是改密码之前签的。 */
  iat?: number;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly captcha: CaptchaService,
  ) {}

  /** 第一次启动时按 .env 建管理员账号，否则装好之后没人能登进后台 */
  async onModuleInit(): Promise<void> {
    const email = this.config.get<string>('BOOTSTRAP_ADMIN_EMAIL');
    const password = this.config.get<string>('BOOTSTRAP_ADMIN_PASSWORD');
    if (!email || !password) {
      this.logger.warn('没有配置 BOOTSTRAP_ADMIN_EMAIL / PASSWORD，跳过管理员初始化');
      return;
    }
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) {
      // 已经有了就不动它 —— 用户很可能已经改过密码了，重启不该把密码打回去
      if (exists.role !== UserRole.admin) {
        await this.prisma.user.update({ where: { id: exists.id }, data: { role: UserRole.admin } });
        this.logger.log(`已把 ${email} 提升为管理员`);
      }
      return;
    }
    await this.prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        displayName: '管理员',
        role: UserRole.admin,
      },
    });
    this.logger.log(`已创建管理员账号 ${email}，请登录后尽快修改密码`);
  }

  // ---------- 注册 / 登录 ----------

  async register(dto: {
    email: string;
    password: string;
    displayName?: string;
    captchaId: string;
    captchaCode: string;
  }, ip?: string) {
    this.captcha.verifyOrThrow(dto.captchaId, dto.captchaCode);

    const email = dto.email.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new BadRequestException('这个邮箱已经注册过了，直接登录或换一个邮箱');
    }
    if (dto.password.length < 8) {
      throw new BadRequestException('密码至少 8 位');
    }

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS),
        displayName: dto.displayName?.trim() || email.split('@')[0],
        lastLoginAt: new Date(),
        lastLoginIp: ip,
      },
    });
    return { token: this.sign(user), user: this.publicUser(user) };
  }

  async login(dto: { email: string; password: string; captchaId: string; captchaCode: string }, ip?: string) {
    this.captcha.verifyOrThrow(dto.captchaId, dto.captchaCode);

    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    // 无论是邮箱不存在还是密码错，都回同一句话 ——
    // 分开提示等于告诉攻击者「这个邮箱在这个站注册过」
    const ok = user && (await bcrypt.compare(dto.password, user.passwordHash));
    if (!ok) throw new UnauthorizedException('邮箱或密码不对');

    if (user.status === UserStatus.blocked) {
      throw new ForbiddenException('这个账号已被停用，请联系客服');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastLoginIp: ip },
    });
    return { token: this.sign(user), user: this.publicUser(user) };
  }

  // ---------- 资料 ----------

  async me(userId: bigint) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');
    return this.publicUser(user);
  }

  async updateProfile(userId: bigint, dto: { displayName?: string; phone?: string }) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.displayName !== undefined ? { displayName: dto.displayName.trim() || null } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone.trim() || null } : {}),
      },
    });
    return this.publicUser(user);
  }

  async changePassword(userId: bigint, dto: { oldPassword: string; newPassword: string }) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(dto.oldPassword, user.passwordHash))) {
      throw new BadRequestException('原密码不对');
    }
    if (dto.newPassword.length < 8) throw new BadRequestException('新密码至少 8 位');

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS),
        passwordChangedAt: new Date(),
      },
    });

    // 换一张新令牌给当前这台设备。
    // 不换的话，用户在自己的设备上改完密码，下一次点击就被自己踢出去了 ——
    // 别的设备该掉线（那正是改密码的目的），但手头这台不该。
    return { ok: true, message: '密码已修改，其它设备上的登录已失效', token: this.sign(updated) };
  }

  // ---------- 管理员 ----------

  async listUsers(query: { keyword?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const where = query.keyword
      ? {
          OR: [
            { email: { contains: query.keyword } },
            { displayName: { contains: query.keyword } },
          ],
        }
      : {};

    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { orders: true, services: true } } },
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      rows: rows.map((u) => ({
        ...this.publicUser(u),
        orderCount: u._count.orders,
        serviceCount: u._count.services,
      })),
    };
  }

  async adminUpdateUser(
    actorId: bigint,
    targetId: bigint,
    dto: {
      displayName?: string;
      phone?: string;
      role?: UserRole;
      status?: UserStatus;
      newPassword?: string;
      maxActiveServices?: number;
    },
  ) {
    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) throw new NotFoundException('用户不存在');

    // 不许把自己降级或停用 —— 否则一不小心就没人能进后台了
    if (targetId === actorId && (dto.role === UserRole.customer || dto.status === UserStatus.blocked)) {
      throw new BadRequestException('不能把自己降级或停用');
    }

    // 也不许把最后一个管理员降级
    if (target.role === UserRole.admin && dto.role === UserRole.customer) {
      const admins = await this.prisma.user.count({
        where: { role: UserRole.admin, status: UserStatus.active },
      });
      if (admins <= 1) throw new BadRequestException('这是最后一个管理员，不能降级');
    }

    const user = await this.prisma.user.update({
      where: { id: targetId },
      data: {
        ...(dto.displayName !== undefined ? { displayName: dto.displayName || null } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone || null } : {}),
        ...(dto.role ? { role: dto.role } : {}),
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.maxActiveServices !== undefined
          ? { maxActiveServices: Math.max(0, Number(dto.maxActiveServices) || 0) }
          : {}),
        ...(dto.newPassword
          ? {
              passwordHash: await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS),
              passwordChangedAt: new Date(),
            }
          : {}),
      },
    });
    return this.publicUser(user);
  }

  /**
   * 管理员帮用户重置密码。
   *
   * 不传新密码就生成一个 —— 而且**只在这一次响应里返回**，
   * 之后任何接口都读不出来（库里只有 bcrypt 哈希）。管理员要把它
   * 转给用户，所以生成用的是那套剔除了 O/0/l/1/I 的字符集：
   * 这串字是要被人手抄或口述的。
   *
   * 重置会让这个用户在**所有设备**上掉线，包括正在用的那台。
   * 这正是重置密码该有的效果 —— 号被盗了，重置完盗号的人就该进不来。
   */
  async adminResetPassword(
    actor: AuthedUser,
    targetId: bigint,
    password?: string,
  ): Promise<{ ok: boolean; password: string; email: string; message: string }> {
    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) throw new NotFoundException('用户不存在');

    const pw = password?.trim() || generatePassword(14);
    if (pw.length < 8 || pw.length > 72) {
      throw new BadRequestException('密码要 8 到 72 位');
    }

    await this.prisma.user.update({
      where: { id: targetId },
      data: {
        passwordHash: await bcrypt.hash(pw, BCRYPT_ROUNDS),
        passwordChangedAt: new Date(),
      },
    });

    // 谁给谁重置的必须留痕。这是能直接接管一个账号的操作。
    this.logger.warn(`管理员 ${actor.email} 重置了 ${target.email} 的密码`);
    await this.prisma.operationLog
      .create({
        data: {
          actorType: 'admin',
          actorId: actor.id,
          action: 'reset_password',
          targetType: 'user',
          targetId: targetId,
          metaJson: { targetEmail: target.email },
        },
      })
      .catch(() => undefined); // 记不上日志不该让重置本身失败

    return {
      ok: true,
      password: pw,
      email: target.email,
      message: `已重置。这串密码只显示这一次，现在就复制给 ${target.email}。`,
    };
  }

  // ---------- 内部 ----------

  private sign(user: { id: bigint; email: string; role: UserRole }): string {
    const payload: JwtPayload = {
      sub: user.id.toString(),
      email: user.email,
      role: user.role,
    };
    return this.jwt.sign(payload);
  }

  /** 返回给前端的用户形状。passwordHash 绝不能出现在这里。 */
  private publicUser(u: {
    id: bigint;
    email: string;
    displayName: string | null;
    phone: string | null;
    role: UserRole;
    status: UserStatus;
    maxActiveServices: number;
    balanceCents?: number;
    lastLoginAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: u.id.toString(),
      email: u.email,
      displayName: u.displayName,
      phone: u.phone,
      role: u.role,
      status: u.status,
      maxActiveServices: u.maxActiveServices,
      balanceCents: u.balanceCents ?? 0,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
    };
  }
}
