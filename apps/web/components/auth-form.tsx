'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, setToken, type Me } from '@/lib/api';
import { Notice, Unit } from './ui';

interface Captcha {
  id: string;
  svg: string;
}

/**
 * 登录和注册共用一套表单。
 *
 * 验证码挡的是「拿脚本批量注册再刷单」——每一单都可能在云账号上
 * 建出一台真的在计费的机器，所以这道门不能省。
 */
export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');
  const [captcha, setCaptcha] = useState<Captcha | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshCaptcha = useCallback(() => {
    setCode('');
    api
      .publicGet<Captcha>('/api/captcha')
      .then(setCaptcha)
      .catch(() => setCaptcha(null));
  }, []);

  useEffect(refreshCaptcha, [refreshCaptcha]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        email: email.trim(),
        password,
        captchaId: captcha?.id ?? '',
        captchaCode: code,
        ...(mode === 'register' ? { displayName: displayName.trim() || undefined } : {}),
      };
      const res = await api.publicPost<{ token: string; user: Me }>(
        mode === 'login' ? '/api/auth/login' : '/api/auth/register',
        body,
      );
      setToken(res.token);
      router.push(res.user.role === 'admin' ? '/admin' : next);
      router.refresh();
    } catch (err: any) {
      setError(err.message);
      // 验证码是一次性的，无论对错都作废了，必须换一张
      refreshCaptcha();
      setBusy(false);
    }
  };

  return (
    <Unit className="unit--narrow">
      <div className="panelbody" style={{ padding: '32px 30px' }}>
        <h1 className="title" style={{ fontSize: 22, marginBottom: 4 }}>
          {mode === 'login' ? '登录' : '注册'}
        </h1>
        <p className="hint" style={{ marginTop: 0, marginBottom: 22 }}>
          {mode === 'login' ? '没有账号？' : '已经有账号了？'}{' '}
          <Link href={mode === 'login' ? '/register' : '/login'}>
            {mode === 'login' ? '去注册' : '去登录'}
          </Link>
        </p>

        {error && (
          <div style={{ marginBottom: 16 }}>
            <Notice tone="crit">{error}</Notice>
          </div>
        )}

        <form onSubmit={submit}>
          <div className="field">
            <label className="label" htmlFor="email">邮箱</label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>

          {mode === 'register' && (
            <div className="field">
              <label className="label" htmlFor="name">显示名称（可留空）</label>
              <input
                id="name"
                className="input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="留空就用邮箱前缀"
              />
            </div>
          )}

          <div className="field">
            <label className="label" htmlFor="pw">密码</label>
            <input
              id="pw"
              className="input"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? '至少 8 位' : ''}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="cap">验证码</label>
            <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
              <input
                id="cap"
                className="input"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="看不清点右边换一张"
                style={{ flex: 1 }}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={refreshCaptcha}
                title="换一张"
                style={{
                  border: '1px solid var(--hairline-2)',
                  padding: 0,
                  borderRadius: 3,
                  cursor: 'pointer',
                  background: 'rgba(255,253,254,.8)',
                  width: 124,
                  height: 38,
                  display: 'grid',
                  placeItems: 'center',
                  overflow: 'hidden',
                }}
              >
                {captcha ? (
                  <span
                    aria-label="验证码图片"
                    // 后端返回的是 svg-captcha 生成的 SVG 字符串
                    dangerouslySetInnerHTML={{ __html: captcha.svg }}
                  />
                ) : (
                  <span className="spin" />
                )}
              </button>
            </div>
          </div>

          <button className="btn btn--key" type="submit" disabled={busy} style={{ width: '100%', marginTop: 6 }}>
            {busy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
          </button>
        </form>
      </div>
    </Unit>
  );
}
