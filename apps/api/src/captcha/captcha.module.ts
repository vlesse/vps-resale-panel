import { Global, Module } from '@nestjs/common';
import { CaptchaService } from './captcha.service';
import { CaptchaController } from './captcha.controller';

@Global()
@Module({
  providers: [CaptchaService],
  controllers: [CaptchaController],
  exports: [CaptchaService],
})
export class CaptchaModule {}
