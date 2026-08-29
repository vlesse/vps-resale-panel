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
  // 界面里有不少小号等宽数字，允许用户放大
  maximumScale: 5,
  themeColor: '#f4eef1',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {/*
          五色柔光。固定在视口上，每一团按自己的周期缓慢漂移，
          周期两两不同，所以永远不会回到同一个构图。
          纯装饰，对读屏软件隐藏。
        */}
        <div className="mesh" aria-hidden="true">
          <span className="blob blob--1" />
          <span className="blob blob--2" />
          <span className="blob blob--3" />
          <span className="blob blob--4" />
          <span className="blob blob--5" />
        </div>

        <Nav />
        <div className="rack">{children}</div>

        <footer className="foot">
          <span>RenrenYings Cloud</span>
          <span className="spacer" />
          <span>云服务器 · 东京 / 新加坡 / 洛杉矶</span>
        </footer>
      </body>
    </html>
  );
}
