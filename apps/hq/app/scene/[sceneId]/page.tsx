import { notFound } from 'next/navigation';

import { sceneMetadata } from '@/config/scenes';
import { SceneRoute } from '@/components/scene/SceneRoute';

export const dynamicParams = false;

export function generateStaticParams() {
  return sceneMetadata.map((scene) => ({ sceneId: scene.id }));
}

export default async function ScenePage({
  params,
}: {
  readonly params: Promise<{ readonly sceneId: string }>;
}) {
  const { sceneId } = await params;
  if (!sceneMetadata.some((scene) => scene.id === sceneId)) notFound();
  return <SceneRoute sceneId={sceneId} />;
}
