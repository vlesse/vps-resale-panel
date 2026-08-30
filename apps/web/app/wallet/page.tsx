'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, formatDate, getToken, money, type PayChannel } from '@/lib/api';
import { Notice, PanelBar, Readout, Unit } from '@/components/ui';
import { PayPanel, type PayInfo } from '@/components/pay-panel';

interface WalletSummary {
  balanceCents: number;
  currency: 'CNY' | 'USD';
  totalRechargedCents: number;
  totalConsumedCents: number;
}

interface Tx {
  id: string;
  type: 'recharge' | 'consume' | 'refund' | 'adjust';
  amountCents: number;
  balanceAfterCents: number;
  currency: 'CNY' | 'USD';
  refType: string | null;
  refNo: string | null;
  remark: string | null;
  createdAt: string;
}

interface Recharge {
  id: string;
  rechargeNo: string;
  amountCents: number;
  currency: 'CNY' | 'USD';
  status: 'pending_payment' | 'paid' | 'cancelled' | 'expired';
  payChannel: string | null;
  paidAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}


const TX_LABEL: Record<Tx['type'], string> = {
  recharge: '充值',
  consume: '消费',
  refund: '退回',
  adjust: '管理员调整',
};

const RECHARGE_STATUS: Record<Recharge['status'], { label: string; tone: string }> = {
  pending_payment: { label: '待付款', tone: 'warn' },
  paid: { label: '已到账', tone: 'ok' },
  cancelled: { label: '已取消', tone: 'mute' },
  expired: { label: '已超时', tone: 'mute' },
};

/** 常用面额。自己填也行，这几个只是省得敲。 */
const PRESETS = [1000, 5000, 10000, 20000, 50000, 100000];

export default function WalletPage() {
  const router = useRouter();
  const [sum, setSum] = useState<WalletSummary | null>(null);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [recharges, setRecharges] = useState<Recharge[]>([]);
  const [channels, setChannels] = useState<PayChannel[]>([]);
  const [amountYuan, setAmountYuan] = useState('50');
  const [picked, setPicked] = useState<string | null>(null);
  const [pending, setPending] = useState<Recharge | null>(null);
  const [payInfo, setPayInfo] = useState<PayInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const [s, l, r] = await Promise.all([
      api.get<WalletSummary>('/api/wallet'),
      api.get<{ rows: Tx[] }>('/api/wallet/ledger?pageSize=30'),
      api.get<{ rows: Recharge[] }>('/api/wallet/recharges?pageSize=10'),
    ]);
    setSum(s);
    setTxs(l.rows);
    setRecharges(r.rows);
    return s;
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.push('/login?next=/wallet');
      return;
    }
    load().catch((e) => setError(e.message));
    api
      .publicGet<PayChannel[]>('/api/payments/channels')
      .then((c) => {
        const usable = c.filter((x) => x.usableForRecharge !== false);
        setChannels(usable);
        setPicked(usable[0]?.code ?? null);
      })
      .catch(() => undefined);
  }, [router, load]);

  /**
   * 有待付款时每 5 秒查一次余额。
   *
   * 网关支付有回调，USDT 是我们自己盯链 —— 两种都不会通知浏览器，
   * 所以页面只能自己问。到账了就停，不能一直转着占用后端。
   */
  useEffect(() => {
    if (poll.current) clearTimeout(poll.current);
    if (!pending) return;
    poll.current = setTimeout(async () => {
      try {
        const before = sum?.balanceCents ?? 0;
        const s = await load();
        if (s.balanceCents > before) {
          setPending(null);
          setPayInfo(null);
          setFlash('充值已到账。');
        } else {
          setPending({ ...pending });
        }
      } catch {
        setPending({ ...pending });
      }
    }, 5000);
    return () => {
      if (poll.current) clearTimeout(poll.current);
    };
  }, [pending, sum?.balanceCents, load]);

  const cents = Math.round(Number(amountYuan) * 100);

  const startRecharge = async () => {
    setBusy(true);
    setError(null);
    setFlash(null);
    try {
      const r = await api.post<Recharge>('/api/wallet/recharges', { amountCents: cents });
      setPending(r);
      if (picked) {
        const info = await api.post<PayInfo>(`/api/payments/recharge/${r.rechargeNo}/pay`, {
          channel: picked,
        });
        setPayInfo(info);
        if (info.payUrl) window.location.href = info.payUrl;
      }
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const payAgain = async (r: Recharge) => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      setPending(r);
      const info = await api.post<PayInfo>(`/api/payments/recharge/${r.rechargeNo}/pay`, {
        channel: picked,
      });
      setPayInfo(info);
      if (info.payUrl) window.location.href = info.payUrl;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!sum) {
    return (
      <Unit>
        <div className="panelbody">
          {error ? (
            <Notice tone="crit">{error}</Notice>
          ) : (
            <>
              <span className="spin" />
              <span className="muted" style={{ marginLeft: 8 }}>正在读取账户…</span>
            </>
          )}
        </div>
      </Unit>
    );
  }

  const cur = sum.currency;

  return (
    <>
      <Unit>
        <PanelBar title="账户余额" meta="先充值，下单时直接从余额里扣，不用每次跳支付" />
        <div className="panelbody">
          <div className="well">
            <div className="readout">
              <div>
                <div className="ro-k">当前余额</div>
                <div className="ro-v" style={{ fontSize: 28 }}>{money(sum.balanceCents, cur)}</div>
              </div>
              <Readout label="累计充值" value={money(sum.totalRechargedCents, cur)} />
              <Readout label="累计消费" value={money(sum.totalConsumedCents, cur)} />
            </div>
          </div>
          {flash && (
            <div style={{ marginTop: 14 }}>
              <Notice tone="ok">{flash}</Notice>
            </div>
          )}
        </div>
      </Unit>

      <Unit>
        <PanelBar title="充值" />
        <div className="panelbody">
          <div className="chips">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className="chip"
                data-on={cents === p}
                onClick={() => setAmountYuan(String(p / 100))}
              >
                {money(p, cur)}
              </button>
            ))}
          </div>

          <div className="field" style={{ maxWidth: 260, marginTop: 14 }}>
            <label className="label">充值金额</label>
            <input
              className="input"
              type="number"
              min={1}
              step="0.01"
              value={amountYuan}
              onChange={(e) => setAmountYuan(e.target.value)}
            />
            <span className="hint">最低 1 元。充进来的余额不能提现，只能用于购买和续费。</span>
          </div>

          {channels.length === 0 ? (
            <div style={{ marginTop: 14 }}>
              <Notice tone="warn">还没有可用的支付方式。管理员需要先在后台「支付通道」里加一个。</Notice>
            </div>
          ) : (
            <>
              <div className="label" style={{ marginTop: 16 }}>支付方式</div>
              <div className="grid2" style={{ marginTop: 8 }}>
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
                  </button>
                ))}
              </div>
            </>
          )}

          {error && (
            <div style={{ marginTop: 14 }}>
              <Notice tone="crit">{error}</Notice>
            </div>
          )}

          <div className="btnrow" style={{ marginTop: 16 }}>
            <button
              className="btn btn--key"
              onClick={startRecharge}
              disabled={busy || !picked || !(cents >= 100)}
            >
              {busy ? '处理中…' : `充值 ${money(Number.isFinite(cents) ? cents : 0, cur)}`}
            </button>
          </div>
        </div>
      </Unit>

      {payInfo && <PayPanel info={payInfo} />}

      {recharges.some((r) => r.status === 'pending_payment') && (
        <Unit>
          <PanelBar title="待付款的充值" />
          <div className="panelbody">
            <table className="table table--cards">
              <thead>
                <tr>
                  <th>单号</th>
                  <th className="r">金额</th>
                  <th>创建时间</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {recharges
                  .filter((r) => r.status === 'pending_payment')
                  .map((r) => (
                    <tr key={r.id}>
                      <td data-label="单号" className="num">{r.rechargeNo}</td>
                      <td data-label="金额" className="num r">{money(r.amountCents, r.currency)}</td>
                      <td data-label="创建时间">{formatDate(r.createdAt)}</td>
                      <td>
                        <button className="btn btn--sm" onClick={() => payAgain(r)} disabled={busy}>
                          继续付款
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Unit>
      )}

      <Unit>
        <PanelBar title="账户流水" meta="每一笔加减都记在这里" />
        <div className="panelbody">
          {txs.length === 0 ? (
            <p className="hint">还没有任何流水。</p>
          ) : (
            <table className="table table--cards">
              <thead>
                <tr>
                  <th>类型</th>
                  <th className="r">金额</th>
                  <th className="r">余额</th>
                  <th>说明</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {txs.map((t) => (
                  <tr key={t.id}>
                    <td data-label="类型">{TX_LABEL[t.type] ?? t.type}</td>
                    <td
                      data-label="金额"
                      className="num r"
                      style={{ color: t.amountCents >= 0 ? 'var(--ok)' : 'var(--ink)' }}
                    >
                      {t.amountCents >= 0 ? '+' : '−'}
                      {money(Math.abs(t.amountCents), t.currency)}
                    </td>
                    <td data-label="余额" className="num r">{money(t.balanceAfterCents, t.currency)}</td>
                    <td data-label="说明">
                      {t.remark ?? '—'}
                      {t.refNo && (
                        <div className="silk" style={{ fontSize: 9.5, marginTop: 3 }}>{t.refNo}</div>
                      )}
                    </td>
                    <td data-label="时间">{formatDate(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Unit>

      <Unit>
        <PanelBar title="充值记录" />
        <div className="panelbody">
          {recharges.length === 0 ? (
            <p className="hint">还没有充值过。</p>
          ) : (
            <table className="table table--cards">
              <thead>
                <tr>
                  <th>单号</th>
                  <th className="r">金额</th>
                  <th>状态</th>
                  <th>方式</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {recharges.map((r) => {
                  const st = RECHARGE_STATUS[r.status];
                  return (
                    <tr key={r.id}>
                      <td data-label="单号" className="num">{r.rechargeNo}</td>
                      <td data-label="金额" className="num r">{money(r.amountCents, r.currency)}</td>
                      <td data-label="状态">
                        <span className="badge" data-tone={st.tone}>{st.label}</span>
                      </td>
                      <td data-label="方式">{r.payChannel ?? '—'}</td>
                      <td data-label="时间">{formatDate(r.paidAt ?? r.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Unit>

      <Unit>
        <div className="panelbody">
          <div className="silk" style={{ fontSize: 10 }}>
            有疑问？<Link href="/orders" className="navlink" style={{ padding: 0 }}>去看订单</Link>
          </div>
        </div>
      </Unit>
    </>
  );
}
