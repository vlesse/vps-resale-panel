import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 汇率。
 *
 * 存在的理由很具体：面板按人民币标价，但收款码是柬埔寨 ABA 的静态码 ——
 * 静态码里**不带金额**，顾客扫完要自己输。他手里是瑞尔，我们标的是人民币，
 * 不告诉他该输多少瑞尔，这笔钱就收不上来，或者收错。
 *
 * 几条原则：
 *   - 汇率取不到不能让人付不了款。取不到就用上一次的值，页面上标明是「参考汇率」。
 *   - 折算一律往上取整到该币种的最小单位（瑞尔取到 1 riel，美元取到 1 美分），
 *     最多多收一个最小单位，但永远不会少收 —— 少收的那部分是从商户口袋里出的。
 *   - 库里只留每个货币对的最新一条。历史汇率对我们没用，留着只会越积越多。
 */

export interface FxQuote {
  /** 顾客实付币种，如 KHR */
  currency: string;
  /** 中文名，如「瑞尔」 */
  label: string;
  /** 折算后的金额，已按该币种的最小单位向上取整 */
  amount: number;
  /** 带千分位的金额文本，直接给前端显示 */
  amountText: string;
  /** 1 单位计价币 = 多少 currency */
  rate: number;
  /** 一句话说明这个数字是怎么算出来的 */
  rateText: string;
  /** 汇率的时间 */
  asOf: string;
  /** true = 当日实时汇率；false = 手工汇率，或者外网拉不到时顶上的旧值 */
  live: boolean;
  source: string;
}

/** 常见币种的中文叫法。查不到就直接用代码，不影响功能。 */
const LABELS: Record<string, string> = {
  CNY: '人民币',
  USD: '美元',
  KHR: '瑞尔',
  THB: '泰铢',
  VND: '越南盾',
  LAK: '基普',
  MMK: '缅元',
  HKD: '港币',
  TWD: '新台币',
  JPY: '日元',
  KRW: '韩元',
  SGD: '新加坡元',
  MYR: '林吉特',
  PHP: '比索',
  IDR: '印尼盾',
  EUR: '欧元',
  GBP: '英镑',
  AUD: '澳元',
  CAD: '加元',
  RUB: '卢布',
  INR: '卢比',
};

/** 没有小数位的币种。这些币种写 30139.00 是错的，当地也没人这么写。 */
const NO_DECIMALS = new Set(['KHR', 'VND', 'LAK', 'MMK', 'JPY', 'KRW', 'IDR', 'CLP', 'ISK']);

/** 汇率超过这个岁数就该去拉新的了 */
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);

  constructor(private readonly prisma: PrismaService) {}

  labelOf(code: string): string {
    return LABELS[code.toUpperCase()] ?? code.toUpperCase();
  }

  /**
   * 把一笔以 base 计价的钱（单位：分）折算成 quote 的实付金额。
   *
   * override 是通道上填的手工汇率 —— 填了就用它，不去查实时汇率。
   * 有些商户跟收单行谈的是固定汇率（ABA 常年 4100 KHR/USD），
   * 这种情况用实时汇率反而对不上账。
   */
  async quoteFor(
    amountCents: number,
    base: string,
    quote: string,
    override?: number | null,
  ): Promise<FxQuote | null> {
    const b = (base || '').toUpperCase();
    const q = (quote || '').toUpperCase();
    if (!b || !q || b === q) return null;
    if (!Number.isFinite(amountCents)) return null;

    let rate: number;
    let asOf: Date;
    let live: boolean;
    let source: string;

    if (override && override > 0) {
      rate = override;
      asOf = new Date();
      live = false;
      source = 'manual';
    } else {
      const got = await this.rate(b, q);
      if (!got) return null;
      rate = got.rate;
      asOf = got.asOf;
      live = got.fresh;
      source = got.source;
    }

    const amount = roundUpTo((amountCents / 100) * rate, stepFor(q));

    return {
      currency: q,
      label: this.labelOf(q),
      amount,
      amountText: formatAmount(amount, q),
      rate,
      rateText:
        source === 'manual'
          ? `按通道设定的固定汇率 1 ${this.labelOf(b)} = ${trimRate(rate)} ${this.labelOf(q)} 折算`
          : `按 ${asOf.toISOString().slice(0, 10)} 汇率 1 ${this.labelOf(b)} ≈ ${trimRate(rate)} ${this.labelOf(q)} 折算`,
      asOf: asOf.toISOString(),
      live,
      source,
    };
  }

  /**
   * 取一个货币对的汇率。
   *
   * 先看库里的够不够新，不够新就去拉；拉失败了还是用库里的旧值，
   * 只是把 fresh 标成 false —— 页面上会写「参考汇率」。
   */
  async rate(
    base: string,
    quote: string,
  ): Promise<{ rate: number; asOf: Date; source: string; fresh: boolean } | null> {
    const b = base.toUpperCase();
    const q = quote.toUpperCase();
    const cached = await this.prisma.fxRate.findUnique({
      where: { base_quote: { base: b, quote: q } },
    });
    if (cached && Date.now() - cached.fetchedAt.getTime() < STALE_AFTER_MS) {
      return { rate: cached.rate, asOf: cached.asOf, source: cached.source, fresh: true };
    }

    const fetched = await this.fetch(b, q);
    if (fetched) {
      await this.prisma.fxRate.upsert({
        where: { base_quote: { base: b, quote: q } },
        create: { base: b, quote: q, ...fetched },
        update: { ...fetched, fetchedAt: new Date() },
      });
      return { ...fetched, fresh: true };
    }

    if (cached) {
      this.logger.warn(
        `拉不到 ${b}/${q} 的实时汇率，先用 ${cached.asOf.toISOString().slice(0, 10)} 的旧值顶上`,
      );
      return { rate: cached.rate, asOf: cached.asOf, source: cached.source, fresh: false };
    }
    this.logger.error(`拉不到 ${b}/${q} 的汇率，本地也没有旧值可用`);
    return null;
  }

  /**
   * 去外面拉汇率。两个源都是免费、不要 key 的，一个挂了用另一个。
   *
   * 不用带 key 的商业接口：这个功能只是给顾客看一个折算金额，
   * 为它引入一个会过期、会欠费的凭据不划算。
   */
  private async fetch(
    base: string,
    quote: string,
  ): Promise<{ rate: number; asOf: Date; source: string } | null> {
    const sources: Array<() => Promise<{ rate: number; asOf: Date; source: string } | null>> = [
      async () => {
        const { data } = await axios.get(`https://open.er-api.com/v6/latest/${base}`, {
          timeout: 8000,
        });
        const r = Number(data?.rates?.[quote]);
        if (!Number.isFinite(r) || r <= 0) return null;
        const ts = Number(data?.time_last_update_unix);
        return {
          rate: r,
          asOf: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(),
          source: 'er-api',
        };
      },
      async () => {
        const url =
          'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/' +
          `${base.toLowerCase()}.json`;
        const { data } = await axios.get(url, { timeout: 8000 });
        const r = Number(data?.[base.toLowerCase()]?.[quote.toLowerCase()]);
        if (!Number.isFinite(r) || r <= 0) return null;
        const d = typeof data?.date === 'string' ? new Date(`${data.date}T00:00:00Z`) : new Date();
        return { rate: r, asOf: Number.isNaN(d.getTime()) ? new Date() : d, source: 'currency-api' };
      },
    ];

    for (const get of sources) {
      try {
        const got = await get();
        if (got) return got;
      } catch (err: any) {
        this.logger.warn(`汇率源取数失败：${err?.message ?? err}`);
      }
    }
    return null;
  }

  /**
   * 每天刷一次已经在用的货币对。
   *
   * 挑在凌晨三点：汇率源基本都在 UTC 00:00 前后更新，而这个点面板几乎
   * 没有人在付款，刷失败了也还有一整天的余量重试。
   */
  @Cron('10 3 * * *')
  async refreshDaily() {
    const channels = await this.prisma.payChannel.findMany({
      where: { isEnabled: true, payCurrency: { not: null }, payRate: null },
      select: { payCurrency: true },
    });
    const quotes = [...new Set(channels.map((c) => (c.payCurrency ?? '').toUpperCase()))].filter(
      Boolean,
    );
    if (quotes.length === 0) return;

    // 计价币种可能是人民币也可能是美元，两个都刷 —— 省得管理员临时切了币种拉不到
    for (const base of ['CNY', 'USD']) {
      for (const q of quotes) {
        if (q === base) continue;
        const got = await this.fetch(base, q);
        if (!got) continue;
        await this.prisma.fxRate.upsert({
          where: { base_quote: { base, quote: q } },
          create: { base, quote: q, ...got },
          update: { ...got, fetchedAt: new Date() },
        });
        this.logger.log(`汇率已更新 ${base}/${q} = ${got.rate}`);
      }
    }
  }
}

/**
 * 折算结果往上取整到多少。
 *
 * 就是该币种自己的最小单位：瑞尔没有分，取整到 1 瑞尔；美元取到 1 美分。
 *
 * 曾经想过瑞尔取整到 100（当地现金最小常用面额就是 100 riel），
 * 但扫码付款是在手机上输数字，输 30139 完全没问题，而取整到 100 会让
 * 1 元这种小额多收将近两成。电子支付按现金的习惯取整没有道理。
 *
 * 方向一律向上：最多多收一个最小单位，但永远不会少收。
 */
export function stepFor(currency: string): number {
  return NO_DECIMALS.has(currency.toUpperCase()) ? 1 : 0.01;
}

/**
 * 向上取整到 step 的整数倍。
 *
 * 用整数运算绕开浮点：40300 这种数算出来常常是 40299.999999996，
 * 直接 ceil 没问题，但 40300.000000001 会多进一档，顾客看到的金额
 * 就比应付的多 100 瑞尔。先按 1e6 定标、再削掉一点点噪声再进位。
 */
export function roundUpTo(value: number, step: number): number {
  if (!(step > 0)) return value;
  const scale = 1e6;
  const v = Math.round(value * scale);
  const s = Math.round(step * scale);
  const n = Math.ceil((v - 1) / s);
  return (n * s) / scale;
}

/** 千分位。零小数币种不写小数点。 */
export function formatAmount(value: number, currency: string): string {
  const digits = NO_DECIMALS.has(currency.toUpperCase()) ? 0 : 2;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 汇率本身写几位小数：大数字两位就够，小数字要多留几位才看得出区别 */
function trimRate(rate: number): string {
  if (rate >= 100) return rate.toFixed(2);
  if (rate >= 1) return rate.toFixed(4);
  return rate.toPrecision(4);
}
