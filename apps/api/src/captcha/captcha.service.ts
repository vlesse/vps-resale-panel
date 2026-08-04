import { Injectable, OnModuleDestroy } from '@nestjs/common';
import * as svgCaptcha from 'svg-captcha';
import { randomUUID } from 'crypto';

type Entry = { text: string; expiresAt: number; used: boolean };

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 5000;

@Injectable()
export class CaptchaService implements OnModuleDestroy {
  private store = new Map<string, Entry>();
  private sweepTimer: NodeJS.Timeout;

  constructor() {
    // periodic cleanup every 2 minutes
    this.sweepTimer = setInterval(() => this.sweep(), 2 * 60 * 1000);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Generate a new captcha challenge. Returns id + inline SVG string. */
  issue() {
    const c = svgCaptcha.create({
      size: 4,
      ignoreChars: '0oO1ilI',
      noise: 3,
      color: true,
      background: '#0f172a',
    });
    const id = randomUUID();
    const text = String(c.text || '').toLowerCase();
    this.store.set(id, { text, expiresAt: Date.now() + TTL_MS, used: false });
    if (this.store.size > MAX_ENTRIES) this.sweep();
    return { id, svg: c.data };
  }

  /** Verify and consume (one-shot). Case-insensitive. */
  verify(id: string, code: string): boolean {
    if (!id || !code) return false;
    const entry = this.store.get(id);
    if (!entry) return false;
    // one-shot: delete regardless of result so it can't be replayed
    this.store.delete(id);
    if (Date.now() > entry.expiresAt) return false;
    return entry.text === String(code).toLowerCase().trim();
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (v.used || now > v.expiresAt) this.store.delete(k);
    }
  }
}
