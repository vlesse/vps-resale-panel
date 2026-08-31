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

    // 改密码之前签发的令牌一律作废。
    //
    // 反正这一行的用户已经查出来了，不多花一次查询。没有这一段的话，
    // 「重置密码」踢不掉任何人 —— 号被盗了、管理员帮着重置完，
    // 盗号的人手上那张令牌还能再用七天，那这个功能就是假的。
    //
    // iat 的精度是秒，所以给一秒的宽限，免得「改完密码马上签发的新令牌」
    // 因为落在同一秒里被自己判死。
    if (user.passwordChangedAt && payload.iat != null) {
      if (payload.iat * 1000 < user.passwordChangedAt.getTime() - 1000) {
        throw new UnauthorizedException('密码已修改，请重新登录');
      }
    }

    return { id: user.id, email: user.email, role: user.role };
  }
}
