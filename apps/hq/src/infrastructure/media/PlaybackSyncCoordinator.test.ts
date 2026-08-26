import { describe, expect, it } from 'vitest';

import {
  createPlaybackSyncTarget,
  PlaybackSyncCoordinator,
  type PlaybackSyncCommand,
  type PlaybackSyncTransport,
} from './PlaybackSyncCoordinator';

class MemoryTransport implements PlaybackSyncTransport {
  readonly listeners = new Set<(command: PlaybackSyncCommand) => void>();
  readonly published: PlaybackSyncCommand[] = [];

  publish(command: PlaybackSyncCommand): void {
    this.published.push(command);
  }

  subscribe(listener: (command: PlaybackSyncCommand) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
  }

  receive(command: PlaybackSyncCommand): void {
    for (const listener of this.listeners) listener(command);
  }
}

describe('PlaybackSyncCoordinator', () => {
  it('issues an ordered, delayed command without a local media URL', () => {
    let now = 1_000;
    const scheduled: Array<() => void> = [];
    const applied: PlaybackSyncCommand[] = [];
    const transport = new MemoryTransport();
    const coordinator = new PlaybackSyncCoordinator({
      deviceId: 'device-a',
      transport,
      now: () => now,
      schedule: (callback) => {
        scheduled.push(callback);
        return () => undefined;
      },
      onCommand: (command) => applied.push(command),
    });
    const target = createPlaybackSyncTarget('K-17', 'LOCAL_MATERIAL', uuid(1));

    const command = coordinator.publish({
      action: 'PLAY',
      target: target ?? fail('Expected local material target'),
      positionSeconds: 12.5,
      playbackRate: 1.5,
    });

    if (command === null) throw new Error('Expected a local playback command.');

    expect(command).toMatchObject({
      epoch: 1,
      sequence: 1,
      executeAtMs: 1_040,
      positionSeconds: 12.5,
      playbackRate: 1.5,
    });
    expect(JSON.stringify(command)).not.toContain('blob:');
    expect(JSON.stringify(command)).not.toContain('material-playback');
    expect(transport.published).toEqual([command]);
    expect(applied).toEqual([]);
    scheduled.forEach((callback) => callback());
    expect(applied).toEqual([command]);
    now += 1;
    coordinator.close();
  });

  it('accepts only the newest command for one source and rejects duplicate sequence values', () => {
    const scheduled: Array<() => void> = [];
    const applied: PlaybackSyncCommand[] = [];
    const transport = new MemoryTransport();
    const coordinator = new PlaybackSyncCoordinator({
      deviceId: 'device-a',
      transport,
      now: () => 1_000,
      schedule: (callback) => {
        scheduled.push(callback);
        return () => undefined;
      },
      onCommand: (command) => applied.push(command),
    });
    const target = createPlaybackSyncTarget('K-17', 'DEMO_VIDEO') ?? fail('Expected demo target');
    const first = remoteCommand({ target, sequence: 1, issuedAtMs: 1_010, positionSeconds: 3 });
    const latest = remoteCommand({ target, sequence: 2, issuedAtMs: 1_020, positionSeconds: 8 });

    transport.receive(first);
    transport.receive(first);
    transport.receive(latest);
    scheduled.forEach((callback) => callback());

    expect(applied).toEqual([latest]);
    coordinator.close();
  });

  it('stamps and schedules on the group clock, applying the offset exactly once', () => {
    const now = 1_000_000;
    const delays: number[] = [];
    const scheduled: Array<() => void> = [];
    const applied: PlaybackSyncCommand[] = [];
    const transport = new MemoryTransport();
    const coordinator = new PlaybackSyncCoordinator({
      deviceId: 'device-a',
      transport,
      now: () => now,
      // This machine's clock reads 250 ms behind the control plane's.
      clockOffsetMs: () => 250,
      schedule: (callback, delayMs) => {
        delays.push(delayMs);
        scheduled.push(callback);
        return () => undefined;
      },
      onCommand: (command) => applied.push(command),
    });
    const target = createPlaybackSyncTarget('K-17', 'DEMO_VIDEO') ?? fail('Expected demo target');

    const command = coordinator.publish({ action: 'PLAY', target });

    if (command === null) throw new Error('Expected a local playback command.');
    // The two instants on the wire are the group's clock, not this machine's.
    expect(command.issuedAtMs).toBe(1_000_250);
    expect(command.executeAtMs).toBe(1_000_290);
    /*
     * The delay is a duration, and a duration carries no offset at all: the
     * publisher's own timer still waits exactly the lead. Applying the offset
     * a second time here would arm it 250 ms out, which is the double-count
     * the single conversion point exists to prevent.
     */
    expect(delays).toEqual([40]);
    scheduled.forEach((callback) => callback());
    expect(applied).toEqual([command]);
    coordinator.close();
  });

  it('converts an arriving command with the estimate current at that moment', () => {
    const now = 1_000_000;
    let offsetMs = 0;
    const delays: number[] = [];
    const scheduled: Array<() => void> = [];
    const applied: PlaybackSyncCommand[] = [];
    const transport = new MemoryTransport();
    const coordinator = new PlaybackSyncCoordinator({
      deviceId: 'device-a',
      transport,
      now: () => now,
      clockOffsetMs: () => offsetMs,
      schedule: (callback, delayMs) => {
        delays.push(delayMs);
        scheduled.push(callback);
        return () => undefined;
      },
      onCommand: (command) => applied.push(command),
    });
    const target = createPlaybackSyncTarget('K-17', 'DEMO_VIDEO') ?? fail('Expected demo target');

    // The first `TimeSync` round completes after the coordinator was built.
    offsetMs = 500;
    transport.receive(
      remoteCommand({ target, sequence: 1, issuedAtMs: 1_000_000, executeAtMs: 1_002_000 }),
    );

    // 1_002_000 on the group's clock is 1_001_500 on this one: 1_500 ms away.
    expect(delays).toEqual([1_500]);
    /*
     * A later round lands while the timer is already armed, and nothing
     * re-arms. A pending command waits at most the lead -- 30 s at the ceiling
     * -- and drift over that window is far below what this estimate can
     * resolve, while re-timing would move the instant on the screens that
     * happen to hold a pending command and on no others.
     */
    offsetMs = 900;
    scheduled.forEach((callback) => callback());
    expect(delays).toEqual([1_500]);
    expect(applied).toHaveLength(1);
    coordinator.close();
  });

  it('treats an unusable clock estimate as no estimate at all', () => {
    /*
     * The offset is read out of a store slice, and a round that never produced
     * a sample leaves arithmetic that can answer `NaN`. Carried into the
     * instant it would poison both ends at once: `isPlaybackSyncCommand`
     * refuses a non-finite `executeAtMs`, so every other screen would drop the
     * command, while `Math.max(0, NaN)` is `NaN` and this one would run it
     * immediately. Falling back to zero is the local-only behaviour, which is
     * the correct answer for a machine whose estimate is unusable.
     */
    const delays: number[] = [];
    const transport = new MemoryTransport();
    const coordinator = new PlaybackSyncCoordinator({
      deviceId: 'device-a',
      transport,
      now: () => 1_000_000,
      clockOffsetMs: () => Number.NaN,
      schedule: (_callback, delayMs) => {
        delays.push(delayMs);
        return () => undefined;
      },
      onCommand: () => undefined,
    });
    const target = createPlaybackSyncTarget('K-17', 'DEMO_VIDEO') ?? fail('Expected demo target');

    const command = coordinator.publish({ action: 'PLAY', target });

    expect(command?.executeAtMs).toBe(1_000_040);
    expect(delays).toEqual([40]);
    coordinator.close();
  });

  it('enforces leader authority and never exposes webcam or path targets', () => {
    const applied: PlaybackSyncCommand[] = [];
    const transport = new MemoryTransport();
    const coordinator = new PlaybackSyncCoordinator({
      deviceId: 'viewer',
      authority: 'LEADER',
      leaderDeviceId: 'leader',
      transport,
      schedule: (callback) => {
        callback();
        return () => undefined;
      },
      onCommand: (command) => applied.push(command),
    });
    const demo = createPlaybackSyncTarget('K-17', 'DEMO_VIDEO') ?? fail('Expected demo target');

    expect(coordinator.publish({ action: 'PLAY', target: demo })).toBeNull();
    transport.receive(remoteCommand({ target: demo, issuedByDeviceId: 'viewer' }));
    transport.receive(remoteCommand({ target: demo, issuedByDeviceId: 'leader', sequence: 2 }));

    expect(createPlaybackSyncTarget('K-17', 'LOCAL_MATERIAL', 'not-a-uuid')).toBeNull();
    expect(applied).toHaveLength(1);
    expect(applied[0]?.issuedByDeviceId).toBe('leader');
    coordinator.close();
  });
});

function remoteCommand({
  target,
  sequence = 1,
  issuedAtMs = 1_000,
  executeAtMs = issuedAtMs,
  positionSeconds = 0,
  issuedByDeviceId = 'device-b',
}: {
  readonly target: NonNullable<ReturnType<typeof createPlaybackSyncTarget>>;
  readonly sequence?: number;
  readonly issuedAtMs?: number;
  readonly executeAtMs?: number;
  readonly positionSeconds?: number;
  readonly issuedByDeviceId?: string;
}): PlaybackSyncCommand {
  return {
    epoch: 1,
    sequence,
    action: 'SEEK',
    target,
    positionSeconds,
    playbackRate: 1,
    issuedAtMs,
    executeAtMs,
    issuedByDeviceId,
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function fail(message: string): never {
  throw new Error(message);
}
