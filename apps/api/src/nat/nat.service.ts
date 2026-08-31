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
  /** 送给这台机器的二级域名，指向它的 80。网关没配 webDomain 时是 null。 */
  webHost: string | null;
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
  webDomain?: string | null;
}

const CHAIN_NAT = 'PANEL-NAT';
const CHAIN_FWD = 'PANEL-FWD';
const SCRIPT_PATH = '/usr/local/sbin/panel-nat.sh';
const UNIT_PATH = '/etc/systemd/system/panel-nat.service';
/**
 * 网关 Nginx 里 include 的那个映射文件。面板**只**写这一个文件，
 * 站点配置本身是人工装好的 —— 让程序去改别人生产环境的 Nginx 主配置，
 * 写错一次整台机器上的网站全下线。
 */
const NGINX_MAP_PATH = '/etc/nginx/vps-panel-nat.map';
/** 补签证书的脚本。放在后台跑，不让签证书拖住开通流程。 */
const CERT_SCRIPT_PATH = '/usr/local/sbin/panel-nat-certs.sh';

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
        webHost: webHostFor(gw.webDomain, b.sshPort),
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
        webDomain: normalizeDomain(dto.webDomain),
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
        ...(dto.webDomain === undefined ? {} : { webDomain: normalizeDomain(dto.webDomain) }),
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
      webHost: webHostFor(gw.webDomain, b.sshPort),
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

      // 二级域名的映射单独推。它失败不该把端口映射一起判死 ——
      // 端口已经生效了，机器是能用的，只是域名暂时不通。
      let webWarning: string | null = null;
      if (gw.webDomain) {
        try {
          await this.pushNginxMap(gw, rows);
        } catch (e) {
          webWarning = e instanceof Error ? e.message : String(e);
          this.logger.warn(`网关 ${gw.name} 的二级域名映射没推上去：${webWarning}`);
        }
      }

      await this.prisma.natGateway.update({
        where: { id: gw.id },
        data: { lastSyncAt: new Date(), lastError: webWarning },
      });
      return { ok: true, rules: rows.length, webWarning, syncedAt: new Date() };
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
   * 把二级域名 → 机器内网地址的映射推到网关的 Nginx 上。
   *
   * 只写一个被 include 的映射文件，站点配置本身不碰 —— 那台机器上往往
   * 还跑着别人的网站，程序去改主配置写错一次就是全站下线。
   * 推完先 `nginx -t`，过不了就原样退回去，绝不 reload 一个坏配置。
   */
  private async pushNginxMap(
    gw: NatGateway,
    rows: { ip: string; code: string; sshPort: number }[],
  ) {
    const lines = [
      '# 这个文件由 VPS 面板自动生成，手工改动会在下次下发时被覆盖。',
      ...rows.map((r) => `${webHostFor(gw.webDomain, r.sshPort)} ${r.ip}:80;  # ${r.code}`),
      '',
    ].join('\n');

    const hosts = rows.map((r) => webHostFor(gw.webDomain, r.sshPort)).filter(Boolean) as string[];
    const mapB64 = Buffer.from(lines, 'utf8').toString('base64');
    const certB64 = Buffer.from(this.renderCertScript(gw, hosts), 'utf8').toString('base64');

    const cmd = [
      `cp ${NGINX_MAP_PATH} ${NGINX_MAP_PATH}.bak 2>/dev/null || true`,
      `echo ${mapB64} | base64 -d > ${NGINX_MAP_PATH}`,
      // 配置过不了就回滚，然后以非零退出，让上层知道域名这块没生效
      `if nginx -t 2>/dev/null; then nginx -s reload; else ` +
        `cp ${NGINX_MAP_PATH}.bak ${NGINX_MAP_PATH} 2>/dev/null; ` +
        `echo "nginx -t 没过，映射已回滚"; nginx -t; exit 1; fi`,
      `echo ${certB64} | base64 -d > ${CERT_SCRIPT_PATH}`,
      `chmod 750 ${CERT_SCRIPT_PATH}`,
      // 丢后台跑。签一张证书要十几秒，而且取决于 Let's Encrypt 当时的脸色 ——
      // 不能让开通流程卡在这上面。机器先按 HTTP 可用，证书随后自己补上。
      `(setsid nohup ${CERT_SCRIPT_PATH} >/dev/null 2>&1 &) ; true`,
    ].join(' && ');

    const auth = this.unpackAuth(gw);
    const res = await sshExec(
      { host: gw.sshHost, auth: { sshUser: gw.sshUser, sshPort: gw.sshPort, ...auth } },
      cmd,
      30000,
    );
    if (res.code !== 0) {
      throw new BadRequestException(
        (res.stderr || res.stdout || '没有输出').trim().slice(0, 300) +
          `。网关上要先装好 *.${gw.webDomain} 的站点配置，见文档第 10 章。`,
      );
    }
  }

  /**
   * 给还没有证书的二级域名补签。
   *
   * 网关上配了泛域名证书的话，这里什么都不用做 —— 一张证书覆盖全部，
   * 也不受 Let's Encrypt 每周 50 张的签发上限。没有泛域名证书时才逐台签，
   * 走 HTTP 验证，不需要任何 DNS 服务商的凭据。
   *
   * 每次下发都会重跑，所以上次失败的、后来才加进来的，都会被补上。
   */
  /**
   * 给还没有证书的二级域名补签。
   *
   * 网关上配了泛域名证书的话这里直接退出 —— 一张证书覆盖全部，
   * 也不受 Let's Encrypt 每周 50 张的签发上限。没有泛域名证书时才逐台签，
   * 走 HTTP 验证，不需要任何 DNS 服务商的凭据。
   *
   * 每次下发都会重跑，所以上次失败的、后来才加进来的、续期后权限被还原的，
   * 都会在下一次下发时自动补上。
   */
  private renderCertScript(gw: NatGateway, hosts: string[]): string {
    const NL = String.fromCharCode(10);
    // 留个邮箱，证书快过期时 Let's Encrypt 会提前发信提醒。
    // 没配就只能匿名注册 —— 能签出来，但到期前不会有人通知你。
    const email = this.config.get<string>('ACME_EMAIL');
    const acmeArg = email ? `-m ${email}` : '--register-unsafely-without-email';
    const L = [
      '#!/bin/bash',
      '# 这个文件由 VPS 面板自动生成，手工改动会在下次下发时被覆盖。',
      'LOG=/var/log/panel-nat-certs.log',
      'exec >>$LOG 2>&1',
      'echo "=== $(date -Is) 开始检查证书 ==="',
      '',
      '# 有泛域名证书就什么都不用做 —— 一张覆盖全部，也没有签发数量上限',
      `if [ -f /etc/letsencrypt/live/${gw.webDomain}/fullchain.pem ]; then`,
      '  echo "已有泛域名证书，跳过"; exit 0',
      'fi',
      '',
      'command -v certbot >/dev/null || { echo "网关上没装 certbot，签不了证书"; exit 1; }',
      '',
      '# Nginx 按 SNI 取证书时，读文件的是 worker 进程（非 root），',
      '# 而 certbot 签出来的私钥是 0600 root。开一个专用组，只把',
      '# 这些二级域名的证书放进去 —— 机器上其它站点的证书一律不动。',
      "NGXUSER=$(awk '$1==\"user\"{print $2}' /etc/nginx/nginx.conf | tr -d ';' | head -1)",
      'NGXUSER=${NGXUSER:-www-data}',
      'groupadd -f panel-nat-certs',
      'id -nG "$NGXUSER" | grep -qw panel-nat-certs || usermod -aG panel-nat-certs "$NGXUSER"',
      '# 父目录只给「能穿过去」，不给「能列出来」',
      'chgrp panel-nat-certs /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null',
      'chmod g+x /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null',
      '',
      'fixperm() {',
      '  for D in /etc/letsencrypt/live/$1 /etc/letsencrypt/archive/$1; do',
      '    [ -d "$D" ] || continue',
      '    chgrp -R panel-nat-certs "$D"; chmod -R g+rX "$D"',
      '  done',
      '}',
      '',
      'NEW=0',
      'for H in ' + (hosts.length ? hosts.join(' ') : '""') + '; do',
      '  [ -z "$H" ] && continue',
      '  if [ ! -f /etc/letsencrypt/live/$H/fullchain.pem ]; then',
      '    echo "签 $H"',
      '    if certbot certonly --webroot -w /var/www/certbot -d "$H" ' +
        '--agree-tos --register-unsafely-without-email --non-interactive --quiet; then',
      '      NEW=1; echo "  好了"',
      '    else',
      '      echo "  没签下来，下次下发再试"; continue',
      '    fi',
      '  fi',
      '  # 续期会重新生成文件并还原成 0600 root，所以每次都重新放权一遍',
      '  fixperm "$H"',
      'done',
      '',
      '# 续期之后也要放权，装一个 certbot 的部署钩子',
      'mkdir -p /etc/letsencrypt/renewal-hooks/deploy',
      "cat > /etc/letsencrypt/renewal-hooks/deploy/panel-nat-perms.sh <<'HOOK'",
      '#!/bin/bash',
      '# 由 VPS 面板装的：续期后把 NAT 二级域名证书的读权限还给 nginx worker',
      'for D in $RENEWED_LINEAGE; do',
      '  N=$(basename "$D")',
      `  case "$N" in m*.${gw.webDomain}) ;; *) continue ;; esac`,
      '  chgrp -R panel-nat-certs "$D" /etc/letsencrypt/archive/"$N" 2>/dev/null',
      '  chmod -R g+rX "$D" /etc/letsencrypt/archive/"$N" 2>/dev/null',
      'done',
      'nginx -t && nginx -s reload',
      'HOOK',
      'chmod 750 /etc/letsencrypt/renewal-hooks/deploy/panel-nat-perms.sh',
      '',
      '# 只有真签出新证书才 reload，省得每次下发都白抖一下 nginx',
      'if [ "$NEW" = "1" ]; then nginx -t && nginx -s reload && echo "nginx 已重载"; fi',
      'echo "=== 完 ==="',
      '',
    ];
    return L.join(NL);
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
    const d = normalizeDomain(dto.webDomain);
    if (d && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) {
      throw new BadRequestException(
        `二级域名根域写得不对：${dto.webDomain}。填 nat.example.com 这样的形式，不要带 * 和 http://`,
      );
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
      webDomain: gw.webDomain,
      capacity: this.capacityOf(gw),
      used: bindingCount,
      enabled: gw.enabled,
      lastSyncAt: gw.lastSyncAt,
      lastError: gw.lastError,
    };
  }
}

/**
 * 机器的二级域名。用它分到的 SSH 端口做标签 —— 短、唯一，
 * 而且这个数字买家本来就要记，不用再多记一个。
 */
function webHostFor(domain: string | null | undefined, sshPort: number): string | null {
  return domain ? `m${sshPort}.${domain}` : null;
}

function normalizeDomain(d?: string | null): string | null {
  if (d == null) return null;
  const v = d.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  return v || null;
}
