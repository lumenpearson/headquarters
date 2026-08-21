import { notFound } from 'next/navigation';

import { OperationsShell } from '@/components/operations/OperationsShell';
import { objectStaticIds } from '@/data/operationsSeed';

export const dynamicParams = false;

export function generateStaticParams() {
  return objectStaticIds.map((id) => ({ id }));
}

export default async function ObjectDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  if (!objectStaticIds.includes(id)) notFound();
  return <OperationsShell route="object-detail" entityId={id} />;
}
