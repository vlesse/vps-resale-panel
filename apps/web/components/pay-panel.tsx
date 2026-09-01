'use client';

import { useState } from 'react';
import { formatDate, type FxQuote, type PayChannel } from '@/lib/api';
import { Notice, PanelBar, Unit } from '@/components/ui';
import { Qr } from '@/components/qr';

export type PayInfo = {
  kind: string;
  payUrl?: string;
  codeUrl?: string;
  message?: string;
  instructions?: string | null;
  /** 顾客扫码后要手动输入的当地币金额。收款码里不带金额时全靠它。 */
  payQuote?: FxQuote | null;
  // USDT
  address?: string;
  amount?: string;
  qrPayload?: string;
  intentNo?: string;
  network?: string;
  notice?: string;
  expiresAt?: string;
};

/**
 * 支付方式的一张卡片。
 *
 * 选中状态原来只有一圈 1px 的 outline，在藕荷色底上几乎看不出来 ——
 * 用户不知道自己选的是哪个，默认落在「线下转账」上也毫无察觉。
 * 现在改成实心描边加一个圆点，一眼能看出选了谁。
 */
export function ChannelCard({
  channel,
  on,
  onPick,
}: {
  channel: PayChannel;
  on: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="well chancard"
      data-on={on}
      aria-pressed={on}
    >
      <div className="row" style={{ justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--ink)', fontSize: 15 }}>{channel.name}</span>
            {/* 线下转账不是当场到账，不写清楚用户会一直等 */}
            {channel.driver === 'manual' && (
              <span className="badge" data-tone="warn">人工确认</span>
            )}
          </div>
          {channel.desc && <div className="hint" style={{ marginTop: 4 }}>{channel.desc}</div>}
          {channel.payCurrency && (
            <div className="silk" style={{ fontSize: 9.5, marginTop: 6 }}>
              实际以 {channel.payCurrency} 付款
            </div>
          )}
        </div>
        <span className="chanmark" data-on={on} aria-hidden="true" />
      </div>
    </button>
  );
}

/**
 * 扫码后要输入多少钱。
 *
 * 收款码分两种：动态码里带金额，扫完直接付；静态码（柬埔寨 KHQR 就是）
 * 里不带，顾客得自己在手机上敲。面板按人民币标价、码收的是瑞尔，
 * 不把这个数字摆到他眼前，这笔钱要么收不上来要么收错。
 *
 * 所以这块做得比页面上任何东西都大 —— 它是唯一一个「不看就一定出错」的信息。
 */
export function FxCallout({ quote, cta }: { quote: FxQuote; cta: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(String(quote.amount));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="fxbox">
      <div className="fxbox-k">{cta}</div>
      <div
        className="row"
        style={{ gap: 10, alignItems: 'baseline', marginTop: 6, flexWrap: 'wrap' }}
      >
        <span className="fxbox-v">{quote.amountText}</span>
        <span style={{ color: 'var(--accent-deep)', fontSize: 15 }}>
          {quote.label}
          <span className="silk" style={{ marginLeft: 6 }}>{quote.currency}</span>
        </span>
        <button className="btn btn--sm" onClick={copy}>
          {copied ? '已复制' : '复制金额'}
        </button>
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        {quote.rateText}
        {!quote.live && '（参考汇率，可能不是最新的）'}
      </div>
    </div>
  );
}

/**
 * 付款指引。
 *
 * 四种形态：扫码（网关给二维码内容）、USDT（地址 + 精确金额）、
 * 线下转账（一段说明），以及「网关给了个我们认不出来的东西」。
 * 跳转型的在发起时就已经 location.href 走了，不会到这里。
 *
 * **这个组件永远不返回 null。** 之前认不出来的形态直接渲染成空，用户点了
 * 付款屏幕上什么都不变、也没有任何报错 —— 那是最难查的一类故障，因为前后端
 * 日志都显示一切正常。宁可把原始返回摊开给他看，也不能什么都不显示。
 */
export function PayPanel({ info }: { info: PayInfo }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  if (info.kind === 'usdt') {
    return (
      <Unit>
        <PanelBar title="USDT 付款" meta={`${info.network} 网络`} />
        <div className="panelbody">
          <Notice tone="warn">{info.notice}</Notice>

          <div className="pay-usdt" style={{ marginTop: 16 }}>
            <Qr value={info.qrPayload ?? info.address ?? ''} size={200} />

            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="ro-k">转账金额（必须完全一致）</div>
              <div className="row" style={{ gap: 8, alignItems: 'baseline', marginTop: 4 }}>
                <span className="ro-v" style={{ fontSize: 26 }}>{info.amount}</span>
                <span className="silk">USDT</span>
                <button className="btn btn--sm" onClick={() => copy('金额', info.amount ?? '')}>
                  {copied === '金额' ? '已复制' : '复制'}
                </button>
              </div>

              <div className="ro-k" style={{ marginTop: 16 }}>收款地址</div>
              <div className="num" style={{ fontSize: 12.5, marginTop: 4, wordBreak: 'break-all' }}>
                {info.address}
              </div>
              <div className="btnrow" style={{ marginTop: 8 }}>
                <button className="btn btn--sm" onClick={() => copy('地址', info.address ?? '')}>
                  {copied === '地址' ? '已复制' : '复制地址'}
                </button>
              </div>

              {info.expiresAt && (
                <div className="silk" style={{ fontSize: 10, marginTop: 14 }}>
                  这个金额为你保留到 {formatDate(info.expiresAt)}，过期后要重新发起
                </div>
              )}
            </div>
          </div>

          <p className="hint" style={{ marginTop: 16 }}>
            转账后不用做任何操作。系统每分钟扫一次链上记录，到账后这个页面会自动更新，
            通常一到三分钟（取决于波场网络的确认速度）。
          </p>
        </div>
      </Unit>
    );
  }

  if (info.kind === 'manual') {
    return (
      <Unit>
        <PanelBar title="线下转账" meta="需要管理员手工确认，不是自动到账" />
        <div className="panelbody">
          {info.payQuote && (
            <div style={{ marginBottom: 14 }}>
              <FxCallout quote={info.payQuote} cta="本次需转账" />
            </div>
          )}
          <Notice tone="warn">
            {info.message}
            {info.instructions && (
              <div style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{info.instructions}</div>
            )}
          </Notice>
        </div>
      </Unit>
    );
  }

  if (info.codeUrl) {
    return (
      <Unit>
        <PanelBar title="扫码付款" />
        <div className="panelbody">
          {info.payQuote && (
            <div style={{ marginBottom: 16 }}>
              <FxCallout quote={info.payQuote} cta="扫码后请手动输入这个金额" />
            </div>
          )}
          <div className="pay-usdt">
            <Qr value={info.codeUrl} size={200} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <p className="hint">
                {info.payQuote
                  ? '用支付软件扫这个码，然后按上面那个金额手动输入 —— 码里不带金额，输错了钱就收错了。'
                  : '用支付软件扫这个码。'}
              </p>
              <p className="hint" style={{ marginTop: 8 }}>
                付款成功后页面会自动更新，不用手动刷新。
              </p>
              <div className="well" style={{ marginTop: 12, wordBreak: 'break-all' }}>
                <div className="ro-k">二维码内容</div>
                <div className="data" style={{ fontSize: 11.5, marginTop: 6 }}>{info.codeUrl}</div>
              </div>
            </div>
          </div>
        </div>
      </Unit>
    );
  }

  // 认不出来的形态。不能不显示 —— 见组件头上的说明。
  return (
    <Unit>
      <PanelBar title="付款信息" />
      <div className="panelbody">
        <Notice tone="crit">
          支付网关返回的内容这个页面认不出来，没法给你显示二维码或者跳转链接。
          这是面板这边的问题，不是你操作错了。请把下面这段发给客服，我们能据此定位。
        </Notice>
        <div className="well" style={{ marginTop: 12, wordBreak: 'break-all' }}>
          <div className="ro-k">原始返回</div>
          <div className="data" style={{ fontSize: 11.5, marginTop: 6, whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(info, null, 2)}
          </div>
        </div>
      </div>
    </Unit>
  );
}
