import { describe, expect, it } from 'vitest';

import {
  createUpstashCoordination,
  type CoordinationRedisClient,
  type UpstashCoordination,
} from '../redis/coordination.js';

import { CoordinatedPresenceStore } from './coordinated-presence-store.js';
import { InMemoryPresenceStore } from './presence-store.js';

/**
 * These are offline: the fake client stands in for Upstash so the composition
 * can be exercised without a cloud connection. It keeps a deadline per key and
 * reads a clock the test moves, so expiry here is the same rule Redis applies —
 * what it cannot show is that Upstash applies that rule too, or that a REST
 * round trip behaves as the local map does.
 */
const presenceTtlSeconds = 45;
const pollIntervalSeconds = 15;

describe('coordinated presence store', () => {
  it('keeps a device that only ever asked who was present online past its lease', async () => {
    const clock = new TestClock();
    const redis = new FakeRedis(clock);
    const store = coordinatedStore(redis);

    await store.record({ groupId: 'group-01', deviceId: 'device-reader', status: 'ONLINE' });
    await store.record({ groupId: 'group-01', deviceId: 'device-silent', status: 'ONLINE' });

    // Ninety seconds — twice the forty-five-second lease — in the fifteen-second
    // steps the client already polls `GetPresence` at. Only one device asks.
    for (let elapsed = 0; elapsed < 90; elapsed += pollIntervalSeconds) {
      clock.advanceSeconds(pollIntervalSeconds);
      await store.renew({ groupId: 'group-01', deviceId: 'device-reader' });
    }

    const listed = await store.list('group-01');
    // Both halves belong to one assertion. A device still reported ONLINE
    // proves nothing on its own: before renewal existed, the durable row said
    // ONLINE too and the reading was simply wrong. What makes the first half
    // mean anything is the second — the device that stopped asking is gone,
    // from the same list, read at the same moment.
    expect(statusOf(listed, 'device-reader')).toBe('ONLINE');
    expect(statusOf(listed, 'device-silent')).toBe('OFFLINE');
  });

  it('cannot bring back a device whose lease has already lapsed', async () => {
    const clock = new TestClock();
    const store = coordinatedStore(new FakeRedis(clock));

    await store.record({ groupId: 'group-01', deviceId: 'device-01', status: 'ONLINE' });
    clock.advanceSeconds(presenceTtlSeconds + 1);
    await store.renew({ groupId: 'group-01', deviceId: 'device-01' });

    // Renewal extends; it never creates. Otherwise a device that closed its lid
    // an hour ago would reappear as present the moment something on its behalf
    // read the group, and announcing presence would stop being the one place
    // presence begins.
    expect(statusOf(await store.list('group-01'), 'device-01')).toBe('OFFLINE');
  });

  it('never lets a device that has not joined read itself into the group', async () => {
    const clock = new TestClock();
    const durable = new InMemoryPresenceStore();
    const store = coordinatedStore(new FakeRedis(clock), durable);
    // The durable row exists — the device is a member and reported once — but
    // it never entered the synchronized session.
    await durable.record({ groupId: 'group-01', deviceId: 'device-01', status: 'ONLINE' });

    await store.renew({ groupId: 'group-01', deviceId: 'device-01' });

    expect(statusOf(await store.list('group-01'), 'device-01')).toBe('OFFLINE');
  });

  it('withdraws a departing device at once and does not let it read itself back', async () => {
    const clock = new TestClock();
    const redis = new FakeRedis(clock);
    const { store, coordination } = coordinatedPair(redis);

    await store.record({ groupId: 'group-01', deviceId: 'device-01', status: 'ONLINE' });
    await store.record({ groupId: 'group-01', deviceId: 'device-01', status: 'OFFLINE' });
    // The departing client's next poll, before its lease would have run out.
    await store.renew({ groupId: 'group-01', deviceId: 'device-01' });

    expect(statusOf(await store.list('group-01'), 'device-01')).toBe('OFFLINE');
    // And the key is gone rather than merely overruled: leaving used to stay
    // invisible for up to a full lease, and with renewal it would have stayed
    // invisible for as long as the departed client kept polling.
    expect(await coordination.listPresence('group-01')).toEqual([]);
  });

  it('reports a device offline once its liveness key has gone', async () => {
    const clock = new TestClock();
    const store = coordinatedStore(new FakeRedis(clock));

    await store.record({ groupId: 'group-01', deviceId: 'device-01', status: 'ONLINE' });
    expect((await store.list('group-01'))[0]?.status).toBe('ONLINE');

    clock.advanceSeconds(presenceTtlSeconds);

    const listed = await store.list('group-01');
    // The durable row still says ONLINE. Presence must not: a device that
    // stopped reporting an hour ago is not present, and the row cannot know it.
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe('OFFLINE');
  });

  it('prefers the live screen and latency over the last durable reading', async () => {
    const durable = new InMemoryPresenceStore();
    const store = coordinatedStore(new FakeRedis(new TestClock()), durable);

    await durable.record({
      groupId: 'group-01',
      deviceId: 'device-01',
      status: 'ONLINE',
      activeScreen: '/stale',
      latencyMs: 900,
    });
    await store.record({
      groupId: 'group-01',
      deviceId: 'device-01',
      status: 'ONLINE',
      activeScreen: '/overview',
      latencyMs: 12,
    });

    const listed = await store.list('group-01');
    expect(listed[0]?.activeScreen).toBe('/overview');
    expect(listed[0]?.latencyMs).toBe(12);
  });

  it('leaves a revoked device revoked rather than calling it merely offline', async () => {
    const durable = new InMemoryPresenceStore();
    const store = coordinatedStore(new FakeRedis(new TestClock()), durable);
    await durable.record({ groupId: 'group-01', deviceId: 'device-01', status: 'REVOKED' });

    const listed = await store.list('group-01');
    expect(listed[0]?.status).toBe('REVOKED');
  });

  it('refuses to be constructed without a configured coordination client', () => {
    expect(
      () =>
        new CoordinatedPresenceStore(
          new InMemoryPresenceStore(),
          createUpstashCoordination(undefined),
        ),
    ).toThrow('requires a configured Upstash coordination client');
  });
});

function coordinatedStore(redis: FakeRedis, durable = new InMemoryPresenceStore()) {
  return coordinatedPair(redis, durable).store;
}

function coordinatedPair(
  redis: FakeRedis,
  durable = new InMemoryPresenceStore(),
): { readonly store: CoordinatedPresenceStore; readonly coordination: UpstashCoordination } {
  const coordination = createUpstashCoordination(
    { restUrl: 'https://example.invalid', restToken: 'token' },
    () => redis,
  );
  return { store: new CoordinatedPresenceStore(durable, coordination), coordination };
}

function statusOf(
  listed: readonly { readonly deviceId: string; readonly status: string }[],
  deviceId: string,
): string | undefined {
  return listed.find((snapshot) => snapshot.deviceId === deviceId)?.status;
}

/** Resolves a `KEYS[n]`/`ARGV[n]` slot against what the caller passed, or a Lua literal. */
function resolveSlot(reference: string, supplied: readonly string[]): string {
  const slot = /^(?:KEYS|ARGV)\[(\d)]$/.exec(reference);
  if (slot === null) return reference;
  return supplied[Number(slot[1]) - 1] ?? '';
}

/** The only clock the fake reads, so a lease can lapse without the test waiting. */
class TestClock {
  #nowMs = 1_756_000_000_000;

  get nowMs(): number {
    return this.#nowMs;
  }

  advanceSeconds(seconds: number): void {
    this.#nowMs += seconds * 1000;
  }
}

/**
 * A Redis with deadlines.
 *
 * Expiry is checked on access rather than swept, which is what makes the
 * difference between a renewed key and a lapsed one observable without waiting:
 * `EXPIRE` on a key that is already past its deadline answers 0, exactly as the
 * server does, and that is the answer the renewal script depends on.
 */
class FakeRedis implements CoordinationRedisClient {
  readonly #values = new Map<string, { value: unknown; expiresAtMs?: number }>();
  readonly #sets = new Map<string, { members: Set<string>; expiresAtMs?: number }>();
  readonly #clock: TestClock;

  constructor(clock: TestClock) {
    this.#clock = clock;
  }

  set(
    key: string,
    value: unknown,
    options?: { readonly ex?: number; readonly nx?: boolean },
  ): Promise<'OK' | null> {
    this.#values.set(key, {
      value,
      ...(options?.ex === undefined ? {} : { expiresAtMs: this.deadline(options.ex) }),
    });
    return Promise.resolve('OK');
  }

  sadd(key: string, ...members: readonly string[]): Promise<number> {
    const entry = this.liveSet(key) ?? { members: new Set<string>() };
    for (const member of members) entry.members.add(member);
    this.#sets.set(key, entry);
    return Promise.resolve(members.length);
  }

  srem(key: string, ...members: readonly string[]): Promise<number> {
    const entry = this.liveSet(key);
    if (entry === undefined) return Promise.resolve(0);
    let removed = 0;
    for (const member of members) if (entry.members.delete(member)) removed += 1;
    if (entry.members.size === 0) this.#sets.delete(key);
    return Promise.resolve(removed);
  }

  del(...keys: readonly string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.#values.delete(key)) removed += 1;
      if (this.#sets.delete(key)) removed += 1;
    }
    return Promise.resolve(removed);
  }

  expire(key: string, seconds: number): Promise<number> {
    const value = this.liveValue(key);
    if (value !== undefined) {
      value.expiresAtMs = this.deadline(seconds);
      return Promise.resolve(1);
    }
    const set = this.liveSet(key);
    if (set !== undefined) {
      set.expiresAtMs = this.deadline(seconds);
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
  }

  smembers(key: string): Promise<string[]> {
    return Promise.resolve([...(this.liveSet(key)?.members ?? [])]);
  }

  mget<Value>(...keys: readonly string[]): Promise<(Value | null)[]> {
    return Promise.resolve(keys.map((key) => (this.liveValue(key)?.value as Value) ?? null));
  }

  incr(): Promise<number> {
    return Promise.resolve(1);
  }

  /**
   * Runs the `EXPIRE` calls the script source actually contains, in order,
   * against this fake's own primitives.
   *
   * Reading the source rather than assuming it is the whole point: a double
   * that hardcoded what the renewal is supposed to do would keep passing after
   * the script stopped doing it — after it dropped the membership set, say, or
   * pinned the lease to a literal instead of the argument. The first call is
   * the guard, exactly as the Lua reads it: the rest run only if the device key
   * was there to extend.
   */
  createScript<Result>(source: string): {
    exec(keys: readonly string[], args: readonly string[]): Promise<Result>;
  } {
    if (source.includes('GET')) {
      return { exec: () => Promise.reject(new Error('leases are not used by these tests')) };
    }
    const calls = [
      ...source.matchAll(/redis\.call\("EXPIRE", (KEYS\[\d]|\d+), (ARGV\[\d]|\d+)\)/g),
    ];
    if (calls.length === 0) throw new Error('the presence script must call EXPIRE');
    return {
      exec: async (keys, args) => {
        let guard = 0;
        for (const [index, call] of calls.entries()) {
          const key = resolveSlot(call[1] ?? '', keys);
          const ttlSeconds = Number(resolveSlot(call[2] ?? '', args));
          const applied = await this.expire(key, ttlSeconds);
          if (index === 0) {
            guard = applied;
            if (guard !== 1) break;
          }
        }
        return guard as Result;
      },
    };
  }

  private deadline(seconds: number): number {
    return this.#clock.nowMs + seconds * 1000;
  }

  private liveValue(key: string): { value: unknown; expiresAtMs?: number } | undefined {
    const entry = this.#values.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs !== undefined && entry.expiresAtMs <= this.#clock.nowMs) {
      this.#values.delete(key);
      return undefined;
    }
    return entry;
  }

  private liveSet(key: string): { members: Set<string>; expiresAtMs?: number } | undefined {
    const entry = this.#sets.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs !== undefined && entry.expiresAtMs <= this.#clock.nowMs) {
      this.#sets.delete(key);
      return undefined;
    }
    return entry;
  }
}
