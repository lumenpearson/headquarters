import { describe, expect, it } from 'vitest';

import {
  groupPollCadence,
  groupPollDelayMs,
  initialGroupPollState,
  nextGroupPollState,
  playbackLeadForDelivery,
  pollingPlaybackLeadMs,
  withGroupPollVisibility,
  type GroupPollOutcome,
  type GroupPollState,
} from './groupEventFeed';

/**
 * The cadence is a billing decision before it is an engineering one, so what
 * these tests hold it to is the arithmetic in `docs/release/environment.md`:
 * one invocation per tick, a million a month on the Hobby plan.
 *
 * They run on values rather than on a clock deliberately. A cadence that can
 * only be observed by waiting is a cadence nobody can read back, and this one
 * has to be readable -- it is why the decision lives in the application layer
 * and not inside `GroupEventPoller`'s timer.
 */
function state(overrides: Partial<GroupPollState> = {}): GroupPollState {
  return { visible: true, quietPolls: 0, catchingUp: false, ...overrides };
}

function drive(from: GroupPollState, outcomes: readonly GroupPollOutcome[]): GroupPollState {
  return outcomes.reduce(nextGroupPollState, from);
}

const quiet: GroupPollOutcome = { kind: 'quiet' };
const failed: GroupPollOutcome = { kind: 'failed' };

describe('group event feed cadence', () => {
  it('polls at once when it starts, so joining a group catches up now', () => {
    expect(groupPollDelayMs(initialGroupPollState(true))).toBe(0);
    expect(groupPollDelayMs(initialGroupPollState(false))).toBe(0);
  });

  it('pays the foreground cadence the invocation budget was written against', () => {
    expect(groupPollDelayMs(state())).toBe(5_000);
    expect(groupPollCadence.foregroundMs).toBe(5_000);
  });

  it('slows to the hidden cadence when the tab goes dark', () => {
    const hidden = withGroupPollVisibility(state(), false);
    expect(groupPollDelayMs(hidden)).toBe(15_000);
  });

  it('backs off a hidden feed after a minute of silence and again after three', () => {
    const hidden = withGroupPollVisibility(state(), false);

    // Four quiet ticks at 15 s is one minute; eight is that minute plus two
    // ticks at 30 s. Both thresholds are counted in ticks because a tick is
    // what costs an invocation.
    expect(groupPollDelayMs(drive(hidden, [quiet, quiet, quiet]))).toBe(15_000);
    expect(groupPollDelayMs(drive(hidden, [quiet, quiet, quiet, quiet]))).toBe(30_000);
    expect(groupPollDelayMs(drive(hidden, Array<GroupPollOutcome>(7).fill(quiet)))).toBe(30_000);
    expect(groupPollDelayMs(drive(hidden, Array<GroupPollOutcome>(8).fill(quiet)))).toBe(60_000);
  });

  it('never lets the counter run past the last threshold', () => {
    const hidden = withGroupPollVisibility(state(), false);
    const overnight = drive(hidden, Array<GroupPollOutcome>(5_000).fill(quiet));

    expect(overnight.quietPolls).toBe(groupPollCadence.quietPollsBeforeCeiling);
    expect(groupPollDelayMs(overnight)).toBe(60_000);
  });

  it('returns to the fast cadence on the first page that carries anything', () => {
    const idle = drive(
      withGroupPollVisibility(state(), false),
      Array<GroupPollOutcome>(9).fill(quiet),
    );
    expect(groupPollDelayMs(idle)).toBe(60_000);

    const heard = nextGroupPollState(idle, { kind: 'applied', hasMore: false });

    expect(heard.quietPolls).toBe(0);
    expect(groupPollDelayMs(heard)).toBe(15_000);
  });

  it('asks for the next page immediately while the log says there is more', () => {
    const catchingUp = nextGroupPollState(state(), { kind: 'applied', hasMore: true });

    expect(groupPollDelayMs(catchingUp)).toBe(0);
    // And stops the moment the log says it has caught up.
    expect(
      groupPollDelayMs(nextGroupPollState(catchingUp, { kind: 'applied', hasMore: false })),
    ).toBe(5_000);
  });

  it('reads the page waiting at the position a resync moved the cursor to', () => {
    expect(groupPollDelayMs(nextGroupPollState(state(), { kind: 'resynced' }))).toBe(0);
  });

  it('backs a hidden feed off a control plane that keeps refusing', () => {
    // A refusal spends an invocation exactly as an empty page does, so it moves
    // the same counter. Nothing is lost: the first page that carries anything
    // resets it.
    const hidden = withGroupPollVisibility(state(), false);
    expect(groupPollDelayMs(drive(hidden, Array<GroupPollOutcome>(4).fill(failed)))).toBe(30_000);
  });

  it('keeps a visible tab out of the idle window however long the group is quiet', () => {
    /*
     * The deliberate exception, and the reason it is one: a visible tab is the
     * one an operator is watching and the one a playback command has to reach
     * inside its execution lead. A lead covering a 60 s interval would not be a
     * lead, so the saving is taken from the hidden tab instead.
     */
    const quietForAnHour = drive(state(), Array<GroupPollOutcome>(720).fill(quiet));

    expect(groupPollDelayMs(quietForAnHour)).toBe(5_000);
  });

  it('starts the fast cadence again the moment the tab comes back', () => {
    const idle = drive(
      withGroupPollVisibility(state(), false),
      Array<GroupPollOutcome>(9).fill(quiet),
    );

    const back = withGroupPollVisibility(idle, true);

    expect(groupPollDelayMs(back)).toBe(5_000);
    // The counter is cleared as well as the flag, so hiding again costs the
    // hidden cadence rather than dropping straight back to the ceiling.
    expect(groupPollDelayMs(withGroupPollVisibility(back, false))).toBe(15_000);
  });
});

describe('playback lead by delivery path', () => {
  it('leaves a socket group on whatever the operator set', () => {
    expect(playbackLeadForDelivery('socket', 40)).toBe(40);
    expect(playbackLeadForDelivery('socket', 0)).toBe(0);
  });

  it('raises a polled group above the interval its commands travel on', () => {
    expect(pollingPlaybackLeadMs).toBeGreaterThan(groupPollCadence.foregroundMs);
    expect(playbackLeadForDelivery('poll', 0)).toBe(pollingPlaybackLeadMs);
    expect(playbackLeadForDelivery('poll', 40)).toBe(pollingPlaybackLeadMs);
  });

  it('keeps a longer lead the operator chose', () => {
    expect(playbackLeadForDelivery('poll', 20_000)).toBe(20_000);
  });
});
