'use client';

import { ModuleRenderer } from '@/components/modules/ModuleRenderer';
import { RuntimeProvider } from '@/components/runtime/RuntimeProvider';
import { useAppStore } from '@/state/appStore';

export type WallId = 'hq-standard' | 'hwan-triple' | 'interrogation';

export function WallView({ wallId }: { readonly wallId: WallId }) {
  return (
    <RuntimeProvider>
      <WallContent wallId={wallId} />
    </RuntimeProvider>
  );
}

function WallContent({ wallId }: { readonly wallId: WallId }) {
  const screens = useAppStore((state) => state.screens.byId);
  const ids =
    wallId === 'hwan-triple'
      ? (['hwan-map', 'hwan-main', 'hwan-comms'] as const)
      : wallId === 'interrogation'
        ? (['interrogation-video', 'interrogation-audio'] as const)
        : (['wall-left', 'wall-center', 'wall-right'] as const);
  return (
    <main className={`wall-route wall-route--${ids.length}`}>
      <header>
        <span>WALL PRESET</span>
        <strong>{wallId}</strong>
        <i>LOCAL BUS / ONLINE</i>
      </header>
      <div>
        {ids.map((screenId) => (
          <section key={screenId}>
            <label>{screenId}</label>
            <ModuleRenderer module={screens[screenId].module} payload={screens[screenId].payload} />
          </section>
        ))}
      </div>
    </main>
  );
}
