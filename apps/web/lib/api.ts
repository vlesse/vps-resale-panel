'use client';

/**
 * 后端接口客户端。
 *
 * 令牌存在 localStorage：面板是纯前后端分离的，后端不下发 Cookie，
 * 而且用户经常在手机内嵌浏览器里打开，Cookie 在那些环境里行为不一致。
 */

const TOKEN_KEY = 'vps_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    // 隐私模式下 localStorage 会直接抛错
    return null;
  }
}

export function setToken(token: string | null) {
  if (typeof window === 'undefined') return;
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 存不了就算了，用户这次会话内还是能用 */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: any,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };

  const token = getToken();
  if (token && init.auth !== false) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, cache: 'no-store' });
  } catch {
    throw new ApiError('连不上服务器，检查一下网络', 0);
  }

  // 204 之类没有响应体
  const text = await res.text();
  const data = text ? safeJson(text) : null;

  if (!res.ok) {
    // 令牌过期或被停用：清掉本地令牌，让页面自己跳登录
    if (res.status === 401) setToken(null);
    const msg =
      (Array.isArray(data?.message) ? data.message[0] : data?.message) ||
      data?.error ||
      `请求失败（${res.status}）`;
    throw new ApiError(String(msg), res.status, data);
  }
  return data as T;
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    // 后端有的接口回纯文本（比如支付回调回 success）
    return text;
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: any) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: any) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  /** 不带令牌的公开接口 */
  publicGet: <T>(path: string) => request<T>(path, { auth: false }),
  publicPost: <T>(path: string, body?: any) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body), auth: false }),
};

// ---------- 类型 ----------

export interface Me {
  id: string;
  email: string;
  displayName: string | null;
  phone: string | null;
  role: 'customer' | 'admin';
  status: 'active' | 'blocked';
  maxActiveServices: number;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface PlanPrice {
  id: string;
  cycle: 'monthly' | 'quarterly' | 'yearly';
  currency: 'CNY' | 'USD';
  priceCents: number;
}

export interface Availability {
  inStock: boolean;
  label: string;
  stockCount: number | null;
  adminReason?: string;
}

export interface PublicPlan {
  id: string;
  name: string;
  slug: string;
  regionLabel: string;
  cpu: number;
  memoryMb: number;
  diskGb: number;
  trafficGb: number | null;
  bandwidthLabel: string | null;
  osTemplate: string | null;
  description: string | null;
  features: string[];
  prices: PlanPrice[];
  availability: Availability;
  capabilities: { canPowerOn: boolean; canRebuild: boolean };
  sortOrder: number;

  /** 选购页按这个分栏。没填分类的老套餐是 'other' / '其它'。 */
  categoryKey: string;
  categoryLabel: string;
  categorySort: number;

  /** 自定义档：不是固定规格，用户自己选核心 / 内存 / 硬盘 */
  isCustom: boolean;
  custom: CustomOffer | null;
}

export interface CustomOffer {
  machineFamily: string;
  disk: { minGb: number; maxGb: number; stepGb: number };
  /** 价格系数，按币种分开。前端拿它实时算价，服务端下单时会重算一遍。 */
  price: Record<string, {
    baseCents: number;
    perCpuCents: number;
    perGbRamCents: number;
    perGbDiskCents: number;
  }>;
  defaults: { cpu: number; memoryMb: number; diskGb: number };
  /** 每个核心数下内存的可选范围不一样，服务端算好了直接用 */
  cpuOptions: { cpu: number; memory: { minGb: number; maxGb: number; stepGb: number } }[];
}

export function priceCustomLocal(
  offer: CustomOffer,
  spec: { cpu: number; memoryMb: number; diskGb: number },
  currency: string,
): number | null {
  const r = offer.price[currency];
  if (!r) return null;
  return Math.round(
    r.baseCents +
      spec.cpu * r.perCpuCents +
      (spec.memoryMb / 1024) * r.perGbRamCents +
      spec.diskGb * r.perGbDiskCents,
  );
}

export interface ServiceItem {
  id: string;
  serviceNo: string;
  status: 'provisioning' | 'active' | 'stopped' | 'suspended' | 'expired' | 'cancelled' | 'error';
  planName?: string;
  regionLabel?: string;
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
  /** 买家该去连的地址。NAT 机器给的是入口地址，不是它自己的私网地址。 */
  ip: string | null;
  sshPort?: number;
  /** 是不是 NAT 机器 —— 列表上要标出来，免得买家以为自己买到了独立 IP */
  isNat?: boolean;
  startAt: string | null;
  expireAt: string;
  daysLeft: number;
  suspendReason: string | null;
}

export interface LiveStatus {
  power: 'running' | 'stopped' | 'starting' | 'stopping' | 'rebuilding' | 'unknown';
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
  note?: string;
}

export interface ServiceDetail extends ServiceItem {
  deliver: {
    ip?: string;
    sshPort?: number;
    username?: string;
    password?: string;
    osTemplate?: string;
    region?: string;
    /** NAT 机器才有：机器自己在私网里的地址，以及分到的公网端口段 */
    nat?: { internalIp: string; portStart: number; portEnd: number };
  } | null;
  liveStatus: LiveStatus | null;
  /** 实时探测失败时的原因。读数会退回上一次采集到的值，页面照常能用。 */
  statusError: string | null;
  lastCheckedAt: string | null;
  /** 没有绑定机器时是 null —— 别当成「一台什么都不支持的机器」 */
  capabilities: { canPowerOn: boolean; canRebuild: boolean; hasMetrics: boolean } | null;
  job: { id: string; kind: string; progress: number; step: string | null; status: string } | null;
  recentActions: {
    id: string;
    action: string;
    status: string;
    error: string | null;
    createdAt: string;
    finishedAt: string | null;
  }[];
}

export interface OrderItem {
  orderNo: string;
  kind: 'new' | 'renew';
  status: string;
  statusLabel: string;
  planName?: string;
  regionLabel?: string;
  cycle: string;
  cycleLabel: string;
  amountCents: number;
  currency: 'CNY' | 'USD';
  payChannel: string | null;
  paidAt: string | null;
  expiresAt: string | null;
  failReason: string | null;
  createdAt: string;
}

export interface PaymentStatus {
  status: string;
  paid: boolean;
  failReason: string | null;
  serviceId: string | null;
  serviceStatus: string | null;
  progress: number;
  step: string | null;
  jobError: string | null;
}

export interface PayChannel {
  code: string;
  name: string;
  icon: string | null;
  driver: string;
  settleCurrency: string | null;
  desc: string | null;
}

// ---------- 展示辅助 ----------

export function money(cents: number, currency: 'CNY' | 'USD'): string {
  const symbol = currency === 'USD' ? '$' : '¥';
  return symbol + (cents / 100).toFixed(2).replace(/\.00$/, '');
}

export function formatBytes(n?: number): string {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatUptime(sec?: number): string {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return d > 0 ? `${d}天 ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDay(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 服务状态 → 中文 + 语气色。前端各处共用，避免每个页面各写一份。 */
export const SERVICE_STATUS: Record<string, { label: string; tone: string }> = {
  provisioning: { label: '开通中', tone: 'info' },
  active: { label: '运行中', tone: 'ok' },
  stopped: { label: '已关机', tone: 'mute' },
  suspended: { label: '已停用', tone: 'warn' },
  expired: { label: '已到期', tone: 'warn' },
  cancelled: { label: '已销毁', tone: 'mute' },
  error: { label: '出错', tone: 'crit' },
};

export const POWER_LABEL: Record<string, string> = {
  running: '运行中',
  stopped: '已关机',
  starting: '启动中',
  stopping: '关机中',
  rebuilding: '重装中',
  unknown: '未知',
};
