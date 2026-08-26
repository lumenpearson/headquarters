'use client';

import { useEffect } from 'react';

import { initialRealtimeLinkState } from '@/application/sync/connection';
import type { ControlPlaneSession } from '@/application/sync/ControlPlaneSession';
import { connectGroupSettings } from '@/application/sync/groupSettingsBus';
import { GroupSettingsSync } from '@/application/sync/GroupSettingsSync';
import type { ControlPlaneClient } from '@/infrastructure/controlPlane/ControlPlaneClient';
import { ControlPlaneGroupChannel } from '@/infrastructure/controlPlane/ControlPlaneGroupChannel';
import { GroupSettingsClient } from '@/infrastructure/controlPlane/GroupSettingsClient';
import { liveEditDocumentId } from '@/infrastructure/controlPlane/GroupLiveEditTransport';
import { RealtimeClient } from '@/infrastructure/controlPlane/RealtimeClient';
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
    setGroupRuntime({ groupId, deviceId, channel, settings });

    let disconnectSettings: (() => void) | undefined;
    if (settings !== null) {
      const sync = new GroupSettingsSync({
        port: settings,
        apply: (patches) => operationsStore.getState().applySettingsPatch(patches),
        readDraftValue: (id) => operationsStore.getState().personalization.draft.values[id],
        onFailure: (failure) => operationsStore.getState().patchConnection({ failure }),
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
  }, [client, deviceId, groupId, mode, realtimeAdmission, session, settingsCapability]);

  return null;
}
