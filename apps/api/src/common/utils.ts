import { createHash } from 'crypto';

/** Jeepay MD5 sign: sort key=value& ... + key=appSecret, MD5 upper */
export function jeepaySign(
  params: Record<string, unknown>,
  appSecret: string,
): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (k === 'sign') continue;
    if (v === null || v === undefined || v === '') continue;
    let val: string;
    if (typeof v === 'boolean') val = v ? 'true' : 'false';
    else val = String(v);
    parts.push(`${k}=${val}&`);
  }
  parts.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const str = parts.join('') + 'key=' + appSecret;
  return createHash('md5').update(str, 'utf8').digest('hex').toUpperCase();
}

export function genOrderNo(prefix = 'VR'): string {
  const t = Date.now().toString();
  const r = Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, '0');
  return `${prefix}${t}${r}`;
}

export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

export function serialize<T extends Record<string, any>>(row: T): any {
  if (row === null || row === undefined) return row;
  if (Array.isArray(row)) return row.map((x) => serialize(x));
  if (typeof row !== 'object') return row;
  if (row instanceof Date) return row.toISOString();
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') out[k] = v.toString();
    else if (v instanceof Date) out[k] = v.toISOString();
    else if (v && typeof v === 'object') out[k] = serialize(v);
    else out[k] = v;
  }
  return out;
}
