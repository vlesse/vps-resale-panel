/**
 * 驱动层契约。
 *
 * 四个驱动实现同一个接口，上层（订单、服务控制台、到期任务）只认这个接口，
 * 不知道机器是谷歌云的、Lightsail 的、自有的还是 PVE 上的。
 *
 * 能力不是所有驱动都齐全，所以接口上带了三个能力位：
 *   canProvision  能不能凭空建出一台机器（gcp / lightsail 能，ssh / proxmox 不能）
 *   canRebuild    能不能重装（四个都能，但 gcp / lightsail 的重装 = 销毁重建）
 *   hasMetrics    能不能从云厂商直接拿监控曲线（lightsail 能，其它靠 SSH 采）
 */

export type ProviderKindValue = 'gcp' | 'lightsail' | 'ssh' | 'proxmox';

// ---------- 云账号凭据（AES 解密后的明文） ----------

export interface GcpCredentials {
  projectId: string;
  /** 服务账号 JSON key 的全文 */
  serviceAccountKey: Record<string, any>;
}

export interface LightsailCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface ProxmoxCredentials {
  host: string;
  port?: number;
  node: string;
  tokenId: string;
  tokenSecret: string;
  /** 自签证书的 PVE 要设 false */
  rejectUnauthorized?: boolean;
}

export type ProviderCredentials =
  | GcpCredentials
  | LightsailCredentials
  | ProxmoxCredentials
  | Record<string, never>;

// ---------- 机器在云厂商那边的身份 ----------

export interface GcpRef {
  projectId: string;
  zone: string;
  instanceName: string;
  /** 预留的静态地址名。重装（销毁重建）时靠它把 IP 保住。 */
  staticIpName?: string;
}

export interface LightsailRef {
  region: string;
  instanceName: string;
  staticIpName?: string;
}

export interface ProxmoxRef {
  node: string;
  vmid: number;
}

/** ssh 驱动没有云端身份，靠 ip + 端口定位 */
export type SshRef = Record<string, never>;

export type ProviderRef = GcpRef | LightsailRef | ProxmoxRef | SshRef;

// ---------- 机器上的登录凭据 ----------

export interface MachineAuth {
  sshUser: string;
  sshPort: number;
  /** 交付给用户的密码 */
  password?: string;
  /** 面板专用私钥。用户改了密码也不影响面板操作。 */
  privateKey?: string;
}

// ---------- 建机 ----------

export interface ProvisionRequest {
  /** 机器编号，同时用作云厂商那边的实例名。已保证符合各家命名规则（小写字母数字连字符）。 */
  code: string;
  /** Plan.providerSpecJson，形状由各驱动自己解释 */
  spec: Record<string, any>;
  /** 装进机器的主机名 */
  hostname?: string;
  /** 要交付给用户的 root 密码，由上层生成（上层需要提前知道它好写进交付信息） */
  password: string;
  /** 面板专用公钥，写进 authorized_keys */
  publicKeyOpenssh: string;
  /** 面板专用私钥，配套上面那把 */
  privateKeyPem: string;
  /** 进度回调，写进 ProvisionJob 供前端轮询显示 */
  onProgress?: (percent: number, step: string) => Promise<void> | void;

  /**
   * 一知道要在云上创建什么就立刻回调，**必须在真正下达创建指令之前**。
   *
   * 为什么这个回调不能省：建机是分步的，「提交创建请求」和「确认创建完成」
   * 之间可能断电、超时、进程被杀。如果等建完才把云端标识写库，
   * 那个窗口里出事就会留下一台在云上真实存在、真实计费、而面板完全不知道的实例。
   * 先写下「我打算建一台叫 X 的机器」，回滚时就总有东西可删（删不存在的实例是幂等的）。
   */
  onRefKnown?: (ref: ProviderRef) => Promise<void> | void;
}

export interface ProvisionResult {
  ref: ProviderRef;
  ip: string;
  ipv6?: string;
  auth: MachineAuth;
  osTemplate?: string;
  /** 原始返回，出问题时排查用 */
  raw?: Record<string, any>;
}

// ---------- 状态 ----------

export type PowerState =
  | 'running'
  | 'stopped'
  | 'starting'
  | 'stopping'
  | 'rebuilding'
  | 'unknown';

export interface MachineStatusSnapshot {
  power: PowerState;
  ip?: string;
  cpuPercent?: number;
  memUsedMb?: number;
  memTotalMb?: number;
  diskUsedGb?: number;
  diskTotalGb?: number;
  uptimeSec?: number;
  loadAvg1?: number;
  netInBytes?: number;
  netOutBytes?: number;
  checkedAt: string;
  /** 拿不到细节时说明原因，前端直接显示给用户 */
  note?: string;
  raw?: Record<string, any>;
}

export interface MetricPoint {
  t: string;
  v: number;
}

export interface MetricSeries {
  key: 'cpu' | 'net_in' | 'net_out';
  label: string;
  unit: string;
  points: MetricPoint[];
}

// ---------- 调用上下文 ----------

/** 每次调驱动都带上：用哪个账号的凭据、操作哪台机器、怎么登进去 */
export interface ProviderContext {
  credentials: ProviderCredentials;
  ref?: ProviderRef;
  auth?: MachineAuth;
  ip?: string;
}

export interface CredentialCheckResult {
  ok: boolean;
  message: string;
  /** 校验通过时顺便回一些账号信息，后台显示出来让人确认没连错项目 */
  detail?: Record<string, any>;
}

export interface ResetPasswordResult {
  username: string;
  password: string;
}

// ---------- 驱动接口 ----------

export interface VpsProvider {
  readonly kind: ProviderKindValue;
  readonly canProvision: boolean;
  readonly canRebuild: boolean;
  readonly hasMetrics: boolean;

  /** 后台点「测试连接」时调，确认凭据能用、项目/区域没填错 */
  verifyCredentials(credentials: ProviderCredentials): Promise<CredentialCheckResult>;

  /** 建一台新机器。只有 canProvision 的驱动实现，其它直接抛错。 */
  provision(ctx: ProviderContext, req: ProvisionRequest): Promise<ProvisionResult>;

  getStatus(ctx: ProviderContext): Promise<MachineStatusSnapshot>;

  start(ctx: ProviderContext): Promise<void>;
  stop(ctx: ProviderContext): Promise<void>;
  reboot(ctx: ProviderContext): Promise<void>;

  resetPassword(ctx: ProviderContext, newPassword: string): Promise<ResetPasswordResult>;

  /** 重装。gcp / lightsail 是销毁重建（IP 靠静态地址保住），proxmox 是克隆模板，ssh 是软重置。 */
  rebuild(ctx: ProviderContext, req: ProvisionRequest): Promise<ProvisionResult>;

  /** 销毁机器并释放计费资源。到期回收和退款都走它。 */
  release(ctx: ProviderContext): Promise<void>;

  /** 监控曲线，只有 hasMetrics 的驱动实现 */
  metrics?(ctx: ProviderContext, hours: number): Promise<MetricSeries[]>;
}

// ---------- 工具 ----------

/** 各家云对实例名的要求都是「小写字母开头、只含小写字母数字和连字符」，统一在这里归一化 */
export function toInstanceName(code: string, prefix = 'vps'): string {
  const cleaned = code
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const name = /^[a-z]/.test(cleaned) ? cleaned : `${prefix}-${cleaned}`;
  return name.slice(0, 62);
}

export class ProviderNotCapableError extends Error {
  constructor(kind: ProviderKindValue, capability: string) {
    super(`${kind} 驱动不支持「${capability}」`);
    this.name = 'ProviderNotCapableError';
  }
}
