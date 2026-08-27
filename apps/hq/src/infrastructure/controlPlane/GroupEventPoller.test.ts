import { create, toBinary } from '@bufbuild/protobuf';
import { realtimeV1 } from '@gremuchaya/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ControlPlanePort } from '@/application/sync/controlPlanePort';
import type {
  GroupEventCursor,
  GroupEventEnvelope,
  GroupSessionCommand,
} from '@/application/sync/groupChannel';
import type { ControlPlaneLinkState } from '@/application/sync/connection';
import { aggregateDelivery, createLinkStates } from '@/application/sync/controlPlaneLinks';
import type { GroupEventPage } from '@/application/sync/groupEventFeed';
import { playbackLeadForDelivery } from '@/application/sync/groupEventFeed';
import {
  createPlaybackSyncTarget,
  PlaybackSyncCoordinator,
  type PlaybackSyncCommand,
} from '@/infrastructure/media/PlaybackSyncCoordinator';
import { operationsStore } from '@/state/operationsStore';

import { connectGroupState } from '@/application/sync/GroupStateSync';

import { ControlPlaneGroupChannel } from './ControlPlaneGroupChannel';
import { GroupEventPoller } from './GroupEventPoller';
import { createGroupLiveEditTransport, liveEditDocumentId } from './GroupLiveEditTransport';
import { createGroupPlaybackSyncTransport } from './GroupPlaybackSyncTransport';
import { RealtimeClient, type RealtimeSocketLike } from './RealtimeClient';

/** A wall-clock base every instant in this file is measured from. */
const baseMs = 1_700_000_000_000;

/* Placeholder addresses: the plane on the set's LAN, and the cloud plane. */
const nearPlane = 'http://127.0.0.1:4100';
const cloudPlane = 'https://plane.example';

/**
 * The group log as a log, not as a mock.
 *
 * Every page is served from an append-only array by the same rule the control
 * plane uses -- everything strictly after the requested sequence, capped -- so a
 * feed that asked for the wrong position gets the wrong page rather than a
 * rehearsed answer. `requests` is the transcript, and it is what proves where
 * the cursor stood at each tick.
 */
class FakeGroupLog {
  readonly events: GroupEventEnvelope[] = [];
  readonly requests: { readonly afterSequence: bigint; readonly atMs: number }[] = [];
  /** Serves one page at a time; anything beyond sets `has_more`. */
  pageSize = 512;
  /** How many of the next calls reject, standing in for a severed network. */
  failures = 0;
  /** When set, the next page answers the server's retention verdict instead. */
  resyncFrom: bigint | null = null;
  /** When set, the read parks here until the test resolves it. */
  gate: { resolve: () => void; promise: Promise<void> } | null = null;

  append(event: GroupEventEnvelope): void {
    this.events.push(event);
  }

  hold(): void {
    let resolve = (): void => {};
    const promise = new Promise<void>((settle) => {
      resolve = () => settle();
    });
    this.gate = { resolve, promise };
  }

  release(): void {
    const gate = this.gate;
    this.gate = null;
    gate?.resolve();
  }

  readonly signals: AbortSignal[] = [];

  readonly readGroupEvents = async (
    afterSequence: bigint,
    signal?: AbortSignal,
  ): Promise<GroupEventPage> => {
    this.requests.push({ afterSequence, atMs: Date.now() });
    if (signal !== undefined) this.signals.push(signal);
    if (this.gate !== null) await this.gate.promise;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('control plane unreachable');
    }
    if (this.resyncFrom !== null) {
      return {
        events: [],
        earliestAvailableSequence: this.resyncFrom,
        hasMore: false,
        resyncRequired: true,
      };
    }
    const pending = this.events.filter((event) => event.sequence > afterSequence);
    return {
      events: pending.slice(0, this.pageSize),
      earliestAvailableSequence: this.events[0]?.sequence ?? 0n,
      hasMore: pending.length > this.pageSize,
      resyncRequired: false,
    };
  };
}

function envelope(sequence: bigint, overrides: Partial<GroupEventEnvelope> = {}) {
  return {
    sequence,
    kind: 'document-delta',
    actorDeviceId: 'device-b',
    documentId: liveEditDocumentId,
    documentDelta: new Uint8Array(0),
    hybridLogicalClock: sequence,
    occurredAt: new Date(baseMs).toISOString(),
    ...overrides,
  } as GroupEventEnvelope;
}

/** A cursor stated as a cursor, so a test can read what moved it and when. */
function cursor(): GroupEventCursor & { applied: bigint } {
  return {
    applied: 0n,
    accept(sequence) {
      if (sequence <= this.applied) return false;
      this.applied = sequence;
      return true;
    },
    appliedSequence() {
      return this.applied;
    },
    rewindTo(sequence) {
      this.applied = sequence < 0n ? 0n : sequence;
    },
  };
}

interface Visibility {
  readonly isVisible: () => boolean;
  readonly subscribeVisibility: (listener: () => void) => () => void;
  readonly set: (visible: boolean) => void;
  readonly subscriberCount: () => number;
}

function visibility(initial: boolean): Visibility {
  let visible = initial;
  const listeners = new Set<() => void>();
  return {
    isVisible: () => visible,
    subscribeVisibility: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      visible = next;
      for (const listener of [...listeners]) listener();
    },
    subscriberCount: () => listeners.size,
  };
}

/** Every interval between successive reads, which is the cadence itself. */
function gaps(log: FakeGroupLog): number[] {
  return log.requests
    .slice(1)
    .map((request, index) => request.atMs - (log.requests[index]?.atMs ?? 0));
}

beforeEach(() => {
  vi.useFakeTimers({ now: baseMs });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GroupEventPoller cadence', () => {
  it('reads the log at the foreground cadence while the tab is visible', async () => {
    const log = new FakeGroupLog();
    const view = visibility(true);
    const poller = new GroupEventPoller({
      reader: log,
      cursor: cursor(),
      deliver: () => {},
      isVisible: view.isVisible,
      subscribeVisibility: view.subscribeVisibility,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(log.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(log.requests).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(gaps(log)).toEqual([5_000, 5_000, 5_000, 5_000]);

    poller.stop();
  });

  it('slows to the hidden cadence when visibilitychange says the tab went dark', async () => {
    const log = new FakeGroupLog();
    const view = visibility(true);
    const poller = new GroupEventPoller({
      reader: log,
      cursor: cursor(),
      deliver: () => {},
      isVisible: view.isVisible,
      subscribeVisibility: view.subscribeVisibility,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.requests).toHaveLength(1);

    view.set(false);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(log.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(log.requests).toHaveLength(2);

    poller.stop();
  });

  it('backs a hidden feed off after a minute of silence and returns on the first event', async () => {
    const log = new FakeGroupLog();
    const view = visibility(false);
    const channel = groupChannel();
    const poller = new GroupEventPoller({
      reader: log,
      cursor: channel,
      deliver: channel.deliver,
      isVisible: view.isVisible,
      subscribeVisibility: view.subscribeVisibility,
    });

    poller.start();
    // The first tick is immediate. Three more at the hidden cadence bring the
    // quiet count to four, which is the minute of silence the floor is set at.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000 * 3);
    expect(gaps(log)).toEqual([15_000, 15_000, 15_000]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(gaps(log).at(-1)).toBe(30_000);

    // One event resets the counter, so the feed is back on the hidden cadence
    // rather than the idle one for everything that follows.
    log.append(envelope(1n));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(gaps(log).at(-1)).toBe(15_000);

    poller.stop();
  });

  it('backs a hidden feed off a control plane that keeps refusing', async () => {
    const log = new FakeGroupLog();
    const view = visibility(false);
    const poller = new GroupEventPoller({
      reader: log,
      cursor: cursor(),
      deliver: () => {},
      isVisible: view.isVisible,
      subscribeVisibility: view.subscribeVisibility,
    });

    // A refusal spends an invocation exactly as an empty page does, so it has to
    // reach the cadence as one. A feed that read a refusal as news would hammer
    // an unreachable control plane at full speed for the rest of the month.
    log.failures = 10;
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000 * 3);
    expect(gaps(log)).toEqual([15_000, 15_000, 15_000]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(gaps(log).at(-1)).toBe(30_000);

    poller.stop();
  });

  it('stops for good when the session leaves the group', async () => {
    const log = new FakeGroupLog();
    const view = visibility(true);
    const poller = new GroupEventPoller({
      reader: log,
      cursor: cursor(),
      deliver: () => {},
      isVisible: view.isVisible,
      subscribeVisibility: view.subscribeVisibility,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(view.subscriberCount()).toBe(1);

    poller.stop();
    // Read before the clock moves: a timer left armed would have fired and been
    // consumed by the advance below, and the leak would be invisible. This runs
    // as a React effect cleanup, so one left behind is a leak per remount.
    expect(vi.getTimerCount()).toBe(0);
    expect(view.subscriberCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(log.requests).toHaveLength(1);
  });

  it('drops a page that came back after the feed was stopped', async () => {
    const log = new FakeGroupLog();
    const channel = groupChannel();
    const seen: bigint[] = [];
    channel.subscribe((event) => seen.push(event.sequence));
    const poller = new GroupEventPoller({
      reader: log,
      cursor: channel,
      deliver: channel.deliver,
      isVisible: () => true,
      subscribeVisibility: () => () => {},
    });

    log.append(envelope(1n));
    log.hold();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();

    // Cancelled rather than left to finish: the signal reaches the RPC, so a
    // session that left the group stops paying for the page it no longer wants.
    expect(log.signals.at(-1)?.aborted).toBe(true);

    log.release();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(seen).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('GroupEventPoller cursor', () => {
  it('reads its position from the channel and asks for what follows it', async () => {
    const log = new FakeGroupLog();
    const channel = groupChannel();
    const seen: bigint[] = [];
    channel.subscribe((event) => seen.push(event.sequence));
    const poller = new GroupEventPoller({
      reader: log,
      cursor: channel,
      deliver: channel.deliver,
      isVisible: () => true,
      subscribeVisibility: () => () => {},
    });

    log.append(envelope(1n));
    log.append(envelope(2n));
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([1n, 2n]);
    expect(channel.appliedSequence()).toBe(2n);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(log.requests.map((request) => request.afterSequence)).toEqual([0n, 2n]);

    poller.stop();
  });

  it('moves the cursor through deliver and never ahead of it', async () => {
    /*
     * The one thing this feed must not do. A poller that advanced the position
     * itself would step past an event `deliver` had not fanned out, and the
     * next page would start after an event no subscriber ever saw.
     */
    const log = new FakeGroupLog();
    const position = cursor();
    const poller = new GroupEventPoller({
      reader: log,
      cursor: position,
      // A merge point that applies nothing: the position must not move.
      deliver: () => {},
      isVisible: () => true,
      subscribeVisibility: () => () => {},
    });

    log.append(envelope(1n));
    log.append(envelope(2n));
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(position.appliedSequence()).toBe(0n);
    expect(log.requests.map((request) => request.afterSequence)).toEqual([0n, 0n]);

    poller.stop();
  });

  it('keeps its position when the network cuts a page off, and repeats it', async () => {
    const log = new FakeGroupLog();
    const channel = groupChannel();
    const seen: bigint[] = [];
    channel.subscribe((event) => seen.push(event.sequence));
    const poller = new GroupEventPoller({
      reader: log,
      cursor: channel,
      deliver: channel.deliver,
      isVisible: () => true,
      subscribeVisibility: () => () => {},
    });

    log.append(envelope(1n));
    log.failures = 1;
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([]);
    expect(channel.appliedSequence()).toBe(0n);

    // The next tick repeats the same position, so the event the severed answer
    // carried is not skipped -- and the feed is still running to ask for it.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log.requests.map((request) => request.afterSequence)).toEqual([0n, 0n]);
    expect(seen).toEqual([1n]);

    poller.stop();
  });

  it('pages straight through a backlog rather than one page per interval', async () => {
    const log = new FakeGroupLog();
    const channel = groupChannel();
    const seen: bigint[] = [];
    channel.subscribe((event) => seen.push(event.sequence));
    const poller = new GroupEventPoller({
      reader: log,
      cursor: channel,
      deliver: channel.deliver,
      isVisible: () => true,
      subscribeVisibility: () => () => {},
    });

    log.pageSize = 2;
    for (const sequence of [1n, 2n, 3n, 4n, 5n]) log.append(envelope(sequence));
    poller.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(seen).toEqual([1n, 2n, 3n, 4n, 5n]);
    // Three pages inside a few milliseconds rather than one every five seconds:
    // a session that was away for an hour catches up now, not in an hour.
    expect(log.requests).toHaveLength(3);
    expect(Date.now()).toBeLessThan(baseMs + 5_000);

    poller.stop();
  });
});

describe('GroupEventPoller resync', () => {
  it('follows the same path a ResyncRequired frame takes on the socket', async () => {
    /*
     * The server takes the retention decision once, in
     * `realtime/replayDecision.ts`, and reports it two ways: a `ResyncRequired`
     * frame to a socket and the `resync_required` field to a page. What follows
     * has to be one path, so the same collaborator is handed to both transports
     * here and both are asked where they end up.
     */
    const snapshotSequence = 40n;
    const resume = async () => ({ afterSequence: snapshotSequence });

    const polled = groupChannel();
    polled.deliver(envelope(5n));
    const log = new FakeGroupLog();
    log.resyncFrom = 30n;
    const poller = new GroupEventPoller({
      reader: log,
      cursor: polled,
      deliver: polled.deliver,
      onResync: resume,
      isVisible: () => true,
      subscribeVisibility: () => () => {},
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();

    const pushed = groupChannel();
    pushed.deliver(envelope(5n));
    await socketResync(pushed, { requested: 5n, earliest: 30n, onResync: resume });

    expect(polled.appliedSequence()).toBe(snapshotSequence);
    expect(pushed.appliedSequence()).toBe(polled.appliedSequence());
  });

  it('follows the server edge when no snapshot was ever recorded, as the socket does', async () => {
    const resume = async () => null;

    const polled = groupChannel();
    polled.deliver(envelope(5n));
    const log = new FakeGroupLog();
    log.resyncFrom = 30n;
    const poller = new GroupEventPoller({
      reader: log,
      cursor: polled,
      deliver: polled.deliver,
      onResync: resume,
      isVisible: () => true,
      subscribeVisibility: () => () => {},
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();

    const pushed = groupChannel();
    pushed.deliver(envelope(5n));
    await socketResync(pushed, { requested: 5n, earliest: 30n, onResync: resume });

    expect(polled.appliedSequence()).toBe(29n);
    expect(pushed.appliedSequence()).toBe(polled.appliedSequence());
  });

  it('reports the verdict rather than deriving one from the window edge', async () => {
    /*
     * `earliest_available_sequence` is reported on an ordinary page too. A feed
     * that decided for itself whether the cursor had fallen out of the window
     * would be a second copy of the retention rule, and this page -- edge above
     * the cursor, `resync_required` false -- is where the two would disagree.
     */
    const log = new FakeGroupLog();
    const channel = groupChannel();
    let resyncs = 0;
    const poller = new GroupEventPoller({
      reader: log,
      cursor: channel,
      deliver: channel.deliver,
      onResync: async () => {
        resyncs += 1;
        return { afterSequence: 99n };
      },
      isVisible: () => true,
      subscribeVisibility: () => () => {},
    });

    log.append(envelope(80n));
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(resyncs).toBe(0);
    expect(channel.appliedSequence()).toBe(80n);

    poller.stop();
  });
});

describe('one order, two transports', () => {
  it('applies an event carried by both the socket and the poll exactly once', async () => {
    /*
     * The claim is about the settings history and not about a call count: a
     * duplicate that reached `applySettingsPatch` twice writes two entries for
     * one change, and that is the defect the shared cursor exists to prevent.
     *
     * The race is the real one. The page was already in flight when the socket
     * pushed the same event, so the poller is holding a cursor position that
     * the socket has since moved past -- exactly the window a second cursor
     * would fall through.
     */
    const channel = groupChannel();
    const liveEdit = createGroupLiveEditTransport({ channel });
    liveEdit.subscribe((patches) => operationsStore.getState().applySettingsPatch(patches));

    const event = envelope(1n, { documentDelta: liveEditDelta(false) });
    const log = new FakeGroupLog();
    log.append(event);
    log.hold();
    const poller = new GroupEventPoller({
      reader: log,
      cursor: channel,
      deliver: channel.deliver,
      isVisible: () => true,
      subscribeVisibility: () => () => {},
    });

    const before = operationsStore.getState().personalization.history.length;
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    // The socket path is literally `channel.deliver`: `GroupChannelRuntime`
    // gives `RealtimeClient` that function as its `onEvent` and the channel as
    // its cursor, so a client with an injected cursor calls this and nothing
    // else.
    channel.deliver(event);
    log.release();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    liveEdit.close();

    const after = operationsStore.getState().personalization.history;
    expect(after.length - before).toBe(1);
    expect(after[0]?.changedIds).toEqual(['popups.longPress']);
    expect(operationsStore.getState().personalization.draft.values['popups.longPress']).toBe(false);
  });

  it('applies an event carried by both planes of one group exactly once', async () => {
    /*
     * The shape this stage is for: one device, two links, one group. The plane
     * on the set's LAN and the plane on the internet stand in front of the same
     * database, so both carry the same log with the same sequence numbers --
     * the allocator hands them out under a row lock, which is what makes the
     * numbers the commit order rather than two opinions about it.
     *
     * Two logs and two feeds here, and one channel. The claim is again about
     * the settings history rather than a call count: a duplicate that reached
     * `applySettingsPatch` twice writes two entries for one change, which is
     * the defect the shared cursor exists to prevent, and
     * `GroupLiveEditTransport` is exactly the subscriber that is not
     * idempotent.
     */
    const channel = groupChannel();
    const liveEdit = createGroupLiveEditTransport({ channel });
    liveEdit.subscribe((patches) => operationsStore.getState().applySettingsPatch(patches));

    const event = envelope(1n, { documentDelta: liveEditDelta(false) });
    const nearLog = new FakeGroupLog();
    const cloudLog = new FakeGroupLog();
    nearLog.append(event);
    cloudLog.append(event);
    const feeds = [nearLog, cloudLog].map(
      (log) =>
        new GroupEventPoller({
          reader: log,
          cursor: channel,
          deliver: channel.deliver,
          isVisible: () => true,
          subscribeVisibility: () => () => {},
        }),
    );

    // Both pages are held until both feeds are in flight, so both asked from
    // the same cursor position -- the window a second cursor would fall
    // through, and the one a sequential test would never open.
    nearLog.hold();
    cloudLog.hold();
    const before = operationsStore.getState().personalization.history.length;
    for (const feed of feeds) feed.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(nearLog.requests.map((request) => request.afterSequence)).toEqual([0n]);
    expect(cloudLog.requests.map((request) => request.afterSequence)).toEqual([0n]);

    nearLog.release();
    cloudLog.release();
    await vi.advanceTimersByTimeAsync(0);
    for (const feed of feeds) feed.stop();
    liveEdit.close();

    const after = operationsStore.getState().personalization.history;
    expect(after.length - before).toBe(1);
    expect(after[0]?.changedIds).toEqual(['popups.longPress']);
    expect(operationsStore.getState().personalization.draft.values['popups.longPress']).toBe(false);
    // Both planes carried the event to the merge point; only the first of them
    // reached a subscriber.
    expect(channel.appliedSequence()).toBe(1n);
  });
});

describe('the group own state follows the same log', () => {
  const group = {
    groupId: 'group-a',
    name: 'ШТАБ',
    authority: 'leader' as const,
    leaderDeviceId: 'device-a',
    revision: 7,
  };

  /** The session as it stands after `JoinGroup`, revision included. */
  function joined(): void {
    operationsStore.getState().patchConnection({
      mode: 'online',
      session: { deviceId: 'device-a', groupId: 'group-a', role: 'ADMIN' },
      groupName: group.name,
      authority: group.authority,
      leaderDeviceId: group.leaderDeviceId,
      groupRevision: group.revision,
      devices: [
        { deviceId: 'device-a', name: 'ЭКРАН 1', role: 'ADMIN', status: 'ONLINE' },
        { deviceId: 'device-b', name: 'ЭКРАН 2', role: 'EDITOR', status: 'ONLINE' },
      ],
      presence: [],
    });
  }

  function subscribe(channel: ControlPlaneGroupChannel): () => void {
    return connectGroupState({
      channel,
      read: () => {
        const { connection } = operationsStore.getState();
        return {
          groupRevision: connection.groupRevision,
          session: connection.session,
          devices: connection.devices,
          presence: connection.presence,
        };
      },
      apply: (patch) => operationsStore.getState().patchConnection(patch),
    });
  }

  it('moves the leader on a session that made no call and reconnected to nothing', async () => {
    /*
     * The consequence, stated as the operator experiences it: an administrator
     * on another machine moved the leader, this session called nothing, opened
     * nothing and rejoined nothing, and what it holds about the group changed
     * on the next page of the log. Before the subscriber existed the same page
     * arrived and was dropped, and the new leader was learned by reconnecting.
     */
    joined();
    const channel = groupChannel();
    const disconnect = subscribe(channel);
    const log = new FakeGroupLog();
    log.append(
      envelope(1n, {
        kind: 'group-updated',
        actorDeviceId: 'device-b',
        group: { ...group, leaderDeviceId: 'device-b', revision: 8 },
      }),
    );
    const poller = new GroupEventPoller({
      reader: log,
      cursor: channel,
      deliver: channel.deliver,
      isVisible: () => true,
      subscribeVisibility: () => () => {},
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    disconnect();

    expect(operationsStore.getState().connection.leaderDeviceId).toBe('device-b');
    expect(operationsStore.getState().connection.groupRevision).toBe(8);
  });

  it('keeps the newer leader when a resync replays the older one on top', async () => {
    /*
     * Ordering against state, not against arrival. The server sent the feed
     * back to the oldest sequence it still retains, so the whole retained
     * window is read again -- every snapshot in it valid, every one of them
     * older than what this session already holds. Arrival order alone would put
     * the previous leader back on every resync.
     */
    joined();
    const channel = groupChannel();
    const disconnect = subscribe(channel);
    channel.deliver(
      envelope(9n, {
        kind: 'group-updated',
        group: { ...group, leaderDeviceId: 'device-c', revision: 12 },
      }),
    );
    expect(operationsStore.getState().connection.leaderDeviceId).toBe('device-c');

    channel.rewindTo(0n);
    const log = new FakeGroupLog();
    log.append(
      envelope(3n, {
        kind: 'group-updated',
        group: { ...group, leaderDeviceId: 'device-b', revision: 8 },
      }),
    );
    log.append(
      envelope(9n, {
        kind: 'group-updated',
        group: { ...group, leaderDeviceId: 'device-c', revision: 12 },
      }),
    );
    const poller = new GroupEventPoller({
      reader: log,
      cursor: channel,
      deliver: channel.deliver,
      isVisible: () => true,
      subscribeVisibility: () => () => {},
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    disconnect();

    expect(operationsStore.getState().connection.leaderDeviceId).toBe('device-c');
    expect(operationsStore.getState().connection.groupRevision).toBe(12);
  });

  it('applies one page carried by both planes once, counted where a repeat would show', async () => {
    /*
     * One device, two links, one group: both planes stand in front of the same
     * database and carry the same log with the same numbers. The page here
     * carries two events at once -- a live-edit delta and a leader change --
     * because the counter that can see a repeat belongs to the first:
     * `applySettingsPatch` writes a history entry per application, so a
     * duplicate that reached a subscriber writes two entries for one change.
     * The leader change rides the same page to show that the new subscriber is
     * behind the same merge point rather than beside a transport.
     */
    joined();
    const channel = groupChannel();
    const disconnect = subscribe(channel);
    const liveEdit = createGroupLiveEditTransport({ channel });
    liveEdit.subscribe((patches) => operationsStore.getState().applySettingsPatch(patches));

    const delta = envelope(1n, { documentDelta: liveEditDelta(false) });
    const moved = envelope(2n, {
      kind: 'group-updated',
      actorDeviceId: 'device-b',
      group: { ...group, leaderDeviceId: 'device-b', revision: 8 },
    });
    const nearLog = new FakeGroupLog();
    const cloudLog = new FakeGroupLog();
    for (const log of [nearLog, cloudLog]) {
      log.append(delta);
      log.append(moved);
      log.hold();
    }
    const feeds = [nearLog, cloudLog].map(
      (log) =>
        new GroupEventPoller({
          reader: log,
          cursor: channel,
          deliver: channel.deliver,
          isVisible: () => true,
          subscribeVisibility: () => () => {},
        }),
    );

    const before = operationsStore.getState().personalization.history.length;
    for (const feed of feeds) feed.start();
    await vi.advanceTimersByTimeAsync(0);
    // Both feeds asked from the same position, which is the window a second
    // cursor would fall through and a sequential test would never open.
    expect(nearLog.requests.map((request) => request.afterSequence)).toEqual([0n]);
    expect(cloudLog.requests.map((request) => request.afterSequence)).toEqual([0n]);

    for (const log of [nearLog, cloudLog]) log.release();
    await vi.advanceTimersByTimeAsync(0);
    for (const feed of feeds) feed.stop();
    liveEdit.close();
    disconnect();

    expect(operationsStore.getState().personalization.history.length - before).toBe(1);
    expect(operationsStore.getState().connection.leaderDeviceId).toBe('device-b');
    expect(operationsStore.getState().connection.groupRevision).toBe(8);
    expect(channel.appliedSequence()).toBe(2n);
  });

  it('turns a neighbour that left offline between two presence ticks', async () => {
    joined();
    operationsStore.getState().patchConnection({
      presence: [
        {
          deviceId: 'device-b',
          status: 'ONLINE',
          activeScreen: 'video',
          clockOffsetMs: 0,
          latencyMs: 4,
          observedAt: new Date(baseMs).toISOString(),
        },
      ],
    });
    const channel = groupChannel();
    const disconnect = subscribe(channel);
    const log = new FakeGroupLog();
    log.append(
      envelope(1n, {
        kind: 'presence-updated',
        actorDeviceId: 'device-b',
        presence: {
          deviceId: 'device-b',
          status: 'OFFLINE',
          activeScreen: '',
          clockOffsetMs: 0,
          latencyMs: 0,
          observedAt: new Date(baseMs + 2_000).toISOString(),
        },
      }),
    );
    const poller = new GroupEventPoller({
      reader: log,
      cursor: channel,
      deliver: channel.deliver,
      isVisible: () => true,
      subscribeVisibility: () => () => {},
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    disconnect();

    // No `GetPresence` was made: the timer keeps the call, its renewal and the
    // whole list; the log only writes down the device an event named.
    expect(operationsStore.getState().connection.presence).toEqual([
      {
        deviceId: 'device-b',
        status: 'OFFLINE',
        activeScreen: '',
        clockOffsetMs: 0,
        latencyMs: 0,
        observedAt: new Date(baseMs + 2_000).toISOString(),
      },
    ]);
  });
});

describe('playback across a polled group', () => {
  it('runs a command delivered by the poll at the same instant on both screens', async () => {
    const { fired } = await twoScreens(playbackLeadForDelivery('poll', 0));

    expect(fired).toHaveLength(2);
    // The whole claim: one instant, not two arrival times.
    expect(fired[0]?.atMs).toBe(fired[1]?.atMs);
    expect(fired[0]?.atMs).toBe(baseMs + 6_000);
  });

  it('shows the socket lead pulling the two screens apart on the same feed', async () => {
    /*
     * The counter-case, so the assertion above cannot pass for a reason other
     * than the lead. Forty milliseconds is the interval a push arrives inside;
     * a page read every five seconds does not, so the receiving screen runs the
     * command on arrival -- a different moment from the issuing screen's.
     */
    const { fired } = await twoScreens(40);

    expect(fired).toHaveLength(2);
    expect(fired[0]?.atMs).toBe(baseMs + 40);
    // The following screen runs it the moment the page carrying it arrives,
    // which is the tick and not the instant the issuing screen chose.
    expect(fired[1]?.atMs).toBeGreaterThanOrEqual(baseMs + 5_000);
    expect(fired[0]?.atMs).not.toBe(fired[1]?.atMs);
  });

  it('converges a screen that holds both planes at once, on the lead its own set asks for', async () => {
    /*
     * The mixed group, end to end: a screen on the set's LAN holding the near
     * plane and the cloud plane, publishing to members that are fed by one or
     * the other. The lead is not chosen by this test -- it is what the device's
     * own link set says, through the two functions that decide it -- so the
     * assertion covers the rule and not a number written twice.
     *
     * Taking the minimum over the links instead of the maximum would give 40 ms
     * here, and the counter-case above shows what that does to the two screens.
     */
    const mixed: readonly ControlPlaneLinkState[] = [
      {
        ...(createLinkStates([nearPlane, cloudPlane])[0] as ControlPlaneLinkState),
        delivery: 'socket',
      },
      {
        ...(createLinkStates([nearPlane, cloudPlane])[1] as ControlPlaneLinkState),
        delivery: 'poll',
      },
    ];
    const configuredLeadMs = 40;

    const { fired } = await twoScreens(
      playbackLeadForDelivery(aggregateDelivery(mixed), configuredLeadMs),
    );

    expect(fired).toHaveLength(2);
    expect(fired[0]?.atMs).toBe(fired[1]?.atMs);
    expect(fired[0]?.atMs).toBe(baseMs + 6_000);
  });

  it('runs the command at one true instant when the publishing screen is three seconds fast', async () => {
    /*
     * The millisecond promise of R27, on the one path that can break it: two
     * machines whose own clocks disagree. `execute_at` crosses the wire
     * untouched -- `publishSessionCommand` copies the client's value into the
     * appended event -- so the only thing that can make two screens agree on
     * an instant is that both express it on the same scale. Three seconds is
     * half again the whole lead, so a coordinator scheduling against its own
     * clock cannot land on the follower's instant by accident.
     */
    const { fired } = await twoScreens(playbackLeadForDelivery('poll', 0), {
      issuing: { skewMs: 3_000, offsetMs: -3_000 },
      following: trueClock,
    });

    expect(fired).toHaveLength(2);
    expect(fired[0]?.atMs).toBe(fired[1]?.atMs);
    expect(fired[0]?.atMs).toBe(baseMs + 6_000);
  });

  it('shows the same two screens three seconds apart while neither holds an estimate', async () => {
    /*
     * The counter-case, so the assertion above cannot pass for a reason other
     * than the offset. A machine that has never completed a `TimeSync` round
     * reports zero, which is also the honest answer for a group of one -- and
     * the divergence that leaves is exactly the difference between the two
     * clocks, neither more nor less. The lead cannot close it: a lead
     * equalizes delivery, and this is not delivery.
     */
    const { fired } = await twoScreens(playbackLeadForDelivery('poll', 0), {
      issuing: { skewMs: 3_000, offsetMs: 0 },
      following: trueClock,
    });

    expect(fired).toHaveLength(2);
    expect(fired[0]?.atMs).toBe(baseMs + 6_000);
    expect(fired[1]?.atMs).toBe(baseMs + 9_000);
  });
});

function groupChannel(deviceId = 'device-a', port?: ControlPlanePort): ControlPlaneGroupChannel {
  return new ControlPlaneGroupChannel({
    selectPort: () => port ?? ({} as ControlPlanePort),
    groupId: 'group-a',
    deviceId,
  });
}

function liveEditDelta(value: boolean): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ protocol: 1, patches: [{ id: 'popups.longPress', value }] }),
  );
}

/**
 * Drives one `ResyncRequired` frame through a real `RealtimeClient`, so the
 * comparison above is against the socket's actual behaviour rather than against
 * a restatement of it.
 */
async function socketResync(
  channel: ControlPlaneGroupChannel,
  options: {
    readonly requested: bigint;
    readonly earliest: bigint;
    readonly onResync: () => Promise<{ readonly afterSequence: bigint } | null>;
  },
): Promise<void> {
  const sockets: FakeRealtimeSocket[] = [];
  const client = new RealtimeClient({
    baseUrl: 'http://127.0.0.1:4100',
    identity: () => ({ groupId: 'group-a', deviceId: 'device-a', accessToken: 'token' }),
    onEvent: channel.deliver,
    cursor: channel,
    onStatus: () => {},
    onResync: options.onResync,
    createSocket: () => {
      const socket = new FakeRealtimeSocket();
      sockets.push(socket);
      return socket;
    },
    // Nothing here should reconnect or ping; the resync is the whole subject.
    schedule: () => () => {},
    pingIntervalMs: 1_000_000,
  });
  client.start();
  sockets.at(-1)?.receive(
    create(realtimeV1.RealtimeServerFrameSchema, {
      payload: {
        case: 'resyncRequired',
        value: {
          groupId: { value: 'group-a' },
          requestedAfterSequence: options.requested,
          earliestAvailableSequence: options.earliest,
          reason: 'retained event history no longer covers the requested sequence',
        },
      },
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  client.stop();
}

class FakeRealtimeSocket implements RealtimeSocketLike {
  binaryType = '';
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(): void {}

  close(): void {
    this.readyState = 3;
  }

  receive(frame: realtimeV1.RealtimeServerFrame): void {
    this.onmessage?.({ data: toBinary(realtimeV1.RealtimeServerFrameSchema, frame).buffer });
  }
}

/**
 * One screen's relationship to the true instant this file measures in.
 *
 * `skewMs` is how far the machine's own clock has run ahead of that instant;
 * `offsetMs` is what its last `TimeSync` round told it to add to that clock to
 * read the control plane's. A machine three seconds fast with an honest
 * estimate reports `+3000 / -3000`, and one that has never completed a round
 * reports an offset of zero whatever its clock says.
 */
interface ScreenClock {
  readonly skewMs: number;
  readonly offsetMs: number;
}

/** A machine agreeing with the group to the millisecond. */
const trueClock: ScreenClock = { skewMs: 0, offsetMs: 0 };

/**
 * Two sessions of one group, one publishing and one following by poll.
 *
 * Both coordinators share the fake log and the fake clock, so what the test
 * reads off them is the instant each screen actually executed the command at.
 * `clocks` is what each screen's own `Date.now()` and `TimeSync` say instead;
 * left alone, both screens agree with true time and with each other.
 */
async function twoScreens(
  leadMs: number,
  clocks: { readonly issuing: ScreenClock; readonly following: ScreenClock } = {
    issuing: trueClock,
    following: trueClock,
  },
): Promise<{
  readonly fired: { readonly device: string; readonly atMs: number }[];
}> {
  const fired: { device: string; atMs: number }[] = [];
  const log = new FakeGroupLog();
  let sequence = 0n;

  const publisher = groupChannel('device-a', {
    async publishSessionCommand(publication) {
      sequence += 1n;
      const command: GroupSessionCommand = {
        epoch: 1n,
        sequence,
        action: publication.action,
        target: publication.target,
        positionSeconds: publication.positionSeconds ?? 0,
        playbackRate: publication.playbackRate ?? 1,
        executeAtMs: publication.executeAtMs ?? 0,
        issuedByDeviceId: 'device-a',
      };
      log.append(
        envelope(sequence, {
          kind: 'session-command',
          actorDeviceId: 'device-a',
          documentId: '',
          sessionCommand: command,
        }),
      );
      return command;
    },
  } as ControlPlanePort);

  const follower = groupChannel('device-b');
  const poller = new GroupEventPoller({
    reader: log,
    cursor: follower,
    deliver: follower.deliver,
    isVisible: () => true,
    subscribeVisibility: () => () => {},
  });
  poller.start();
  await vi.advanceTimersByTimeAsync(0);

  const schedule = (callback: () => void, delayMs: number) => {
    const timeoutId = setTimeout(callback, delayMs);
    return () => clearTimeout(timeoutId);
  };
  const issuing = new PlaybackSyncCoordinator({
    onCommand: () => fired.push({ device: 'device-a', atMs: Date.now() }),
    deviceId: 'device-a',
    executionDelayMs: leadMs,
    transport: createGroupPlaybackSyncTransport({ channel: publisher }),
    now: () => Date.now() + clocks.issuing.skewMs,
    clockOffsetMs: () => clocks.issuing.offsetMs,
    schedule,
  });
  const following = new PlaybackSyncCoordinator({
    onCommand: () => fired.push({ device: 'device-b', atMs: Date.now() }),
    deviceId: 'device-b',
    executionDelayMs: leadMs,
    transport: createGroupPlaybackSyncTransport({ channel: follower }),
    now: () => Date.now() + clocks.following.skewMs,
    clockOffsetMs: () => clocks.following.offsetMs,
    schedule,
  });

  const target = createPlaybackSyncTarget('CAM-01', 'DEMO_VIDEO');
  if (target === null) throw new Error('The playback target did not validate.');
  const published: PlaybackSyncCommand | null = issuing.publish({ action: 'PLAY', target });
  if (published === null) throw new Error('The coordinator refused to publish.');

  await vi.advanceTimersByTimeAsync(20_000);
  issuing.close();
  following.close();
  poller.stop();
  return { fired: [...fired].sort((left, right) => left.device.localeCompare(right.device)) };
}
