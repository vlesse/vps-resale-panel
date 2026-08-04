import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/** Proxmox API credentials stored inside inventory auth blob. */
export type ProxmoxAuthConfig = {
  host: string;
  port?: number;
  protocol?: 'https' | 'http';
  /** API token id, e.g. root@pam!panel */
  tokenId?: string;
  tokenSecret?: string;
  /** Password auth fallback (less preferred than token). */
  username?: string;
  password?: string;
  node: string;
  vmid: number;
  /** Accept self-signed PVE certs (common in homelab). Default true. */
  verifyTls?: boolean;
  /** Template VMID used for full reinstall/clone. */
  templateVmid?: number;
  storage?: string;
  bridge?: string;
  ciUser?: string;
  /** cloud-init ipconfig0, e.g. ip=10.0.0.50/24,gw=10.0.0.1 */
  ipconfig0?: string;
  nameserver?: string;
};

/**
 * Unified encrypted payload for inventory machines.
 * - SSH-only resale boxes: username/password/privateKey
 * - Proxmox VMs: pve block required; username/password optional for guest SSH fallback
 */
export type ServerAuthPayload = {
  username?: string;
  password?: string;
  privateKey?: string;
  pve?: ProxmoxAuthConfig;
};

function keyFromSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encryptJson(secret: string, data: unknown): string {
  const iv = randomBytes(12);
  const key = keyFromSecret(secret);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptJson<T>(secret: string, payload: string): T {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const key = keyFromSecret(secret);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(dec.toString('utf8')) as T;
}
