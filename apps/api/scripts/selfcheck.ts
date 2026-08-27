/**
 * 自检脚本：验证那些「写错了不会立刻报错、但会在生产上悄悄坏掉」的地方。
 * 跑法：npx ts-node scripts/selfcheck.ts
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { utils } from 'ssh2';
import {
  decryptJson,
  encryptJson,
  generatePassword,
  generateSshKeyPair,
} from '../src/crypto/crypto.util';
import { buildBootstrapScript } from '../src/providers/bootstrap.util';
import { toInstanceName } from '../src/providers/provider.types';
import { parseProbeOutput } from '../src/providers/ssh-exec.util';
import { JeepayDriver } from '../src/payments/drivers/jeepay.driver';

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  ' + extra : ''}`);
};

console.log('\n[1] SSH 公钥编码 —— 拼错的话每台交付的机器都进不去');
const kp = generateSshKeyPair('panel-test');
const parsed = utils.parseKey(kp.privateKeyPem);
if (parsed instanceof Error) {
  check('ssh2 能解析我们生成的私钥', false, parsed.message);
} else {
  check('ssh2 能解析我们生成的私钥', true, `类型 ${parsed.type}`);
  const mine = Buffer.from(kp.publicKeyOpenssh.split(' ')[1], 'base64');
  const theirs = parsed.getPublicSSH();
  check(
    '我们手工拼的公钥与 ssh2 推导的二进制一致',
    Buffer.compare(mine, theirs) === 0,
    `${mine.length} 字节`,
  );
  check('公钥是 authorized_keys 的合法格式', /^ssh-rsa [A-Za-z0-9+/]+=* \S+$/.test(kp.publicKeyOpenssh));
}

console.log('\n[2] 凭据加解密 —— 关系到云账号密钥和每台机器的密码');
const secret = 'x'.repeat(40);
const payload = { projectId: 'demo', nested: { k: [1, 2, '三'] }, 中文键: '中文值' };
const blob = encryptJson(secret, payload);
check('加解密往返数据一致', JSON.stringify(decryptJson(secret, blob)) === JSON.stringify(payload));
check('两次加密同样内容密文不同（IV 随机）', encryptJson(secret, payload) !== blob);

const flip = (s: string) => s.slice(0, -2) + (s.slice(-2, -1) === 'A' ? 'B' : 'A') + s.slice(-1);
check('密文被篡改会抛错而不是返回错数据', throws(() => decryptJson(secret, flip(blob))));
check('换一个密钥解不开', throws(() => decryptJson('y'.repeat(40), blob)));
check('密钥太短直接拒绝', throws(() => encryptJson('short', payload)));

console.log('\n[3] 交付密码 —— 要能过各家系统的密码策略，还要方便用户手抄');
const pws = Array.from({ length: 500 }, () => generatePassword(16));
check('长度都是 16', pws.every((p) => p.length === 16));
check(
  '都含大写/小写/数字/符号',
  pws.every((p) => /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[!@#%^*\-_=+]/.test(p)),
);
check('不含易抄错的 O 0 l I 1', pws.every((p) => !/[O0lI1]/.test(p)), `样例 ${pws[0]}`);
check('500 个互不重复', new Set(pws).size === 500);

console.log('\n[4] 初始化脚本 —— 密码里的特殊字符不能把 shell 搞断');
// 下面每一个字符在没转义时都能把命令搞断，甚至变成命令注入
const nasty = `a'b"c$d\`e;f|g&h i*j(k)`;
const script = buildBootstrapScript({
  username: 'root',
  password: nasty,
  publicKeyOpenssh: kp.publicKeyOpenssh,
  hostname: 'test-host',
});
// 不做字符串比对，直接丢给真的 bash 跑一遍，看密码能不能一字不差还原出来
const chpasswdLine = script.split('\n').find((l) => l.includes('| chpasswd'))!;
const echoOnly = chpasswdLine.replace(/\s*\|\s*chpasswd\s*$/, '');
const roundTrip = execFileSync('bash', ['-c', echoOnly], { encoding: 'utf8' }).replace(/\r?\n$/, '');
check('bash 解析后密码一字不差', roundTrip === `root:${nasty}`, `得到 ${JSON.stringify(roundTrip)}`);
check('整段脚本 bash -n 语法检查通过', bashSyntaxOk(script));
check('sshd 覆盖文件用 00 开头（否则压不过云镜像的 60-）', script.includes('/etc/ssh/sshd_config.d/00-vps-panel.conf'));
check('写了完成标记文件', script.includes('/var/lib/vps-panel-bootstrap.done'));
check('开了 BBR', script.includes('tcp_congestion_control=bbr'));

console.log('\n[5] 实例命名 —— 各家云都要求小写字母开头');
const cases: [string, RegExp][] = [
  // 大写编号小写后已经是字母打头，本来就不需要再加前缀
  ['ORD250827abc123', /^ord250827abc123$/],
  ['9start', /^vps-9start$/],
  ['a_b.c!d', /^a-b-c-d$/],
  ['--lead--', /^lead$/],
];
for (const [input, want] of cases) {
  const got = toInstanceName(input);
  check(`"${input}" → "${got}"`, want.test(got));
}
check('超长编号被截到 62 字符内', toInstanceName('x'.repeat(200)).length <= 62);

console.log('\n[6] 状态采集的解析 —— 真机上栽过一次的地方');
// 下面这段是 2026-08-27 从真机（Debian 13）上原样抓下来的输出。
// df 的两个数字前面带空格，当时正则要求 DISK= 后紧跟数字，磁盘用量一直是 undefined，
// 本地看代码完全看不出来。这条用例就是为了不让它再回来。
const realOutput =
  'CPU=10 MEMTOTAL=7945 MEMAVAIL=4977 UPTIME=1722219 LOAD=0.9 DISK=  23       48 NET=227404107888 197798043599';
const probe = parseProbeOutput(realOutput);
check('磁盘已用解析正确（前导空格不能吃掉它）', probe.diskUsedGb === 23, String(probe.diskUsedGb));
check('磁盘总量解析正确', probe.diskTotalGb === 48, String(probe.diskTotalGb));
check('内存已用 = 总量 - 可用', probe.memUsedMb === 7945 - 4977, String(probe.memUsedMb));
check('CPU 解析正确', probe.cpuPercent === 10);
check('负载是小数不是整数', probe.loadAvg1 === 0.9);
check('网络累计字节是大数（不能被截断）', probe.netInBytes === 227404107888);

// 紧凑格式（没有多余空格）也要能解析，不同发行版的 awk 对齐方式不一样
const tight = 'CPU=5 MEMTOTAL=1024 MEMAVAIL=512 UPTIME=60 LOAD=0.01 DISK=1 20 NET=100 200';
const p2 = parseProbeOutput(tight);
check('紧凑格式也能解析', p2.diskUsedGb === 1 && p2.diskTotalGb === 20 && p2.netOutBytes === 200);

// 机器返回垃圾时不能崩，要优雅地返回 undefined
const garbage = parseProbeOutput('bash: command not found\nsome noise');
check('输出是垃圾时不抛错', typeof garbage === 'object');
check('垃圾输入下各字段是 undefined 而不是 NaN', garbage.cpuPercent === undefined && garbage.diskUsedGb === undefined);

console.log('\n[7] Jeepay 签名 —— 错一个字节网关只会回「签名错误」四个字');
const jee = new JeepayDriver();
const KEY = 'test_app_secret_123';

// 手工按规则算一遍标准答案，和实现对拍
const sample = { mchNo: 'M001', appId: 'app1', amount: 4500, mchOrderNo: 'ORD1' };
const manual = createHash('md5')
  .update('amount=4500&appId=app1&mchNo=M001&mchOrderNo=ORD1&key=' + KEY, 'utf8')
  .digest('hex')
  .toUpperCase();
check('签名与手工按规则计算的结果一致', jee.sign(sample, KEY) === manual, jee.sign(sample, KEY).slice(0, 16) + '…');
check('参数顺序不影响结果（内部按 ASCII 排序）',
  jee.sign({ appId: 'app1', amount: 4500, mchOrderNo: 'ORD1', mchNo: 'M001' }, KEY) === manual);
check('结果是大写十六进制', /^[0-9A-F]{32}$/.test(jee.sign(sample, KEY)));

// 这一条是踩过的坑：用 if (v) 过滤会把数字 0 和字符串 "0" 一起扔掉，
// 而网关那边是把它算进签名的，于是永远「签名错误」，还查不出来。
const withZero = { ...sample, state: 0, refundAmount: '0' };
const zeroManual = createHash('md5')
  .update('amount=4500&appId=app1&mchNo=M001&mchOrderNo=ORD1&refundAmount=0&state=0&key=' + KEY, 'utf8')
  .digest('hex')
  .toUpperCase();
check('值为 0 的参数必须参与签名', jee.sign(withZero, KEY) === zeroManual);
check('空字符串参数必须排除', jee.sign({ ...sample, extra: '' }, KEY) === manual);
check('null / undefined 参数必须排除',
  jee.sign({ ...sample, a: null, b: undefined } as any, KEY) === manual);
check('sign 字段本身不参与签名', jee.sign({ ...sample, sign: 'WHATEVER' }, KEY) === manual);

// 验签
const signed = { ...sample, sign: manual };
check('自己签的自己能验过', jee.verify(signed, KEY));
check('换个密钥验不过', !jee.verify(signed, 'wrong_secret'));
check('改了金额验不过', !jee.verify({ ...signed, amount: 1 }, KEY));
check('没有 sign 字段直接拒绝', !jee.verify(sample as any, KEY));
check('签名长度不对不会抛错只会返回 false', !jee.verify({ ...sample, sign: 'SHORT' }, KEY));

// 回调解析：只有 state=2 才是成功
const notifyBase = { mchOrderNo: 'ORD1', payOrderId: 'P1', amount: 4500 };
const mk = (state: number) => {
  const p: any = { ...notifyBase, state };
  p.sign = jee.sign(p, KEY);
  return p;
};
check('state=2 判定为支付成功', jee.parseNotify(mk(2), { appSecret: KEY } as any).success);
for (const s of [0, 1, 3, 4, 5, 6]) {
  check(`state=${s} 不能判成成功`, !jee.parseNotify(mk(s), { appSecret: KEY } as any).success);
}
check('验签不过时 valid=false 且 success=false', (() => {
  const r = jee.parseNotify({ ...notifyBase, state: 2, sign: 'FAKE' }, { appSecret: KEY } as any);
  return !r.valid && !r.success;
})());

console.log(failed === 0 ? '\n全部通过\n' : `\n有 ${failed} 项没过\n`);
process.exit(failed === 0 ? 0 : 1);

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/** 把脚本写到临时文件用 bash -n 做语法检查，能抓出引号不配对这类问题 */
function bashSyntaxOk(script: string): boolean {
  const f = join(tmpdir(), `vps-bootstrap-check-${Date.now()}.sh`);
  try {
    writeFileSync(f, script, 'utf8');
    execFileSync('bash', ['-n', f], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  } finally {
    try { unlinkSync(f); } catch { /* 已经没了就算了 */ }
  }
}
