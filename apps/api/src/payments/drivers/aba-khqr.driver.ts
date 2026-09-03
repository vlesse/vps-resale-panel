import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * ABA KHQR（柬埔寨）—— 靠到账通知认单的收款方式。
 *
 * 为什么要有这么个东西：ABA 的普通商户**没有 API**。钱扫码进账户，
 * 银行不会告诉任何系统「这笔是哪张订单的」。唯一拿得到的线索是
 * PayWay 推到 Telegram 群里的一条到账通知：
 *
 *   ៛604 paid by WeChat Settlement Hub (*ZMg) on Sep 02, 12:15 PM
 *   via ABA KHQR (BLCBKHPPXXX) at 商户名. Trx. ID: 178832610926160, APV: 318305.
 *
 * 里面有金额和流水号，没有订单号 —— 所以只能靠**金额**认单：给每张待付款的
 * 单子分一个别人没占用的精确金额，通知里的金额对上就是它。和面板收 USDT
 * 是同一套办法，只是数据源从链上换成了这个群。
 *
 * 收款码是**固定码**，每张单都一样，金额靠用户手输 —— 所以页面上必须把
 * 那个精确金额写得足够大，输错一位这笔钱就认不出来。
 *
 * 读群消息用 getUpdates 主动拉，不用 webhook：webhook 要求我们有一个公网
 * 地址常年可达，而一旦连不上，Telegram 会把 webhook 摘掉，接下来的到账
 * 通知就全丢了 —— 而且没有任何人会告诉你。主动拉只需要出网，
 * 换 IP、宕机重启都不影响，重启后从存下来的偏移量接着读。
 */

export interface AbaKhqrCredentials {
  /**
   * BotFather 给的 token，选填。
   *
   * **注意 Telegram 有一条绕不过去的规则：bot 收不到其他 bot 发的消息。**
   * 银行的通知如果是某个 bot（比如 PayWay by ABA）发的，那么不管你把自己的 bot
   * 设成管理员还是关掉隐私模式，都一条也收不到 —— 这条路直接是死的，
   * 得改用下面的「外部推送」，或者让一个真人账号来读。
   *
   * 通知是**真人**发的（或者发在频道里）时，这条路才走得通。
   */
  botToken?: string;
  /** 只认这个群的消息。留空则不限（不建议 —— 别的群发一句就能骗到入账）。 */
  chatId?: string;
  /**
   * 固定收款码的内容，一行一个。
   *
   * 可以填多个 —— 收款方常常有两三个码轮着用（不同的收款账户，
   * 分散单账户的收款限额）。填多个的话面板按顺序轮流发。
   *
   * 轮换**不影响认单**：几个码收的钱都进同一个 Telegram 通知群，
   * 而认单只看金额，跟用了哪个码无关。
   */
  qrPayload: string;
  /**
   * 外部推送用的密钥，选填。
   *
   * 配了之后，任何能读到那个群的程序（比如一个 telethon 真人账号监听器）
   * 都可以把通知原文 POST 给面板，面板照样按金额认单。
   *
   * 这是为「银行通知由 bot 发出」准备的路子 —— 那种情况我们自己的 bot
   * 永远读不到，只能让一个读得到的程序转一手。
   *
   * 这个密钥等于**收款入账的钥匙**：拿到它的人可以构造一条通知让面板加钱。
   * 要够长够随机，而且只给那一个转发程序。
   */
  inboundSecret?: string;
}

/** 从一条到账通知里解出来的东西 */
export interface AbaNotice {
  /** 金额，单位是该币种的最小单位（瑞尔就是瑞尔本身） */
  amount: number;
  currency: string;
  /** 银行流水号。用来防止同一笔通知被处理两次。 */
  txId: string;
  /** 原文，存档用 */
  raw: string;
}

/** 通知里的货币符号 */
const SYMBOLS: Record<string, string> = {
  '៛': 'KHR',
  $: 'USD',
};

/** 没有小数位的币种，金额直接就是最小单位 */
const NO_DECIMALS = new Set(['KHR']);

@Injectable()
export class AbaKhqrDriver {
  readonly code = 'aba_khqr';
  private readonly logger = new Logger(AbaKhqrDriver.name);

  /**
   * 解析一条到账通知。认不出来就返回 null。
   *
   * 只认「收到钱」这一种消息。群里还会有别的东西（退款、对账、人说话），
   * 认错了就是凭空给人加钱，所以宁可漏认也不能错认 ——
   * 漏认会在日志里吼出来，人工补一下就行。
   */
  parseNotice(text: string): AbaNotice | null {
    if (!text) return null;
    // 必须同时具备三个特征才算数：货币符号开头的金额、paid by、流水号
    const m = /([៛$])\s*([\d,]+(?:\.\d+)?)\s+paid\s+by/i.exec(text);
    if (!m) return null;
    const trx = /Trx\.?\s*ID\s*[:：]\s*(\d+)/i.exec(text);
    if (!trx) return null;

    const currency = SYMBOLS[m[1]] ?? '';
    if (!currency) return null;

    const num = Number(m[2].replace(/,/g, ''));
    if (!Number.isFinite(num) || num <= 0) return null;

    // 瑞尔没有小数位，写多少就是多少；美元要换算成美分
    const amount = NO_DECIMALS.has(currency) ? Math.round(num) : Math.round(num * 100);

    return { amount, currency, txId: trx[1], raw: text.slice(0, 1000) };
  }

  /**
   * 把配置里那一坨拆成一个个收款码。
   *
   * 一行一个，空行和前后空白都忽略 —— 从别处复制过来常常带着一堆空白，
   * 不清理的话校验会莫名其妙地不过。
   */
  parseQrList(raw: string): string[] {
    return (raw ?? '')
      .split(/[\r\n]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  /** 看着像不像一张 EMV 收款码 */
  looksLikeQr(v: string): boolean {
    return /^000201/.test(v.trim());
  }

  /**
   * 挑一个没被占用的金额。
   *
   * 往**上**加，不往下减：加了顾客多付几瑞尔（1 瑞尔约合两厘钱），
   * 减了就是我们少收 —— 少收的那部分是从商户口袋里出的。
   *
   * 加的幅度必须小到顾客不在意、又大到能区分开。瑞尔的最小单位是 1，
   * 逐个加一即可；一元人民币约 600 瑞尔，加到 30 也才多收半分钱。
   */
  pickUniqueAmount(base: number, taken: Set<number>, maxTries = 30): number {
    for (let i = 0; i < maxTries; i++) {
      const candidate = base + i;
      if (!taken.has(candidate)) return candidate;
    }
    throw new Error(
      `金额 ${base} 附近 ${maxTries} 个数都被占用了 —— 同一时刻等待付款的单子太多，分不出唯一金额`,
    );
  }

  /**
   * 拉一批群消息。
   *
   * offset 是「下一条要读的更新号」。Telegram 只在你确认读过之后才会丢弃，
   * 所以偏移量必须持久化 —— 存丢了就会把最近 24 小时的通知重放一遍，
   * 那意味着一堆早就处理过的到账重新匹配一次。
   */
  async fetchNotices(
    botToken: string,
    offset: number,
    chatId?: string,
  ): Promise<{ notices: AbaNotice[]; nextOffset: number; seen: number }> {
    const url = `https://api.telegram.org/bot${botToken}/getUpdates`;
    let data: any;
    try {
      const res = await axios.get(url, {
        params: { offset: offset || undefined, limit: 100, timeout: 0 },
        timeout: 15000,
      });
      data = res.data;
    } catch (err: any) {
      throw new Error(this.explain(err));
    }
    if (!data?.ok) {
      throw new Error(`Telegram 拒绝了请求：${data?.description ?? '未知原因'}`);
    }

    const updates: any[] = Array.isArray(data.result) ? data.result : [];
    let nextOffset = offset;
    const notices: AbaNotice[] = [];

    for (const u of updates) {
      if (typeof u.update_id === 'number') nextOffset = Math.max(nextOffset, u.update_id + 1);
      // 频道消息和群消息的字段名不一样，两种都收
      const msg = u.message ?? u.channel_post ?? u.edited_message ?? u.edited_channel_post;
      if (!msg) continue;
      if (chatId && String(msg.chat?.id) !== String(chatId)) continue;
      const text: string = msg.text ?? msg.caption ?? '';
      const n = this.parseNotice(text);
      if (n) notices.push(n);
    }
    return { notices, nextOffset, seen: updates.length };
  }

  /** 测通道配得对不对 */
  async verifyCredentials(
    cred: AbaKhqrCredentials,
  ): Promise<{ ok: boolean; message: string; detail?: Record<string, any> }> {
    const codes = this.parseQrList(cred.qrPayload);
    if (codes.length === 0) {
      return { ok: false, message: '要填固定收款码的内容（付款页上「二维码内容」那一长串）' };
    }
    const bad = codes.findIndex((c) => !this.looksLikeQr(c));
    if (bad >= 0) {
      return {
        ok: false,
        message: `第 ${bad + 1} 个收款码看着不像 EMV 二维码（正常应该以 000201 开头）。多个码要一行一个。`,
      };
    }

    // 两条进消息的路，至少得有一条
    if (!cred.botToken && !cred.inboundSecret) {
      return {
        ok: false,
        message:
          '「bot token」和「外部推送密钥」至少要填一个 —— 不然面板没有任何办法知道钱到了。' +
          '银行通知是 bot 发的（比如 PayWay by ABA）就只能用外部推送：' +
          'Telegram 规定 bot 收不到其他 bot 的消息，这条限制绕不过去。',
      };
    }

    if (!cred.botToken) {
      return {
        ok: true,
        message:
          `收款码 ${codes.length} 个（会轮流发）。走的是外部推送 —— ` +
          `让能读到那个群的程序把通知原文 POST 到 /api/payments/khqr/<通道代码>/notice，` +
          `body 里带上 secret 和 text 两个字段。`,
      };
    }

    let me: any;
    try {
      const res = await axios.get(`https://api.telegram.org/bot${cred.botToken}/getMe`, {
        timeout: 12000,
      });
      me = res.data;
    } catch (err: any) {
      return { ok: false, message: this.explain(err) };
    }
    if (!me?.ok) {
      return { ok: false, message: `Telegram 说这个 token 不对：${me?.description ?? '未知原因'}` };
    }

    // webhook 和 getUpdates 互斥。别人设过 webhook 的话我们一条消息都拉不到，
    // 而且报错很含糊，不如在这里直接说清楚。
    let hook: any;
    try {
      const res = await axios.get(`https://api.telegram.org/bot${cred.botToken}/getWebhookInfo`, {
        timeout: 12000,
      });
      hook = res.data?.result;
    } catch {
      // 拿不到就算了，不影响主流程
    }
    if (hook?.url) {
      return {
        ok: false,
        message:
          `这个 bot 已经设了 webhook（${hook.url}），和主动拉取是互斥的，一条消息也收不到。` +
          `要么换一个新 bot，要么先 deleteWebhook。`,
        detail: { bot: me.result?.username },
      };
    }

    return {
      ok: true,
      message:
        `Telegram 连通，bot 是 @${me.result?.username}，收款码 ${codes.length} 个（会轮流发）。` +
        `还要确认：bot 在群里、隐私模式已关，而且**银行那条通知不是 bot 发的** —— ` +
        `是 bot 发的话这条路收不到任何东西，得改用外部推送。`,
      detail: { bot: me.result?.username },
    };
  }

  private explain(err: any): string {
    const code = err?.code;
    if (code === 'ENOTFOUND') return '解析不了 api.telegram.org，检查服务器的 DNS';
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
      return '连不上 api.telegram.org，检查服务器出网是否被拦';
    }
    if (code === 'ECONNABORTED' || /timeout/i.test(err?.message ?? '')) {
      return 'api.telegram.org 超时没响应';
    }
    const d = err?.response?.data?.description;
    if (d) return `Telegram 返回错误：${d}`;
    return `请求 Telegram 失败：${err?.message ?? err}`;
  }
}
