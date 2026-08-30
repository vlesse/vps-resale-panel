'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * 二维码。
 *
 * 渲染成 SVG 字符串再塞进 DOM，不用 canvas ——
 * canvas 在高分屏上要自己处理 devicePixelRatio，忘了就是一片糊，
 * 而付款码糊了用户是真扫不出来的。
 *
 * 纠错等级用 M：付款码通常显示在屏幕上，不像贴纸会被磨损，
 * 用 H 只会让码变密、更难扫。
 */
export function Qr({ value, size = 200 }: { value: string; size?: number }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    QRCode.toString(value, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: size,
      color: { dark: '#3b3340', light: '#ffffff' },
    })
      .then((s) => alive && setSvg(s))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [value, size]);

  if (failed) {
    // 生成不出来也不能让付款流程断掉 —— 下面本来就有可复制的原文
    return <div className="hint">二维码生成失败，请复制下面的内容手动付款。</div>;
  }
  if (!svg) return <div style={{ width: size, height: size }} />;

  return (
    <div
      style={{
        width: size,
        height: size,
        background: '#fff',
        borderRadius: 6,
        padding: 8,
        boxSizing: 'content-box',
      }}
      // qrcode 生成的是我们自己拼出来的 SVG，不含外部内容
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
