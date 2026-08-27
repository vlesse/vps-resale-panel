import { Console } from './console';

export const metadata = { title: '机器控制台' };

export default async function ServicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Console id={id} />;
}
