import { BadRequestException, Injectable } from '@nestjs/common';
import * as svgCaptcha from 'svg-captcha';
import { randomUUID } from 'crypto';

interface Entry {
  code: string;
  expireAt: number;
}

/**
 * 图形验证码。挡的是「拿脚本批量注册账号刷单」——
 * 而每一单都可能在你的云账号上建出一台真的在计费的机器，所以这道门不能省。
 *
 * 存在内存里而不是 Redis：验证码只活 5 分钟，重启丢了用户刷新一下就有新的，
 * 没必要为它引入额外的状态存储。要横向扩多个后端实例时再换 Redis。
 */
@Injectable()
export class CaptchaService {
  private readonly store = new Map<string, Entry>();
  private readonly ttlMs = 5 * 60 * 1000;

  constructor() {
    // 定期清理过期条目，否则被刷一波之后内存里全是垃圾
    const timer = setInterval(() => this.sweep(), 60_000);
    timer.unref?.();
  }

  generate(): { id: string; svg: string } {
    const c = svgCaptcha.create({
      size: 4,
      noise: 2,
      color: true,
      background: '#1a1d21',
      width: 120,
      height: 44,
      // 去掉容易看错的字符，用户看错了会以为是系统坏了
      ignoreChars: '0oO1ilI',
    });
    const id = randomUUID();
    this.store.set(id, { code: c.text.toLowerCase(), expireAt: Date.now() + this.ttlMs });
    return { id, svg: c.data };
  }

  /** 验证码是一次性的：验过就删，无论对错 —— 否则可以拿一个正确的码无限重放 */
  verifyOrThrow(id: string, code: string): void {
    if (!id || !code) throw new BadRequestException('请填写验证码');
    const entry = this.store.get(id);
    this.store.delete(id);

    if (!entry) throw new BadRequestException('验证码已失效，请点图片换一张');
    if (Date.now() > entry.expireAt) throw new BadRequestException('验证码超时了，请点图片换一张');
    if (entry.code !== code.trim().toLowerCase()) throw new BadRequestException('验证码不对');
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, e] of this.store) {
      if (e.expireAt < now) this.store.delete(id);
    }
  }
}
