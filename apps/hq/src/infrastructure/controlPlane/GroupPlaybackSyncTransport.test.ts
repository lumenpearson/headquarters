import { describe, expect, it } from 'vitest';

import type {
  DocumentDeltaReceipt,
  GroupChannel,
  GroupEventEnvelope,
  GroupSessionCommand,
  SessionCommandPublication,
} from '@/application/sync/groupChannel';
import {
  PlaybackSyncCoordinator,
  type PlaybackSyncCommand,
  type PlaybackSyncTarget,
} from '@/infrastructure/media/PlaybackSyncCoordinator';

import {
  createGroupPlaybackSyncTransport,
  decodeTarget,
  encodeTarget,
} from './GroupPlaybackSyncTransport';

const demo: PlaybackSyncTarget = { cameraId: 'cam-1', sourceKind: 'DEMO_VIDEO' };

/**
 * Drains the microtask queue.
 *
 * Adoption travels through three promises -- the publication, the conversion to
 * an allocation, and the coordinator adopting it -- so a fixed number of
 * `await Promise.resolve()` would be a count that breaks the next time one of
 * them gains a link.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

interface FakeChannel extends GroupChannel {
  readonly published: SessionCommandPublication[];
  /** The pair the server allocates for the next publication. */
  allocation: { epoch: bigint; sequence: bigint };
  failure: Error | null;
  deliver(event: Partial<GroupEventEnvelope>): void;
}

function fakeChannel(deviceId = 'device-a'): FakeChannel {
  const published: SessionCommandPublication[] = [];
  const listeners = new Set<(event: GroupEventEnvelope) => void>();
  const channel: FakeChannel = {
    groupId: 'group-a',
    deviceId,
    published,
    allocation: { epoch: 4n, sequence: 118n },
    failure: null,
    async publishDocumentDelta(): Promise<DocumentDeltaReceipt> {
      throw new Error('not used');
    },
    async publishSessionCommand(publication) {
      if (channel.failure !== null) throw channel.failure;
      published.push(publication);
      return {
        epoch: channel.allocation.epoch,
        sequence: channel.allocation.sequence,
        action: publication.action,
        target: publication.target,
        positionSeconds: publication.positionSeconds ?? 0,
        playbackRate: publication.playbackRate ?? 1,
        executeAtMs: publication.executeAtMs ?? 0,
        issuedByDeviceId: deviceId,
      } satisfies GroupSessionCommand;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    deliver(event) {
      const envelope: GroupEventEnvelope = {
        sequence: 9n,
        kind: 'session-command',
        actorDeviceId: 'device-b',
        documentId: '',
        documentDelta: new Uint8Array(0),
        hybridLogicalClock: 0n,
        occurredAt: '2026-08-26T09:00:00.000Z',
        ...event,
      };
      for (const listener of [...listeners]) listener(envelope);
    },
  };
  return channel;
}

/** A coordinator with a controllable clock and no real timers. */
function coordinator(channel: FakeChannel, onPublishFailed?: (error: unknown) => void) {
  const executed: PlaybackSyncCommand[] = [];
  let pending: { callback: () => void; delayMs: number }[] = [];
  const created = new PlaybackSyncCoordinator({
    onCommand: (command) => executed.push(command),
    deviceId: channel.deviceId,
    now: () => 1_000,
    executionDelayMs: 40,
    schedule: (callback, delayMs) => {
      pending.push({ callback, delayMs });
      return () => {
        pending = pending.filter((entry) => entry.callback !== callback);
      };
    },
    transport: createGroupPlaybackSyncTransport({
      channel,
      ...(onPublishFailed === undefined ? {} : { onPublishFailed }),
    }),
  });
  return {
    created,
    executed,
    delays: () => pending.map((entry) => entry.delayMs),
    run: () => {
      const due = pending;
      pending = [];
      for (const entry of due) entry.callback();
    },
  };
}

describe('playback target encoding', () => {
  it('round-trips a demo target through the single command string', () => {
    expect(decodeTarget(encodeTarget(demo))).toEqual(demo);
  });

  it('round-trips a material target', () => {
    const target: PlaybackSyncTarget = {
      cameraId: 'cam-2',
      sourceKind: 'LOCAL_MATERIAL',
      materialId: 'mat-000000000001',
    };
    expect(decodeTarget(encodeTarget(target))).toEqual(target);
  });

  it('refuses a target string it cannot read rather than guessing', () => {
    expect(decodeTarget('cam-1')).toBeNull();
    expect(decodeTarget('cam-1|RTSP|')).toBeNull();
    expect(decodeTarget('cam-1|LOCAL_MATERIAL|')).toBeNull();
  });
});

describe('PlaybackSyncCoordinator over the group transport', () => {
  it('takes the epoch and sequence the server allocated', async () => {
    const channel = fakeChannel();
    const test = coordinator(channel);

    const issued = test.created.publish({ action: 'PLAY', target: demo });
    expect(issued?.epoch).toBe(1);
    expect(issued?.sequence).toBe(1);
    await settle();

    // The server's numbering replaces the local pair; the command executes at
    // the instant it was scheduled for, not one round trip later.
    test.run();
    expect(test.executed).toHaveLength(1);
    expect(test.executed[0]?.epoch).toBe(4);
    expect(test.executed[0]?.sequence).toBe(118);
    expect(test.executed[0]?.executeAtMs).toBe(1_040);
  });

  it('sends no epoch or sequence of its own to the server', () => {
    const channel = fakeChannel();
    const test = coordinator(channel);

    test.created.publish({ action: 'SEEK', target: demo, positionSeconds: 12 });

    expect(channel.published).toEqual([
      {
        action: 'seek',
        target: 'cam-1|DEMO_VIDEO|',
        positionSeconds: 12,
        playbackRate: 1,
        executeAtMs: 1_040,
      },
    ]);
  });

  it('keeps the local schedule and reports a command the group refused', async () => {
    const channel = fakeChannel();
    const failures: unknown[] = [];
    const test = coordinator(channel, (error) => failures.push(error));
    channel.failure = new Error(
      'Only the group leader can issue session commands while the group is under leader authority.',
    );

    test.created.publish({ action: 'PLAY', target: demo });
    await settle();
    test.run();

    expect(failures).toHaveLength(1);
    // The operator's own screen still obeys the operator, at the local numbering.
    expect(test.executed).toHaveLength(1);
    expect(test.executed[0]?.epoch).toBe(1);
  });

  it('applies a command another device issued', () => {
    const channel = fakeChannel('device-a');
    const test = coordinator(channel);

    channel.deliver({
      sessionCommand: {
        epoch: 4n,
        sequence: 200n,
        action: 'pause',
        target: 'cam-1|DEMO_VIDEO|',
        positionSeconds: 3,
        playbackRate: 1,
        executeAtMs: 1_020,
        issuedByDeviceId: 'device-b',
      },
    });
    test.run();

    expect(test.executed).toHaveLength(1);
    expect(test.executed[0]?.action).toBe('PAUSE');
    expect(test.executed[0]?.sequence).toBe(200);
  });

  it('ignores the echo of its own session command', () => {
    const channel = fakeChannel('device-a');
    const test = coordinator(channel);

    channel.deliver({
      sessionCommand: {
        epoch: 4n,
        sequence: 200n,
        action: 'pause',
        target: 'cam-1|DEMO_VIDEO|',
        positionSeconds: 3,
        playbackRate: 1,
        executeAtMs: 1_020,
        issuedByDeviceId: 'device-a',
      },
    });
    test.run();

    expect(test.executed).toEqual([]);
  });

  it('ignores a group command that is not playback', () => {
    const channel = fakeChannel();
    const test = coordinator(channel);

    channel.deliver({
      sessionCommand: {
        epoch: 4n,
        sequence: 201n,
        action: 'navigate',
        target: 'cam-1|DEMO_VIDEO|',
        positionSeconds: 0,
        playbackRate: 1,
        executeAtMs: 1_020,
        issuedByDeviceId: 'device-b',
      },
    });
    test.run();

    expect(test.executed).toEqual([]);
  });
});
