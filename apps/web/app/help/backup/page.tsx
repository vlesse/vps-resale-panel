import type { Metadata } from 'next';
import Link from 'next/link';
import { Notice, PanelBar, Unit } from '@/components/ui';
import {
  LIFESPAN_MAX_MONTHS,
  LIFESPAN_MIN_MONTHS,
  SUPPORT_EMAIL,
  telegramLink,
} from '@/lib/site-notice';

export const metadata: Metadata = {
  title: '服务器备份手册',
  description: '三种备份办法，选一种照着做，十分钟设置好。',
};

/** 命令块。用 pre 而不是拼在段落里 —— 用户是要整段复制走的。 */
function Cmd({ children }: { children: string }) {
  return <pre className="cmd">{children}</pre>;
}

export default function BackupGuide() {
  const tg = telegramLink();

  return (
    <>
      <Unit>
        <PanelBar title="服务器备份手册" meta="三种办法，选一种照着做" />
        <div className="panelbody">
          <Notice tone="warn">
            本站的机器<strong>最短 {LIFESPAN_MIN_MONTHS} 个月、最长 {LIFESPAN_MAX_MONTHS} 个多月就会到期重置</strong>，
            到期时机器和上面的数据一并清空，<strong>我们也恢复不了</strong>。
            你自己那台的到期时间在「
            <Link href="/dashboard" style={{ color: 'var(--accent)' }}>我的机器</Link>
            」里能看到。
          </Notice>
          <p className="hint" style={{ marginTop: 14 }}>
            下面三种办法，<strong>选一种做完就行</strong>，不用都做。
            拿不准就选办法一 —— 它最简单，覆盖大多数情况。
          </p>
        </div>
      </Unit>

      {/* ---------- 先想清楚要备份什么 ---------- */}
      <Unit>
        <PanelBar title="第一步　先想清楚要备份什么" />
        <div className="panelbody">
          <p className="hint">
            整机备份既慢又占地方，而且恢复的时候你还是得重装一遍系统。
            真正需要留下来的通常只有三类东西：
          </p>
          <table className="table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>要备份的</th>
                <th>一般在哪</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td data-label="要备份的">你的网站 / 程序文件</td>
                <td data-label="一般在哪"><code>/var/www</code>、<code>/opt</code>、<code>/home</code></td>
              </tr>
              <tr>
                <td data-label="要备份的">数据库</td>
                <td data-label="一般在哪">MySQL / PostgreSQL，<strong>要导出，不能直接拷文件</strong></td>
              </tr>
              <tr>
                <td data-label="要备份的">配置文件</td>
                <td data-label="一般在哪"><code>/etc/nginx</code>、<code>/etc/systemd/system</code>、各种 <code>.env</code></td>
              </tr>
            </tbody>
          </table>
          <div style={{ marginTop: 14 }}>
            <Notice tone="crit">
              <strong>数据库千万别直接拷数据目录。</strong>
              数据库正在运行时那些文件是写到一半的，拷回去很可能起不来，
              而且你要到恢复那天才会发现。一定要用 <code>mysqldump</code> 这类导出命令。
            </Notice>
          </div>
        </div>
      </Unit>

      {/* ---------- 办法一 ---------- */}
      <Unit>
        <PanelBar title="办法一　打包下载到自己电脑" meta="最简单，适合数据不大、变化不频繁" />
        <div className="panelbody">
          <p className="hint">在服务器上把要留的东西打成一个包：</p>
          <Cmd>{`tar czf ~/backup-$(date +%Y%m%d).tgz \\
    /var/www /etc/nginx /opt/myapp`}</Cmd>

          <p className="hint" style={{ marginTop: 14 }}>
            有 MySQL 的话，先导出再一起打包：
          </p>
          <Cmd>{`mysqldump -u root -p --all-databases > ~/db-$(date +%Y%m%d).sql
tar czf ~/backup-$(date +%Y%m%d).tgz \\
    /var/www /etc/nginx ~/db-$(date +%Y%m%d).sql`}</Cmd>

          <p className="hint" style={{ marginTop: 14 }}>
            然后在<strong>自己电脑上</strong>（不是在服务器上）执行，把它拉回来：
          </p>
          <Cmd>{`scp -P 端口号 root@你的IP:~/backup-*.tgz .`}</Cmd>

          <p className="hint" style={{ marginTop: 10 }}>
            Windows 用户不想敲命令的话，用 <strong>WinSCP</strong> 或者 <strong>FileZilla</strong>，
            填 IP、端口、用户名密码连上去，把文件拖回本地就行。
          </p>

          <div style={{ marginTop: 14 }}>
            <Notice tone="warn">
              这个办法要<strong>你自己记得做</strong>。建议现在就在手机上设个每周提醒，
              比「我记得的」靠谱。
            </Notice>
          </div>
        </div>
      </Unit>

      {/* ---------- 办法二 ---------- */}
      <Unit>
        <PanelBar title="办法二　自动同步到网盘" meta="设置一次就不用管了，推荐" />
        <div className="panelbody">
          <p className="hint">
            用 <strong>rclone</strong> 把备份自动传到你的网盘（Google Drive、OneDrive、
            对象存储都支持）。设置一次，以后每天自动跑。
          </p>

          <p className="hint" style={{ marginTop: 14 }}>1. 装 rclone：</p>
          <Cmd>{`curl https://rclone.org/install.sh | sudo bash`}</Cmd>

          <p className="hint" style={{ marginTop: 14 }}>
            2. 连你的网盘，按提示一路选（新手全按默认回车，到授权那步会给你一个网址，
            在浏览器里打开登录一下）：
          </p>
          <Cmd>{`rclone config`}</Cmd>

          <p className="hint" style={{ marginTop: 14 }}>
            3. 建一个备份脚本 <code>/root/backup.sh</code>，
            把里面的路径和网盘名字换成你自己的：
          </p>
          <Cmd>{`#!/bin/bash
set -e
D=$(date +%Y%m%d)
mysqldump -u root -p'你的数据库密码' --all-databases > /tmp/db-$D.sql
tar czf /tmp/backup-$D.tgz /var/www /etc/nginx /tmp/db-$D.sql
rclone copy /tmp/backup-$D.tgz 网盘名字:vps-backup/
rm -f /tmp/backup-$D.tgz /tmp/db-$D.sql
# 只留最近 14 天的
rclone delete --min-age 14d 网盘名字:vps-backup/`}</Cmd>

          <p className="hint" style={{ marginTop: 14 }}>4. 给它执行权限，先手工跑一次确认能成：</p>
          <Cmd>{`chmod +x /root/backup.sh && /root/backup.sh`}</Cmd>

          <p className="hint" style={{ marginTop: 14 }}>
            5. 跑通了再加到定时任务里。执行 <code>crontab -e</code>，在最后加一行
            （每天凌晨三点跑）：
          </p>
          <Cmd>{`0 3 * * * /root/backup.sh >> /var/log/backup.log 2>&1`}</Cmd>

          <div style={{ marginTop: 14 }}>
            <Notice tone="info">
              第 4 步<strong>一定要先手工跑一次</strong>。直接扔进 cron 的话，
              就算它天天失败你也不会知道 —— cron 出错默认不会通知任何人。
            </Notice>
          </div>
        </div>
      </Unit>

      {/* ---------- 办法三 ---------- */}
      <Unit>
        <PanelBar title="办法三　让另一台机器来拉" meta="适合有两台以上服务器的人" />
        <div className="panelbody">
          <p className="hint">
            在另一台<strong>不会到期</strong>的机器上定时把这台的数据拉过去。
            好处是这台机器就算突然没了，备份也不在它身上。
          </p>
          <p className="hint" style={{ marginTop: 12 }}>在那台机器上执行：</p>
          <Cmd>{`rsync -avz -e "ssh -p 端口号" \\
    root@这台的IP:/var/www/ /backup/vps-www/`}</Cmd>
          <p className="hint" style={{ marginTop: 12 }}>
            同样加进 <code>crontab -e</code> 就能每天自动跑。
            先配好 SSH 密钥登录，否则 cron 里跑会卡在输密码那步。
          </p>
        </div>
      </Unit>

      {/* ---------- 验证 ---------- */}
      <Unit>
        <PanelBar title="最后一步　验一次能不能恢复" meta="这一步最多人跳过，也最要命" />
        <div className="panelbody">
          <Notice tone="crit">
            <strong>没验过的备份不算备份。</strong>
            备份天天在跑、文件也一直在长，但真到恢复那天才发现打包时漏了一个目录、
            或者数据库导出的是空的 —— 这种事非常常见。
          </Notice>
          <p className="hint" style={{ marginTop: 14 }}>
            花十分钟验一遍，以后就能安心了：
          </p>
          <ol className="hint" style={{ margin: '10px 0 0', paddingLeft: 20, lineHeight: 2 }}>
            <li>把备份包下载到自己电脑，解开看看</li>
            <li>确认<strong>网站文件、数据库导出、配置文件</strong>三样都在里面</li>
            <li>打开那个 <code>.sql</code> 文件看一眼，里面应该有 <code>INSERT INTO</code> 这样的内容，
              而不是只有几行注释</li>
          </ol>
          <p className="hint" style={{ marginTop: 14 }}>
            更彻底的做法是买一台最便宜的机器，把备份恢复上去跑一遍。
            如果这台机器上跑的是你的正经生意，这十几块钱值得花。
          </p>
        </div>
      </Unit>

      {/* ---------- 到期之后 ---------- */}
      <Unit>
        <PanelBar title="到期那天要做什么" />
        <div className="panelbody">
          <ol className="hint" style={{ margin: 0, paddingLeft: 20, lineHeight: 2 }}>
            <li>到期前手工再跑一次备份，确保拿到的是最新的</li>
            <li>在本站<strong>重新下一单</strong>，开一台新机器</li>
            <li>把备份传到新机器上，装好环境，把数据恢复回去</li>
            <li>域名解析改到新 IP</li>
          </ol>
          <div style={{ marginTop: 14 }}>
            <Notice tone="info">
              想少一次折腾的话，<strong>在旧机器到期前几天就把新机器开好</strong>，
              两台并行跑几天，确认新的没问题再切域名。这样中间不会断服务。
            </Notice>
          </div>
        </div>
      </Unit>

      {/* ---------- 求助 ---------- */}
      <Unit>
        <PanelBar title="搞不定？直接找站长" />
        <div className="panelbody">
          <p className="hint">
            上面这些自己弄不来，或者需要<strong>大容量、长期稳定、批量采购</strong>的，
            直接联系，<strong>免费提供技术支持</strong>，价格也可以谈。
          </p>
          <p className="hint" style={{ marginTop: 10 }}>
            邮箱{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: 'var(--accent)' }}>
              {SUPPORT_EMAIL}
            </a>
            {tg && (
              <>
                　·　Telegram{' '}
                <a
                  href={tg.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent)' }}
                >
                  {tg.label}
                </a>
              </>
            )}
          </p>
        </div>
      </Unit>
    </>
  );
}
