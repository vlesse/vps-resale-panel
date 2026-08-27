import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Nav } from '@/components/nav';

export const metadata: Metadata = {
  title: {
    default: 'RenrenYings Cloud',
    template: '%s · RenrenYings Cloud',
  },
  description: '云服务器与存储 —— 东京 / 新加坡 / 洛杉矶',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // 拟物界面里有仪表和小字，允许用户放大
  maximumScale: 5,
  themeColor: '#0a0b0d',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="rack">
          <Nav />
          {children}
          <p className="foot">RenrenYings Cloud · 机架编号 RY-01</p>
        </div>
      </body>
    </html>
  );
}
