import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('api')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 容器编排和反向代理都靠它判断服务活没活着。
   * 必须真的查一下数据库 —— 进程还在但连不上库的话，这个服务其实是废的。
   */
  @Get('health')
  async health() {
    const started = Date.now();
    let db = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (err: any) {
      db = `fail: ${err.message}`;
    }
    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      database: db,
      latencyMs: Date.now() - started,
      time: new Date().toISOString(),
    };
  }
}
