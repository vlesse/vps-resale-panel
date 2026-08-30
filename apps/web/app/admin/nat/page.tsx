'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Notice, PanelBar, Unit } from '@/components/ui';

interface Gateway {
  id: string;
  name: string;
  publicHost: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  hasAuth: boolean;
  subnet: string;
  portStart: number;
  portEnd: number;
  portsPerMachine: number;
  webDomain: string | null;
  capacity: number;
  used: number;
  enabled: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
}

interface Binding {
  machineCode: string;
  internalIp: string | null;
  machineStatus: string;
  sshPort: number;
  portStart: number;
  portEnd: number;
  webHost: string | null;
}

const BLANK = {
  name: '',
  publicHost: '',
  sshHost: '',
  sshPort: '22',
  sshUser: 'root',
  password: '',
  privateKey: '',
  subnet: '172.31.0.0/24',
  portStart: '20000',
  portEnd: '39999',
  portsPerMachine: '20',
  webDomain: '',
};

export default function NatGateways() {
  const [rows, setRows] = useState<Gateway[] | null>(null);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'crit' | 'warn'; text: string } | null>(null);
  const [form, setForm] = useState({ ...BLANK });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [bindings, setBindings] = useState<Binding[] | null>(null);

  const load = () =>
    api
      .get<Gateway[]>('/api/admin/nat-gateways')
      .then(setRows)
      .catch((e) => setFlash({ tone: 'crit', text: e.message }));

  useEffect(() => {
    void load();
  }, []);

  const startEdit = (g: Gateway) => {
    setEditingId(g.id);
    setShowForm(true);
    setForm({
      name: g.name,
      publicHost: g.publicHost,
      sshHost: g.sshHost,
      sshPort: String(g.sshPort),
      sshUser: g.sshUser,
      // 密码不回填 —— 接口本来就不吐出来。留空提交就是「别动」。
      password: '',
      privateKey: '',
      subnet: g.subnet,
      portStart: String(g.portStart),
      portEnd: String(g.portEnd),
      portsPerMachine: String(g.portsPerMachine),
      webDomain: g.webDomain ?? '',
    });
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const reset = () => {
    setEditingId(null);
    setShowForm(false);
    setForm({ ...BLANK });
  };

  const save = async () => {
    setBusy(true);
    setFlash(null);
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      publicHost: form.publicHost.trim(),
      sshHost: form.sshHost.trim() || form.publicHost.trim(),
      sshPort: Number(form.sshPort) || 22,
      sshUser: form.sshUser.trim() || 'root',
      subnet: form.subnet.trim(),
      portStart: Number(form.portStart),
      portEnd: Number(form.portEnd),
      portsPerMachine: Number(form.portsPerMachine),
      webDomain: form.webDomain.trim(),
    };
    if (form.password.trim()) body.password = form.password;
    if (form.privateKey.trim()) body.privateKey = form.privateKey;

    try {
      if (editingId) await api.patch(`/api/admin/nat-gateways/${editingId}`, body);
      else await api.post('/api/admin/nat-gateways', body);
      setFlash({ tone: 'ok', text: editingId ? '已保存' : '已添加，记得点一下「测试」看看通不通' });
      reset();
      await load();
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const test = async (id: string) => {
    setFlash({ tone: 'warn', text: '正在连网关…' });
    try {
      const r = await api.post<{ ok: boolean; hint: string | null; detail: string }>(
        `/api/admin/nat-gateways/${id}/test`,
      );
      setFlash({
        tone: r.ok ? 'ok' : 'crit',
        text: r.ok ? `网关正常。${r.detail.replace(/\n/g, '　')}` : (r.hint ?? r.detail),
      });
      await load();
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
  };

  const sync = async (id: string) => {
    setFlash({ tone: 'warn', text: '正在下发规则…' });
    try {
      const r = await api.post<{ rules: number }>(`/api/admin/nat-gateways/${id}/sync`);
      setFlash({ tone: 'ok', text: `已下发，当前有 ${r.rules} 台机器的映射生效` });
      await load();
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
  };

  const remove = async (id: string) => {
    setFlash(null);
    try {
      await api.del(`/api/admin/nat-gateways/${id}`);
      setFlash({ tone: 'ok', text: '已删除' });
      await load();
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
  };

  const toggleDetail = async (id: string) => {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setBindings(null);
    try {
      const d = await api.get<{ bindings: Binding[] }>(`/api/admin/nat-gateways/${id}`);
      setBindings(d.bindings);
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
  };

  const f = (k: keyof typeof BLANK) => ({
    value: form[k],
    onChange: (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value }),
  });

  return (
    <>
      <Unit>
        <PanelBar title="NAT 入口" meta="把私网里的机器映射到公网端口上，卖没有公网 IP 的机器">
          <div className="spacer" />
          <button
            className={`btn btn--sm ${showForm && !editingId ? 'btn--key' : ''}`}
            onClick={() => (showForm ? reset() : setShowForm(true))}
          >
            {showForm ? '收起' : '+ 添加网关'}
          </button>
        </PanelBar>
        <div className="panelbody">
          <Notice tone="info">
            网关是一台<b>有公网 IP</b> 的机器，机器本体待在你自己的私网里。两边怎么连通
            （Tailscale、WireGuard、还是同机房二层）面板不管，只要网关自己
            <code>ip route</code> 能看到那个网段就行。面板只负责在网关上写 iptables。
          </Notice>
          {flash && (
            <div style={{ marginTop: 14 }}>
              <Notice tone={flash.tone === 'warn' ? 'warn' : flash.tone}>{flash.text}</Notice>
            </div>
          )}
        </div>
      </Unit>

      {showForm && (
        <Unit>
          <PanelBar title={editingId ? '修改网关' : '添加网关'} />
          <div className="panelbody">
            <div className="grid2">
              <div className="field">
                <label className="label">名称</label>
                <input className="input" placeholder="比如「香港入口」" {...f('name')} />
              </div>
              <div className="field">
                <label className="label">对外地址</label>
                <input className="input" placeholder="34.80.126.84 或 nat.example.com" {...f('publicHost')} />
                <span className="hint">买家看到、也是买家去连的地址</span>
              </div>
              <div className="field">
                <label className="label">私网网段</label>
                <input className="input" placeholder="172.31.0.0/24" {...f('subnet')} />
                <span className="hint">机器待的那个网段，要和套餐里的 ipPool 一致</span>
              </div>

              <div className="field">
                <label className="label">面板连它的地址</label>
                <input className="input" placeholder="留空就用上面的对外地址" {...f('sshHost')} />
              </div>
              <div className="field">
                <label className="label">SSH 端口</label>
                <input className="input" type="number" {...f('sshPort')} />
              </div>
              <div className="field">
                <label className="label">SSH 用户</label>
                <input className="input" {...f('sshUser')} />
                <span className="hint">要能免密 sudo 或者直接是 root，面板得写 iptables</span>
              </div>

              <div className="field">
                <label className="label">密码</label>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  placeholder={editingId ? '留空表示不改' : ''}
                  {...f('password')}
                />
              </div>
              <div className="field">
                <label className="label">起始端口</label>
                <input className="input" type="number" {...f('portStart')} />
              </div>
              <div className="field">
                <label className="label">结束端口</label>
                <input className="input" type="number" {...f('portEnd')} />
              </div>

              <div className="field">
                <label className="label">每台机器分几个端口</label>
                <input className="input" type="number" {...f('portsPerMachine')} />
                <span className="hint">第一个固定映射到机器的 22，其余原样转发</span>
              </div>
              <div className="field">
                <label className="label">二级域名根域（选填）</label>
                <input className="input" placeholder="nat.example.com" {...f('webDomain')} />
                <span className="hint">
                  填了每台机器会拿到 m&lt;SSH端口&gt;.这个域名，指向它的 80。
                  网关上要先装好泛域名站点和证书，见文档第 10 章。
                </span>
              </div>
            </div>

            <div className="field" style={{ maxWidth: 780 }}>
              <label className="label">私钥（可选，比密码稳）</label>
              <textarea
                className="textarea"
                spellCheck={false}
                placeholder={editingId ? '留空表示不改' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                {...f('privateKey')}
              />
            </div>

            <div className="btnrow" style={{ marginTop: 8 }}>
              <button className="btn btn--key" onClick={save} disabled={busy}>
                {busy ? '保存中…' : editingId ? '保存修改' : '添加'}
              </button>
              <button className="btn" onClick={reset}>取消</button>
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
              端口区间要留够：{form.portEnd && form.portStart && form.portsPerMachine
                ? `按现在这个填法，这台网关能带 ${Math.max(
                    0,
                    Math.floor(
                      (Number(form.portEnd) - Number(form.portStart) + 1) /
                        Math.max(1, Number(form.portsPerMachine)),
                    ),
                  )} 台机器`
                : '起点、终点、每台端口数填全了这里会算给你看'}
              。还要确认云厂商的防火墙放行了这一段，不然规则写对了外面照样连不上。
            </p>
          </div>
        </Unit>
      )}

      {rows?.length === 0 && (
        <Unit>
          <div className="panelbody">
            <Notice tone="warn">
              还没有 NAT 网关。没有它就只能卖有公网 IP 的机器 ——
              自建 Proxmox 上那些私网虚拟机是卖不出去的，因为买家根本连不上。
            </Notice>
          </div>
        </Unit>
      )}

      {rows?.map((g) => (
        <Unit key={g.id}>
          <div className="panelbody">
            <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div className="title" style={{ fontSize: 16 }}>
                  {g.name}{' '}
                  {g.enabled ? <Badge tone="ok">启用</Badge> : <Badge tone="mute">停用</Badge>}
                </div>
                <div className="num" style={{ fontSize: 12, marginTop: 4 }}>
                  {g.publicHost} · {g.subnet} · 端口 {g.portStart}–{g.portEnd}
                  {g.webDomain ? ` · *.${g.webDomain}` : ''}
                </div>
              </div>
              <div className="btnrow">
                <button className="btn btn--sm" onClick={() => test(g.id)}>测试</button>
                <button className="btn btn--sm" onClick={() => sync(g.id)}>重新下发</button>
                <button className="btn btn--sm" onClick={() => startEdit(g)}>修改</button>
                <button className="btn btn--sm" onClick={() => toggleDetail(g.id)}>
                  {openId === g.id ? '收起' : `机器 ${g.used}`}
                </button>
                <button className="btn btn--sm" onClick={() => remove(g.id)}>删除</button>
              </div>
            </div>

            <div className="caps" style={{ marginTop: 14 }}>
              <div>
                <div className="ro-k">容量</div>
                <div className="ro-v">
                  {g.used} <small>/ {g.capacity} 台</small>
                </div>
              </div>
              <div>
                <div className="ro-k">每台端口数</div>
                <div className="ro-v">{g.portsPerMachine}</div>
              </div>
              <div>
                <div className="ro-k">上次下发</div>
                <div className="ro-v" style={{ fontSize: 13 }}>
                  {g.lastSyncAt ? new Date(g.lastSyncAt).toLocaleString('zh-CN') : '还没下发过'}
                </div>
              </div>
              <div>
                <div className="ro-k">凭据</div>
                <div className="ro-v" style={{ fontSize: 13 }}>
                  {g.hasAuth ? `${g.sshUser}@${g.sshHost}:${g.sshPort}` : '没填，下发不了'}
                </div>
              </div>
            </div>

            {g.lastError && (
              <div style={{ marginTop: 14 }}>
                <Notice tone="crit">上次下发失败：{g.lastError}</Notice>
              </div>
            )}

            {openId === g.id && (
              <div style={{ marginTop: 16 }}>
                {!bindings ? (
                  <p className="hint">读取中…</p>
                ) : bindings.length === 0 ? (
                  <p className="hint">这个网关上还没有机器。</p>
                ) : (
                  <table className="table table--cards">
                    <thead>
                      <tr>
                        <th>机器</th>
                        <th>私网地址</th>
                        <th className="r">SSH 端口</th>
                        <th className="r">端口段</th>
                        <th>二级域名</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bindings.map((b) => (
                        <tr key={b.machineCode}>
                          <td data-label="机器" className="num">{b.machineCode}</td>
                          <td data-label="私网地址" className="num">{b.internalIp ?? '—'}</td>
                          <td data-label="SSH 端口" className="num r">{b.sshPort}</td>
                          <td data-label="端口段" className="num r">
                            {b.portStart}–{b.portEnd}
                          </td>
                          <td data-label="二级域名" className="num">{b.webHost ?? '—'}</td>
                          <td data-label="状态">{b.machineStatus}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </Unit>
      ))}
    </>
  );
}
