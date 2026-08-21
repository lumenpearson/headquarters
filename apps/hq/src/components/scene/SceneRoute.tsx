import { OperationalShell } from '@/components/shell/OperationalShell';

export function SceneRoute({ sceneId }: { readonly sceneId: string }) {
  return (
    <div data-scene-route={sceneId}>
      <OperationalShell initialSceneId={sceneId} />
    </div>
  );
}
