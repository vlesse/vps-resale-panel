'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  api,
  defaultChannel,
  fetchQuote,
  formatDate,
  getToken,
  money,
  type FxQuote,
  type PayChannel,
} from '@/lib/api';
import { Notice, PanelBar, Readout, Unit } from '@/components/ui';
import { ChannelCard, FxCallout, PayPanel, type PayInfo } from '@/components/pay-panel';

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

/**
 * 只有真的是个能跳转的地址才跳。
 *
 * 网关有时会把二维码内容放在 payUrl 里（EMV 那种 0002010102… 的长串）。
 * 不判一下就 location.href，浏览器会当成相对路径去跳，结果是页面一动不动、
 * 也没有任何报错 —— 用户以为点了没反应。
 */
function navigate(url?: string): boolean {
  const u = (url ?? '').trim();
  // 用 includes('://') 而不是在正则里转义斜杠 —— 少一处能写错的地方
  if (!u || !u.includes('://') || !/^[a-z][a-z0-9+.-]*:/i.test(u)) return false;
  window.location.href = u;
  return true;
}

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
  const [quote, setQuote] = useState<FxQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
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
        setPicked(defaultChannel(usable));
      })
      .catch(() => undefined);
  }, [router, load]);

  /**
   * 有待付款时每 5 秒查一次余额。
   *
   * 网关支付有回调，USDT 是我们自己盯链 —— 两种都不会通知浏览器，
   * 所以页面只能自己问。
   *
   * 有上限：最多问 6 分钟。用户开着这个页面去吃饭的话，一直轮询
   * 既白占后端，也没有意义（真到账了刷新一下就看见了）。
   */
  const MAX_TICKS = 72; // 72 × 5 秒 = 6 分钟
  useEffect(() => {
    if (poll.current) clearTimeout(poll.current);
    if (!pending || tick >= MAX_TICKS) return;
    poll.current = setTimeout(async () => {
      try {
        const before = sum?.balanceCents ?? 0;
        const s = await load();
        if (s.balanceCents > before) {
          setPending(null);
          setPayInfo(null);
          setTick(0);
          setFlash('充值已到账。');
          return;
        }
      } catch {
        // 网络抖一下不算数，继续下一轮
      }
      setTick((n) => n + 1);
    }, 5000);
    return () => {
      if (poll.current) clearTimeout(poll.current);
    };
  }, [pending, tick, sum?.balanceCents, load]);

  /**
   * 「这笔充值扫码时要输多少瑞尔」的预览。
   *
   * 放在点付款**之前**：等下单之后才知道自己要掏多少已经晚了 ——
   * 用户会先看到一个陌生的数字，然后回头怀疑是不是充错了金额。
   *
   * 拿不到就不显示，绝不因为汇率接口抽风挡住付款。
   */
  useEffect(() => {
    const c = Math.round(Number(amountYuan) * 100);
    const ch = channels.find((x) => x.code === picked);
    if (!picked || !ch?.payCurrency || !(c > 0)) {
      setQuote(null);
      return;
    }
    // 用户还在敲金额的时候不要每按一个键就问一次
    let alive = true;
    const t = setTimeout(() => {
      void fetchQuote(picked, c, sum?.currency).then((q) => {
        if (alive) setQuote(q);
      });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [picked, amountYuan, channels, sum?.currency]);

  const payRef = useRef<HTMLDivElement | null>(null);
  const scrollToPay = () =>
    setTimeout(() => payRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);

  const cents = Math.round(Number(amountYuan) * 100);

  const startRecharge = async () => {
    setBusy(true);
    setError(null);
    setFlash(null);
    try {
      const r = await api.post<Recharge>('/api/wallet/recharges', { amountCents: cents });
      setPending(r);
      setTick(0);
      if (picked) {
        const info = await api.post<PayInfo>(`/api/payments/recharge/${r.rechargeNo}/pay`, {
          channel: picked,
        });
        setPayInfo(info);
        // 跳不了（比如拿到的是二维码内容）就把付款指引滚到眼前。
        // 它渲染在「充值」卡片下面，小屏上正好在折叠线以下 ——
        // 不滚过去的话用户看不到任何变化，只会以为点了没反应。
        if (!navigate(info.payUrl)) scrollToPay();
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
      setTick(0);
      const info = await api.post<PayInfo>(`/api/payments/recharge/${r.rechargeNo}/pay`, {
        channel: picked,
      });
      setPayInfo(info);
      if (!navigate(info.payUrl)) scrollToPay();
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
                  <ChannelCard
                    key={c.code}
                    channel={c}
                    on={picked === c.code}
                    onPick={() => setPicked(c.code)}
                  />
                ))}
              </div>
            </>
          )}

          {quote && (
            <div style={{ marginTop: 16 }}>
              <FxCallout quote={quote} cta="扫码后需要手动输入这个金额" />
            </div>
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

      <div ref={payRef}>{payInfo && <PayPanel info={payInfo} />}</div>

      {pending && tick >= MAX_TICKS && (
        <Unit>
          <div className="panelbody">
            <Notice tone="warn">
              等了六分钟还没等到到账，页面先不自动查了。
              已经付过款的话刷新一下这个页面看看；还是没有就联系客服，
              带上充值单号 <span className="data">{pending.rechargeNo}</span>。
            </Notice>
            <div className="btnrow" style={{ marginTop: 14 }}>
              <button className="btn btn--sm" onClick={() => { setTick(0); void load(); }}>
                再等一会儿
              </button>
            </div>
          </div>
        </Unit>
      )}

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
