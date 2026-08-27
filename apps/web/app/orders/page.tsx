'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, formatDate, getToken, money, type OrderItem } from '@/lib/api';
import { Notice, PanelBar, Unit } from '@/components/rack';

const TONE: Record<string, 'ok' | 'warn' | 'crit' | 'info' | 'mute'> = {
  pending_payment: 'warn',
  paid: 'info',
  provisioning: 'info',
  completed: 'ok',
  cancelled: 'mute',
  refunded: 'mute',
  failed: 'crit',
};

export default function Orders() {
  const router = useRouter();
  const [rows, setRows] = useState<OrderItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.push('/login?next=/orders');
      return;
    }
    api
      .get<OrderItem[]>('/api/orders')
      .then(setRows)
      .catch((e) => setError(e.message));
  }, [router]);

  return (
    <>
      <Unit>
        <PanelBar slot="U01" title="我的订单" meta={rows ? `共 ${rows.length} 笔` : undefined} />
      </Unit>

      <Unit>
        <div className="panelbody">
          {error && <Notice tone="crit">{error}</Notice>}
          {rows === null && !error && (
            <>
              <span className="spin" /> <span className="muted" style={{ marginLeft: 8 }}>正在读取…</span>
            </>
          )}
          {rows?.length === 0 && (
            <Notice tone="info">
              还没有订单。到<Link href="/"> 选购页 </Link>看看有什么机型。
            </Notice>
          )}
          {rows && rows.length > 0 && (
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>订单号</th>
                    <th>机型</th>
                    <th>周期</th>
                    <th className="num">金额</th>
                    <th>状态</th>
                    <th>下单时间</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <tr key={o.orderNo}>
                      <td className="num" style={{ fontSize: 11.5 }}>{o.orderNo}</td>
                      <td>
                        {o.planName}
                        {o.kind === 'renew' && <span className="badge" style={{ marginLeft: 6 }}>续费</span>}
                      </td>
                      <td>{o.cycleLabel}</td>
                      <td className="num">{money(o.amountCents, o.currency)}</td>
                      <td>
                        <span className="badge" data-tone={TONE[o.status] ?? 'mute'}>{o.statusLabel}</span>
                      </td>
                      <td className="num" style={{ fontSize: 11.5 }}>{formatDate(o.createdAt)}</td>
                      <td>
                        {o.status === 'pending_payment' ? (
                          <Link href={`/pay/${o.orderNo}`} className="btn btn--sm btn--key">去付款</Link>
                        ) : (
                          <Link href={`/pay/${o.orderNo}`} className="btn btn--sm">详情</Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Unit>
    </>
  );
}
