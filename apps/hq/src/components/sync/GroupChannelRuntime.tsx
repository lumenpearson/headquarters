'use client';

import { useEffect } from 'react';

import { initialRealtimeLinkState } from '@/application/sync/connection';
import type { ControlPlaneSession } from '@/application/sync/ControlPlaneSession';
import { connectGroupSettings } from '@/application/sync/groupSettingsBus';
import { GroupSettingsSync } from '@/application/sync/GroupSettingsSync';
import { mirrorSummary } from '@/application/sync/localMirror';
import type { ControlPlaneClient } from '@/infrastructure/controlPlane/ControlPlaneClient';
import { ControlPlaneGroupChannel } from '@/infrastructure/controlPlane/ControlPlaneGroupChannel';
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
    setGroupRuntime({ groupId, deviceId, channel, settings, materials });

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
        onResync: async (_resync, signal) => {
          /*
           * The resume point fell off the retained log. The snapshot is asked
           * for by document, and the only document this client publishes is
           * live edit; a control plane that has recorded none answers `null`,
           * and the socket then resumes from the oldest sequence still held --
           * which is the most it can honestly claim to have seen.
           */
          const snapshot = await client.getDocumentSnapshot(liveEditDocumentId, signal);
          return snapshot === null ? null : { afterSequence: snapshot.sequence };
        },
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
    } else {
      /*
       * A control plane started without realtime admission serves no socket at
       * all -- the upgrade is refused `403` (`isRealtimeUpgrade`). The session
       * is still in the group and still reads it, on the presence and clock
       * timers, so the link says `POLL` rather than pretending to be live.
       */
      operationsStore
        .getState()
        .patchConnection({ realtime: { ...initialRealtimeLinkState, status: 'polling' } });
    }

    return () => {
      controller.abort();
      realtime?.stop();
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
