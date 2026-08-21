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
  positionSeconds = 0,
  issuedByDeviceId = 'device-b',
}: {
  readonly target: NonNullable<ReturnType<typeof createPlaybackSyncTarget>>;
  readonly sequence?: number;
  readonly issuedAtMs?: number;
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
    executeAtMs: issuedAtMs,
    issuedByDeviceId,
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function fail(message: string): never {
  throw new Error(message);
}
