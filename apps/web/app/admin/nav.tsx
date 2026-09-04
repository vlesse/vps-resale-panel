'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, getToken, type Me } from '@/lib/api';
import { Notice, PanelBar, Unit } from '@/components/ui';

const TABS = [
  ['/admin', '总览'],
  ['/admin/cloud-accounts', '云账号'],
  ['/admin/plans', '套餐'],
  ['/admin/machines', '机器'],
  ['/admin/services', '已交付'],
  ['/admin/nat', 'NAT 入口'],
  ['/admin/orders', '订单'],
  ['/admin/recharges', '充值'],
  ['/admin/pay-channels', '支付'],
  ['/admin/users', '用户'],
] as const;

export function AdminNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.push('/login?next=/admin');
      return;
    }
    api
      .get<Me>('/api/auth/me')
      .then((m) => {
        if (m.role !== 'admin') setDenied(true);
      })
      .catch(() => router.push('/login?next=/admin'));
  }, [router]);

  if (denied) {
    return (
      <Unit>
        <div className="panelbody">
          <Notice tone="crit">这个页面只有管理员能进。</Notice>
        </div>
      </Unit>
    );
  }

  return (
    <Unit>
      <PanelBar title="管理后台">
        <div className="spacer" />
        <nav className="navlinks">
          {TABS.map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="navlink"
              data-active={href === '/admin' ? pathname === '/admin' : pathname.startsWith(href)}
            >
              {label}
            </Link>
          ))}
        </nav>
      </PanelBar>
    </Unit>
  );
}
