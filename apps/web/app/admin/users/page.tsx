'use client';

import { useEffect, useState } from 'react';
import { api, formatDate, money } from '@/lib/api';
import { Notice, PanelBar, Unit } from '@/components/ui';

export default function AdminUsers() {
  const [data, setData] = useState<any>(null);
  const [keyword, setKeyword] = useState('');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'crit'; text: string } | null>(null);
  // 重置出来的新密码只有这一次能看到，所以单独摆一块出来给管理员复制，
  // 不用 alert —— 有些浏览器的弹窗里选不中文字。
  const [reset, setReset] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

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

  const resetPassword = async (u: any, custom?: string) => {
    setFlash(null);
    setReset(null);
    try {
      const r = await api.post<{ password: string; email: string; message: string }>(
        `/api/admin/users/${u.id}/reset-password`,
        custom ? { password: custom } : {},
      );
      setReset({ email: r.email, password: r.password });
      setCopied(false);
      setFlash({ tone: 'ok', text: r.message });
      if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
    load();
  };

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

          {reset && (
            <div className="well" style={{ marginTop: 14 }}>
              <div className="ro-k">{reset.email} 的新密码</div>
              <div
                className="data"
                style={{ fontSize: 19, marginTop: 6, wordBreak: 'break-all', color: 'var(--ink)' }}
              >
                {reset.password}
              </div>
              <div className="btnrow" style={{ marginTop: 12 }}>
                <button
                  className="btn btn--sm btn--key"
                  onClick={() => {
                    void navigator.clipboard?.writeText(reset.password);
                    setCopied(true);
                  }}
                >
                  {copied ? '已复制' : '复制密码'}
                </button>
                <button className="btn btn--sm" onClick={() => setReset(null)}>
                  我记下了，收起
                </button>
              </div>
              <p className="hint" style={{ marginTop: 10 }}>
                这串密码<b>只显示这一次</b> —— 库里存的是哈希，任何接口都读不回来。
                现在就发给他。这个用户在所有设备上的登录都已经失效，要用新密码重新登。
              </p>
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
                  <th className="num r">余额</th>
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
                    <td className="num r">{money(u.balanceCents ?? 0, 'CNY')}</td>
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
                        <button
                          className="btn btn--sm"
                          onClick={async () => {
                            const n = window.prompt(
                              `给 ${u.email} 加多少钱？单位「元」，可以填负数表示扣。
` +
                                `当前余额 ${((u.balanceCents ?? 0) / 100).toFixed(2)}`,
                              '0',
                            );
                            if (n === null || !Number(n)) return;
                            const why = window.prompt('原因（会记进流水，事后对账全靠这一行）', '');
                            if (!why) {
                              setFlash({ tone: 'crit', text: '没写原因，已取消' });
                              return;
                            }
                            try {
                              await api.post(`/api/admin/wallet/users/${u.id}/adjust`, {
                                amountCents: Math.round(Number(n) * 100),
                                remark: why,
                              });
                              setFlash({ tone: 'ok', text: '余额已调整' });
                            } catch (e: any) {
                              setFlash({ tone: 'crit', text: e.message });
                            }
                            load();
                          }}
                        >
                          调余额
                        </button>
                        <button
                          className="btn btn--sm"
                          onClick={() => resetPassword(u)}
                        >
                          重置密码
                        </button>
                        <button
                          className="btn btn--sm"
                          onClick={() => {
                            const p = window.prompt(
                              `给 ${u.email} 指定一个新密码（至少 8 位）。
` +
                                `留空取消。不想自己想密码就用旁边的「重置密码」。`,
                              '',
                            );
                            if (!p) return;
                            if (p.length < 8) {
                              setFlash({ tone: 'crit', text: '密码至少 8 位' });
                              return;
                            }
                            void resetPassword(u, p);
                          }}
                        >
                          改密码
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
