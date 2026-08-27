import { INestApplication, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    // 容器编排下数据库可能比后端晚几秒就绪，这里重试而不是直接崩
    for (let i = 1; i <= 10; i++) {
      try {
        await this.$connect();
        this.logger.log('数据库已连接');
        return;
      } catch (err: any) {
        this.logger.warn(`连接数据库失败（第 ${i}/10 次）：${err.message}`);
        if (i === 10) throw err;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  async enableShutdownHooks(app: INestApplication) {
    process.on('beforeExit', () => void app.close());
  }
}
