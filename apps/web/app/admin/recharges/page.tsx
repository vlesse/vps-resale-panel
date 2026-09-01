'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, formatDate, money } from '@/lib/api';
import { Badge, Notice, PanelBar, Unit } from '@/components/ui';

interface Row {
  id: string;
  rechargeNo: string;
  amountCents: number;
  currency: 'CNY' | 'USD';
  status: 'pending_payment' | 'paid' | 'cancelled' | 'expired';
  payChannel: string | null;
  paidAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  user: { id: string; email: string };
  /** 提交给网关的商户单号（带后缀），对账时拿它去服务商后台搜 */
  gatewayOrderNo: string | null;
  /** 网关那边的支付单号 */
  upstreamNo: string | null;
}

const STATUS: Record<Row['status'], { label: string; tone: 'ok' | 'warn' | 'mute' }> = {
  pending_payment: { label: '待付款', tone: 'warn' },
  paid: { label: '已到账', tone: 'ok' },
  cancelled: { label: '已取消', tone: 'mute' },
  expired: { label: '已超时', tone: 'mute' },
};

export default function AdminRecharges() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [keyword, setKeyword] = useState('');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'crit' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ pageSize: '50' });
    if (keyword.trim()) qs.set('keyword', keyword.trim());
    const r = await api.get<{ rows: Row[] }>(`/api/admin/wallet/recharges?${qs}`);
    setRows(r.rows);
  }, [keyword]);

  useEffect(() => {
    void load().catch((e) => setFlash({ tone: 'crit', text: e.message }));
  }, [load]);

  /**
   * 反过来问支付网关这笔到底收到钱没有。
   *
   * 用户说「我付了」而余额没动的时候，这是唯一能立刻分清是谁的问题的东西：
   * 网关说「支付成功」就是我们漏了回调（会当场补入账），
   * 网关说「订单不存在 / 未支付」那钱就没走到网关那边去。
   */
  const ask = async (r: Row) => {
    setBusy(r.rechargeNo);
    setFlash(null);
    try {
      const res = await api.post<any>(`/api/admin/pay-channels/query/recharge/${r.rechargeNo}`);
      setFlash({ tone: res.paid ? 'ok' : 'warn', text: `${r.rechargeNo}：${res.message}` });
      await load();
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    } finally {
      setBusy(null);
    }
  };

  const markPaid = async (r: Row) => {
    if (
      !window.confirm(
        `确认收到了 ${money(r.amountCents, r.currency)}？\n\n` +
          `确认后会立刻给 ${r.user.email} 加上这笔余额，加了不能撤销（只能再手工扣回去）。\n` +
          `请先在收款账户里核实这笔钱真的到了。`,
      )
    ) {
      return;
    }
    setBusy(r.rechargeNo);
    setFlash(null);
    try {
      await api.post(`/api/admin/wallet/recharges/${r.rechargeNo}/mark-paid`);
      setFlash({ tone: 'ok', text: `${r.rechargeNo} 已入账` });
      await load();
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Unit>
        <PanelBar title="充值单" meta="用户往账户里充的钱都在这里">
          <div className="spacer" />
          <div className="btnrow">
            <input
              className="input"
              style={{ width: 200 }}
              placeholder="单号或邮箱"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
            <button className="btn btn--sm" onClick={() => void load()}>查找</button>
          </div>
        </PanelBar>
        <div className="panelbody">
          <Notice tone="info">
            用户说付了钱但余额没动，先点「<strong>问网关</strong>」——
            网关说已支付就会当场补上，说没有这笔就是钱没走到网关那边。
            「标记已到账」是最后手段，点之前一定要先在收款账户里看到钱。
          </Notice>
          {flash && (
            <div style={{ marginTop: 14 }}>
              <Notice tone={flash.tone === 'warn' ? 'warn' : flash.tone}>{flash.text}</Notice>
            </div>
          )}
        </div>
      </Unit>

      <Unit>
        <div className="panelbody">
          {!rows ? (
            <>
              <span className="spin" />
              <span className="muted" style={{ marginLeft: 8 }}>正在读取…</span>
            </>
          ) : rows.length === 0 ? (
            <p className="hint">还没有充值单。</p>
          ) : (
            <table className="table table--cards">
              <thead>
                <tr>
                  <th>单号</th>
                  <th>用户</th>
                  <th className="r">金额</th>
                  <th>状态</th>
                  <th>方式</th>
                  <th>时间</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const st = STATUS[r.status];
                  return (
                    <tr key={r.id}>
                      <td data-label="单号">
                        <div className="num">{r.rechargeNo}</div>
                        {r.gatewayOrderNo && (
                          <div className="silk" style={{ fontSize: 9.5, marginTop: 3 }}>
                            报给网关 {r.gatewayOrderNo}
                          </div>
                        )}
                        {r.upstreamNo && (
                          <div className="silk" style={{ fontSize: 9.5, marginTop: 2 }}>
                            网关单号 {r.upstreamNo}
                          </div>
                        )}
                      </td>
                      <td data-label="用户">{r.user.email}</td>
                      <td data-label="金额" className="num r">{money(r.amountCents, r.currency)}</td>
                      <td data-label="状态">
                        <Badge tone={st.tone}>{st.label}</Badge>
                      </td>
                      <td data-label="方式">{r.payChannel ?? '—'}</td>
                      <td data-label="时间">{formatDate(r.paidAt ?? r.createdAt)}</td>
                      <td>
                        {r.status !== 'paid' && (
                          <div className="btnrow">
                            {r.gatewayOrderNo && (
                              <button
                                className="btn btn--sm"
                                disabled={busy === r.rechargeNo}
                                onClick={() => ask(r)}
                              >
                                问网关
                              </button>
                            )}
                            <button
                              className="btn btn--sm"
                              disabled={busy === r.rechargeNo}
                              onClick={() => markPaid(r)}
                            >
                              标记已到账
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Unit>
    </>
  );
}
