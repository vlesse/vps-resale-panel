'use client';

import { useEffect, useState } from 'react';
import { api, formatDate, money } from '@/lib/api';
import { Notice, PanelBar, Unit } from '@/components/ui';

const TONE: Record<string, any> = {
  pending_payment: 'warn',
  paid: 'info',
  provisioning: 'info',
  completed: 'ok',
  cancelled: 'mute',
  refunded: 'mute',
  failed: 'crit',
};

export default function AdminOrders() {
  const [data, setData] = useState<any>(null);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'crit'; text: string } | null>(null);

  const load = (s = status, k = keyword) => {
    const q = new URLSearchParams({ pageSize: '50' });
    if (k) q.set('keyword', k);
    if (s) q.set('status', s);
    api
      .get(`/api/admin/orders?${q}`)
      .then(setData)
      .catch((e) => setFlash({ tone: 'crit', text: `读取订单失败：${e.message}` }));
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async (orderNo: string, path: string, body?: any) => {
    setFlash(null);
    try {
      const r = await api.post<any>(`/api/admin/orders/${orderNo}/${path}`, body);
      setFlash({ tone: 'ok', text: r.message ?? '已执行' });
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
    load();
  };

  return (
    <>
      <Unit>
        <PanelBar title="订单" meta={data ? `共 ${data.total} 笔` : undefined} />
        <div className="panelbody">
          <div className="row">
            <input
              className="input"
              style={{ maxWidth: 240 }}
              placeholder="订单号或用户邮箱"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
            />
            <select
              className="select"
              style={{ maxWidth: 160 }}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                load(e.target.value);
              }}
            >
              <option value="">全部状态</option>
              <option value="pending_payment">待付款</option>
              <option value="provisioning">开通中</option>
              <option value="completed">已完成</option>
              <option value="failed">开通失败</option>
              <option value="cancelled">已取消</option>
            </select>
            <button className="btn btn--sm" onClick={() => load()}>查询</button>
          </div>

          {data?.revenue?.length > 0 && (
            <div className="row" style={{ marginTop: 14 }}>
              {data.revenue.map((r: any) => (
                <span key={r.currency} className="badge" data-tone="ok">
                  已收 {money(r.totalCents, r.currency)}（{r.orderCount} 笔）
                </span>
              ))}
            </div>
          )}
          {flash && (
            <div style={{ marginTop: 14 }}>
              <Notice tone={flash.tone}>{flash.text}</Notice>
            </div>
          )}
        </div>
      </Unit>

      <Unit>
        <div className="panelbody">
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>订单号</th>
                  <th>用户</th>
                  <th>机型</th>
                  <th className="num r">金额</th>
                  <th>状态</th>
                  <th>开通进度</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {(data?.rows ?? []).map((o: any) => (
                  <tr key={o.orderNo}>
                    <td className="num" style={{ fontSize: 11.5 }}>{o.orderNo}</td>
                    <td style={{ fontSize: 12 }}>{o.user.email}</td>
                    <td>
                      {o.planName}
                      {o.kind === 'renew' && <span className="badge" style={{ marginLeft: 6 }}>续费</span>}
                    </td>
                    <td className="num r">{money(o.amountCents, o.currency)}</td>
                    <td>
                      <span className="badge" data-tone={TONE[o.status] ?? 'mute'}>{o.statusLabel}</span>
                    </td>
                    <td className="muted" style={{ fontSize: 11.5, maxWidth: 220 }}>
                      {o.provisioning ? `${o.provisioning.progress}% ${o.provisioning.step ?? ''}` : '—'}
                      {o.provisioning?.error && (
                        <div style={{ color: 'var(--crit)', marginTop: 3 }}>
                          {String(o.provisioning.error).slice(0, 60)}
                        </div>
                      )}
                    </td>
                    <td className="num" style={{ fontSize: 11.5 }}>{formatDate(o.createdAt)}</td>
                    <td>
                      <div className="btnrow">
                        {o.status === 'pending_payment' && (
                          <button
                            className="btn btn--sm"
                            onClick={() => act(o.orderNo, 'mark-paid', { note: '后台确认收款' })}
                          >
                            标记已付
                          </button>
                        )}
                        {['failed', 'paid', 'provisioning'].includes(o.status) && (
                          <button className="btn btn--sm" onClick={() => act(o.orderNo, 'retry-provision')}>
                            重试开通
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data?.rows?.length && <span className="muted">没有符合条件的订单</span>}
          <p className="hint" style={{ marginTop: 14 }}>
            「标记已付」走的和支付回调完全同一条路径，所以手工补的单和自动的单行为一致。
            「重试开通」会从头重新建一台机器，上一次失败的半成品已经在失败时回滚掉了。
          </p>
        </div>
      </Unit>
    </>
  );
}
