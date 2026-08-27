import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decideReplay, resyncRequiredReason } from './replayDecision.js';

/**
 * The retention edge, isolated from both transports that consult it.
 *
 * The boundary is off by one in the direction that is easy to get wrong: the
 * caller holds `afterSequence` and needs everything above it, so it has lost
 * nothing while `afterSequence + 1` is still retained. The socket and the poll
 * both read this verdict, so a single step in either direction changes what two
 * different clients are told about the same log.
 */
describe('retained replay window', () => {
  it('answers with events while the caller sits exactly on the edge', () => {
    // The oldest retained event is 4, and this caller wants everything after 3.
    // The log can supply all of it: nothing between the cursor and the edge was
    // ever lost, so a snapshot would throw away a history that still exists.
    expect(decideReplay({ afterSequence: 3n, earliestSequence: 4n })).toEqual({
      outcome: 'replay',
    });
  });

  it('requires a resync one step past the edge', () => {
    // Event 4 is gone. Whatever the log still holds starts above the gap, so a
    // page of it would read to the caller as a complete history.
    expect(decideReplay({ afterSequence: 2n, earliestSequence: 4n })).toEqual({
      outcome: 'resync',
      earliestAvailableSequence: 4n,
    });
  });

  it('reads a log that has never been pruned from the beginning', () => {
    expect(decideReplay({ afterSequence: 0n, earliestSequence: 1n })).toEqual({
      outcome: 'replay',
    });
  });

  it('asks for no snapshot when the store reported no edge at all', () => {
    // An absent edge is what a store answers when nothing sits above the
    // cursor: an empty group, or a caller that is already current. Neither is
    // improved by a snapshot, and treating the absence as "everything is gone"
    // would send every up-to-date client to fetch one on every poll.
    for (const afterSequence of [0n, 1n, 10_000n]) {
      expect(decideReplay({ afterSequence, earliestSequence: undefined })).toEqual({
        outcome: 'replay',
      });
    }
  });

  it('stays ahead of the edge for a caller far past it', () => {
    expect(decideReplay({ afterSequence: 900n, earliestSequence: 4n })).toEqual({
      outcome: 'replay',
    });
  });

  it('carries one sentence for every transport that reports the verdict', () => {
    expect(resyncRequiredReason).toBe(
      'retained event history no longer covers the requested sequence',
    );
  });
});

/**
 * That the verdict above is never turned into a log row.
 *
 * `GROUP_EVENT_KIND_SNAPSHOT_REQUIRED` is declared in the contract and decoded
 * by the client, and no line of this control plane sends it — the socket
 * reports the same fact as a `ResyncRequired` frame and the poll as the
 * `resync_required` field of a page. That is a decision, written down beside
 * the enum value in `sync.proto`, and this is the guard on it.
 *
 * A change detector by construction, and that is the whole intent (rule 2.3):
 * it proves nothing about behaviour, and it fails the day a publication is
 * added, so whoever adds one has to say why the contract note no longer holds.
 * The reason it cannot hold as written is that the verdict is about one
 * reader's cursor while a log row is the same for every reader, so a row would
 * either reach readers it does not describe or lengthen the log it complains
 * about.
 */
describe('the group log and the resync verdict', () => {
  it('never publishes the snapshot-required kind from anywhere in this control plane', async () => {
    const mentions = await mentionsOf('SNAPSHOT_REQUIRED');

    // Both surviving mentions are the exhaustive translation of a kind into
    // the text of the `sync_events.kind` column: a decoder for whatever a
    // future client sends, not a publisher. Nothing here builds a draft with
    // this kind, and nothing hands one to the hub or the event store.
    expect(mentions).toEqual([
      { file: 'realtime/eventStore.ts', line: 'case syncV1.GroupEventKind.SNAPSHOT_REQUIRED:' },
      { file: 'realtime/eventStore.ts', line: "return 'SNAPSHOT_REQUIRED';" },
    ]);
  });
});

/**
 * Every mention of a token in the control plane's own source, tests excluded.
 *
 * Tests are excluded because a suite naming a kind is not a deployment sending
 * it — this file names it twice itself.
 */
async function mentionsOf(
  token: string,
): Promise<readonly { readonly file: string; readonly line: string }[]> {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const sources = entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => `${entry.parentPath}/${entry.name}`)
    .sort();

  const mentions: { readonly file: string; readonly line: string }[] = [];
  for (const source of sources) {
    const contents = await readFile(source, 'utf8');
    for (const line of contents.split('\n')) {
      if (!line.includes(token)) continue;
      mentions.push({
        file: source.slice(root.length).replaceAll('\\', '/'),
        line: line.trim(),
      });
    }
  }
  return mentions;
}
