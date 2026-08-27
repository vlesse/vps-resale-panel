import { Checkout } from './checkout';

export const metadata = { title: '结算' };

export default async function PayPage({ params }: { params: Promise<{ orderNo: string }> }) {
  const { orderNo } = await params;
  return <Checkout orderNo={orderNo} />;
}
