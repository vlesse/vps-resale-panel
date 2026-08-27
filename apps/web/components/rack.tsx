import type { ReactNode } from 'react';

/**
 * 机架视觉语言的基础件。
 * 页面只拼这些积木，不各自写样式，否则十几个页面很快就长歪了。
 */

/** 一个机架单元：两侧耳片 + 中间面板。整站每一块内容都装在这里面。 */
export function Unit({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={`unit ${className ?? ''}`}>
      <div className="ear ear--l">
        <i className="screw" />
        <i className="screw" />
      </div>
      <div className="face">{children}</div>
      <div className="ear ear--r">
        <i className="screw" />
        <i className="screw" />
      </div>
    </section>
  );
}

/** 面板顶部那条带槽位号的横条 */
export function PanelBar({
  slot,
  title,
  meta,
  children,
}: {
  slot?: string;
  title?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="panelbar">
      {slot && <span className="slotid">{slot}</span>}
      {(title || meta) && (
        <div style={{ minWidth: 0 }}>
          {title && <h2 className="title">{title}</h2>}
          {meta && (
            <div className="data" style={{ fontSize: 12, color: 'var(--silk-dim)' }}>
              {meta}
            </div>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

const LED_COLOR: Record<string, string> = {
  run: 'var(--led-run)',
  io: 'var(--led-io)',
  net: 'var(--led-net)',
  err: 'var(--led-stop)',
};

/**
 * 指示灯。blink 只有 io 和 net 两种，节奏是不规则的 ——
 * 平滑呼吸一眼就能看出是网页假装的硬件。
 */
export function Led({
  kind,
  label,
  on,
  blink,
}: {
  kind: 'run' | 'io' | 'net' | 'err';
  label: string;
  on: boolean;
  blink?: 'io' | 'net';
}) {
  return (
    <div className="ledwrap">
      <span
        className="led"
        data-on={on}
        data-blink={on && blink ? blink : undefined}
        style={{ ['--c' as string]: LED_COLOR[kind] }}
      />
      <span className="silk">{label}</span>
    </div>
  );
}

/** 沉降式读数窗里的一格 */
export function Readout({
  label,
  value,
  unit,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
}) {
  return (
    <div>
      <div className="ro-k">{label}</div>
      <div className="ro-v">
        {value}
        {unit && <small>{unit}</small>}
      </div>
    </div>
  );
}

/** 带阈值变色的进度条：超过 75% 转黄，超过 90% 转红 */
export function Meter({ used, total, label }: { used?: number; total?: number; label?: string }) {
  const pct = used != null && total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const tone = pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : undefined;
  return (
    <div>
      {label && (
        <div className="ro-k">
          {label}{' '}
          <span className="data" style={{ color: 'var(--silk)', letterSpacing: 0 }}>
            {used != null && total ? `${used} / ${total}` : '—'}
          </span>
        </div>
      )}
      <div className="bar">
        <span className="bar-fill" data-tone={tone} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Badge({
  tone,
  children,
}: {
  tone?: 'ok' | 'warn' | 'crit' | 'info' | 'mute';
  children: ReactNode;
}) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function Notice({
  tone,
  children,
}: {
  tone?: 'ok' | 'warn' | 'crit' | 'info';
  children: ReactNode;
}) {
  return (
    <div className="notice" data-tone={tone}>
      {children}
    </div>
  );
}

/** 散热孔。纯装饰，但没有它面板会显得太空。 */
export function Vent() {
  return <div className="plate-vent" aria-hidden="true" />;
}

/**
 * 指针式负载表。
 *
 * 指针会过冲再回落 —— 真实的动圈仪表就是这样，因为指针有惯性。
 * 直接滑到位是电子表的行为，放在拟物界面里会露馅。
 */
export function Gauge({ value, max = 4 }: { value?: number; max?: number }) {
  const v = Math.max(0, Math.min(max, value ?? 0));
  // 表盘从 -84° 扫到 +84°
  const angle = -84 + (v / max) * 168;
  return (
    <svg viewBox="0 0 126 78" width="126" height="78" role="img" aria-label={`系统负载 ${v}，满量程 ${max}`}>
      <path d="M6,70 A57,57 0 0 1 120,70 L120,74 L6,74 Z" fill="#0e1114" stroke="#000" strokeWidth="1" />
      <path d="M96.5,26.5 A52,52 0 0 1 115,66" stroke="var(--crit)" strokeWidth="3" fill="none" opacity="0.75" />
      <g stroke="var(--etch)" strokeWidth="1.8">
        <line x1="14.5" y1="66" x2="20.5" y2="65" />
        <line x1="63" y1="12" x2="63" y2="18" />
        <line x1="111.5" y1="66" x2="105.5" y2="65" />
      </g>
      <g stroke="var(--silk-dim)" strokeWidth="1.3">
        <line x1="24" y1="41" x2="29.5" y2="44" />
        <line x1="41" y1="22" x2="45" y2="27" />
        <line x1="85" y1="22" x2="81" y2="27" />
        <line x1="102" y1="41" x2="96.5" y2="44" />
      </g>
      <line
        x1="63"
        y1="66"
        x2="63"
        y2="21"
        stroke="var(--amber)"
        strokeWidth="2"
        strokeLinecap="round"
        style={{
          transformOrigin: '63px 66px',
          transform: `rotate(${angle}deg)`,
          // 这条缓动带回弹，指针会冲过头再摆回来
          transition: 'transform 1.1s cubic-bezier(.34,1.56,.64,1)',
          filter: 'drop-shadow(0 0 5px var(--amber-glow))',
        }}
      />
      <circle cx="63" cy="66" r="5" fill="#5b6169" stroke="#101316" strokeWidth="1" />
    </svg>
  );
}

/**
 * 走势带。数据点不够时画一条平线并注明，不假装有数据。
 */
export function Trace({
  points,
  caption,
  unit = '%',
}: {
  points: number[];
  caption?: string;
  unit?: string;
}) {
  const W = 460;
  const H = 52;
  if (!points.length) {
    return (
      <div className="hint" style={{ padding: '14px 0' }}>
        暂时没有历史数据{caption ? `（${caption}）` : ''}
      </div>
    );
  }
  const max = Math.max(...points, unit === '%' ? 100 : 1);
  const step = points.length > 1 ? W / (points.length - 1) : W;
  const y = (v: number) => H - 6 - (v / max) * (H - 12);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const last = points[points.length - 1];

  return (
    <div style={{ marginTop: 14 }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: 52 }}>
        <defs>
          <linearGradient id="g-amber" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e8a33d" stopOpacity="0.38" />
            <stop offset="100%" stopColor="#e8a33d" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g stroke="rgba(255,255,255,.045)" strokeWidth="1">
          <line x1="0" y1="13" x2={W} y2="13" />
          <line x1="0" y1="26" x2={W} y2="26" />
          <line x1="0" y1="39" x2={W} y2="39" />
        </g>
        <path d={area} fill="url(#g-amber)" />
        <path
          d={line}
          fill="none"
          stroke="var(--amber)"
          strokeWidth="1.6"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          style={{ filter: 'drop-shadow(0 0 4px var(--amber-glow))' }}
        />
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
        <span className="silk">{caption}</span>
        <span className="silk">
          当前 {last.toFixed(unit === '%' ? 1 : 0)}
          {unit} · 峰值 {max.toFixed(unit === '%' ? 1 : 0)}
          {unit}
        </span>
      </div>
    </div>
  );
}
