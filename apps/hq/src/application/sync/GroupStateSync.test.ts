import { describe, expect, it } from 'vitest';

import {
  initialConnectionState,
  type ConnectionState,
  type GroupDevice,
  type GroupSummary,
  type PresenceEntry,
} from './connection';
import type { GroupChannel, GroupEventEnvelope } from './groupChannel';
import { connectGroupState, groupStatePatch, type GroupStateView } from './GroupStateSync';

const baseMs = 1_700_000_000_000;

const group: GroupSummary = {
  groupId: 'group-a',
  name: 'ШТАБ',
  authority: 'leader',
  leaderDeviceId: 'device-a',
  revision: 7,
};

function view(overrides: Partial<GroupStateView> = {}): GroupStateView {
  return {
    groupRevision: 7,
    session: { deviceId: 'device-a', groupId: 'group-a', role: 'ADMIN' },
    devices: [],
    presence: [],
    ...overrides,
  };
}

function event(overrides: Partial<GroupEventEnvelope>): GroupEventEnvelope {
  return {
    sequence: 1n,
    kind: 'group-updated',
    actorDeviceId: 'device-b',
    documentId: '',
    documentDelta: new Uint8Array(0),
    hybridLogicalClock: 0n,
    occurredAt: new Date(baseMs).toISOString(),
    ...overrides,
  } as GroupEventEnvelope;
}

function device(overrides: Partial<GroupDevice> = {}): GroupDevice {
  return { deviceId: 'device-b', name: 'ЭКРАН 2', role: 'EDITOR', status: 'ONLINE', ...overrides };
}

function presence(overrides: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    deviceId: 'device-b',
    status: 'ONLINE',
    activeScreen: 'video',
    clockOffsetMs: 0,
    latencyMs: 4,
    observedAt: new Date(baseMs).toISOString(),
    ...overrides,
  };
}

/**
 * The channel reduced to the one thing this collaborator uses.
 *
 * A real `ControlPlaneGroupChannel` would drag the transport in; what is under
 * test here is the rule, and the merge point it sits behind is proved where the
 * two feeds are -- `GroupEventPoller.test.ts`.
 */
function channel(): GroupChannel & { emit: (event: GroupEventEnvelope) => void } {
  const listeners = new Set<(event: GroupEventEnvelope) => void>();
  return {
    groupId: 'group-a',
    deviceId: 'device-a',
    publishDocumentDelta: () => Promise.reject(new Error('not published here')),
    publishSessionCommand: () => Promise.reject(new Error('not published here')),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(next) {
      for (const listener of [...listeners]) listener(next);
    },
  };
}

describe('the group log moves the group', () => {
  it('moves the leader another device set, without any call being made', () => {
    const patch = groupStatePatch(
      view(),
      event({ group: { ...group, leaderDeviceId: 'device-b', revision: 8 } }),
    );

    /*
     * The whole point of the subscriber: an administrator on another machine
     * called `SetLeader`, this session called nothing, and what it holds about
     * the group changed anyway. Before this, the new leader was learned by the
     * next `JoinGroup` -- that is, by reconnecting.
     */
    expect(patch).toEqual({
      groupRevision: 8,
      groupName: 'ШТАБ',
      authority: 'leader',
      leaderDeviceId: 'device-b',
    });
  });

  it('takes the authority mode and the name from the same snapshot', () => {
    const patch = groupStatePatch(
      view(),
      event({
        group: { ...group, name: 'ШТАБ-2', authority: 'multi-authority', revision: 9 },
      }),
    );

    expect(patch?.authority).toBe('multi-authority');
    expect(patch?.groupName).toBe('ШТАБ-2');
  });

  it('refuses a snapshot the replayed window carried after a newer one', () => {
    /*
     * The trap this guard exists for. A feed resuming from a cursor of zero --
     * a fresh poller, or one the server sent back to the oldest retained
     * sequence -- replays every `GROUP_UPDATED` in the window. Each one is a
     * valid snapshot and every one of them is older than what `JoinGroup` just
     * established, so arrival order would put the previous leader back on
     * every resync.
     */
    const stale = groupStatePatch(
      view({ groupRevision: 9 }),
      event({ sequence: 40n, group: { ...group, leaderDeviceId: 'device-c', revision: 6 } }),
    );

    expect(stale).toBeNull();
  });

  it('refuses the snapshot of a mutation it has already recorded, whoever caused it', () => {
    // This device asked for the change and `SetLeader` answered it; the echo of
    // the same append is the same revision and therefore not news.
    const echo = groupStatePatch(
      view({ groupRevision: 8 }),
      event({
        actorDeviceId: 'device-a',
        group: { ...group, leaderDeviceId: 'device-b', revision: 8 },
      }),
    );

    expect(echo).toBeNull();
  });

  it('applies its own append when the answer to it never arrived', () => {
    /*
     * Why the echo is filtered by version and not by actor, which is what
     * `GroupLiveEditTransport` does. A `SetLeader` that was appended and whose
     * response was lost leaves this session holding the older revision; the
     * event is then the only copy of the outcome it will ever see, and dropping
     * it because "we caused it" would strand the session on the previous
     * leader until it reconnected.
     */
    const patch = groupStatePatch(
      view({ groupRevision: 7 }),
      event({
        actorDeviceId: 'device-a',
        group: { ...group, leaderDeviceId: 'device-b', revision: 8 },
      }),
    );

    expect(patch?.leaderDeviceId).toBe('device-b');
  });
});

describe('the group log moves a device', () => {
  it('records the role an administrator changed on another device', () => {
    const patch = groupStatePatch(
      view({ devices: [device({ role: 'EDITOR' }), device({ deviceId: 'device-c' })] }),
      event({
        kind: 'device-updated',
        device: device({ role: 'VIEWER' }),
        group: { ...group, revision: 8 },
      }),
    );

    expect(patch?.devices).toEqual([device({ role: 'VIEWER' }), device({ deviceId: 'device-c' })]);
    // The device list keeps its order: the surfaces render it as written and a
    // list that reshuffled on every role change would move the buttons under
    // the operator's hand.
    expect(patch?.devices?.[1]?.deviceId).toBe('device-c');
  });

  it('moves this session own role when the change is about this device', () => {
    const patch = groupStatePatch(
      view({ devices: [device({ deviceId: 'device-a', role: 'ADMIN' })] }),
      event({
        kind: 'device-updated',
        device: device({ deviceId: 'device-a', role: 'VIEWER' }),
        group: { ...group, revision: 8 },
      }),
    );

    /*
     * The observable consequence: the administrative controls are gated on
     * `connection.session.role`, so a demoted session that went on believing
     * itself an administrator would keep offering commands the server now
     * refuses.
     */
    expect(patch?.session).toEqual({ deviceId: 'device-a', groupId: 'group-a', role: 'VIEWER' });
  });

  it('leaves another device role change out of this session own role', () => {
    const patch = groupStatePatch(
      view(),
      event({
        kind: 'device-updated',
        device: device({ deviceId: 'device-b', role: 'VIEWER' }),
        group: { ...group, revision: 8 },
      }),
    );

    expect(patch?.session).toBeUndefined();
  });

  it('refuses a role the replayed window carried after a newer group revision', () => {
    const patch = groupStatePatch(
      view({ groupRevision: 12, devices: [device({ role: 'VIEWER' })] }),
      event({
        kind: 'device-updated',
        device: device({ role: 'ADMIN' }),
        group: { ...group, revision: 5 },
      }),
    );

    expect(patch).toBeNull();
  });
});

describe('the group log moves presence, and the timer keeps owning it', () => {
  it('adds a neighbour that joined between two presence ticks', () => {
    const patch = groupStatePatch(
      view({ presence: [presence({ deviceId: 'device-a' })] }),
      event({ kind: 'presence-updated', presence: presence({ deviceId: 'device-c' }) }),
    );

    expect(patch?.presence?.map((entry) => entry.deviceId)).toEqual(['device-a', 'device-c']);
  });

  it('turns a neighbour that left offline without waiting for the next tick', () => {
    const left = presence({
      status: 'OFFLINE',
      observedAt: new Date(baseMs + 1_000).toISOString(),
    });
    const patch = groupStatePatch(
      view({ presence: [presence()] }),
      event({ kind: 'presence-updated', presence: left }),
    );

    expect(patch?.presence).toEqual([left]);
  });

  it('never replaces the list the presence call owns', () => {
    const patch = groupStatePatch(
      view({ presence: [presence({ deviceId: 'device-a' }), presence({ deviceId: 'device-c' })] }),
      event({ kind: 'presence-updated', presence: presence({ deviceId: 'device-b' }) }),
    );

    /*
     * `GetPresence` on its fifteen-second timer is what renews this device's
     * own liveness key server-side and what reports the whole group. This path
     * writes down one device and nothing else, so the two cannot disagree about
     * who is present -- and it makes no call of its own, which would double a
     * metered invocation for a fact the timer already carries.
     */
    expect(patch?.presence).toHaveLength(3);
    expect(patch?.presence?.map((entry) => entry.deviceId)).toEqual([
      'device-a',
      'device-b',
      'device-c',
    ]);
  });

  it('refuses an observation older than the one it already holds', () => {
    const patch = groupStatePatch(
      view({ presence: [presence({ observedAt: new Date(baseMs + 60_000).toISOString() })] }),
      event({ kind: 'presence-updated', presence: presence({ status: 'OFFLINE' }) }),
    );

    // A replayed window carries the join of a device that has since gone quiet;
    // applying it would report a screen as live for up to fifteen seconds.
    expect(patch).toBeNull();
  });

  it('sorts online sessions first, in the order the presence call uses', () => {
    const patch = groupStatePatch(
      view({ presence: [presence({ deviceId: 'device-c', status: 'OFFLINE' })] }),
      event({ kind: 'presence-updated', presence: presence({ deviceId: 'device-a' }) }),
    );

    expect(patch?.presence?.map((entry) => entry.deviceId)).toEqual(['device-a', 'device-c']);
  });
});

describe('what the subscriber does not touch', () => {
  it('leaves the two kinds that already have a subscriber alone', () => {
    expect(groupStatePatch(view(), event({ kind: 'document-delta' }))).toBeNull();
    expect(groupStatePatch(view(), event({ kind: 'session-command' }))).toBeNull();
    // Decoded because the enum has it; appended by nothing in the control plane.
    expect(groupStatePatch(view(), event({ kind: 'snapshot-required' }))).toBeNull();
  });

  it('ignores a group event that carried no group', () => {
    expect(groupStatePatch(view(), event({}))).toBeNull();
    expect(groupStatePatch(view(), event({ kind: 'device-updated' }))).toBeNull();
    expect(groupStatePatch(view(), event({ kind: 'presence-updated' }))).toBeNull();
  });
});

describe('connectGroupState over a channel', () => {
  it('carries a leader change from the channel into one patch, and stops on unsubscribe', () => {
    const line = channel();
    let state: ConnectionState = { ...initialConnectionState, groupRevision: 7 };
    const patches: Partial<ConnectionState>[] = [];
    const disconnect = connectGroupState({
      channel: line,
      read: () => ({
        groupRevision: state.groupRevision,
        session: state.session,
        devices: state.devices,
        presence: state.presence,
      }),
      apply: (patch) => {
        patches.push(patch);
        state = { ...state, ...patch };
      },
    });

    line.emit(event({ group: { ...group, leaderDeviceId: 'device-b', revision: 8 } }));
    expect(state.leaderDeviceId).toBe('device-b');
    expect(state.groupRevision).toBe(8);

    // The same event again -- which is what a second feed carrying the same log
    // would hand a subscriber wired in front of the merge point.
    line.emit(event({ group: { ...group, leaderDeviceId: 'device-b', revision: 8 } }));
    expect(patches).toHaveLength(1);

    disconnect();
    line.emit(event({ group: { ...group, leaderDeviceId: 'device-c', revision: 9 } }));
    expect(state.leaderDeviceId).toBe('device-b');
    expect(patches).toHaveLength(1);
  });
});
