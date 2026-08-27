'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, formatDate, getToken, type Me } from '@/lib/api';
import { Notice, PanelBar, Readout, Unit } from '@/components/rack';

export default function Profile() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'crit'; text: string } | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.push('/login?next=/profile');
      return;
    }
    api.get<Me>('/api/auth/me').then((m) => {
      setMe(m);
      setName(m.displayName ?? '');
      setPhone(m.phone ?? '');
    }).catch(() => router.push('/login?next=/profile'));
  }, [router]);

  const saveProfile = async () => {
    setFlash(null);
    try {
      const m = await api.patch<Me>('/api/auth/profile', { displayName: name, phone });
      setMe(m);
      setFlash({ tone: 'ok', text: '资料已保存' });
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
  };

  const changePw = async () => {
    setFlash(null);
    try {
      const r = await api.post<any>('/api/auth/change-password', { oldPassword: oldPw, newPassword: newPw });
      setFlash({ tone: 'ok', text: r.message });
      setOldPw('');
      setNewPw('');
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
  };

  if (!me) return null;

  return (
    <>
      <Unit>
        <PanelBar slot="U01" title="账户" meta={me.email} />
        <div className="panelbody">
          <div className="well">
            <div className="readout">
              <Readout label="账号" value={me.email} />
              <Readout label="身份" value={me.role === 'admin' ? '管理员' : '客户'} />
              <Readout label="机器上限" value={me.maxActiveServices || '按平台默认'} unit={me.maxActiveServices ? '台' : ''} />
              <Readout label="注册时间" value={formatDate(me.createdAt)} />
            </div>
          </div>
          {flash && <div style={{ marginTop: 14 }}><Notice tone={flash.tone}>{flash.text}</Notice></div>}
        </div>
      </Unit>

      <Unit>
        <PanelBar slot="U02" title="资料" />
        <div className="panelbody">
          <div className="grid2">
            <div className="field">
              <label className="label">显示名称</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">手机号（可空）</label>
              <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
          <button className="btn btn--key" onClick={saveProfile}>保存</button>
        </div>
      </Unit>

      <Unit>
        <PanelBar slot="U03" title="修改密码" />
        <div className="panelbody">
          <div className="grid2">
            <div className="field">
              <label className="label">当前密码</label>
              <input className="input" type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} autoComplete="current-password" />
            </div>
            <div className="field">
              <label className="label">新密码（至少 8 位）</label>
              <input className="input" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" />
            </div>
          </div>
          <button className="btn btn--key" onClick={changePw} disabled={!oldPw || newPw.length < 8}>修改密码</button>
          <p className="hint" style={{ marginTop: 12 }}>
            这里改的是你登录面板的密码，和机器上的 root 密码是两回事。
            机器密码在控制台页面上重置。
          </p>
        </div>
      </Unit>
    </>
  );
}
