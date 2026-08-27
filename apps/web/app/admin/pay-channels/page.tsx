'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Notice, PanelBar, Unit } from '@/components/rack';

interface Channel {
  id: string;
  code: string;
  name: string;
  driver: string;
  wayCode: string | null;
  settleCurrency: string | null;
  gatewayUrl: string | null;
  rate: number | null;
  isEnabled: boolean;
  descText: string | null;
  credentialSummary: Record<string, string>;
}

export default function PayChannels() {
  const [rows, setRows] = useState<Channel[] | null>(null);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'crit'; text: string } | null>(null);
  const [adding, setAdding] = useState<'jeepay' | 'manual' | null>(null);
  const [f, setF] = useState<any>({});

  const load = () => api.get<Channel[]>('/api/admin/pay-channels').then(setRows).catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    setFlash(null);
    try {
      const body =
        adding === 'manual'
          ? {
              code: f.code || 'manual',
              name: f.name || '线下转账',
              driver: 'manual',
              descText: f.descText,
            }
          : {
              code: f.code || 'jeepay',
              name: f.name || 'Jeepay 聚合支付',
              driver: 'jeepay',
              wayCode: f.wayCode,
              gatewayUrl: f.gatewayUrl,
              settleCurrency: f.settleCurrency || undefined,
              rate: f.rate ? Number(f.rate) : undefined,
              descText: f.descText,
              credentials: {
                gatewayUrl: f.gatewayUrl,
                mchNo: f.mchNo,
                appId: f.appId,
                appSecret: f.appSecret,
              },
            };
      const r = await api.post<any>('/api/admin/pay-channels', body);
      setFlash({
        tone: r.check?.ok === false ? 'crit' : 'ok',
        text: r.check?.ok === false ? `已添加，但测试没通过：${r.check.message}` : '已添加并测试通过',
      });
      setAdding(null);
      setF({});
      await load();
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
  };

  return (
    <>
      <Unit>
        <PanelBar slot="U01" title="支付通道" meta="用户结算页看到的付款方式">
          <div className="spacer" />
          <div className="btnrow">
            <button className={`btn btn--sm ${adding === 'jeepay' ? 'btn--key' : ''}`} onClick={() => setAdding(adding === 'jeepay' ? null : 'jeepay')}>
              + Jeepay
            </button>
            <button className={`btn btn--sm ${adding === 'manual' ? 'btn--key' : ''}`} onClick={() => setAdding(adding === 'manual' ? null : 'manual')}>
              + 线下转账
            </button>
          </div>
        </PanelBar>
        <div className="panelbody">
          <Notice tone="info">
            商户密钥同样加密存储，页面上只显示脱敏摘要。
            回调地址会自动用 .env 里的 PUBLIC_BASE_URL 拼出来 ——
            那个值填错的话，用户付了钱订单不会变成已支付。
          </Notice>
          {flash && (
            <div style={{ marginTop: 14 }}>
              <Notice tone={flash.tone}>{flash.text}</Notice>
            </div>
          )}
        </div>
      </Unit>

      {adding && (
        <Unit>
          <PanelBar slot="U02" title={adding === 'manual' ? '添加线下转账' : '添加 Jeepay 通道'} />
          <div className="panelbody">
            <div className="grid2">
              <div className="field">
                <label className="label">通道代码（英文，唯一）</label>
                <input className="input" value={f.code ?? ''} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder={adding} />
              </div>
              <div className="field">
                <label className="label">显示名（用户看得到）</label>
                <input className="input" value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={adding === 'manual' ? '银行转账' : '扫码支付'} />
              </div>
            </div>

            {adding === 'jeepay' && (
              <div className="grid2">
                <div className="field">
                  <label className="label">网关地址</label>
                  <input className="input" value={f.gatewayUrl ?? ''} onChange={(e) => setF({ ...f, gatewayUrl: e.target.value })} placeholder="https://pay.example.com" spellCheck={false} />
                  <span className="hint">填到域名为止，不要带 /api/pay 这样的路径</span>
                </div>
                <div className="field">
                  <label className="label">商户号 mchNo</label>
                  <input className="input" value={f.mchNo ?? ''} onChange={(e) => setF({ ...f, mchNo: e.target.value })} spellCheck={false} />
                </div>
                <div className="field">
                  <label className="label">应用 ID appId</label>
                  <input className="input" value={f.appId ?? ''} onChange={(e) => setF({ ...f, appId: e.target.value })} spellCheck={false} />
                </div>
                <div className="field">
                  <label className="label">应用密钥 appSecret</label>
                  <input className="input" type="password" value={f.appSecret ?? ''} onChange={(e) => setF({ ...f, appSecret: e.target.value })} spellCheck={false} />
                  <span className="hint">前后不要带空格，很多「签名错误」都是复制时多带了空格</span>
                </div>
                <div className="field">
                  <label className="label">支付方式码 wayCode</label>
                  <input className="input" value={f.wayCode ?? ''} onChange={(e) => setF({ ...f, wayCode: e.target.value })} placeholder="ALI_QR / WX_NATIVE" spellCheck={false} />
                  <span className="hint">问你的 Jeepay 服务商要，不同支付方式码不一样</span>
                </div>
                <div className="field">
                  <label className="label">结算币种（可空）</label>
                  <input className="input" value={f.settleCurrency ?? ''} onChange={(e) => setF({ ...f, settleCurrency: e.target.value })} placeholder="留空表示按订单币种结算" />
                </div>
              </div>
            )}

            <div className="field">
              <label className="label">给用户的说明（可空）</label>
              <textarea
                className="textarea"
                style={{ minHeight: 80 }}
                value={f.descText ?? ''}
                onChange={(e) => setF({ ...f, descText: e.target.value })}
                placeholder={adding === 'manual' ? '收款账号、户名、转账后如何联系客服' : '支持支付宝和微信扫码'}
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
              最简单的是先加一个「线下转账」，把收款账号写在说明里，
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
                </div>
              </div>
              <Badge tone={c.isEnabled ? 'ok' : 'mute'}>{c.isEnabled ? '已启用' : '已停用'}</Badge>
            </div>

            <div className="well" style={{ marginTop: 14 }}>
              <div className="readout">
                {Object.entries(c.credentialSummary).map(([k, v]) => (
                  <div key={k}>
                    <div className="ro-k">{k}</div>
                    <div className="data" style={{ fontSize: 12.5, color: 'var(--silk)' }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="btnrow" style={{ marginTop: 14 }}>
              <button
                className="btn btn--sm"
                onClick={async () => {
                  try {
                    const r = await api.post<any>(`/api/admin/pay-channels/${c.id}/verify`);
                    setFlash({ tone: r.ok ? 'ok' : 'crit', text: r.message });
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
