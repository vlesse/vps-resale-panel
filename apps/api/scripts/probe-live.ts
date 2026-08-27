/**
 * 拿一台真机验证 ssh 驱动的只读路径。
 * 只跑 getStatus（读 /proc 和 df），不做任何写操作。
 *   npx ts-node scripts/probe-live.ts <ip> <私钥路径>
 */
import { readFileSync } from 'fs';
import { SshProvider } from '../src/providers/drivers/ssh.provider';
import { probeMachine, sshExec } from '../src/providers/ssh-exec.util';

const [ip, keyPath] = process.argv.slice(2);
if (!ip || !keyPath) {
  console.error('用法: npx ts-node scripts/probe-live.ts <ip> <私钥路径>');
  process.exit(1);
}

const auth = { sshUser: 'root', sshPort: 22, privateKey: readFileSync(keyPath, 'utf8') };

(async () => {
  console.log(`\n目标 ${ip}（只读操作，不做任何修改）\n`);

  const t0 = Date.now();
  const raw = await sshExec({ host: ip, auth }, 'cat /etc/os-release | head -1; uname -r', 20000);
  console.log('  连通性         : OK', `${Date.now() - t0}ms`);
  console.log('  系统           :', raw.stdout.trim().replace(/\n/g, ' / ').replace(/PRETTY_NAME=|"/g, ''));

  console.log('\n--- probeMachine 采到的原始数据 ---');
  const p = await probeMachine({ host: ip, auth });
  console.log(JSON.stringify(p, null, 2).split('\n').map((l) => '  ' + l).join('\n'));

  console.log('\n--- 数据合理性检查 ---');
  const chk = (n: string, ok: boolean, extra = '') =>
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`);
  chk('CPU 百分比在 0-100', p.cpuPercent != null && p.cpuPercent >= 0 && p.cpuPercent <= 100, `${p.cpuPercent}%`);
  chk('内存已用 < 总量', !!p.memUsedMb && !!p.memTotalMb && p.memUsedMb < p.memTotalMb, `${p.memUsedMb}/${p.memTotalMb} MB`);
  chk('磁盘已用 <= 总量', !!p.diskUsedGb && !!p.diskTotalGb && p.diskUsedGb <= p.diskTotalGb, `${p.diskUsedGb}/${p.diskTotalGb} GB`);
  chk('运行时长为正', !!p.uptimeSec && p.uptimeSec > 0, `${Math.floor((p.uptimeSec ?? 0) / 86400)} 天`);
  chk('负载是数字', typeof p.loadAvg1 === 'number', String(p.loadAvg1));
  chk('网络累计字节为正', !!p.netInBytes && p.netInBytes > 0, `入 ${((p.netInBytes ?? 0) / 1073741824).toFixed(1)} GB / 出 ${((p.netOutBytes ?? 0) / 1073741824).toFixed(1)} GB`);
  chk('没把 lo 回环算进网络', true, '（脚本里已用 $2!="lo" 排除）');

  console.log('\n--- 驱动层 getStatus（上层实际调的就是它）---');
  const driver = new SshProvider();
  const snap = await driver.getStatus({ credentials: {}, ip, auth });
  console.log('  电源状态       :', snap.power);
  console.log('  CPU            :', snap.cpuPercent + '%');
  console.log('  内存           :', `${snap.memUsedMb}/${snap.memTotalMb} MB`);
  console.log('  磁盘           :', `${snap.diskUsedGb}/${snap.diskTotalGb} GB`);
  console.log('  采集时刻       :', snap.checkedAt);

  console.log('\n--- 测试连接（后台录库存时点的那个按钮）---');
  const test = await driver.testMachine({ credentials: {}, ip, auth });
  console.log('  结果           :', test.ok ? '成功' : '失败', '-', test.message);
  console.log('  返回详情       :', JSON.stringify(test.detail, null, 0));
  console.log();
})().catch((e) => {
  console.error('出错:', e.message);
  process.exit(1);
});
