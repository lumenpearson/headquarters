'use client';

import { useSyncExternalStore } from 'react';

import {
  currentGroupRuntime,
  noGroupRuntime,
  subscribeGroupRuntime,
} from '@/components/sync/groupRuntimeHolder';
import { BridgeMaterialClient } from '@/infrastructure/materials/BridgeMaterialClient';
import {
  selectMaterialLibrary,
  type MaterialLibraryClient,
} from '@/infrastructure/materials/materialLibrary';
import { useOperationsStore } from '@/state/operationsStore';

let bridge: BridgeMaterialClient | null = null;

/**
 * The loopback mirror, built once for the whole client.
 *
 * It used to be a `useMemo` in each screen, which meant one gRPC-Web transport
 * per mounted screen and a fresh one after every remount. Built lazily rather
 * than at module scope because this module is also imported where there is no
 * DOM: the static export renders these screens with no window at all.
 */
export function bridgeMaterialLibrary(): BridgeMaterialClient {
  bridge ??= new BridgeMaterialClient();
  return bridge;
}

/** Test seam: the next call to `bridgeMaterialLibrary` builds a new one. */
export function resetBridgeMaterialLibrary(): void {
  bridge = null;
}

/**
 * The library this screen reads and writes (R1, R2).
 *
 * One hook, so `FilesScreen` and `VideoScreen` hold a library rather than a
 * bridge and the choice between the two is taken in one place. The group
 * handle is external state -- it appears with `JoinGroup` and disappears with
 * the session, neither of which is a render -- so it is read the way
 * `VideoScreen` already reads the group, and the two connection facts come
 * from the store slice `ControlPlaneSession` owns.
 */
export function useMaterialLibrary(): MaterialLibraryClient {
  const group = useSyncExternalStore(subscribeGroupRuntime, currentGroupRuntime, noGroupRuntime);
  const online = useOperationsStore((state) => state.connection.mode === 'online');
  const materialsCapability = useOperationsStore(
    (state) => state.connection.capabilities?.materials ?? false,
  );
  return selectMaterialLibrary({
    bridge: bridgeMaterialLibrary(),
    group: group?.materials ?? null,
    online,
    materialsCapability,
  });
}
