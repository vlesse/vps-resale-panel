import axios, { AxiosInstance } from 'axios';
import * as https from 'https';
import { ProxmoxAuthConfig } from '../crypto/crypto.util';
import { genPassword } from './ssh.util';

export type PveVmStatus = {
  online: boolean;
  power: string;
  status: string;
  qmpstatus?: string;
  name?: string;
  cpus?: number;
  maxmem?: number;
  mem?: number;
  uptime?: number;
  pid?: number;
  agent?: boolean;
  primaryIp?: string | null;
  hostname?: string | null;
  uptimeText?: string | null;
  memory?: string | null;
  load?: string | null;
  disk?: string | null;
  source?: string;
  checkedAt: string;
  raw?: any;
};

function baseUrl(cfg: ProxmoxAuthConfig) {
  const proto = cfg.protocol || 'https';
  const port = cfg.port || 8006;
  return `${proto}://${cfg.host}:${port}/api2/json`;
}

function createClient(cfg: ProxmoxAuthConfig, ticketAuth?: { ticket: string; csrf: string }) {
  const headers: Record<string, string> = {};
  if (cfg.tokenId && cfg.tokenSecret) {
    headers.Authorization = `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}`;
  } else if (ticketAuth) {
    headers.Cookie = `PVEAuthCookie=${ticketAuth.ticket}`;
    headers.CSRFPreventionToken = ticketAuth.csrf;
  }
  return axios.create({
    baseURL: baseUrl(cfg),
    timeout: 30000,
    headers,
    httpsAgent: new https.Agent({
      rejectUnauthorized: cfg.verifyTls === true,
    }),
    validateStatus: () => true,
  });
}

async function withAuth<T>(
  cfg: ProxmoxAuthConfig,
  fn: (client: AxiosInstance) => Promise<T>,
): Promise<T> {
  if (cfg.tokenId && cfg.tokenSecret) {
    return fn(createClient(cfg));
  }
  if (!cfg.username || !cfg.password) {
    throw new Error('Proxmox credentials missing: need tokenId/tokenSecret or username/password');
  }
  const boot = createClient(cfg);
  const login = await boot.post(
    '/access/ticket',
    new URLSearchParams({
      username: cfg.username,
      password: cfg.password,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  if (login.status >= 300 || !login.data?.data?.ticket) {
    throw new Error(`Proxmox login failed: HTTP ${login.status} ${JSON.stringify(login.data)}`);
  }
  const ticket = login.data.data.ticket as string;
  const csrf = login.data.data.CSRFPreventionToken as string;
  return fn(createClient(cfg, { ticket, csrf }));
}

async function pveGet<T = any>(cfg: ProxmoxAuthConfig, path: string, params?: Record<string, any>) {
  return withAuth(cfg, async (client) => {
    const res = await client.get(path, { params });
    if (res.status >= 300) {
      throw new Error(`PVE GET ${path} failed: ${res.status} ${JSON.stringify(res.data)}`);
    }
    return res.data?.data as T;
  });
}

async function pvePost<T = any>(
  cfg: ProxmoxAuthConfig,
  path: string,
  body?: Record<string, any>,
) {
  return withAuth(cfg, async (client) => {
    const res = await client.post(path, body ? new URLSearchParams(flatten(body)).toString() : undefined, {
      headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
    });
    if (res.status >= 300) {
      throw new Error(`PVE POST ${path} failed: ${res.status} ${JSON.stringify(res.data)}`);
    }
    return res.data?.data as T;
  });
}

async function pvePut<T = any>(
  cfg: ProxmoxAuthConfig,
  path: string,
  body?: Record<string, any>,
) {
  return withAuth(cfg, async (client) => {
    const res = await client.put(path, body ? new URLSearchParams(flatten(body)).toString() : undefined, {
      headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
    });
    if (res.status >= 300) {
      throw new Error(`PVE PUT ${path} failed: ${res.status} ${JSON.stringify(res.data)}`);
    }
    return res.data?.data as T;
  });
}

async function pveDelete<T = any>(
  cfg: ProxmoxAuthConfig,
  path: string,
  params?: Record<string, any>,
) {
  return withAuth(cfg, async (client) => {
    const res = await client.delete(path, {
      params,
      // some PVE deletes want form body; query is enough for purge flags
    });
    if (res.status >= 300) {
      throw new Error(`PVE DELETE ${path} failed: ${res.status} ${JSON.stringify(res.data)}`);
    }
    return res.data?.data as T;
  });
}

function flatten(obj: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'boolean' || typeof v === 'number' ? String(v) : String(v);
  }
  return out;
}

function vmPath(cfg: ProxmoxAuthConfig, suffix = '') {
  return `/nodes/${cfg.node}/qemu/${cfg.vmid}${suffix}`;
}

export function parseProxmoxRef(providerRef?: string | null): { node?: string; vmid?: number } {
  if (!providerRef) return {};
  // formats: "pve/101", "node:pve,vmid:101", "101"
  const m1 = providerRef.match(/^([^/]+)\/(\d+)$/);
  if (m1) return { node: m1[1], vmid: Number(m1[2]) };
  const m2 = providerRef.match(/node\s*[:=]\s*([^,\s]+).*vmid\s*[:=]\s*(\d+)/i);
  if (m2) return { node: m2[1], vmid: Number(m2[2]) };
  if (/^\d+$/.test(providerRef)) return { vmid: Number(providerRef) };
  return {};
}

export function resolvePveConfig(
  pve: ProxmoxAuthConfig,
  providerRef?: string | null,
): ProxmoxAuthConfig {
  const parsed = parseProxmoxRef(providerRef);
  return {
    ...pve,
    node: pve.node || parsed.node || '',
    vmid: pve.vmid || parsed.vmid || 0,
    port: pve.port || 8006,
    protocol: pve.protocol || 'https',
    verifyTls: pve.verifyTls === true,
    ciUser: pve.ciUser || 'root',
  };
}

export async function pveCollectStatus(cfg: ProxmoxAuthConfig): Promise<PveVmStatus> {
  if (!cfg.node || !cfg.vmid) throw new Error('Proxmox node/vmid required');
  const st = await pveGet<any>(cfg, vmPath(cfg, '/status/current'));
  let primaryIp: string | null = null;
  let agent = false;
  try {
    const ifaces = await pveGet<any>(cfg, vmPath(cfg, '/agent/network-get-interfaces'));
    agent = true;
    const list = ifaces?.result || ifaces || [];
    for (const nic of list) {
      const addrs = nic['ip-addresses'] || [];
      for (const a of addrs) {
        if (a['ip-address-type'] === 'ipv4' && a['ip-address'] && !String(a['ip-address']).startsWith('127.')) {
          primaryIp = a['ip-address'];
          break;
        }
      }
      if (primaryIp) break;
    }
  } catch {
    // guest agent optional
  }

  const power = st?.status || 'unknown';
  const online = power === 'running';
  const memMb = st?.mem ? Math.round(st.mem / 1024 / 1024) : null;
  const maxMemMb = st?.maxmem ? Math.round(st.maxmem / 1024 / 1024) : null;
  return {
    online,
    power,
    status: power,
    qmpstatus: st?.qmpstatus,
    name: st?.name,
    cpus: st?.cpus,
    maxmem: st?.maxmem,
    mem: st?.mem,
    uptime: st?.uptime,
    pid: st?.pid,
    agent,
    primaryIp,
    hostname: st?.name || null,
    uptimeText:
      st?.uptime != null
        ? `${Math.floor(st.uptime / 3600)}h ${Math.floor((st.uptime % 3600) / 60)}m`
        : null,
    // console UI reads `uptime` as display string for SSH path; mirror here
    // (numeric uptime still available as raw.uptime)
    memory: memMb != null && maxMemMb != null ? `${memMb}/${maxMemMb}MB` : null,
    load: st?.cpu != null ? `cpu=${Number(st.cpu).toFixed(2)}` : null,
    disk: null,
    checkedAt: new Date().toISOString(),
    source: 'proxmox',
    raw: {
      status: st?.status,
      qmpstatus: st?.qmpstatus,
      uptime: st?.uptime,
    },
  };
}

export async function pveReboot(cfg: ProxmoxAuthConfig) {
  if (!cfg.node || !cfg.vmid) throw new Error('Proxmox node/vmid required');
  // try graceful reboot first
  try {
    await pvePost(cfg, vmPath(cfg, '/status/reboot'));
    return { accepted: true, mode: 'reboot', message: 'Proxmox reboot requested' };
  } catch (e: any) {
    // fallback hard reset
    await pvePost(cfg, vmPath(cfg, '/status/reset'));
    return {
      accepted: true,
      mode: 'reset',
      message: 'Proxmox reset requested (reboot failed: ' + String(e?.message || e).slice(0, 120) + ')',
    };
  }
}

export async function pveStopStart(cfg: ProxmoxAuthConfig) {
  await pvePost(cfg, vmPath(cfg, '/status/stop'));
  await sleep(2000);
  await waitPower(cfg, 'stopped', 60000);
  await pvePost(cfg, vmPath(cfg, '/status/start'));
  return { accepted: true, mode: 'stop_start' };
}

/**
 * Prefer qemu-guest-agent set-user-password.
 * Returns false if agent unavailable (caller may SSH fallback).
 */
export async function pveResetPassword(
  cfg: ProxmoxAuthConfig,
  username: string,
  newPassword: string,
): Promise<{ ok: true; method: 'guest-agent' }> {
  if (!cfg.node || !cfg.vmid) throw new Error('Proxmox node/vmid required');
  // PVE agent endpoint: POST /agent/set-user-password  { username, password }
  await pvePost(cfg, vmPath(cfg, '/agent/set-user-password'), {
    username: username || cfg.ciUser || 'root',
    password: newPassword,
  });
  return { ok: true, method: 'guest-agent' };
}

/**
 * Full-ish reinstall: destroy current VM and clone from template into the same VMID.
 * Requires templateVmid. Uses cloud-init password when possible.
 */
export async function pveReinstallFromTemplate(
  cfg: ProxmoxAuthConfig,
  opts: {
    name?: string;
    newPassword?: string;
    osLabel?: string;
  },
) {
  if (!cfg.templateVmid) {
    throw new Error('Proxmox reinstall requires templateVmid in inventory auth');
  }
  if (!cfg.node || !cfg.vmid) throw new Error('Proxmox node/vmid required');
  const password = opts.newPassword || genPassword(16);
  const name = opts.name || `vm-${cfg.vmid}`;

  // stop if running
  try {
    const st = await pveGet<any>(cfg, vmPath(cfg, '/status/current'));
    if (st?.status === 'running') {
      await pvePost(cfg, vmPath(cfg, '/status/stop'));
      await waitPower(cfg, 'stopped', 90000);
    }
  } catch {
    // may already be missing
  }

  // destroy existing VM (purge disks)
  try {
    await pveDelete(cfg, vmPath(cfg), {
      purge: 1,
      'destroy-unreferenced-disks': 1,
    });
    // wait a bit for unlock
    await sleep(3000);
  } catch (e: any) {
    // if not found, continue
    if (!/does not exist|not found|404/i.test(String(e?.message || e))) {
      throw e;
    }
  }

  const cloneBody: Record<string, any> = {
    newid: cfg.vmid,
    name,
    full: 1,
  };
  if (cfg.storage) cloneBody.storage = cfg.storage;
  const upid = await pvePost(
    cfg,
    `/nodes/${cfg.node}/qemu/${cfg.templateVmid}/clone`,
    cloneBody,
  );
  await waitTask(cfg, String(upid), 300000);

  // cloud-init credentials / network
  const config: Record<string, any> = {
    ciuser: cfg.ciUser || 'root',
    cipassword: password,
  };
  if (cfg.ipconfig0) config.ipconfig0 = cfg.ipconfig0;
  if (cfg.nameserver) config.nameserver = cfg.nameserver;
  try {
    await pvePut(cfg, vmPath(cfg, '/config'), config);
  } catch (e: any) {
    // config may fail if template has no cloud-init; still start VM
  }

  await pvePost(cfg, vmPath(cfg, '/status/start'));

  return {
    ok: true,
    mode: 'proxmox_template_clone',
    password,
    osLabel: opts.osLabel || null,
    vmid: cfg.vmid,
    templateVmid: cfg.templateVmid,
    message: 'VM recreated from Proxmox template and started',
  };
}

async function waitPower(cfg: ProxmoxAuthConfig, want: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const st = await pveGet<any>(cfg, vmPath(cfg, '/status/current'));
      if (st?.status === want) return st;
    } catch {
      if (want === 'stopped') return null;
    }
    await sleep(2000);
  }
  throw new Error(`Timeout waiting Proxmox VM ${cfg.vmid} -> ${want}`);
}

async function waitTask(cfg: ProxmoxAuthConfig, upid: string, timeoutMs: number) {
  if (!upid || upid === 'null' || upid === 'undefined') return;
  const start = Date.now();
  // UPID encodes node; use cluster tasks or node tasks
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await pveGet<any>(cfg, `/nodes/${cfg.node}/tasks/${encodeURIComponent(upid)}/status`);
      if (status?.status === 'stopped') {
        if (status.exitstatus && status.exitstatus !== 'OK') {
          throw new Error(`Proxmox task failed: ${status.exitstatus}`);
        }
        return status;
      }
    } catch (e: any) {
      if (/task failed/i.test(String(e?.message || e))) throw e;
    }
    await sleep(2000);
  }
  throw new Error(`Timeout waiting Proxmox task ${upid}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function pveTestConnection(cfg: ProxmoxAuthConfig) {
  const version = await pveGet<any>(cfg, '/version');
  let vm: any = null;
  if (cfg.node && cfg.vmid) {
    vm = await pveGet<any>(cfg, vmPath(cfg, '/status/current'));
  }
  return {
    ok: true,
    version: version?.version || version,
    vm: vm
      ? { status: vm.status, name: vm.name, uptime: vm.uptime, cpus: vm.cpus }
      : null,
  };
}
