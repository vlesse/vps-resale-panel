import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * USDT-TRC20 收款驱动。
 *
 * 跟前面两个驱动的根本区别：**链上转账带不了订单号**。
 * 用户从交易所或钱包转过来的，只有「谁转的、转了多少、什么时候」，
 * 没有任何字段能塞进我们的单号。所以配对只能靠别的东西。
 *
 * 这里用的是行业通行做法 —— **金额唯一**：
 * 给每笔待付款分配一个此刻没人在用的精确金额（在原金额上加几分之一分钱的
 * 随机尾数），然后盯着链上，看到一笔正好这个数的转入就认定是它。
 *
 * 由此带来两条硬性约束，代码里到处都在维护它们：
 *   1. 同一个收款地址上，同一时刻不能有两笔待付款金额相同 —— 否则一笔转账
 *      能对上两张单，其中一张就是白送。
 *   2. 待付款必须有超时。挂着不付的单会一直占着那个金额，
 *      占的人多了就分不出新金额来了。
 *
 * 另外：**不做地址归集，也不碰私钥**。面板只知道收款地址（公开信息），
 * 提币是运营自己在交易所或钱包里做的事。面板存了私钥就成了热钱包，
 * 一个 SQL 注入等于把钱包端走。
 */

/** TRC20 上 USDT 的合约地址。这是全网唯一的官方合约，不要改。 */
export const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

/** USDT 有 6 位小数，链上金额都是整数「最小单位」 */
export const USDT_DECIMALS = 6;
export const USDT_UNIT = 10 ** USDT_DECIMALS;

export interface UsdtCredentials {
  /** 收款地址，T 开头 34 位 */
  address: string;
  /** TronGrid 的 API Key。不填也能用，但会被限流。 */
  apiKey?: string;
  /** 自建节点或别的浏览器 API，留空用官方 TronGrid */
  apiBase?: string;
}

export interface Trc20Transfer {
  txId: string;
  from: string;
  to: string;
  /** 最小单位的整数 */
  valueUnits: bigint;
  timestamp: number;
}

@Injectable()
export class UsdtDriver {
  readonly code = 'usdt_trc20';
  private readonly logger = new Logger(UsdtDriver.name);

  /**
   * 波场地址的形状检查。
   *
   * 只查形状不查校验位：真正的 Base58Check 校验要引入一整个依赖，
   * 而这里的目的是拦住「粘贴时少了一个字符」和「贴成了 ERC20 的 0x 地址」，
   * 形状检查就够。地址真不真，第一笔收款到不到得了，一试便知。
   */
  isValidAddress(addr: string): boolean {
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test((addr ?? '').trim());
  }

  /**
   * 把订单金额换算成 USDT 的最小单位。
   *
   * @param amountCents 订单金额（分）
   * @param currency    订单币种
   * @param usdToCnyRate 1 USDT 折多少人民币。CNY 订单必须配，USD 订单用不上。
   */
  toUsdtUnits(amountCents: number, currency: string, usdToCnyRate?: number | null): bigint {
    if (currency === 'USD') {
      // 1 USDT ≈ 1 USD，直接按分换算
      return BigInt(Math.round((amountCents / 100) * USDT_UNIT));
    }
    if (!usdToCnyRate || usdToCnyRate <= 0) {
      throw new Error(
        '这个 USDT 通道没配汇率。人民币计价的订单要靠「1 USDT 折多少人民币」才能算出该收多少币，' +
          '在通道设置里把汇率填上（比如 7.25）。',
      );
    }
    const usd = amountCents / 100 / usdToCnyRate;
    // 向上取整到最小单位：宁可多收 0.000001，也不能因为截断少收
    return BigInt(Math.ceil(usd * USDT_UNIT));
  }

  /** 最小单位 → 给人看的字符串，比如 10.372541 */
  format(units: bigint): string {
    const s = units.toString().padStart(USDT_DECIMALS + 1, '0');
    const int = s.slice(0, -USDT_DECIMALS);
    const frac = s.slice(-USDT_DECIMALS).replace(/0+$/, '');
    return frac ? `${int}.${frac}` : int;
  }

  /**
   * 在基准金额上找一个「此刻没人占着」的精确金额。
   *
   * 只往上加不往下减 —— 往下减等于让用户少付钱。
   * 加的幅度控制在 0.01 USDT 以内（一分美元都不到），用户不会在意，
   * 但一万笔并发待付款也不会撞。
   *
   * @param taken 当前这个地址上所有待付款的金额，必须传全，漏一个就可能撞单
   */
  pickUniqueAmount(baseUnits: bigint, taken: Set<string>): bigint {
    const SPREAD = 10_000; // 0.01 USDT
    for (let i = 0; i < SPREAD; i++) {
      // 从随机位置开始试，不要总从 0 开始 —— 那样金额尾数会集中在低位，
      // 用户能从尾数猜出你有多少笔待付款。
      const offset = (Math.floor(Math.random() * SPREAD) + i) % SPREAD;
      const candidate = baseUnits + BigInt(offset);
      if (!taken.has(candidate.toString())) return candidate;
    }
    throw new Error(
      '同一时刻待付款的 USDT 订单太多，分不出不重复的金额了。' +
        '等几分钟让超时的单子释放掉，或者再配一个收款地址。',
    );
  }

  /**
   * 拉这个地址最近的 TRC20 转入记录。
   *
   * 只要转入（only_to=true），只要 USDT 合约的。别的币种的转账
   * 和转出记录混进来会让金额配对乱套。
   */
  async recentIncoming(
    cred: UsdtCredentials,
    opts: { sinceMs?: number; limit?: number } = {},
  ): Promise<Trc20Transfer[]> {
    const base = (cred.apiBase || 'https://api.trongrid.io').replace(/\/+$/, '');
    const url = `${base}/v1/accounts/${cred.address}/transactions/trc20`;
    let res: any;
    try {
      res = await axios.get(url, {
        timeout: 20000,
        params: {
          only_to: true,
          limit: Math.min(200, opts.limit ?? 50),
          contract_address: USDT_TRC20_CONTRACT,
          ...(opts.sinceMs ? { min_timestamp: opts.sinceMs } : {}),
        },
        headers: cred.apiKey ? { 'TRON-PRO-API-KEY': cred.apiKey } : undefined,
      });
    } catch (err: any) {
      if (err?.response?.status === 401 || err?.response?.status === 403) {
        throw new Error('TronGrid 拒绝了请求，API Key 不对或已失效');
      }
      if (err?.response?.status === 429) {
        throw new Error('TronGrid 限流了。配一个 API Key 能把额度提上去（免费申请）。');
      }
      throw new Error(`查链上记录失败：${err?.message ?? err}`);
    }

    const list: any[] = res.data?.data ?? [];
    return list
      .filter((t) => t?.type === 'Transfer' && t?.to === cred.address)
      .map((t) => ({
        txId: String(t.transaction_id),
        from: String(t.from),
        to: String(t.to),
        valueUnits: BigInt(String(t.value ?? '0')),
        timestamp: Number(t.block_timestamp ?? 0),
      }));
  }

  /** 测试配置：地址形状对不对、链上查不查得动 */
  async verifyCredentials(
    cred: UsdtCredentials,
  ): Promise<{ ok: boolean; message: string; detail?: Record<string, any> }> {
    if (!cred.address) return { ok: false, message: '收款地址要填' };
    if (!this.isValidAddress(cred.address)) {
      return {
        ok: false,
        message: /^0x/i.test(cred.address)
          ? '这是一个以太坊（ERC20）地址。TRC20 的地址是 T 开头的 34 位，别填错链，转过来的币拿不回来。'
          : '收款地址格式不对，TRC20 地址是 T 开头的 34 位',
      };
    }
    try {
      const list = await this.recentIncoming(cred, { limit: 5 });
      return {
        ok: true,
        message: cred.apiKey ? '链上查询正常' : '链上查询正常（没配 API Key，高频时可能被限流）',
        detail: {
          收款地址: cred.address,
          最近转入笔数: String(list.length),
          ...(list[0] ? { 最近一笔: `${this.format(list[0].valueUnits)} USDT` } : {}),
        },
      };
    } catch (err: any) {
      return { ok: false, message: String(err.message ?? err) };
    }
  }
}
