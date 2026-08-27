import { Injectable, Logger } from '@nestjs/common';
import {
  AllocateStaticIpCommand,
  AttachStaticIpCommand,
  CreateInstancesCommand,
  DeleteInstanceCommand,
  GetInstanceCommand,
  GetInstanceMetricDataCommand,
  GetInstanceStateCommand,
  GetOperationCommand,
  GetRegionsCommand,
  LightsailClient,
  PutInstancePublicPortsCommand,
  RebootInstanceCommand,
  ReleaseStaticIpCommand,
  StartInstanceCommand,
  StopInstanceCommand,
} from '@aws-sdk/client-lightsail';
import {
  CredentialCheckResult,
  LightsailCredentials,
  LightsailRef,
  MachineStatusSnapshot,
  MetricSeries,
  PowerState,
  ProviderContext,
  ProvisionRequest,
  ProvisionResult,
  ResetPasswordResult,
  VpsProvider,
  toInstanceName,
} from '../provider.types';
import { buildBootstrapCheckCommand, buildBootstrapScript } from '../bootstrap.util';
import { SshTarget, probeMachine, setRootPassword, sleep, sshExec, waitForSsh } from '../ssh-exec.util';

/**
 * AWS Lightsail 驱动。
 *
 * Lightsail 是 AWS 给「就想要一台简单 VPS」的人做的产品线，按月固定价，
 * 比 EC2 好卖也好算成本，所以转售用它比用 EC2 合适。
 *
 * 相比谷歌云，它多给了两样有用的东西：
 *   GetInstanceMetricData   直接吐 CPU 和网络曲线，不用往机器里装监控
 *   PutInstancePublicPorts  防火墙也是 API 可控的
 *
 * 但同样 **没有「重装」API**：重装 = DeleteInstance 再 CreateInstances。
 * 静态 IP 是独立资源，不跟着实例删，所以开了静态 IP 的套餐重装后 IP 不变。
 *
 * 还有一个坑：Lightsail 的 Debian 镜像默认登录用户是 admin 不是 root，
 * Ubuntu 镜像是 ubuntu。但 userData 是以 root 身份跑的，所以我们的初始化脚本
 * 能把 root 密码登录打开，交付给用户的仍然是 root。
 */

interface LightsailSpec {
  /** 可用区，比如 ap-southeast-1a。注意结尾有字母，和 region 不是一个东西 */
  availabilityZone: string;
  /** 套餐规格，比如 nano_3_0 / micro_3_0 / small_3_0 */
  bundleId: string;
  /** 系统镜像，比如 debian_12 / ubuntu_22_04 */
  blueprintId: string;
  /** 是否分配静态 IP。转售建议开。 */
  staticIp?: boolean;
  /** 要放行的端口。不填用默认值（22 SSH、80 HTTP、443 HTTPS）。 */
  openPorts?: OpenPort[];
  enableBbr?: boolean;
}

type OpenPort = { from: number; to: number; protocol: 'tcp' | 'udp' | 'all' };

const DEFAULT_PORTS: OpenPort[] = [
  { from: 22, to: 22, protocol: 'tcp' },
  { from: 80, to: 80, protocol: 'tcp' },
  { from: 443, to: 443, protocol: 'tcp' },
];

@Injectable()
export class LightsailProvider implements VpsProvider {
  readonly kind = 'lightsail' as const;
  readonly canProvision = true;
  readonly canRebuild = true;
  readonly hasMetrics = true;

  private readonly logger = new Logger(LightsailProvider.name);

  // ---------- 客户端 ----------

  private client(cred: LightsailCredentials, regionOverride?: string): LightsailClient {
    if (!cred?.accessKeyId || !cred?.secretAccessKey) {
      throw new Error('AWS 账号缺少 accessKeyId 或 secretAccessKey');
    }
    const region = regionOverride ?? cred.region;
    if (!region) throw new Error('AWS 账号没填区域（region），比如 ap-southeast-1');
    return new LightsailClient({
      region,
      credentials: {
        accessKeyId: cred.accessKeyId,
        secretAccessKey: cred.secretAccessKey,
      },
      maxAttempts: 3,
    });
  }

  private cred(ctx: ProviderContext): LightsailCredentials {
    return ctx.credentials as LightsailCredentials;
  }

  private lsRef(ctx: ProviderContext): LightsailRef {
    const ref = ctx.ref as LightsailRef;
    if (!ref?.instanceName || !ref?.region) {
      throw new Error('这台机器缺少 Lightsail 的实例标识（region / instanceName），无法操作');
    }
    return ref;
  }

  /** ap-southeast-1a → ap-southeast-1 */
  private regionOfAz(az: string): string {
    return az.replace(/[a-z]$/, '');
  }

  // ---------- 凭据校验 ----------

  async verifyCredentials(credentials: LightsailCredentials): Promise<CredentialCheckResult> {
    try {
      const client = this.client(credentials);
      const res = await client.send(new GetRegionsCommand({ includeAvailabilityZones: true }));
      const hit = res.regions?.find((r) => r.name === credentials.region);
      if (!hit) {
        return {
          ok: false,
          message: `区域 ${credentials.region} 不是有效的 Lightsail 区域。可用区域：${res.regions
            ?.map((r) => r.name)
            .join('、')}`,
        };
      }
      return {
        ok: true,
        message: '连接成功',
        detail: {
          区域: `${hit.displayName}（${hit.name}）`,
          可用区: hit.availabilityZones?.map((z) => z.zoneName).join('、'),
        },
      };
    } catch (err: any) {
      return { ok: false, message: this.explain(err) };
    }
  }

  // ---------- 建机 ----------

  async provision(ctx: ProviderContext, req: ProvisionRequest): Promise<ProvisionResult> {
    const cred = this.cred(ctx);
    const spec = req.spec as LightsailSpec;
    this.assertSpec(spec);

    const region = this.regionOfAz(spec.availabilityZone);
    const client = this.client(cred, region);
    const instanceName = toInstanceName(req.code);
    const progress = req.onProgress ?? (() => undefined);

    const userData = buildBootstrapScript({
      username: 'root',
      password: req.password,
      publicKeyOpenssh: req.publicKeyOpenssh,
      hostname: req.hostname,
      enableBbr: spec.enableBbr !== false,
    });

    const staticIpName = spec.staticIp ? `${instanceName}-ip` : undefined;

    // 0. 先把「我要建什么」告诉上层并落库。提交创建和确认完成之间断掉的话，
    //    云上可能已经有一台在计费的实例，没有这行记录就再也找不到它了。
    await req.onRefKnown?.({ region, instanceName, staticIpName });

    // 1. 建实例
    await progress(12, '向 AWS 提交建机请求');
    try {
      const res = await client.send(
        new CreateInstancesCommand({
          instanceNames: [instanceName],
          availabilityZone: spec.availabilityZone,
          blueprintId: spec.blueprintId,
          bundleId: spec.bundleId,
          userData,
          tags: [
            { key: 'managed-by', value: 'vps-resale-panel' },
            { key: 'panel-code', value: instanceName },
          ],
        }),
      );
      await progress(28, 'AWS 正在创建实例');
      await this.waitOperations(client, res.operations?.map((o) => o.id).filter(Boolean) as string[]);
    } catch (err: any) {
      throw new Error(this.explain(err));
    }

    try {
      // 2. 等实例进入 running（静态 IP 要挂到 running 的实例上）
      await progress(42, '等待实例启动');
      await this.waitState(client, instanceName, 'running', 240000);

      // 3. 静态 IP
      let ip: string | undefined;
      if (staticIpName) {
        await progress(52, '分配并绑定静态公网 IP');
        ip = await this.attachStaticIp(client, instanceName, staticIpName);
      }

      // 4. 防火墙
      await progress(58, '配置防火墙端口');
      await this.applyPorts(client, instanceName, spec.openPorts ?? DEFAULT_PORTS);

      // 5. 取 IP
      if (!ip) {
        const inst = await client.send(new GetInstanceCommand({ instanceName }));
        ip = inst.instance?.publicIpAddress;
      }
      if (!ip) throw new Error('实例建出来了但没拿到公网 IP');

      const ref: LightsailRef = { region, instanceName, staticIpName };
      const auth = {
        sshUser: 'root',
        sshPort: 22,
        password: req.password,
        privateKey: req.privateKeyPem,
      };

      await this.waitUntilReady({ host: ip, auth }, progress);

      return {
        ref,
        ip,
        auth,
        osTemplate: spec.blueprintId,
        raw: { instanceName, region, bundleId: spec.bundleId, staticIpName },
      };
    } catch (err: any) {
      // 半成品实例会一直计费，必须清掉
      await this.cleanupFailed(client, instanceName, staticIpName);
      // 我们自己抛的错已经是中文了，只翻译 AWS SDK 抛出来的
      throw err?.name && err?.$metadata ? new Error(this.explain(err)) : err;
    }
  }

  /** SSH 通了不等于初始化跑完了，必须等标记文件出现才敢把密码交给用户 */
  private async waitUntilReady(
    target: SshTarget,
    progress: (p: number, s: string) => Promise<void> | void,
  ): Promise<void> {
    await progress(68, '等待系统启动并开放 SSH');
    await waitForSsh(target, {
      timeoutMs: 240000,
      intervalMs: 6000,
      onAttempt: (n) => {
        if (n % 5 === 0) void progress(74, `等待 SSH 就绪（第 ${n} 次尝试）`);
      },
    });

    await progress(86, '等待系统初始化完成');
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const res = await sshExec(target, buildBootstrapCheckCommand(), 15000).catch(() => null);
      if (res && res.code === 0) {
        await progress(95, '初始化完成');
        return;
      }
      await sleep(5000);
    }
    throw new Error(
      '系统初始化脚本超过 3 分钟还没跑完。可以到后台机器列表里手动重试，' +
        '或 SSH 进去看 /var/log/vps-panel-bootstrap.log',
    );
  }

  // ---------- 状态 ----------

  async getStatus(ctx: ProviderContext): Promise<MachineStatusSnapshot> {
    const ref = this.lsRef(ctx);
    const client = this.client(this.cred(ctx), ref.region);

    const inst = await client.send(new GetInstanceCommand({ instanceName: ref.instanceName }));
    const power = this.mapPower(inst.instance?.state?.name);
    const ip = inst.instance?.publicIpAddress ?? ctx.ip;

    const snapshot: MachineStatusSnapshot = {
      power,
      ip: ip ?? undefined,
      checkedAt: new Date().toISOString(),
      raw: { state: inst.instance?.state?.name, bundleId: inst.instance?.bundleId },
    };

    if (power === 'running' && ip && ctx.auth) {
      try {
        Object.assign(snapshot, await probeMachine({ host: ip, auth: ctx.auth }));
      } catch (err: any) {
        snapshot.note = `实例在跑，但读不到内部数据：${err.message}`;
      }
    }
    return snapshot;
  }

  private mapPower(name?: string): PowerState {
    switch (name) {
      case 'running':
        return 'running';
      case 'pending':
      case 'starting':
        return 'starting';
      case 'stopping':
        return 'stopping';
      case 'stopped':
      case 'terminated':
        return 'stopped';
      default:
        return 'unknown';
    }
  }

  // ---------- 电源 ----------

  async start(ctx: ProviderContext): Promise<void> {
    const ref = this.lsRef(ctx);
    const client = this.client(this.cred(ctx), ref.region);
    const res = await client.send(new StartInstanceCommand({ instanceName: ref.instanceName }));
    await this.waitOperations(client, res.operations?.map((o) => o.id).filter(Boolean) as string[]);
  }

  async stop(ctx: ProviderContext): Promise<void> {
    const ref = this.lsRef(ctx);
    const client = this.client(this.cred(ctx), ref.region);
    const res = await client.send(new StopInstanceCommand({ instanceName: ref.instanceName }));
    await this.waitOperations(client, res.operations?.map((o) => o.id).filter(Boolean) as string[]);
  }

  async reboot(ctx: ProviderContext): Promise<void> {
    const ref = this.lsRef(ctx);
    const client = this.client(this.cred(ctx), ref.region);
    const res = await client.send(new RebootInstanceCommand({ instanceName: ref.instanceName }));
    await this.waitOperations(client, res.operations?.map((o) => o.id).filter(Boolean) as string[]);
  }

  // ---------- 改密 ----------

  async resetPassword(ctx: ProviderContext, newPassword: string): Promise<ResetPasswordResult> {
    if (!ctx.ip || !ctx.auth) throw new Error('缺少机器的 IP 或登录凭据');
    const username = ctx.auth.sshUser || 'root';
    await setRootPassword({ host: ctx.ip, auth: ctx.auth }, username, newPassword);
    return { username, password: newPassword };
  }

  // ---------- 重装 ----------

  async rebuild(ctx: ProviderContext, req: ProvisionRequest): Promise<ProvisionResult> {
    const ref = this.lsRef(ctx);
    const client = this.client(this.cred(ctx), ref.region);
    const progress = req.onProgress ?? (() => undefined);

    await progress(5, '销毁旧实例');
    // 静态 IP 不删，等下重新绑到新实例上，这样用户的 IP 不变
    await client
      .send(new DeleteInstanceCommand({ instanceName: ref.instanceName }))
      .catch((err) => {
        if (!/NotFound/i.test(err?.name ?? '')) throw new Error(this.explain(err));
      });
    await this.waitGone(client, ref.instanceName, 180000);

    await progress(20, '按原配置重新创建');
    return this.provision(ctx, {
      ...req,
      code: ref.instanceName,
      spec: { ...req.spec, staticIp: !!ref.staticIpName },
      onProgress: async (p, s) => progress(20 + Math.round(p * 0.8), s),
    });
  }

  // ---------- 销毁 ----------

  async release(ctx: ProviderContext): Promise<void> {
    const ref = this.lsRef(ctx);
    const client = this.client(this.cred(ctx), ref.region);
    await this.cleanupFailed(client, ref.instanceName, ref.staticIpName);
  }

  // ---------- 监控 ----------

  /**
   * Lightsail 自带监控，直接问 AWS 要曲线，不用往用户机器里装任何东西。
   * 这是它比谷歌云省事的地方 —— 控制台上那条走势带的数据就来自这里。
   */
  async metrics(ctx: ProviderContext, hours = 24): Promise<MetricSeries[]> {
    const ref = this.lsRef(ctx);
    const client = this.client(this.cred(ctx), ref.region);
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - hours * 3600 * 1000);
    // AWS 限制单次最多返回 1440 个点，按小时数动态选采样周期
    const period = Math.max(300, Math.ceil((hours * 3600) / 300 / 60) * 60);

    const defs: { key: MetricSeries['key']; metric: string; label: string; unit: string }[] = [
      { key: 'cpu', metric: 'CPUUtilization', label: 'CPU 使用率', unit: '%' },
      { key: 'net_in', metric: 'NetworkIn', label: '入站流量', unit: 'B' },
      { key: 'net_out', metric: 'NetworkOut', label: '出站流量', unit: 'B' },
    ];

    const out: MetricSeries[] = [];
    for (const def of defs) {
      try {
        const res = await client.send(
          new GetInstanceMetricDataCommand({
            instanceName: ref.instanceName,
            metricName: def.metric as any,
            period,
            startTime,
            endTime,
            unit: def.metric === 'CPUUtilization' ? 'Percent' : 'Bytes',
            statistics: ['Average'],
          }),
        );
        const points = (res.metricData ?? [])
          .filter((d) => d.timestamp)
          .sort((a, b) => a.timestamp!.getTime() - b.timestamp!.getTime())
          .map((d) => ({ t: d.timestamp!.toISOString(), v: Number(d.average ?? 0) }));
        out.push({ key: def.key, label: def.label, unit: def.unit, points });
      } catch (err: any) {
        this.logger.warn(`拉取 ${def.metric} 失败：${err.message}`);
      }
    }
    return out;
  }

  // ---------- 内部工具 ----------

  private assertSpec(spec: LightsailSpec): void {
    const missing = ['availabilityZone', 'bundleId', 'blueprintId'].filter(
      (k) => !(spec as any)?.[k],
    );
    if (missing.length) {
      throw new Error(
        `套餐的 Lightsail 参数缺了：${missing.join('、')}。` +
          '请在后台套餐编辑页把「可用区 / 规格 / 系统镜像」填上。',
      );
    }
    if (!/[a-z]$/.test(spec.availabilityZone)) {
      throw new Error(
        `可用区写错了：${spec.availabilityZone}。可用区结尾要带字母，` +
          '比如 ap-southeast-1a，不是 ap-southeast-1',
      );
    }
  }

  /** Lightsail 的每个动作都返回一组 operation，要等它们全部 Succeeded */
  private async waitOperations(client: LightsailClient, ids: string[]): Promise<void> {
    if (!ids?.length) return;
    const deadline = Date.now() + 300000;
    const pending = new Set(ids);
    while (pending.size && Date.now() < deadline) {
      for (const id of [...pending]) {
        const res = await client.send(new GetOperationCommand({ operationId: id }));
        const status = res.operation?.status;
        if (status === 'Succeeded' || status === 'Completed') {
          pending.delete(id);
        } else if (status === 'Failed') {
          throw new Error(
            `AWS 操作失败：${res.operation?.errorDetails ?? res.operation?.errorCode ?? '未知原因'}`,
          );
        }
      }
      if (pending.size) await sleep(3000);
    }
    if (pending.size) throw new Error('AWS 操作超过 5 分钟仍未完成');
  }

  private async waitState(
    client: LightsailClient,
    instanceName: string,
    want: string,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await client.send(new GetInstanceStateCommand({ instanceName }));
      if (res.state?.name === want) return;
      await sleep(4000);
    }
    throw new Error(`等待实例进入 ${want} 状态超时`);
  }

  private async waitGone(
    client: LightsailClient,
    instanceName: string,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await client.send(new GetInstanceCommand({ instanceName }));
        await sleep(4000);
      } catch (err: any) {
        if (/NotFound/i.test(err?.name ?? '')) return;
        throw err;
      }
    }
    throw new Error('等待旧实例销毁超时');
  }

  private async attachStaticIp(
    client: LightsailClient,
    instanceName: string,
    staticIpName: string,
  ): Promise<string> {
    await client.send(new AllocateStaticIpCommand({ staticIpName })).catch((err) => {
      // 已经存在就复用（重装场景）
      if (!/AlreadyExists|InvalidInput/i.test(err?.name ?? '')) throw err;
    });
    const res = await client.send(
      new AttachStaticIpCommand({ staticIpName, instanceName }),
    );
    await this.waitOperations(client, res.operations?.map((o) => o.id).filter(Boolean) as string[]);

    const inst = await client.send(new GetInstanceCommand({ instanceName }));
    const ip = inst.instance?.publicIpAddress;
    if (!ip) throw new Error('静态 IP 绑定后没读到地址');
    return ip;
  }

  private async applyPorts(
    client: LightsailClient,
    instanceName: string,
    ports: OpenPort[],
  ): Promise<void> {
    await client
      .send(
        new PutInstancePublicPortsCommand({
          instanceName,
          portInfos: ports.map((p) => ({
            fromPort: p.from,
            toPort: p.to,
            protocol: p.protocol,
            cidrs: ['0.0.0.0/0'],
            ipv6Cidrs: ['::/0'],
          })),
        }),
      )
      .catch((err) => this.logger.warn(`设置防火墙失败（不影响交付）：${err.message}`));
  }

  /** 建机失败或销毁时的清理。两个资源都要清，静态 IP 留着会一直计费。 */
  private async cleanupFailed(
    client: LightsailClient,
    instanceName: string,
    staticIpName?: string,
  ): Promise<void> {
    await client
      .send(new DeleteInstanceCommand({ instanceName }))
      .catch((err) => {
        if (!/NotFound/i.test(err?.name ?? '')) {
          this.logger.warn(`销毁实例 ${instanceName} 失败：${err.message}`);
        }
      });
    if (staticIpName) {
      await client
        .send(new ReleaseStaticIpCommand({ staticIpName }))
        .catch((err) => this.logger.warn(`释放静态 IP ${staticIpName} 失败：${err.message}`));
    }
  }

  /** AWS 的报错代码翻译成能照着解决的中文 */
  private explain(err: any): string {
    const name: string = err?.name ?? '';
    const msg: string = err?.message ?? String(err);

    if (/InvalidClientTokenId|UnrecognizedClient|SignatureDoesNotMatch/i.test(name + msg)) {
      return 'AWS 密钥无效。请到 IAM 里确认 Access Key ID 和 Secret Access Key 都没抄错，且这把密钥还是启用状态';
    }
    if (/AccessDenied|UnauthorizedOperation|NotAuthorized/i.test(name + msg)) {
      return (
        'AWS 权限不够。请给这个 IAM 用户附加 AmazonLightsailFullAccess 策略' +
        '（IAM → 用户 → 添加权限 → 直接附加策略）'
      );
    }
    if (/InvalidInputException/i.test(name)) {
      return `AWS 说参数不对：${msg}。常见原因是可用区、规格 ID 或镜像 ID 在这个区域不存在`;
    }
    if (/ServiceException|OperationFailure/i.test(name)) {
      return `AWS 服务端出错：${msg}。稍等片刻重试，或换一个可用区`;
    }
    if (/AccountSetupInProgress/i.test(name)) {
      return 'AWS 账号还在初始化中（新注册的账号常见），等几分钟再试';
    }
    if (/NotFound/i.test(name)) {
      return `AWS 说找不到对应资源：${msg}`;
    }
    return `AWS 返回错误：${name ? name + ' - ' : ''}${msg}`;
  }
}
