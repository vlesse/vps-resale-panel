'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, formatDay, getToken, SERVICE_STATUS, type ServiceItem } from '@/lib/api';
import { Led, Notice, PanelBar, Unit } from '@/components/ui';

export default function Dashboard() {
  const router = useRouter();
  const [rows, setRows] = useState<ServiceItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.push('/login?next=/dashboard');
      return;
    }
    api
      .get<ServiceItem[]>('/api/services')
      .then(setRows)
      .catch((e) => {
        if (e.status === 401) router.push('/login?next=/dashboard');
        else setError(e.message);
      });
  }, [router]);

  return (
    <>
      <Unit>
        <PanelBar title="我的机器" meta={rows ? `共 ${rows.length} 台` : undefined} />
      </Unit>

      {error && (
        <Unit>
          <div className="panelbody">
            <Notice tone="crit">{error}</Notice>
          </div>
        </Unit>
      )}

      {rows === null && !error && (
        <Unit>
          <div className="panelbody">
            <span className="spin" /> <span className="muted" style={{ marginLeft: 8 }}>正在读取…</span>
          </div>
        </Unit>
      )}

      {rows?.length === 0 && (
        <Unit>
          <div className="panelbody">
            <Notice tone="info">
              你还没有机器。到<Link href="/"> 选购页 </Link>挑一个机型，付款后大约一分钟就能用。
            </Notice>
          </div>
        </Unit>
      )}

      {rows?.map((s) => {
        const st = SERVICE_STATUS[s.status] ?? { label: s.status, tone: 'mute' };
        const running = s.status === 'active';
        const expiring = s.daysLeft <= 7 && s.daysLeft >= 0;
        return (
          <Unit key={s.id}>
            <div
              className="panelbody"
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto minmax(0,1fr) auto auto',
                gap: 18,
                alignItems: 'center',
              }}
            >
              <div className="leds">
                <Led kind="run" label="电源" on={running} />
                <Led kind="io" label="磁盘" on={running} blink="io" />
              </div>

              <div style={{ minWidth: 0 }}>
                <div className="title" style={{ fontSize: 16 }}>
                  {s.planName ?? '机器'}
                </div>
                <div className="data" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {s.ip
                    ? s.isNat
                      ? `${s.ip}:${s.sshPort ?? 22}（NAT）`
                      : s.ip
                    : s.status === 'provisioning'
                      ? '正在开通，尚未分配 IP'
                      : s.status === 'error'
                        ? '开通失败，没有分配到机器'
                        : '没有可用地址'}
                  {s.cpu ? ` · ${s.cpu} vCPU · ${(s.memoryMb! / 1024).toFixed(0)} GB · ${s.diskGb} GB` : ''}
                </div>
                <div className="silk" style={{ fontSize: 9.5, marginTop: 5 }}>
                  {s.serviceNo} · {s.regionLabel}
                </div>
              </div>

              <div style={{ textAlign: 'right' }}>
                <span className="badge" data-tone={st.tone as any}>{st.label}</span>
                <div className="silk" style={{ fontSize: 10, marginTop: 6, color: expiring ? 'var(--warn)' : undefined }}>
                  {formatDay(s.expireAt)} 到期
                  {s.daysLeft >= 0 ? `（剩 ${s.daysLeft} 天）` : '（已过期）'}
                </div>
              </div>

              <div className="btnrow" style={{ justifyContent: 'flex-end' }}>
                <Link href={`/services/${s.id}`} className="btn btn--sm btn--key">
                  进入控制台
                </Link>
                {(expiring || s.daysLeft < 0) && (
                  <Link href={`/services/${s.id}/renew`} className="btn btn--sm">
                    续费
                  </Link>
                )}
              </div>
            </div>

            {s.suspendReason && (
              <div className="panelbody" style={{ paddingTop: 0 }}>
                <Notice tone="warn">{s.suspendReason}</Notice>
              </div>
            )}
          </Unit>
        );
      })}
    </>
  );
}
