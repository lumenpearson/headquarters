'use client';

import { TerminalIcon, TerminalIconButton } from '@gremuchaya/ui/primitives';

import { useStringSetting } from '@/application/personalization/useSetting';
import { appStore, useAppStore } from '@/state/appStore';
import { AssetSurface } from '@/components/modules/AssetSurface';

export function WindowLayer() {
  const windows = useAppStore((state) => state.workspace.windows);
  const documents = useAppStore((state) => state.workspace.documentsById);
  const iconSet = useStringSetting('styles.iconSet');
  const visible = windows.filter((window) => window.state !== 'minimized');
  return (
    <div className="window-layer" aria-live="polite">
      {visible.map((window) => {
        const document = documents[window.documentId];
        if (document === undefined) return null;
        const style =
          window.state === 'maximized'
            ? { inset: 18, zIndex: window.zOrder }
            : {
                left: window.bounds.x,
                top: window.bounds.y,
                width: window.bounds.width,
                height: window.bounds.height,
                zIndex: window.zOrder,
              };
        return (
          <section
            key={window.id}
            className={`workspace-window workspace-window--${window.state}`}
            style={style}
            onMouseDown={() => focusWindow(window.id)}
          >
            <header>
              <div>
                <i>HQ</i>
                <span>{window.title}</span>
              </div>
              <nav>
                <TerminalIconButton
                  label={`Свернуть ${window.title}`}
                  onClick={() => setWindowState(window.id, 'minimized')}
                >
                  <TerminalIcon name="minimize" iconSet={iconSet} />
                </TerminalIconButton>
                <TerminalIconButton
                  label={
                    window.state === 'maximized'
                      ? `Восстановить ${window.title}`
                      : `Развернуть ${window.title}`
                  }
                  onClick={() =>
                    setWindowState(window.id, window.state === 'maximized' ? 'normal' : 'maximized')
                  }
                >
                  <TerminalIcon name="maximize" iconSet={iconSet} />
                </TerminalIconButton>
                <TerminalIconButton
                  label={`Закрыть ${window.title}`}
                  tone="critical"
                  onClick={() => closeWindow(window.id)}
                >
                  <TerminalIcon name="close" iconSet={iconSet} />
                </TerminalIconButton>
              </nav>
            </header>
            <div className="workspace-window__content">
              <DocumentView document={document} />
            </div>
          </section>
        );
      })}
    </div>
  );
}

function DocumentView({
  document,
}: {
  readonly document: ReturnType<typeof appStore.getState>['workspace']['documentsById'][string];
}) {
  switch (document.kind) {
    case 'person':
      return (
        <div className="document-dossier">
          <span>PERSON / DOSSIER</span>
          <h2>{document.title}</h2>
          <AssetSurface />
          <dl>
            <dt>ENTITY ID</dt>
            <dd>{document.entityId}</dd>
            <dt>STATUS</dt>
            <dd>ОТКРЫТО ИЗ VIRTUAL EXPLORER</dd>
            <dt>КОНТУР</dt>
            <dd>ЛОКАЛЬНЫЙ</dd>
          </dl>
        </div>
      );
    case 'vehicle':
      return (
        <div className="document-dossier">
          <span>VEHICLE / DOSSIER</span>
          <h2>{document.title}</h2>
          <AssetSurface />
          <p>{document.entityId}</p>
        </div>
      );
    case 'image':
      return <AssetSurface assetId={document.assetId} />;
    case 'video':
      return (
        <AssetSurface assetId={document.assetId} tone="video">
          <div className="cctv-time">LOCAL MEDIA / PAUSED</div>
        </AssetSurface>
      );
    case 'map':
      return (
        <AssetSurface assetId="map-spb-kad-shushary" tone="map">
          <div className="target-box">
            <span>{document.presetId}</span>
          </div>
        </AssetSurface>
      );
    case 'graph':
      return (
        <div className="document-placeholder">
          <i>⌬</i>
          <h2>{document.title}</h2>
          <span>{document.graphId}</span>
        </div>
      );
    case 'text':
      return (
        <article className="text-document">
          <h2>{document.title}</h2>
          <p>{document.body}</p>
        </article>
      );
    case 'metadata':
      return (
        <div className="document-dossier">
          <span>FILE / METADATA</span>
          <h2>{document.title}</h2>
          <dl>
            <dt>PATH</dt>
            <dd>{document.node.path}</dd>
            <dt>KIND</dt>
            <dd>{document.node.kind}</dd>
          </dl>
        </div>
      );
  }
}

function focusWindow(windowId: string): void {
  const current = appStore.getState();
  const nextZ =
    current.workspace.windows.reduce((maximum, window) => Math.max(maximum, window.zOrder), 0) + 1;
  current.replaceRuntimeState({
    ...current,
    workspace: {
      ...current.workspace,
      windows: current.workspace.windows.map((window) =>
        window.id === windowId ? { ...window, zOrder: nextZ } : window,
      ),
    },
  });
}

function setWindowState(windowId: string, state: 'normal' | 'maximized' | 'minimized'): void {
  const current = appStore.getState();
  current.replaceRuntimeState({
    ...current,
    workspace: {
      ...current.workspace,
      windows: current.workspace.windows.map((window) =>
        window.id === windowId ? { ...window, state } : window,
      ),
    },
  });
}

function closeWindow(windowId: string): void {
  const current = appStore.getState();
  current.replaceRuntimeState({
    ...current,
    workspace: {
      ...current.workspace,
      windows: current.workspace.windows.filter((window) => window.id !== windowId),
    },
  });
}
