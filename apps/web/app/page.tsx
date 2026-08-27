'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, getToken, money, type PublicPlan } from '@/lib/api';
import { Badge, Notice, Unit, Vent } from '@/components/rack';

const PROVIDER_LOOK: { test: (p: PublicPlan) => boolean; label: string; color: string }[] = [
  { test: (p) => /东京|首尔|大阪|日本|韩国/.test(p.regionLabel), label: '亚洲东北', color: '#8ab7f0' },
  { test: (p) => /新加坡|香港|台湾|东南亚/.test(p.regionLabel), label: '亚洲东南', color: '#f0b46a' },
  { test: (p) => /洛杉矶|美国|硅谷|西雅图/.test(p.regionLabel), label: '北美', color: '#8fd8a8' },
];

function regionTag(p: PublicPlan) {
  const hit = PROVIDER_LOOK.find((x) => x.test(p));
  return hit ?? { label: '全球', color: 'var(--silk)' };
}

export default function Home() {
  const router = useRouter();
  const [plans, setPlans] = useState<PublicPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currency, setCurrency] = useState<'CNY' | 'USD'>('CNY');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api
      .publicGet<PublicPlan[]>('/api/plans')
      .then(setPlans)
      .catch((e) => setError(e.message));
  }, []);

  const buy = async (plan: PublicPlan) => {
    if (!getToken()) {
      router.push(`/login?next=${encodeURIComponent('/')}`);
      return;
    }
    setBusy(plan.id);
    try {
      const res = await api.post<{ orderNo: string }>('/api/orders', {
        planId: plan.id,
        currency,
      });
      router.push(`/pay/${res.orderNo}`);
    } catch (e: any) {
      setError(e.message);
      setBusy(null);
    }
  };

  return (
    <>
      <Unit>
        <div className="panelbody" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <h1 className="title" style={{ fontSize: 30, lineHeight: 1.25 }}>
              云服务器，交付到分钟
            </h1>
            <p style={{ marginTop: 10, marginBottom: 0, maxWidth: '62ch' }}>
              机器在东京、新加坡和洛杉矶的机房里跑。付款之后系统自动开通、装好系统、开启 BBR，
              把 IP 和密码直接给你。开关机、重启、改密、重装都在你自己的控制台上点，不用发工单等人。
            </p>
          </div>
          <Vent />
          <div className="btnrow" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <span className="silk" style={{ marginBottom: 6 }}>结算币种</span>
            <div className="btnrow">
              {(['CNY', 'USD'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`btn btn--sm ${currency === c ? 'btn--key' : ''}`}
                  onClick={() => setCurrency(c)}
                >
                  {c === 'CNY' ? '人民币' : '美元'}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Unit>

      {error && (
        <Unit>
          <div className="panelbody">
            <Notice tone="crit">{error}</Notice>
          </div>
        </Unit>
      )}

      {plans === null && !error && (
        <Unit>
          <div className="panelbody">
            <span className="spin" /> <span className="muted" style={{ marginLeft: 8 }}>正在读取机型…</span>
          </div>
        </Unit>
      )}

      {plans?.length === 0 && (
        <Unit>
          <div className="panelbody">
            <Notice tone="info">
              还没有上架任何机型。如果你是管理员，去后台「套餐」里建一个。
            </Notice>
          </div>
        </Unit>
      )}

      {plans?.map((p) => {
        const price = p.prices.find((x) => x.currency === currency && x.cycle === 'monthly');
        const tag = regionTag(p);
        const stock = p.availability;
        return (
          <Unit key={p.id}>
            <div
              className="panelbody"
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto minmax(0,1fr) auto auto',
                gap: 20,
                alignItems: 'center',
              }}
            >
              <span className="badge" style={{ color: tag.color }}>
                {tag.label}
              </span>

              <div style={{ minWidth: 0 }}>
                <div className="title" style={{ fontSize: 17 }}>
                  {p.name}
                </div>
                <div className="data" style={{ fontSize: 11.5, color: 'var(--silk-dim)', marginTop: 2 }}>
                  {p.cpu} vCPU · {(p.memoryMb / 1024).toFixed(p.memoryMb % 1024 ? 1 : 0)} GB ·{' '}
                  {p.diskGb} GB SSD
                  {p.trafficGb ? ` · ${p.trafficGb >= 1000 ? p.trafficGb / 1000 + ' TB' : p.trafficGb + ' GB'}/月` : ''}
                  {' · '}
                  {p.regionLabel}
                </div>
                {p.features?.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
                    {p.features.slice(0, 4).map((f) => (
                      <span key={f} className="silk" style={{ fontSize: 9.5, opacity: 0.85 }}>
                        {f}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="price-plate">
                <div className="price-amt">{price ? money(price.priceCents, currency) : '—'}</div>
                <div className="price-cyc">每月</div>
              </div>

              <div style={{ textAlign: 'right' }}>
                <button
                  type="button"
                  className="btn btn--key"
                  disabled={!stock.inStock || !price || busy === p.id}
                  onClick={() => buy(p)}
                >
                  {busy === p.id ? '处理中…' : stock.inStock ? '立即开通' : '暂时缺货'}
                </button>
                <div style={{ marginTop: 6 }}>
                  <span
                    className="silk"
                    style={{
                      fontSize: 10,
                      color: stock.inStock
                        ? stock.stockCount != null && stock.stockCount <= 5
                          ? 'var(--warn)'
                          : 'var(--ok)'
                        : 'var(--silk-dim)',
                    }}
                  >
                    ● {stock.label}
                  </span>
                </div>
              </div>
            </div>
          </Unit>
        );
      })}

      {plans && plans.length > 0 && (
        <Unit>
          <div className="panelbody">
            <div className="grid2">
              <div>
                <h3 className="title">开通之后你能做什么</h3>
                <p style={{ marginTop: 8, marginBottom: 0 }}>
                  控制台上直接开关机、重启、重置 root 密码、重装系统，
                  和在云厂商自己的控制台里操作是同一套动作，不用等客服。
                </p>
              </div>
              <div>
                <h3 className="title">关于重装</h3>
                <p style={{ marginTop: 8, marginBottom: 0 }}>
                  重装会清空整块系统盘且无法恢复，做之前请先把数据拷走。
                  开通时分配的是固定 IP，重装之后 IP 不变。
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 18 }}>
              <Badge tone="ok">BBR 已预装</Badge>
              <Badge tone="mute">Debian 12</Badge>
              <Badge tone="mute">独立公网 IPv4</Badge>
              <Badge tone="mute">SSH 直连 root</Badge>
            </div>
          </div>
        </Unit>
      )}
    </>
  );
}
