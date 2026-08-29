'use client';

import { useMemo, useState } from 'react';
import { money, priceCustomLocal, type CustomOffer } from '@/lib/api';

/**
 * 自定义配置器。
 *
 * 这里算出来的价格只是给人看的即时反馈，下单时服务端会照同一套系数重算一遍。
 * 两边都算是有意的：前端不算，用户拉滑块看不到价格，就不敢下单；
 * 前端算了就信，改个数字能一块钱买十六核。
 */
export function CustomBuilder({
  offer,
  currency,
  busy,
  onBuy,
}: {
  offer: CustomOffer;
  currency: 'CNY' | 'USD';
  busy: boolean;
  onBuy: (spec: { cpu: number; memoryMb: number; diskGb: number }) => void;
}) {
  const [cpu, setCpu] = useState(offer.defaults.cpu);
  const [memoryMb, setMemoryMb] = useState(offer.defaults.memoryMb);
  const [diskGb, setDiskGb] = useState(offer.defaults.diskGb);

  const memRange = useMemo(
    () => offer.cpuOptions.find((o) => o.cpu === cpu)?.memory ?? offer.cpuOptions[0].memory,
    [offer, cpu],
  );

  // 内存的可选档位跟着核心数变 —— 谷歌云限制每核 0.5 到 8 GB
  const memChoices = useMemo(() => {
    const out: number[] = [];
    for (let gb = memRange.minGb; gb <= memRange.maxGb + 0.001; gb += memRange.stepGb) {
      out.push(Math.round(gb * 1024));
    }
    return out;
  }, [memRange]);

  const diskChoices = useMemo(() => {
    const out: number[] = [];
    for (let g = offer.disk.minGb; g <= offer.disk.maxGb; g += offer.disk.stepGb) out.push(g);
    return out;
  }, [offer.disk]);

  // 换了核心数之后，原来选的内存可能就越界了，夹回合法范围
  const pickCpu = (n: number) => {
    setCpu(n);
    const r = offer.cpuOptions.find((o) => o.cpu === n)?.memory;
    if (!r) return;
    const gb = memoryMb / 1024;
    if (gb < r.minGb) setMemoryMb(Math.round(r.minGb * 1024));
    else if (gb > r.maxGb) setMemoryMb(Math.round(r.maxGb * 1024));
  };

  const spec = { cpu, memoryMb, diskGb };
  const cents = priceCustomLocal(offer, spec, currency);

  return (
    <div className="builder">
      <div className="builder-grid">
        <Choice
          label="核心数"
          value={cpu}
          options={offer.cpuOptions.map((o) => ({ v: o.cpu, t: `${o.cpu} 核` }))}
          onPick={(v) => pickCpu(v)}
        />
        <Choice
          label="内存"
          value={memoryMb}
          options={memChoices.map((mb) => ({ v: mb, t: `${mb / 1024} GB` }))}
          onPick={setMemoryMb}
        />
        <Choice
          label="硬盘"
          value={diskGb}
          options={diskChoices.map((g) => ({ v: g, t: `${g} GB` }))}
          onPick={setDiskGb}
        />
      </div>

      <div className="builder-foot">
        <div>
          <div className="silk">合计</div>
          <div className="price-plate" style={{ marginTop: 4 }}>
            <span className="price-amt">{cents == null ? '—' : money(cents, currency)}</span>
            <span className="price-cyc">每月</span>
          </div>
        </div>
        <button
          type="button"
          className="btn btn--key"
          disabled={busy || cents == null}
          onClick={() => onBuy(spec)}
        >
          {busy ? '处理中…' : '按这个配置开通'}
        </button>
      </div>

      <p className="hint" style={{ marginTop: 12 }}>
        内存的可选范围跟着核心数变 —— {cpu} 核可以配 {memRange.minGb} 到 {memRange.maxGb} GB。
        这是云厂商对自定义机型的硬性限制，不是我们设的。
      </p>
    </div>
  );
}

/**
 * 少量选项用方块，一眼看全、一下点中；
 * 选项一多（内存能有十几档、硬盘十六档）就改用下拉框 ——
 * 三十几个方块铺满半屏，既难看也难选。
 */
function Choice<T extends number>({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: T;
  options: { v: T; t: string }[];
  onPick: (v: T) => void;
}) {
  return (
    <div>
      <div className="label">{label}</div>
      {options.length <= 6 ? (
        <div className="chips">
          {options.map((o) => (
            <button
              key={o.v}
              type="button"
              className="chip"
              data-on={o.v === value}
              onClick={() => onPick(o.v)}
            >
              {o.t}
            </button>
          ))}
        </div>
      ) : (
        <select
          className="select"
          value={value}
          onChange={(e) => onPick(Number(e.target.value) as T)}
        >
          {options.map((o) => (
            <option key={o.v} value={o.v}>
              {o.t}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
