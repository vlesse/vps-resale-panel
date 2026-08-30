import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as crypto from 'crypto';

/**
 * 易支付（EPAY）驱动。
 *
 * 「易支付」不是某一家公司，是一套在国内被广泛克隆的接口规范
 * （彩虹易支付那一系）。各家服务商的域名不同，但接口长得一模一样，
 * 所以填好网关地址、商户 ID、商户密钥就能对接任意一家。
 *
 * 签名规则跟 Jeepay 很像但有三处不一样，每一处都够让你调半天：
 *
 *   1. 密钥是**直接接在末尾**的，不是 `&key=xxx`
 *      正确：`money=1.00&name=x&pid=1001` + `KEY`
 *      错误：`money=1.00&name=x&pid=1001&key=KEY`
 *   2. 结果是**小写**十六进制，不是大写
 *   3. `sign` 和 `sign_type` 两个字段都要排除在外，Jeepay 只排除 sign
 *
 * 还有一个不是签名但同样致命的：**金额单位是「元」，两位小数**，
 * 不是分。传 100 过去人家收的是一百块。
 */

export interface EpayCredentials {
  /** 服务商给的网关地址，填到域名为止，比如 https://pay.example.com */
  gatewayUrl: string;
  /** 商户 ID，数字 */
  pid: string;
  /** 商户密钥 */
  key: string;
}

export interface EpayPayRequest {
  orderNo: string;
  /** 单位分。driver 内部转成元。 */
  amountCents: number;
  /** alipay / wxpay / qqpay / bank，具体支持哪些看服务商 */
  payType: string;
  subject: string;
  notifyUrl: string;
  returnUrl?: string;
  clientIp?: string;
  siteName?: string;
}

export interface EpayPayResult {
  /** 服务商那边的订单号 */
  tradeNo?: string;
  /** 跳转支付页 */
  payUrl?: string;
  /** 二维码内容 */
  qrCode?: string;
  raw: Record<string, any>;
}

@Injectable()
export class EpayDriver {
  readonly code = 'epay';
  private readonly logger = new Logger(EpayDriver.name);

  /**
   * 按易支付规则算签名。
   *
   * 参与签名的是「非空、且不是 sign / sign_type」的参数，按参数名 ASCII 升序，
   * 拼成 k=v&k=v，末尾直接接密钥，整串 MD5 转小写。
   */
  sign(params: Record<string, any>, key: string): string {
    const names = Object.keys(params)
      .filter((k) => {
        if (k === 'sign' || k === 'sign_type') return false;
        const v = params[k];
        // 不能写 if (v)：值是 0 或 "0" 的参数对方是算进签名的，
        // 被 JS 的真值判断扔掉就永远对不上。
        return v !== undefined && v !== null && v !== '';
      })
      .sort();

    const query = names.map((k) => `${k}=${params[k]}`).join('&');
    return crypto.createHash('md5').update(query + key, 'utf8').digest('hex');
  }

  /** 验签。回调不验签的话，任何人构造一个请求就能把订单标成已付款。 */
  verify(params: Record<string, any>, key: string): boolean {
    const received = String(params.sign ?? '').toLowerCase();
    if (!received) return false;
    const expected = this.sign(params, key);
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** 金额：分 → 元，两位小数的字符串。签名和请求都用这个串，不能一个用数字一个用串。 */
  private yuan(cents: number): string {
    return (cents / 100).toFixed(2);
  }

  /**
   * 下单。走 mapi.php（JSON 接口），拿到二维码或跳转地址。
   *
   * 服务商如果没开 mapi，就退回 submit.php 的表单跳转 —— 那个是纯前端跳转，
   * 不需要服务端调用，把拼好的 URL 交给浏览器就行。
   */
  async createPayment(cred: EpayCredentials, req: EpayPayRequest): Promise<EpayPayResult> {
    const base = cred.gatewayUrl.replace(/\/+$/, '');
    const params: Record<string, any> = {
      pid: cred.pid,
      type: req.payType,
      out_trade_no: req.orderNo,
      notify_url: req.notifyUrl,
      return_url: req.returnUrl ?? '',
      name: req.subject.slice(0, 100),
      money: this.yuan(req.amountCents),
      clientip: req.clientIp || '127.0.0.1',
      device: 'pc',
      ...(req.siteName ? { sitename: req.siteName } : {}),
    };
    params.sign = this.sign(params, cred.key);
    params.sign_type = 'MD5';

    let res: any;
    try {
      // 易支付一律收表单，不收 JSON。发 JSON 过去多数服务商直接回「参数错误」。
      res = await axios.post(`${base}/mapi.php`, new URLSearchParams(params as any).toString(), {
        timeout: 20000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch (err: any) {
      throw new Error(this.explainNetwork(err, base));
    }

    const data = typeof res.data === 'string' ? safeJson(res.data) : res.data ?? {};
    if (Number(data.code) !== 1) {
      throw new Error(this.explainGateway(data));
    }

    return {
      tradeNo: data.trade_no,
      payUrl: data.payurl || data.urlscheme,
      qrCode: data.qrcode,
      raw: data,
    };
  }

  /**
   * 拼一个 submit.php 的跳转地址。
   *
   * mapi 不可用时的退路，也是最省事的接入方式：整个流程不需要服务端
   * 跟支付网关通信，浏览器带着签名参数跳过去就行。
   */
  buildSubmitUrl(cred: EpayCredentials, req: EpayPayRequest): string {
    const base = cred.gatewayUrl.replace(/\/+$/, '');
    const params: Record<string, any> = {
      pid: cred.pid,
      type: req.payType,
      out_trade_no: req.orderNo,
      notify_url: req.notifyUrl,
      return_url: req.returnUrl ?? '',
      name: req.subject.slice(0, 100),
      money: this.yuan(req.amountCents),
      ...(req.siteName ? { sitename: req.siteName } : {}),
    };
    params.sign = this.sign(params, cred.key);
    params.sign_type = 'MD5';
    return `${base}/submit.php?${new URLSearchParams(params as any).toString()}`;
  }

  /**
   * 解析异步通知。
   *
   * 易支付用 trade_status 表示状态，只有 TRADE_SUCCESS 是成功。
   * 通知是 GET，参数在 query 上。
   */
  parseNotify(
    params: Record<string, any>,
    cred: EpayCredentials,
  ): {
    valid: boolean;
    success: boolean;
    orderNo?: string;
    upstreamNo?: string;
    amountCents?: number;
    reason?: string;
  } {
    if (!this.verify(params, cred.key)) {
      return { valid: false, success: false, reason: '签名校验不通过' };
    }
    const ok = String(params.trade_status) === 'TRADE_SUCCESS';
    // money 是元，转回分。用四舍五入而不是取整：0.1+0.2 那类浮点误差
    // 会让 19.99 变成 1998.9999999999998，直接截断就少收一分钱。
    const money = params.money != null ? Math.round(Number(params.money) * 100) : undefined;
    return {
      valid: true,
      success: ok,
      orderNo: params.out_trade_no,
      upstreamNo: params.trade_no,
      amountCents: Number.isFinite(money as number) ? money : undefined,
      reason: ok ? undefined : `支付状态 trade_status=${params.trade_status}`,
    };
  }

  /**
   * 测试凭据。
   *
   * 用 api.php?act=query 查商户信息 —— 这是易支付规范里唯一一个
   * 「不产生订单就能验证 pid + key」的接口。
   */
  async verifyCredentials(
    cred: EpayCredentials,
  ): Promise<{ ok: boolean; message: string; detail?: Record<string, any> }> {
    if (!cred.gatewayUrl || !cred.pid || !cred.key) {
      return { ok: false, message: '网关地址、商户 ID、商户密钥三项都要填' };
    }
    if (!/^https?:\/\//.test(cred.gatewayUrl)) {
      return { ok: false, message: '网关地址要带 http:// 或 https://' };
    }
    const base = cred.gatewayUrl.replace(/\/+$/, '');
    try {
      const res = await axios.get(`${base}/api.php`, {
        params: { act: 'query', pid: cred.pid, key: cred.key },
        timeout: 15000,
      });
      const data = typeof res.data === 'string' ? safeJson(res.data) : res.data ?? {};
      if (Number(data.code) === 1) {
        return {
          ok: true,
          message: '商户校验通过',
          detail: {
            商户号: String(data.pid ?? cred.pid),
            ...(data.money != null ? { 账户余额: String(data.money) } : {}),
            ...(data.type ? { 支持的支付方式: String(data.type) } : {}),
            ...(data.active != null ? { 状态: Number(data.active) === 1 ? '正常' : '已停用' } : {}),
          },
        };
      }
      return { ok: false, message: this.explainGateway(data) };
    } catch (err: any) {
      return { ok: false, message: this.explainNetwork(err, base) };
    }
  }

  private explainNetwork(err: any, gateway: string): string {
    const code = err?.code;
    if (code === 'ECONNREFUSED') return `连不上支付网关 ${gateway}，检查地址和端口`;
    if (code === 'ENOTFOUND') return `解析不了支付网关的域名 ${gateway}，检查地址有没有写错`;
    if (code === 'ECONNABORTED' || /timeout/i.test(err?.message ?? '')) {
      return `支付网关 ${gateway} 超时没响应`;
    }
    if (err?.response?.status === 404) {
      return `支付网关返回 404。网关地址填到域名为止就行，不要带 /submit.php 这样的路径`;
    }
    if (/certificate|SSL|self.signed/i.test(err?.message ?? '')) {
      return '支付网关的 HTTPS 证书有问题（过期或自签）';
    }
    return `请求支付网关失败：${err?.message ?? err}`;
  }

  private explainGateway(data: any): string {
    const msg = String(data?.msg ?? data?.message ?? '未知错误');
    if (/签名|sign/i.test(msg)) {
      return `网关说签名错误：${msg}。商户密钥抄错、前后带空格、或者用了别家的密钥都会这样`;
    }
    if (/商户|pid|不存在/i.test(msg)) {
      return `网关说商户有问题：${msg}。检查商户 ID 是不是这个网关的`;
    }
    if (/类型|type/i.test(msg)) {
      return `网关说支付方式不对：${msg}。常见的是 alipay / wxpay / qqpay / bank，具体问服务商`;
    }
    if (/金额|money/i.test(msg)) {
      return `网关说金额有问题：${msg}。易支付的金额单位是「元」两位小数，不是分`;
    }
    return `支付网关拒绝了这笔请求：${msg}`;
  }
}

/** 有些服务商返回的 Content-Type 是 text/html，但内容其实是 JSON */
function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { code: 0, msg: text.slice(0, 200) };
  }
}
