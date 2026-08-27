import { Controller, Get } from '@nestjs/common';
import { CaptchaService } from './captcha.service';
import { Public } from '../auth/auth.decorators';

@Controller('api/captcha')
export class CaptchaController {
  constructor(private readonly captcha: CaptchaService) {}

  @Public()
  @Get()
  create() {
    return this.captcha.generate();
  }
}
