'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  api,
  formatBytes,
  formatDate,
  formatDay,
  formatUptime,
  getToken,
  POWER_LABEL,
  SERVICE_STATUS,
  type ServiceDetail,
} from '@/lib/api';
import { Gauge, Led, Meter, Notice, PanelBar, Readout, Trace, Unit } from '@/components/ui';

type Busy = null | 'start' | 'stop' | 'reboot' | 'reset' | 'rebuild' | 'refresh';

export function Console({ id }: { id: string }) {
  const router = useRouter();
  const [svc, setSvc] = useState<ServiceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'warn' | 'crit'; text: string } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmText, setConfirmText] = useState('');
  const [confirmKind, setConfirmKind] = useState<null | 'rebuild'>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [metrics, setMetrics] = useState<number[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (refresh = false) => {
      try {
        const d = await api.get<ServiceDetail>(`/api/services/${id}${refresh ? '?refresh=1' : ''}`);
        setSvc(d);
        setError(null);
        return d;
      } catch (e: any) {
        if (e.status === 401) router.push('/login');
        else setError(e.message);
        return null;
      }
    },
    [id, router],
  );

  useEffect(() => {
    if (!getToken()) {
      router.push(`/login?next=/services/${id}`);
      return;
    }
    void load(true);
  }, [id, load, router]);

  // 开通中或重装中时才轮询。机器稳定之后不该一直烦服务器。
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const job = svc?.job;
    const pending = job && ['queued', 'running'].includes(job.status);
    if (!pending) return;
    timer.current = setTimeout(() => void load(), 3000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [svc, load]);

  // 有历史监控的平台才去拉曲线
  useEffect(() => {
    if (!svc?.capabilities?.hasMetrics) return;
    api
      .get<{ supported: boolean; series: { key: string; points: { t: string; v: number }[] }[] }>(
        `/api/services/${id}/metrics?hours=24`,
      )
      .then((r) => {
        const cpu = r.series?.find((s) => s.key === 'cpu');
        setMetrics(cpu ? cpu.points.map((p) => p.v) : []);
      })
      .catch(() => setMetrics([]));
  }, [id, svc?.capabilities?.hasMetrics]);

  const act = async (kind: Busy, path: string, body?: any) => {
    setBusy(kind);
    setFlash(null);
    try {
      const r = await api.post<any>(`/api/services/${id}/${path}`, body);
      setFlash({ tone: 'ok', text: r.message ?? '已执行' });
      // 改密返回的新密码要立刻显示出来，用户等的就是这个
      if (r.password) setShowPassword(true);
      await load(true);
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    } finally {
      setBusy(null);
      setConfirmKind(null);
      setConfirmText('');
    }
  };

  if (error) {
    return (
      <Unit>
        <div className="panelbody">
          <Notice tone="crit">{error}</Notice>
          <div style={{ marginTop: 14 }}>
            <Link href="/dashboard" className="btn btn--sm">返回我的机器</Link>
          </div>
        </div>
      </Unit>
    );
  }

  if (!svc) {
    return (
      <Unit>
        <div className="panelbody">
          <span className="spin" /> <span className="muted" style={{ marginLeft: 8 }}>正在读取…</span>
        </div>
      </Unit>
    );
  }

  const live = svc.liveStatus;
  const power = live?.power ?? 'unknown';
  const running = power === 'running';
  const st = SERVICE_STATUS[svc.status] ?? { label: svc.status, tone: 'mute' };
  const job = svc.job;
  const jobPending = job && ['queued', 'running'].includes(job.status);
  const d = svc.deliver;
  const caps = svc.capabilities;

  // 没有绑定机器 = 要么还在开通，要么开通失败了。
  // 这两种情况下摆一个所有读数都是「—」的控制台没有任何意义，
  // 而且用户根本不知道自己在看什么。直接说清楚状况。
  if (!caps) {
    const stillWorking = jobPending || svc.status === 'provisioning';
    return (
      <Unit>
        <PanelBar title={svc.planName ?? '我的机器'} meta={svc.serviceNo} />
        <div className="panelbody">
          {stillWorking ? (
            <>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="title" style={{ fontSize: 16 }}>正在开通这台机器</span>
                <span className="data" style={{ color: 'var(--accent)' }}>{job?.progress ?? 0}%</span>
              </div>
              <div className="bar" style={{ marginTop: 10, height: 12 }}>
                <span className="bar-fill" style={{ width: `${job?.progress ?? 0}%` }} />
              </div>
              <div className="hint" style={{ marginTop: 10 }}>
                <span className="spin" />
                <span style={{ marginLeft: 8 }}>{job?.step ?? '排队中'}</span>
              </div>
              <p className="hint" style={{ marginTop: 12 }}>
                通常一到两分钟。这个页面会自动刷新，开通好了会直接显示登录信息。
              </p>
            </>
          ) : (
            <>
              <Notice tone="crit">
                这台机器没有开通成功{job?.step ? `（停在「${job.step}」这一步）` : ''}。
                {job?.status === 'failed' && ' 系统已经自动回滚，不会重复计费。'}
              </Notice>
              {(job?.step || svc.suspendReason) && (
                <div className="well" style={{ marginTop: 14 }}>
                  <div className="ro-k">失败原因</div>
                  <div style={{ marginTop: 6, color: 'var(--ink-2)', fontSize: 13.5 }}>
                    {svc.suspendReason ?? job?.step}
                  </div>
                </div>
              )}
              <p className="hint" style={{ marginTop: 14 }}>
                款项已经收到，但机器没建出来。请联系客服，我们会重新给你开通或者退款。
                提供服务编号 <span className="data">{svc.serviceNo}</span> 能查得更快。
              </p>
              <div className="btnrow" style={{ marginTop: 14 }}>
                <Link href="/dashboard" className="btn btn--sm">返回我的机器</Link>
              </div>
            </>
          )}
        </div>
      </Unit>
    );
  }

  return (
    <>
      {/* 开通 / 重装进行中的进度条 */}
      {jobPending && (
        <Unit>
          <div className="panelbody">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="title" style={{ fontSize: 15 }}>
                {job.kind === 'rebuild' ? '正在重装系统' : '正在开通'}
              </span>
              <span className="data" style={{ color: 'var(--accent)' }}>{job.progress}%</span>
            </div>
            <div className="bar" style={{ marginTop: 10, height: 12 }}>
              <span className="bar-fill" style={{ width: `${job.progress}%` }} />
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              <span className="spin" /> <span style={{ marginLeft: 8 }}>{job.step ?? '排队中'}</span>
              {job.kind === 'rebuild' && ' —— 完成后这里会显示新的登录密码'}
            </div>
          </div>
        </Unit>
      )}

      {/* 2U 控制台 */}
      <Unit>
        <PanelBar
          title={svc.planName ?? '我的机器'}
          meta={`${svc.serviceNo} · ${svc.regionLabel ?? ''} · 到期 ${formatDay(svc.expireAt)}`}
        >
          <div className="spacer" />
          <div className="leds">
            <Led kind="run" label="PWR" on={running} />
            <Led kind="io" label="I/O" on={running} blink="io" />
            <Led kind="net" label="NET" on={running} blink="net" />
            <Led kind="err" label="ERR" on={svc.status === 'error'} />
          </div>
        </PanelBar>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.55fr) minmax(0,1fr)' }} className="console-grid">
          <div style={{ padding: '16px 0 16px 20px' }} className="console-left">
            <div className="well">
              <div className="readout">
                <Readout label="公网 IPv4" value={d?.ip ?? svc.ip ?? '—'} />
                <Readout label="已运行" value={formatUptime(live?.uptimeSec)} />
                <Readout
                  label="内存"
                  value={live?.memTotalMb ? (live.memUsedMb! / 1024).toFixed(2) : '—'}
                  unit={live?.memTotalMb ? `/ ${(live.memTotalMb / 1024).toFixed(2)} GB` : undefined}
                />
                <Readout
                  label="累计流量"
                  value={live?.netOutBytes != null ? formatBytes(live.netInBytes! + live.netOutBytes) : '—'}
                />
              </div>

              <div style={{ marginTop: 16 }}>
                <Meter used={live?.diskUsedGb} total={live?.diskTotalGb} label="系统盘（GB）" />
              </div>

              {caps.hasMetrics && (
                <Trace points={metrics ?? []} caption="CPU · 过去 24 小时" unit="%" />
              )}

              {live?.note && (
                <div style={{ marginTop: 14 }}>
                  <Notice tone="warn">{live.note}</Notice>
                </div>
              )}
            </div>
          </div>

          <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <Gauge value={live?.loadAvg1} max={Math.max(4, (svc.cpu ?? 2) * 2)} />
              <div>
                <div className="ro-k">系统负载</div>
                <div className="data" style={{ fontSize: 24, color: 'var(--ink)' }}>
                  {live?.loadAvg1?.toFixed(2) ?? '—'}
                </div>
                <div className="silk" style={{ marginTop: 2 }}>
                  1 分钟 · {svc.cpu ?? '?'} 核
                </div>
              </div>
            </div>

            <div className="row" style={{ gap: 10 }}>
              <span className="badge" data-tone={st.tone as any}>{st.label}</span>
              <span className="badge" data-tone={running ? 'ok' : 'mute'}>{POWER_LABEL[power]}</span>
              <span className="badge" data-tone={svc.daysLeft <= 7 ? 'warn' : 'mute'}>
                剩 {svc.daysLeft} 天
              </span>
            </div>

            <div className="btnrow">
              {caps.canPowerOn && !running && (
                <button className="btn btn--key" disabled={!!busy || !!jobPending} onClick={() => act('start', 'start')}>
                  {busy === 'start' ? '…' : '开机'}
                </button>
              )}
              <button className="btn btn--key" disabled={!!busy || !!jobPending || !running} onClick={() => act('reboot', 'reboot')}>
                {busy === 'reboot' ? '…' : '重启'}
              </button>
              <button className="btn" disabled={!!busy || !!jobPending} onClick={() => act('reset', 'reset-password')}>
                {busy === 'reset' ? '…' : '重置密码'}
              </button>
              {caps.canRebuild && (
                <button className="btn" disabled={!!busy || !!jobPending} onClick={() => setConfirmKind('rebuild')}>
                  重装系统
                </button>
              )}
              <button className="btn btn--danger" disabled={!!busy || !!jobPending || !running} onClick={() => act('stop', 'stop')}>
                {busy === 'stop' ? '…' : '关机'}
              </button>
              <button className="btn btn--sm" disabled={!!busy} onClick={() => act('refresh', '')} style={{ display: 'none' }} />
            </div>

            <p className="hint">
              {caps.canPowerOn
                ? '这些操作直接发到机器所在的平台，和你在云控制台里点是同一个动作。'
                : '这台机器没有带外管理，关机之后没法远程开机，需要联系客服。'}
            </p>

            <button
              className="btn btn--sm"
              disabled={busy === 'refresh'}
              onClick={async () => {
                setBusy('refresh');
                await load(true);
                setBusy(null);
              }}
            >
              {busy === 'refresh' ? '刷新中…' : '刷新状态'}
            </button>
            <span className="silk" style={{ fontSize: 9.5 }}>
              上次采集 {formatDate(svc.lastCheckedAt)}
              {svc.statusError && (
                <span style={{ color: 'var(--warn)', marginLeft: 10 }}>
                  · 这次没连上（{svc.statusError}），下面是上次的读数
                </span>
              )}
            </span>
          </div>
        </div>
      </Unit>

      {flash && (
        <Unit>
          <div className="panelbody">
            <Notice tone={flash.tone}>{flash.text}</Notice>
          </div>
        </Unit>
      )}

      {/* 重装确认。要求把机器编号原样抄一遍 —— 这一步会清空整块盘。 */}
      {confirmKind === 'rebuild' && (
        <Unit>
          <div className="panelbody">
            <h3 className="title" style={{ color: 'var(--crit)' }}>确认重装系统</h3>
            <div style={{ margin: '12px 0' }}>
              <Notice tone="crit">
                重装会<strong>清空整块系统盘</strong>，上面的所有数据都会消失且无法恢复。
                请先确认已经把需要的数据拷走。重装完成后 IP 不变，但登录密码会换成新的。
              </Notice>
            </div>
            <div className="field" style={{ maxWidth: 380 }}>
              <label className="label">请输入服务编号 {svc.serviceNo} 以确认</label>
              <input
                className="input"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={svc.serviceNo}
                autoComplete="off"
              />
              <span className="hint">
                后端会用机器编号做二次校验，输入不匹配时会告诉你正确的编号。
              </span>
            </div>
            <div className="btnrow">
              <button
                className="btn btn--danger"
                disabled={!confirmText || busy === 'rebuild'}
                onClick={() => act('rebuild', 'rebuild', { confirm: confirmText })}
              >
                {busy === 'rebuild' ? '提交中…' : '确认重装'}
              </button>
              <button className="btn" onClick={() => { setConfirmKind(null); setConfirmText(''); }}>
                取消
              </button>
            </div>
          </div>
        </Unit>
      )}

      {/* 交付信息 */}
      {d && (
        <Unit>
          <PanelBar title="登录信息" />
          <div className="panelbody">
            <div className="well">
              <div className="readout">
                <Readout label="地址" value={d.ip ?? '—'} />
                <Readout label="端口" value={d.sshPort ?? 22} />
                <Readout label="用户名" value={d.username ?? 'root'} />
                <Readout
                  label="密码"
                  value={
                    showPassword ? (d.password ?? '—') : '••••••••••••'
                  }
                />
              </div>
              <div className="btnrow" style={{ marginTop: 14 }}>
                <button className="btn btn--sm" onClick={() => setShowPassword((v) => !v)}>
                  {showPassword ? '隐藏密码' : '显示密码'}
                </button>
                <button
                  className="btn btn--sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(
                      `ssh -p ${d.sshPort ?? 22} ${d.username ?? 'root'}@${d.ip}`,
                    );
                    setFlash({ tone: 'ok', text: '登录命令已复制到剪贴板' });
                  }}
                >
                  复制 SSH 命令
                </button>
              </div>
              <div className="hint" style={{ marginTop: 12 }}>
                在自己电脑上打开终端，粘贴上面的命令回车，然后输入密码就能进这台机器。
                Windows 用户可以用自带的 PowerShell，命令一样。
              </div>
            </div>
          </div>
        </Unit>
      )}

      {/* 操作流水 */}
      {svc.recentActions.length > 0 && (
        <Unit>
          <PanelBar title="最近操作" />
          <div className="panelbody">
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>操作</th>
                    <th>结果</th>
                    <th>时间</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {svc.recentActions.map((a) => (
                    <tr key={a.id}>
                      <td>{ACTION_LABEL[a.action] ?? a.action}</td>
                      <td>
                        <span
                          className="badge"
                          data-tone={a.status === 'success' ? 'ok' : a.status === 'failed' ? 'crit' : 'info'}
                        >
                          {a.status === 'success' ? '成功' : a.status === 'failed' ? '失败' : '进行中'}
                        </span>
                      </td>
                      <td className="num">{formatDate(a.createdAt)}</td>
                      <td className="muted">{a.error ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Unit>
      )}

      <style>{`
        @media (max-width: 820px) {
          .console-grid { grid-template-columns: minmax(0,1fr) !important; }
          .console-left { padding: 16px 20px !important; }
        }
      `}</style>
    </>
  );
}

const ACTION_LABEL: Record<string, string> = {
  status_check: '状态检测',
  start: '开机',
  stop: '关机',
  reboot: '重启',
  reset_password: '重置密码',
  rebuild: '重装系统',
  sync_metrics: '同步监控',
};
