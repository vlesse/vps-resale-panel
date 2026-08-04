import { Client, ConnectConfig } from 'ssh2';

export type SshAuth = {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
};

export type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function withClient<T>(
  auth: SshAuth,
  fn: (client: Client) => Promise<T>,
  timeoutMs = 25000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`SSH timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const conf: ConnectConfig = {
      host: auth.host,
      port: auth.port || 22,
      username: auth.username || 'root',
      readyTimeout: Math.min(15000, timeoutMs),
      tryKeyboard: false,
    };
    if (auth.privateKey) conf.privateKey = auth.privateKey;
    else conf.password = auth.password || '';

    conn
      .on('ready', async () => {
        try {
          const result = await fn(conn);
          clearTimeout(timer);
          conn.end();
          resolve(result);
        } catch (e) {
          clearTimeout(timer);
          conn.end();
          reject(e);
        }
      })
      .on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .connect(conf);
  });
}

export function sshExec(auth: SshAuth, command: string, timeoutMs = 25000): Promise<ExecResult> {
  return withClient(auth, (conn) => {
    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        stream
          .on('close', (code: number | null) => {
            resolve({ code, stdout, stderr });
          })
          .on('data', (d: Buffer) => {
            stdout += d.toString('utf8');
          });
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf8');
        });
      });
    });
  }, timeoutMs);
}

export async function collectHostStatus(auth: SshAuth) {
  const script = [
    'echo __HOST__=$(hostname)',
    'echo __UPTIME__=$(uptime -p 2>/dev/null || uptime)',
    'echo __UNAME__=$(uname -a)',
    'echo __LOAD__=$(cat /proc/loadavg 2>/dev/null || echo n/a)',
    "echo __MEM__=$(free -m | awk '/Mem:/ {printf \"%s/%sMB\", $3, $2}')",
    "echo __DISK__=$(df -h / | awk 'NR==2{print $3\"/\"$2\" used \"$5}')",
    'echo __IP__=$(hostname -I 2>/dev/null | awk "{print \\$1}")',
  ].join('; ');
  const res = await sshExec(auth, script, 20000);
  const lines = (res.stdout || '').split(/\r?\n/);
  const map: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^__([A-Z]+)__=(.*)$/);
    if (m) map[m[1].toLowerCase()] = m[2];
  }
  return {
    online: res.code === 0,
    rawCode: res.code,
    hostname: map.host || null,
    uptime: map.uptime || null,
    uname: map.uname || null,
    load: map.load || null,
    memory: map.mem || null,
    disk: map.disk || null,
    primaryIp: map.ip || null,
    stderr: res.stderr || null,
    checkedAt: new Date().toISOString(),
  };
}

export async function rebootHost(auth: SshAuth) {
  // fire reboot; connection may drop
  try {
    await sshExec(auth, 'nohup bash -c "sleep 1; reboot" >/dev/null 2>&1 &', 8000);
  } catch (e: any) {
    // connection reset after reboot is acceptable
    if (!/reboot|reset|ECONN|closed|timeout/i.test(String(e?.message || e))) {
      throw e;
    }
  }
  return { accepted: true, message: 'Reboot command sent' };
}

export async function resetRootPassword(auth: SshAuth, newPassword: string) {
  // Prefer chpasswd; escape single quotes for shell
  const safe = newPassword.replace(/'/g, `'\"'\"'`);
  const cmd = `echo 'root:${safe}' | chpasswd && echo OK_PASSWD`;
  const res = await sshExec(auth, cmd, 20000);
  if (res.code !== 0 || !res.stdout.includes('OK_PASSWD')) {
    throw new Error(`reset password failed: ${res.stderr || res.stdout || res.code}`);
  }
  return { ok: true };
}

/**
 * Lightweight "reinstall-like" reset for unmanaged VPS via SSH:
 * - optional package refresh markers
 * - recreate ubuntu/debian cloud feel is impossible fully without provider API
 * - we do a practical baseline: wipe common app dirs is too dangerous
 * So we implement "system reinit":
 *   update apt indexes (optional), ensure openssh, set hostname optional,
 *   clear bash history, set password, reboot
 * True ISO reinstall requires CloudCone/Proxmox API — marked as limited.
 */
export async function softReinitHost(
  auth: SshAuth,
  opts: { newPassword?: string; osLabel?: string },
) {
  const steps: string[] = [];
  steps.push('export DEBIAN_FRONTEND=noninteractive');
  steps.push('echo START_REINIT');
  // best-effort package presence
  steps.push('(command -v apt-get >/dev/null && apt-get update -y) || true');
  steps.push('(command -v apt-get >/dev/null && apt-get install -y openssh-server curl ca-certificates) || true');
  steps.push('systemctl enable ssh 2>/dev/null || systemctl enable sshd 2>/dev/null || true');
  steps.push('systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true');
  if (opts.newPassword) {
    const safe = opts.newPassword.replace(/'/g, `'\"'\"'`);
    steps.push(`echo 'root:${safe}' | chpasswd`);
  }
  steps.push('echo DONE_REINIT');
  const res = await sshExec(auth, steps.join(' && '), 120000);
  if (!res.stdout.includes('DONE_REINIT')) {
    throw new Error(`reinit failed: ${res.stderr || res.stdout || res.code}`);
  }
  // reboot after reinit
  try {
    await rebootHost(auth);
  } catch {
    // ignore
  }
  return {
    ok: true,
    mode: 'soft_reinit',
    note: 'Full ISO reinstall needs upstream provider API; performed baseline reinit + reboot',
    osLabel: opts.osLabel || null,
    stdoutTail: res.stdout.slice(-500),
  };
}

export function genPassword(len = 16): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
