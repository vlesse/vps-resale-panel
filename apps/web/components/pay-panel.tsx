'use client';

import { useState } from 'react';
import { formatDate } from '@/lib/api';
import { Notice, PanelBar, Unit } from '@/components/ui';
import { Qr } from '@/components/qr';

export type PayInfo = {
  kind: string;
  payUrl?: string;
  codeUrl?: string;
  message?: string;
  instructions?: string | null;
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
 * 付款指引。
 *
 * 三种形态：扫码（网关给二维码内容）、USDT（地址 + 精确金额）、线下转账（一段说明）。
 * 跳转型的在发起时就已经 location.href 走了，不会到这里。
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
        <PanelBar title="转账说明" />
        <div className="panelbody">
          <Notice tone="info">
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
          <div className="pay-usdt">
            <Qr value={info.codeUrl} size={200} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <p className="hint">
                用支付软件扫这个码。付款成功后页面会自动更新，不用手动刷新。
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

  return null;
}
