import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as crypto from 'crypto';

/**
 * Jeepay 聚合支付驱动。
 *
 * Jeepay 是开源的聚合支付网关，你自己部署一套，它对接下游各种支付方式
 * （支付宝、微信、银行、加密货币等），面板只跟它说话。
 *
 * 签名规则是最容易错的地方，也是错了最难查的地方（网关只会回「签名错误」四个字）：
 *   1. 取所有非空参数（sign 本身除外）
 *   2. 按参数名的 ASCII 升序排列
 *   3. 拼成 k1=v1&k2=v2&...
 *   4. 末尾接上 &key=你的appSecret
 *   5. 整串 MD5，转成大写十六进制
 *
 * 「非空」的判定尤其要小心：值为空字符串的参数必须排除，但值为 "0" 的必须保留 ——
 * 用 JS 的真值判断（if (v)）会把 0 也扔掉，签名就永远对不上。
 */

export interface JeepayCredentials {
  gatewayUrl: string;
  mchNo: string;
  appId: string;
  appSecret: string;
}

export interface JeepayPayRequest {
  orderNo: string;
  amountCents: number;
  currency: string;
  wayCode: string;
  subject: string;
  body?: string;
  notifyUrl: string;
  returnUrl?: string;
  clientIp?: string;
  /** 部分通道以第三方货币结算（比如 KHR），按这个汇率换算 */
  rate?: number;
}

export interface JeepayPayResult {
  /** Jeepay 那边的支付单号，对账用 */
  payOrderId: string;
  /** 二维码内容，扫码支付时用 */
  codeUrl?: string;
  /** 跳转地址，网页支付时用 */
  payUrl?: string;
  /** 原样返回，前端有特殊需求时能拿到全部字段 */
  raw: Record<string, any>;
}

@Injectable()
export class JeepayDriver {
  readonly code = 'jeepay';
  private readonly logger = new Logger(JeepayDriver.name);

  /**
   * 按 Jeepay 规则算签名。
   * 收单和验签用的是同一个函数 —— 分成两份实现迟早会出现一边改了另一边没改。
   */
  sign(params: Record<string, any>, appSecret: string): string {
    const pairs = Object.keys(params)
      .filter((k) => {
        if (k === 'sign') return false;
        const v = params[k];
        // 注意这里：不能写成 if (v)，那样值为 0 或 "0" 的参数会被扔掉，
        // 而 Jeepay 那边是把它算进签名的，结果就是永远「签名错误」。
        return v !== undefined && v !== null && v !== '';
      })
      .sort();

    const query = pairs.map((k) => `${k}=${params[k]}`).join('&');
    const full = `${query}&key=${appSecret}`;
    return crypto.createHash('md5').update(full, 'utf8').digest('hex').toUpperCase();
  }

  /** 验签。回调必须验，不验的话任何人构造一个请求就能把订单标成已付款。 */
  verify(params: Record<string, any>, appSecret: string): boolean {
    const received = String(params.sign ?? '');
    if (!received) return false;
    const expected = this.sign(params, appSecret);
    // 用定长比较避免时序侧信道。这里泄露的信息量其实很小，
    // 但验签这种地方按规矩来不会有坏处。
    const a = Buffer.from(received.toUpperCase());
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** 下单。返回二维码内容或跳转地址。 */
  async createPayment(
    cred: JeepayCredentials,
    req: JeepayPayRequest,
  ): Promise<JeepayPayResult> {
    // 金额单位是「分」。有些通道以第三方货币结算，先按汇率换算再取整。
    const amount = req.rate ? Math.round(req.amountCents * req.rate) : req.amountCents;

    const params: Record<string, any> = {
      mchNo: cred.mchNo,
      appId: cred.appId,
      mchOrderNo: req.orderNo,
      wayCode: req.wayCode,
      amount,
      currency: (req.currency || 'CNY').toLowerCase(),
      clientIp: req.clientIp || '127.0.0.1',
      subject: req.subject.slice(0, 64),
      body: (req.body || req.subject).slice(0, 256),
      notifyUrl: req.notifyUrl,
      ...(req.returnUrl ? { returnUrl: req.returnUrl } : {}),
      reqTime: Date.now(),
      version: '1.0',
      signType: 'MD5',
    };
    params.sign = this.sign(params, cred.appSecret);

    const url = `${cred.gatewayUrl.replace(/\/+$/, '')}/api/pay/unifiedOrder`;
    let res: any;
    try {
      res = await axios.post(url, params, {
        timeout: 20000,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err: any) {
      throw new Error(this.explainNetwork(err, cred.gatewayUrl));
    }

    const data = res.data ?? {};
    if (data.code !== 0) {
      throw new Error(this.explainGateway(data));
    }

    const d = data.data ?? {};

    // 网关把「跳转地址」和「二维码内容」塞在哪个字段，各家不一样，
    // 而且**同一个字段两种都可能**：payData 有时是 https://…，
    // 有时是一长串 EMV 二维码数据（00020101021130…）。
    //
    // 所以不能按字段名分，得看内容长什么样。以前按字段名分的时候，
    // 二维码数据被当成了跳转地址，前端一句 location.href = 那串数字，
    // 浏览器当场卡住 —— 用户点了付款什么都不出来，也没有任何报错。
    const candidates = [d.payUrl, d.payData, d.codeUrl, d.qrCode].filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    const payUrl = candidates.find(isNavigable);
    const codeUrl = candidates.find((v) => !isNavigable(v));

    return { payOrderId: d.payOrderId, codeUrl, payUrl, raw: d };
  }

  /**
   * 解析回调。
   *
   * Jeepay 用 state 表示状态，2 才是支付成功。
   * 其它状态（0 订单生成、1 支付中、3 支付失败、4 已撤销、5 已退款、6 订单关闭）
   * 一律不当成功处理 —— 尤其是 1，见过把「支付中」当成功然后白送机器的。
   */
  parseNotify(
    params: Record<string, any>,
    cred: JeepayCredentials,
  ): { valid: boolean; success: boolean; orderNo?: string; upstreamNo?: string; amountCents?: number; reason?: string } {
    if (!this.verify(params, cred.appSecret)) {
      return { valid: false, success: false, reason: '签名校验不通过' };
    }
    const state = Number(params.state);
    return {
      valid: true,
      success: state === 2,
      orderNo: params.mchOrderNo,
      upstreamNo: params.payOrderId,
      amountCents: params.amount != null ? Number(params.amount) : undefined,
      reason: state === 2 ? undefined : `支付状态 state=${state}（只有 2 才是成功）`,
    };
  }

  /** 测试通道配置对不对。用一笔金额极小的订单探一下网关是否受理。 */
  async verifyCredentials(
    cred: JeepayCredentials,
  ): Promise<{ ok: boolean; message: string; detail?: Record<string, any> }> {
    if (!cred.gatewayUrl || !cred.mchNo || !cred.appId || !cred.appSecret) {
      return { ok: false, message: '网关地址、商户号、应用 ID、应用密钥四项都要填' };
    }
    if (!/^https?:\/\//.test(cred.gatewayUrl)) {
      return { ok: false, message: '网关地址要带 http:// 或 https://' };
    }
    try {
      // 故意用一个不存在的 wayCode 去探：能连通并且返回业务错误，
      // 说明地址和签名都是对的，只是支付方式不存在。
      await this.createPayment(cred, {
        orderNo: `PROBE${Date.now()}`,
        amountCents: 1,
        currency: 'CNY',
        wayCode: '__PANEL_PROBE__',
        subject: '连通性测试',
        notifyUrl: 'https://example.com/notify',
      });
      return { ok: true, message: '网关连通，签名通过' };
    } catch (err: any) {
      const msg = String(err.message);
      if (/签名|sign/i.test(msg)) {
        return { ok: false, message: '网关能连上，但签名不通过 —— 检查商户号、应用 ID、应用密钥有没有抄错' };
      }
      if (/支付方式|wayCode|不存在|不支持/i.test(msg)) {
        // 这正是我们期待的结果
        return { ok: true, message: '网关连通，签名通过（探测用的支付方式不存在属正常）' };
      }
      return { ok: false, message: msg };
    }
  }

  private explainNetwork(err: any, gateway: string): string {
    const code = err?.code;
    if (code === 'ECONNREFUSED') return `连不上支付网关 ${gateway}，检查地址和端口，以及 Jeepay 是不是在跑`;
    if (code === 'ENOTFOUND') return `解析不了支付网关的域名 ${gateway}，检查地址有没有写错`;
    if (code === 'ECONNABORTED' || /timeout/i.test(err?.message ?? '')) {
      return `支付网关 ${gateway} 超时没响应`;
    }
    if (err?.response?.status === 404) {
      return `支付网关返回 404。网关地址应该填到域名为止，不要带 /api/pay 这样的路径`;
    }
    if (/certificate|SSL|self.signed/i.test(err?.message ?? '')) {
      return '支付网关的 HTTPS 证书有问题，检查证书是否过期或用了自签证书';
    }
    return `请求支付网关失败：${err?.message ?? err}`;
  }

  private explainGateway(data: any): string {
    const msg = data?.msg ?? data?.message ?? '未知错误';
    // 这条要排在「商户」前面：它的原文里也带「商户订单」四个字，
    // 放后面会被下面那条抢走，然后提示你去检查商户号 —— 查半天查不出问题。
    if (/已存在|重复|duplicate/i.test(msg)) {
      return `网关说这个订单号提交过了：${msg}。同一个商户单号只能提交一次，` +
        `面板会自动给每次提交加后缀，出现这条说明后缀没生效`;
    }
    if (/签名|sign/i.test(msg)) {
      return `支付网关说签名错误：${msg}。检查应用密钥（appSecret）是不是抄错了或者前后有空格`;
    }
    if (/商户|mch/i.test(msg)) {
      return `支付网关说商户有问题：${msg}。检查商户号和应用 ID 是否属于同一个商户`;
    }
    if (/金额|amount/i.test(msg)) {
      return `支付网关说金额有问题：${msg}。注意金额单位是「分」不是「元」`;
    }
    return `支付网关拒绝了这笔订单：${msg}`;
  }
}

/**
 * 这个字符串能不能直接丢给浏览器跳转。
 *
 * 只认带 `scheme://` 的：http(s) 是网页收银台，weixin:// alipays:// 这类
 * 是唤起 App。二维码内容（EMV 那种 `0002010102…`）没有 scheme，
 * 会被这里挡下来，交给前端画成二维码给人扫。
 */
function isNavigable(v: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v.trim());
}
