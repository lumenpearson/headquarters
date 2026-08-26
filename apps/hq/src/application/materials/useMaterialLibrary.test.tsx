// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GroupChannel } from '@/application/sync/groupChannel';
import { setGroupRuntime } from '@/components/sync/groupRuntimeHolder';
import type { MaterialLibraryClient } from '@/infrastructure/materials/materialLibrary';
import { operationsStore } from '@/state/operationsStore';

import {
  bridgeMaterialLibrary,
  resetBridgeMaterialLibrary,
  useMaterialLibrary,
} from './useMaterialLibrary';

const groupLibrary = { origin: 'group-library' } as unknown as MaterialLibraryClient;

describe('the library a screen holds', () => {
  beforeEach(() => {
    resetBridgeMaterialLibrary();
    setGroupRuntime(null);
    act(() => {
      operationsStore.getState().patchConnection({ mode: 'local-only', capabilities: undefined });
    });
  });

  afterEach(() => {
    setGroupRuntime(null);
    act(() => {
      operationsStore.getState().patchConnection({ mode: 'local-only', capabilities: undefined });
    });
    resetBridgeMaterialLibrary();
  });

  it('is the loopback mirror with no group, and the same instance for every screen', () => {
    const first = renderHook(() => useMaterialLibrary());
    const second = renderHook(() => useMaterialLibrary());

    expect(first.result.current).toBe(bridgeMaterialLibrary());
    // One gRPC-Web transport for the client, not one per mounted screen.
    expect(second.result.current).toBe(first.result.current);
  });

  it('moves to the group library when the session is admitted and the capability is declared', () => {
    const { result } = renderHook(() => useMaterialLibrary());
    expect(result.current.origin).toBe('local-mirror');

    act(() => {
      joinGroup();
    });

    expect(result.current).toBe(groupLibrary);
  });

  it('stays on the mirror when the control plane declares no materials collaborator', () => {
    const { result } = renderHook(() => useMaterialLibrary());

    act(() => {
      joinGroup({ materials: false });
    });

    expect(result.current.origin).toBe('local-mirror');
  });

  it('returns to the mirror the moment the group ends', () => {
    const { result } = renderHook(() => useMaterialLibrary());
    act(() => {
      joinGroup();
    });
    expect(result.current).toBe(groupLibrary);

    act(() => {
      setGroupRuntime(null);
      operationsStore.getState().patchConnection({ mode: 'reauth-required' });
    });

    expect(result.current.origin).toBe('local-mirror');
  });
});

function joinGroup(capabilities: { readonly materials?: boolean } = {}): void {
  setGroupRuntime({
    groupId: 'group',
    deviceId: 'device',
    channel: {} as unknown as GroupChannel,
    settings: null,
    materials: groupLibrary,
  });
  operationsStore.getState().patchConnection({
    mode: 'online',
    capabilities: {
      sync: true,
      deviceLifecycle: true,
      realtimeAdmission: false,
      settings: false,
      materials: capabilities.materials ?? true,
    },
  });
}
