'use client';

import { useState } from 'react';
import {
  TerminalButton,
  TerminalCheckbox,
  TerminalDialog,
  TerminalInput,
} from '@gremuchaya/ui/primitives';

import { useRuntime } from '@/components/runtime/RuntimeProvider';
import { appStore, useAppStore } from '@/state/appStore';

const tabs = [
  'states',
  'scenes',
  'screens',
  'data',
  'files',
  'media',
  'simulation',
  'bridge',
  'snapshots',
  'diagnostics',
] as const;

export function DeveloperPanel() {
  const { controller } = useRuntime();
  const developer = useAppStore((state) => state.developer);
  const runtime = useAppStore((state) => state);
  const [active, setActive] = useState<(typeof tabs)[number]>('states');
  if (!developer.isUnlocked) return null;
  return (
    <aside className="developer-panel">
      <header>
        <div>
          <i>DEV</i>
          <strong>ИНЖЕНЕРНЫЙ КОНТУР</strong>
          <span>LOCAL ONLY</span>
        </div>
        <TerminalButton
          tone="quiet"
          aria-label="Закрыть инженерный контур"
          onClick={() => controller?.toggleDeveloper()}
        >
          ×
        </TerminalButton>
      </header>
      <nav>
        {tabs.map((tab) => (
          <TerminalButton
            key={tab}
            className={active === tab ? 'is-active' : ''}
            onClick={() => setActive(tab)}
          >
            {tab}
          </TerminalButton>
        ))}
      </nav>
      <div className="developer-panel__body">
        {active === 'simulation' ? (
          <SimulationControls />
        ) : active === 'screens' ? (
          <ScreenDiagnostics />
        ) : active === 'diagnostics' ? (
          <pre>
            {JSON.stringify(
              {
                scene: runtime.scene,
                connections: runtime.connections,
                errors: developer.lastErrors,
              },
              null,
              2,
            )}
          </pre>
        ) : active === 'snapshots' ? (
          <SnapshotTools />
        ) : (
          <StateInspector section={active} />
        )}
      </div>
    </aside>
  );
}

function SimulationControls() {
  const simulation = useAppStore((state) => state.developer.simulation);
  return (
    <div className="dev-controls">
      <h3>SIMULATION FLAGS</h3>
      {Object.entries(simulation).map(([key, enabled]) => (
        <div className="dev-controls__row" key={key}>
          <TerminalCheckbox
            checked={enabled}
            onCheckedChange={() => toggleSimulation(key as keyof typeof simulation)}
            label={`Симуляция ${key}`}
          />
          <span>{key}</span>
          <b>{enabled ? 'ON' : 'OFF'}</b>
        </div>
      ))}
    </div>
  );
}

function ScreenDiagnostics() {
  const screens = useAppStore((state) => state.screens.byId);
  return (
    <div className="dev-screen-grid">
      {Object.values(screens).map((screen) => (
        <div key={screen.id}>
          <span>{screen.id}</span>
          <strong>{screen.module}</strong>
          <small>REV {screen.revision}</small>
        </div>
      ))}
    </div>
  );
}

function SnapshotTools() {
  const { controller } = useRuntime();
  const snapshots = useAppStore((state) => state.developer.snapshots);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const save = () => {
    const snapshotName = name.trim();
    if (snapshotName === '') return;
    void controller?.saveSnapshot(snapshotName);
    setDialogOpen(false);
    setName('');
  };
  const setOpen = (open: boolean) => {
    if (open && name === '') setName(`REHEARSAL ${new Date().toLocaleTimeString('ru-RU')}`);
    setDialogOpen(open);
  };
  return (
    <div className="snapshot-tools">
      <h3>SNAPSHOTS</h3>
      <p>Состояние хранится локально и экспортируется как JSON без сетевого запроса.</p>
      <TerminalDialog
        title="СОХРАНИТЬ SNAPSHOT"
        eyebrow="LOCAL STATE / VERSIONED"
        description="Задайте имя локальной точки восстановления. Данные не отправляются в сеть."
        open={dialogOpen}
        onOpenChange={setOpen}
        trigger={<TerminalButton>СОХРАНИТЬ SNAPSHOT</TerminalButton>}
        footer={
          <TerminalButton tone="primary" onClick={save} disabled={name.trim() === ''}>
            [ENTER] СОХРАНИТЬ
          </TerminalButton>
        }
      >
        <TerminalInput
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.code === 'Enter') save();
          }}
          aria-label="Имя snapshot"
          autoFocus
        />
      </TerminalDialog>
      <TerminalButton onClick={exportSnapshot}>ЭКСПОРТ ТЕКУЩЕГО СОСТОЯНИЯ</TerminalButton>
      <div>
        {snapshots.map((snapshot) => (
          <article key={snapshot.name}>
            <strong>{snapshot.name}</strong>
            <small>{new Date(snapshot.createdAt).toLocaleString('ru-RU')}</small>
            <TerminalButton onClick={() => void controller?.restoreSnapshot(snapshot.name)}>
              RESTORE
            </TerminalButton>
            <TerminalButton
              tone="critical"
              onClick={() => void controller?.removeSnapshot(snapshot.name)}
            >
              DELETE
            </TerminalButton>
          </article>
        ))}
      </div>
    </div>
  );
}

function StateInspector({ section }: { readonly section: string }) {
  const state = useAppStore((value) => value);
  const selected =
    section === 'scenes'
      ? state.scene
      : section === 'files'
        ? state.explorer
        : section === 'media'
          ? state.screens
          : state.operator;
  return <pre>{JSON.stringify(selected, null, 2)}</pre>;
}

function toggleSimulation(
  key: keyof ReturnType<typeof appStore.getState>['developer']['simulation'],
): void {
  const current = appStore.getState();
  current.replaceRuntimeState({
    ...current,
    developer: {
      ...current.developer,
      simulation: { ...current.developer.simulation, [key]: !current.developer.simulation[key] },
    },
  });
}

function exportSnapshot(): void {
  const state = appStore.getState();
  const data = JSON.stringify(
    { version: 1, exportedAt: new Date().toISOString(), runtime: state },
    null,
    2,
  );
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `hq-snapshot-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
