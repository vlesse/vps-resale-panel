import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { encryptJson, decryptJson } from '../crypto/crypto.util';
import { serialize } from '../common/utils';

/**
 * Admin-managed payment channels (Jeepay ABA KHQR / ABA PayWay / crypto TRX_USDT ...).
 *
 * Credentials (appSecret / apiToken / merchant secrets) are stored AES-256-GCM
 * encrypted with CREDENTIALS_SECRET — same scheme as inventory auth blobs.
 *
 * Public checkout only ever sees: id, code, name, icon, channel, wayCode,
 * settleCurrency, rate, usdToCnyRate, descText, settleHint. Never secrets.
 */
@Injectable()
export class PayChannelsService {
  private readonly logger = new Logger(PayChannelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private secret(): string {
    return this.config.get<string>('CREDENTIALS_SECRET') || 'dev-secret';
  }

  /** Public list for checkout — no secrets */
  private db() {
    // Prisma client is regenerated after schema change; cast for local typecheck.
    return this.prisma as any;
  }

  async listPublic() {
    const rows = await this.db().payChannel.findMany({
      where: { isEnabled: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r: any) => this.toPublic(r));
  }

  /** Admin list — includes meta, secrets masked */
  async listAdmin() {
    const rows = await this.db().payChannel.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return serialize(rows.map((r: any) => this.toAdmin(r)));
  }

  async getOneAdmin(id: string) {
    const row = await this.db().payChannel.findUnique({
      where: { id: BigInt(id) },
    });
    if (!row) throw new NotFoundException('Pay channel not found');
    return serialize(this.toAdmin(row));
  }

  private toPublic(r: any) {
    return {
      id: r.code, // stable code as id for checkout
      code: r.code,
      name: r.name,
      icon: r.icon,
      channel: r.channel,
      wayCode: r.wayCode,
      settleCurrency: r.settleCurrency,
      rate: r.rate,
      usdToCnyRate: r.usdToCnyRate,
      desc: r.descText,
      settleHint: this.settleHint(r),
    };
  }

  private toAdmin(r: any) {
    let creds: Record<string, any> = {};
    try {
      creds = decryptJson(this.secret(), r.credentialsEncrypted) || {};
    } catch {
      creds = { _error: 'decrypt failed' };
    }
    return {
      ...this.toPublic(r),
      id: String(r.id),
      isEnabled: r.isEnabled,
      sortOrder: r.sortOrder,
      gatewayUrl: r.gatewayUrl,
      notes: r.notes,
      credentials: this.maskCreds(creds),
      credentialsKeys: Object.keys(creds),
    };
  }

  /** Return decrypted creds for internal use by OrdersService (never serialized out) */
  async getActiveByCode(code: string) {
    const row = await this.db().payChannel.findUnique({
      where: { code },
    });
    if (!row || !row.isEnabled) return null;
    let credentials: Record<string, any> = {};
    try {
      credentials = decryptJson(this.secret(), row.credentialsEncrypted) || {};
    } catch (e: any) {
      this.logger.warn(`decrypt failed for ${code}: ${e?.message || e}`);
    }
    return { row, credentials };
  }

  private settleHint(r: any): string {
    const cur = (r.settleCurrency || '').toUpperCase();
    if (r.channel === 'jeepay' && r.wayCode?.toUpperCase().includes('KHQR')) {
      return cur ? `实际支付：${cur}` : '实际支付：瑞尔 KHR';
    }
    if (r.channel === 'tokenpay') return '跳转 TokenPay 收银台';
    if (r.channel === 'jeepay' && r.wayCode?.toUpperCase().includes('ABA_PC')) {
      return cur ? `结算币：${cur}` : '结算币：USD';
    }
    if (r.channel === 'jeepay') return `Jeepay · ${r.wayCode}`;
    return cur ? `结算币：${cur}` : '';
  }

  private maskCreds(creds: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(creds)) {
      const s = String(v ?? '');
      if (!s) {
        out[k] = '';
      } else if (s.length <= 6) {
        out[k] = '****';
      } else {
        out[k] = s.slice(0, 3) + '****' + s.slice(-3);
      }
    }
    return out;
  }

  /** Schema of credential fields per channel type, for the admin form. */
  credSchema(channel: string, wayCode?: string): string[] {
    const c = String(channel || '').toLowerCase();
    const w = String(wayCode || '').toUpperCase();
    if (c === 'jeepay') {
      return [
        'mchNo',
        'appId',
        'appSecret',
        ...(w.includes('ABA_PC') ? [] : []),
      ];
    }
    if (c === 'tokenpay') {
      return ['apiToken'];
    }
    return ['appSecret'];
  }

  async create(body: any) {
    this.validate(body);
    const exists = await this.db().payChannel.findUnique({
      where: { code: body.code },
    });
    if (exists) throw new BadRequestException('code already exists');
    const creds = this.collectCreds(body);
    const row = await this.db().payChannel.create({
      data: {
        code: body.code,
        name: body.name,
        icon: body.icon || this.defaultIcon(body),
        channel: body.channel,
        wayCode: body.wayCode,
        settleCurrency: body.settleCurrency || null,
        gatewayUrl: body.gatewayUrl || null,
        credentialsEncrypted: encryptJson(this.secret(), creds),
        rate: body.rate != null && body.rate !== '' ? Number(body.rate) : null,
        usdToCnyRate:
          body.usdToCnyRate != null && body.usdToCnyRate !== ''
            ? Number(body.usdToCnyRate)
            : null,
        isEnabled: body.isEnabled !== false,
        sortOrder: Number(body.sortOrder || 0),
        descText: body.descText || null,
        notes: body.notes || null,
      },
    });
    this.logger.log(`created pay channel ${row.code}`);
    return serialize(this.toAdmin(row));
  }

  async update(id: string, body: any) {
    const row = await this.db().payChannel.findUnique({
      where: { id: BigInt(id) },
    });
    if (!row) throw new NotFoundException('Pay channel not found');

    const data: any = {};
    for (const f of [
      'name',
      'icon',
      'channel',
      'wayCode',
      'settleCurrency',
      'gatewayUrl',
      'descText',
      'notes',
    ]) {
      if (body[f] !== undefined) data[f] = body[f] === '' ? null : body[f];
    }
    for (const f of ['rate', 'usdToCnyRate', 'sortOrder']) {
      if (body[f] !== undefined && body[f] !== '')
        data[f] = Number(body[f]);
    }
    if (body.isEnabled !== undefined) data.isEnabled = !!body.isEnabled;

    // credentials: only re-encrypt if at least one secret field provided & non-empty
    const schema = this.credSchema(body.channel || row.channel, body.wayCode || row.wayCode);
    const provided = schema.filter((k) => body[k] && String(body[k]).trim());
    if (provided.length) {
      let prev: Record<string, any> = {};
      try {
        prev = decryptJson(this.secret(), row.credentialsEncrypted) || {};
      } catch {
        prev = {};
      }
      const merged = { ...prev };
      for (const k of provided) merged[k] = String(body[k]).trim();
      // if channel changed & new secret fields are required but not provided, keep old
      data.credentialsEncrypted = encryptJson(this.secret(), merged);
    }

    const updated = await this.db().payChannel.update({
      where: { id: BigInt(id) },
      data,
    });
    this.logger.log(`updated pay channel ${updated.code}`);
    return serialize(this.toAdmin(updated));
  }

  async remove(id: string) {
    const row = await this.db().payChannel.findUnique({
      where: { id: BigInt(id) },
    });
    if (!row) throw new NotFoundException('Pay channel not found');
    await this.db().payChannel.delete({ where: { id: BigInt(id) } });
    this.logger.log(`deleted pay channel ${row.code}`);
    return { ok: true };
  }

  async setEnabled(id: string, enabled: boolean) {
    const row = await this.db().payChannel.update({
      where: { id: BigInt(id) },
      data: { isEnabled: !!enabled },
    });
    return serialize(this.toAdmin(row));
  }

  private validate(body: any) {
    if (!body.code) throw new BadRequestException('code required');
    if (!body.name) throw new BadRequestException('name required');
    if (!body.channel) throw new BadRequestException('channel required');
    if (!body.wayCode && body.channel !== 'tokenpay')
      throw new BadRequestException('wayCode required');
  }

  private collectCreds(body: any): Record<string, any> {
    const schema = this.credSchema(body.channel, body.wayCode);
    const out: Record<string, any> = {};
    for (const k of schema) {
      if (body[k] != null && body[k] !== '') out[k] = String(body[k]);
    }
    return out;
  }

  private defaultIcon(body: any): string {
    const w = String(body.wayCode || '').toUpperCase();
    if (w.includes('KHQR')) return '🇰🇭';
    if (w.includes('ABA_PC')) return '🏦';
    if (w.includes('USDT') || w.includes('TRX')) return '🪙';
    if (body.channel === 'tokenpay') return '🪙';
    return '💳';
  }
}
