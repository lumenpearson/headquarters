/**
 * The retention edge, decided once for every transport that answers a resume.
 *
 * A client resumes the group log in two ways: a socket says "push what arrives
 * after N" (`WatchGroup` through the realtime hub) and a poll says "give me
 * the page after N" (`ReadGroupEvents`). Both have to answer the same question
 * before they answer anything else — is N still inside the retained window —
 * and both have to answer it the same way, because a deployment serving both at
 * once would otherwise tell one client to take a snapshot and hand the other a
 * partial history it would mistake for a complete one.
 *
 * This module is that question and nothing else: no store, no socket, no
 * protobuf. The two call sites differ only in how they report the outcome, a
 * `ResyncRequired` frame on one side and a response field on the other.
 */

/** The oldest sequence a group still retains, as the store reports it. */
export interface RetainedWindow {
  /** The sequence the caller already holds; zero means "from the beginning". */
  readonly afterSequence: bigint;
  /**
   * The oldest sequence the store still holds for the group, or `undefined`
   * when it reported no edge. An absent edge means nothing sits above the
   * cursor, which no snapshot would improve.
   */
  readonly earliestSequence: bigint | undefined;
}

export type ReplayDecision =
  | { readonly outcome: 'replay' }
  | { readonly outcome: 'resync'; readonly earliestAvailableSequence: bigint };

/**
 * Why the caller was told to take a snapshot. Kept beside the decision so the
 * socket frame and any future transport quote one sentence rather than two.
 */
export const resyncRequiredReason =
  'retained event history no longer covers the requested sequence';

/**
 * Decides whether a resume point is still answerable from the log.
 *
 * The comparison is `afterSequence < earliestSequence - 1`, not `<=` and not
 * `<` against `earliestSequence` itself: the caller holds `afterSequence` and
 * wants everything above it, so the first event it still needs is
 * `afterSequence + 1`. A caller sitting exactly one below the oldest retained
 * event has lost nothing, and telling it to fetch a snapshot would throw away
 * a history the log can still supply. One step further back and the events
 * between are gone for good, which no page size can repair.
 */
export function decideReplay(window: RetainedWindow): ReplayDecision {
  const { earliestSequence } = window;
  if (earliestSequence === undefined) return { outcome: 'replay' };
  if (window.afterSequence < earliestSequence - 1n) {
    return { outcome: 'resync', earliestAvailableSequence: earliestSequence };
  }
  return { outcome: 'replay' };
}
