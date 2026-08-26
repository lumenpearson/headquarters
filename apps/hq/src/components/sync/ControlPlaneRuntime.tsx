'use client';

import { useEffect, useSyncExternalStore } from 'react';

import { useBooleanSetting, useStringSetting } from '@/application/personalization/useSetting';
import { toAuthorityMode } from '@/application/sync/authority';
import { disconnectedConnection, type ControlPlaneLinkRole } from '@/application/sync/connection';
import {
  createLinkStates,
  isLinkOfSameDatabase,
  parseControlPlaneAddressList,
} from '@/application/sync/controlPlaneLinks';
import { ControlPlaneSession } from '@/application/sync/ControlPlaneSession';
import { groupValuePatches } from '@/application/sync/GroupSettingsSync';
import { mirrorSummary } from '@/application/sync/localMirror';
import { loadProjectConfiguration } from '@/infrastructure/config/RuntimeConfigLoader';
import { ControlPlaneClient } from '@/infrastructure/controlPlane/ControlPlaneClient';
import { DeviceSessionStore } from '@/infrastructure/controlPlane/DeviceSessionStore';
import { readGroupMirror } from '@/infrastructure/controlPlane/GroupSnapshotDownloader';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

import { GroupChannelRuntime } from './GroupChannelRuntime';

/** How often the group's presence list is re-read. */
const presenceIntervalMs = 15_000;
/** How often the clock is re-estimated. Drift is slow; the probe is not free. */
const clockIntervalMs = 60_000;

/**
 * One address this device can reach the group at, and the client for it.
 *
 * The state that goes on the status line lives in the `connection` slice, as
 * `ControlPlaneLinkState`; this is the part a component cannot put in a store
 * -- the client itself. The two are joined by `linkId`.
 */
export interface ControlPlaneLink {
  readonly linkId: string;
  readonly baseUrl: string;
  readonly role: ControlPlaneLinkRole;
  readonly client: ControlPlaneClient;
}

/*
 * One session for the whole client, in the idiom `LiveEditBus` and
 * `KeybindRuntime` already use: the application runs as a single runtime, and
 * threading a context from the root layout into a dialog mounted beside it
 * would be ceremony around one instance. `null` is both the default and the
 * disconnected state, so a surface that asks while nothing is connected is
 * told exactly that rather than handed a client that cannot answer.
 */
interface ActiveControlPlane {
  readonly session: ControlPlaneSession;
  /**
   * Every link this device holds, in the operator's order.
   *
   * A list rather than the single client this held before F14 stage 7: a group
   * may be reachable over the set's LAN and over the internet at once, and the
   * two addresses stand in front of one database. The first is the primary --
   * the session runs on it and it is the only client permitted to write
   * credentials -- and the rest present the same credentials and never rotate
   * them.
   */
  readonly links: readonly ControlPlaneLink[];
}

let active: ActiveControlPlane | null = null;
const listeners = new Set<() => void>();

export function currentControlPlaneSession(): ControlPlaneSession | null {
  return active === null ? null : active.session;
}

/**
 * Every link this device holds, with its client, or none.
 *
 * Beside the session accessor and for the same reason: the holder now holds a
 * set rather than one connection, and a surface that needs the clients -- which
 * one may write credentials, which address a call would leave by -- has to be
 * able to ask for the set rather than for the first of it. The `connection`
 * slice carries what a component renders; this carries what only a client has.
 */
export function currentControlPlaneLinks(): readonly ControlPlaneLink[] {
  return active === null ? [] : active.links;
}

/** Notifies the surfaces that hold a session so they re-read it. */
function setActiveControlPlane(next: ActiveControlPlane | null): void {
  active = next;
  for (const listener of [...listeners]) listener();
}

function currentActiveControlPlane(): ActiveControlPlane | null {
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
 * It holds no state of its own beyond the links it built: the transitions
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
    currentActiveControlPlane,
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
      setActiveControlPlane(null);
      operationsStore
        .getState()
        .patchConnection({ ...disconnectedConnection('local-only'), links: [] });
      return () => {
        controller.abort();
      };
    }

    void resolveControlPlaneAddresses(controller.signal).then((addresses) => {
      if (disposed) return;
      if (addresses.length === 0) {
        // No address configured is the same fact as local-only: there is no
        // group to be out of.
        operationsStore
          .getState()
          .patchConnection({ ...disconnectedConnection('local-only'), links: [] });
        return;
      }
      const states = createLinkStates(addresses);
      /*
       * One store instance for every link, so that "which client may write the
       * credentials" is a question about the clients rather than about which
       * copy of the store they happen to hold. `DeviceSessionStore` reads and
       * writes `localStorage` on every call, so separate instances would share
       * the data anyway -- sharing the object states the intent.
       */
      const sessionStore = new DeviceSessionStore();
      const device = {
        platform: typeof navigator === 'undefined' ? 'web' : navigator.platform,
        applicationVersion: process.env.NEXT_PUBLIC_HQ_BUILD_ID ?? 'dev',
      };
      const links: readonly ControlPlaneLink[] = states.map((state) => ({
        linkId: state.linkId,
        baseUrl: state.baseUrl,
        role: state.role,
        client: new ControlPlaneClient({
          baseUrl: state.baseUrl,
          sessionStore,
          // Exactly one owner, and it is the first address the operator wrote.
          // Two clients minting refresh request ids against one stored token
          // would be read by the server as a stolen-token replay and would
          // revoke the whole session family.
          credentials: state.role === 'primary' ? 'owner' : 'reader',
          device,
        }),
      }));
      const primary = links[0];
      if (primary === undefined) return;
      const created = new ControlPlaneSession({
        client: primary.client,
        apply: (patch) => operationsStore.getState().patchConnection(patch),
      });
      setActiveControlPlane({ session: created, links });
      /*
       * The links are probed *before* the session connects, and that order is
       * the point rather than a detail. `GroupChannelRuntime` builds its feeds
       * from what each link turned out to be, and rebuilding them replaces the
       * channel -- and with it the applied-sequence cursor, which would resume
       * from zero and let the retained window be applied a second time. So the
       * plan is settled while the session is still connecting, and nothing
       * about it changes afterwards.
       *
       * `mode` is moved to `connecting` here because the probe now precedes
       * `ControlPlaneSession.connect`, which is what used to move it, and a row
       * reading "only this machine" through a round trip the operator is
       * waiting on would be wrong. This runtime already writes the mode on the
       * two local-only branches above.
       */
      operationsStore
        .getState()
        .patchConnection({ links: states, mode: 'connecting', failure: '' });
      void probeLinks(links, controller.signal).then(() => {
        if (disposed) return;
        void created.connect(false, controller.signal);
      });
    });

    return () => {
      disposed = true;
      controller.abort();
      setActiveControlPlane(null);
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
   * The sockets, the event channel and the group's settings are mounted rather
   * than opened here, because they live and die with a joined group while this
   * runtime lives as long as the application. Rendering them keeps that
   * lifetime in React's hands instead of in a second set of effect guards.
   */
  return connection === null ? null : (
    <GroupChannelRuntime links={connection.links} session={connection.session} />
  );
}

/**
 * Asks every link what its own control plane can do.
 *
 * The answer differs per address by design -- the plane on the set's LAN admits
 * a realtime socket and the one on the public internet does not -- and one
 * record of it meant the second probe erased the first. Each link now keeps its
 * own, and the whole set is settled before the session connects, so the feeds
 * built from it are built once.
 *
 * The primary is probed here as well as by `ControlPlaneSession.connect`, and
 * the second call is worth its round trip: it is what lets the plan be complete
 * before the mode reaches `online`, and `GetCapabilities` is a unary call that
 * reads a registry rather than the database.
 *
 * The primary decides which database the group's is. A secondary that answers
 * for a different one is marked as not admitted rather than dropped, so the
 * operator can read which address answered for which database instead of
 * watching a configured link silently vanish.
 */
async function probeLinks(links: readonly ControlPlaneLink[], signal: AbortSignal): Promise<void> {
  const probe = async (link: ControlPlaneLink) => {
    try {
      return await link.client.probeCapabilities(signal);
    } catch {
      // An address that does not answer is not a failure of the connection: the
      // group is reachable through whatever else answered. The link keeps its
      // `off` status and its unknown delivery, which counts as polling.
      return undefined;
    }
  };
  const primary = links[0];
  if (primary === undefined) return;
  const primaryCapabilities = await probe(primary);
  if (signal.aborted) return;
  if (primaryCapabilities !== undefined) {
    operationsStore.getState().patchConnectionLink(primary.linkId, {
      capabilities: primaryCapabilities,
      delivery: primaryCapabilities.realtimeAdmission ? 'socket' : 'poll',
    });
  }
  const groupInstallationId = primaryCapabilities?.installationId ?? '';
  await Promise.all(
    links.slice(1).map(async (link) => {
      const capabilities = await probe(link);
      if (capabilities === undefined || signal.aborted) return;
      const admitted = isLinkOfSameDatabase(capabilities, groupInstallationId);
      operationsStore.getState().patchConnectionLink(link.linkId, {
        capabilities,
        admitted,
        delivery: capabilities.realtimeAdmission ? 'socket' : 'poll',
      });
      if (admitted) return;
      operationsStore.getState().patchConnection({
        failure: `АДРЕС ${link.baseUrl} ОТВЕЧАЕТ ЗА ДРУГУЮ БАЗУ CONTROL PLANE — СВЯЗЬ НЕ ИСПОЛЬЗУЕТСЯ`,
      });
    }),
  );
}

/**
 * Where the control plane answers, if anywhere, in the operator's order.
 *
 * The project configuration wins over the environment variable: the variable
 * is a developer's convenience, while `project.override.json` is the file an
 * operator edits on the shoot machine, and the machine's own answer has to
 * outrank the one baked into the build.
 *
 * A list rather than an address since F14 stage 7. One address behaves exactly
 * as it did, and so does none; more than one is a group reachable both over the
 * set's LAN and over the internet, and the order is the operator's statement of
 * which plane to prefer.
 */
async function resolveControlPlaneAddresses(signal: AbortSignal): Promise<readonly string[]> {
  try {
    const project = await loadProjectConfiguration(signal);
    if (project.config.controlPlaneUrl.length > 0) return project.config.controlPlaneUrl;
  } catch {
    // The runtime configuration is unavailable on a route that ships without
    // it; the variable is then the only answer left, and no address at all is
    // a valid one.
  }
  const configured = process.env.NEXT_PUBLIC_HQ_CONTROL_PLANE_URL;
  return configured === undefined ? [] : parseControlPlaneAddressList(configured);
}
