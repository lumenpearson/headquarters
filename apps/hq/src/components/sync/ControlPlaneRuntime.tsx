'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

import { useBooleanSetting, useStringSetting } from '@/application/personalization/useSetting';
import { toAuthorityMode } from '@/application/sync/authority';
import {
  disconnectedConnection,
  type ControlPlaneCapabilities,
  type ControlPlaneLinkRole,
} from '@/application/sync/connection';
import { resolveControlPlaneAddresses } from '@/application/sync/controlPlaneAddressResolution';
import { createLinkStates, isLinkOfSameDatabase } from '@/application/sync/controlPlaneLinks';
import { ControlPlaneSession } from '@/application/sync/ControlPlaneSession';
import { groupValuePatches } from '@/application/sync/GroupSettingsSync';
import { mirrorSummary } from '@/application/sync/localMirror';
import { subscribeManualControlPlaneAddress } from '@/application/sync/manualControlPlaneAddress';
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
  /*
   * A tick rather than the address list itself: the manual store re-reads
   * `localStorage` on every call and returns a fresh array each time, which
   * would fail `useSyncExternalStore`'s requirement that a snapshot compare
   * equal until something actually changed. The tick only has to change
   * identity when the store notifies, which a counter does trivially, and the
   * effect below reads the address itself through `resolveControlPlaneAddresses`
   * once it re-runs.
   */
  const [manualAddressTick, setManualAddressTick] = useState(0);
  useEffect(
    () => subscribeManualControlPlaneAddress(() => setManualAddressTick((tick) => tick + 1)),
    [],
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
      setActiveControlPlane(null);
      operationsStore
        .getState()
        .patchConnection({ ...disconnectedConnection('local-only'), links: [] });
      return () => {
        controller.abort();
      };
    }

    void resolveControlPlaneAddresses(controller.signal).then((resolved) => {
      if (disposed) return;
      if (resolved.addresses.length === 0) {
        // No address configured is the same fact as local-only: there is no
        // group to be out of. A broken override is still worth reporting, so
        // it rides along on the same patch rather than being cleared by it.
        operationsStore.getState().patchConnection({
          ...disconnectedConnection('local-only'),
          links: [],
          addressSource: resolved.source,
          failure: resolved.overrideFailure,
        });
        return;
      }
      const states = createLinkStates(resolved.addresses);
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
      const created = buildControlPlaneSession(primary.client);
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
      operationsStore.getState().patchConnection({
        links: states,
        mode: 'connecting',
        addressSource: resolved.source,
        failure: resolved.overrideFailure,
      });
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
  }, [localOnly, manualAddressTick]);

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

  /**
   * Rebuilds the session on the next configured plane, once the primary has
   * stopped answering (known-limitations.md:132-138).
   *
   * Tried only while the mode is `offline` -- the one state that means the
   * primary's own probe or a later call failed outright, exactly as
   * `ControlPlaneSession` draws that line in `connect` and in `#record`. A
   * session that is `reauth-required` or `installation-changed` names a
   * different problem, and changing plane fixes neither of them; with fewer
   * than two configured links there is nowhere to fail over to, and the
   * existing local-copy effect above is what an operator sees instead.
   *
   * Re-tried on the presence timer's own cadence for as long as no candidate
   * has answered, rather than a new timer of this effect's own: a secondary
   * that was down the moment the primary failed may still come up before the
   * primary does.
   */
  useEffect(() => {
    if (mode !== 'offline' || connection === null || connection.links.length < 2) return;
    const controller = new AbortController();
    let disposed = false;
    const attempt = () => {
      void attemptPlaneFailover(connection.links, controller.signal).then((rebuilt) => {
        if (disposed || rebuilt === null) return;
        const promoted = rebuilt[0];
        if (promoted === undefined) return;
        const created = buildControlPlaneSession(promoted.client);
        setActiveControlPlane({ session: created, links: rebuilt });
        void created.connect(false, controller.signal);
      });
    };
    attempt();
    const intervalId = window.setInterval(attempt, presenceIntervalMs);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, [connection, mode]);

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
 * One `ControlPlaneSession` bound to one link's client, with what only a
 * component can supply: the operator's own screen and selection, read fresh
 * every time presence is reported rather than captured once (F10 presence
 * publish).
 *
 * Shared by the initial mount and by plane failover below, so a session
 * rebuilt on a second address reports itself exactly as the first one did --
 * two copies of this closure would be two places for the two to drift.
 */
function buildControlPlaneSession(client: ControlPlaneClient): ControlPlaneSession {
  return new ControlPlaneSession({
    client,
    apply: (patch) => operationsStore.getState().patchConnection(patch),
    readPresenceScreen: () => ({
      activeScreen: typeof window === 'undefined' ? '' : window.location.pathname,
      selectedElement: operationsStore.getState().edit.selectedElementId,
    }),
  });
}

/** One link's own probe, or `undefined` when it did not answer. */
async function probeLink(
  link: ControlPlaneLink,
  signal: AbortSignal,
): Promise<ControlPlaneCapabilities | undefined> {
  try {
    return await link.client.probeCapabilities(signal);
  } catch {
    // An address that does not answer is not a failure of the connection: the
    // group is reachable through whatever else answered.
    return undefined;
  }
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
  const primary = links[0];
  if (primary === undefined) return;
  const primaryCapabilities = await probeLink(primary, signal);
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
      const capabilities = await probeLink(link, signal);
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
 * Rebuilds the link set with the next answering plane promoted to primary, or
 * `null` when none of the others answered either (known-limitations.md:132-138).
 *
 * Only a plane already known not to share the group's database is skipped
 * outright; every other candidate is probed fresh, because the plane that
 * failed just now may not be the one that failed at boot. `deviceLifecycle`
 * is checked here for the same reason `ControlPlaneSession.connect` checks it
 * before pairing -- a control plane started without durable auth cannot carry
 * a session -- and *which* database the promoted plane actually answers for is
 * left to `connect`'s own `#installationMatches` check, which is the
 * authoritative one and already lands on `installation-changed` rather than
 * joining the wrong group.
 *
 * Promotion moves the link to the front of the list and swaps which client
 * holds `owner` credentials, because every downstream consumer --
 * `GroupChannelRuntime`'s settings and material clients, the snapshot resume,
 * the socket that refines the clock -- reads `links[0]` as the plane carrying
 * the session. The demoted primary keeps its place among the rest, tried
 * again the next time this runs.
 */
export async function attemptPlaneFailover(
  links: readonly ControlPlaneLink[],
  signal: AbortSignal,
): Promise<readonly ControlPlaneLink[] | null> {
  const current = links[0];
  if (current === undefined || links.length < 2) return null;
  for (let index = 1; index < links.length; index += 1) {
    const candidate = links[index];
    if (candidate === undefined) continue;
    const known = operationsStore
      .getState()
      .connection.links.find((entry) => entry.linkId === candidate.linkId);
    if (known?.admitted === false) continue;
    const capabilities = await probeLink(candidate, signal);
    if (signal.aborted || capabilities === undefined || !capabilities.deviceLifecycle) continue;
    const promoted: ControlPlaneLink = {
      linkId: candidate.linkId,
      baseUrl: candidate.baseUrl,
      role: 'primary',
      client: candidate.client.asOwner(),
    };
    const demoted: ControlPlaneLink = {
      linkId: current.linkId,
      baseUrl: current.baseUrl,
      role: 'secondary',
      client: current.client.asReader(),
    };
    operationsStore.getState().patchConnectionLink(promoted.linkId, {
      role: 'primary',
      capabilities,
      delivery: capabilities.realtimeAdmission ? 'socket' : 'poll',
    });
    operationsStore.getState().patchConnectionLink(demoted.linkId, { role: 'secondary' });
    const rest = links.filter((_link, position) => position !== 0 && position !== index);
    return [promoted, demoted, ...rest];
  }
  return null;
}
