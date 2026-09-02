'use client';

import { useState } from 'react';
import {
  TerminalButton,
  TerminalCheckbox,
  TerminalDialog,
  TerminalInput,
} from '@gremuchaya/ui/primitives';

import { dateTimeFormat } from '@/application/localization/intl';
import { useAppLocale, t } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';
import { useRuntime } from '@/components/runtime/RuntimeProvider';
import type { NativeMonitor } from '@/infrastructure/tauri/TauriDisplayGateway';
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

const tabLabelIds: Readonly<Record<(typeof tabs)[number], MessageId>> = {
  states: 'developer.tabStates',
  scenes: 'developer.tabScenes',
  screens: 'developer.tabScreens',
  data: 'developer.tabData',
  files: 'developer.tabFiles',
  media: 'developer.tabMedia',
  simulation: 'developer.tabSimulation',
  bridge: 'developer.tabBridge',
  snapshots: 'developer.tabSnapshots',
  diagnostics: 'developer.tabDiagnostics',
};

export function DeveloperPanel() {
  const { controller } = useRuntime();
  const developer = useAppStore((state) => state.developer);
  const runtime = useAppStore((state) => state);
  const [active, setActive] = useState<(typeof tabs)[number]>('states');
  // `appStore`, unlike `operationsStore`, carries no personalization setting
  // of its own, so nothing above already re-renders this panel when the
  // locale moves. This is the one subscription the whole subtree below leans
  // on, the same way `SnapshotTools` already leans on its own.
  useAppLocale();
  if (!developer.isUnlocked) return null;
  return (
    <aside className="developer-panel">
      <header>
        <div>
          <i>{t('developer.badge')}</i>
          <strong>{t('developer.panelHeading')}</strong>
          <span>{t('developer.localOnlyLabel')}</span>
        </div>
        <TerminalButton
          tone="quiet"
          aria-label={t('developer.closeAriaLabel')}
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
            {t(tabLabelIds[tab])}
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
      <h3>{t('developer.simulationFlagsHeading')}</h3>
      {Object.entries(simulation).map(([key, enabled]) => (
        <div className="dev-controls__row" key={key}>
          <TerminalCheckbox
            checked={enabled}
            onCheckedChange={() => toggleSimulation(key as keyof typeof simulation)}
            label={t('developer.simulationFlagCheckboxLabel', { flag: key })}
          />
          <span>{key}</span>
          <b>{enabled ? t('developer.onLabel') : t('developer.offLabel')}</b>
        </div>
      ))}
    </div>
  );
}

function ScreenDiagnostics() {
  const screens = useAppStore((state) => state.screens.byId);
  return (
    <>
      <div className="dev-screen-grid">
        {Object.values(screens).map((screen) => (
          <div key={screen.id}>
            <span>{screen.id}</span>
            <strong>{screen.module}</strong>
            <small>{t('developer.revisionLabel', { revision: screen.revision })}</small>
          </div>
        ))}
      </div>
      <NativeDisplayControls />
    </>
  );
}

/**
 * The operator-facing entry to the native window layer.
 *
 * `list_monitors`, `open_screen_window` and `close_managed_windows` existed in
 * `src-tauri` with no caller, and `project.screenWindows` was validated and
 * never acted on. The engineering panel is where they become reachable today;
 * a shell menu entry is the better home, because opening the display windows is
 * a shoot-day action and not a diagnostic, and the developer contour is behind
 * an access code.
 */
function NativeDisplayControls() {
  const { controller } = useRuntime();
  const [monitors, setMonitors] = useState<readonly NativeMonitor[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = (action: () => Promise<string>) => {
    setBusy(true);
    void action()
      .then((message) => setReport(message))
      .catch((error: unknown) =>
        setReport(error instanceof Error ? error.message : 'NATIVE_WINDOW_ERROR'),
      )
      .finally(() => setBusy(false));
  };

  // The panel only mounts inside a booted runtime, but the context types the
  // controller as nullable for the boot window and a failed boot.
  if (controller === null) return null;
  const available = controller.displays.isAvailable();
  const planned = controller.config.project.screenWindows;

  return (
    <div className="dev-controls">
      <h3>{t('developer.nativeDisplaysHeading')}</h3>
      {available ? null : <p>{t('developer.nativeShellUnavailableNotice')}</p>}
      <div className="dev-controls__row">
        <TerminalButton
          disabled={!available || busy}
          onClick={() =>
            run(async () => {
              const found = await controller.listMonitors();
              setMonitors(found);
              return t('developer.monitorsFoundReport', { count: found.length });
            })
          }
        >
          {t('developer.pollMonitorsButton')}
        </TerminalButton>
        <TerminalButton
          disabled={!available || busy || planned.length === 0}
          onClick={() =>
            run(async () => {
              const results = await controller.openConfiguredScreenWindows();
              const opened = results.filter((result) => result.status === 'opened').length;
              const failures = results.flatMap((result) =>
                result.status === 'failed' ? [result.reason] : [],
              );
              return failures.length === 0
                ? t('developer.windowsOpenedReport', { opened, total: results.length })
                : t('developer.windowsOpenedWithFailuresReport', {
                    opened,
                    total: results.length,
                    failures: failures.join('; '),
                  });
            })
          }
        >
          {t('developer.openScreenWindowsButton', { count: planned.length })}
        </TerminalButton>
        <TerminalButton
          tone="critical"
          disabled={!available || busy}
          onClick={() =>
            run(async () => {
              const result = await controller.closeManagedWindows();
              return result.status === 'closed'
                ? t('developer.managedWindowsClosedReport')
                : result.status === 'failed'
                  ? t('developer.closeFailedReport', { reason: result.reason })
                  : t('developer.nativeShellUnavailableReport');
            })
          }
        >
          {t('developer.closeManagedWindowsButton')}
        </TerminalButton>
      </div>
      {report === null ? null : <p>{report}</p>}
      {monitors.length === 0 ? null : (
        <div className="dev-screen-grid">
          {monitors.map((monitor, index) => (
            <div key={`${monitor.x}:${monitor.y}:${String(index)}`}>
              <span>
                [{index}] {monitor.name ?? t('developer.unnamedMonitorLabel')}
              </span>
              <strong>
                {monitor.width}×{monitor.height}
              </strong>
              <small>
                {monitor.x},{monitor.y} · ×{monitor.scaleFactor}
                {monitor.primary ? t('developer.primaryMonitorSuffix') : ''}
              </small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SnapshotTools() {
  const { controller } = useRuntime();
  // The subscription behind the two stamps below; this panel reads `appStore`,
  // which knows nothing about a personalization setting moving.
  useAppLocale();
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
    if (open && name === '')
      setName(
        t('developer.rehearsalPrefix', {
          time: dateTimeFormat({ timeStyle: 'medium' }).format(new Date()),
        }),
      );
    setDialogOpen(open);
  };
  return (
    <div className="snapshot-tools">
      <h3>{t('developer.snapshotsHeading')}</h3>
      <p>{t('developer.snapshotsDescription')}</p>
      <TerminalDialog
        title={t('developer.saveSnapshotDialogTitle')}
        eyebrow={t('developer.saveSnapshotDialogEyebrow')}
        description={t('developer.saveSnapshotDialogDescription')}
        open={dialogOpen}
        onOpenChange={setOpen}
        trigger={<TerminalButton>{t('developer.saveSnapshotDialogTitle')}</TerminalButton>}
        footer={
          <TerminalButton tone="primary" onClick={save} disabled={name.trim() === ''}>
            {t('developer.confirmSaveButton')}
          </TerminalButton>
        }
      >
        <TerminalInput
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.code === 'Enter') save();
          }}
          aria-label={t('developer.snapshotNameAriaLabel')}
          autoFocus
        />
      </TerminalDialog>
      <TerminalButton onClick={exportSnapshot}>
        {t('developer.exportCurrentStateButton')}
      </TerminalButton>
      <div>
        {snapshots.map((snapshot) => (
          <article key={snapshot.name}>
            <strong>{snapshot.name}</strong>
            <small>
              {dateTimeFormat({ dateStyle: 'short', timeStyle: 'medium' }).format(
                new Date(snapshot.createdAt),
              )}
            </small>
            <TerminalButton onClick={() => void controller?.restoreSnapshot(snapshot.name)}>
              {t('developer.restoreButton')}
            </TerminalButton>
            <TerminalButton
              tone="critical"
              onClick={() => void controller?.removeSnapshot(snapshot.name)}
            >
              {t('developer.deleteButton')}
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
