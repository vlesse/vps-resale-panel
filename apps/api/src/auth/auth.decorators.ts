import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { Observable } from 'rxjs';

export const IS_PUBLIC = 'isPublic';

/**
 * 标了这个的接口不需要登录。
 *
 * 采用「默认全部要登录，例外显式标注」而不是反过来 ——
 * 反过来的话，新加一个接口忘了加守卫，就是一个裸奔的接口。
 * 这个方向上忘记标注只会导致接口打不开，看得见，不会静默漏数据。
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}

/** 管理员专用。挂在 controller 上就整个 controller 都受保护。 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user;
    if (user?.role !== UserRole.admin) {
      throw new ForbiddenException('需要管理员权限');
    }
    return true;
  }
}

export interface AuthedUser {
  id: bigint;
  email: string;
  role: UserRole;
}

/** 控制器里用 @CurrentUser() user: AuthedUser 直接拿到当前登录的人 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthedUser | undefined, ctx: ExecutionContext) => {
    const user = ctx.switchToHttp().getRequest().user as AuthedUser;
    return data ? user?.[data] : user;
  },
);

/** 取真实客户端 IP。经过 Caddy 反代后 remoteAddress 是容器内网地址，没有意义。 */
export const ClientIp = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest();
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.ip || req.socket?.remoteAddress || undefined;
});
