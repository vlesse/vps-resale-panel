'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  BACKUP_GUIDE_URL,
  LIFESPAN_MAX_MONTHS,
  LIFESPAN_MIN_MONTHS,
  NOTICE_VERSION,
  REMIND_AFTER_DAYS,
  SUPPORT_EMAIL,
  telegramLink,
} from '@/lib/site-notice';

const KEY = 'site-notice-ack';

interface Ack {
  v: number;
  /** 上次点「知道了」的时间戳 */
  t: number;
}

/** 读上次的确认记录。读不到、读坏了都当没读过 —— 多弹一次比漏弹一次好。 */
function readAck(): Ack | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const a = JSON.parse(raw) as Ack;
    return typeof a?.v === 'number' && typeof a?.t === 'number' ? a : null;
  } catch {
    // 无痕窗口、或者浏览器禁了站点数据，getItem 本身会抛
    return null;
  }
}

/**
 * 开站提示。
 *
 * 说的是一件用户不看会真的丢数据的事：这里的机器有寿命，到期连数据一起清空。
 * 所以它不是营销弹窗，几条设计上的取舍都是围着「确保看见」来的：
 *
 * - **不在服务端渲染**。要读 localStorage 才知道该不该弹，服务端渲染出来
 *   再在客户端撤掉，会先闪一下。这里先渲染空，挂载后再决定。
 * - **点过之后隔一段时间还会再弹**（默认七天）。只说一次的警告等于没说 ——
 *   用户三个月后早忘干净了，而机器恰好就是那时候到期。
 * - **文案改了会重新弹给所有人**，靠 NOTICE_VERSION 控制。
 * - **Esc 能关，点背景也能关**，但不自动消失 —— 得让人做一个动作。
 */
export function SiteNotice() {
  const [open, setOpen] = useState(false);
  const tg = telegramLink();

  useEffect(() => {
    const ack = readAck();
    if (!ack || ack.v !== NOTICE_VERSION) {
      setOpen(true);
      return;
    }
    if (REMIND_AFTER_DAYS > 0) {
      const due = ack.t + REMIND_AFTER_DAYS * 86400_000;
      if (Date.now() >= due) setOpen(true);
    }
  }, []);

  // 开着的时候锁掉背景滚动，并让 Esc 能关
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => {
    setOpen(false);
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ v: NOTICE_VERSION, t: Date.now() }));
    } catch {
      // 存不下就存不下，下次再弹一遍而已，不值得为它报错
    }
  };

  if (!open) return null;

  return (
    <div className="modalwrap" role="presentation" onClick={close}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="site-notice-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2 className="modal__title" id="site-notice-title">
            买之前请先看这一条
          </h2>
        </div>

        <div className="modal__body">
          {/* 先说后果，再说原因。用户不关心我们的进货周期，
              他关心的是「我的东西会不会没」。 */}
          <p className="modal__lead">
            本站的机器跑在有使用期限的云资源上，
            <strong>
              每台最短 {LIFESPAN_MIN_MONTHS} 个月、最长 {LIFESPAN_MAX_MONTHS} 个多月就会到期重置
            </strong>
            。到期时机器和上面的数据会一并清空，<strong>无法恢复</strong>。
          </p>

          <p>
            你自己那台的准确到期时间，登录后在「
            <Link href="/dashboard" className="modal__link" onClick={close}>
              我的机器
            </Link>
            」里能看到，以那个为准。
          </p>

          <div className="modal__key">
            <div className="modal__keytitle">所以请务必自己做好备份</div>
            <p>
              别把唯一一份数据放在这里。设置一次自动备份大约十分钟，
              到期那天你只要重新买一台、把数据倒回去就行。
            </p>
            <Link href={BACKUP_GUIDE_URL} className="btn btn--key btn--sm" onClick={close}>
              查看备份操作手册
            </Link>
          </div>

          <p className="modal__contact">
            需要<strong>大容量、长期稳定或者批量采购</strong>的，直接联系站长 ——
            价格可以谈，也免费提供技术支持。
            <br />
            邮箱{' '}
            <a className="modal__link" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>
            {tg && (
              <>
                　·　Telegram{' '}
                <a className="modal__link" href={tg.href} target="_blank" rel="noopener noreferrer">
                  {tg.label}
                </a>
              </>
            )}
          </p>
        </div>

        <div className="modal__foot">
          <button className="btn btn--key" onClick={close} autoFocus>
            我知道了
          </button>
          <span className="hint" style={{ margin: 0 }}>
            这条提示随后还会再出现一次，提醒你检查备份。
          </span>
        </div>
      </div>
    </div>
  );
}
