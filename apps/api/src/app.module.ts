import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { CaptchaModule } from './captcha/captcha.module';
import { PlansModule } from './plans/plans.module';
import { InventoryModule } from './inventory/inventory.module';
import { OrdersModule } from './orders/orders.module';
import { ServicesModule } from './services/services.module';
import { PayChannelsModule } from './paychannels/paychannels.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    CaptchaModule,
    PlansModule,
    InventoryModule,
    OrdersModule,
    ServicesModule,
    PayChannelsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
