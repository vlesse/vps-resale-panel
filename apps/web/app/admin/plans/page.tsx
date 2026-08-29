'use client';

import { useEffect, useState } from 'react';
import { api, money } from '@/lib/api';
import { Badge, Notice, PanelBar, Unit } from '@/components/ui';

interface Capability {
  kind: string;
  label: string;
  canProvision: boolean;
  needsCloudAccount: boolean;
  specFields: { key: string; label: string; type: string; hint: string }[];
}

interface AdminPlan {
  id: string;
  name: string;
  slug: string;
  provider: string;
  fulfillment: string;
  cloudAccount: { id: string; name: string; isEnabled: boolean } | null;
  providerSpec: Record<string, any> | null;
  regionLabel: string;
  cpu: number;
  memoryMb: number;
  diskGb: number;
  trafficGb: number | null;
  isEnabled: boolean;
  soldCount: number;
  prices: { cycle: string; currency: string; priceCents: number }[];
  availability: { inStock: boolean; label: string; adminReason?: string };
}

export default function AdminPlans() {
  const [caps, setCaps] = useState<Capability[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [rows, setRows] = useState<AdminPlan[] | null>(null);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'crit'; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState<any>({
    provider: 'gcp',
    fulfillment: 'on_demand',
    cpu: 2,
    memoryMb: 4096,
    diskGb: 80,
    priceCny: 45,
    priceUsd: 7,
    spec: {},
  });

  const load = () => api.get<AdminPlan[]>('/api/admin/plans').then(setRows).catch(() => undefined);

  useEffect(() => {
    api.get<Capability[]>('/api/admin/cloud-accounts/capabilities').then(setCaps).catch(() => undefined);
    api.get<any[]>('/api/admin/cloud-accounts').then(setAccounts).catch(() => undefined);
    void load();
  }, []);

  const cap = caps.find((c) => c.kind === f.provider);
  const usableAccounts = accounts.filter((a) => a.provider === f.provider && a.isEnabled);

  const create = async () => {
    setFlash(null);
    try {
      await api.post('/api/admin/plans', {
        name: f.name,
        slug: f.slug,
        provider: f.provider,
        fulfillment: f.fulfillment,
        cloudAccountId: f.cloudAccountId || undefined,
        providerSpec: normalizeSpec(f.spec),
        regionLabel: f.regionLabel,
        cpu: Number(f.cpu),
        memoryMb: Number(f.memoryMb),
        diskGb: Number(f.diskGb),
        trafficGb: f.trafficGb ? Number(f.trafficGb) : undefined,
        description: f.description,
        features: (f.features ?? '').split('\n').map((s: string) => s.trim()).filter(Boolean),
        prices: [
          ...(f.priceCny ? [{ cycle: 'monthly', currency: 'CNY', priceCents: Math.round(f.priceCny * 100) }] : []),
          ...(f.priceUsd ? [{ cycle: 'monthly', currency: 'USD', priceCents: Math.round(f.priceUsd * 100) }] : []),
        ],
      });
      setFlash({ tone: 'ok', text: '套餐已创建' });
      setCreating(false);
      await load();
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
  };

  return (
    <>
      <Unit>
        <PanelBar title="套餐" meta={rows ? `共 ${rows.length} 个` : undefined}>
          <div className="spacer" />
          <button className="btn btn--sm btn--key" onClick={() => setCreating((v) => !v)}>
            {creating ? '收起' : '+ 新建套餐'}
          </button>
        </PanelBar>
        {flash && (
          <div className="panelbody">
            <Notice tone={flash.tone}>{flash.text}</Notice>
          </div>
        )}
      </Unit>

      {creating && (
        <Unit>
          <PanelBar title="新建套餐" />
          <div className="panelbody">
            <div className="grid2">
              <div className="field">
                <label className="label">套餐名（用户看得到）</label>
                <input className="input" value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="东京 2C4G" />
              </div>
              <div className="field">
                <label className="label">标识 slug（英文，唯一）</label>
                <input className="input" value={f.slug ?? ''} onChange={(e) => setF({ ...f, slug: e.target.value })} placeholder="tokyo-2c4g" />
              </div>
              <div className="field">
                <label className="label">机房显示名（用户看得到）</label>
                <input className="input" value={f.regionLabel ?? ''} onChange={(e) => setF({ ...f, regionLabel: e.target.value })} placeholder="东京 · 亚洲东北" />
                <span className="hint">这里不要写「谷歌云」，用户不需要知道你从哪进的货</span>
              </div>
              <div className="field">
                <label className="label">履约方式</label>
                <select className="select" value={f.fulfillment} onChange={(e) => setF({ ...f, fulfillment: e.target.value })}>
                  <option value="on_demand">下单即开（付款后调 API 现建）</option>
                  <option value="inventory">库存池（从提前建好的机器里分配）</option>
                </select>
              </div>
              <div className="field">
                <label className="label">平台</label>
                <select className="select" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value, spec: {}, cloudAccountId: '' })}>
                  {caps.map((c) => (
                    <option key={c.kind} value={c.kind} disabled={f.fulfillment === 'on_demand' && !c.canProvision}>
                      {c.label}
                      {f.fulfillment === 'on_demand' && !c.canProvision ? '（不能自动建机）' : ''}
                    </option>
                  ))}
                </select>
              </div>
              {cap?.needsCloudAccount && (
                <div className="field">
                  <label className="label">用哪个云账号</label>
                  <select className="select" value={f.cloudAccountId ?? ''} onChange={(e) => setF({ ...f, cloudAccountId: e.target.value })}>
                    <option value="">— 请选择 —</option>
                    {usableAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                  {usableAccounts.length === 0 && (
                    <span className="hint" style={{ color: 'var(--warn)' }}>
                      还没有可用的 {cap.label} 账号，先去「云账号」页添加
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="grid2">
              {(['cpu', 'memoryMb', 'diskGb', 'trafficGb'] as const).map((k) => (
                <div className="field" key={k}>
                  <label className="label">
                    {{ cpu: 'CPU 核数', memoryMb: '内存 MB', diskGb: '磁盘 GB', trafficGb: '月流量 GB（可空）' }[k]}
                  </label>
                  <input className="input" type="number" value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
                </div>
              ))}
              <div className="field">
                <label className="label">月价（人民币，元）</label>
                <input className="input" type="number" step="0.01" value={f.priceCny ?? ''} onChange={(e) => setF({ ...f, priceCny: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label className="label">月价（美元，可空）</label>
                <input className="input" type="number" step="0.01" value={f.priceUsd ?? ''} onChange={(e) => setF({ ...f, priceUsd: Number(e.target.value) })} />
              </div>
            </div>

            {f.fulfillment === 'on_demand' && cap && cap.specFields.length > 0 && (
              <>
                <h3 className="title" style={{ fontSize: 14, marginTop: 18, marginBottom: 10 }}>
                  建机参数（{cap.label}）
                </h3>
                <div className="grid2">
                  {cap.specFields.map((sf) => (
                    <div className="field" key={sf.key}>
                      <label className="label">{sf.label}</label>
                      {sf.type === 'boolean' ? (
                        <label className="checkline">
                          <input
                            type="checkbox"
                            checked={!!f.spec[sf.key]}
                            onChange={(e) => setF({ ...f, spec: { ...f.spec, [sf.key]: e.target.checked } })}
                          />
                          启用
                        </label>
                      ) : (
                        <input
                          className="input"
                          type={sf.type === 'number' ? 'number' : 'text'}
                          value={f.spec[sf.key] ?? ''}
                          onChange={(e) => setF({ ...f, spec: { ...f.spec, [sf.key]: e.target.value } })}
                          spellCheck={false}
                        />
                      )}
                      <span className="hint">{sf.hint}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="field">
              <label className="label">卖点（一行一条）</label>
              <textarea
                className="textarea"
                style={{ minHeight: 90 }}
                value={f.features ?? ''}
                onChange={(e) => setF({ ...f, features: e.target.value })}
                placeholder={'独立公网 IPv4\nBBR 已开启\nSSH 直连 root'}
              />
            </div>

            <div className="btnrow">
              <button className="btn btn--key" onClick={create}>创建套餐</button>
              <button className="btn" onClick={() => setCreating(false)}>取消</button>
            </div>
          </div>
        </Unit>
      )}

      {rows?.map((p) => (
        <Unit key={p.id}>
          <div className="panelbody">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div style={{ minWidth: 0 }}>
                <div className="title" style={{ fontSize: 16 }}>{p.name}</div>
                <div className="data" style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
                  {p.slug} · {p.cpu}C {(p.memoryMb / 1024).toFixed(0)}G {p.diskGb}GB · {p.regionLabel}
                </div>
                <div className="silk" style={{ fontSize: 9.5, marginTop: 5 }}>
                  {p.provider} · {p.fulfillment === 'on_demand' ? '下单即开' : '库存池'}
                  {p.cloudAccount ? ` · ${p.cloudAccount.name}` : ''}
                  {` · 已售 ${p.soldCount}`}
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                {p.prices.map((pr) => (
                  <span key={pr.currency} className="badge">
                    {money(pr.priceCents, pr.currency as any)}/月
                  </span>
                ))}
                <Badge tone={p.isEnabled ? 'ok' : 'mute'}>{p.isEnabled ? '已上架' : '已下架'}</Badge>
                <Badge tone={p.availability.inStock ? 'ok' : 'warn'}>{p.availability.label}</Badge>
              </div>
            </div>

            {!p.availability.inStock && p.availability.adminReason && (
              <div style={{ marginTop: 12 }}>
                <Notice tone="warn">缺货原因：{p.availability.adminReason}</Notice>
              </div>
            )}

            <div className="btnrow" style={{ marginTop: 14 }}>
              <button
                className="btn btn--sm"
                onClick={async () => {
                  await api.patch(`/api/admin/plans/${p.id}`, { isEnabled: !p.isEnabled });
                  await load();
                }}
              >
                {p.isEnabled ? '下架' : '上架'}
              </button>
              <button
                className="btn btn--sm btn--danger"
                onClick={async () => {
                  try {
                    const r = await api.del<any>(`/api/admin/plans/${p.id}`);
                    setFlash({ tone: 'ok', text: r.message ?? '已删除' });
                  } catch (e: any) {
                    setFlash({ tone: 'crit', text: e.message });
                  }
                  await load();
                }}
              >
                删除
              </button>
            </div>
          </div>
        </Unit>
      ))}
    </>
  );
}

/** 表单里数字和布尔都是字符串，交给后端前转成正确的类型 */
function normalizeSpec(spec: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(spec)) {
    if (v === '' || v == null) continue;
    if (typeof v === 'boolean') out[k] = v;
    else if (/^\d+$/.test(String(v))) out[k] = Number(v);
    else out[k] = v;
  }
  // 没勾「固定 IP」时要显式传 false，否则后端会拦下来要求确认
  if (!('staticIp' in out)) out.staticIp = false;
  return out;
}
