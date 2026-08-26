// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  DocumentDeltaPublication,
  DocumentDeltaReceipt,
  GroupChannel,
  GroupEventEnvelope,
  GroupSessionCommand,
} from '@/application/sync/groupChannel';
import { EditModeRuntime } from '@/components/edit/EditModeRuntime';
import { liveEditDocumentId } from '@/infrastructure/controlPlane/GroupLiveEditTransport';
import { operationsStore } from '@/state/operationsStore';

import { setGroupRuntime } from './groupRuntimeHolder';

interface FakeChannel extends GroupChannel {
  readonly published: DocumentDeltaPublication[];
  /** Plays the part of the realtime socket handing an event to the channel. */
  deliver(event: Partial<GroupEventEnvelope>): void;
}

/**
 * A group channel, so the claim under test is which wire a patch left by.
 *
 * `EditModeRuntime` is rendered with no `transport` prop -- exactly as the
 * application mounts it -- because the claim is about the choice the component
 * makes, and a transport handed in would make that choice for it.
 */
function fakeChannel(): FakeChannel {
  const published: DocumentDeltaPublication[] = [];
  const listeners = new Set<(event: GroupEventEnvelope) => void>();
  return {
    groupId: 'group-a',
    deviceId: 'device-a',
    published,
    async publishDocumentDelta(publication): Promise<DocumentDeltaReceipt> {
      published.push(publication);
      return { sequence: BigInt(published.length), stateVector: new Uint8Array(0) };
    },
    async publishSessionCommand(): Promise<GroupSessionCommand> {
      throw new Error('not used');
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    deliver(event) {
      const envelope: GroupEventEnvelope = {
        sequence: 5n,
        kind: 'document-delta',
        actorDeviceId: 'device-b',
        documentId: liveEditDocumentId,
        documentDelta: new Uint8Array(0),
        hybridLogicalClock: 0n,
        occurredAt: '2026-08-26T09:00:00.000Z',
        ...event,
      };
      for (const listener of [...listeners]) listener(envelope);
    },
  };
}

function join(channel: GroupChannel): void {
  act(() => {
    setGroupRuntime({ groupId: 'group-a', deviceId: 'device-a', channel, settings: null });
  });
}

function enableLiveEdit(): void {
  act(() => {
    operationsStore.getState().applySettingsPatch([{ id: 'advanced.liveEdit', value: true }]);
  });
}

function patchDensity(value: string): void {
  act(() => {
    operationsStore.getState().applySettingsPatch([{ id: 'layout.density', value }]);
  });
}

function density(): unknown {
  return operationsStore.getState().personalization.draft.values['layout.density'];
}

describe('live edit transport selection', () => {
  beforeEach(() => {
    // `resetWorld` rebuilds from `createBaseState`, so the draft comes back at
    // the schema defaults and no opt-in survives from an earlier test.
    operationsStore.getState().resetWorld();
    operationsStore.getState().exitEditMode();
    setGroupRuntime(null);
  });

  afterEach(() => {
    setGroupRuntime(null);
  });

  it('sends an edit over the group channel while a session is admitted', () => {
    const channel = fakeChannel();
    join(channel);
    enableLiveEdit();
    render(<EditModeRuntime />);

    patchDensity('comfortable');

    expect(channel.published).toHaveLength(1);
    expect(channel.published[0]?.documentId).toBe(liveEditDocumentId);
    expect(channel.published[0]?.documentType).toBe('settings');
  });

  it('opens no group channel at all while the group has not enabled live edit', () => {
    const channel = fakeChannel();
    join(channel);
    render(<EditModeRuntime />);

    patchDensity('comfortable');

    expect(channel.published).toEqual([]);
  });

  it('stops using the group channel the moment the session leaves the group', () => {
    const channel = fakeChannel();
    join(channel);
    enableLiveEdit();
    render(<EditModeRuntime />);

    patchDensity('comfortable');
    expect(channel.published).toHaveLength(1);

    act(() => {
      setGroupRuntime(null);
    });
    patchDensity('dense');

    // The browser bus took over; nothing further reached the group.
    expect(channel.published).toHaveLength(1);
  });

  it('applies a patch the group channel delivers, and does not echo it back', () => {
    const channel = fakeChannel();
    join(channel);
    enableLiveEdit();
    render(<EditModeRuntime />);

    act(() => {
      channel.deliver({
        documentDelta: new TextEncoder().encode(
          JSON.stringify({
            protocol: 1,
            patches: [{ id: 'layout.density', value: 'comfortable' }],
          }),
        ),
      });
    });

    expect(density()).toBe('comfortable');
    expect(channel.published).toEqual([]);
  });

  it('refuses a delivered value its own definition rejects', () => {
    const channel = fakeChannel();
    join(channel);
    enableLiveEdit();
    render(<EditModeRuntime />);

    act(() => {
      channel.deliver({
        documentDelta: new TextEncoder().encode(
          JSON.stringify({ protocol: 1, patches: [{ id: 'layout.density', value: 'enormous' }] }),
        ),
      });
    });

    expect(density()).toBe('dense');
  });
});
