import { Injectable, Logger } from '@nestjs/common';
import {
  AddressesClient,
  InstancesClient,
  MachineTypesClient,
  RegionOperationsClient,
  ZoneOperationsClient,
} from '@google-cloud/compute';
import {
  CredentialCheckResult,
  GcpCredentials,
  GcpRef,
  MachineStatusSnapshot,
  PowerState,
  ProviderContext,
  ProvisionRequest,
  ProvisionResult,
  ResetPasswordResult,
  VpsProvider,
  toInstanceName,
} from '../provider.types';
import {
  buildBootstrapCheckCommand,
  buildBootstrapScript,
} from '../bootstrap.util';
import {
  SshTarget,
  probeMachine,
  setRootPassword,
  sleep,
  sshExec,
  waitForSsh,
} from '../ssh-exec.util';

/**
 * 谷歌云 Compute Engine 驱动。
 *
 * 用的都是公开 REST API（@google-cloud/compute 是官方 SDK 的一层封装），
 * 和你在谷歌云控制台里点按钮走的是同一套接口。
 *
 * 有一件事必须先说清楚：**谷歌云没有「重装系统」这个 API。**
 * 控制台上也没有这个按钮。所谓重装的真实含义是「删掉实例再用同样的参数建一个」。
 * 所以套餐里如果不开静态 IP，用户重装完 IP 就变了 —— 这是转售场景下最容易挨投诉的地方，
 * 因此本驱动在 spec.staticIp 为 true 时会先占一个静态地址再建机。
 */

interface GcpSpec {
  /** 可用区，比如 asia-northeast1-a */
  zone: string;
  /** 机型，比如 e2-small / e2-medium */
  machineType: string;
  /** 系统镜像，比如 projects/debian-cloud/global/images/family/debian-12 */
  sourceImage: string;
  diskGb?: number;
  /** pd-standard（便宜） / pd-balanced（默认） / pd-ssd（快） */
  diskType?: string;
  /** 是否占一个静态公网 IP。转售建议开，否则重启/重装后 IP 会变。 */
  staticIp?: boolean;
  /** VPC 网络名，一般就是 default */
  network?: string;
  enableBbr?: boolean;
}

@Injectable()
export class GcpProvider implements VpsProvider {
  readonly kind = 'gcp' as const;
  readonly canProvision = true;
  readonly canRebuild = true;
  readonly hasMetrics = false;

  private readonly logger = new Logger(GcpProvider.name);

  // ---------- 客户端 ----------

  private clientOptions(cred: GcpCredentials) {
    if (!cred?.projectId) {
      throw new Error('谷歌云账号没填项目 ID（projectId）');
    }
    if (!cred?.serviceAccountKey?.client_email) {
      throw new Error(
        '谷歌云服务账号密钥不对：JSON 里应该有 client_email 和 private_key 两个字段，' +
          '请确认你上传的是「服务账号密钥」而不是别的 JSON',
      );
    }
    return {
      projectId: cred.projectId,
      credentials: {
        client_email: cred.serviceAccountKey.client_email,
        private_key: cred.serviceAccountKey.private_key,
      },
    };
  }

  private cred(ctx: ProviderContext): GcpCredentials {
    return ctx.credentials as GcpCredentials;
  }

  private gcpRef(ctx: ProviderContext): GcpRef {
    const ref = ctx.ref as GcpRef;
    if (!ref?.instanceName || !ref?.zone) {
      throw new Error('这台机器缺少谷歌云的实例标识（zone / instanceName），无法操作');
    }
    return ref;
  }

  /** asia-northeast1-a → asia-northeast1 */
  private regionOf(zone: string): string {
    return zone.replace(/-[a-z]$/, '');
  }

  // ---------- 凭据校验 ----------

  async verifyCredentials(credentials: GcpCredentials): Promise<CredentialCheckResult> {
    try {
      const opts = this.clientOptions(credentials);
      // 列机型是只读操作，权限要求最低，用来验「凭据对不对 + 项目存不存在」正合适
      const client = new MachineTypesClient(opts);
      const [list] = await client.list({
        project: credentials.projectId,
        zone: 'us-central1-a',
        maxResults: 1,
      });
      return {
        ok: true,
        message: '连接成功',
        detail: {
          项目: credentials.projectId,
          服务账号: credentials.serviceAccountKey.client_email,
          探测机型数: list.length,
        },
      };
    } catch (err: any) {
      return { ok: false, message: this.explain(err) };
    }
  }

  // ---------- 建机 ----------

  async provision(ctx: ProviderContext, req: ProvisionRequest): Promise<ProvisionResult> {
    const cred = this.cred(ctx);
    const spec = req.spec as GcpSpec;
    this.assertSpec(spec);

    const opts = this.clientOptions(cred);
    const project = cred.projectId;
    const zone = spec.zone;
    const region = this.regionOf(zone);
    const instanceName = toInstanceName(req.code);
    const progress = req.onProgress ?? (() => undefined);

    const instances = new InstancesClient(opts);
    const staticIpName = spec.staticIp ? `${instanceName}-ip` : undefined;
    let natIP: string | undefined;

    // 0. 先把「我要建什么」告诉上层并落库。任何一步炸了，回滚都有据可查。
    await req.onRefKnown?.({ projectId: project, zone, instanceName, staticIpName });

    // 1. 静态 IP。必须在建机之前占好，因为它要作为参数传进实例。
    if (staticIpName) {
      await progress(6, '申请静态公网 IP');
      try {
        natIP = await this.ensureStaticIp(opts, project, region, staticIpName);
      } catch (err: any) {
        throw new Error(this.explain(err));
      }
    }

    // 2. 提交建机请求
    await progress(15, '向谷歌云提交建机请求');
    const bootstrap = buildBootstrapScript({
      username: 'root',
      password: req.password,
      publicKeyOpenssh: req.publicKeyOpenssh,
      hostname: req.hostname,
      enableBbr: spec.enableBbr !== false,
    });

    const instanceResource: any = {
      name: instanceName,
      machineType: `zones/${zone}/machineTypes/${spec.machineType}`,
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: spec.sourceImage,
            diskSizeGb: String(spec.diskGb ?? 20),
            diskType: `zones/${zone}/diskTypes/${spec.diskType ?? 'pd-balanced'}`,
          },
        },
      ],
      networkInterfaces: [
        {
          name: 'nic0',
          network: `global/networks/${spec.network ?? 'default'}`,
          accessConfigs: [
            {
              name: 'External NAT',
              type: 'ONE_TO_ONE_NAT',
              networkTier: 'PREMIUM',
              ...(natIP ? { natIP } : {}),
            },
          ],
        },
      ],
      metadata: {
        items: [
          // 同时塞 ssh-keys 和 startup-script：前者让面板能立刻用密钥进去，
          // 后者负责设密码和开 root 登录
          { key: 'ssh-keys', value: `root:${req.publicKeyOpenssh}` },
          { key: 'startup-script', value: bootstrap },
          // 关掉 guest agent 对 sshd 的接管，否则我们改的配置会被它改回去
          { key: 'block-project-ssh-keys', value: 'true' },
        ],
      },
      labels: {
        'managed-by': 'vps-resale-panel',
        'panel-code': instanceName,
      },
      tags: { items: ['vps-panel'] },
      scheduling: { automaticRestart: true, onHostMaintenance: 'MIGRATE' },
    };

    try {
      const [op] = await instances.insert({ project, zone, instanceResource });
      await progress(30, '谷歌云正在创建实例');
      await this.waitZoneOp(opts, project, zone, this.opName(op));
    } catch (err: any) {
      // 建机失败时把已经占掉的静态 IP 还回去，否则它会一直计费
      if (staticIpName) {
        await this.releaseStaticIp(opts, project, region, staticIpName).catch(() => undefined);
      }
      throw new Error(this.explain(err));
    }

    // 3. 取公网 IP
    await progress(55, '读取实例网络信息');
    const ip = natIP ?? (await this.fetchExternalIp(opts, project, zone, instanceName).catch((err) => {
      throw new Error(this.explain(err));
    }));
    if (!ip) {
      throw new Error('实例建出来了但没拿到公网 IP，请检查套餐里的网络配置是否给了外部访问权限');
    }

    const ref: GcpRef = { projectId: project, zone, instanceName, staticIpName };
    const auth = { sshUser: 'root', sshPort: 22, password: req.password, privateKey: req.privateKeyPem };

    // 4. 等系统起来 + 初始化脚本跑完
    await this.waitUntilReady({ host: ip, auth }, progress);

    return {
      ref,
      ip,
      auth,
      osTemplate: spec.sourceImage.split('/').pop(),
      raw: { instanceName, zone, staticIpName },
    };
  }

  /**
   * 等到机器真正可交付。
   *
   * 分两步，而且第二步不能省：SSH 通了不代表初始化脚本跑完了 ——
   * startup-script 和 sshd 是并行启动的，很可能能连上但 root 密码还没设。
   * 这时候把凭据交付给用户，用户一登就是密码错误。
   */
  private async waitUntilReady(
    target: SshTarget,
    progress: (p: number, s: string) => Promise<void> | void,
  ): Promise<void> {
    await progress(65, '等待系统启动并开放 SSH');
    await waitForSsh(target, {
      timeoutMs: 240000,
      intervalMs: 6000,
      onAttempt: (n) => {
        if (n % 5 === 0) void progress(70, `等待 SSH 就绪（第 ${n} 次尝试）`);
      },
    });

    await progress(85, '等待系统初始化完成');
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
      '系统初始化脚本超过 3 分钟还没跑完。机器已经建出来了，' +
        '可以到后台机器列表里手动重试，或者 SSH 进去看 /var/log/vps-panel-bootstrap.log',
    );
  }

  // ---------- 状态 ----------

  async getStatus(ctx: ProviderContext): Promise<MachineStatusSnapshot> {
    const cred = this.cred(ctx);
    const ref = this.gcpRef(ctx);
    const opts = this.clientOptions(cred);
    const instances = new InstancesClient(opts);

    const [instance] = await instances.get({
      project: ref.projectId,
      zone: ref.zone,
      instance: ref.instanceName,
    });

    const power = this.mapPower(instance.status ?? undefined);
    const ip =
      instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? ctx.ip ?? undefined;

    const snapshot: MachineStatusSnapshot = {
      power,
      ip: ip ?? undefined,
      checkedAt: new Date().toISOString(),
      raw: { gcpStatus: instance.status },
    };

    // 谷歌云的 API 只给得出电源状态，CPU/内存/磁盘这些要进机器里采。
    // 关机状态下就不白费力气去连了。
    if (power === 'running' && ip && ctx.auth) {
      try {
        const probe = await probeMachine({ host: ip, auth: ctx.auth });
        Object.assign(snapshot, probe);
      } catch (err: any) {
        snapshot.note = `实例在跑，但读不到内部数据：${err.message}`;
      }
    }
    return snapshot;
  }

  private mapPower(status?: string): PowerState {
    switch (status) {
      case 'RUNNING':
        return 'running';
      case 'PROVISIONING':
      case 'STAGING':
        return 'starting';
      case 'STOPPING':
      case 'SUSPENDING':
        return 'stopping';
      case 'TERMINATED':
      case 'STOPPED':
      case 'SUSPENDED':
        return 'stopped';
      default:
        return 'unknown';
    }
  }

  // ---------- 电源操作 ----------

  async start(ctx: ProviderContext): Promise<void> {
    await this.power(ctx, 'start');
  }

  async stop(ctx: ProviderContext): Promise<void> {
    await this.power(ctx, 'stop');
  }

  async reboot(ctx: ProviderContext): Promise<void> {
    await this.power(ctx, 'reset');
  }

  private async power(ctx: ProviderContext, action: 'start' | 'stop' | 'reset'): Promise<void> {
    const cred = this.cred(ctx);
    const ref = this.gcpRef(ctx);
    const opts = this.clientOptions(cred);
    const instances = new InstancesClient(opts);
    try {
      const [op] = await instances[action]({
        project: ref.projectId,
        zone: ref.zone,
        instance: ref.instanceName,
      });
      await this.waitZoneOp(opts, ref.projectId, ref.zone, this.opName(op));
    } catch (err: any) {
      throw new Error(this.explain(err));
    }
  }

  // ---------- 改密 ----------

  async resetPassword(ctx: ProviderContext, newPassword: string): Promise<ResetPasswordResult> {
    const ip = ctx.ip;
    if (!ip || !ctx.auth) throw new Error('缺少机器的 IP 或登录凭据');
    const username = ctx.auth.sshUser || 'root';

    // 走面板专用密钥进去改。用户就算把自己的密码改了，面板这条路也不受影响。
    await setRootPassword({ host: ip, auth: ctx.auth }, username, newPassword);
    return { username, password: newPassword };
  }

  // ---------- 重装 ----------

  /**
   * 谷歌云没有 rebuild API，重装 = 删了重建。
   * 静态 IP 不跟着实例删，所以只要套餐开了 staticIp，重装后 IP 不变。
   */
  async rebuild(ctx: ProviderContext, req: ProvisionRequest): Promise<ProvisionResult> {
    const cred = this.cred(ctx);
    const ref = this.gcpRef(ctx);
    const opts = this.clientOptions(cred);
    const progress = req.onProgress ?? (() => undefined);

    await progress(5, '销毁旧实例');
    await this.deleteInstance(opts, ref.projectId, ref.zone, ref.instanceName);

    await progress(20, '按原配置重新创建');
    // 复用 provision，但要保证实例名和静态 IP 名不变，这样 IP 才能接回来
    return this.provision(ctx, {
      ...req,
      code: ref.instanceName,
      spec: { ...req.spec, staticIp: !!ref.staticIpName },
      onProgress: async (p, s) => progress(20 + Math.round(p * 0.8), s),
    });
  }

  // ---------- 销毁 ----------

  async release(ctx: ProviderContext): Promise<void> {
    const cred = this.cred(ctx);
    const ref = this.gcpRef(ctx);
    const opts = this.clientOptions(cred);

    await this.deleteInstance(opts, ref.projectId, ref.zone, ref.instanceName);

    // 静态 IP 是单独计费的资源，实例删了它还在扣钱，必须一起释放
    if (ref.staticIpName) {
      await this.releaseStaticIp(
        opts,
        ref.projectId,
        this.regionOf(ref.zone),
        ref.staticIpName,
      ).catch((err) => this.logger.warn(`释放静态 IP 失败：${err.message}`));
    }
  }

  // ---------- 内部工具 ----------

  private assertSpec(spec: GcpSpec): void {
    const missing = ['zone', 'machineType', 'sourceImage'].filter((k) => !(spec as any)?.[k]);
    if (missing.length) {
      throw new Error(
        `套餐的谷歌云参数缺了：${missing.join('、')}。` +
          '请在后台套餐编辑页把「可用区 / 机型 / 系统镜像」填上。',
      );
    }
  }

  private opName(op: any): string {
    const name = op?.latestResponse?.name ?? op?.name;
    if (!name) throw new Error('谷歌云没有返回操作句柄，无法确认建机是否成功');
    return name;
  }

  private async waitZoneOp(opts: any, project: string, zone: string, opName: string) {
    const client = new ZoneOperationsClient(opts);
    const deadline = Date.now() + 300000;
    let op: any = { name: opName, status: 'RUNNING' };
    while (op.status !== 'DONE' && Date.now() < deadline) {
      [op] = await client.wait({ operation: op.name ?? opName, project, zone });
    }
    if (op.status !== 'DONE') throw new Error('谷歌云操作超过 5 分钟仍未完成');
    if (op.error) {
      throw new Error(
        `谷歌云操作失败：${op.error.errors?.map((e: any) => e.message).join('；') ?? '未知原因'}`,
      );
    }
  }

  private async waitRegionOp(opts: any, project: string, region: string, opName: string) {
    const client = new RegionOperationsClient(opts);
    const deadline = Date.now() + 180000;
    let op: any = { name: opName, status: 'RUNNING' };
    while (op.status !== 'DONE' && Date.now() < deadline) {
      [op] = await client.wait({ operation: op.name ?? opName, project, region });
    }
  }

  private async ensureStaticIp(
    opts: any,
    project: string,
    region: string,
    name: string,
  ): Promise<string> {
    const addresses = new AddressesClient(opts);
    try {
      const [existing] = await addresses.get({ project, region, address: name });
      if (existing?.address) return existing.address;
    } catch {
      // 不存在，往下建
    }
    const [op] = await addresses.insert({
      project,
      region,
      addressResource: { name, addressType: 'EXTERNAL', networkTier: 'PREMIUM' },
    });

    // 从这里开始地址已经真实存在并开始计费了，后面任何一步失败都必须还回去
    try {
      await this.waitRegionOp(opts, project, region, this.opName(op));
      const [created] = await addresses.get({ project, region, address: name });
      if (!created?.address) throw new Error('静态 IP 申请成功但没拿到地址');
      return created.address;
    } catch (err) {
      await this.releaseStaticIp(opts, project, region, name).catch(() => undefined);
      throw err;
    }
  }

  private async releaseStaticIp(opts: any, project: string, region: string, name: string) {
    const addresses = new AddressesClient(opts);
    const [op] = await addresses.delete({ project, region, address: name });
    await this.waitRegionOp(opts, project, region, this.opName(op));
  }

  private async deleteInstance(opts: any, project: string, zone: string, instance: string) {
    const instances = new InstancesClient(opts);
    try {
      const [op] = await instances.delete({ project, zone, instance });
      await this.waitZoneOp(opts, project, zone, this.opName(op));
    } catch (err: any) {
      // 已经不存在了就当删成功 —— 销毁是幂等的
      if (err?.code === 5 || /not found/i.test(err?.message ?? '')) return;
      throw new Error(this.explain(err));
    }
  }

  private async fetchExternalIp(
    opts: any,
    project: string,
    zone: string,
    instance: string,
  ): Promise<string | undefined> {
    const instances = new InstancesClient(opts);
    for (let i = 0; i < 10; i++) {
      const [inst] = await instances.get({ project, zone, instance });
      const ip = inst.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
      if (ip) return ip;
      await sleep(3000);
    }
    return undefined;
  }

  /** 把谷歌云那些英文报错翻译成能照着解决的中文 */
  private explain(err: any): string {
    const msg: string = err?.message ?? String(err);
    if (
      /invalid authentication credentials|Expected OAuth 2 access token|UNAUTHENTICATED/i.test(msg)
    ) {
      return (
        '谷歌云不认这份密钥。三种可能：密钥已经在控制台被删了、粘贴时少了几行、' +
        '或者这个服务账号属于另一个项目。建议重新下载一份 JSON 密钥再填一遍。'
      );
    }
    if (/invalid_grant|Invalid JWT Signature|account not found/i.test(msg)) {
      return (
        '密钥签名校验没过，通常是 JSON 内容被改动过（比如换行被编辑器吃掉了）。' +
        '请重新下载原始的 .json 文件，不要用记事本以外的工具编辑它。'
      );
    }
    if (/could not load the default credentials/i.test(msg)) {
      return '服务账号密钥无效或已过期，请到谷歌云控制台重新生成一份 JSON 密钥';
    }
    if (/clock|JWT.*(iat|exp)|token.*expired/i.test(msg)) {
      return '服务器时间不对导致密钥被拒。请检查这台服务器的系统时间是否准确（时间差超过 5 分钟就会失败）';
    }
    if (/Permission .* denied|IAM_PERMISSION_DENIED|does not have .*permission/i.test(msg)) {
      return (
        '服务账号权限不够。请到「IAM 和管理 → IAM」里给这个服务账号加上' +
        '「Compute 实例管理员 (v1)」角色（roles/compute.instanceAdmin.v1）'
      );
    }
    if (/Quota .* exceeded|QUOTA_EXCEEDED/i.test(msg)) {
      return '谷歌云配额不够了。到「IAM 和管理 → 配额」里申请提升对应区域的 CPU 或 IP 配额';
    }
    if (/already exists|ALREADY_EXISTS/i.test(msg)) {
      return '同名实例已经存在。可能是上次建机失败留下的残留，到谷歌云控制台删掉后重试';
    }
    if (/Compute Engine API has not been used|SERVICE_DISABLED/i.test(msg)) {
      return '这个项目还没启用 Compute Engine API。到「API 和服务 → 库」里搜 Compute Engine API 并启用';
    }
    if (/was not found|notFound/i.test(msg)) {
      return `谷歌云说找不到对应资源，请检查套餐里的可用区、机型、镜像名是否写对：${msg}`;
    }
    if (/billing/i.test(msg)) {
      return '这个项目没有绑定结算账号，谷歌云不允许创建实例。请先在控制台绑定结算账号';
    }
    return `谷歌云返回错误：${msg}`;
  }
}
