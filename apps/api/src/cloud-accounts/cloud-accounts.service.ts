import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { encryptJson, tryDecryptJson } from '../crypto/crypto.util';

/**
 * 云账号管理。
 *
 * 这是运营方把自己的谷歌云 / AWS / PVE 凭据交给面板的地方。凭据落库前一律
 * AES-256-GCM 加密，任何接口都不会把它再吐回前端 —— 后台页面上只显示
 * 「已配置」和一个脱敏摘要，想换就整份重填。
 *
 * 支持一家云挂多个账号：不同项目的配额是分开的，配额撑爆时可以再挂一个顶上。
 */
@Injectable()
export class CloudAccountsService {
  private readonly logger = new Logger(CloudAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProviderRegistry,
    private readonly config: ConfigService,
  ) {}

  private secret(): string {
    const s = this.config.get<string>('CREDENTIALS_SECRET');
    if (!s) throw new Error('.env 里没有配 CREDENTIALS_SECRET');
    return s;
  }

  async list() {
    const rows = await this.prisma.cloudAccount.findMany({
      orderBy: { id: 'desc' },
      include: { _count: { select: { plans: true, machines: true } } },
    });

    // 当日已建机数，后台直接显示「今天用了几个配额」
    const since = new Date();
    since.setHours(0, 0, 0, 0);

    return Promise.all(
      rows.map(async (a) => ({
        id: a.id.toString(),
        name: a.name,
        provider: a.provider,
        defaultRegion: a.defaultRegion,
        dailyCreateQuota: a.dailyCreateQuota,
        todayCreated: await this.prisma.machine.count({
          where: { cloudAccountId: a.id, createdAt: { gte: since } },
        }),
        isEnabled: a.isEnabled,
        lastCheckedAt: a.lastCheckedAt,
        lastCheckError: a.lastCheckError,
        planCount: a._count.plans,
        machineCount: a._count.machines,
        notes: a.notes,
        createdAt: a.createdAt,
        // 只回摘要，永远不回原文
        credentialSummary: this.summarize(a.provider, a.credentialsEncrypted),
      })),
    );
  }

  async create(dto: {
    name: string;
    provider: ProviderKind;
    credentials: Record<string, any>;
    defaultRegion?: string;
    dailyCreateQuota?: number;
    notes?: string;
  }) {
    const credentials = this.normalize(dto.provider, dto.credentials);

    const account = await this.prisma.cloudAccount.create({
      data: {
        name: dto.name.trim(),
        provider: dto.provider,
        credentialsEncrypted: encryptJson(this.secret(), credentials),
        defaultRegion: dto.defaultRegion?.trim() || null,
        dailyCreateQuota: dto.dailyCreateQuota ?? 20,
        notes: dto.notes?.trim() || null,
      },
    });

    // 建完立刻测一次连接。让人在录入的当下就知道填对没有，
    // 而不是等到第一个用户下单建机失败才发现。
    const check = await this.verify(account.id);
    return { id: account.id.toString(), name: account.name, check };
  }

  async update(
    id: bigint,
    dto: {
      name?: string;
      credentials?: Record<string, any>;
      defaultRegion?: string;
      dailyCreateQuota?: number;
      isEnabled?: boolean;
      notes?: string;
    },
  ) {
    const account = await this.prisma.cloudAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException('云账号不存在');

    await this.prisma.cloudAccount.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.credentials
          ? {
              credentialsEncrypted: encryptJson(
                this.secret(),
                this.normalize(account.provider, dto.credentials),
              ),
            }
          : {}),
        ...(dto.defaultRegion !== undefined ? { defaultRegion: dto.defaultRegion || null } : {}),
        ...(dto.dailyCreateQuota !== undefined
          ? { dailyCreateQuota: Math.max(0, Number(dto.dailyCreateQuota) || 0) }
          : {}),
        ...(dto.isEnabled !== undefined ? { isEnabled: dto.isEnabled } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
      },
    });

    // 换过凭据就重新测一次
    return dto.credentials ? { check: await this.verify(id) } : { ok: true };
  }

  async remove(id: bigint) {
    const [planCount, liveMachines] = await Promise.all([
      this.prisma.plan.count({ where: { cloudAccountId: id } }),
      this.prisma.machine.count({
        where: {
          cloudAccountId: id,
          status: { in: ['provisioning', 'running', 'stopped', 'rebuilding', 'suspended'] },
        },
      }),
    ]);

    // 删掉账号等于丢掉凭据，那些机器就再也管不了了 —— 必须拦住
    if (liveMachines > 0) {
      throw new BadRequestException(
        `这个账号下还有 ${liveMachines} 台在运行的机器。删掉凭据之后这些机器就再也控制不了了（云厂商那边还在计费）。` +
          '请先把它们销毁或迁走。',
      );
    }
    if (planCount > 0) {
      throw new BadRequestException(
        `还有 ${planCount} 个套餐在用这个账号，请先改掉这些套餐的账号绑定`,
      );
    }

    await this.prisma.cloudAccount.delete({ where: { id } });
    return { ok: true };
  }

  /** 后台点「测试连接」。真的去调一次云厂商的只读接口，不是本地检查格式。 */
  async verify(id: bigint) {
    const account = await this.prisma.cloudAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException('云账号不存在');

    const driver = this.registry.get(account.provider);
    let result: { ok: boolean; message: string; detail?: Record<string, any> };
    try {
      result = await driver.verifyCredentials(this.registry.decryptCredentials(account));
    } catch (err: any) {
      result = { ok: false, message: err?.message ?? String(err) };
    }

    await this.prisma.cloudAccount.update({
      where: { id },
      data: {
        lastCheckedAt: new Date(),
        lastCheckError: result.ok ? null : result.message.slice(0, 500),
      },
    });
    return result;
  }

  /** 前端建套餐时要知道每家驱动支持什么 */
  capabilities() {
    return this.registry.all().map((d) => ({
      kind: d.kind,
      label: LABELS[d.kind],
      canProvision: d.canProvision,
      canRebuild: d.canRebuild,
      hasMetrics: d.hasMetrics,
      needsCloudAccount: d.kind !== 'ssh',
      credentialFields: CREDENTIAL_FIELDS[d.kind],
      specFields: SPEC_FIELDS[d.kind],
    }));
  }

  // ---------- 内部 ----------

  /**
   * 把用户填进来的东西整理成驱动认识的形状，顺便把最常见的填错方式拦下来。
   * 这些提示是照着「第一次接触云厂商的人会怎么填错」写的。
   */
  private normalize(provider: ProviderKind, raw: Record<string, any>): Record<string, any> {
    if (!raw || typeof raw !== 'object') throw new BadRequestException('凭据不能为空');

    if (provider === ProviderKind.gcp) {
      let key = raw.serviceAccountKey;
      // 允许直接粘贴 JSON 全文
      if (typeof key === 'string') {
        try {
          key = JSON.parse(key);
        } catch {
          throw new BadRequestException(
            '服务账号密钥不是合法的 JSON。请把下载到的那个 .json 文件用记事本打开，' +
              '从第一个 { 到最后一个 } 整个复制粘贴进来',
          );
        }
      }
      if (!key?.client_email || !key?.private_key) {
        throw new BadRequestException(
          '这份 JSON 里没有 client_email 和 private_key，不像是服务账号密钥。' +
            '正确的文件是在「IAM 和管理 → 服务账号 → 密钥 → 添加密钥 → 创建新密钥 → JSON」下载的那个',
        );
      }
      const projectId = String(raw.projectId ?? key.project_id ?? '').trim();
      if (!projectId) {
        throw new BadRequestException('缺少项目 ID。在谷歌云控制台顶部项目选择器里能看到');
      }
      return { projectId, serviceAccountKey: key };
    }

    if (provider === ProviderKind.lightsail) {
      const accessKeyId = String(raw.accessKeyId ?? '').trim();
      const secretAccessKey = String(raw.secretAccessKey ?? '').trim();
      const region = String(raw.region ?? '').trim();
      if (!accessKeyId || !secretAccessKey) {
        throw new BadRequestException('请填写 AWS 的 Access Key ID 和 Secret Access Key');
      }
      if (!/^AKIA|^ASIA/.test(accessKeyId)) {
        throw new BadRequestException(
          'Access Key ID 通常以 AKIA 开头。你可能把 Secret 和 ID 填反了',
        );
      }
      if (!region) {
        throw new BadRequestException('请填写区域，比如 ap-southeast-1（新加坡）、ap-northeast-1（东京）');
      }
      if (/[a-z]$/.test(region) && /-\d[a-z]$/.test(region)) {
        throw new BadRequestException(
          `区域填成可用区了：${region}。区域是 ap-southeast-1，可用区才是 ap-southeast-1a。` +
            '可用区在套餐里填，不在这里。',
        );
      }
      return { accessKeyId, secretAccessKey, region };
    }

    if (provider === ProviderKind.proxmox) {
      const host = String(raw.host ?? '').trim().replace(/^https?:\/\//, '').replace(/:\d+$/, '');
      const tokenId = String(raw.tokenId ?? '').trim();
      const tokenSecret = String(raw.tokenSecret ?? '').trim();
      const node = String(raw.node ?? '').trim();
      if (!host) throw new BadRequestException('请填写 PVE 的地址');
      if (!/!/.test(tokenId)) {
        throw new BadRequestException(
          `API Token ID 格式不对：${tokenId}。正确的样子是 root@pam!panel —— 用户名@认证域!令牌名`,
        );
      }
      if (!tokenSecret) throw new BadRequestException('请填写 Token 密钥（创建时只显示一次那个）');
      if (!node) throw new BadRequestException('请填写节点名，一般是 pve');
      return {
        host,
        port: Number(raw.port) || 8006,
        node,
        tokenId,
        tokenSecret,
        rejectUnauthorized: raw.rejectUnauthorized === true,
      };
    }

    throw new BadRequestException(`${provider} 驱动不需要云账号`);
  }

  /** 脱敏摘要。让人能认出「这是哪个账号」，但拿不到任何可用的东西。 */
  private summarize(provider: ProviderKind, blob: string): Record<string, string> {
    const c = tryDecryptJson<any>(this.secret(), blob);
    if (!c) {
      return {
        状态: '解密失败 —— CREDENTIALS_SECRET 可能被改过了，需要重新填一遍凭据',
      };
    }
    if (provider === ProviderKind.gcp) {
      return { 项目: c.projectId ?? '?', 服务账号: c.serviceAccountKey?.client_email ?? '?' };
    }
    if (provider === ProviderKind.lightsail) {
      const k = String(c.accessKeyId ?? '');
      return { 区域: c.region ?? '?', 密钥: k ? `${k.slice(0, 8)}${'*'.repeat(8)}${k.slice(-4)}` : '?' };
    }
    if (provider === ProviderKind.proxmox) {
      return { 地址: `${c.host}:${c.port ?? 8006}`, 节点: c.node ?? '?', 令牌: c.tokenId ?? '?' };
    }
    return {};
  }
}

const LABELS: Record<string, string> = {
  gcp: '谷歌云 Compute Engine',
  lightsail: 'AWS Lightsail',
  ssh: '自有机器（SSH）',
  proxmox: '自建 Proxmox VE',
};

/** 后台录云账号时表单要渲染哪些字段，以及每个字段去哪拿 */
const CREDENTIAL_FIELDS: Record<string, { key: string; label: string; type: string; hint: string }[]> = {
  gcp: [
    {
      key: 'projectId',
      label: '项目 ID',
      type: 'text',
      hint: '谷歌云控制台顶部项目选择器里那一串，形如 my-project-123456。留空会自动从密钥里读',
    },
    {
      key: 'serviceAccountKey',
      label: '服务账号密钥（JSON 全文）',
      type: 'textarea',
      hint: 'IAM 和管理 → 服务账号 → 选中账号 → 密钥 → 添加密钥 → 创建新密钥 → JSON，把下载到的文件内容整个粘进来',
    },
  ],
  lightsail: [
    { key: 'accessKeyId', label: 'Access Key ID', type: 'text', hint: 'AKIA 开头，在 IAM → 用户 → 安全凭证里创建' },
    { key: 'secretAccessKey', label: 'Secret Access Key', type: 'password', hint: '创建密钥时只显示一次，没存下来只能重新建一对' },
    { key: 'region', label: '区域', type: 'text', hint: 'ap-southeast-1（新加坡）、ap-northeast-1（东京）、us-west-2（俄勒冈）' },
  ],
  proxmox: [
    { key: 'host', label: 'PVE 地址', type: 'text', hint: '只填 IP 或域名，不要带 https:// 和端口' },
    { key: 'port', label: '端口', type: 'number', hint: '默认 8006' },
    { key: 'node', label: '节点名', type: 'text', hint: '登录 PVE 后左侧树里那个名字，一般是 pve' },
    { key: 'tokenId', label: 'API Token ID', type: 'text', hint: '形如 root@pam!panel' },
    { key: 'tokenSecret', label: 'Token 密钥', type: 'password', hint: '创建 Token 时只显示一次' },
  ],
  ssh: [],
};

/** 建套餐时 providerSpecJson 要填哪些字段 */
const SPEC_FIELDS: Record<string, { key: string; label: string; type: string; hint: string }[]> = {
  gcp: [
    { key: 'zone', label: '可用区', type: 'text', hint: 'asia-northeast1-a（东京）、asia-east1-b（台湾）、us-west1-a（俄勒冈）' },
    { key: 'machineType', label: '机型', type: 'text', hint: 'e2-micro（最便宜）、e2-small、e2-medium' },
    { key: 'sourceImage', label: '系统镜像', type: 'text', hint: 'projects/debian-cloud/global/images/family/debian-12' },
    { key: 'diskGb', label: '系统盘 GB', type: 'number', hint: '最小 10' },
    { key: 'diskType', label: '磁盘类型', type: 'text', hint: 'pd-standard 便宜 / pd-balanced 默认 / pd-ssd 快' },
    { key: 'staticIp', label: '固定公网 IP', type: 'boolean', hint: '强烈建议开。不开的话用户每次重装 IP 都会变' },
  ],
  lightsail: [
    { key: 'availabilityZone', label: '可用区', type: 'text', hint: '结尾要带字母：ap-southeast-1a，不是 ap-southeast-1' },
    { key: 'bundleId', label: '套餐规格', type: 'text', hint: 'nano_3_0 / micro_3_0 / small_3_0 / medium_3_0' },
    { key: 'blueprintId', label: '系统镜像', type: 'text', hint: 'debian_12 / ubuntu_22_04' },
    { key: 'staticIp', label: '固定公网 IP', type: 'boolean', hint: '强烈建议开' },
  ],
  proxmox: [
    { key: 'templateVmid', label: '模板机 VMID', type: 'number', hint: '配了才能做真重装。模板机里要装好 qemu-guest-agent' },
    { key: 'storage', label: '存储', type: 'text', hint: 'local-lvm' },
    { key: 'bridge', label: '网桥', type: 'text', hint: 'vmbr0' },
  ],
  ssh: [],
};
