import { Controller, Get } from '@nestjs/common';
import { CaptchaService } from './captcha.service';

@Controller('api/auth')
export class CaptchaController {
  constructor(private readonly captcha: CaptchaService) {}

  /** Public: issue a graphical captcha (SVG). One-shot, 5-min TTL. */
  @Get('captcha')
  issue() {
    const { id, svg } = this.captcha.issue();
    return { id, svg };
  }
}
