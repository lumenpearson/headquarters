'use client';

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { useBooleanSetting } from '@/application/personalization/useSetting';

import { AppUpdateService, type AppUpdateState } from './AppUpdateService';
import { appUpdateService } from './appUpdateRuntime';
import type { AppUpdatePort } from './appUpdatePort';
import { AutostartCoordinator, type AutostartReading } from './AutostartReconciler';

export interface AppUpdateController {
  readonly state: AppUpdateState;
  readonly checkForUpdate: () => void;
  readonly download: () => void;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly cancel: () => void;
  readonly install: () => void;
  readonly autostart: AutostartReading;
}

/**
 * Subscribes the caller to the process's update service.
 *
 * The service is not created here and not closed here: it belongs to
 * `appUpdateRuntime` and lives for the session, because a download must
 * survive the operator navigating away from the surface that started it, and
 * the launch check `startup.autoUpdate` promises must run whether or not
 * anyone opens settings at all. This hook reads that service's state and
 * hands back the commands, nothing more.
 *
 * `portOverride` exists for tests: passing a fake port drives the whole cycle
 * without a Tauri runtime, and passing `null` forces the same `'unavailable'`
 * reading a browser session gets. It builds a service local to the mount, so
 * a test never disturbs -- and is never disturbed by -- the process one.
 */
export function useAppUpdate(portOverride?: AppUpdatePort | null): AppUpdateController {
  /*
   * A test's own service is built here and torn down with the mount; the real
   * one is the process's and outlives every mount. Either way the identity is
   * stable for as long as `portOverride` is, which is what lets the
   * subscription below be a store subscription rather than an effect that
   * assigns state.
   */
  const service = useMemo(
    () => (portOverride === undefined ? appUpdateService() : new AppUpdateService(portOverride)),
    [portOverride],
  );
  const port = portOverride === undefined ? service.port : portOverride;
  const desiredAutostart = useBooleanSetting('startup.launchOnLogin');
  const coordinator = useMemo(() => new AutostartCoordinator(port), [port]);

  const subscribe = useCallback((onChange: () => void) => service.subscribe(onChange), [service]);
  const read = useCallback(() => service.getState(), [service]);
  const state = useSyncExternalStore<AppUpdateState>(subscribe, read, read);

  const subscribeAutostart = useCallback(
    (onChange: () => void) => coordinator.subscribe(onChange),
    [coordinator],
  );
  const readAutostart = useCallback(() => coordinator.getReading(), [coordinator]);
  const autostart = useSyncExternalStore<AutostartReading>(
    subscribeAutostart,
    readAutostart,
    readAutostart,
  );

  useEffect(() => {
    // Only a port this mount brought into being is a port this mount may end:
    // the process service's adapter listens for as long as the session does.
    if (portOverride === undefined) return;
    return () => closePort(portOverride);
  }, [portOverride]);

  useEffect(() => {
    // The effect asks and nothing else: whether that turns into a write, and
    // what the shell answers, are the coordinator's to decide and publish --
    // see `AutostartCoordinator.request`'s doc. In particular, this firing on
    // mount is not itself a reason to write: the coordinator only writes for
    // a `desired` that actually changed after its first call.
    coordinator.request(desiredAutostart);
  }, [coordinator, desiredAutostart]);

  return {
    state,
    checkForUpdate: () => void service.checkForUpdate(),
    download: () => void service.download(),
    pause: () => void service.pause(),
    resume: () => void service.resume(),
    cancel: () => void service.cancel(),
    install: () => void service.install(),
    autostart,
  };
}

/**
 * `TauriAppUpdateAdapter.close()` is not part of `AppUpdatePort` (see that
 * class's own doc), so it is reached the same duck-typed way regardless of
 * whether this hook created the port itself or a test injected one -- a fake
 * port with no `close` simply has nothing happen to it.
 */
function closePort(port: AppUpdatePort | null): void {
  const closable = port as { close?: () => void } | null;
  closable?.close?.();
}
