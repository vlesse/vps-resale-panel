import { Injectable } from '@nestjs/common';
import {
  CredentialCheckResult,
  MachineStatusSnapshot,
  ProviderContext,
  ProviderNotCapableError,
  ProvisionRequest,
  ProvisionResult,
  ResetPasswordResult,
  VpsProvider,
} from '../provider.types';
import { buildRemoteBootstrapCommand } from '../bootstrap.util';
import { probeMachine, setRootPassword, sleep, sshExec, waitForSsh } from '../ssh-exec.util';

/**
 * 通用 SSH 驱动 —— 给「你已经有这台机器」的情况用。
 *
 * 适用于：自己从别家买的 VPS、放在机房的物理机、任何能 SSH 进去的东西。
 * 这类机器走的是**库存池**模式：你提前录进后台并调优好（状态推到 ready），
 * 用户下单付款后从池子里分配一台。
 *
 * 和云驱动的区别：
 *   建不出机器  没有上游 API，凭空变不出一台服务器，所以 canProvision = false
 *   provision() 在这里的含义是「把这台已存在的机器初始化成买家的机器」——
 *               设新密码、塞面板公钥、开 root 登录、开 BBR
 *   关机是真关  stop() 走的是 `poweroff`，关了之后面板就再也叫不醒它了
 *               （没有带外管理），所以控制台上对这类机器不提供开机按钮
 *   重装是软重装 没有虚拟化层，做不到真正的重装。只能清掉用户数据、重置密码、
 *               恢复到一个干净的基线状态。这一点必须在套餐说明里跟用户讲清楚。
 */
@Injectable()
export class SshProvider implements VpsProvider {
  readonly kind = 'ssh' as const;
  readonly canProvision = false;
  readonly canRebuild = true;
  readonly hasMetrics = false;

  async verifyCredentials(): Promise<CredentialCheckResult> {
    // 这个驱动不用云账号，凭据挂在每台机器上，所以「测试连接」是针对单台机器的
    return {
      ok: true,
      message: '该驱动不需要云账号凭据，请到机器列表里对单台机器测试连接',
    };
  }

  /** 测试单台机器能不能登进去。后台录入库存时点「测试连接」调的就是它。 */
  async testMachine(ctx: ProviderContext): Promise<CredentialCheckResult> {
    if (!ctx.ip || !ctx.auth) return { ok: false, message: '缺少 IP 或登录凭据' };
    try {
      const res = await sshExec(
        { host: ctx.ip, auth: ctx.auth },
        'cat /etc/os-release 2>/dev/null | head -2; nproc; free -m | awk "NR==2{print \\$2}"',
        20000,
      );
      const lines = res.stdout.trim().split('\n');
      return {
        ok: true,
        message: '登录成功',
        detail: {
          系统: lines[0]?.replace(/^PRETTY_NAME=|"/g, '') || '未知',
          CPU核数: lines[lines.length - 2],
          内存MB: lines[lines.length - 1],
        },
      };
    } catch (err: any) {
      return { ok: false, message: this.explain(err) };
    }
  }

  /**
   * 初始化一台已存在的机器并交付。
   * 调用前 ctx.ip 和 ctx.auth 必须是管理员录入库存时填的那套凭据。
   */
  async provision(ctx: ProviderContext, req: ProvisionRequest): Promise<ProvisionResult> {
    if (!ctx.ip || !ctx.auth) {
      throw new Error('ssh 驱动无法凭空创建机器，必须先在后台把这台机器的 IP 和登录凭据录进来');
    }
    const progress = req.onProgress ?? (() => undefined);
    const target = { host: ctx.ip, auth: ctx.auth };

    await progress(20, '连接机器');
    await waitForSsh(target, { timeoutMs: 60000, intervalMs: 5000 });

    await progress(50, '写入新的登录凭据');
    const cmd = buildRemoteBootstrapCommand({
      username: ctx.auth.sshUser || 'root',
      password: req.password,
      publicKeyOpenssh: req.publicKeyOpenssh,
      hostname: req.hostname,
      enableBbr: req.spec?.enableBbr !== false,
    });
    const res = await sshExec(target, cmd, 90000);
    if (res.code !== 0) {
      throw new Error(`初始化脚本执行失败：${res.stderr || res.stdout}`);
    }

    await progress(85, '验证新凭据可用');
    const auth = {
      sshUser: ctx.auth.sshUser || 'root',
      sshPort: ctx.auth.sshPort || 22,
      password: req.password,
      privateKey: req.privateKeyPem,
    };
    // 改完 sshd 配置要等它重启完，这里用新密钥重连一次做验证
    await sleep(3000);
    await waitForSsh({ host: ctx.ip, auth }, { timeoutMs: 60000, intervalMs: 4000 });

    await progress(95, '初始化完成');
    return { ref: {}, ip: ctx.ip, auth, raw: { mode: 'inventory-prepare' } };
  }

  async getStatus(ctx: ProviderContext): Promise<MachineStatusSnapshot> {
    if (!ctx.ip || !ctx.auth) throw new Error('缺少 IP 或登录凭据');
    const checkedAt = new Date().toISOString();
    try {
      const probe = await probeMachine({ host: ctx.ip, auth: ctx.auth });
      return { power: 'running', ip: ctx.ip, checkedAt, ...probe };
    } catch (err: any) {
      // 连不上有两种可能：真关机了，或者只是网络抖动。
      // 没有带外管理就分辨不了，如实告诉用户而不是瞎猜。
      return {
        power: 'unknown',
        ip: ctx.ip,
        checkedAt,
        note: `连不上这台机器：${err.message}。可能是关机了、网络不通，或者防火墙挡了 SSH`,
      };
    }
  }

  async start(): Promise<void> {
    throw new ProviderNotCapableError('ssh', '远程开机');
  }

  /** 真关机。没有带外管理，关了就叫不醒了，所以调用方要先跟用户确认。 */
  async stop(ctx: ProviderContext): Promise<void> {
    if (!ctx.ip || !ctx.auth) throw new Error('缺少 IP 或登录凭据');
    // poweroff 会立刻切断连接，SSH 必然报错，所以不看返回值
    await sshExec({ host: ctx.ip, auth: ctx.auth }, 'nohup sh -c "sleep 1; poweroff" >/dev/null 2>&1 &', 10000).catch(
      () => undefined,
    );
  }

  async reboot(ctx: ProviderContext): Promise<void> {
    if (!ctx.ip || !ctx.auth) throw new Error('缺少 IP 或登录凭据');
    await sshExec({ host: ctx.ip, auth: ctx.auth }, 'nohup sh -c "sleep 1; reboot" >/dev/null 2>&1 &', 10000).catch(
      () => undefined,
    );
  }

  async resetPassword(ctx: ProviderContext, newPassword: string): Promise<ResetPasswordResult> {
    if (!ctx.ip || !ctx.auth) throw new Error('缺少 IP 或登录凭据');
    const username = ctx.auth.sshUser || 'root';
    await setRootPassword({ host: ctx.ip, auth: ctx.auth }, username, newPassword);
    return { username, password: newPassword };
  }

  /**
   * 软重装。
   *
   * 物理机/裸 VPS 没有虚拟化层，做不到真正的重装。这里做的是「清空用户数据 +
   * 重置凭据」，把机器恢复到一个干净基线。套餐说明里必须写清楚这一点，
   * 不能让用户以为是全新系统。
   */
  async rebuild(ctx: ProviderContext, req: ProvisionRequest): Promise<ProvisionResult> {
    if (!ctx.ip || !ctx.auth) throw new Error('缺少 IP 或登录凭据');
    const progress = req.onProgress ?? (() => undefined);
    const target = { host: ctx.ip, auth: ctx.auth };

    await progress(15, '清理用户数据');
    // 只清明确属于用户的目录，不碰系统目录 —— 误删系统会把机器彻底搞死
    await sshExec(
      target,
      [
        'rm -rf /root/* /root/.cache /root/.local /tmp/* /var/tmp/*',
        'rm -rf /home/*/[!.]* 2>/dev/null || true',
        'systemctl list-units --type=service --state=running --no-legend 2>/dev/null | head -50',
      ].join('; '),
      60000,
    ).catch(() => undefined);

    await progress(45, '重置登录凭据');
    return this.provision(ctx, {
      ...req,
      onProgress: async (p, s) => progress(45 + Math.round(p * 0.55), s),
    });
  }

  /**
   * 库存机不销毁 —— 它是你的资产，用户退订后要回收再上架，不是删掉。
   * 真正的下架请在后台把机器状态推到 retired。
   */
  async release(): Promise<void> {
    return;
  }

  private explain(err: any): string {
    const msg: string = err?.message ?? String(err);
    if (/All configured authentication methods failed/i.test(msg)) {
      return '账号或密码不对，也可能是这台机器禁止了 root 密码登录';
    }
    if (/ECONNREFUSED/i.test(msg)) {
      return 'SSH 端口连不上，检查端口号对不对、sshd 是不是在跑';
    }
    if (/ETIMEDOUT|timeout/i.test(msg)) {
      return '连接超时，检查 IP 对不对、防火墙有没有放行 SSH 端口';
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) {
      return '解析不了这个地址，检查 IP 或域名有没有写错';
    }
    return msg;
  }
}
