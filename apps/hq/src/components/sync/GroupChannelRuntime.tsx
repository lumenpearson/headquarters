'use client';

import { useEffect } from 'react';

import type { ControlPlaneLinkState } from '@/application/sync/connection';
import { aggregateDelivery, preferredPublishLinkId } from '@/application/sync/controlPlaneLinks';
import type { ControlPlanePort } from '@/application/sync/controlPlanePort';
import type { ControlPlaneSession } from '@/application/sync/ControlPlaneSession';
import { connectGroupSettings } from '@/application/sync/groupSettingsBus';
import { GroupSettingsSync } from '@/application/sync/GroupSettingsSync';
import { connectGroupState } from '@/application/sync/GroupStateSync';
import { mirrorSummary } from '@/application/sync/localMirror';
import { ControlPlaneGroupChannel } from '@/infrastructure/controlPlane/ControlPlaneGroupChannel';
import { GroupEventPoller } from '@/infrastructure/controlPlane/GroupEventPoller';
import { GroupSettingsClient } from '@/infrastructure/controlPlane/GroupSettingsClient';
import { liveEditDocumentId } from '@/infrastructure/controlPlane/GroupLiveEditTransport';
import { GroupSnapshotDownloader } from '@/infrastructure/controlPlane/GroupSnapshotDownloader';
import { RealtimeClient } from '@/infrastructure/controlPlane/RealtimeClient';
import { ControlPlaneMaterialClient } from '@/infrastructure/materials/ControlPlaneMaterialClient';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

import type { ControlPlaneLink } from './ControlPlaneRuntime';
import { setGroupRuntime } from './groupRuntimeHolder';

interface GroupChannelRuntimeProps {
  /** Every address this device holds for the group; the first is the primary. */
  readonly links: readonly ControlPlaneLink[];
  readonly session: ControlPlaneSession;
}

/**
 * The group's feeds, event channel and settings, while it is joined.
 *
 * Separated from `ControlPlaneRuntime` because the two have different
 * lifetimes. The session outlives every failure -- it is what turns a refused
 * call back into `reauth-required` -- while the feeds exist only between
 * `JoinGroup` succeeding and the session ending, and a socket kept open across
 * that boundary is a socket the server has already stopped believing in.
 *
 * **One channel, several feeds.** A device may hold a link to the plane on the
 * set's LAN and one to the plane on the internet at the same time, and both
 * carry the same group log out of the same database. They therefore feed one
 * `ControlPlaneGroupChannel`: the channel owns the applied-sequence cursor, so
 * an event that arrives on both paths is delivered to the subscribers once. That
 * is load-bearing rather than tidy -- `GroupLiveEditTransport` is not
 * idempotent and would write a second settings-history entry for one change.
 *
 * It renders nothing. What it owns is a set of feeds, three collaborators and
 * the holder every other surface reads them from.
 */
export function GroupChannelRuntime({ links, session }: GroupChannelRuntimeProps) {
  const mode = useOperationsStore((state) => state.connection.mode);
  const groupId = useOperationsStore((state) => state.connection.session?.groupId ?? '');
  const deviceId = useOperationsStore((state) => state.connection.session?.deviceId ?? '');
  const settingsCapability = useOperationsStore(
    (state) => state.connection.capabilities?.settings ?? false,
  );
  const materialsCapability = useOperationsStore(
    (state) => state.connection.capabilities?.materials ?? false,
  );
  const syncCapability = useOperationsStore(
    (state) => state.connection.capabilities?.sync ?? false,
  );
  const installationId = useOperationsStore(
    (state) => state.connection.capabilities?.installationId ?? '',
  );
  /*
   * What each link turned out to be, as one string.
   *
   * The feeds have to be rebuilt when a link's probe changes it from unknown to
   * a socket or a poll, and must *not* be rebuilt when a socket reports that it
   * reconnected -- a status change tears down and reopens every feed on the
   * device. Depending on the whole `links` array would do the second; depending
   * on the plan alone does only the first.
   */
  const linkPlan = useOperationsStore((state) => describeLinkPlan(state.connection.links));

  useEffect(() => {
    if (mode !== 'online' || groupId === '' || deviceId === '') {
      setGroupRuntime(null);
      operationsStore.getState().idleConnectionLinks();
      return;
    }
    const controller = new AbortController();
    const primary = links[0];
    if (primary === undefined) return;
    const clientsByLinkId = new Map(links.map((link) => [link.linkId, link.client]));
    /*
     * Which plane a publication goes out on, decided at the moment of the call
     * rather than when the channel is built: the near plane while it is
     * carrying, the cloud plane while it is not, and the near plane again when
     * it returns. The repeat that a failover could cause is safe -- the
     * mutation receipt in the shared database answers it -- but publishing to
     * both on purpose would spend a metered invocation to learn nothing.
     */
    const selectPort = (): ControlPlanePort => {
      const current = operationsStore.getState().connection.links;
      const chosen = preferredPublishLinkId(current);
      return (chosen === undefined ? undefined : clientsByLinkId.get(chosen)) ?? primary.client;
    };
    const channel = new ControlPlaneGroupChannel({ selectPort, groupId, deviceId });
    /*
     * The settings client shares the primary link's transport rather than
     * building one: the bearer interceptor reads the token per call, and a
     * second transport would be a second place for that rule to drift. Absent
     * when a test injected RPC clients, which is also when there is no settings
     * service to reach.
     *
     * The primary and not any link, because `GroupSettingsSync` overwrites this
     * machine's draft with the group's values on join. Two of them against two
     * planes would be two writers of one draft, racing over the same values.
     */
    const transport = primary.client.transport;
    const settings =
      transport === undefined || !settingsCapability
        ? null
        : new GroupSettingsClient({ groupId, deviceId, transport });
    /*
     * The material library shares the same transport for the same reason, and
     * is built only when `GetCapabilities` said `materials`: a control plane
     * without the collaborator refuses every material RPC, and a client built
     * against it would turn every import into a round trip that could only
     * fail. Where the bucket answers is configuration and not something any RPC
     * reports, so the origin is read from the environment here and validated on
     * every presigned address inside the client.
     */
    const materials =
      transport === undefined || !materialsCapability
        ? null
        : new ControlPlaneMaterialClient({
            groupId,
            deviceId,
            transport,
            ...(materialStorageOrigin() === undefined
              ? {}
              : { storageOrigin: materialStorageOrigin() }),
          });
    /*
     * How promptly the *slowest* of this device's own links carries the group,
     * which is what a published command's execution lead has to cover. The rule
     * and the reasoning behind taking the maximum are in `aggregateDelivery`;
     * this is the input, and `playbackLeadForDelivery` in `VideoScreen` is the
     * consumer.
     */
    const plan = operationsStore.getState().connection.links;
    const delivery = aggregateDelivery(plan);
    setGroupRuntime({ groupId, deviceId, channel, delivery, settings, materials });

    /*
     * The group's own state, kept current from the log rather than from
     * whichever call happened to ask next.
     *
     * Subscribed here, before any feed is built, for two reasons. It is behind
     * `channel.deliver` -- the one merge point, where an event carried by both
     * the socket and the poll is dropped the second time -- rather than beside a
     * transport, which would see both copies. And it is registered before the
     * first tick, so the page a feed reads on that tick is delivered into a
     * listener set that already contains it.
     *
     * The view is read from the store per event instead of captured, because
     * `ControlPlaneSession` writes the same fields from the answers to calls and
     * a captured copy would be stale exactly when the version check matters.
     */
    const disconnectGroupState = connectGroupState({
      channel,
      read: () => {
        const { connection } = operationsStore.getState();
        return {
          groupRevision: connection.groupRevision,
          session: connection.session,
          devices: connection.devices,
          presence: connection.presence,
        };
      },
      apply: (patch) => operationsStore.getState().patchConnection(patch),
    });

    /*
     * The resume point when the retained log no longer covers the cursor. One
     * function for every feed: the socket reports the verdict as a
     * `ResyncRequired` frame and a polled page as its `resync_required` field,
     * but what follows is the same snapshot call, and copies of it would be
     * places for the document identifier to drift.
     *
     * The only document this client publishes is live edit; a control plane
     * that has recorded no snapshot answers `null`, and every feed then resumes
     * from the oldest sequence still held -- which is the most any of them can
     * honestly claim to have seen. The call goes out on the same link a
     * publication would, so a resync does not depend on a plane that is down.
     */
    const resumeFromSnapshot = async (
      _resync: unknown,
      signal: AbortSignal,
    ): Promise<{ readonly afterSequence: bigint } | null> => {
      const snapshot = await selectPort().getDocumentSnapshot(liveEditDocumentId, signal);
      return snapshot === null ? null : { afterSequence: snapshot.sequence };
    };

    let disconnectSettings: (() => void) | undefined;
    if (settings !== null) {
      /*
       * The local copy of the group's state (F14, stage 9). It is offered the
       * answer `GetEffectiveSettings` gives and decides for itself whether the
       * answer is newer, complete and readable; nothing here can make it accept
       * one that is not. `documents` is passed only when this deployment
       * registered `SyncService`, because the group-log position it stamps the
       * copy with comes from `GetDocumentSnapshot`, and a call that could only
       * be refused would stop every refresh instead of stamping one.
       */
      const mirror = new GroupSnapshotDownloader({
        groupId,
        installationId,
        ...(syncCapability ? { documents: primary.client } : {}),
      });
      const sync = new GroupSettingsSync({
        port: settings,
        apply: (patches) => operationsStore.getState().applySettingsPatch(patches),
        readDraftValue: (id) => operationsStore.getState().personalization.draft.values[id],
        onFailure: (failure) => operationsStore.getState().patchConnection({ failure }),
        mirror,
        onMirrorChanged: () =>
          operationsStore.getState().patchConnection({ mirror: mirrorSummary(mirror.read()) }),
      });
      disconnectSettings = connectGroupSettings(sync);
      // The group wins on join; see `GroupSettingsSync`'s precedence note.
      void sync.adoptGroupSettings(controller.signal);
    }

    /*
     * One feed per admitted link, each reporting under its own link id.
     *
     * A plane that admits realtime is followed by a socket; one that does not
     * is followed by asking, because `WatchGroup` subscribes to the realtime
     * hub's listener map -- a property of one process -- while `ReadGroupEvents`
     * touches no listener at all. A plane that answers for a different database
     * is followed by neither: it is a different group, and merging its log into
     * this cursor would drop every second event as already applied.
     *
     * Every feed hands its events to the same `channel.deliver` and reads its
     * position from the same channel, so an event that arrived twice is applied
     * once.
     */
    const realtimes: RealtimeClient[] = [];
    const pollers: GroupEventPoller[] = [];
    for (const link of links) {
      const state = plan.find((candidate) => candidate.linkId === link.linkId);
      if (state === undefined || !state.admitted) continue;
      const report = (patch: Partial<Omit<ControlPlaneLinkState, 'linkId'>>) =>
        operationsStore.getState().patchConnectionLink(link.linkId, patch);
      if (state.delivery === 'socket') {
        const realtime = new RealtimeClient({
          baseUrl: link.baseUrl,
          identity: () => link.client.realtimeIdentity(),
          onEvent: channel.deliver,
          // The channel owns the group's position, because the group has one
          // order and more than one transport may be carrying it.
          cursor: channel,
          onStatus: report,
          onResync: resumeFromSnapshot,
          onReauthenticationRequired: () => {
            /*
             * The server closed the socket because the triple no longer checks
             * out. Rotating the token and dialling again is the only recovery
             * that is not a loop, and it goes through the session -- the one
             * component that may refresh -- rather than through this link's own
             * client, which on a secondary link is a reader and would refuse.
             */
            void session.ensureFreshSession().then((fresh) => {
              if (fresh && !controller.signal.aborted) realtime.start();
            });
          },
        });
        realtimes.push(realtime);
        realtime.start();
        continue;
      }
      /*
       * Without `SyncService` there is no log to read and no poller is built;
       * the link still says `POLL`, because the session is in the group and
       * reads it on the presence and clock timers, and saying `LIVE` would
       * claim a promptness that is not there.
       */
      report({ status: 'polling', connectionId: '', lastSequence: 0, resyncCount: 0 });
      if (!(state.capabilities?.sync ?? syncCapability)) continue;
      const poller = new GroupEventPoller({
        reader: link.client,
        cursor: channel,
        deliver: channel.deliver,
        onResync: resumeFromSnapshot,
        onStatus: report,
        subscribeVisibility: (listener) => {
          document.addEventListener('visibilitychange', listener);
          return () => document.removeEventListener('visibilitychange', listener);
        },
      });
      pollers.push(poller);
      poller.start();
    }

    return () => {
      controller.abort();
      for (const realtime of realtimes) realtime.stop();
      for (const poller of pollers) poller.stop();
      disconnectGroupState();
      disconnectSettings?.();
      channel.close();
      setGroupRuntime(null);
      operationsStore.getState().idleConnectionLinks();
    };
  }, [
    deviceId,
    groupId,
    installationId,
    linkPlan,
    links,
    materialsCapability,
    mode,
    session,
    settingsCapability,
    syncCapability,
  ]);

  return null;
}

/**
 * What the feeds are built from, as a string a dependency list can compare.
 *
 * The address, whether the link may be followed and how it delivers are the
 * three answers that decide which feed a link gets. A socket's status is
 * deliberately not among them: it changes several times a session and would
 * tear down and rebuild every feed on the device each time.
 */
function describeLinkPlan(links: readonly ControlPlaneLinkState[]): string {
  return links
    .map((link) => `${link.linkId}|${link.baseUrl}|${String(link.admitted)}|${link.delivery}`)
    .join(';');
}

/**
 * Where the object store answers, if this build was told.
 *
 * An environment variable rather than a project-configuration field: the bucket
 * belongs to the same deployment as the control plane the build already points
 * at, and adding a field to `packages/config` would put a second owner on a
 * value that only the material client reads.
 */
function materialStorageOrigin(): string | undefined {
  const configured = process.env.NEXT_PUBLIC_HQ_MATERIAL_STORAGE_ORIGIN;
  return configured === undefined || configured.length === 0 ? undefined : configured;
}
