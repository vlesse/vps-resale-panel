import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const config = app.get(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // 前端和后端在生产环境同域（由 Caddy 分发），跨域只在本地开发时用得到
  app.enableCors({ origin: true, credentials: true });

  // Prisma 的主键是 BigInt，JSON 序列化会直接抛错。
  // 全局补一个 toJSON，比每个接口都手动转省事，也不会漏。
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };

  const port = Number(config.get('PORT') ?? 3000);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`面板后端已启动，监听 :${port}`);
}

void bootstrap();
