import { shellQuote } from './ssh-exec.util';

/**
 * 新机器的首次初始化脚本。
 *
 * 谷歌云通过实例 metadata 的 startup-script 执行，Lightsail 通过 userData 执行，
 * Proxmox 通过 cloud-init 执行，自有机器由 ssh 驱动登进去直接跑 —— 同一份脚本，四家通用。
 *
 * 干四件事：
 *   1. 设 root 密码（这是要交付给用户的）
 *   2. 塞面板专用公钥（用户改密码后面板还能进得去）
 *   3. 打开 root 密码登录（云镜像默认全是关的）
 *   4. 开 BBR（这是转售平台的「优化」卖点）
 *
 * 最后写一个标记文件。面板 SSH 进去看到这个文件，才认为初始化真的跑完了 ——
 * 光能 SSH 上不代表脚本执行成功，中间任何一步挂了都可能连得上但密码是错的。
 */

export const BOOTSTRAP_MARKER = '/var/lib/vps-panel-bootstrap.done';

export interface BootstrapOptions {
  username: string;
  password: string;
  publicKeyOpenssh: string;
  hostname?: string;
  enableBbr?: boolean;
}

export function buildBootstrapScript(opts: BootstrapOptions): string {
  const { username, password, publicKeyOpenssh, hostname, enableBbr = true } = opts;

  const home = username === 'root' ? '/root' : `/home/${username}`;

  const lines: string[] = [
    '#!/bin/bash',
    '# 由 VPS 转售面板自动生成，勿手工修改',
    '# 出错也要继续往下跑：某一步失败不应该导致整台机器交付不出去',
    'set +e',
    'exec >>/var/log/vps-panel-bootstrap.log 2>&1',
    'echo "=== bootstrap start $(date -u +%FT%TZ) ==="',
    '',
    '# --- 1. 设置密码 ---',
    `echo ${shellQuote(`${username}:${password}`)} | chpasswd`,
    '',
    '# --- 2. 写入面板专用公钥 ---',
    `mkdir -p ${home}/.ssh`,
    `chmod 700 ${home}/.ssh`,
    `grep -qxF ${shellQuote(publicKeyOpenssh)} ${home}/.ssh/authorized_keys 2>/dev/null || \\`,
    `  echo ${shellQuote(publicKeyOpenssh)} >> ${home}/.ssh/authorized_keys`,
    `chmod 600 ${home}/.ssh/authorized_keys`,
    `chown -R ${username}: ${home}/.ssh 2>/dev/null || true`,
    '',
    '# --- 3. 打开 root 密码登录 ---',
    '# 云镜像默认禁止 root 密码登录。sshd 的规则是「先读到的值生效」，而 Debian/Ubuntu',
    '# 把 Include 放在配置文件最顶上、按文件名字典序读，所以这个文件必须以 00 开头',
    '# 才能压过云镜像自带的 60-cloudimg-settings.conf。',
    'if [ -d /etc/ssh/sshd_config.d ]; then',
    '  cat > /etc/ssh/sshd_config.d/00-vps-panel.conf <<\'SSHDCONF\'',
    'PermitRootLogin yes',
    'PasswordAuthentication yes',
    'PubkeyAuthentication yes',
    'KbdInteractiveAuthentication no',
    'SSHDCONF',
    '  chmod 644 /etc/ssh/sshd_config.d/00-vps-panel.conf',
    'fi',
    '# 老镜像没有 sshd_config.d，直接改主配置兜底',
    "sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config",
    "sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config",
    'grep -q "^PermitRootLogin yes" /etc/ssh/sshd_config || echo "PermitRootLogin yes" >> /etc/ssh/sshd_config',
    'grep -q "^PasswordAuthentication yes" /etc/ssh/sshd_config || echo "PasswordAuthentication yes" >> /etc/ssh/sshd_config',
    '',
    '# 谷歌云的 guest agent 会周期性地按项目 metadata 重写 sshd 配置，',
    '# 把它对 sshd 的接管关掉，否则我们改的配置过几分钟就被改回去了。',
    'if [ -f /etc/default/instance_configs.cfg ] || command -v google_metadata_script_runner >/dev/null 2>&1; then',
    '  mkdir -p /etc/default',
    '  printf "[Daemons]\\nsshd=false\\n" > /etc/default/instance_configs.cfg.template',
    'fi',
    '',
    'systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || service ssh restart 2>/dev/null',
  ];

  if (hostname) {
    lines.push(
      '',
      '# --- 主机名 ---',
      `hostnamectl set-hostname ${shellQuote(hostname)} 2>/dev/null || echo ${shellQuote(hostname)} > /etc/hostname`,
    );
  }

  if (enableBbr) {
    lines.push(
      '',
      '# --- 4. 开启 BBR ---',
      'if ! grep -q "^net.ipv4.tcp_congestion_control=bbr" /etc/sysctl.conf; then',
      '  echo "net.core.default_qdisc=fq" >> /etc/sysctl.conf',
      '  echo "net.ipv4.tcp_congestion_control=bbr" >> /etc/sysctl.conf',
      'fi',
      'sysctl -p >/dev/null 2>&1',
    );
  }

  lines.push(
    '',
    '# --- 完成标记 ---',
    'mkdir -p /var/lib',
    `date -u +%FT%TZ > ${BOOTSTRAP_MARKER}`,
    'echo "=== bootstrap done $(date -u +%FT%TZ) ==="',
    '',
  );

  return lines.join('\n');
}

/**
 * 检查初始化脚本到底跑完没有。
 *
 * 建完机之后光「SSH 能连上」是不够的 —— startup-script 是和 sshd 并行跑的，
 * 很可能 SSH 已经通了但密码还没设上。所以要等这个标记文件出现才算交付成功。
 */
export function buildBootstrapCheckCommand(): string {
  return `test -f ${BOOTSTRAP_MARKER} && cat ${BOOTSTRAP_MARKER}`;
}

/**
 * 给 ssh / proxmox 驱动用的版本：不走 startup-script，登进去直接执行。
 * 用 base64 传输，避免多层引号在 shell 之间来回转义时被吃掉。
 */
export function buildRemoteBootstrapCommand(opts: BootstrapOptions): string {
  const script = buildBootstrapScript(opts);
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return `echo ${b64} | base64 -d > /tmp/.vps-panel-bootstrap.sh && bash /tmp/.vps-panel-bootstrap.sh; rm -f /tmp/.vps-panel-bootstrap.sh`;
}
