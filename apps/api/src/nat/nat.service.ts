import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NatGateway } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { encryptJson, tryDecryptJson } from '../crypto/crypto.util';
import { sshExec } from '../providers/ssh-exec.util';

/**
 * NAT 端口映射。
 *
 * 卖没有公网 IP 的机器，靠的就是这一层：机器待在私网里，
 * 面板在一台有公网 IP 的网关上给它开一段端口，买家连网关的端口。
 *
 * 规则下发是**声明式**的：面板不去做「加一条 / 删一条」，
 * 而是每次都把当前该有的全套规则重新渲染一遍，整链替换。
 * 增量改在这种场景下必错 —— 网关重启过、别人手工动过、上一次下发到一半断了，
 * 面板都无从知道现场是什么样子。整链替换则不管现场如何，一次就对齐。
 *
 * 为此规则全部放在面板独占的两条链里（PANEL-NAT / PANEL-FWD），
 * 清空它们不会碰到 Docker、Tailscale、或者运维手写的任何规则。
 */

export interface NatEndpoint {
  gatewayId: bigint;
  publicHost: string;
  sshPort: number;
  portStart: number;
  portEnd: number;
  internalIp: string;
}

export interface GatewayInput {
  name: string;
  publicHost: string;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  password?: string;
  privateKey?: string;
  subnet: string;
  portStart: number;
  portEnd: number;
  portsPerMachine?: number;
}

const CHAIN_NAT = 'PANEL-NAT';
const CHAIN_FWD = 'PANEL-FWD';
const SCRIPT_PATH = '/usr/local/sbin/panel-nat.sh';
const UNIT_PATH = '/etc/systemd/system/panel-nat.service';

@Injectable()
export class NatService {
  private readonly logger = new Logger(NatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private secret(): string {
    const s = this.config.get<string>('CREDENTIALS_SECRET');
    if (!s) throw new Error('.env 里没有配 CREDENTIALS_SECRET，无法加解密网关凭据');
    return s;
  }

  // ---------- 网关的增删改查 ----------

  async list() {
    const rows = await this.prisma.natGateway.findMany({
      orderBy: { id: 'asc' },
      include: { _count: { select: { bindings: true } } },
    });
    return rows.map((g) => this.toPublic(g, g._count.bindings));
  }

  async detail(id: bigint) {
    const gw = await this.prisma.natGateway.findUnique({
      where: { id },
      include: {
        bindings: {
          orderBy: { portStart: 'asc' },
          include: { machine: { select: { code: true, ip: true, status: true } } },
        },
      },
    });
    if (!gw) throw new NotFoundException('没有这个 NAT 网关');
    return {
      ...this.toPublic(gw, gw.bindings.length),
      bindings: gw.bindings.map((b) => ({
        machineCode: b.machine.code,
        internalIp: b.machine.ip,
        machineStatus: b.machine.status,
        sshPort: b.sshPort,
        portStart: b.portStart,
        portEnd: b.portEnd,
      })),
    };
  }

  async create(dto: GatewayInput) {
    this.validate(dto);
    const gw = await this.prisma.natGateway.create({
      data: {
        name: dto.name,
        publicHost: dto.publicHost,
        sshHost: dto.sshHost || dto.publicHost,
        sshPort: dto.sshPort ?? 22,
        sshUser: dto.sshUser || 'root',
        authPayloadEncrypted: this.packAuth(dto),
        subnet: dto.subnet,
        portStart: dto.portStart,
        portEnd: dto.portEnd,
        portsPerMachine: dto.portsPerMachine ?? 20,
      },
    });
    return this.toPublic(gw, 0);
  }

  async update(id: bigint, dto: Partial<GatewayInput> & { enabled?: boolean }) {
    const cur = await this.prisma.natGateway.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('没有这个 NAT 网关');

    // 只把「真的填了」的字段盖上去。DTO 实例会把没填的字段实打实地
    // 定义成 undefined，直接展开会把库里原有的值全抹掉 ——
    // 只改个名字都会触发「私网网段格式不对」。
    const provided = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    );
    const merged = { ...cur, ...provided } as GatewayInput;
    this.validate(merged);

    // 端口区间缩小之前先看看有没有已经分出去的段落在外面。
    // 直接改会让库里的映射和实际下发的规则对不上 —— 机器还在跑，但买家连不上了。
    if (dto.portStart != null || dto.portEnd != null) {
      const outside = await this.prisma.natBinding.count({
        where: {
          gatewayId: id,
          OR: [{ portStart: { lt: merged.portStart } }, { portEnd: { gt: merged.portEnd } }],
        },
      });
      if (outside > 0) {
        throw new BadRequestException(
          `已经有 ${outside} 台机器的端口段落在新区间之外，先把它们释放或迁走再改`,
        );
      }
    }

    const auth = this.packAuth(dto);
    const gw = await this.prisma.natGateway.update({
      where: { id },
      data: {
        name: dto.name,
        publicHost: dto.publicHost,
        sshHost: dto.sshHost,
        sshPort: dto.sshPort,
        sshUser: dto.sshUser,
        subnet: dto.subnet,
        portStart: dto.portStart,
        portEnd: dto.portEnd,
        portsPerMachine: dto.portsPerMachine,
        enabled: dto.enabled,
        // 没填就是「别动原来的密码」，不是「清空密码」
        ...(auth ? { authPayloadEncrypted: auth } : {}),
      },
    });
    return this.toPublic(gw, 0);
  }

  async remove(id: bigint) {
    const used = await this.prisma.natBinding.count({ where: { gatewayId: id } });
    if (used > 0) {
      throw new BadRequestException(`这个网关上还有 ${used} 台机器在用，删了它们就全断了`);
    }
    await this.prisma.natGateway.delete({ where: { id } });
    return { ok: true };
  }

  // ---------- 端口段的分配与回收 ----------

  /**
   * 给一台机器分一段端口，然后立刻下发规则。
   *
   * 已经分过就直接复用 —— 重装、重试开通都会走到这里，
   * 每次换一段端口的话，买家保存的连接方式就失效了。
   */
  async attach(machineId: bigint, gatewayId: bigint, internalIp: string): Promise<NatEndpoint> {
    const gw = await this.prisma.natGateway.findUnique({ where: { id: gatewayId } });
    if (!gw) throw new BadRequestException(`套餐里写的 NAT 网关 ${gatewayId} 不存在`);
    if (!gw.enabled) throw new BadRequestException(`NAT 网关「${gw.name}」已停用`);

    const exist = await this.prisma.natBinding.findUnique({ where: { machineId } });
    if (exist) {
      await this.sync(gw.id);
      return this.endpoint(gw, exist, internalIp);
    }

    const binding = await this.prisma.natBinding.create({
      data: { gatewayId: gw.id, machineId, ...(await this.pickBlock(gw)) },
    });
    await this.sync(gw.id);
    return this.endpoint(gw, binding, internalIp);
  }

  /** 机器销毁时回收端口段。规则要跟着撤，否则端口重分给下一台机器时会串门。 */
  async detach(machineId: bigint) {
    const b = await this.prisma.natBinding.findUnique({ where: { machineId } });
    if (!b) return;
    await this.prisma.natBinding.delete({ where: { id: b.id } });
    // 这里不能因为下发失败就把整个销毁流程带崩：机器已经没了，
    // 端口段也已经在库里回收，网关上多留几条指向空地址的规则不影响别人。
    await this.sync(b.gatewayId).catch((e) =>
      this.logger.warn(`回收端口后下发规则失败，规则会在下次下发时自动对齐：${e.message}`),
    );
  }

  /**
   * 挑一段还没被占的端口。取最小的空位，而不是一路往后加，
   * 这样删掉几台机器之后腾出来的段落会被重新用上。
   */
  private async pickBlock(gw: NatGateway) {
    const size = gw.portsPerMachine;
    const taken = new Set(
      (
        await this.prisma.natBinding.findMany({
          where: { gatewayId: gw.id },
          select: { portStart: true },
        })
      ).map((b) => b.portStart),
    );
    for (let start = gw.portStart; start + size - 1 <= gw.portEnd; start += size) {
      if (!taken.has(start)) return { portStart: start, portEnd: start + size - 1, sshPort: start };
    }
    throw new BadRequestException(
      `NAT 网关「${gw.name}」的端口 ${gw.portStart}-${gw.portEnd} 已经分完了，把区间调大一点`,
    );
  }

  private capacityOf(gw: NatGateway) {
    return Math.floor((gw.portEnd - gw.portStart + 1) / gw.portsPerMachine);
  }

  private endpoint(
    gw: NatGateway,
    b: { portStart: number; portEnd: number; sshPort: number },
    ip: string,
  ): NatEndpoint {
    return {
      gatewayId: gw.id,
      publicHost: gw.publicHost,
      sshPort: b.sshPort,
      portStart: b.portStart,
      portEnd: b.portEnd,
      internalIp: ip,
    };
  }

  // ---------- 规则下发 ----------

  /** 把这个网关当前该有的全套规则重新下发一遍 */
  async sync(gatewayId: bigint) {
    const gw = await this.prisma.natGateway.findUnique({
      where: { id: gatewayId },
      include: { bindings: { include: { machine: { select: { ip: true, code: true } } } } },
    });
    if (!gw) throw new NotFoundException('没有这个 NAT 网关');

    // 还没拿到私网地址的机器先跳过 —— 给一条指向空地址的 DNAT，
    // iptables 会直接拒绝整份脚本，连带把别人的映射也一起下发失败。
    const rows = gw.bindings
      .filter((b) => !!b.machine.ip)
      .map((b) => ({
        ip: b.machine.ip as string,
        code: b.machine.code,
        portStart: b.portStart,
        portEnd: b.portEnd,
        sshPort: b.sshPort,
      }));

    try {
      await this.runScript(gw, this.renderScript(gw, rows));
      await this.prisma.natGateway.update({
        where: { id: gw.id },
        data: { lastSyncAt: new Date(), lastError: null },
      });
      return { ok: true, rules: rows.length, syncedAt: new Date() };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.prisma.natGateway.update({
        where: { id: gw.id },
        data: { lastError: msg.slice(0, 490) },
      });
      throw e;
    }
  }

  /**
   * 渲染下发脚本。
   *
   * 端口段里除了第一个端口（映射到机器的 22），其余按**原样转发** ——
   * 公网 30002 进来就打到机器的 30002。买家在机器上起服务时用哪个端口，
   * 对外就是哪个端口，不用记两套号码。
   */
  private renderScript(
    gw: NatGateway,
    rows: { ip: string; code: string; portStart: number; portEnd: number; sshPort: number }[],
  ): string {
    const L: string[] = [
      '#!/bin/bash',
      '# 这个文件由 VPS 面板自动生成，手工改动会在下次下发时被覆盖。',
      'set -e',
      'IPT=$(command -v iptables)',
      '',
      '# 链不存在就建。已经存在时 -N 会报错，用 || true 吞掉。',
      `$IPT -t nat -N ${CHAIN_NAT} 2>/dev/null || true`,
      `$IPT -N ${CHAIN_FWD} 2>/dev/null || true`,
      '',
      '# 挂到主链最前面。已经挂过就别重复挂 —— 每次下发都插一条的话，',
      '# 跑上几十次 PREROUTING 里就是几十条一模一样的跳转。',
      `$IPT -t nat -C PREROUTING -j ${CHAIN_NAT} 2>/dev/null || $IPT -t nat -I PREROUTING 1 -j ${CHAIN_NAT}`,
      `$IPT -C FORWARD -j ${CHAIN_FWD} 2>/dev/null || $IPT -I FORWARD 1 -j ${CHAIN_FWD}`,
      '',
      '# 只清面板自己的链。Docker 和 Tailscale 的规则一根都不碰。',
      `$IPT -t nat -F ${CHAIN_NAT}`,
      `$IPT -F ${CHAIN_FWD}`,
      '',
      `$IPT -A ${CHAIN_FWD} -s ${gw.subnet} -m state --state RELATED,ESTABLISHED -j ACCEPT`,
      `$IPT -A ${CHAIN_FWD} -d ${gw.subnet} -j ACCEPT`,
      '',
      '# 回程也要经过网关，所以出方向得改源地址；否则机器会把回包丢给',
      '# 它自己那边的默认网关，买家永远等不到握手的第二个包。',
      `$IPT -t nat -C POSTROUTING -d ${gw.subnet} -j MASQUERADE 2>/dev/null || $IPT -t nat -A POSTROUTING -d ${gw.subnet} -j MASQUERADE`,
      '',
    ];

    if (rows.length === 0) L.push('# 目前没有机器绑在这个网关上');

    for (const r of rows) {
      L.push(`# ${r.code} -> ${r.ip}`);
      L.push(
        `$IPT -t nat -A ${CHAIN_NAT} -p tcp --dport ${r.sshPort} -j DNAT --to-destination ${r.ip}:22`,
      );
      if (r.portEnd > r.portStart) {
        const a = r.portStart + 1;
        L.push(
          `$IPT -t nat -A ${CHAIN_NAT} -p tcp --dport ${a}:${r.portEnd} -j DNAT --to-destination ${r.ip}`,
        );
        L.push(
          `$IPT -t nat -A ${CHAIN_NAT} -p udp --dport ${a}:${r.portEnd} -j DNAT --to-destination ${r.ip}`,
        );
      }
      L.push('');
    }
    L.push('exit 0');
    return L.join('\n') + '\n';
  }

  /**
   * 把脚本传上去执行，并装一个开机自启的 systemd 单元。
   *
   * 不用 iptables-save / iptables-restore 做持久化：那会把 Docker 当时的规则
   * 一起存下来，而开机时 Docker 自己也会重建一份，两边打架。存我们自己的脚本、
   * 开机跑一遍，只写我们自己的链，Docker 那边毫不知情。
   */
  private async runScript(gw: NatGateway, script: string) {
    const auth = this.unpackAuth(gw);
    const target = {
      host: gw.sshHost,
      auth: { sshUser: gw.sshUser, sshPort: gw.sshPort, ...auth },
    };

    const unit = [
      '[Unit]',
      'Description=VPS 面板的 NAT 端口映射',
      'After=network-online.target docker.service tailscaled.service',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=oneshot',
      'RemainAfterExit=yes',
      `ExecStart=${SCRIPT_PATH}`,
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n');

    // base64 传输，免得脚本里的引号和 $ 在层层 shell 之间被吃掉
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    const cmd = [
      `echo ${b64(script)} | base64 -d > ${SCRIPT_PATH}`,
      `chmod 750 ${SCRIPT_PATH}`,
      `echo ${b64(unit)} | base64 -d > ${UNIT_PATH}`,
      'systemctl daemon-reload >/dev/null 2>&1 || true',
      'systemctl enable panel-nat.service >/dev/null 2>&1 || true',
      `bash ${SCRIPT_PATH}`,
    ].join(' && ');

    const res = await sshExec(target, cmd, 40000);
    if (res.code !== 0) {
      const why = (res.stderr || res.stdout || '没有输出').trim().slice(0, 300);
      throw new BadRequestException(
        `在网关 ${gw.sshHost} 上下发规则失败（退出码 ${res.code}）：${why}`,
      );
    }
  }

  /** 后台点「测试」：连上去看看能不能用，顺带报告它到私网通不通 */
  async test(id: bigint) {
    const gw = await this.prisma.natGateway.findUnique({ where: { id } });
    if (!gw) throw new NotFoundException('没有这个 NAT 网关');
    const auth = this.unpackAuth(gw);
    const target = { host: gw.sshHost, auth: { sshUser: gw.sshUser, sshPort: gw.sshPort, ...auth } };

    const res = await sshExec(
      target,
      [
        'echo "转发=$(sysctl -n net.ipv4.ip_forward)"',
        `echo "路由=$(ip route show table all | grep -m1 -F '${gw.subnet}' || echo 没有)"`,
        'echo "iptables=$(command -v iptables || echo 缺)"',
        `echo "已下发=$(iptables -t nat -S ${CHAIN_NAT} 2>/dev/null | grep -c DNAT || true)"`,
      ].join('; '),
      25000,
    );
    const out = (res.stdout || '').trim();
    const forwarding = /转发=1/.test(out);
    const hasRoute = !/路由=没有/.test(out);
    const hasIptables = !/iptables=缺/.test(out);
    return {
      ok: res.code === 0 && forwarding && hasRoute && hasIptables,
      forwarding,
      hasRoute,
      hasIptables,
      detail: out || (res.stderr || '').trim(),
      hint: !hasIptables
        ? '网关上没有 iptables，先装 iptables 包'
        : !forwarding
          ? '网关没开内核转发：sysctl -w net.ipv4.ip_forward=1，并写进 /etc/sysctl.d/ 保证重启后还在'
          : !hasRoute
            ? `网关没有到 ${gw.subnet} 的路由 —— 隧道（Tailscale / WireGuard）那边还没打通`
            : null,
    };
  }

  // ---------- 杂项 ----------

  /** 查一台机器的对外连接方式。控制台和交付信息都要用。 */
  async endpointForMachine(machineId: bigint): Promise<NatEndpoint | null> {
    const b = await this.prisma.natBinding.findUnique({
      where: { machineId },
      include: { gateway: true, machine: { select: { ip: true } } },
    });
    if (!b) return null;
    return this.endpoint(b.gateway, b, b.machine.ip ?? '');
  }

  private validate(dto: GatewayInput) {
    if (!/^\d+\.\d+\.\d+\.\d+\/\d{1,2}$/.test(dto.subnet ?? '')) {
      throw new BadRequestException('私网网段要写成 172.31.0.0/24 这种形式');
    }
    const { portStart, portEnd } = dto;
    const per = dto.portsPerMachine ?? 20;
    if (!portStart || !portEnd || portStart < 1024 || portEnd > 65535 || portStart >= portEnd) {
      throw new BadRequestException('端口区间不对：起点不能低于 1024，终点不能高于 65535');
    }
    if (per < 1 || per > 1000) {
      throw new BadRequestException('每台机器的端口数要在 1 到 1000 之间');
    }
    if (portEnd - portStart + 1 < per) {
      throw new BadRequestException('端口区间比每台机器要分的端口数还小，一台都放不下');
    }
  }

  private packAuth(dto: { password?: string; privateKey?: string }): string | undefined {
    if (!dto.password && !dto.privateKey) return undefined;
    return encryptJson(this.secret(), {
      password: dto.password || undefined,
      privateKey: dto.privateKey || undefined,
    });
  }

  private unpackAuth(gw: NatGateway): { password?: string; privateKey?: string } {
    if (!gw.authPayloadEncrypted) {
      throw new BadRequestException(`NAT 网关「${gw.name}」没存登录凭据，面板下不了规则`);
    }
    const a = tryDecryptJson<{ password?: string; privateKey?: string }>(
      this.secret(),
      gw.authPayloadEncrypted,
    );
    if (!a) throw new BadRequestException(`NAT 网关「${gw.name}」的凭据解不开，重新填一次密码`);
    return a;
  }

  private toPublic(gw: NatGateway, bindingCount: number) {
    return {
      id: gw.id.toString(),
      name: gw.name,
      publicHost: gw.publicHost,
      sshHost: gw.sshHost,
      sshPort: gw.sshPort,
      sshUser: gw.sshUser,
      hasAuth: !!gw.authPayloadEncrypted,
      subnet: gw.subnet,
      portStart: gw.portStart,
      portEnd: gw.portEnd,
      portsPerMachine: gw.portsPerMachine,
      capacity: this.capacityOf(gw),
      used: bindingCount,
      enabled: gw.enabled,
      lastSyncAt: gw.lastSyncAt,
      lastError: gw.lastError,
    };
  }
}
