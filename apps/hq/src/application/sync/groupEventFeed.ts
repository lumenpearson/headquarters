/**
 * When the group's log is read next, and how far ahead a command taken from it
 * has to be scheduled (F14, stage 6).
 *
 * Everything here is a pure function of a state value. It owns no timer, no
 * transport and no `document`: a cadence hidden inside a `setInterval` is a
 * cadence nobody can read back or test, and this one answers to a billing
 * ceiling rather than to taste, so it has to be legible. `GroupEventPoller`
 * supplies the clock and the socket-less transport; this decides what it does.
 *
 * The reason the feed exists at all is that `WatchGroup` needs the realtime
 * hub's process-local listener set, and a deployment that answers one request
 * on one instance and the next on another cannot keep one. `ReadGroupEvents`
 * needs no hub, so the log stays readable where the socket cannot exist.
 */

import type { GroupEventEnvelope } from './groupChannel';

/** How the group's events reach this session. */
export type GroupEventDelivery =
  /** The realtime socket, pushing as events are appended. */
  | 'socket'
  /** Unary `ReadGroupEvents`, on the cadence below. */
  | 'poll';

/**
 * One page of the group log, as the application reasons about it.
 *
 * The four fields are `ReadGroupEventsResponse`, converted in infrastructure.
 * `resyncRequired` is the server's verdict and is followed rather than
 * re-derived: the retention rule lives in the control plane's
 * `realtime/replayDecision.ts`, is called by both the hub and this method, and
 * a client recomputing it from `earliestAvailableSequence` would be a second
 * copy of it that could drift.
 */
export interface GroupEventPage {
  readonly events: readonly GroupEventEnvelope[];
  /** The oldest sequence the group still retains, or `0n` when it reported none. */
  readonly earliestAvailableSequence: bigint;
  /** The log holds something beyond the last event of this page. */
  readonly hasMore: boolean;
  /** The retained window no longer covers the requested cursor. */
  readonly resyncRequired: boolean;
}

/**
 * What one tick of the feed came back with.
 *
 * A named verdict rather than a bag of booleans, because the four cases lead
 * to three different cadences and the difference between them is the whole
 * content of this module.
 */
export type GroupPollOutcome =
  /** The page carried events. `hasMore` is the server's, not the page length. */
  | { readonly kind: 'applied'; readonly hasMore: boolean }
  /** The page was empty: the group has said nothing since the cursor. */
  | { readonly kind: 'quiet' }
  /** The call did not answer, or answered a refusal. Nothing was applied. */
  | { readonly kind: 'failed' }
  /** The window no longer covered the cursor, and the cursor was moved. */
  | { readonly kind: 'resynced' };

export interface GroupPollState {
  /** What the document last reported. Read from `visibilitychange`, not guessed. */
  readonly visible: boolean;
  /**
   * How many ticks in a row brought nothing back, capped at the last threshold
   * so a session left open overnight does not carry an unbounded counter.
   */
  readonly quietPolls: number;
  /** The log is known to hold more, so the next page is due immediately. */
  readonly catchingUp: boolean;
}

/**
 * The cadence, and why each number is the number it is.
 *
 * The Hobby plan allows a million function invocations a month, and every tick
 * is one (`docs/release/environment.md`). At 5 s a client spends 12 a minute,
 * which a shoot fits inside; at 2 s it spends 30 and does not. So 5 s is a
 * ceiling imposed by the tariff and not a preference, and everything below is
 * how the feed spends less than that when it can.
 */
export const groupPollCadence = {
  /** The visible tab's interval. Also the interval a playback lead must cover. */
  foregroundMs: 5_000,
  /** A hidden tab is not being watched, so it can afford to hear late. */
  hiddenMs: 15_000,
  /** Where a hidden, quiet feed settles first. */
  idleFloorMs: 30_000,
  /** And where it settles when the group has been silent for minutes. */
  idleCeilingMs: 60_000,
  /**
   * Four quiet ticks at 15 s is one minute of silence, after which the hidden
   * feed halves its rate; eight ticks -- one minute at 15 s plus two at 30 s --
   * is three minutes, after which it halves again. The thresholds are counted
   * in ticks rather than seconds because a tick is what costs an invocation,
   * and the counter resets on the first page that carries anything, so a group
   * that starts talking is heard at full speed on the next tick.
   */
  quietPollsBeforeFloor: 4,
  quietPollsBeforeCeiling: 8,
} as const;

/**
 * The lead a command needs when it travels by polling rather than by socket.
 *
 * `PlaybackSyncCoordinator` schedules every command for `executeAtMs` and every
 * screen computes `executeAtMs - now`, so screens converge only while that
 * instant is still ahead of the slowest of them. The socket's 40 ms covers a
 * push; a page read every 5 s does not arrive within 40 ms of the append, and a
 * screen handed a command whose instant has already passed runs it on arrival
 * -- which is a different moment on every screen, and exactly the divergence
 * the lead exists to prevent. One second above the foreground cadence covers
 * the tick plus the round trip that carried it.
 */
export const pollingPlaybackLeadMs = groupPollCadence.foregroundMs + 1_000;

/** The state a feed starts in. Nothing is known to be pending, so it polls at once. */
export function initialGroupPollState(visible: boolean): GroupPollState {
  return { visible, quietPolls: 0, catchingUp: true };
}

/**
 * How long until the next tick.
 *
 * A visible tab always pays the foreground cadence and never enters the idle
 * window. That is deliberate and is the one place this feed spends rather than
 * saves: a visible tab is the one an operator is looking at and the one a
 * playback command has to reach inside {@link pollingPlaybackLeadMs}, and a
 * lead covering a 60 s idle interval would not be a lead. The saving is taken
 * from the hidden tab instead, which is showing nobody anything.
 */
export function groupPollDelayMs(state: GroupPollState): number {
  if (state.catchingUp) return 0;
  if (state.visible) return groupPollCadence.foregroundMs;
  if (state.quietPolls >= groupPollCadence.quietPollsBeforeCeiling) {
    return groupPollCadence.idleCeilingMs;
  }
  if (state.quietPolls >= groupPollCadence.quietPollsBeforeFloor) {
    return groupPollCadence.idleFloorMs;
  }
  return groupPollCadence.hiddenMs;
}

/**
 * The state after one tick.
 *
 * A failed call advances the quiet counter alongside an empty page. The two are
 * different facts about the group but the same fact about the budget: a control
 * plane answering a refusal spends an invocation exactly as an empty page does,
 * and a feed that hammered a failing address at full speed would spend the
 * month's allowance on refusals. Nothing is lost by backing off, because the
 * counter resets the moment a page carries anything.
 */
export function nextGroupPollState(
  state: GroupPollState,
  outcome: GroupPollOutcome,
): GroupPollState {
  switch (outcome.kind) {
    case 'applied':
      return { ...state, quietPolls: 0, catchingUp: outcome.hasMore };
    case 'resynced':
      // The cursor moved to the snapshot's position, so there is a page waiting
      // at the new one; asking for it on the ordinary cadence would leave the
      // session minutes behind the group it has just resynchronized with.
      return { ...state, quietPolls: 0, catchingUp: true };
    case 'quiet':
    case 'failed':
      return {
        ...state,
        quietPolls: Math.min(state.quietPolls + 1, groupPollCadence.quietPollsBeforeCeiling),
        catchingUp: false,
      };
  }
}

/**
 * The state after the document changed visibility.
 *
 * Becoming visible clears the quiet counter as well as the flag. The feed is
 * about to pay the foreground cadence either way, and carrying the counter
 * across would drop the tab straight back into the idle window the instant it
 * is hidden again, without a single quiet tick in between to justify it.
 */
export function withGroupPollVisibility(state: GroupPollState, visible: boolean): GroupPollState {
  if (state.visible === visible) return state;
  return visible ? { ...state, visible, quietPolls: 0 } : { ...state, visible };
}

/**
 * The execution lead this delivery path needs, given what the operator set.
 *
 * `performance.playbackLeadMs` stays the floor rather than the answer: an
 * operator who raised it for a slow display keeps the higher value, and one who
 * left it alone still gets a command that lands ahead of its own instant on
 * every screen the poll feeds.
 */
export function playbackLeadForDelivery(
  delivery: GroupEventDelivery,
  configuredLeadMs: number,
): number {
  return delivery === 'poll' ? Math.max(configuredLeadMs, pollingPlaybackLeadMs) : configuredLeadMs;
}
