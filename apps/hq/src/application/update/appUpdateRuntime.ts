'use client';

import { readBooleanSetting } from '@/application/personalization/useSetting';
import { createTauriAppUpdateAdapter } from '@/infrastructure/tauri/TauriAppUpdateAdapter';

import { AppUpdateService } from './AppUpdateService';
import type { AppUpdatePort } from './appUpdatePort';

/**
 * One update service for the life of the process.
 *
 * The maintenance surface used to own its own service, which made the feature
 * mean something narrower than the setting says: `startup.autoUpdate` promises
 * a check at launch, and a service created when the operator opens settings
 * checks when the operator opens settings. Worse, it started over each visit --
 * a download already at 80% became a download at 0%.
 *
 * A process-lived service fixes both. The launch check runs once, from the
 * shell root, whether or not anyone opens settings; and the surface, when
 * it does open, subscribes to the transfer already in flight and shows it where
 * it actually is.
 *
 * It is deliberately never closed. Closing it would end a background download
 * the moment the operator navigated away from settings, which is the behaviour
 * this replaces; the adapter's listener costs one event subscription for a
 * session that is going to exit anyway.
 */
let service: AppUpdateService | null = null;
let launchCheckStarted = false;

export function appUpdateService(): AppUpdateService {
  service ??= new AppUpdateService(createTauriAppUpdateAdapter());
  return service;
}

/**
 * The check `startup.autoUpdate` names, run once per launch.
 *
 * Called from `OperationalShell` (via `RuntimeProvider`'s `LaunchUpdateCheck`)
 * rather than from any screen, so the promise the setting makes -- check on
 * launch, download without being asked -- does not depend on where the
 * operator happens to navigate. `ScreenView`, `WallView` and `DeveloperGate`
 * mount `RuntimeProvider` too, as separate Tauri windows onto the same
 * session, and deliberately do not render `LaunchUpdateCheck`: they are not a
 * second launch, and a launch is what this guards against. A second call is
 * also a no-op for the ordinary reason: React's Strict Mode replays a mount
 * effect, and a replay is not a second launch either.
 *
 * On a browser build the port is absent, the service reports `unavailable`, and
 * this returns having done nothing -- no request, no error line for a feature
 * that build does not have.
 */
export function startLaunchUpdateCheck(): void {
  if (launchCheckStarted) return;
  launchCheckStarted = true;
  if (!readBooleanSetting('startup.autoUpdate')) return;
  const current = appUpdateService();
  if (current.getState().status !== 'idle') return;
  void current.checkForUpdate().then(() => {
    if (current.getState().status === 'available') void current.download();
  });
}

/** Test seam: drops the process-lived service and re-arms the launch check. */
export function resetAppUpdateRuntimeForTests(port?: AppUpdatePort | null): void {
  service = port === undefined ? null : new AppUpdateService(port);
  launchCheckStarted = false;
}
