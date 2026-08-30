'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Notice, PanelBar, Unit } from '@/components/ui';

interface Channel {
  id: string;
  code: string;
  name: string;
  driver: string;
  wayCode: string | null;
  settleCurrency: string | null;
  gatewayUrl: string | null;
  rate: number | null;
  usdToCnyRate: number | null;
  isEnabled: boolean;
  descText: string | null;
  credentialSummary: Record<string, string>;
}

interface CredentialField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  hint: string;
}

interface DriverSpec {
  driver: string;
  label: string;
  hint: string;
  needsWayCode: boolean;
  wayCodeHint?: string;
  needsRate?: boolean;
  credentialFields: CredentialField[];
}

/** 加通道时的默认名字，省得每次都自己想 */
const PRESET_NAME: Record<string, string> = {
  epay: '支付宝 / 微信',
  usdt_trc20: 'USDT（TRC20）',
  jeepay: '扫码支付',
  balance: '账户余额',
  manual: '线下转账',
};

export default function PayChannels() {
  const [rows, setRows] = useState<Channel[] | null>(null);
  const [specs, setSpecs] = useState<DriverSpec[]>([]);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'crit' | 'warn'; text: string } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [f, setF] = useState<Record<string, string>>({});

  const load = () =>
    api.get<Channel[]>('/api/admin/pay-channels').then(setRows).catch(() => undefined);

  useEffect(() => {
    void load();
    api
      .publicGet<DriverSpec[]>('/api/payments/driver-specs')
      .then(setSpecs)
      .catch(() => undefined);
  }, []);

  const spec = specs.find((s) => s.driver === adding);

  const pick = (driver: string) => {
    setAdding(adding === driver ? null : driver);
    setF({ code: driver, name: PRESET_NAME[driver] ?? '' });
  };

  const create = async () => {
    if (!spec) return;
    setFlash(null);
    const credentials: Record<string, string> = {};
    for (const cf of spec.credentialFields) {
      if (f[cf.key]) credentials[cf.key] = f[cf.key].trim();
    }
    try {
      const r = await api.post<any>('/api/admin/pay-channels', {
        code: (f.code || spec.driver).trim(),
        name: (f.name || spec.label).trim(),
        driver: spec.driver,
        wayCode: spec.needsWayCode ? f.wayCode?.trim() : undefined,
        gatewayUrl: credentials.gatewayUrl,
        settleCurrency: f.settleCurrency?.trim() || undefined,
        usdToCnyRate: f.usdToCnyRate ? Number(f.usdToCnyRate) : undefined,
        descText: f.descText,
        credentials,
      });
      setFlash({
        tone: r.check?.ok === false ? 'crit' : 'ok',
        text:
          r.check?.ok === false
            ? `已添加，但测试没通过：${r.check.message}`
            : `已添加并测试通过。${r.check?.message ?? ''}`,
      });
      setAdding(null);
      setF({});
      await load();
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
  };

  const set = (k: string) => ({
    value: f[k] ?? '',
    onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }),
  });

  return (
    <>
      <Unit>
        <PanelBar title="支付通道" meta="用户结算页和充值页看到的付款方式">
          <div className="spacer" />
          <div className="btnrow">
            {specs.map((s) => (
              <button
                key={s.driver}
                className={`btn btn--sm ${adding === s.driver ? 'btn--key' : ''}`}
                onClick={() => pick(s.driver)}
              >
                + {s.label}
              </button>
            ))}
          </div>
        </PanelBar>
        <div className="panelbody">
          <Notice tone="info">
            商户密钥加密存储，页面上只显示脱敏摘要。回调地址会自动用 .env 里的
            PUBLIC_BASE_URL 拼出来 —— 那个值填错的话，用户付了钱订单不会变成已支付。
          </Notice>
          {flash && (
            <div style={{ marginTop: 14 }}>
              <Notice tone={flash.tone === 'warn' ? 'warn' : flash.tone}>{flash.text}</Notice>
            </div>
          )}
        </div>
      </Unit>

      {spec && (
        <Unit>
          <PanelBar title={`添加${spec.label}`} meta={spec.hint} />
          <div className="panelbody">
            <div className="grid2">
              <div className="field">
                <label className="label">通道代码（英文，唯一）</label>
                <input className="input" spellCheck={false} {...set('code')} />
                <span className="hint">内部用，用户看不到。同一种驱动配多个通道时靠它区分。</span>
              </div>
              <div className="field">
                <label className="label">显示名（用户看得到）</label>
                <input className="input" {...set('name')} />
              </div>

              {spec.credentialFields.map((cf) => (
                <div className="field" key={cf.key}>
                  <label className="label">
                    {cf.label}
                    {!cf.required && <span className="silk">（选填）</span>}
                  </label>
                  <input
                    className="input"
                    type={cf.type === 'password' ? 'password' : 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    {...set(cf.key)}
                  />
                  {cf.hint && <span className="hint">{cf.hint}</span>}
                </div>
              ))}

              {spec.needsWayCode && (
                <div className="field">
                  <label className="label">支付方式</label>
                  <input className="input" spellCheck={false} {...set('wayCode')} />
                  <span className="hint">{spec.wayCodeHint}</span>
                </div>
              )}

              {spec.needsRate && (
                <div className="field">
                  <label className="label">汇率（1 USDT = 多少人民币）</label>
                  <input className="input" type="number" step="0.01" placeholder="7.25" {...set('usdToCnyRate')} />
                  <span className="hint">
                    人民币计价的订单靠它算该收多少币。汇率变了记得回来改，
                    这个值只影响新发起的付款，已经在等待的不会变。
                  </span>
                </div>
              )}
            </div>

            <div className="field">
              <label className="label">给用户的说明（可空）</label>
              <textarea
                className="textarea"
                style={{ minHeight: 80 }}
                placeholder={
                  spec.driver === 'manual'
                    ? '收款账号、户名、转账后如何联系客服'
                    : '会显示在支付方式下面的一行小字'
                }
                {...set('descText')}
              />
            </div>

            <div className="btnrow">
              <button className="btn btn--key" onClick={create}>添加并测试</button>
              <button className="btn" onClick={() => setAdding(null)}>取消</button>
            </div>
          </div>
        </Unit>
      )}

      {rows?.length === 0 && (
        <Unit>
          <div className="panelbody">
            <Notice tone="warn">
              还没有配置支付方式。没有支付方式用户下了单也付不了钱。
              最省事的是先加一个「线下转账」，把收款账号写在说明里，
              收到款后到订单页点「标记已付」。
            </Notice>
          </div>
        </Unit>
      )}

      {rows?.map((c) => (
        <Unit key={c.id}>
          <div className="panelbody">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <div className="title" style={{ fontSize: 16 }}>{c.name}</div>
                <div className="silk" style={{ fontSize: 10, marginTop: 4 }}>
                  {c.code} · {c.driver}
                  {c.wayCode ? ` · ${c.wayCode}` : ''}
                  {c.settleCurrency ? ` · 以 ${c.settleCurrency} 结算` : ''}
                  {c.usdToCnyRate ? ` · 1 USDT ≈ ${c.usdToCnyRate} 元` : ''}
                </div>
              </div>
              <Badge tone={c.isEnabled ? 'ok' : 'mute'}>{c.isEnabled ? '已启用' : '已停用'}</Badge>
            </div>

            <div className="well" style={{ marginTop: 14 }}>
              <div className="readout">
                {Object.entries(c.credentialSummary).map(([k, v]) => (
                  <div key={k}>
                    <div className="ro-k">{k}</div>
                    <div className="data" style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="btnrow" style={{ marginTop: 14 }}>
              <button
                className="btn btn--sm"
                onClick={async () => {
                  setFlash({ tone: 'warn', text: '正在测试…' });
                  try {
                    const r = await api.post<any>(`/api/admin/pay-channels/${c.id}/verify`);
                    const extra = r.detail
                      ? '　' + Object.entries(r.detail).map(([k, v]) => `${k}：${v}`).join('，')
                      : '';
                    setFlash({ tone: r.ok ? 'ok' : 'crit', text: r.message + extra });
                  } catch (e: any) {
                    setFlash({ tone: 'crit', text: e.message });
                  }
                }}
              >
                测试
              </button>
              <button
                className="btn btn--sm"
                onClick={async () => {
                  await api.patch(`/api/admin/pay-channels/${c.id}`, { isEnabled: !c.isEnabled });
                  await load();
                }}
              >
                {c.isEnabled ? '停用' : '启用'}
              </button>
              <button
                className="btn btn--sm btn--danger"
                onClick={async () => {
                  try {
                    const r = await api.del<any>(`/api/admin/pay-channels/${c.id}`);
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
