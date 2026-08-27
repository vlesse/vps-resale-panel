/**
 * Prisma 的主键是 BigInt，JSON.stringify 直接对 BigInt 抛错。
 * 全局统一转成字符串 —— 转成 number 的话超过 2^53 会悄悄丢精度。
 */
export function serialize<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return v.toString();
      return v;
    }),
  );
}

/** 从任何形状里剔掉敏感字段，返回给前端之前必须过一遍 */
const SECRET_KEYS = [
  'passwordHash',
  'credentialsEncrypted',
  'authPayloadEncrypted',
  'privateKey',
  'secretAccessKey',
  'serviceAccountKey',
  'tokenSecret',
  'appSecret',
];

export function stripSecrets<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripSecrets) as unknown as T;
  const out: any = {};
  for (const [k, v] of Object.entries(value as any)) {
    if (SECRET_KEYS.includes(k)) continue;
    out[k] = stripSecrets(v);
  }
  return out;
}
