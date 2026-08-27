import { Client, ConnectConfig } from 'ssh2';
import { MachineAuth } from './provider.types';

/**
 * SSH 执行工具。
 *
 * 四个驱动都用得上：
 *   gcp / lightsail  建完机后进去改密码、装 BBR、取运行数据
 *   proxmox          guest-agent 走不通时的兜底
 *   ssh              全部操作都靠它
 *
 * 登录优先用面板专用私钥，没有私钥再退回密码 —— 用户改了自己的密码不影响面板。
 */

export interface SshTarget {
  host: string;
  auth: MachineAuth;
}

export interface SshExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class SshError extends Error {
  constructor(
    message: string,
    readonly host: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SshError';
  }
}

function buildConnectConfig(target: SshTarget, timeoutMs: number): ConnectConfig {
  const { host, auth } = target;
  const cfg: ConnectConfig = {
    host,
    port: auth.sshPort || 22,
    username: auth.sshUser || 'root',
    readyTimeout: timeoutMs,
    // 云厂商的新机器第一次连时主机指纹必然是陌生的，这里不做校验。
    // 面板到机器走的是运营方自己的网络路径，威胁模型和用户侧不同。
    algorithms: {
      serverHostKey: [
        'ssh-ed25519',
        'ecdsa-sha2-nistp256',
        'rsa-sha2-512',
        'rsa-sha2-256',
        'ssh-rsa',
      ],
    },
  };
  if (auth.privateKey) {
    cfg.privateKey = auth.privateKey;
  } else if (auth.password) {
    cfg.password = auth.password;
  } else {
    throw new SshError('既没有私钥也没有密码，无法登录', host);
  }
  return cfg;
}

/** 连上去跑一条命令。非零退出码不抛错，由调用方自己判断。 */
export function sshExec(
  target: SshTarget,
  command: string,
  timeoutMs = 20000,
): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.end();
      } catch {
        /* 连接可能已经断了，忽略 */
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new SshError(`SSH 超时（${timeoutMs}ms）`, target.host)));
    }, timeoutMs + 5000);

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) return finish(() => reject(new SshError('执行命令失败', target.host, err)));
        let stdout = '';
        let stderr = '';
        stream
          .on('close', (code: number) => {
            finish(() => resolve({ code: code ?? 0, stdout, stderr }));
          })
          .on('data', (d: Buffer) => {
            stdout += d.toString('utf8');
          })
          .stderr.on('data', (d: Buffer) => {
            stderr += d.toString('utf8');
          });
      });
    });

    conn.on('error', (err) => {
      finish(() => reject(new SshError(`连不上 ${target.host}：${err.message}`, target.host, err)));
    });

    try {
      conn.connect(buildConnectConfig(target, timeoutMs));
    } catch (err) {
      finish(() => reject(err));
    }
  });
}

/**
 * 新建的机器不会立刻能 SSH（要等系统起来、sshd 起来、防火墙放行）。
 * 这里按固定间隔重试，直到能跑通一条 `true` 为止。
 */
export async function waitForSsh(
  target: SshTarget,
  opts: { timeoutMs?: number; intervalMs?: number; onAttempt?: (n: number) => void } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 240000;
  const intervalMs = opts.intervalMs ?? 6000;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError: unknown;

  while (Date.now() < deadline) {
    attempt++;
    opts.onAttempt?.(attempt);
    try {
      await sshExec(target, 'true', 12000);
      return;
    } catch (err) {
      lastError = err;
      await sleep(intervalMs);
    }
  }
  throw new SshError(
    `等了 ${Math.round(timeoutMs / 1000)} 秒还是连不上 SSH，机器可能没起来或者防火墙没放行 22 端口`,
    target.host,
    lastError,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 把字符串安全地塞进 shell 单引号里。
 * 密码里带单引号是完全合法的，不转义会把命令搞断，甚至造成注入。
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 改 root 密码。Debian/Ubuntu/CentOS 都吃 chpasswd。 */
export async function setRootPassword(
  target: SshTarget,
  username: string,
  password: string,
): Promise<void> {
  const line = shellQuote(`${username}:${password}`);
  const res = await sshExec(target, `echo ${line} | chpasswd`, 20000);
  if (res.code !== 0) {
    throw new SshError(`改密码失败：${res.stderr || res.stdout}`, target.host);
  }
}

/**
 * 采一次机器的运行数据。
 *
 * 全部用 /proc 和 coreutils，不依赖任何要额外安装的东西 —— 卖出去的机器
 * 用户随时可能重装成任意系统，装 agent 这条路在转售场景下不成立。
 *
 * CPU 用两次 /proc/stat 采样求差，不用 top，因为 top 在不同发行版输出格式不一样。
 */
const PROBE_SCRIPT = [
  'set -e',
  'read _ a b c d e f g h _ < /proc/stat',
  't1=$((a+b+c+d+e+f+g+h)); i1=$d',
  'sleep 1',
  'read _ a b c d e f g h _ < /proc/stat',
  't2=$((a+b+c+d+e+f+g+h)); i2=$d',
  'dt=$((t2-t1)); di=$((i2-i1))',
  'cpu=0; [ "$dt" -gt 0 ] && cpu=$(( (100*(dt-di))/dt ))',
  'mt=$(awk "/MemTotal/{print int(\\$2/1024)}" /proc/meminfo)',
  'ma=$(awk "/MemAvailable/{print int(\\$2/1024)}" /proc/meminfo)',
  'up=$(cut -d. -f1 /proc/uptime)',
  'la=$(cut -d" " -f1 /proc/loadavg)',
  'dsk=$(df -BG --output=used,size / | tail -1 | tr -dc "0-9 ")',
  'net=$(awk -F"[: ]+" \'NR>2 && $2!="lo" {ri+=$3; to+=$11} END{print ri" "to}\' /proc/net/dev)',
  'echo "CPU=$cpu MEMTOTAL=$mt MEMAVAIL=$ma UPTIME=$up LOAD=$la DISK=$dsk NET=$net"',
].join('; ');

export interface ProbeResult {
  cpuPercent?: number;
  memUsedMb?: number;
  memTotalMb?: number;
  diskUsedGb?: number;
  diskTotalGb?: number;
  uptimeSec?: number;
  loadAvg1?: number;
  netInBytes?: number;
  netOutBytes?: number;
}

export async function probeMachine(target: SshTarget): Promise<ProbeResult> {
  const res = await sshExec(target, PROBE_SCRIPT, 25000);
  const out = res.stdout.trim();
  const pick = (key: string): string | undefined =>
    new RegExp(`${key}=([^\\s]+)`).exec(out)?.[1];

  const memTotal = num(pick('MEMTOTAL'));
  const memAvail = num(pick('MEMAVAIL'));
  const disk = /DISK=([0-9]+)\s+([0-9]+)/.exec(out);
  const net = /NET=([0-9]+)\s+([0-9]+)/.exec(out);

  return {
    cpuPercent: num(pick('CPU')),
    memTotalMb: memTotal,
    memUsedMb: memTotal != null && memAvail != null ? memTotal - memAvail : undefined,
    uptimeSec: num(pick('UPTIME')),
    loadAvg1: num(pick('LOAD')),
    diskUsedGb: disk ? Number(disk[1]) : undefined,
    diskTotalGb: disk ? Number(disk[2]) : undefined,
    netInBytes: net ? Number(net[1]) : undefined,
    netOutBytes: net ? Number(net[2]) : undefined,
  };
}

function num(v?: string): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
