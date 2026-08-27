import { Suspense } from 'react';
import { AuthForm } from '@/components/auth-form';

export const metadata = { title: '登录' };

export default function LoginPage() {
  // useSearchParams 要求包一层 Suspense，否则整页会退化成客户端渲染
  return (
    <Suspense fallback={null}>
      <AuthForm mode="login" />
    </Suspense>
  );
}
