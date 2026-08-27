'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Notice, PanelBar, Unit } from '@/components/rack';

interface Capability {
  kind: string;
  label: string;
  canProvision: boolean;
  canRebuild: boolean;
  hasMetrics: boolean;
  needsCloudAccount: boolean;
  credentialFields: { key: string; label: string; type: string; hint: string }[];
  specFields: { key: string; label: string; type: string; hint: string }[];
}

interface Account {
  id: string;
  name: string;
  provider: string;
  defaultRegion: string | null;
  dailyCreateQuota: number;
  todayCreated: number;
  isEnabled: boolean;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  planCount: number;
  machineCount: number;
  credentialSummary: Record<string, string>;
}

export default function CloudAccounts() {
  const [caps, setCaps] = useState<Capability[]>([]);
  const [rows, setRows] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'crit'; text: string } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .get<Account[]>('/api/admin/cloud-accounts')
      .then(setRows)
      .catch((e) => setError(e.message));

  useEffect(() => {
    api.get<Capability[]>('/api/admin/cloud-accounts/capabilities').then(setCaps).catch(() => undefined);
    void load();
  }, []);

  const cap = caps.find((c) => c.kind === adding);

  const submit = async () => {
    if (!cap) return;
    setBusy(true);
    setFlash(null);
    try {
      const r = await api.post<{ id: string; check: { ok: boolean; message: string } }>(
        '/api/admin/cloud-accounts',
        { name: name.trim() || cap.label, provider: cap.kind, credentials: form },
      );
      setFlash({
        tone: r.check.ok ? 'ok' : 'crit',
        text: r.check.ok ? `已添加，连接测试通过：${r.check.message}` : `已添加，但连接测试没过：${r.check.message}`,
      });
      setAdding(null);
      setForm({});
      setName('');
      await load();
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const verify = async (id: string) => {
    setFlash(null);
    try {
      const r = await api.post<{ ok: boolean; message: string; detail?: Record<string, any> }>(
        `/api/admin/cloud-accounts/${id}/verify`,
      );
      setFlash({
        tone: r.ok ? 'ok' : 'crit',
        text: r.ok
          ? `连接正常。${Object.entries(r.detail ?? {}).map(([k, v]) => `${k}：${v}`).join('，')}`
          : r.message,
      });
      await load();
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
  };

  const remove = async (id: string) => {
    setFlash(null);
    try {
      await api.del(`/api/admin/cloud-accounts/${id}`);
      setFlash({ tone: 'ok', text: '已删除' });
      await load();
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
  };

  return (
    <>
      <Unit>
        <PanelBar slot="U01" title="云账号" meta="面板拿这些凭据代表你去建机器" />
        <div className="panelbody">
          <Notice tone="info">
            凭据会用 AES-256-GCM 加密后存进数据库，任何接口都不会再把它读出来 ——
            页面上只显示脱敏摘要。要换的话整份重填。
          </Notice>
          {flash && (
            <div style={{ marginTop: 14 }}>
              <Notice tone={flash.tone}>{flash.text}</Notice>
            </div>
          )}
          {error && (
            <div style={{ marginTop: 14 }}>
              <Notice tone="crit">{error}</Notice>
            </div>
          )}
          <div className="btnrow" style={{ marginTop: 16 }}>
            {caps
              .filter((c) => c.needsCloudAccount)
              .map((c) => (
                <button
                  key={c.kind}
                  className={`btn btn--sm ${adding === c.kind ? 'btn--key' : ''}`}
                  onClick={() => {
                    setAdding(adding === c.kind ? null : c.kind);
                    setForm({});
                    setName('');
                  }}
                >
                  + {c.label}
                </button>
              ))}
          </div>
        </div>
      </Unit>

      {cap && (
        <Unit>
          <PanelBar slot="U02" title={`添加 ${cap.label}`} />
          <div className="panelbody">
            <div className="field" style={{ maxWidth: 420 }}>
              <label className="label">账号备注名</label>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`比如「${cap.label} 主账号」`}
              />
              <span className="hint">只是给你自己看的，用来区分多个账号</span>
            </div>

            {cap.credentialFields.map((f) => (
              <div className="field" key={f.key} style={{ maxWidth: f.type === 'textarea' ? 780 : 420 }}>
                <label className="label">{f.label}</label>
                {f.type === 'textarea' ? (
                  <textarea
                    className="textarea"
                    value={form[f.key] ?? ''}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                    placeholder='{ "type": "service_account", "project_id": "...", ... }'
                    spellCheck={false}
                  />
                ) : (
                  <input
                    className="input"
                    type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                    value={form[f.key] ?? ''}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
                <span className="hint">{f.hint}</span>
              </div>
            ))}

            <div className="btnrow" style={{ marginTop: 8 }}>
              <button className="btn btn--key" onClick={submit} disabled={busy}>
                {busy ? '正在测试连接…' : '添加并测试连接'}
              </button>
              <button className="btn" onClick={() => setAdding(null)}>取消</button>
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
              点「添加」之后系统会立刻真的去调一次这家云的只读接口，当场告诉你填对没有，
              而不是等到第一个用户下单建机失败才发现。
            </p>
          </div>
        </Unit>
      )}

      {rows?.length === 0 && (
        <Unit>
          <div className="panelbody">
            <Notice tone="warn">
              还没有任何云账号。没有云账号就没法做「下单即开」的套餐 ——
              上面选一家云添加。谷歌云需要一个服务账号 JSON 密钥，
              AWS 需要一对 IAM 密钥，具体怎么拿见文档第 3、4 章。
            </Notice>
          </div>
        </Unit>
      )}

      {rows?.map((a) => (
        <Unit key={a.id}>
          <div className="panelbody">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div style={{ minWidth: 0 }}>
                <div className="title" style={{ fontSize: 16 }}>{a.name}</div>
                <div className="silk" style={{ fontSize: 10, marginTop: 4 }}>
                  {a.provider} · 套餐 {a.planCount} 个 · 机器 {a.machineCount} 台
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <Badge tone={a.isEnabled ? 'ok' : 'mute'}>{a.isEnabled ? '已启用' : '已停用'}</Badge>
                <Badge tone={a.todayCreated >= a.dailyCreateQuota ? 'crit' : a.todayCreated > a.dailyCreateQuota * 0.7 ? 'warn' : 'mute'}>
                  今日 {a.todayCreated}/{a.dailyCreateQuota}
                </Badge>
              </div>
            </div>

            <div className="well" style={{ marginTop: 14 }}>
              <div className="readout">
                {Object.entries(a.credentialSummary).map(([k, v]) => (
                  <div key={k}>
                    <div className="ro-k">{k}</div>
                    <div className="data" style={{ fontSize: 12.5, color: 'var(--silk)', wordBreak: 'break-all' }}>
                      {v}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {a.lastCheckError && (
              <div style={{ marginTop: 12 }}>
                <Notice tone="crit">上次连接测试失败：{a.lastCheckError}</Notice>
              </div>
            )}

            <div className="btnrow" style={{ marginTop: 14 }}>
              <button className="btn btn--sm" onClick={() => verify(a.id)}>测试连接</button>
              <button
                className="btn btn--sm"
                onClick={async () => {
                  await api.patch(`/api/admin/cloud-accounts/${a.id}`, { isEnabled: !a.isEnabled });
                  await load();
                }}
              >
                {a.isEnabled ? '停用' : '启用'}
              </button>
              <button className="btn btn--sm btn--danger" onClick={() => remove(a.id)}>删除</button>
            </div>
          </div>
        </Unit>
      ))}
    </>
  );
}
