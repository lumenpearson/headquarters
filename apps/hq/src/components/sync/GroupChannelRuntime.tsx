'use client';

import { useEffect } from 'react';

import { initialRealtimeLinkState } from '@/application/sync/connection';
import type { ControlPlaneSession } from '@/application/sync/ControlPlaneSession';
import { connectGroupSettings } from '@/application/sync/groupSettingsBus';
import { GroupSettingsSync } from '@/application/sync/GroupSettingsSync';
import { mirrorSummary } from '@/application/sync/localMirror';
import type { ControlPlaneClient } from '@/infrastructure/controlPlane/ControlPlaneClient';
import { ControlPlaneGroupChannel } from '@/infrastructure/controlPlane/ControlPlaneGroupChannel';
import { GroupEventPoller } from '@/infrastructure/controlPlane/GroupEventPoller';
import { GroupSettingsClient } from '@/infrastructure/controlPlane/GroupSettingsClient';
import { liveEditDocumentId } from '@/infrastructure/controlPlane/GroupLiveEditTransport';
import { GroupSnapshotDownloader } from '@/infrastructure/controlPlane/GroupSnapshotDownloader';
import { RealtimeClient } from '@/infrastructure/controlPlane/RealtimeClient';
import { ControlPlaneMaterialClient } from '@/infrastructure/materials/ControlPlaneMaterialClient';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

import { setGroupRuntime } from './groupRuntimeHolder';

interface GroupChannelRuntimeProps {
  readonly client: ControlPlaneClient;
  readonly session: ControlPlaneSession;
}

/**
 * The group's realtime socket, event channel and settings, while it is joined.
 *
 * Separated from `ControlPlaneRuntime` because the two have different
 * lifetimes. The session outlives every failure -- it is what turns a refused
 * call back into `reauth-required` -- while the channel exists only between
 * `JoinGroup` succeeding and the session ending, and a socket kept open across
 * that boundary is a socket the server has already stopped believing in.
 *
 * It renders nothing. What it owns is a socket, two collaborators and the
 * holder every other surface reads them from.
 */
export function GroupChannelRuntime({ client, session }: GroupChannelRuntimeProps) {
  const mode = useOperationsStore((state) => state.connection.mode);
  const groupId = useOperationsStore((state) => state.connection.session?.groupId ?? '');
  const deviceId = useOperationsStore((state) => state.connection.session?.deviceId ?? '');
  const realtimeAdmission = useOperationsStore(
    (state) => state.connection.capabilities?.realtimeAdmission ?? false,
  );
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

  useEffect(() => {
    if (mode !== 'online' || groupId === '' || deviceId === '') {
      setGroupRuntime(null);
      operationsStore.getState().patchConnection({ realtime: initialRealtimeLinkState });
      return;
    }
    const controller = new AbortController();
    const channel = new ControlPlaneGroupChannel({ port: client, groupId, deviceId });
    /*
     * The settings client shares the session's transport rather than building
     * one: the bearer interceptor reads the token per call, and a second
     * transport would be a second place for that rule to drift. Absent when a
     * test injected RPC clients, which is also when there is no settings
     * service to reach.
     */
    const transport = client.transport;
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
     * A control plane that admits no realtime socket is still followed, by
     * reading the durable log instead of being pushed to. The label is what a
     * surface downstream acts on -- `VideoScreen` widens the playback lead for
     * it -- so it is decided once, here, beside the transport it describes.
     */
    const delivery = realtimeAdmission ? 'socket' : 'poll';
    setGroupRuntime({ groupId, deviceId, channel, delivery, settings, materials });

    /*
     * The resume point when the retained log no longer covers the cursor. One
     * function for both transports: the socket reports the verdict as a
     * `ResyncRequired` frame and the feed as the `resync_required` field of a
     * page, but what follows is the same snapshot call, and two copies of it
     * would be two places for the document identifier to drift.
     *
     * The only document this client publishes is live edit; a control plane
     * that has recorded no snapshot answers `null`, and both transports then
     * resume from the oldest sequence still held -- which is the most either
     * can honestly claim to have seen.
     */
    const resumeFromSnapshot = async (
      _resync: unknown,
      signal: AbortSignal,
    ): Promise<{ readonly afterSequence: bigint } | null> => {
      const snapshot = await client.getDocumentSnapshot(liveEditDocumentId, signal);
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
        ...(syncCapability ? { documents: client } : {}),
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

    let realtime: RealtimeClient | null = null;
    if (realtimeAdmission) {
      realtime = new RealtimeClient({
        baseUrl: client.baseUrl,
        identity: () => client.realtimeIdentity(),
        onEvent: channel.deliver,
        // The channel owns the group's position, because the group has one
        // order and may come to have more than one transport carrying it.
        cursor: channel,
        onStatus: (state) => operationsStore.getState().patchConnection({ realtime: state }),
        onResync: resumeFromSnapshot,
        onReauthenticationRequired: () => {
          /*
           * The server closed the socket because the triple no longer checks
           * out. Rotating the token and dialling again is the only recovery
           * that is not a loop; a refusal leaves the session service to move
           * the mode to `reauth-required`, and this effect unmounts with it.
           */
          void session.ensureFreshSession().then((fresh) => {
            if (fresh && !controller.signal.aborted) realtime?.start();
          });
        },
      });
      realtime.start();
    }

    /*
     * A control plane started without realtime admission serves no socket at
     * all -- the upgrade is refused `403` (`isRealtimeUpgrade`) -- and on a
     * deployment whose instances do not share a listener map it could not serve
     * a useful one anyway. The group log is still there and still durable, so
     * the session follows it by asking: `ReadGroupEvents` needs no hub.
     *
     * The feed hands its pages to `channel.deliver` and reads its position from
     * the same channel, so an event that arrived by both paths is applied once.
     * Without `SyncService` there is no log to read and no poller is built; the
     * link still says `POLL`, because the session is in the group and reads it
     * on the presence and clock timers, and saying `LIVE` would claim a
     * promptness that is not there.
     */
    let poller: GroupEventPoller | null = null;
    if (!realtimeAdmission) {
      operationsStore
        .getState()
        .patchConnection({ realtime: { ...initialRealtimeLinkState, status: 'polling' } });
      if (syncCapability) {
        poller = new GroupEventPoller({
          reader: client,
          cursor: channel,
          deliver: channel.deliver,
          onResync: resumeFromSnapshot,
          onStatus: (state) => operationsStore.getState().patchConnection({ realtime: state }),
          subscribeVisibility: (listener) => {
            document.addEventListener('visibilitychange', listener);
            return () => document.removeEventListener('visibilitychange', listener);
          },
        });
        poller.start();
      }
    }

    return () => {
      controller.abort();
      realtime?.stop();
      poller?.stop();
      disconnectSettings?.();
      channel.close();
      setGroupRuntime(null);
      operationsStore.getState().patchConnection({ realtime: initialRealtimeLinkState });
    };
  }, [
    client,
    deviceId,
    groupId,
    installationId,
    materialsCapability,
    mode,
    realtimeAdmission,
    session,
    settingsCapability,
    syncCapability,
  ]);

  return null;
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
