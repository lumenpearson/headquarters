import { createFactorySnapshot } from '@gremuchaya/settings-schema';
import type { SettingValue } from '@gremuchaya/settings-schema';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DocumentSnapshot } from '@/application/sync/groupChannel';
import type { GroupSettingsDocument } from '@/application/sync/groupSettingsPort';
import { groupValuePatches } from '@/application/sync/GroupSettingsSync';

import type { KeyValueStorage } from './DeviceSessionStore';
import {
  type DocumentSnapshotReader,
  GroupSnapshotDownloader,
  groupMirrorDraftStorageKey,
  groupMirrorStorageKey,
  readGroupMirror,
} from './GroupSnapshotDownloader';

/**
 * A storage that can be made to fail on a chosen write, and that records the
 * order of the keys it was asked to write.
 *
 * The order is what a claim about staging rests on: "the working copy is never
 * written before the answer has been checked" is a statement about which key is
 * touched first, and only a storage that remembers can answer it.
 */
class RecordingStorage implements KeyValueStorage {
  readonly entries = new Map<string, string>();
  readonly writes: string[] = [];
  /** After this many successful writes, every further one throws. */
  failAfterWrites = Number.POSITIVE_INFINITY;
  /**
   * A key whose writes are accepted and then dropped.
   *
   * A privacy profile or a storage-blocking extension answers exactly like
   * this: `setItem` returns without complaint and `getItem` reports nothing.
   * A downloader that trusted its own write would promote an answer that is
   * not on the disk at all.
   */
  swallowKey: string | null = null;

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.writes.length >= this.failAfterWrites) {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    }
    this.writes.push(key);
    if (key === this.swallowKey) return;
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }
}

class FakeSnapshots implements DocumentSnapshotReader {
  snapshot: DocumentSnapshot | null = null;
  error: unknown = null;
  calls = 0;

  async getDocumentSnapshot(): Promise<DocumentSnapshot | null> {
    this.calls += 1;
    if (this.error !== null) throw this.error;
    return this.snapshot;
  }
}

function document(
  values: Readonly<Record<string, SettingValue>>,
  revision = 7,
): GroupSettingsDocument {
  return { revision, values, updatedAt: '2026-08-26T09:00:00.000Z' };
}

function snapshotAt(sequence: bigint): DocumentSnapshot {
  return {
    snapshot: new Uint8Array(),
    stateVector: new Uint8Array(),
    sequence,
    documentType: 'settings',
  };
}

let storage: RecordingStorage;
let snapshots: FakeSnapshots;
let clock: number;

function downloader(
  overrides: { readonly groupId?: string; readonly installationId?: string } = {},
) {
  return new GroupSnapshotDownloader({
    groupId: overrides.groupId ?? 'GRP-1',
    installationId: overrides.installationId ?? 'INST-1',
    documents: snapshots,
    storage,
    now: () => clock,
  });
}

/** The copy exactly as it rests on disk, for a byte-for-byte comparison. */
function workingBlob(): string | null {
  return storage.getItem(groupMirrorStorageKey);
}

/** Puts a copy on disk the way one successful refresh would have. */
async function seed(revision = 7, sequence = 12n): Promise<void> {
  snapshots.snapshot = snapshotAt(sequence);
  const outcome = await downloader().absorb(document({ 'telemetry.source': 'native' }, revision));
  expect(outcome).toBe('adopted');
  storage.writes.length = 0;
}

beforeEach(() => {
  storage = new RecordingStorage();
  snapshots = new FakeSnapshots();
  clock = Date.parse('2026-08-26T09:00:00.000Z');
});

describe('GroupSnapshotDownloader seniority', () => {
  it('writes the first copy a machine has ever had', async () => {
    snapshots.snapshot = snapshotAt(12n);

    const outcome = await downloader().absorb(
      document({ 'telemetry.source': 'native', 'layout.density': 'dense' }),
    );

    expect(outcome).toBe('adopted');
    const mirror = readGroupMirror(storage);
    expect(mirror?.revision).toBe(7);
    expect(mirror?.sequence).toBe(12);
    // Only the group's share. 138 of the 154 definitions belong to the
    // machine, and a copy of the group must carry none of them.
    expect(mirror?.values).toEqual({ 'telemetry.source': 'native' });
    expect(mirror?.refreshedAt).toBe('2026-08-26T09:00:00.000Z');
  });

  it('refuses a revision equal to the one already held', async () => {
    await seed(7);
    const before = workingBlob();

    const outcome = await downloader().absorb(document({ 'telemetry.source': 'hybrid' }, 7));

    expect(outcome).toBe('kept');
    expect(workingBlob()).toBe(before);
  });

  it('refuses a revision older than the one already held', async () => {
    await seed(9);
    const before = workingBlob();

    // The case the rule exists for: this client may hold a change of its own
    // that has not reached the server, and an older answer would erase it.
    const outcome = await downloader().absorb(document({ 'telemetry.source': 'hybrid' }, 8));

    expect(outcome).toBe('kept');
    expect(workingBlob()).toBe(before);
  });

  it('takes a strictly newer revision whole', async () => {
    await seed(7);

    const outcome = await downloader().absorb(
      document({ 'telemetry.source': 'hybrid', 'simulation.preset': 'degraded' }, 8),
    );

    expect(outcome).toBe('adopted');
    expect(readGroupMirror(storage)?.values).toEqual({
      'telemetry.source': 'hybrid',
      'simulation.preset': 'degraded',
    });
  });

  it('moves the stamp when the same settings are seen later in the log', async () => {
    await seed(7, 12n);
    snapshots.snapshot = snapshotAt(40n);

    const outcome = await downloader().absorb(document({ 'telemetry.source': 'native' }, 7));

    expect(outcome).toBe('adopted');
    const mirror = readGroupMirror(storage);
    expect(mirror?.revision).toBe(7);
    expect(mirror?.sequence).toBe(40);
  });

  it('does not take an older settings revision on the strength of a newer sequence', async () => {
    await seed(9, 12n);
    const before = workingBlob();
    snapshots.snapshot = snapshotAt(400n);

    const outcome = await downloader().absorb(document({ 'telemetry.source': 'hybrid' }, 8));

    expect(outcome).toBe('kept');
    expect(workingBlob()).toBe(before);
  });

  it('treats a copy of another group as no copy at all', async () => {
    await seed(9);

    // Two groups count their revisions separately, so one is not a ceiling the
    // other has to clear. Revision 1 would be refused for `GRP-1` and is taken
    // for `GRP-2`, which is the whole distinction.
    expect(
      await downloader({ groupId: 'GRP-2' }).absorb(document({ 'telemetry.source': 'hybrid' }, 1)),
    ).toBe('adopted');
    expect(readGroupMirror(storage)?.groupId).toBe('GRP-2');
  });

  it('treats a copy from another database as no copy at all', async () => {
    await seed(9);

    // A database deleted and recreated at the same address starts counting its
    // revisions again, so revision 1 from the new one is not older than
    // revision 9 from the old one -- it is unrelated to it. The connection
    // refuses such a session before it can reach `online`
    // (`installation-changed`); this is the belt to that brace.
    expect(
      await downloader({ installationId: 'INST-2' }).absorb(
        document({ 'telemetry.source': 'hybrid' }, 1),
      ),
    ).toBe('adopted');
    expect(readGroupMirror(storage)?.installationId).toBe('INST-2');
  });
});

describe('GroupSnapshotDownloader refusals', () => {
  it('treats an answer holding no group values as a no-op and not a wipe', async () => {
    await seed(7);
    const before = workingBlob();

    // A control plane whose database was replaced answers for a group that
    // holds nothing. Storing "nothing" would blank every group-scoped setting
    // on the next launch, which is the reset this guard exists to prevent.
    expect(await downloader().absorb(document({}, 99))).toBe('kept');
    expect(workingBlob()).toBe(before);

    expect(await downloader().absorb(document({ 'layout.density': 'dense' }, 99))).toBe('kept');
    expect(workingBlob()).toBe(before);
  });

  it('refuses an answer whose group values all fail their own validators', async () => {
    await seed(7);
    const before = workingBlob();

    const outcome = await downloader().absorb(
      document(
        {
          // `oneOf(['simulation','native','hybrid'])` and
          // `integerWithin(1, 86_400)`.
          'telemetry.source': 'quantum',
          'simulation.periodSeconds': 999_999,
        },
        99,
      ),
    );

    expect(outcome).toBe('refused');
    expect(workingBlob()).toBe(before);
  });

  it('refuses an answer that lost a required field', async () => {
    await seed(7);
    const before = workingBlob();

    const outcome = await downloader().absorb({
      values: { 'telemetry.source': 'hybrid' },
    } as unknown as GroupSettingsDocument);

    expect(outcome).toBe('refused');
    expect(workingBlob()).toBe(before);
  });

  it('refuses a revision that is not a revision', async () => {
    await seed(7);
    const before = workingBlob();

    for (const revision of [Number.NaN, Number.POSITIVE_INFINITY, -1, 7.5]) {
      expect(await downloader().absorb(document({ 'telemetry.source': 'hybrid' }, revision))).toBe(
        'refused',
      );
      expect(workingBlob()).toBe(before);
    }
  });

  it('leaves the copy alone when the download of the log position is cut off', async () => {
    await seed(7);
    const before = workingBlob();
    snapshots.error = new Error('socket hang up');

    const outcome = await downloader().absorb(document({ 'telemetry.source': 'hybrid' }, 8));

    expect(outcome).toBe('unreachable');
    expect(workingBlob()).toBe(before);
    expect(storage.writes).toEqual([]);
  });

  it('drops the one value it cannot read and keeps the rest of a newer answer', async () => {
    await seed(7);

    // The rule `GroupSettingsSync` already applies to the wire, applied to the
    // disk: the group may be running a newer build, and refusing a whole
    // document over one unreadable value would send every other group-scoped
    // setting back to the compiled-in default.
    const outcome = await downloader().absorb(
      document({ 'telemetry.source': 'hybrid', 'simulation.preset': 'нет такого' }, 8),
    );

    expect(outcome).toBe('adopted');
    expect(readGroupMirror(storage)?.values).toEqual({ 'telemetry.source': 'hybrid' });
  });
});

describe('GroupSnapshotDownloader staging', () => {
  it('never writes the working copy before the answer has been checked', async () => {
    await seed(7);
    const before = workingBlob();
    // One write succeeds and every later one throws: a quota reached, a
    // profile that stopped accepting writes mid-refresh. If the candidate went
    // straight to the working key, that first write would be the one that
    // replaced a good copy with an unchecked answer.
    storage.failAfterWrites = 1;

    const outcome = await downloader().absorb(document({ 'telemetry.source': 'hybrid' }, 8));

    expect(outcome).toBe('refused');
    expect(workingBlob()).toBe(before);
    expect(storage.writes).toEqual([groupMirrorDraftStorageKey]);
  });

  it('stages before it promotes, in that order, on the way to a taken answer', async () => {
    await seed(7);

    await downloader().absorb(document({ 'telemetry.source': 'hybrid' }, 8));

    expect(storage.writes).toEqual([groupMirrorDraftStorageKey, groupMirrorStorageKey]);
  });

  it('refuses an answer the storage accepted and did not keep', async () => {
    await seed(7);
    const before = workingBlob();
    storage.swallowKey = groupMirrorDraftStorageKey;

    // The staged answer is read back out of storage rather than trusted from
    // memory, so "the write returned" and "the bytes are there" stay two
    // different claims. Without the read-back this answer would be promoted to
    // the working key on the strength of a write that stored nothing.
    const outcome = await downloader().absorb(document({ 'telemetry.source': 'hybrid' }, 8));

    expect(outcome).toBe('refused');
    expect(workingBlob()).toBe(before);
    expect(storage.writes).toEqual([groupMirrorDraftStorageKey]);
  });

  it('leaves no staged answer behind, whether it was taken or refused', async () => {
    await downloader().absorb(document({ 'telemetry.source': 'native' }, 7));
    expect(storage.getItem(groupMirrorDraftStorageKey)).toBeNull();

    await downloader().absorb(document({ 'telemetry.source': 'quantum' }, 8));
    expect(storage.getItem(groupMirrorDraftStorageKey)).toBeNull();
  });

  it('never reads a staged answer as the copy', async () => {
    await seed(7);
    // What a refresh interrupted between the two writes would leave behind:
    // a newer, perfectly well-formed candidate under the staging key.
    storage.setItem(
      groupMirrorDraftStorageKey,
      JSON.stringify({
        version: 1,
        groupId: 'GRP-1',
        installationId: 'INST-1',
        revision: 99,
        sequence: 99,
        values: { 'telemetry.source': 'hybrid' },
        refreshedAt: '2026-08-26T10:00:00.000Z',
      }),
    );

    expect(readGroupMirror(storage)?.revision).toBe(7);
    expect(readGroupMirror(storage)?.values).toEqual({ 'telemetry.source': 'native' });
  });

  it('reads a blob that is not a copy as no copy, and leaves it where it is', () => {
    storage.setItem(groupMirrorStorageKey, '{ не json');
    expect(readGroupMirror(storage)).toBeNull();
    expect(storage.getItem(groupMirrorStorageKey)).toBe('{ не json');

    storage.setItem(groupMirrorStorageKey, JSON.stringify({ version: 1 }));
    expect(readGroupMirror(storage)).toBeNull();
  });
});

describe('the three levels of seniority', () => {
  it('comes up on the compiled-in constants, then on the local copy', async () => {
    // Level three, and it is the one that already existed: a clean machine
    // with no network has no copy, so nothing is patched over the factory
    // draft and the application comes up on `createFactorySnapshot()`.
    const draft: Record<string, SettingValue> = { ...createFactorySnapshot().values };
    expect(readGroupMirror(storage)).toBeNull();
    expect(groupValuePatches(readGroupMirror(storage)?.values ?? {}, (id) => draft[id])).toEqual(
      [],
    );
    expect(draft['telemetry.source']).toBe('simulation');

    // One successful synchronization, and then the network is gone.
    snapshots.snapshot = snapshotAt(12n);
    expect(await downloader().absorb(document({ 'telemetry.source': 'native' }, 7))).toBe(
      'adopted',
    );

    // Level two: the next launch reads the copy off the disk and joins on what
    // the group last agreed rather than on what the build was compiled with.
    const mirror = readGroupMirror(storage);
    expect(groupValuePatches(mirror?.values ?? {}, (id) => draft[id])).toEqual([
      { id: 'telemetry.source', value: 'native' },
    ]);
  });
});
