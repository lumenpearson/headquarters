'use client';

import { type RuntimeSnapshotState, type ScreenId } from '@gremuchaya/domain';
import { useEffect } from 'react';

import { applyCueAction } from '@/application/sceneState';
import { ModuleRenderer } from '@/components/modules/ModuleRenderer';
import { RuntimeProvider, useRuntime } from '@/components/runtime/RuntimeProvider';
import { appStore, useAppStore } from '@/state/appStore';

export function ScreenView({ screenId }: { readonly screenId: ScreenId }) {
  return (
    <RuntimeProvider>
      <SynchronizedScreen screenId={screenId} />
    </RuntimeProvider>
  );
}

function SynchronizedScreen({ screenId }: { readonly screenId: ScreenId }) {
  const { controller, status, error } = useRuntime();
  const screen = useAppStore((state) => state.screens.byId[screenId]);
  const sceneId = useAppStore((state) => state.scene.activeSceneId);

  useEffect(() => {
    if (controller === null) return;
    const unsubscribe = controller.bus.subscribe((message) => {
      const payload = message.payload;
      if (payload.type === 'CUE') {
        const current = appStore.getState();
        current.replaceRuntimeState(applyCueAction(current, payload.action));
      } else if (payload.type === 'BLACKOUT') {
        const current = appStore.getState();
        current.replaceRuntimeState(
          applyCueAction(current, { type: 'SET_BLACKOUT', enabled: payload.enabled }),
        );
      } else if (payload.type === 'FREEZE') {
        const current = appStore.getState();
        current.replaceRuntimeState(
          applyCueAction(current, { type: 'FREEZE', enabled: payload.enabled }),
        );
      } else if (
        payload.type === 'SCENE_LOADED' ||
        payload.type === 'RESET' ||
        payload.type === 'CURRENT_STATE'
      ) {
        applySnapshot(payload.state);
      } else if (payload.type === 'PING') {
        controller.bus.publish({
          type: 'PONG',
          nonce: payload.nonce,
          heartbeat: {
            screenId,
            receivedAt: Date.now(),
            route: window.location.pathname,
            sceneId,
            module: appStore.getState().screens.byId[screenId].module,
          },
        });
      }
    });
    controller.bus.publish({ type: 'REQUEST_CURRENT_STATE', requesterId: screenId });
    return unsubscribe;
  }, [controller, sceneId, screenId]);

  if (status !== 'ready')
    return (
      <main className="screen-route screen-route--loading">
        {status === 'failed' ? error : 'SCREEN LINK / CONNECTING'}
      </main>
    );
  return (
    <main className={`screen-route ${screen.blackout ? 'is-blackout' : ''}`}>
      <header>
        <span>{screenId}</span>
        <strong>{screen.module}</strong>
        <i>{sceneId ?? 'LOCAL'}</i>
      </header>
      <div className="screen-route__content">
        <ModuleRenderer module={screen.module} payload={screen.payload} />
        {screen.frozen ? <div className="freeze-layer">FREEZE</div> : null}
        {screen.glitch > 0 ? (
          <div className="glitch-layer" style={{ opacity: screen.glitch }} />
        ) : null}
      </div>
      {screen.blackout ? <div className="screen-blackout" /> : null}
    </main>
  );
}

function applySnapshot(snapshot: RuntimeSnapshotState): void {
  const current = appStore.getState();
  current.replaceRuntimeState({
    ...current,
    scene: {
      ...current.scene,
      activeSceneId: snapshot.activeSceneId,
      activeCueIndex: snapshot.activeCueIndex,
      status: 'running',
    },
    screens: { byId: snapshot.screens },
    operator: { ...current.operator, wallPreset: snapshot.wallPreset, note: snapshot.operatorNote },
  });
}
