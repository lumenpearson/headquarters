'use client';

import { useEffect, useSyncExternalStore } from 'react';

import { useBooleanSetting, useStringSetting } from '@/application/personalization/useSetting';
import { toAuthorityMode } from '@/application/sync/authority';
import { disconnectedConnection } from '@/application/sync/connection';
import { ControlPlaneSession } from '@/application/sync/ControlPlaneSession';
import { groupValuePatches } from '@/application/sync/GroupSettingsSync';
import { mirrorSummary } from '@/application/sync/localMirror';
import { loadProjectConfiguration } from '@/infrastructure/config/RuntimeConfigLoader';
import { ControlPlaneClient } from '@/infrastructure/controlPlane/ControlPlaneClient';
import { readGroupMirror } from '@/infrastructure/controlPlane/GroupSnapshotDownloader';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

import { GroupChannelRuntime } from './GroupChannelRuntime';

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
interface ActiveConnection {
  readonly session: ControlPlaneSession;
  /**
   * The client the session was built on, kept because the group channel needs
   * what only the client has: the shared authenticated transport, and the
   * identity a realtime hello carries. The session deliberately holds neither
   * -- it reasons about a port, not about credentials.
   */
  readonly client: ControlPlaneClient;
}

let active: ActiveConnection | null = null;
const listeners = new Set<() => void>();

export function currentControlPlaneSession(): ControlPlaneSession | null {
  return active === null ? null : active.session;
}

/** Notifies the surfaces that hold a session so they re-read it. */
function setActiveSession(connection: ActiveConnection | null): void {
  active = connection;
  for (const listener of [...listeners]) listener();
}

function currentActiveConnection(): ActiveConnection | null {
  return active;
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
  const connection = useSyncExternalStore(
    subscribeControlPlaneSession,
    currentActiveConnection,
    () => null,
  );
  const session = connection === null ? null : connection.session;

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
      const client = new ControlPlaneClient({
        baseUrl,
        device: {
          platform: typeof navigator === 'undefined' ? 'web' : navigator.platform,
          applicationVersion: process.env.NEXT_PUBLIC_HQ_BUILD_ID ?? 'dev',
        },
      });
      const created = new ControlPlaneSession({
        client,
        apply: (patch) => operationsStore.getState().patchConnection(patch),
      });
      setActiveSession({ session: created, client });
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
   * The local copy of the group's state, for the session that cannot reach the
   * group at all (F14, stage 9).
   *
   * `GroupChannelRuntime` mounts only while a session is `online`, so it is the
   * wrong place for this: the launch that matters here is the one where the
   * control plane never answered. The copy is read on every mode change so the
   * status line always reports what is actually on disk -- a mode reset clears
   * every other field of the slice and this one is a fact about the disk.
   *
   * On `offline` the copy is also adopted, because offline is what joining
   * looks like to a device that cannot reach its group: the same precedence
   * `GroupSettingsSync` states for a live join, applied through the same
   * `groupValuePatches`, so the offline path cannot accept a value the online
   * path refuses. It follows that a group-scoped change made offline does not
   * survive the next launch -- the group's last agreement wins a join, and this
   * is one. That is the existing online behaviour, not a new rule.
   */
  useEffect(() => {
    const mirror = readGroupMirror();
    operationsStore.getState().patchConnection({ mirror: mirrorSummary(mirror) });
    if (mode !== 'offline' || mirror === null) return;
    const patches = groupValuePatches(
      mirror.values,
      (id) => operationsStore.getState().personalization.draft.values[id],
    );
    if (patches.length === 0) return;
    operationsStore.getState().applySettingsPatch(patches);
  }, [mode]);

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

  /*
   * The socket, the event channel and the group's settings are mounted rather
   * than opened here, because they live and die with a joined group while this
   * runtime lives as long as the application. Rendering them keeps that
   * lifetime in React's hands instead of in a second set of effect guards.
   */
  return connection === null ? null : (
    <GroupChannelRuntime client={connection.client} session={connection.session} />
  );
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
