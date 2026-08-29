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
    setGroupRuntime({
      groupId: 'group-a',
      deviceId: 'device-a',
      channel,
      delivery: 'socket',
      settings: null,
    });
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

function caseTitle(entityId: string): string | undefined {
  return operationsStore.getState().cases[entityId]?.title;
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

  // R4 tail (F10 task 2, R27 remainder): domain-content edits over the group
  // transport, not only settings.

  it('sends a domain-content edit over the group channel as a content delta', () => {
    const channel = fakeChannel();
    join(channel);
    enableLiveEdit();
    render(<EditModeRuntime />);

    act(() => {
      operationsStore
        .getState()
        .applyContentPatch([{ id: 'case.title', entityId: 'CASE-01', value: 'ДЕЛО / ПРОВЕРЕНО' }]);
    });

    expect(channel.published).toHaveLength(1);
    expect(channel.published[0]?.documentId).toBe(liveEditDocumentId);
    expect(channel.published[0]?.documentType).toBe('content');
  });

  it('applies a content edit the group channel delivers as its own undoable entry', () => {
    const channel = fakeChannel();
    join(channel);
    enableLiveEdit();
    render(<EditModeRuntime />);
    const seedTitle = caseTitle('CASE-01');

    act(() => {
      channel.deliver({
        documentDelta: new TextEncoder().encode(
          JSON.stringify({
            protocol: 1,
            kind: 'content',
            patches: [{ id: 'case.title', entityId: 'CASE-01', value: 'ДЕЛО / СОСЕД' }],
          }),
        ),
      });
    });

    expect(caseTitle('CASE-01')).toBe('ДЕЛО / СОСЕД');
    // Landing a received patch runs the same store action that publishes one,
    // so an unguarded apply would have the two sessions echoing forever.
    expect(channel.published).toEqual([]);

    // The neighbor's edit is its own reversible ledger entry, the same way a
    // local content patch already is: undo reverts it specifically.
    act(() => {
      operationsStore.getState().undoSettingsDraft();
    });
    expect(caseTitle('CASE-01')).toBe(seedTitle);
  });

  it('undoes only the more recent edit when a local one precedes a remote one', () => {
    const channel = fakeChannel();
    join(channel);
    enableLiveEdit();
    render(<EditModeRuntime />);
    const seedTitle = caseTitle('CASE-01');

    act(() => {
      operationsStore
        .getState()
        .applyContentPatch([{ id: 'case.title', entityId: 'CASE-02', value: 'ДЕЛО / МЕСТНОЕ' }]);
    });
    act(() => {
      channel.deliver({
        documentDelta: new TextEncoder().encode(
          JSON.stringify({
            protocol: 1,
            kind: 'content',
            patches: [{ id: 'case.title', entityId: 'CASE-01', value: 'ДЕЛО / СОСЕД' }],
          }),
        ),
      });
    });

    act(() => {
      operationsStore.getState().undoSettingsDraft();
    });

    // The neighbor's edit is undone -- it landed last -- and the local edit
    // that preceded it survives. Before this fix, undo replaced the whole
    // overrides record from the local entry's own snapshot and erased the
    // neighbor's edit outright regardless of order.
    expect(caseTitle('CASE-01')).toBe(seedTitle);
    expect(caseTitle('CASE-02')).toBe('ДЕЛО / МЕСТНОЕ');
  });
});
