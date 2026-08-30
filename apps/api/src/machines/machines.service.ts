import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MachineStatus, Prisma, ProviderKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { SshProvider } from '../providers/drivers/ssh.provider';
import { encryptJson, generateCode } from '../crypto/crypto.util';

/**
 * 机器管理（后台）。
 *
 * 两类机器都在这张表里：
 *   库存池的机器  管理员手工录入，走 sourcing → optimizing → ready 上架
 *   按需建的机器  建机任务自动写入，管理员只查看不录入
 *
 * 状态流转是有向的，后台按钮要按当前状态显示可用的下一步，
 * 而不是把所有状态都摆出来让人乱点。
 */

/** 每个状态允许流转到哪些状态。乱改状态会让机器和订单对不上。 */
const ALLOWED_TRANSITIONS: Record<MachineStatus, MachineStatus[]> = {
  sourcing: ['optimizing', 'error'],
  optimizing: ['ready', 'sourcing', 'error'],
  ready: ['optimizing', 'suspended'],
  reserved: ['ready', 'error'], // 订单没付款时放回池子
  provisioning: ['error'],
  running: ['stopped', 'suspended', 'error'],
  stopped: ['running', 'suspended', 'error'],
  rebuilding: ['running', 'error'],
  suspended: ['optimizing', 'releasing', 'running'],
  releasing: ['released', 'error'],
  released: [],
  error: ['optimizing', 'releasing', 'ready'],
};

const STATUS_LABEL: Record<MachineStatus, string> = {
  sourcing: '采购中',
  optimizing: '优化中',
  ready: '待售',
  reserved: '已锁定',
  provisioning: '开通中',
  running: '运行中',
  stopped: '已关机',
  rebuilding: '重装中',
  suspended: '已停用',
  releasing: '销毁中',
  released: '已销毁',
  error: '出错',
};

@Injectable()
export class MachinesService {
  private readonly logger = new Logger(MachinesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProviderRegistry,
    private readonly ssh: SshProvider,
    private readonly config: ConfigService,
  ) {}

  private secret(): string {
    const s = this.config.get<string>('CREDENTIALS_SECRET');
    if (!s) throw new Error('.env 里没有配 CREDENTIALS_SECRET');
    return s;
  }

  async list(query: {
    status?: MachineStatus;
    provider?: ProviderKind;
    keyword?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 30));
    const where: Prisma.MachineWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.keyword
        ? { OR: [{ code: { contains: query.keyword } }, { ip: { contains: query.keyword } }] }
        : {}),
    };

    const [total, rows, byStatus] = await Promise.all([
      this.prisma.machine.count({ where }),
      this.prisma.machine.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          plan: { select: { id: true, name: true } },
          cloudAccount: { select: { id: true, name: true } },
          service: { select: { id: true, serviceNo: true, userId: true } },
        },
      }),
      this.prisma.machine.groupBy({ by: ['status'], _count: true }),
    ]);

    return {
      total,
      page,
      pageSize,
      // 后台顶部那排状态计数
      summary: byStatus.map((s) => ({
        status: s.status,
        label: STATUS_LABEL[s.status],
        count: s._count,
      })),
      rows: rows.map((m) => ({
        id: m.id.toString(),
        code: m.code,
        provider: m.provider,
        status: m.status,
        statusLabel: STATUS_LABEL[m.status],
        // 前端按这个渲染可点的按钮，不用自己维护一份状态机
        nextStatuses: ALLOWED_TRANSITIONS[m.status].map((s) => ({ value: s, label: STATUS_LABEL[s] })),
        ip: m.ip,
        sshPort: m.sshPort,
        region: m.region,
        cpu: m.cpu,
        memoryMb: m.memoryMb,
        diskGb: m.diskGb,
        osTemplate: m.osTemplate,
        optimizeTags: m.optimizeTagsJson ?? [],
        plan: m.plan ? { id: m.plan.id.toString(), name: m.plan.name } : null,
        cloudAccount: m.cloudAccount
          ? { id: m.cloudAccount.id.toString(), name: m.cloudAccount.name }
          : null,
        service: m.service
          ? { id: m.service.id.toString(), serviceNo: m.service.serviceNo }
          : null,
        costCents: m.costCents,
        costCurrency: m.costCurrency,
        upstreamExpireAt: m.upstreamExpireAt,
        lastCheckedAt: m.lastCheckedAt,
        lastError: m.lastError,
        hasCredentials: !!m.authPayloadEncrypted,
        createdAt: m.createdAt,
      })),
    };
  }

  /**
   * 疑似残留实例。
   *
   * 这些机器在上游有标识（说明我们确实发过创建指令），但销毁从来没有确认成功。
   * 换句话说：**它们可能正在你的云账号上按小时烧钱，而面板已经把它们当废弃了。**
   * 这个列表应该定期看，尤其在一批建机失败之后。
   *
   * Proxmox 也算在内：自建节点虽然不按小时收钱，但残留的虚拟机一样占着
   * 你的内存和磁盘，而且因为不在告警里，后台根本看不见 —— 只会越攒越多。
   */
  async suspectedOrphans() {
    const rows = await this.prisma.machine.findMany({
      where: {
        provider: { in: [ProviderKind.gcp, ProviderKind.lightsail, ProviderKind.proxmox] },
        providerRefJson: { not: Prisma.DbNull },
        releasedAt: null,
        status: { in: [MachineStatus.error, MachineStatus.releasing] },
      },
      orderBy: { id: 'desc' },
      include: { cloudAccount: { select: { name: true } } },
    });

    return {
      count: rows.length,
      hint:
        rows.length > 0
          ? '这些机器的销毁没有确认成功，可能仍在云厂商那边计费。请逐个到云控制台核对，' +
            '确认已经不存在的可以点「标记已清理」。'
          : '没有发现疑似残留的实例',
      rows: rows.map((m) => ({
        id: m.id.toString(),
        code: m.code,
        provider: m.provider,
        cloudAccount: m.cloudAccount?.name,
        // 拿这个去云控制台里搜就能找到
        providerRef: m.providerRefJson,
        lastError: m.lastError,
        createdAt: m.createdAt,
      })),
    };
  }

  /** 人工到云控制台确认过确实没有了，把它标掉，从告警列表里消失 */
  async markCleaned(id: bigint, note?: string) {
    const m = await this.prisma.machine.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('机器不存在');
    await this.prisma.machine.update({
      where: { id },
      data: {
        status: MachineStatus.released,
        releasedAt: new Date(),
        authPayloadEncrypted: null,
        notes: [m.notes, `人工确认已清理${note ? '：' + note : ''}`].filter(Boolean).join('\n'),
      },
    });
    return { ok: true, message: '已标记为已清理' };
  }

  /** 再试一次销毁。云厂商临时抽风导致回滚失败时用。 */
  async retryRelease(id: bigint) {
    const m = await this.prisma.machine.findUnique({
      where: { id },
      include: { cloudAccount: true, natBinding: { select: { sshPort: true, gateway: { select: { publicHost: true } } } } },
    });
    if (!m) throw new NotFoundException('机器不存在');
    if (!m.providerRefJson) throw new BadRequestException('这台机器没有云端标识，无法销毁');

    const driver = this.registry.get(m.provider);
    const ctx = this.registry.contextFor(m, m.cloudAccount);
    try {
      await driver.release(ctx);
      await this.prisma.machine.update({
        where: { id },
        data: { status: MachineStatus.released, releasedAt: new Date(), authPayloadEncrypted: null },
      });
      return { ok: true, message: '销毁成功' };
    } catch (err: any) {
      await this.prisma.machine.update({
        where: { id },
        data: { lastError: String(err.message).slice(0, 500) },
      });
      throw new BadRequestException(`销毁失败：${err.message}`);
    }
  }

  // ---------- 库存录入 ----------

  /**
   * 手工录一台自有机器进库存池。
   * 录完是 sourcing 状态，要走完优化流程推到 ready 才能卖。
   */
  async create(dto: {
    provider: ProviderKind;
    ip: string;
    sshPort?: number;
    sshUser?: string;
    password?: string;
    privateKey?: string;
    region: string;
    cpu: number;
    memoryMb: number;
    diskGb: number;
    osTemplate?: string;
    planId?: string;
    cloudAccountId?: string;
    optimizeTags?: string[];
    costCents?: number;
    upstreamExpireAt?: string;
    notes?: string;
  }) {
    if (dto.provider === ProviderKind.gcp || dto.provider === ProviderKind.lightsail) {
      throw new BadRequestException(
        '谷歌云和 Lightsail 的机器由系统在用户下单时自动创建，不需要手工录入。' +
          '手工录的机器请选「自有机器（SSH）」或「Proxmox」。',
      );
    }
    if (!dto.password && !dto.privateKey) {
      throw new BadRequestException('要么填密码，要么填私钥，面板得能登进去才管得了这台机器');
    }

    const dup = await this.prisma.machine.findFirst({
      where: { ip: dto.ip, status: { notIn: [MachineStatus.released] } },
    });
    if (dup) {
      throw new BadRequestException(`IP ${dto.ip} 已经录过了（编号 ${dup.code}），不要重复录入`);
    }

    const auth = {
      sshUser: dto.sshUser || 'root',
      sshPort: dto.sshPort || 22,
      password: dto.password,
      privateKey: dto.privateKey,
    };

    const machine = await this.prisma.machine.create({
      data: {
        code: generateCode('M'),
        provider: dto.provider,
        ip: dto.ip.trim(),
        sshPort: auth.sshPort,
        region: dto.region.trim(),
        cpu: dto.cpu,
        memoryMb: dto.memoryMb,
        diskGb: dto.diskGb,
        osTemplate: dto.osTemplate,
        planId: dto.planId ? BigInt(dto.planId) : null,
        cloudAccountId: dto.cloudAccountId ? BigInt(dto.cloudAccountId) : null,
        optimizeTagsJson: (dto.optimizeTags ?? []) as Prisma.InputJsonValue,
        costCents: dto.costCents,
        upstreamExpireAt: dto.upstreamExpireAt ? new Date(dto.upstreamExpireAt) : null,
        notes: dto.notes,
        authPayloadEncrypted: encryptJson(this.secret(), auth),
        status: MachineStatus.sourcing,
      },
    });

    // 录完立刻测一次，当场知道凭据填对没有
    const check = await this.testConnection(machine.id);
    return { id: machine.id.toString(), code: machine.code, check };
  }

  async testConnection(id: bigint) {
    const m = await this.prisma.machine.findUnique({
      where: { id },
      include: { cloudAccount: true, natBinding: { select: { sshPort: true, gateway: { select: { publicHost: true } } } } },
    });
    if (!m) throw new NotFoundException('机器不存在');

    const ctx = this.registry.contextFor(m, m.cloudAccount);
    let result: { ok: boolean; message: string; detail?: Record<string, any> };

    if (m.provider === ProviderKind.ssh) {
      result = await this.ssh.testMachine(ctx);
    } else {
      try {
        const snapshot = await this.registry.get(m.provider).getStatus(ctx);
        result = {
          ok: true,
          message: '连接成功',
          detail: {
            电源: snapshot.power,
            CPU: snapshot.cpuPercent != null ? snapshot.cpuPercent + '%' : '未知',
            内存: snapshot.memTotalMb ? `${snapshot.memUsedMb}/${snapshot.memTotalMb} MB` : '未知',
          },
        };
      } catch (err: any) {
        result = { ok: false, message: err.message };
      }
    }

    await this.prisma.machine.update({
      where: { id },
      data: {
        lastCheckedAt: new Date(),
        lastError: result.ok ? null : result.message.slice(0, 500),
      },
    });
    return result;
  }

  /** 状态流转。只允许合法的下一步，乱改会让机器和订单对不上。 */
  async changeStatus(id: bigint, next: MachineStatus) {
    const m = await this.prisma.machine.findUnique({ where: { id }, include: { service: true } });
    if (!m) throw new NotFoundException('机器不存在');

    const allowed = ALLOWED_TRANSITIONS[m.status];
    if (!allowed.includes(next)) {
      throw new BadRequestException(
        `不能从「${STATUS_LABEL[m.status]}」直接改成「${STATUS_LABEL[next]}」。` +
          `当前允许的下一步：${allowed.map((s) => STATUS_LABEL[s]).join('、') || '（无，这是终态）'}`,
      );
    }
    const backToPool: MachineStatus[] = [MachineStatus.ready, MachineStatus.optimizing];
    if (m.service && backToPool.includes(next)) {
      throw new BadRequestException(
        `这台机器还绑着服务 ${m.service.serviceNo}，不能改回待售。请先把那个服务销毁。`,
      );
    }

    await this.prisma.machine.update({
      where: { id },
      data: { status: next, version: { increment: 1 }, ...(next === MachineStatus.ready ? { lastError: null } : {}) },
    });
    return { ok: true, message: `已改为「${STATUS_LABEL[next]}」` };
  }

  async update(
    id: bigint,
    dto: {
      region?: string;
      cpu?: number;
      memoryMb?: number;
      diskGb?: number;
      osTemplate?: string;
      planId?: string | null;
      optimizeTags?: string[];
      costCents?: number;
      upstreamExpireAt?: string | null;
      notes?: string;
      sshUser?: string;
      sshPort?: number;
      password?: string;
      privateKey?: string;
    },
  ) {
    const m = await this.prisma.machine.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('机器不存在');

    // 改凭据要把原来的读出来合并，否则只填密码会把私钥冲掉
    let authBlob: string | undefined;
    if (dto.password || dto.privateKey || dto.sshUser || dto.sshPort) {
      const current = this.registry.decryptAuth(m) ?? { sshUser: 'root', sshPort: 22 };
      authBlob = encryptJson(this.secret(), {
        sshUser: dto.sshUser ?? current.sshUser,
        sshPort: dto.sshPort ?? current.sshPort,
        password: dto.password ?? current.password,
        privateKey: dto.privateKey ?? current.privateKey,
      });
    }

    await this.prisma.machine.update({
      where: { id },
      data: {
        ...(dto.region !== undefined ? { region: dto.region } : {}),
        ...(dto.cpu !== undefined ? { cpu: dto.cpu } : {}),
        ...(dto.memoryMb !== undefined ? { memoryMb: dto.memoryMb } : {}),
        ...(dto.diskGb !== undefined ? { diskGb: dto.diskGb } : {}),
        ...(dto.osTemplate !== undefined ? { osTemplate: dto.osTemplate } : {}),
        ...(dto.planId !== undefined ? { planId: dto.planId ? BigInt(dto.planId) : null } : {}),
        ...(dto.optimizeTags !== undefined
          ? { optimizeTagsJson: dto.optimizeTags as Prisma.InputJsonValue }
          : {}),
        ...(dto.costCents !== undefined ? { costCents: dto.costCents } : {}),
        ...(dto.upstreamExpireAt !== undefined
          ? { upstreamExpireAt: dto.upstreamExpireAt ? new Date(dto.upstreamExpireAt) : null }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.sshPort !== undefined ? { sshPort: dto.sshPort } : {}),
        ...(authBlob ? { authPayloadEncrypted: authBlob } : {}),
      },
    });
    return { ok: true };
  }

  async remove(id: bigint) {
    const m = await this.prisma.machine.findUnique({ where: { id }, include: { service: true } });
    if (!m) throw new NotFoundException('机器不存在');
    if (m.service) {
      throw new BadRequestException(
        `这台机器还绑着服务 ${m.service.serviceNo}，删不得。请先销毁那个服务。`,
      );
    }
    if (m.providerRefJson && !m.releasedAt) {
      throw new BadRequestException(
        '这台机器在云上可能还存在（销毁未确认）。直接删掉记录的话它会一直计费而没人知道。' +
          '请先点「重试销毁」或到云控制台确认删除后点「标记已清理」。',
      );
    }
    await this.prisma.machine.delete({ where: { id } });
    return { ok: true, message: '已删除' };
  }
}
