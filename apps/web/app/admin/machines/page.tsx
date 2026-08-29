'use client';

import { useEffect, useState } from 'react';
import { api, formatDate } from '@/lib/api';
import { Notice, PanelBar, Unit } from '@/components/ui';

const TONE: Record<string, any> = {
  ready: 'ok',
  running: 'ok',
  optimizing: 'info',
  sourcing: 'info',
  provisioning: 'info',
  rebuilding: 'info',
  reserved: 'warn',
  suspended: 'warn',
  releasing: 'warn',
  stopped: 'mute',
  released: 'mute',
  error: 'crit',
};

export default function AdminMachines() {
  const [data, setData] = useState<any>(null);
  const [status, setStatus] = useState('');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'crit'; text: string } | null>(null);

  const load = (s = status) => {
    const q = new URLSearchParams({ pageSize: '60' });
    if (s) q.set('status', s);
    api
      .get(`/api/admin/machines?${q}`)
      .then(setData)
      .catch((e) => setFlash({ tone: 'crit', text: `读取机器列表失败：${e.message}` }));
  };

  useEffect(() => {
    void load();
  }, []);

  const change = async (id: string, next: string) => {
    setFlash(null);
    try {
      const r = await api.post<any>(`/api/admin/machines/${id}/status`, { status: next });
      setFlash({ tone: 'ok', text: r.message });
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
    load();
  };

  const test = async (id: string) => {
    setFlash(null);
    try {
      const r = await api.post<any>(`/api/admin/machines/${id}/test-connection`);
      setFlash({
        tone: r.ok ? 'ok' : 'crit',
        text: r.ok
          ? `连接成功。${Object.entries(r.detail ?? {}).map(([k, v]) => `${k}：${v}`).join('，')}`
          : r.message,
      });
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
    load();
  };

  return (
    <>
      <Unit>
        <PanelBar title="机器" meta={data ? `共 ${data.total} 台` : undefined} />
        <div className="panelbody">
          <div className="row">
            <button
              className={`btn btn--sm ${!status ? 'btn--key' : ''}`}
              onClick={() => {
                setStatus('');
                load('');
              }}
            >
              全部
            </button>
            {(data?.summary ?? []).map((s: any) => (
              <button
                key={s.status}
                className={`btn btn--sm ${status === s.status ? 'btn--key' : ''}`}
                onClick={() => {
                  setStatus(s.status);
                  load(s.status);
                }}
              >
                {s.label} {s.count}
              </button>
            ))}
          </div>
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
                  <th>编号</th>
                  <th>平台</th>
                  <th>IP</th>
                  <th>规格</th>
                  <th>状态</th>
                  <th>归属</th>
                  <th>最近检测</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {(data?.rows ?? []).map((m: any) => (
                  <tr key={m.id}>
                    <td className="num" style={{ fontSize: 11.5 }}>{m.code}</td>
                    <td>{m.provider}</td>
                    <td className="num" style={{ fontSize: 12 }}>{m.ip ?? '—'}</td>
                    <td className="num" style={{ fontSize: 11.5 }}>
                      {m.cpu}C {(m.memoryMb / 1024).toFixed(0)}G {m.diskGb}GB
                    </td>
                    <td>
                      <span className="badge" data-tone={TONE[m.status] ?? 'mute'}>{m.statusLabel}</span>
                    </td>
                    <td style={{ fontSize: 11.5 }}>
                      {m.service ? m.service.serviceNo : m.plan ? m.plan.name : '—'}
                    </td>
                    <td className="num" style={{ fontSize: 11.5 }}>
                      {formatDate(m.lastCheckedAt)}
                      {m.lastError && (
                        <div style={{ color: 'var(--crit)', marginTop: 3, maxWidth: 200 }}>
                          {String(m.lastError).slice(0, 50)}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="btnrow">
                        {m.hasCredentials && (
                          <button className="btn btn--sm" onClick={() => test(m.id)}>
                            测连接
                          </button>
                        )}
                        {(m.nextStatuses ?? []).slice(0, 2).map((n: any) => (
                          <button key={n.value} className="btn btn--sm" onClick={() => change(m.id, n.value)}>
                            → {n.label}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data?.rows?.length && <span className="muted">没有机器</span>}
          <p className="hint" style={{ marginTop: 14 }}>
            流转按钮只显示当前状态允许的下一步。库存机要走完「采购中 → 优化中 → 待售」
            才会被用户买到；谷歌云和 Lightsail 的机器由系统在用户下单时自动创建，不用手工录。
          </p>
        </div>
      </Unit>
    </>
  );
}
