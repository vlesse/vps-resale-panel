import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from './auth.service';
import { AuthedUser } from './auth.decorators';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') ?? 'missing-jwt-secret',
    });
  }

  /**
   * 每次请求都回数据库查一次用户。
   * 不这么做的话，把用户停用之后他手上那张令牌还能继续用到过期为止。
   */
  async validate(payload: JwtPayload): Promise<AuthedUser> {
    const user = await this.prisma.user.findUnique({ where: { id: BigInt(payload.sub) } });
    if (!user) throw new UnauthorizedException('账号不存在');
    if (user.status === UserStatus.blocked) throw new UnauthorizedException('账号已被停用');
    return { id: user.id, email: user.email, role: user.role };
  }
}
