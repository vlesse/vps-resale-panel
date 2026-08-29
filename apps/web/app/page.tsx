'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, getToken, money, type PublicPlan } from '@/lib/api';
import { Notice, Unit } from '@/components/ui';

/**
 * 交付过程。
 *
 * 这里写的是**典型耗时**，不是某一笔真实订单的回执 ——
 * 首页上摆一张带订单号和 IP 的「回执」，等于把编出来的记录当真事展示。
 * 等你手上有了足够的真实数据，把这几个数字换成实际统计值。
 */
const FLOW: { at: string; what: string; note: string }[] = [
  { at: '00:00', what: '订单创建', note: '选好机型下单' },
  { at: '00:10', what: '收到付款', note: '支付渠道回调' },
  { at: '00:15', what: '向云厂商提交创建', note: '谷歌云 / Lightsail' },
  { at: '01:00', what: '系统就绪，BBR 已开启', note: '首次启动脚本跑完' },
  { at: '01:10', what: '已交付，SSH 可连接', note: '地址和密码进控制台' },
];

const CAPS: { n: string; h: string; p: string }[] = [
  {
    n: '01',
    h: '固定公网 IP',
    p: '重装系统不会换 IP。云厂商本身没有「重装」这个功能，真实做法是删旧建新，没有固定 IP 就每次都变。',
  },
  {
    n: '02',
    h: '自助重装与改密',
    p: '控制台上点一下就重装，交还一台干净的机器。忘记密码自己重置，不用等人工。',
  },
  {
    n: '03',
    h: '实时资源读数',
    p: 'CPU、内存、磁盘、本月流量都在控制台里更新，不用自己装监控。',
  },
  {
    n: '04',
    h: '到期只挂起，不删数据',
    p: '忘记续费不会丢数据。机器会关机保留，续费之后原样恢复。',
  },
];

function gb(mb: number) {
  return `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB`;
}

function traffic(gbValue?: number | null) {
  if (!gbValue) return '—';
  return gbValue >= 1000 ? `${gbValue / 1000} TB` : `${gbValue} GB`;
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

  // 首屏那几个数字全部从真实套餐算出来，不写死
  const regions = useMemo(
    () => Array.from(new Set((plans ?? []).map((p) => p.regionLabel))),
    [plans],
  );

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
      {/* ---------- 首屏 ---------- */}
      <Unit>
        <div className="hero">
          <div className="hero-copy">
            <div className="silk">{regions.length > 0 ? regions.join(' · ') : '东京 · 新加坡 · 洛杉矶'}</div>

            <h1 className="hero-h1">付款之后，一分钟左右就能 SSH 进去。</h1>

            <p className="hero-deck">
              你下单，系统去谷歌云或 AWS 建机器、装系统、配好网络，把地址和密码交到你手里。
              <em>全程没有人工介入。</em>
            </p>

            <ul className="hero-list">
              <li>
                <i aria-hidden="true" />
                <span>
                  <b>固定公网 IP</b>重装系统也不会变
                </span>
              </li>
              <li>
                <i aria-hidden="true" />
                <span>
                  <b>BBR 已开启</b>拿到手就是调好的
                </span>
              </li>
              <li>
                <i aria-hidden="true" />
                <span>
                  <b>控制台自助</b>开关机 / 改密 / 重装，不用发工单
                </span>
              </li>
            </ul>

            <div className="hero-stats">
              <div>
                <div className="hero-stat-k">{plans ? plans.length : '—'}</div>
                <div className="hero-stat-v">在售机型</div>
              </div>
              <div>
                <div className="hero-stat-k">{plans ? regions.length : '—'}</div>
                <div className="hero-stat-v">可选机房</div>
              </div>
              <div>
                <div className="hero-stat-k">自动</div>
                <div className="hero-stat-v">开通方式</div>
              </div>
            </div>
          </div>

          {/* 交付过程示意。刻意不写订单号和 IP —— 那会变成伪造的记录。 */}
          <div className="flow">
            <div className="flow-head">
              <span className="flow-dot" aria-hidden="true" />
              <span className="silk">典型交付过程</span>
            </div>
            <ol className="flow-steps">
              {FLOW.map((s, i) => (
                <li key={s.at} className={i === FLOW.length - 1 ? 'is-done' : undefined}>
                  <span className="data flow-at">{s.at}</span>
                  <span className="flow-what">{s.what}</span>
                  <span className="data flow-note">{s.note}</span>
                </li>
              ))}
            </ol>
            <div className="flow-foot">
              <span className="hint">
                时间是典型值，实际快慢取决于云厂商当时的响应。开通失败会自动回滚并重试，不会留下计费的半成品。
              </span>
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
            <span className="spin" />{' '}
            <span className="muted" style={{ marginLeft: 8 }}>
              正在读取机型…
            </span>
          </div>
        </Unit>
      )}

      {plans?.length === 0 && (
        <Unit>
          <div className="panelbody">
            <Notice tone="info">还没有上架任何机型。如果你是管理员，去后台「套餐」里建一个。</Notice>
          </div>
        </Unit>
      )}

      {/* ---------- 机型与价格 ---------- */}
      {plans && plans.length > 0 && (
        <Unit>
          <div className="panelbar">
            <div style={{ minWidth: 0 }}>
              <h2 className="title">机型与价格</h2>
              <div className="hint">按月计费。价格含固定公网 IP，不额外收。</div>
            </div>
            <span className="spacer" />
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

          <div className="tablewrap">
            <table className="table plans table--cards">
              <thead>
                <tr>
                  <th>机型</th>
                  <th className="num r">vCPU</th>
                  <th className="num r">内存</th>
                  <th className="num r">硬盘</th>
                  <th className="num r">月流量</th>
                  <th className="num r">价格</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => {
                  const price = p.prices.find((x) => x.currency === currency && x.cycle === 'monthly');
                  const stock = p.availability;
                  const low = stock.stockCount != null && stock.stockCount <= 5;
                  return (
                    <tr key={p.id}>
                      <td>
                        <div className="plan-name">{p.name}</div>
                        <div className="plan-region">{p.regionLabel}</div>
                      </td>
                      <td className="num data r" data-label="vCPU">{p.cpu}</td>
                      <td className="num data r" data-label="内存">{gb(p.memoryMb)}</td>
                      <td className="num data r" data-label="硬盘">{p.diskGb} GB</td>
                      <td className="num data r" data-label="月流量">{traffic(p.trafficGb)}</td>
                      <td className="num r" data-label="价格">
                        {/* 包一层，窄屏上两端对齐时价格和「/月」才不会被拆到两头 */}
                        <span>
                          <span className="plan-price">{price ? money(price.priceCents, currency) : '—'}</span>
                          <span className="plan-cyc"> /月</span>
                        </span>
                      </td>
                      <td className="num r" data-role="action" style={{ whiteSpace: 'nowrap' }}>
                        <button
                          type="button"
                          className="btn btn--sm btn--key"
                          disabled={!stock.inStock || !price || busy === p.id}
                          onClick={() => buy(p)}
                        >
                          {busy === p.id ? '处理中…' : stock.inStock ? '立即开通' : '暂时缺货'}
                        </button>
                        <div
                          className="silk"
                          style={{
                            marginTop: 5,
                            color: stock.inStock ? (low ? 'var(--warn)' : 'var(--ok)') : 'var(--muted)',
                          }}
                        >
                          {stock.label}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Unit>
      )}

      {/* ---------- 你买到的是什么 ---------- */}
      {plans && plans.length > 0 && (
        <Unit>
          <div className="panelbody">
            <div className="caps">
              {CAPS.map((c) => (
                <div key={c.n} className="cap">
                  <span className="data cap-n">{c.n}</span>
                  <div>
                    <h3 className="cap-h">{c.h}</h3>
                    <p className="cap-p">{c.p}</p>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 22 }}>
              <Notice tone="warn">重装会清空整块系统盘且无法恢复，做之前请先把数据拷走。</Notice>
            </div>
          </div>
        </Unit>
      )}
    </>
  );
}
