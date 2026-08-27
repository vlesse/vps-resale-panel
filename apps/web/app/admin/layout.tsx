import type { ReactNode } from 'react';
import { AdminNav } from './nav';

export const metadata = { title: '后台' };

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AdminNav />
      {children}
    </>
  );
}
