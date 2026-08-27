import * as crypto from 'crypto';

/**
 * 凭据加密。所有云账号密钥、机器 SSH 密码/私钥、支付通道商户密钥
 * 都以密文入库，密钥由 .env 里的 CREDENTIALS_SECRET 派生。
 *
 * 一旦库里写过数据，CREDENTIALS_SECRET 就不能再改 —— 改了历史密文全部解不开。
 */

const ALGO = 'aes-256-gcm';
const SALT = 'vps-resale-panel:v1';

function deriveKey(secret: string): Buffer {
  if (!secret || secret.length < 32) {
    throw new Error('CREDENTIALS_SECRET 至少要 32 个字符，请在 .env 里设一个足够长的随机值');
  }
  return crypto.scryptSync(secret, SALT, 32);
}

/** 加密任意 JSON，输出 `iv.tag.密文` 的 base64url 串 */
export function encryptJson(secret: string, payload: unknown): string {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(payload ?? null), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64url'),
    tag.toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

/** 解密。密文被篡改会抛错（GCM 自带完整性校验），不会静默返回错数据。 */
export function decryptJson<T = any>(secret: string, blob: string): T {
  if (!blob) throw new Error('密文为空');
  const parts = blob.split('.');
  if (parts.length !== 3) throw new Error('密文格式不对，应为 iv.tag.body');
  const key = deriveKey(secret);
  const [iv, tag, body] = parts.map((p) => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  return JSON.parse(plain) as T;
}

/** 解密失败时返回 null 而不是抛错，用于「能读就读，读不到就算了」的场景 */
export function tryDecryptJson<T = any>(secret: string, blob?: string | null): T | null {
  if (!blob) return null;
  try {
    return decryptJson<T>(secret, blob);
  } catch {
    return null;
  }
}

// 全部剔除了 O/0、l/1/I 这些抄错率高的字符 —— 用户是要手抄进 SSH 客户端的
const PW_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PW_LOWER = 'abcdefghijkmnpqrstuvwxyz';
const PW_DIGIT = '23456789';
const PW_SYMBOL = '!@#%^*-_=+';

/**
 * 生成给用户的 root 密码。
 *
 * 保证四类字符各至少一个 —— 不是生成完再打补丁（补丁会互相覆盖：补符号时
 * 很可能正好盖掉唯一的那个大写字母），而是先每类各取一个、剩下的随机填，
 * 最后整体洗牌。这样组成是构造出来的，不依赖运气。
 *
 * 取随机数用 crypto.randomInt 而不是 randomBytes 取模 —— 取模会让
 * 排在字符表前面的字符出现概率偏高，虽然不致命但没必要。
 */
export function generatePassword(length = 16): string {
  if (length < 8) throw new Error('密码至少 8 位');
  const all = PW_UPPER + PW_LOWER + PW_DIGIT + PW_SYMBOL;

  const chars = [
    pickChar(PW_UPPER),
    pickChar(PW_LOWER),
    pickChar(PW_DIGIT),
    pickChar(PW_SYMBOL),
    ...Array.from({ length: length - 4 }, () => pickChar(all)),
  ];

  // Fisher-Yates 洗牌，否则前四位的类型是固定的
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function pickChar(pool: string): string {
  return pool[crypto.randomInt(pool.length)];
}

export interface SshKeyPair {
  /** PKCS#1 PEM，ssh2 能直接吃 */
  privateKeyPem: string;
  /** OpenSSH authorized_keys 那一行的格式：`ssh-rsa AAAA... comment` */
  publicKeyOpenssh: string;
}

/**
 * 生成面板自己用的 SSH 密钥对。
 *
 * 为什么要有这个：交付给用户的是密码，用户随时可能自己改掉。面板后续要执行
 * 「重启 / 改密 / 查状态」这些操作就进不去了。所以建机时同时塞一把面板专用公钥，
 * 面板永远走密钥进，和用户的密码互不干扰。
 *
 * 用 RSA 而不是 ed25519：Node 导不出 OpenSSH 格式的 ed25519 私钥，
 * 而 ssh2 对 PKCS#1 的 RSA PEM 支持最稳。
 */
export function generateSshKeyPair(comment = 'vps-resale-panel'): SshKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  const jwk = crypto.createPublicKey(publicKey).export({ format: 'jwk' }) as {
    n: string;
    e: string;
  };
  const n = Buffer.from(jwk.n, 'base64url');
  const e = Buffer.from(jwk.e, 'base64url');

  const blob = Buffer.concat([
    sshString(Buffer.from('ssh-rsa')),
    sshString(mpint(e)),
    sshString(mpint(n)),
  ]);

  return {
    privateKeyPem: privateKey,
    publicKeyOpenssh: `ssh-rsa ${blob.toString('base64')} ${comment}`,
  };
}

/** SSH 线格式的 string：4 字节大端长度 + 内容 */
function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

/** SSH 线格式的 mpint：最高位是 1 时要补一个 0x00，否则会被当成负数 */
function mpint(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  const trimmed = buf.subarray(i);
  return trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed;
}

/** 订单号 / 服务号 / 机器编号：时间前缀 + 随机尾巴，便于人工排查时按时间定位 */
export function generateCode(prefix: string, randomLen = 6): string {
  const now = new Date();
  const stamp =
    now.getUTCFullYear().toString().slice(2) +
    String(now.getUTCMonth() + 1).padStart(2, '0') +
    String(now.getUTCDate()).padStart(2, '0') +
    String(now.getUTCHours()).padStart(2, '0') +
    String(now.getUTCMinutes()).padStart(2, '0') +
    String(now.getUTCSeconds()).padStart(2, '0');
  const tail = crypto.randomBytes(randomLen).toString('hex').slice(0, randomLen);
  return `${prefix}${stamp}${tail}`;
}
