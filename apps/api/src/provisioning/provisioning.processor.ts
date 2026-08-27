import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { ProvisioningService } from './provisioning.service';

export const PROVISION_QUEUE = 'provision';

export interface ProvisionJobData {
  jobId: string;
}

/**
 * 队列 worker。
 *
 * 并发设成 3：建机大部分时间是在等云厂商和等 SSH，不吃 CPU，但也不能开太大 ——
 * 同时建太多机器容易撞上云厂商的 API 频率限制。
 *
 * 重试交给 BullMQ 做指数退避。ProvisioningService 内部在每次失败时都会
 * 先把半成品实例销毁掉，所以重试是从干净状态重新开始，不会越堆越多。
 */
@Injectable()
@Processor(PROVISION_QUEUE, { concurrency: 3 })
export class ProvisioningProcessor extends WorkerHost {
  private readonly logger = new Logger(ProvisioningProcessor.name);

  constructor(private readonly provisioning: ProvisioningService) {
    super();
  }

  async process(job: Job<ProvisionJobData>): Promise<void> {
    const jobId = BigInt(job.data.jobId);
    this.logger.log(`开始处理建机任务 ${jobId}（第 ${job.attemptsMade + 1} 次）`);
    await this.provisioning.runJob(jobId);
    this.logger.log(`建机任务 ${jobId} 完成`);
  }
}

/** 把数据库里的任务推进队列。业务代码只跟这个打交道，不直接碰 BullMQ。 */
@Injectable()
export class ProvisionQueueService {
  constructor(@InjectQueue(PROVISION_QUEUE) private readonly queue: Queue<ProvisionJobData>) {}

  async enqueue(jobId: bigint): Promise<void> {
    await this.queue.add(
      'run',
      { jobId: jobId.toString() },
      {
        // 用数据库里的任务 ID 作为队列 ID，天然去重：
        // 支付平台重发回调时不会产生第二个队列任务
        jobId: `provision-${jobId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 15000 },
        removeOnComplete: { age: 86400, count: 500 },
        removeOnFail: { age: 604800 },
      },
    );
  }
}
