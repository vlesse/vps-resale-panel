'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, formatDate, money } from '@/lib/api';
import { Notice, PanelBar, Readout, Unit } from '@/components/rack';

interface Orphans {
  count: number;
  hint: string;
  rows: {
    id: string;
    code: string;
    provider: string;
    cloudAccount?: string;
    providerRef: any;
    lastError: string | null;
    createdAt: string;
  }[];
}

export default function AdminHome() {
  const [orphans, setOrphans] = useState<Orphans | null>(null);
  const [machines, setMachines] = useState<any>(null);
  const [orders, setOrders] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [flash, setFlash] = useState<string | null>(null);

  const load = () => {
    // 不静默吞错误：请求失败和「确实没数据」长得一样，排查时毫无线索
    const fail = (what: string) => (e: any) => setFlash(`读取${what}失败：${e.message}`);
    api.get<Orphans>('/api/admin/machines/orphans').then(setOrphans).catch(fail('残留实例告警'));
    api.get('/api/admin/machines?pageSize=1').then(setMachines).catch(fail('机器统计'));
    api.get('/api/admin/orders?pageSize=5').then(setOrders).catch(fail('订单'));
    api.get<any[]>('/api/admin/cloud-accounts').then(setAccounts).catch(fail('云账号'));
  };

  useEffect(load, []);

  const byStatus = (s: string) =>
    machines?.summary?.find((x: any) => x.status === s)?.count ?? 0;

  const brokenAccounts = accounts.filter((a) => a.lastCheckError);

  return (
    <>
      {/* 最要紧的一条：可能正在烧钱的残留实例 */}
      {orphans && orphans.count > 0 && (
        <Unit>
          <PanelBar slot="!!!" title="疑似还在计费的残留实例" />
          <div className="panelbody">
            <Notice tone="crit">{orphans.hint}</Notice>
            <div className="tablewrap" style={{ marginTop: 14 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>机器编号</th>
                    <th>平台</th>
                    <th>云端实例名</th>
                    <th>出错时间</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {orphans.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="num" style={{ fontSize: 11.5 }}>{r.code}</td>
                      <td>{r.provider}</td>
                      <td className="num" style={{ fontSize: 11.5 }}>
                        {r.providerRef?.instanceName ?? '—'}
                        {r.providerRef?.zone ? ` @ ${r.providerRef.zone}` : ''}
                        {r.providerRef?.region ? ` @ ${r.providerRef.region}` : ''}
                      </td>
                      <td className="num" style={{ fontSize: 11.5 }}>{formatDate(r.createdAt)}</td>
                      <td>
                        <div className="btnrow">
                          <button
                            className="btn btn--sm"
                            onClick={async () => {
                              try {
                                const x = await api.post<any>(`/api/admin/machines/${r.id}/retry-release`);
                                setFlash(x.message);
                              } catch (e: any) {
                                setFlash(e.message);
                              }
                              load();
                            }}
                          >
                            重试销毁
                          </button>
                          <button
                            className="btn btn--sm"
                            onClick={async () => {
                              await api.post(`/api/admin/machines/${r.id}/mark-cleaned`, {
                                note: '后台人工确认',
                              });
                              setFlash('已标记为已清理');
                              load();
                            }}
                          >
                            已确认清理
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
              拿「云端实例名」到对应云厂商的控制台里搜一下。确认已经不存在的点「已确认清理」，
              还在的点「重试销毁」。这个列表非空的时候，说明可能有机器在按小时扣你的钱。
            </p>
            {flash && (
              <div style={{ marginTop: 12 }}>
                <Notice tone="info">{flash}</Notice>
              </div>
            )}
          </div>
        </Unit>
      )}

      {brokenAccounts.length > 0 && (
        <Unit>
          <div className="panelbody">
            <Notice tone="warn">
              有 {brokenAccounts.length} 个云账号的连接测试没通过（
              {brokenAccounts.map((a) => a.name).join('、')}）。
              这些账号下的套餐现在都开不出机器。
              <Link href="/admin/cloud-accounts"> 去处理 </Link>
            </Notice>
          </div>
        </Unit>
      )}

      <Unit>
        <PanelBar slot="U01" title="总览" />
        <div className="panelbody">
          <div className="well">
            <div className="readout">
              <Readout label="待售库存" value={byStatus('ready')} unit="台" />
              <Readout label="运行中" value={byStatus('running')} unit="台" />
              <Readout label="优化中" value={byStatus('optimizing')} unit="台" />
              <Readout label="出错" value={byStatus('error')} unit="台" />
            </div>
          </div>

          {orders?.revenue?.length > 0 && (
            <div className="well" style={{ marginTop: 14 }}>
              <div className="readout">
                {orders.revenue.map((r: any) => (
                  <Readout
                    key={r.currency}
                    label={`已收 ${r.currency}`}
                    value={money(r.totalCents, r.currency)}
                    unit={`/ ${r.orderCount} 笔`}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </Unit>

      <Unit>
        <PanelBar slot="U02" title="最近订单" />
        <div className="panelbody">
          {!orders?.rows?.length ? (
            <span className="muted">还没有订单</span>
          ) : (
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>订单号</th>
                    <th>用户</th>
                    <th>机型</th>
                    <th className="num">金额</th>
                    <th>状态</th>
                    <th>开通进度</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.rows.map((o: any) => (
                    <tr key={o.orderNo}>
                      <td className="num" style={{ fontSize: 11.5 }}>{o.orderNo}</td>
                      <td style={{ fontSize: 12 }}>{o.user.email}</td>
                      <td>{o.planName}</td>
                      <td className="num">{money(o.amountCents, o.currency)}</td>
                      <td>
                        <span
                          className="badge"
                          data-tone={
                            o.status === 'completed' ? 'ok' : o.status === 'failed' ? 'crit' : 'info'
                          }
                        >
                          {o.statusLabel}
                        </span>
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {o.provisioning
                          ? `${o.provisioning.progress}% ${o.provisioning.step ?? ''}`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="btnrow" style={{ marginTop: 14 }}>
            <Link href="/admin/orders" className="btn btn--sm">全部订单</Link>
            <Link href="/admin/machines" className="btn btn--sm">机器列表</Link>
          </div>
        </div>
      </Unit>
    </>
  );
}
