'use client';

import { useEffect, useSyncExternalStore } from 'react';

import { useBooleanSetting, useStringSetting } from '@/application/personalization/useSetting';
import { toAuthorityMode } from '@/application/sync/authority';
import { disconnectedConnection } from '@/application/sync/connection';
import { ControlPlaneSession } from '@/application/sync/ControlPlaneSession';
import { loadProjectConfiguration } from '@/infrastructure/config/RuntimeConfigLoader';
import { ControlPlaneClient } from '@/infrastructure/controlPlane/ControlPlaneClient';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

/** How often the group's presence list is re-read. */
const presenceIntervalMs = 15_000;
/** How often the clock is re-estimated. Drift is slow; the probe is not free. */
const clockIntervalMs = 60_000;

/*
 * One session for the whole client, in the idiom `LiveEditBus` and
 * `KeybindRuntime` already use: the application runs as a single runtime, and
 * threading a context from the root layout into a dialog mounted beside it
 * would be ceremony around one instance. `null` is both the default and the
 * disconnected state, so a surface that asks while nothing is connected is
 * told exactly that rather than handed a client that cannot answer.
 */
let active: ControlPlaneSession | null = null;
const listeners = new Set<() => void>();

export function currentControlPlaneSession(): ControlPlaneSession | null {
  return active;
}

/** Notifies the surfaces that hold a session so they re-read it. */
function setActiveSession(session: ControlPlaneSession | null): void {
  active = session;
  for (const listener of [...listeners]) listener();
}

export function subscribeControlPlaneSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Mounts the group connection for the whole application (R27).
 *
 * It holds no state of its own beyond the session it built: the transitions
 * belong to `ControlPlaneSession`, the slice to the store, and this component
 * supplies what only a component can — the mount, the two timers and the two
 * settings that govern the connection.
 *
 * Mounted in the root layout beside the other runtimes, so a display session
 * that never opens a screen is still in the group.
 */
export function ControlPlaneRuntime() {
  const localOnly = useBooleanSetting('general.localOnly');
  const authoritySetting = useStringSetting('groups.authority');
  const mode = useOperationsStore((state) => state.connection.mode);
  const serverAuthority = useOperationsStore((state) => state.connection.authority);
  /*
   * The session is read from the module holder rather than mirrored into
   * component state: it is external state, and `useSyncExternalStore` is the
   * hook for external state. Mirroring it would mean writing state from an
   * effect body -- a cascading render, and one more place for the two copies
   * to disagree about whether a client exists.
   */
  const session = useSyncExternalStore(
    subscribeControlPlaneSession,
    currentControlPlaneSession,
    () => null,
  );

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    /*
     * `general.localOnly` is honoured before the address is even looked for.
     * The setting promises this client stays usable without a group, and the
     * only way to keep that promise is to build no client at all — a client
     * built and then not used would still be one probe away from talking.
     */
    if (localOnly) {
      setActiveSession(null);
      operationsStore.getState().patchConnection(disconnectedConnection('local-only'));
      return () => {
        controller.abort();
      };
    }

    void resolveControlPlaneUrl(controller.signal).then((baseUrl) => {
      if (disposed) return;
      if (baseUrl === undefined) {
        // No address configured is the same fact as local-only: there is no
        // group to be out of.
        operationsStore.getState().patchConnection(disconnectedConnection('local-only'));
        return;
      }
      const created = new ControlPlaneSession({
        client: new ControlPlaneClient({
          baseUrl,
          device: {
            platform: typeof navigator === 'undefined' ? 'web' : navigator.platform,
            applicationVersion: process.env.NEXT_PUBLIC_HQ_BUILD_ID ?? 'dev',
          },
        }),
        apply: (patch) => operationsStore.getState().patchConnection(patch),
      });
      setActiveSession(created);
      void created.connect(false, controller.signal);
    });

    return () => {
      disposed = true;
      controller.abort();
      setActiveSession(null);
    };
  }, [localOnly]);

  useEffect(() => {
    if (session === null || mode !== 'online') return;
    const intervalId = window.setInterval(() => {
      void session.refreshPresence();
    }, presenceIntervalMs);
    return () => window.clearInterval(intervalId);
  }, [mode, session]);

  useEffect(() => {
    if (session === null || mode !== 'online') return;
    const intervalId = window.setInterval(() => {
      void session.sampleClock();
    }, clockIntervalMs);
    return () => window.clearInterval(intervalId);
  }, [mode, session]);

  /*
   * `groups.authority` and the group's mode are reconciled here rather than
   * inside the settings action, because the disagreement can start on either
   * side: an administrator moving the control, or another session moving the
   * group. `serverAuthority` is in the dependency list for the second case.
   * The precedence itself is `resolveAuthority`; this only carries the answer
   * back into the setting, which is a store act and not the service's.
   */
  useEffect(() => {
    if (session === null || mode !== 'online') return;
    const setting = toAuthorityMode(authoritySetting);
    void session.reconcileAuthority(setting).then((outcome) => {
      if (outcome.reflect === undefined || outcome.reflect === setting) return;
      operationsStore
        .getState()
        .applySettingsPatch([{ id: 'groups.authority', value: outcome.reflect }]);
    });
  }, [authoritySetting, mode, serverAuthority, session]);

  return null;
}

/**
 * Where the control plane answers, if anywhere.
 *
 * The project configuration wins over the environment variable: the variable
 * is a developer's convenience, while `project.override.json` is the file an
 * operator edits on the shoot machine, and the machine's own answer has to
 * outrank the one baked into the build.
 */
async function resolveControlPlaneUrl(signal: AbortSignal): Promise<string | undefined> {
  try {
    const project = await loadProjectConfiguration(signal);
    if (project.config.controlPlaneUrl !== undefined) return project.config.controlPlaneUrl;
  } catch {
    // The runtime configuration is unavailable on a route that ships without
    // it; the variable is then the only answer left, and no address at all is
    // a valid one.
  }
  const configured = process.env.NEXT_PUBLIC_HQ_CONTROL_PLANE_URL;
  return configured === undefined || configured.length === 0 ? undefined : configured;
}
