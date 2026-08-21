import { notFound } from 'next/navigation';

import { OperationsShell } from '@/components/operations/OperationsShell';
import { caseStaticIds } from '@/data/operationsSeed';

export const dynamicParams = false;

export function generateStaticParams() {
  return caseStaticIds.map((id) => ({ id }));
}

export default async function CaseDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  if (!caseStaticIds.includes(id)) notFound();
  return <OperationsShell route="case-detail" entityId={id} />;
}
