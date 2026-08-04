import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({ origin: true, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // Static storefront / admin pages
  app.useStaticAssets(join(__dirname, '..', 'public'), {
    index: ['index.html'],
  });

  // Jeepay notify may need raw text response
  app.use('/api/payments/jeepay/notify', (req: any, res: any, next: any) => {
    const oldJson = res.json.bind(res);
    res.json = (body: any) => {
      if (typeof body === 'string') {
        res.type('text/plain').send(body);
        return res;
      }
      return oldJson(body);
    };
    next();
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`VPS Resale API listening on :${port}`);
}
bootstrap();
