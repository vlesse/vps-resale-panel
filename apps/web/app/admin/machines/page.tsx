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
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [f, setF] = useState<any>({ provider: 'ssh', sshPort: 22, sshUser: 'root', cpu: 2, memoryMb: 2048, diskGb: 40 });

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
    api.get<any[]>('/api/admin/plans').then(setPlans).catch(() => undefined);
  }, []);

  const resetForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setF({ provider: 'ssh', sshPort: 22, sshUser: 'root', cpu: 2, memoryMb: 2048, diskGb: 40 });
  };

  const startEdit = (m: any) => {
    setF({
      provider: m.provider,
      ip: m.ip ?? '',
      sshPort: m.sshPort ?? 22,
      sshUser: m.sshUser ?? 'root',
      password: '',
      privateKey: '',
      region: m.region ?? '',
      cpu: m.cpu,
      memoryMb: m.memoryMb,
      diskGb: m.diskGb,
      osTemplate: m.osTemplate ?? '',
      planId: m.plan?.id ?? '',
      notes: m.notes ?? '',
    });
    setEditingId(m.id);
    setFormOpen(true);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const save = async () => {
    setFlash(null);
    try {
      const body: any = {
        provider: f.provider,
        ip: f.ip,
        sshPort: Number(f.sshPort) || 22,
        sshUser: f.sshUser || 'root',
        region: f.region,
        cpu: Number(f.cpu),
        memoryMb: Number(f.memoryMb),
        diskGb: Number(f.diskGb),
        osTemplate: f.osTemplate || undefined,
        planId: f.planId || undefined,
        notes: f.notes || undefined,
      };
      // 密码和密钥留空表示「不改」，不能把空串写进去把凭据清掉
      if (f.password) body.password = f.password;
      if (f.privateKey) body.privateKey = f.privateKey;

      if (editingId) await api.patch(`/api/admin/machines/${editingId}`, body);
      else await api.post('/api/admin/machines', body);
      setFlash({ tone: 'ok', text: editingId ? '机器已保存' : '机器已录入' });
      resetForm();
      load();
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
  };

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
        <PanelBar title="机器" meta={data ? `共 ${data.total} 台` : undefined}>
          <div className="spacer" />
          <button
            className="btn btn--sm btn--key"
            onClick={() => (formOpen ? resetForm() : setFormOpen(true))}
          >
            {formOpen ? '收起' : '+ 录入机器'}
          </button>
        </PanelBar>
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

      {formOpen && (
        <Unit>
          <PanelBar title={editingId ? '修改机器' : '录入自有机器'} />
          <div className="panelbody">
            <Notice tone="info">
              这里录的是<b>你自己的机器</b> —— 自建 Proxmox 虚拟机，或任何一台能 SSH 进去的服务器。
              录进来之后它进「库存池」，绑定到一个「库存池」类型的套餐上才会被用户买到。
              谷歌云和 Lightsail 的机器由系统在用户下单时自动创建，不用手工录。
            </Notice>

            <div className="grid2" style={{ marginTop: 16 }}>
              <div className="field">
                <label className="label">平台</label>
                <select
                  className="select"
                  value={f.provider}
                  onChange={(e) => setF({ ...f, provider: e.target.value })}
                  disabled={!!editingId}
                >
                  <option value="ssh">自有机器（SSH 直连）</option>
                  <option value="proxmox">Proxmox VE</option>
                </select>
                {editingId && <span className="hint">平台建好之后不能改</span>}
              </div>
              <div className="field">
                <label className="label">IP 地址</label>
                <input
                  className="input"
                  value={f.ip ?? ''}
                  onChange={(e) => setF({ ...f, ip: e.target.value })}
                  placeholder="203.0.113.10"
                  spellCheck={false}
                />
              </div>
              <div className="field">
                <label className="label">SSH 端口</label>
                <input className="input" type="number" value={f.sshPort ?? 22} onChange={(e) => setF({ ...f, sshPort: e.target.value })} />
              </div>
              <div className="field">
                <label className="label">登录用户</label>
                <input className="input" value={f.sshUser ?? ''} onChange={(e) => setF({ ...f, sshUser: e.target.value })} placeholder="root" spellCheck={false} />
              </div>
              <div className="field">
                <label className="label">机房显示名</label>
                <input className="input" value={f.region ?? ''} onChange={(e) => setF({ ...f, region: e.target.value })} placeholder="洛杉矶" />
              </div>
              <div className="field">
                <label className="label">归到哪个套餐（可空）</label>
                <select className="select" value={f.planId ?? ''} onChange={(e) => setF({ ...f, planId: e.target.value })}>
                  <option value="">— 先不绑 —</option>
                  {plans
                    .filter((p) => p.fulfillment === 'inventory')
                    .map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                </select>
                <span className="hint">只有「库存池」类型的套餐能挂机器</span>
              </div>
            </div>

            <div className="grid2">
              <div className="field">
                <label className="label">CPU 核数</label>
                <input className="input" type="number" value={f.cpu ?? ''} onChange={(e) => setF({ ...f, cpu: e.target.value })} />
              </div>
              <div className="field">
                <label className="label">内存 MB</label>
                <input className="input" type="number" value={f.memoryMb ?? ''} onChange={(e) => setF({ ...f, memoryMb: e.target.value })} />
              </div>
              <div className="field">
                <label className="label">磁盘 GB</label>
                <input className="input" type="number" value={f.diskGb ?? ''} onChange={(e) => setF({ ...f, diskGb: e.target.value })} />
              </div>
              <div className="field">
                <label className="label">系统（可空）</label>
                <input className="input" value={f.osTemplate ?? ''} onChange={(e) => setF({ ...f, osTemplate: e.target.value })} placeholder="Debian 12" />
              </div>
            </div>

            <div className="field">
              <label className="label">root 密码{editingId ? '（留空表示不改）' : ''}</label>
              <input
                className="input"
                type="password"
                value={f.password ?? ''}
                onChange={(e) => setF({ ...f, password: e.target.value })}
                autoComplete="new-password"
              />
              <span className="hint">
                密码和密钥填一样就行，填了就是加密后存进数据库，页面上再也读不出来。
              </span>
            </div>

            <div className="field">
              <label className="label">SSH 私钥{editingId ? '（留空表示不改）' : '（可空）'}</label>
              <textarea
                className="textarea"
                value={f.privateKey ?? ''}
                onChange={(e) => setF({ ...f, privateKey: e.target.value })}
                placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----'}
                spellCheck={false}
              />
            </div>

            <div className="field">
              <label className="label">备注（只有你看得到）</label>
              <input className="input" value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} />
            </div>

            <div className="btnrow">
              <button className="btn btn--key" onClick={save}>
                {editingId ? '保存修改' : '录入'}
              </button>
              <button className="btn" onClick={resetForm}>取消</button>
            </div>
          </div>
        </Unit>
      )}

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
                        {/* 云上自动建的机器不给改 —— 规格由套餐和订单决定，
                            在这里改只会让面板记录和云上真实情况对不上 */}
                        {(m.provider === 'ssh' || m.provider === 'proxmox') && (
                          <button className="btn btn--sm" onClick={() => startEdit(m)}>
                            修改
                          </button>
                        )}
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
