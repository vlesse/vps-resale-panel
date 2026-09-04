'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, formatDate } from '@/lib/api';
import { Badge, Notice, PanelBar, Unit } from '@/components/ui';

interface Row {
  id: string;
  serviceNo: string;
  status: string;
  planName?: string;
  regionLabel?: string;
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
  ip: string | null;
  sshPort: number;
  isNat: boolean;
  startAt: string | null;
  expireAt: string;
  daysLeft: number;
  suspendReason: string | null;
  user: { id: string; email: string };
  provider?: string;
  machineCode?: string;
}

const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'crit' | 'mute' | 'info' }> = {
  provisioning: { label: '开通中', tone: 'info' },
  active: { label: '运行中', tone: 'ok' },
  stopped: { label: '已关机', tone: 'mute' },
  suspended: { label: '已挂起', tone: 'warn' },
  expired: { label: '已过期', tone: 'warn' },
  cancelled: { label: '已销毁', tone: 'mute' },
  error: { label: '异常', tone: 'crit' },
};

export default function AdminServices() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'crit' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 正在确认销毁的那一行，以及输入框里抄的编号 */
  const [killing, setKilling] = useState<Row | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ pageSize: '50' });
    if (keyword.trim()) qs.set('keyword', keyword.trim());
    if (status) qs.set('status', status);
    const r = await api.get<{ rows: Row[] }>(`/api/admin/services?${qs}`);
    setRows(r.rows);
  }, [keyword, status]);

  useEffect(() => {
    void load().catch((e) => setFlash({ tone: 'crit', text: e.message }));
  }, [load]);

  const run = async (r: Row, path: string, body?: any, okText?: string) => {
    setBusy(r.id);
    setFlash(null);
    try {
      const res = await api.post<any>(`/api/admin/services/${r.id}/${path}`, body);
      setFlash({ tone: 'ok', text: res.message ?? okText ?? '已执行' });
      setKilling(null);
      setConfirmText('');
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
        <PanelBar title="已交付的机器" meta="用户买到手的每一台都在这里">
          <div className="spacer" />
          <div className="btnrow">
            <input
              className="input"
              style={{ width: 190 }}
              placeholder="服务号 / IP / 邮箱"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
            <select className="input" style={{ width: 120 }} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">全部状态</option>
              {Object.entries(STATUS).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
            <button className="btn btn--sm" onClick={() => void load()}>查找</button>
          </div>
        </PanelBar>
        <div className="panelbody">
          <Notice tone="warn">
            「<strong>销毁</strong>」会把机器从云厂商那边真删掉，同时回收 NAT 端口、
            清空登录凭据、把服务标成已销毁。<strong>不可恢复，也不会自动退款</strong> ——
            要退钱去「用户」页手工调余额。
          </Notice>
          {flash && (
            <div style={{ marginTop: 14 }}>
              <Notice tone={flash.tone === 'warn' ? 'warn' : flash.tone}>{flash.text}</Notice>
            </div>
          )}
        </div>
      </Unit>

      {killing && (
        <Unit>
          <div className="panelbody">
            <h3 className="title" style={{ color: 'var(--crit)' }}>销毁 {killing.serviceNo}</h3>
            <div style={{ margin: '12px 0' }}>
              <Notice tone="crit">
                这台机器（{killing.user.email} 的 {killing.planName}）会被从
                {killing.provider === 'gcp' ? '谷歌云' : killing.provider} 上真正删除，
                数据全部消失且无法恢复。用户不会收到退款。
              </Notice>
            </div>
            <div className="field" style={{ maxWidth: 380 }}>
              <label className="label">
                请输入机器编号 <span className="data">{killing.machineCode}</span> 以确认
              </label>
              <input
                className="input"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={killing.machineCode}
                autoComplete="off"
              />
            </div>
            <div className="btnrow">
              <button
                className="btn btn--danger"
                disabled={!confirmText || busy === killing.id}
                onClick={() => run(killing, 'release', { confirm: confirmText })}
              >
                {busy === killing.id ? '提交中…' : '确认销毁'}
              </button>
              <button
                className="btn"
                onClick={() => {
                  setKilling(null);
                  setConfirmText('');
                }}
              >
                取消
              </button>
            </div>
          </div>
        </Unit>
      )}

      <Unit>
        <div className="panelbody">
          {!rows ? (
            <>
              <span className="spin" />
              <span className="muted" style={{ marginLeft: 8 }}>正在读取…</span>
            </>
          ) : rows.length === 0 ? (
            <p className="hint">没有符合条件的机器。</p>
          ) : (
            <table className="table table--cards">
              <thead>
                <tr>
                  <th>服务</th>
                  <th>用户</th>
                  <th>规格</th>
                  <th>地址</th>
                  <th>状态</th>
                  <th>到期</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const st = STATUS[r.status] ?? { label: r.status, tone: 'mute' as const };
                  const dead = r.status === 'cancelled';
                  return (
                    <tr key={r.id}>
                      <td data-label="服务">
                        <Link href={`/services/${r.id}`} className="num" style={{ color: 'var(--accent)' }}>
                          {r.serviceNo}
                        </Link>
                        <div className="silk" style={{ fontSize: 9.5, marginTop: 3 }}>
                          {r.planName}
                          {r.machineCode ? ` · ${r.machineCode}` : ''}
                          {r.provider ? ` · ${r.provider}` : ''}
                        </div>
                      </td>
                      <td data-label="用户">{r.user.email}</td>
                      <td data-label="规格" className="num">
                        {r.cpu}C {r.memoryMb ? Math.round(r.memoryMb / 1024) : '?'}G {r.diskGb}G
                      </td>
                      <td data-label="地址" className="num">
                        {r.ip ?? '—'}
                        {r.isNat && <span className="silk" style={{ marginLeft: 6 }}>:{r.sshPort}</span>}
                      </td>
                      <td data-label="状态">
                        <Badge tone={st.tone}>{st.label}</Badge>
                        {r.suspendReason && (
                          <div className="silk" style={{ fontSize: 9.5, marginTop: 3 }}>{r.suspendReason}</div>
                        )}
                      </td>
                      <td data-label="到期">
                        {formatDate(r.expireAt)}
                        <div className="silk" style={{ fontSize: 9.5, marginTop: 3 }}>
                          还剩 {r.daysLeft} 天
                        </div>
                      </td>
                      <td>
                        {!dead && (
                          <div className="btnrow">
                            {r.status === 'suspended' ? (
                              <button
                                className="btn btn--sm"
                                disabled={busy === r.id}
                                onClick={() => run(r, 'resume', undefined, '已恢复')}
                              >
                                恢复
                              </button>
                            ) : (
                              <button
                                className="btn btn--sm"
                                disabled={busy === r.id}
                                onClick={() => {
                                  const reason = window.prompt('挂起原因（用户会看到）：', '违规使用');
                                  if (reason) void run(r, 'suspend', { reason }, '已挂起');
                                }}
                              >
                                挂起
                              </button>
                            )}
                            <button
                              className="btn btn--sm btn--danger"
                              disabled={busy === r.id || !r.machineCode}
                              onClick={() => {
                                setKilling(r);
                                setConfirmText('');
                              }}
                            >
                              销毁
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
