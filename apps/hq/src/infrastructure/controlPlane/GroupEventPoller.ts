import type { RealtimeLinkState } from '@/application/sync/connection';
import type { ControlPlanePort } from '@/application/sync/controlPlanePort';
import type { GroupEventCursor, GroupEventEnvelope } from '@/application/sync/groupChannel';
import {
  groupPollDelayMs,
  initialGroupPollState,
  nextGroupPollState,
  withGroupPollVisibility,
  type GroupPollOutcome,
  type GroupPollState,
} from '@/application/sync/groupEventFeed';

/** The one method of `ControlPlanePort` this feed needs. */
export type GroupEventReader = Pick<ControlPlanePort, 'readGroupEvents'>;

/** What a page that outran the retained window is answered with. */
export interface GroupPollResyncOutcome {
  /** The sequence the next page is asked for after. */
  readonly afterSequence: bigint;
}

export interface GroupEventPollerOptions {
  readonly reader: GroupEventReader;
  /**
   * The group's applied position, owned by whatever merges the transports.
   *
   * Read to say where the next page starts, and rewound on a resync. It is
   * never advanced here: the cursor moves inside `deliver`, when the event has
   * actually reached the subscribers, so a page half applied before a listener
   * threw does not leave the group claiming to have seen the rest.
   */
  readonly cursor: GroupEventCursor;
  /**
   * The group's one merge point -- `ControlPlaneGroupChannel.deliver`.
   *
   * Events go through it and nowhere else. It is what drops an event the socket
   * already carried, and the subscribers behind it are not uniformly
   * idempotent: `GroupLiveEditTransport` applies the patch again and writes a
   * second history entry for one change.
   */
  readonly deliver: (event: GroupEventEnvelope) => void;
  /**
   * Called when the server says the retained window no longer covers the
   * cursor. The same collaborator the socket's `onResync` uses, answering with
   * the sequence a snapshot was taken at, or `null` when none was recorded.
   */
  readonly onResync?: (
    resync: {
      readonly requestedAfterSequence: bigint;
      readonly earliestAvailableSequence: bigint;
    },
    signal: AbortSignal,
  ) => Promise<GroupPollResyncOutcome | null>;
  readonly onStatus?: (state: RealtimeLinkState) => void;
  /** What the document reports. Injected so a test does not need a `document`. */
  readonly isVisible?: () => boolean;
  readonly subscribeVisibility?: (listener: () => void) => () => void;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
}

/**
 * The group's event feed for a deployment that serves no socket (F14, stage 6).
 *
 * `RealtimeClient` follows the log by being pushed to; this follows it by
 * asking. The difference is not a preference: `WatchGroup` subscribes to the
 * realtime hub's listener map, which is a property of one process, so a
 * deployment that answers the subscribe on one instance and the publish on
 * another admits a socket that reports itself live and then follows nothing.
 * `ReadGroupEvents` touches no listener at all.
 *
 * What it does *not* own is as important as what it does. The applied position
 * is the channel's, because a group has one order and may be carried by both
 * transports at once. The retention verdict is the server's, read off
 * `resync_required` rather than recomputed from the window edge. The page size
 * is the server's default. Each of those has exactly one owner, and this is not
 * it.
 *
 * The cadence is {@link groupPollDelayMs} and lives in the application layer,
 * where it can be read and tested without a clock. This class supplies the
 * clock, the abort signal and the visibility subscription, and nothing else.
 */
export class GroupEventPoller {
  readonly #options: GroupEventPollerOptions;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;
  #state: GroupPollState;
  #cancelTick: (() => void) | null = null;
  #unsubscribeVisibility: (() => void) | null = null;
  #controller: AbortController | null = null;
  #started = false;
  #inFlight = false;
  #resyncCount = 0;

  constructor(options: GroupEventPollerOptions) {
    this.#options = options;
    this.#schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timeoutId = setTimeout(callback, delayMs);
        return () => clearTimeout(timeoutId);
      });
    this.#state = initialGroupPollState(this.#visible());
  }

  /** The last sequence the group applied, as this feed last read it. */
  get lastSequence(): bigint {
    return this.#options.cursor.appliedSequence();
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#state = initialGroupPollState(this.#visible());
    this.#unsubscribeVisibility =
      this.#options.subscribeVisibility?.(this.#onVisibilityChanged) ?? null;
    this.#emit();
    this.#arm();
  }

  /**
   * Stops the feed and releases every handle it took.
   *
   * Idempotent, because it is a React effect cleanup and the same runtime may
   * stop a feed that never armed a timer. The in-flight request is aborted
   * rather than left to resolve: a page that came back after the session left
   * the group would be delivered into a channel that is already closed, and
   * its continuation would arm another timer nobody would ever cancel.
   */
  stop(): void {
    this.#started = false;
    this.#cancelTick?.();
    this.#cancelTick = null;
    this.#unsubscribeVisibility?.();
    this.#unsubscribeVisibility = null;
    this.#controller?.abort();
    this.#controller = null;
  }

  readonly #onVisibilityChanged = (): void => {
    if (!this.#started) return;
    const next = withGroupPollVisibility(this.#state, this.#visible());
    if (next === this.#state) return;
    this.#state = next;
    // Re-armed rather than left to expire: a tab that just became visible would
    // otherwise wait out the hidden interval it was already inside before it
    // started paying the foreground one.
    this.#arm();
  };

  #visible(): boolean {
    const isVisible = this.#options.isVisible;
    if (isVisible !== undefined) return isVisible();
    // Server rendering and the node test environment both have no `document`.
    // Neither is a hidden tab, and treating them as one would start the feed on
    // the slow cadence for no reason.
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  }

  #arm(): void {
    this.#cancelTick?.();
    this.#cancelTick = null;
    if (!this.#started || this.#inFlight) return;
    this.#cancelTick = this.#schedule(() => {
      this.#cancelTick = null;
      void this.#tick();
    }, groupPollDelayMs(this.#state));
  }

  async #tick(): Promise<void> {
    if (!this.#started || this.#inFlight) return;
    this.#inFlight = true;
    const controller = new AbortController();
    this.#controller = controller;
    const requestedAfterSequence = this.#options.cursor.appliedSequence();
    let outcome: GroupPollOutcome;
    try {
      outcome = await this.#read(requestedAfterSequence, controller);
    } catch {
      /*
       * A page that never arrived, or arrived as a refusal. The cursor has not
       * moved, so the next tick asks for the same position again and nothing is
       * skipped; the feed backs off rather than retrying at full speed, because
       * a refusal costs an invocation exactly as an answer does.
       */
      outcome = { kind: 'failed' };
    } finally {
      this.#inFlight = false;
      if (this.#controller === controller) this.#controller = null;
    }
    if (controller.signal.aborted || !this.#started) return;
    this.#state = nextGroupPollState(this.#state, outcome);
    this.#emit();
    this.#arm();
  }

  async #read(
    requestedAfterSequence: bigint,
    controller: AbortController,
  ): Promise<GroupPollOutcome> {
    const page = await this.#options.reader.readGroupEvents(
      requestedAfterSequence,
      controller.signal,
    );
    if (controller.signal.aborted || !this.#started) return { kind: 'failed' };
    if (page.resyncRequired) {
      this.#resyncCount += 1;
      await this.#resync(requestedAfterSequence, page.earliestAvailableSequence, controller);
      return { kind: 'resynced' };
    }
    for (const event of page.events) this.#options.deliver(event);
    return page.events.length === 0
      ? { kind: 'quiet' }
      : { kind: 'applied', hasMore: page.hasMore };
  }

  /**
   * Follows the server back to a position it still holds.
   *
   * The same two answers `RealtimeClient` gives a `ResyncRequired` frame, for
   * the same reason: with a snapshot the cursor moves to the sequence it was
   * taken at, and without one -- a group whose log has recorded no snapshot, or
   * a snapshot call that failed -- to the sequence just below the oldest the
   * server still retains, which is the most this client can honestly claim to
   * have seen.
   */
  async #resync(
    requestedAfterSequence: bigint,
    earliestAvailableSequence: bigint,
    controller: AbortController,
  ): Promise<void> {
    const fallback = maxSequence(0n, earliestAvailableSequence - 1n);
    const onResync = this.#options.onResync;
    if (onResync === undefined) {
      this.#options.cursor.rewindTo(fallback);
      return;
    }
    try {
      const outcome = await onResync(
        { requestedAfterSequence, earliestAvailableSequence },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      this.#options.cursor.rewindTo(outcome === null ? fallback : outcome.afterSequence);
    } catch {
      if (!controller.signal.aborted) this.#options.cursor.rewindTo(fallback);
    }
  }

  /**
   * `polling` and not `live`: this session is in the group and reading it, but
   * nothing is being pushed to it, and a status line saying otherwise would
   * claim a promptness the cadence does not offer.
   */
  #emit(): void {
    this.#options.onStatus?.({
      status: 'polling',
      connectionId: '',
      lastSequence: Number(this.#options.cursor.appliedSequence()),
      resyncCount: this.#resyncCount,
    });
  }
}

function maxSequence(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
