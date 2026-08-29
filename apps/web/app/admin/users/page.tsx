'use client';

import { useEffect, useState } from 'react';
import { api, formatDate } from '@/lib/api';
import { Notice, PanelBar, Unit } from '@/components/ui';

export default function AdminUsers() {
  const [data, setData] = useState<any>(null);
  const [keyword, setKeyword] = useState('');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'crit'; text: string } | null>(null);

  const load = (k = keyword) => {
    const q = new URLSearchParams({ pageSize: '50' });
    if (k) q.set('keyword', k);
    api
      .get(`/api/admin/users?${q}`)
      .then(setData)
      .catch((e) => setFlash({ tone: 'crit', text: `读取用户失败：${e.message}` }));
  };

  useEffect(() => {
    void load();
  }, []);

  const patch = async (id: string, body: any) => {
    setFlash(null);
    try {
      await api.patch(`/api/admin/users/${id}`, body);
      setFlash({ tone: 'ok', text: '已保存' });
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
    load();
  };

  return (
    <>
      <Unit>
        <PanelBar title="用户" meta={data ? `共 ${data.total} 人` : undefined} />
        <div className="panelbody">
          <div className="row">
            <input
              className="input"
              style={{ maxWidth: 260 }}
              placeholder="邮箱或昵称"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
            />
            <button className="btn btn--sm" onClick={() => load()}>查询</button>
          </div>
          {flash && (
            <div style={{ marginTop: 14 }}>
              <Notice tone={flash.tone}>{flash.text}</Notice>
            </div>
          )}
        </div>
      </Unit>

      <Unit>
        <div className="panelbody">
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>邮箱</th>
                  <th>昵称</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th className="num r">订单</th>
                  <th className="num r">机器</th>
                  <th className="num r">机器上限</th>
                  <th>最近登录</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {(data?.rows ?? []).map((u: any) => (
                  <tr key={u.id}>
                    <td style={{ fontSize: 12.5 }}>{u.email}</td>
                    <td>{u.displayName ?? '—'}</td>
                    <td>
                      <span className="badge" data-tone={u.role === 'admin' ? 'info' : 'mute'}>
                        {u.role === 'admin' ? '管理员' : '客户'}
                      </span>
                    </td>
                    <td>
                      <span className="badge" data-tone={u.status === 'active' ? 'ok' : 'crit'}>
                        {u.status === 'active' ? '正常' : '已停用'}
                      </span>
                    </td>
                    <td className="num r">{u.orderCount}</td>
                    <td className="num r">{u.serviceCount}</td>
                    <td className="num r">{u.maxActiveServices || '默认'}</td>
                    <td className="num" style={{ fontSize: 11.5 }}>{formatDate(u.lastLoginAt)}</td>
                    <td>
                      <div className="btnrow">
                        <button
                          className="btn btn--sm"
                          onClick={() =>
                            patch(u.id, { status: u.status === 'active' ? 'blocked' : 'active' })
                          }
                        >
                          {u.status === 'active' ? '停用' : '恢复'}
                        </button>
                        <button
                          className="btn btn--sm"
                          onClick={() => {
                            const n = window.prompt(
                              `把 ${u.email} 能同时持有的机器数上限改成？（填 0 表示用全局默认值）`,
                              String(u.maxActiveServices),
                            );
                            if (n !== null) patch(u.id, { maxActiveServices: Number(n) || 0 });
                          }}
                        >
                          改上限
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ marginTop: 14 }}>
            「机器数上限」是防刷单闸门。「下单即开」每一单都会在你的云账号上真的建出一台
            开始计费的机器，所以这个值不要设得太大。填 0 表示用 .env 里的全局默认值。
          </p>
        </div>
      </Unit>
    </>
  );
}
