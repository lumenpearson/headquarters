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
