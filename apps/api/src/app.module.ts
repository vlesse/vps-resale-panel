import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { ProvidersModule } from './providers/providers.module';
import { ProvisioningModule } from './provisioning/provisioning.module';
import { CaptchaModule } from './captcha/captcha.module';
import { AuthModule } from './auth/auth.module';
import { CloudAccountsModule } from './cloud-accounts/cloud-accounts.module';
import { PlansModule } from './plans/plans.module';
import { ServicesModule } from './services/services.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { JwtAuthGuard } from './auth/auth.decorators';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = new URL(config.get<string>('REDIS_URL') ?? 'redis://127.0.0.1:6379');
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            password: url.password || undefined,
            // BullMQ 要求这一项必须是 null，否则长时间阻塞的任务会被中断
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
    PrismaModule,
    ProvidersModule,
    CaptchaModule,
    AuthModule,
    CloudAccountsModule,
    PlansModule,
    ProvisioningModule,
    ServicesModule,
    OrdersModule,
    PaymentsModule,
  ],
  controllers: [HealthController],
  providers: [
    // 全局默认「所有接口都要登录」，公开接口靠 @Public() 显式开口子。
    // 反过来做的话（默认公开、逐个挂守卫），新加接口忘了挂就是一个裸奔的接口，
    // 而且没人会发现。这个方向上忘了标注只会导致接口打不开，看得见。
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
