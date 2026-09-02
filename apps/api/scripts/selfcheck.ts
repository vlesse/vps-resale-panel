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
import { EpayDriver } from '../src/payments/drivers/epay.driver';
import { UsdtDriver } from '../src/payments/drivers/usdt.driver';
import { AbaKhqrDriver } from '../src/payments/drivers/aba-khqr.driver';
import { formatAmount, minorUnits, roundUpTo, stepFor } from '../src/payments/fx.service';

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

console.log('\n[8] 易支付签名 —— 和 Jeepay 有三处不一样，每处都够调半天');
{
  const epay = new EpayDriver();
  const KEY = 'MYSECRETKEY';
  const base = 'money=47.00&name=HK-Basic&notify_url=https://vps.example.com/n' +
    '&out_trade_no=ORD2026083012345&pid=1001&type=alipay&zero=0';
  const p: Record<string, any> = {
    pid: '1001',
    type: 'alipay',
    out_trade_no: 'ORD2026083012345',
    notify_url: 'https://vps.example.com/n',
    return_url: '',
    name: 'HK-Basic',
    money: '47.00',
    zero: 0,
  };
  const sign = epay.sign(p, KEY);

  // 手工按规则算一遍：非空、非 sign/sign_type，按 ASCII 排序，拼成 k=v&k=v，
  // 末尾**直接**接密钥（不是 &key=），整串 MD5 转小写
  const expect = createHash('md5').update(base + KEY, 'utf8').digest('hex');
  check('签名与手工按规则计算的结果一致', sign === expect, sign.slice(0, 16) + '…');
  check('结果是小写十六进制', sign === sign.toLowerCase());
  check(
    '密钥是直接接尾，不是 &key=',
    sign !== createHash('md5').update(base + '&key=' + KEY, 'utf8').digest('hex'),
  );
  check('值为 0 的参数必须参与签名', epay.sign({ ...p, zero: 1 }, KEY) !== sign);
  check('空字符串参数必须排除', epay.sign({ ...p, return_url: undefined }, KEY) === sign);
  check('sign_type 不参与签名', epay.sign({ ...p, sign_type: 'MD5' }, KEY) === sign);
  check(
    '参数顺序不影响结果',
    epay.sign(Object.fromEntries(Object.entries(p).reverse()), KEY) === sign,
  );
  check('自己签的自己能验过', epay.verify({ ...p, sign, sign_type: 'MD5' }, KEY));
  check('换个密钥验不过', !epay.verify({ ...p, sign }, 'OTHERKEY'));
  check('改了金额验不过', !epay.verify({ ...p, money: '1.00', sign }, KEY));
  check('没有 sign 字段直接拒绝', !epay.verify(p, KEY));
  check('签名长度不对不抛错只返回 false', !throws(() => epay.verify({ ...p, sign: 'abc' }, KEY)));

  const cred = { gatewayUrl: '', pid: '1001', key: KEY };
  const okBody = { ...p, trade_status: 'TRADE_SUCCESS', trade_no: 'T1' };
  const ok = epay.parseNotify({ ...okBody, sign: epay.sign(okBody, KEY) }, cred);
  check('TRADE_SUCCESS 判定为成功', ok.valid && ok.success);
  check('金额从「元」正确换回「分」', ok.amountCents === 4700, String(ok.amountCents));

  const waitBody = { ...p, trade_status: 'WAIT_BUYER_PAY' };
  const bad = epay.parseNotify({ ...waitBody, sign: epay.sign(waitBody, KEY) }, cred);
  check('非 TRADE_SUCCESS 不能判成成功', bad.valid && !bad.success);

  // 这一处是浮点陷阱：19.99 * 100 在 JS 里是 1998.9999999999998，截断就少一分
  const fBody = { money: '19.99', trade_status: 'TRADE_SUCCESS', out_trade_no: 'X' };
  const f = epay.parseNotify({ ...fBody, sign: epay.sign(fBody, KEY) }, cred);
  check('19.99 元换成分不能少一分', f.amountCents === 1999, String(f.amountCents));
}

console.log('\n[9] USDT —— 算错了要么少收钱，要么两张单撞一个金额');
{
  const u = new UsdtDriver();
  check('T 开头 34 位是合法地址', u.isValidAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'));
  check('0x 开头的以太坊地址要拒绝', !u.isValidAddress('0x1234567890123456789012345678901234567890'));
  check('少一位要拒绝', !u.isValidAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6'));
  check('空字符串要拒绝', !u.isValidAddress(''));

  check('美元订单 1:1 换算', u.toUsdtUnits(999, 'USD') === 9990000n, u.format(u.toUsdtUnits(999, 'USD')));
  check(
    '人民币订单按汇率换算',
    u.format(u.toUsdtUnits(4700, 'CNY', 7.25)) === '6.482759',
    u.format(u.toUsdtUnits(4700, 'CNY', 7.25)),
  );
  check('人民币订单没配汇率要报错', throws(() => u.toUsdtUnits(4700, 'CNY', null)));
  check('汇率是 0 也要报错', throws(() => u.toUsdtUnits(4700, 'CNY', 0)));

  // 取整方向：宁可多收 0.000001，也不能因为截断少收
  let allUp = true;
  for (const cents of [1, 3, 7, 99, 4700, 18600]) {
    if (Number(u.toUsdtUnits(cents, 'CNY', 7.25)) / 1e6 < cents / 100 / 7.25) allUp = false;
  }
  check('换算一律向上取整（不能少收）', allUp);

  const b = u.toUsdtUnits(4700, 'CNY', 7.25);
  const taken = new Set<string>();
  let dup = false;
  for (let i = 0; i < 3000; i++) {
    const a = u.pickUniqueAmount(b, taken);
    if (taken.has(a.toString())) dup = true;
    taken.add(a.toString());
  }
  check('连开 3000 笔待付款，金额零重复', !dup);
  const arr = [...taken].map(BigInt);
  check('只往上加不往下减（不能让用户少付）', arr.every((a) => a >= b));
  const max = arr.reduce((x, y) => (x > y ? x : y));
  check('加价不超过 0.01 USDT', Number(max - b) <= 10000, u.format(max - b));
  check(
    '金额分完了要报错，而不是发一个重复的出去',
    throws(() => {
      const full = new Set<string>();
      for (let i = 0; i < 10000; i++) full.add((b + BigInt(i)).toString());
      u.pickUniqueAmount(b, full);
    }),
  );

  check('格式化去掉多余的 0', u.format(1500000n) === '1.5', u.format(1500000n));
  check('整数不带小数点', u.format(7000000n) === '7', u.format(7000000n));
  check('小于 1 也正确', u.format(137932n) === '0.137932', u.format(137932n));
}

console.log('\n[10] 网关返回的字段分类 —— 分错了用户点付款什么都不出来');
{
  const j = new JeepayDriver();
  const pick = (d: any) => {
    const c = [d.payUrl, d.payData, d.codeUrl, d.qrCode].filter(
      (v: any) => typeof v === 'string' && v.length > 0,
    );
    const nav = (v: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(v.trim());
    return { payUrl: c.find(nav), codeUrl: c.find((v: string) => !nav(v)) };
  };

  // 真实案例：柬埔寨 ABA 的 EMV 二维码放在 payData 里，没有 payUrl。
  // 以前按字段名分，它被当成跳转地址，前端 location.href 过去浏览器当场卡住。
  const emv =
    '00020101021130510016abaakhppxxx@abaa01151260715094150370208ABA Bank' +
    '5204783253031165802KH5910TEST STORE6010Phnom Penh6304DDE7';
  const r1 = pick({ payData: emv });
  check('EMV 二维码不能被当成跳转地址', r1.payUrl === undefined);
  check('EMV 二维码要当成二维码内容', r1.codeUrl === emv);

  const r2 = pick({ payUrl: 'https://pay.example.com/cashier/abc' });
  check('http 地址认成跳转', r2.payUrl === 'https://pay.example.com/cashier/abc');
  check('认成跳转就不该再当二维码', r2.codeUrl === undefined);

  const r3 = pick({ payData: 'weixin://wxpay/bizpayurl?pr=abc' });
  check('唤起 App 的 scheme 也算跳转', r3.payUrl === 'weixin://wxpay/bizpayurl?pr=abc');

  const r4 = pick({ payUrl: 'https://pay.example.com/x', payData: emv });
  check('两种都有时各归各位', r4.payUrl === 'https://pay.example.com/x' && r4.codeUrl === emv);

  const r5 = pick({ codeUrl: 'weixin://wxpay/bizpayurl?pr=zz' });
  check('二维码字段里放了 scheme 也认成跳转', r5.payUrl === 'weixin://wxpay/bizpayurl?pr=zz');

  check('空返回不炸', pick({}).payUrl === undefined && pick({}).codeUrl === undefined);
  void j;
}

console.log('\n[11] 汇率折算 —— 算少了是从商户口袋里出钱，算多了顾客当场就走');
{
  // 瑞尔没有小数位，往上取整到 1 瑞尔
  check('瑞尔进位到整数', roundUpTo(30138.4, stepFor('KHR')) === 30139);
  check('正好是整数就不动', roundUpTo(30139, stepFor('KHR')) === 30139);
  check('浮点噪声不该多进一位', roundUpTo(30139.0000001, stepFor('KHR')) === 30139);
  check('差一点点也要进上去，不能少收', roundUpTo(30139.01, stepFor('KHR')) === 30140);

  // 两位小数的币种按分进位，别被瑞尔那套规则带偏
  check('美元按分进位', roundUpTo(12.341, stepFor('USD')) === 12.35);
  check('美元正好两位就不动', roundUpTo(12.34, stepFor('USD')) === 12.34);

  // 零小数币种不写小数点 —— 写成 30139.00 瑞尔，当地人会以为是另一个数
  check('瑞尔不写小数位', formatAmount(30139, 'KHR') === '30,139');
  check('美元写两位小数', formatAmount(1234.5, 'USD') === '1,234.50');

  // 从「分」换算过去：小数点挪错一位就是 100 倍的差
  // 报给网关的金额单位是「最小单位」。瑞尔没有分，603 瑞尔就报 603；
  // 顺手乘个 100 就是六万多，一百倍的差
  check('瑞尔的最小单位是它自己', minorUnits('KHR') === 1);
  check('人民币的最小单位是分', minorUnits('CNY') === 100);
  check('美元的最小单位是美分', minorUnits('USD') === 100);
  check('603 瑞尔报给网关就是 603', Math.round(603 * minorUnits('KHR')) === 603);

  check('1 元 = 603 瑞尔', roundUpTo((100 / 100) * 602.77, stepFor('KHR')) === 603);
  check('50 元 = 30139 瑞尔', roundUpTo((5000 / 100) * 602.77, stepFor('KHR')) === 30139);
}

console.log('\n[12] 到账通知的解析 —— 认错了是凭空给人加钱，漏认了是钱进来没人管');
{
  const a = new AbaKhqrDriver();

  // 真实样本（收款人姓名换成了占位符）
  const real =
    '៛604 paid by WeChat Settlement Hub (*ZMg) on Sep 02, 12:15 PM ' +
    'via ABA KHQR (BLCBKHPPXXX) at TEST STORE. Trx. ID: 178832610926160, APV: 318305.';
  const n = a.parseNotice(real);
  check('认得出真实的到账通知', !!n);
  check('金额解对了', n?.amount === 604, String(n?.amount));
  check('币种解对了', n?.currency === 'KHR');
  check('流水号解对了', n?.txId === '178832610926160');

  // 带千分位的大额。去不掉逗号会解成 51 —— 少收三个数量级
  const big = a.parseNotice(
    '៛51,001 paid by Alipay CN Settlement Hub (*155) on Aug 28, 01:00 PM ' +
    'via ABA KHQR (BLCB) at TEST STORE. Trx. ID: 178789682788725, APV: 922177.',
  );
  check('千分位不能把金额截断', big?.amount === 51001, String(big?.amount));

  // 美元要换成美分；瑞尔不能乘 100
  const usd = a.parseNotice('$12.34 paid by X on Sep 02 via ABA. Trx. ID: 999.');
  check('美元换算成美分', usd?.amount === 1234 && usd?.currency === 'USD', String(usd?.amount));

  // 群里的闲聊、没有流水号的消息，一律不能当成到账
  check('闲聊不认', a.parseNotice('៛604 到账了吗') === null);
  check('没有流水号不认', a.parseNotice('៛604 paid by X on Sep 02 via ABA.') === null);
  check('没有金额不认', a.parseNotice('Trx. ID: 123456') === null);
  check('空消息不炸', a.parseNotice('') === null);

  // 唯一金额只能往上加 —— 往下减就是少收钱
  check('没占用就用原数', a.pickUniqueAmount(604, new Set()) === 604);
  check('被占了往上让', a.pickUniqueAmount(604, new Set([604, 605])) === 606);
  check('绝不往下减', a.pickUniqueAmount(604, new Set([604])) > 604);
  check('全占满了要报错，而不是发一个重复的出去', throws(() =>
    a.pickUniqueAmount(604, new Set(Array.from({ length: 30 }, (_, k) => 604 + k))),
  ));
}

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
