import { notFound } from 'next/navigation';

import { WallView, type WallId } from '@/components/screen/WallView';

const wallIds = ['hq-standard', 'hwan-triple', 'interrogation'] as const;

export const dynamicParams = false;

export function generateStaticParams() {
  return wallIds.map((wallId) => ({ wallId }));
}

export default async function WallPage({
  params,
}: {
  readonly params: Promise<{ readonly wallId: string }>;
}) {
  const { wallId } = await params;
  if (!wallIds.includes(wallId as WallId)) notFound();
  return <WallView wallId={wallId as WallId} />;
}
