'use client';

import { useEffect, useState } from 'react';
import type { WorkspaceWindow } from '@gremuchaya/domain';
import { TerminalButton, TerminalInput } from '@gremuchaya/ui/primitives';

import { useActiveKeybinds } from '@/application/keybinds/activeScheme';
import { formatChord } from '@/application/keybinds/match';
import { ModuleRenderer } from '@/components/modules/ModuleRenderer';
import { RuntimeProvider, useRuntime } from '@/components/runtime/RuntimeProvider';
import { SceneControl } from '@/components/operator/SceneControl';
import { VirtualExplorer } from '@/components/explorer/VirtualExplorer';
import { useKeybind } from '@/components/keybinds/KeybindRuntime';
import { WindowLayer } from '@/components/workspace/WindowLayer';
import { DeveloperPanel } from '@/components/developer/DeveloperPanel';
import { useAppStore } from '@/state/appStore';

import { NavigationRail } from './NavigationRail';
import { TopBar } from './TopBar';

/**
 * The six actions the task strip advertises, by id rather than by chord.
 *
 * The chords themselves come from the active scheme: this strip printed `^K`
 * for the command line, which was the palette's chord under no scheme —
 * `scene.commandPalette` is Ctrl+Shift+K by default and `:` under
 * `vim-inspired` — and a hint that names a chord nothing answers teaches the
 * operator a key that does not work.
 */
const shortcutHintIds = [
  ['scene.sectionFiles', 'FILES'],
  ['scene.sectionMap', 'MAP'],
  ['scene.previousCue', 'PREV'],
  ['scene.nextCue', 'GO'],
  ['scene.resetScene', 'RESET'],
  ['scene.commandPalette', 'COMMAND'],
] as const;

const paletteCommands = [
  ['overview', 'Открыть оперативный обзор'],
  ['files', 'Открыть Virtual Explorer'],
  ['map', 'Показать картографический экран'],
  ['video', 'Показать видеоконтур'],
  ['comms', 'Показать перехват связи'],
] as const;

export function OperationalShell({
  initialSceneId,
}: {
  readonly initialSceneId?: string | undefined;
}) {
  return (
    <RuntimeProvider>
      <ShellContent initialSceneId={initialSceneId} />
    </RuntimeProvider>
  );
}

function ShellContent({ initialSceneId }: { readonly initialSceneId?: string | undefined }) {
  const { status, error, controller } = useRuntime();
  const section = useAppStore((state) => state.workspace.activeSection);
  const windows = useAppStore((state) => state.workspace.windows);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // The scene operator's keys. Declared in the registry like every other
  // keybind, but owned here: nothing outside this shell can advance a cue.
  useKeybind('scene.commandPalette', () => setPaletteOpen((current) => !current));
  useKeybind('scene.sectionFiles', () => controller?.setSection('files'));
  useKeybind('scene.sectionMap', () => controller?.setSection('map'));
  useKeybind('scene.previousCue', () => controller?.sceneService.previousCue());
  useKeybind('scene.nextCue', () => controller?.sceneService.nextCue());
  useKeybind('scene.resetScene', () => controller?.sceneService.resetScene());
  useKeybind('shell.dismiss', () => setPaletteOpen(false));

  useEffect(() => {
    if (controller !== null && initialSceneId !== undefined)
      void controller.loadScene(initialSceneId);
  }, [controller, initialSceneId]);

  if (status === 'booting')
    return (
      <main className="boot-screen">
        <div className="boot-mark">ГС</div>
        <strong>РАЗВОРАЧИВАНИЕ ОПЕРАТИВНОГО КОНТУРА</strong>
        <span>ПРОВЕРКА ЛОКАЛЬНЫХ КОНФИГУРАЦИЙ</span>
        <i />
      </main>
    );
  if (status === 'failed')
    return (
      <main className="boot-screen boot-screen--failed">
        <div className="boot-mark">!</div>
        <strong>КОНТУР НЕ ЗАПУЩЕН</strong>
        <span>{error}</span>
        <TerminalButton tone="primary" onClick={() => window.location.reload()}>
          ПОВТОРИТЬ ИНИЦИАЛИЗАЦИЮ
        </TerminalButton>
      </main>
    );

  return (
    <div className="operational-shell">
      <TopBar />
      <NavigationRail />
      <div className="workspace">
        {section === 'overview' ? (
          <Overview />
        ) : section === 'files' ||
          section === 'cases' ||
          section === 'archive' ||
          section === 'search' ||
          section === 'objects' ? (
          <VirtualExplorer />
        ) : (
          <FocusedScreen section={section} />
        )}
      </div>
      <TaskStrip windows={windows} />
      <StatusBar />
      <WindowLayer />
      <DeveloperPanel />
      {paletteOpen ? (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onSection={(next) => {
            controller?.setSection(next);
            setPaletteOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function Overview() {
  const wall = useAppStore((state) => state.screens.byId['wall-center']);
  const hwan = useAppStore((state) => state.screens.byId['hwan-main']);
  const scene = useAppStore((state) => state.scene);
  return (
    <div className="overview-grid">
      <SceneControl />
      <section className="wall-preview hq-panel">
        <header className="hq-panel__header">
          <div>
            <span className="hq-panel__eyebrow">WALL / CENTER</span>
            <h2 className="hq-panel__title">ОСНОВНОЙ ВИДЕОКОНТУР</h2>
          </div>
          <span className="status-ok">ONLINE</span>
        </header>
        <div className="screen-content">
          <ModuleRenderer module={wall.module} payload={wall.payload} />
          {wall.blackout ? <div className="blackout-layer">BLACKOUT</div> : null}
          {wall.frozen ? <div className="freeze-layer">FREEZE</div> : null}
        </div>
      </section>
      <section className="hwan-preview hq-panel">
        <header className="hq-panel__header">
          <div>
            <span className="hq-panel__eyebrow">HWAN / MAIN</span>
            <h2 className="hq-panel__title">РАБОЧИЙ МОНИТОР</h2>
          </div>
        </header>
        <div className="screen-content">
          <ModuleRenderer module={hwan.module} payload={hwan.payload} />
        </div>
      </section>
      <section className="telemetry-panel hq-panel">
        <header className="hq-panel__header">
          <h2 className="hq-panel__title">ТЕЛЕМЕТРИЯ</h2>
        </header>
        <div>
          <Telemetry label="SCENE" value={scene.activeSceneId ?? '—'} />
          <Telemetry label="CUE" value={String(scene.activeCueIndex + 1).padStart(2, '0')} />
          <Telemetry label="STATUS" value={scene.status.toUpperCase()} />
          <Telemetry label="ASSETS" value={`${scene.preload.ready}/${scene.preload.total}`} />
          <Telemetry label="BUS" value="LOCAL / ONLINE" />
        </div>
      </section>
    </div>
  );
}

function FocusedScreen({ section }: { readonly section: 'map' | 'video' | 'comms' }) {
  const screenId =
    section === 'map' ? 'hwan-map' : section === 'comms' ? 'hwan-comms' : 'wall-center';
  const screen = useAppStore((state) => state.screens.byId[screenId]);
  return (
    <section className="focused-screen">
      <header>
        <span>{screenId}</span>
        <strong>{section.toUpperCase()} / OPERATIONAL VIEW</strong>
        <i>ONLINE</i>
      </header>
      <ModuleRenderer module={screen.module} payload={screen.payload} />
    </section>
  );
}

function Telemetry({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <p>
      <span>{label}</span>
      <strong>{value}</strong>
    </p>
  );
}

function TaskStrip({ windows }: { readonly windows: readonly WorkspaceWindow[] }) {
  const keybinds = useActiveKeybinds();
  return (
    <div className="task-strip">
      <strong className="task-strip__mode">-- NORMAL --</strong>
      <div className="task-strip__windows">
        {windows.map((window) => (
          <TerminalButton key={window.id}>{window.title}</TerminalButton>
        ))}
      </div>
      <div className="task-strip__hints" aria-label="Горячие клавиши">
        {shortcutHintIds.map(([id, label]) => {
          const keybind = keybinds.find((candidate) => candidate.id === id);
          if (keybind === undefined) return null;
          return (
            <span className="terminal-hint" key={id}>
              <kbd>{formatChord(keybind.chord)}</kbd>
              <em>{label}</em>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function StatusBar() {
  const sources = useAppStore((state) => state.explorer.sourceStatuses);
  return (
    <footer className="statusbar">
      <span>~/hq/control</span>
      <span className="statusbar__mode">NORMAL</span>
      <span>
        SRC {Object.values(sources).filter((status) => status === 'online').length}/
        {Object.keys(sources).length}
      </span>
      <span>BUS:V1</span>
      <span>UTF-8</span>
      <span>HQ-V3-LOCAL</span>
    </footer>
  );
}

function CommandPalette({
  onClose,
  onSection,
}: {
  readonly onClose: () => void;
  readonly onSection: (section: 'overview' | 'files' | 'map' | 'video' | 'comms') => void;
}) {
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <section className="command-palette" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <strong>:COMMAND</strong>
          <kbd>ESC</kbd>
        </header>
        <label>
          <span>:</span>
          <TerminalInput
            aria-label="Команда или раздел"
            autoFocus
            placeholder="command or section"
          />
        </label>
        <span>[ COMMANDS ]</span>
        {paletteCommands.map(([id, label]) => (
          <TerminalButton key={id} onClick={() => onSection(id)}>
            <i>&gt;</i>
            {label}
            <kbd>ENTER</kbd>
          </TerminalButton>
        ))}
      </section>
    </div>
  );
}
