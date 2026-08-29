import type { SettingsPatch } from '@gremuchaya/settings-schema';
import { describe, expect, it } from 'vitest';

import type { ContentPatch } from '@/application/edit/contentFields';
import type {
  DocumentDeltaPublication,
  GroupChannel,
  GroupEventEnvelope,
  GroupSessionCommand,
} from '@/application/sync/groupChannel';
import type { LiveEditPatchSet } from '@/infrastructure/browser/LiveEditBus';

import { createGroupLiveEditTransport, liveEditDocumentId } from './GroupLiveEditTransport';

interface FakeChannel extends GroupChannel {
  readonly published: DocumentDeltaPublication[];
  deliver(event: Partial<GroupEventEnvelope>): void;
  fail(error: Error): void;
}

/**
 * A group channel stated as the log states it, not a spy on one.
 *
 * The claims under test are about what is appended and what is applied, and
 * both of those are the bytes in a delta. A mock counting `publishDocumentDelta`
 * calls would pass while the payload carried nothing a peer could read.
 */
function fakeChannel(deviceId = 'device-a'): FakeChannel {
  const published: DocumentDeltaPublication[] = [];
  const listeners = new Set<(event: GroupEventEnvelope) => void>();
  let failure: Error | null = null;
  return {
    groupId: 'group-a',
    deviceId,
    published,
    fail(error) {
      failure = error;
    },
    async publishDocumentDelta(publication) {
      if (failure !== null) throw failure;
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
        sequence: 1n,
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

/** The bytes another session's settings publication would carry. */
function delta(patches: readonly SettingsPatch[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ protocol: 1, patches }));
}

/** The bytes another session's content publication would carry. */
function contentDelta(patches: readonly ContentPatch[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ protocol: 1, kind: 'content', patches }));
}

describe('createGroupLiveEditTransport', () => {
  it('appends a patch under the live-edit document as a settings delta', () => {
    const channel = fakeChannel();
    const transport = createGroupLiveEditTransport({ channel });

    transport.publish({
      kind: 'settings',
      patches: [{ id: 'layout.density', value: 'comfortable' }],
    });

    expect(channel.published).toHaveLength(1);
    const publication = channel.published[0];
    expect(publication?.documentId).toBe(liveEditDocumentId);
    expect(publication?.documentType).toBe('settings');
    expect(JSON.parse(new TextDecoder().decode(publication?.delta ?? new Uint8Array(0)))).toEqual({
      protocol: 1,
      patches: [{ id: 'layout.density', value: 'comfortable' }],
    });
  });

  it('applies a delta another device appended', () => {
    const channel = fakeChannel();
    const transport = createGroupLiveEditTransport({ channel });
    const received: LiveEditPatchSet[] = [];
    transport.subscribe((patchSet) => received.push(patchSet));

    channel.deliver({ documentDelta: delta([{ id: 'layout.density', value: 'comfortable' }]) });

    expect(received).toEqual([
      { kind: 'settings', patches: [{ id: 'layout.density', value: 'comfortable' }] },
    ]);
  });

  it('ignores the echo of its own append', () => {
    const channel = fakeChannel('device-a');
    const transport = createGroupLiveEditTransport({ channel });
    const received: LiveEditPatchSet[] = [];
    transport.subscribe((patchSet) => received.push(patchSet));

    channel.deliver({
      actorDeviceId: 'device-a',
      documentDelta: delta([{ id: 'layout.density', value: 'comfortable' }]),
    });

    expect(received).toEqual([]);
  });

  it('ignores a delta appended under another document', () => {
    const channel = fakeChannel();
    const transport = createGroupLiveEditTransport({ channel });
    const received: LiveEditPatchSet[] = [];
    transport.subscribe((patchSet) => received.push(patchSet));

    channel.deliver({
      documentId: 'layout.tiles',
      documentDelta: delta([{ id: 'layout.density', value: 'comfortable' }]),
    });

    expect(received).toEqual([]);
  });

  it('drops an inbound value its own definition rejects and keeps the rest', () => {
    const channel = fakeChannel();
    const transport = createGroupLiveEditTransport({ channel });
    const received: LiveEditPatchSet[] = [];
    transport.subscribe((patchSet) => received.push(patchSet));

    channel.deliver({
      documentDelta: delta([
        { id: 'layout.density', value: 'not-a-density' },
        { id: 'settings.unknown.identifier', value: 1 },
        { id: 'layout.density', value: 'comfortable' },
      ]),
    });

    expect(received).toEqual([
      { kind: 'settings', patches: [{ id: 'layout.density', value: 'comfortable' }] },
    ]);
  });

  it('reports a refused publication instead of losing it', async () => {
    const channel = fakeChannel();
    const failures: unknown[] = [];
    const transport = createGroupLiveEditTransport({
      channel,
      onPublishFailed: (error) => failures.push(error),
    });
    channel.fail(new Error('A viewer cannot publish to the group.'));

    transport.publish({
      kind: 'settings',
      patches: [{ id: 'layout.density', value: 'comfortable' }],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(failures).toHaveLength(1);
  });

  it('stops publishing and listening once closed', () => {
    const channel = fakeChannel();
    const transport = createGroupLiveEditTransport({ channel });
    const received: LiveEditPatchSet[] = [];
    transport.subscribe((patchSet) => received.push(patchSet));

    transport.close();
    transport.publish({
      kind: 'settings',
      patches: [{ id: 'layout.density', value: 'comfortable' }],
    });
    channel.deliver({ documentDelta: delta([{ id: 'layout.density', value: 'comfortable' }]) });

    expect(channel.published).toEqual([]);
    expect(received).toEqual([]);
  });

  // R4: domain-content edits (F10, remainder of R27).

  it('appends a content patch under the live-edit document, kinded and documentType content', () => {
    const channel = fakeChannel();
    const transport = createGroupLiveEditTransport({ channel });

    transport.publish({
      kind: 'content',
      patches: [{ id: 'case.title', entityId: 'CASE-01', value: 'ДЕЛО / ПРОВЕРЕНО' }],
    });

    expect(channel.published).toHaveLength(1);
    const publication = channel.published[0];
    expect(publication?.documentId).toBe(liveEditDocumentId);
    expect(publication?.documentType).toBe('content');
    expect(JSON.parse(new TextDecoder().decode(publication?.delta ?? new Uint8Array(0)))).toEqual({
      protocol: 1,
      kind: 'content',
      patches: [{ id: 'case.title', entityId: 'CASE-01', value: 'ДЕЛО / ПРОВЕРЕНО' }],
    });
  });

  it('applies a content delta another device appended', () => {
    const channel = fakeChannel();
    const transport = createGroupLiveEditTransport({ channel });
    const received: LiveEditPatchSet[] = [];
    transport.subscribe((patchSet) => received.push(patchSet));

    channel.deliver({
      documentDelta: contentDelta([
        { id: 'case.title', entityId: 'CASE-01', value: 'ДЕЛО / ПРОВЕРЕНО' },
      ]),
    });

    expect(received).toEqual([
      {
        kind: 'content',
        patches: [{ id: 'case.title', entityId: 'CASE-01', value: 'ДЕЛО / ПРОВЕРЕНО' }],
      },
    ]);
  });

  it('drops a content patch naming an unknown field or an unseeded entity', () => {
    const channel = fakeChannel();
    const transport = createGroupLiveEditTransport({ channel });
    const received: LiveEditPatchSet[] = [];
    transport.subscribe((patchSet) => received.push(patchSet));

    channel.deliver({
      documentDelta: contentDelta([
        { id: 'content.no-such-field', entityId: 'CASE-01', value: 'x' },
        { id: 'case.title', entityId: 'CASE-NO-SUCH', value: 'x' },
        { id: 'case.title', entityId: 'CASE-01', value: 'ДЕЛО / ПРОВЕРЕНО' },
      ]),
    });

    expect(received).toEqual([
      {
        kind: 'content',
        patches: [{ id: 'case.title', entityId: 'CASE-01', value: 'ДЕЛО / ПРОВЕРЕНО' }],
      },
    ]);
  });
});
