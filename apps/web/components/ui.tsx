import type { ReactNode } from 'react';

/**
 * 藕荷视觉语言的基础件。
 * 页面只拼这些积木，不各自写样式，否则十几个页面很快就长歪了。
 */

/** 一张卡片。整站每一块内容都装在这里面。 */
export function Unit({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={`unit ${className ?? ''}`}>
      <div className="face">{children}</div>
    </section>
  );
}

/** 卡片顶部那条横条 */
export function PanelBar({
  title,
  meta,
  children,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="panelbar">
      {(title || meta) && (
        <div style={{ minWidth: 0 }}>
          {title && <h2 className="title">{title}</h2>}
          {meta && (
            <div className="data" style={{ fontSize: 12, color: 'var(--muted)' }}>
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
  run: 'var(--ok)',
  io: 'var(--warn)',
  net: 'var(--info)',
  err: 'var(--crit)',
};

/** 状态点。blink 的会缓慢呼吸，用来表示「一直在动」的东西。 */
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
          <span className="data" style={{ color: 'var(--ink-2)', letterSpacing: 0 }}>
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

/**
 * 撑开件。旧方案里这里是一排散热孔，藕荷方案不做拟物装饰，
 * 只保留它「把两边推开」的排版作用。
 */
export function Vent() {
  return <span className="spacer" aria-hidden="true" />;
}

/**
 * 负载弧。
 *
 * 旧方案是一块动圈仪表（黑面板、琥珀指针、过冲回摆），那是拟物语言里的东西。
 * 藕荷方案不装硬件：一道底弧加一道主色弧，中间把数字直接写出来。
 * 弧长用 stroke-dasharray 控制，所以它会平滑地长过去。
 */
export function Gauge({ value, max = 4 }: { value?: number; max?: number }) {
  const v = Math.max(0, Math.min(max, value ?? 0));
  const pct = max > 0 ? v / max : 0;
  // 半径 46 的半圆，弧长 = π × 46
  const LEN = Math.PI * 46;
  const tone = pct >= 0.9 ? 'var(--crit)' : pct >= 0.75 ? 'var(--warn)' : 'var(--accent)';

  return (
    <svg viewBox="0 0 120 72" width="120" height="72" role="img" aria-label={`系统负载 ${v}，满量程 ${max}`}>
      <path
        d="M14,60 A46,46 0 0 1 106,60"
        fill="none"
        stroke="var(--hairline-2)"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <path
        d="M14,60 A46,46 0 0 1 106,60"
        fill="none"
        stroke={tone}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={LEN}
        strokeDashoffset={LEN * (1 - pct)}
        style={{ transition: 'stroke-dashoffset 1.1s cubic-bezier(.22,.68,.3,1)' }}
      />
      <text
        x="60"
        y="56"
        textAnchor="middle"
        fill="var(--ink)"
        style={{
          fontFamily: 'var(--f-serif)',
          fontWeight: 600,
          fontSize: 22,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {v.toFixed(2)}
      </text>
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
          <linearGradient id="g-trace" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g stroke="var(--hairline)" strokeWidth="1">
          <line x1="0" y1="13" x2={W} y2="13" />
          <line x1="0" y1="26" x2={W} y2="26" />
          <line x1="0" y1="39" x2={W} y2="39" />
        </g>
        <path d={area} fill="url(#g-trace)" />
        <path
          d={line}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.6"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
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
