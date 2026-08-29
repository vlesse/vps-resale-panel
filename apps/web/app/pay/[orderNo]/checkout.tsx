'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  api,
  formatDate,
  getToken,
  money,
  type OrderItem,
  type PayChannel,
  type PaymentStatus,
} from '@/lib/api';
import { Notice, PanelBar, Unit } from '@/components/ui';

interface OrderDetail extends OrderItem {
  plan?: { name: string; regionLabel: string; cpu: number; memoryMb: number; diskGb: number };
  service?: { id: string; serviceNo: string; status: string } | null;
  provisioning?: { status: string; progress: number; step: string | null; error: string | null } | null;
}

export function Checkout({ orderNo }: { orderNo: string }) {
  const router = useRouter();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [channels, setChannels] = useState<PayChannel[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [payInfo, setPayInfo] = useState<{ kind: string; codeUrl?: string; payUrl?: string; message?: string; instructions?: string | null } | null>(null);
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.get<PaymentStatus>(`/api/orders/${orderNo}/payment-status`);
      setStatus(s);
      return s;
    } catch {
      return null;
    }
  }, [orderNo]);

  useEffect(() => {
    if (!getToken()) {
      router.push(`/login?next=/pay/${orderNo}`);
      return;
    }
    Promise.all([
      api.get<OrderDetail>(`/api/orders/${orderNo}`),
      api.publicGet<PayChannel[]>('/api/payments/channels'),
    ])
      .then(([o, c]) => {
        setOrder(o);
        setChannels(c);
        setPicked(c[0]?.code ?? null);
      })
      .catch((e) => setError(e.message));
    void loadStatus();
  }, [orderNo, router, loadStatus]);

  // 付款页每 3 秒问一次到账没有。到账或失败就停。
  useEffect(() => {
    if (poll.current) clearTimeout(poll.current);
    if (!status) return;
    const done = ['completed', 'failed', 'cancelled', 'refunded'].includes(status.status);
    if (done) return;
    poll.current = setTimeout(() => void loadStatus(), 3000);
    return () => {
      if (poll.current) clearTimeout(poll.current);
    };
  }, [status, loadStatus]);

  // 未付款订单的倒计时。超时后库存会被放回池子，得让用户看得见。
  useEffect(() => {
    if (!order?.expiresAt || status?.paid) return;
    const tick = () => {
      const ms = new Date(order.expiresAt!).getTime() - Date.now();
      setLeft(Math.max(0, Math.floor(ms / 1000)));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [order?.expiresAt, status?.paid]);

  const pay = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<any>(`/api/payments/${orderNo}/pay`, { channel: picked });
      setPayInfo(r);
      if (r.payUrl) window.location.href = r.payUrl;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !order) {
    return (
      <Unit>
        <div className="panelbody">
          <Notice tone="crit">{error}</Notice>
          <div style={{ marginTop: 14 }}>
            <Link href="/orders" className="btn btn--sm">返回订单列表</Link>
          </div>
        </div>
      </Unit>
    );
  }

  if (!order) {
    return (
      <Unit>
        <div className="panelbody">
          <span className="spin" /> <span className="muted" style={{ marginLeft: 8 }}>正在读取订单…</span>
        </div>
      </Unit>
    );
  }

  const paid = status?.paid;
  const provisioning = status && ['paid', 'provisioning'].includes(status.status);
  const completed = status?.status === 'completed';
  const failed = status?.status === 'failed';

  return (
    <>
      <Unit>
        <PanelBar title="结算" meta={`订单 ${order.orderNo}`} />
        <div className="panelbody">
          <div className="well">
            <div className="readout">
              <div>
                <div className="ro-k">机型</div>
                <div style={{ color: 'var(--ink)', fontSize: 15 }}>{order.planName}</div>
                <div className="silk" style={{ fontSize: 10, marginTop: 3 }}>{order.regionLabel}</div>
              </div>
              <div>
                <div className="ro-k">计费周期</div>
                <div style={{ color: 'var(--ink)', fontSize: 15 }}>{order.cycleLabel}</div>
              </div>
              <div>
                <div className="ro-k">应付金额</div>
                <div className="ro-v" style={{ fontSize: 24 }}>
                  {money(order.amountCents, order.currency)}
                </div>
              </div>
            </div>
          </div>

          {!paid && left !== null && (
            <div style={{ marginTop: 14 }}>
              <Notice tone={left < 300 ? 'warn' : 'info'}>
                {left > 0 ? (
                  <>
                    请在 <strong className="data">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</strong>{' '}
                    内完成付款，超时订单会自动取消。
                  </>
                ) : (
                  <>这笔订单已经超时了，请回到选购页重新下单。</>
                )}
              </Notice>
            </div>
          )}
        </div>
      </Unit>

      {/* 已付款 —— 显示开通进度 */}
      {paid && !completed && !failed && (
        <Unit>
          <div className="panelbody">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="title" style={{ fontSize: 16 }}>付款已到账，正在开通机器</span>
              <span className="data" style={{ color: 'var(--accent)' }}>{status?.progress ?? 0}%</span>
            </div>
            <div className="bar" style={{ marginTop: 10, height: 12 }}>
              <span className="bar-fill" style={{ width: `${status?.progress ?? 0}%` }} />
            </div>
            <div className="hint" style={{ marginTop: 10 }}>
              <span className="spin" />
              <span style={{ marginLeft: 8 }}>{status?.step ?? '排队中'}</span>
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
              这一步在向机房下单建机，通常一到两分钟。这个页面会自动刷新，你也可以先去做别的，
              开通完成后在「我的机器」里能看到。
            </p>
          </div>
        </Unit>
      )}

      {completed && (
        <Unit>
          <div className="panelbody">
            <Notice tone="ok">机器已经开通好了。</Notice>
            <div className="btnrow" style={{ marginTop: 14 }}>
              {status?.serviceId && (
                <Link href={`/services/${status.serviceId}`} className="btn btn--key">
                  进入控制台看登录信息
                </Link>
              )}
              <Link href="/dashboard" className="btn">我的机器</Link>
            </div>
          </div>
        </Unit>
      )}

      {failed && (
        <Unit>
          <div className="panelbody">
            <Notice tone="crit">
              开通失败：{status?.jobError ?? status?.failReason ?? '未知原因'}
            </Notice>
            <p className="hint" style={{ marginTop: 12 }}>
              款已经收到了，但机器没建出来。这种情况通常是机房侧的临时问题，
              请联系客服处理，我们会重新开通或者退款。
            </p>
          </div>
        </Unit>
      )}

      {/* 选支付方式 */}
      {!paid && left !== 0 && (
        <Unit>
          <PanelBar title="选择支付方式" />
          <div className="panelbody">
            {channels.length === 0 ? (
              <Notice tone="warn">
                还没有配置任何支付方式。如果你是管理员，去后台「支付通道」里加一个。
              </Notice>
            ) : (
              <>
                <div className="grid2">
                  {channels.map((c) => (
                    <button
                      key={c.code}
                      type="button"
                      onClick={() => setPicked(c.code)}
                      className="well"
                      style={{
                        textAlign: 'left',
                        cursor: 'pointer',
                        border: 0,
                        outline: picked === c.code ? '1px solid var(--accent)' : 'none',
                        outlineOffset: 1,
                      }}
                    >
                      <div style={{ color: 'var(--ink)', fontSize: 15 }}>{c.name}</div>
                      {c.desc && <div className="hint" style={{ marginTop: 4 }}>{c.desc}</div>}
                      {c.settleCurrency && (
                        <div className="silk" style={{ fontSize: 9.5, marginTop: 6 }}>
                          以 {c.settleCurrency} 结算
                        </div>
                      )}
                    </button>
                  ))}
                </div>

                {error && (
                  <div style={{ marginTop: 14 }}>
                    <Notice tone="crit">{error}</Notice>
                  </div>
                )}

                <div className="btnrow" style={{ marginTop: 16 }}>
                  <button className="btn btn--key" onClick={pay} disabled={busy || !picked}>
                    {busy ? '正在跳转…' : `去支付 ${money(order.amountCents, order.currency)}`}
                  </button>
                  <Link href="/orders" className="btn">稍后再付</Link>
                </div>
              </>
            )}

            {payInfo?.kind === 'manual' && (
              <div style={{ marginTop: 16 }}>
                <Notice tone="info">
                  {payInfo.message}
                  {payInfo.instructions && (
                    <div style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{payInfo.instructions}</div>
                  )}
                </Notice>
              </div>
            )}

            {payInfo?.codeUrl && !payInfo.payUrl && (
              <div style={{ marginTop: 16 }}>
                <Notice tone="info">
                  请用支付软件扫码付款。付款成功后这个页面会自动跳转，不用手动刷新。
                </Notice>
                <div className="well" style={{ marginTop: 12, wordBreak: 'break-all' }}>
                  <div className="ro-k">二维码内容</div>
                  <div className="data" style={{ fontSize: 12, marginTop: 6 }}>{payInfo.codeUrl}</div>
                </div>
              </div>
            )}
          </div>
        </Unit>
      )}

      <Unit>
        <div className="panelbody">
          <div className="silk" style={{ fontSize: 10 }}>
            下单时间 {formatDate(order.createdAt)}
            {order.paidAt && ` · 付款时间 ${formatDate(order.paidAt)}`}
          </div>
        </div>
      </Unit>
    </>
  );
}
