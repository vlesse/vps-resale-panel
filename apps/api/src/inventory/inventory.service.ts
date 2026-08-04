import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InventoryStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  decryptJson,
  encryptJson,
  ProxmoxAuthConfig,
  ServerAuthPayload,
} from '../crypto/crypto.util';
import { serialize } from '../common/utils';
import { pveTestConnection, resolvePveConfig } from '../services/proxmox.util';
import { normalizeProvider } from '../services/provider.util';

type MatchRules = {
  regions?: string[];
  min_cpu?: number;
  min_memory_mb?: number;
  min_disk_gb?: number;
  tags_any?: string[];
  providers?: string[];
};

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private secret() {
    return this.config.get<string>('CREDENTIALS_SECRET') || 'dev-secret';
  }

  list(status?: InventoryStatus) {
    return this.prisma.inventoryServer
      .findMany({
        where: status ? { status } : undefined,
        orderBy: { id: 'desc' },
      })
      .then((rows) =>
        serialize(
          rows.map((r) => ({
            ...r,
            driver: normalizeProvider(r.provider),
            // never return encrypted blob raw size only
            hasAuth: Boolean(r.authPayloadEncrypted),
          })),
        ),
      );
  }

  async create(body: {
    code: string;
    provider: string;
    providerRef?: string;
    ip: string;
    sshPort?: number;
    username?: string;
    password?: string;
    privateKey?: string;
    cpu: number;
    memoryMb: number;
    diskGb: number;
    region: string;
    optimizeTags?: string[];
    costCents?: number;
    currency?: 'CNY' | 'USD';
    upstreamExpireAt?: string;
    notes?: string;
    status?: InventoryStatus;
    /** Proxmox block (when provider=proxmox) */
    pve?: Partial<ProxmoxAuthConfig> & {
      host?: string;
      node?: string;
      vmid?: number | string;
      tokenId?: string;
      tokenSecret?: string;
      templateVmid?: number | string;
      storage?: string;
      ipconfig0?: string;
      nameserver?: string;
      ciUser?: string;
      port?: number | string;
      protocol?: 'https' | 'http';
      verifyTls?: boolean;
      apiUsername?: string;
      apiPassword?: string;
    };
  }) {
    const provider = String(body.provider || '').trim().toLowerCase() || 'ssh';
    const driver = normalizeProvider(provider);

    const auth: ServerAuthPayload = {
      username: body.username || body.pve?.ciUser || 'root',
      password: body.password,
      privateKey: body.privateKey,
    };

    let providerRef = body.providerRef;
    if (driver === 'proxmox') {
      if (!body.pve?.host) {
        throw new BadRequestException('Proxmox inventory requires pve.host');
      }
      const node = String(body.pve.node || '').trim();
      const vmid = Number(body.pve.vmid);
      if (!node || !vmid) {
        throw new BadRequestException('Proxmox inventory requires pve.node and pve.vmid');
      }
      const hasToken = Boolean(body.pve.tokenId && body.pve.tokenSecret);
      const hasPass = Boolean(
        (body.pve.apiUsername || body.pve.username) &&
          (body.pve.apiPassword || body.pve.password),
      );
      // token preferred; password auth also ok
      if (!hasToken && !hasPass) {
        throw new BadRequestException(
          'Proxmox requires tokenId+tokenSecret or apiUsername+apiPassword',
        );
      }
      auth.pve = {
        host: String(body.pve.host).trim(),
        port: body.pve.port ? Number(body.pve.port) : 8006,
        protocol: body.pve.protocol || 'https',
        tokenId: body.pve.tokenId,
        tokenSecret: body.pve.tokenSecret,
        username: body.pve.apiUsername || body.pve.username,
        password: body.pve.apiPassword || (hasToken ? undefined : body.pve.password),
        node,
        vmid,
        verifyTls: body.pve.verifyTls === true,
        templateVmid: body.pve.templateVmid
          ? Number(body.pve.templateVmid)
          : undefined,
        storage: body.pve.storage,
        bridge: body.pve.bridge,
        ciUser: body.pve.ciUser || body.username || 'root',
        ipconfig0: body.pve.ipconfig0,
        nameserver: body.pve.nameserver,
      };
      if (!providerRef) providerRef = `${node}/${vmid}`;
      // guest SSH password may still be provided for fallback
      if (body.password) auth.password = body.password;
    } else {
      if (!body.username) {
        throw new BadRequestException('SSH inventory requires username');
      }
      if (!body.password && !body.privateKey) {
        throw new BadRequestException('SSH inventory requires password or privateKey');
      }
    }

    const row = await this.prisma.inventoryServer.create({
      data: {
        code: body.code,
        provider: driver === 'proxmox' ? 'proxmox' : provider,
        providerRef,
        ip: body.ip,
        sshPort: body.sshPort ?? 22,
        authPayloadEncrypted: encryptJson(this.secret(), auth),
        cpu: body.cpu,
        memoryMb: body.memoryMb,
        diskGb: body.diskGb,
        region: body.region,
        optimizeTagsJson: body.optimizeTags ?? [],
        costCents: body.costCents,
        currency: body.currency,
        upstreamExpireAt: body.upstreamExpireAt
          ? new Date(body.upstreamExpireAt)
          : null,
        notes: body.notes,
        status: body.status ?? InventoryStatus.sourcing,
      },
    });
    return serialize({ ...row, driver });
  }

  async testConnection(id: string) {
    const row = await this.prisma.inventoryServer.findUnique({
      where: { id: BigInt(id) },
    });
    if (!row) throw new NotFoundException('Inventory not found');
    const driver = normalizeProvider(row.provider);
    if (driver !== 'proxmox') {
      throw new BadRequestException('test-connection currently supports proxmox only');
    }
    const auth = decryptJson<ServerAuthPayload>(
      this.secret(),
      row.authPayloadEncrypted,
    );
    if (!auth.pve) throw new BadRequestException('Missing pve credentials');
    const cfg = resolvePveConfig(auth.pve, row.providerRef);
    try {
      const result = await pveTestConnection(cfg);
      return { driver, ...result };
    } catch (e: any) {
      throw new BadRequestException({
        code: 'PVE_CONNECTION_FAILED',
        message: String(e?.message || e),
        host: cfg.host,
        port: cfg.port || 8006,
        node: cfg.node,
        vmid: cfg.vmid,
      });
    }
  }

  async updateStatus(id: string, status: InventoryStatus, notes?: string) {
    const allowed: Record<string, InventoryStatus[]> = {
      sourcing: [InventoryStatus.optimizing, InventoryStatus.retired],
      optimizing: [
        InventoryStatus.ready,
        InventoryStatus.sourcing,
        InventoryStatus.retired,
      ],
      ready: [InventoryStatus.retired, InventoryStatus.optimizing],
      reserved: [InventoryStatus.ready],
      sold: [InventoryStatus.suspended, InventoryStatus.recycling],
      suspended: [InventoryStatus.sold, InventoryStatus.recycling],
      recycling: [InventoryStatus.ready, InventoryStatus.retired],
      retired: [],
    };
    const cur = await this.prisma.inventoryServer.findUnique({
      where: { id: BigInt(id) },
    });
    if (!cur) throw new NotFoundException('Inventory not found');
    const next = allowed[cur.status] || [];
    const forceReady =
      status === InventoryStatus.ready &&
      (
        cur.status === InventoryStatus.sourcing ||
        cur.status === InventoryStatus.optimizing ||
        cur.status === InventoryStatus.recycling
      );
    if (!next.includes(status) && !forceReady) {
      throw new BadRequestException(
        `Cannot transition ${cur.status} -> ${status}`,
      );
    }
    const row = await this.prisma.inventoryServer.update({
      where: { id: cur.id },
      data: { status, notes: notes ?? cur.notes },
    });
    return serialize(row);
  }

  /** Count ready stock matching plan rules (for pre-order check). */
  async countReadyForPlan(planId: bigint): Promise<number> {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) return 0;
    const rules = (plan.matchRulesJson || {}) as MatchRules;
    const where = this.buildMatchWhere(rules);
    return this.prisma.inventoryServer.count({
      where: { status: InventoryStatus.ready, ...where },
    });
  }

  buildMatchWhere(rules: MatchRules): Prisma.InventoryServerWhereInput {
    const where: Prisma.InventoryServerWhereInput = {};
    if (rules.regions?.length) where.region = { in: rules.regions };
    if (rules.providers?.length) where.provider = { in: rules.providers };
    if (rules.min_cpu) where.cpu = { gte: rules.min_cpu };
    if (rules.min_memory_mb) where.memoryMb = { gte: rules.min_memory_mb };
    if (rules.min_disk_gb) where.diskGb = { gte: rules.min_disk_gb };
    return where;
  }

  async findReadyCandidates(planId: bigint, take = 20) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) return [];
    const rules = (plan.matchRulesJson || {}) as MatchRules;
    const where = this.buildMatchWhere(rules);
    let rows = await this.prisma.inventoryServer.findMany({
      where: { status: InventoryStatus.ready, ...where },
      orderBy: [{ upstreamExpireAt: 'desc' }, { id: 'asc' }],
      take,
    });
    if (rules.tags_any?.length) {
      rows = rows.filter((r) => {
        const tags = (r.optimizeTagsJson as string[]) || [];
        return rules.tags_any!.some((t) => tags.includes(t));
      });
    }
    return rows;
  }
}
