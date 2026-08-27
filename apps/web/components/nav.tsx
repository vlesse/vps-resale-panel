'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, getToken, setToken, type Me } from '@/lib/api';
import { Unit, Vent } from './rack';

/**
 * 顶部铭牌。
 *
 * 登录状态在客户端判断（令牌在 localStorage），所以首屏会有一瞬间
 * 不知道用户是谁。这里用一个占位宽度顶住，避免导航条抖一下。
 */
export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!getToken()) {
      setLoaded(true);
      return;
    }
    api
      .get<Me>('/api/auth/me')
      .then((m) => alive && setMe(m))
      .catch(() => {
        // 令牌失效，api 层已经清掉了，这里不用再处理
      })
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [pathname]);

  const logout = () => {
    setToken(null);
    setMe(null);
    router.push('/');
    router.refresh();
  };

  const link = (href: string, label: string) => (
    <Link key={href} href={href} className="navlink" data-active={pathname === href || pathname.startsWith(href + '/')}>
      {label}
    </Link>
  );

  return (
    <Unit>
      <div className="navbar">
        <Link href="/" style={{ textDecoration: 'none' }}>
          <span className="brand-mark">
            RENREN<em>YINGS</em>
          </span>
        </Link>

        <nav className="navlinks">
          {link('/', '选购')}
          {me && link('/dashboard', '我的机器')}
          {me && link('/orders', '订单')}
          {me?.role === 'admin' && link('/admin', '后台')}
        </nav>

        <Vent />

        <div className="navlinks" style={{ minWidth: loaded ? undefined : 120 }}>
          {!loaded ? null : me ? (
            <>
              <Link href="/profile" className="navlink" title={me.email}>
                {me.displayName || me.email.split('@')[0]}
              </Link>
              <button className="btn btn--sm" onClick={logout} type="button">
                退出
              </button>
            </>
          ) : (
            <>
              {link('/login', '登录')}
              <Link href="/register" className="btn btn--sm btn--key">
                注册
              </Link>
            </>
          )}
        </div>
      </div>
    </Unit>
  );
}
