import { screenIds, type ScreenId } from '@gremuchaya/domain';
import { notFound } from 'next/navigation';

import { ScreenView } from '@/components/screen/ScreenView';

export const dynamicParams = false;

export function generateStaticParams() {
  return screenIds.map((screenId) => ({ screenId }));
}

export default async function ScreenPage({
  params,
}: {
  readonly params: Promise<{ readonly screenId: string }>;
}) {
  const { screenId } = await params;
  if (!screenIds.includes(screenId as ScreenId)) notFound();
  return <ScreenView screenId={screenId as ScreenId} />;
}
