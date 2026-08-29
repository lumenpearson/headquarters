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

  it('takes a revoked device out of the membership set, which a lapsed key never does', async () => {
    const clock = new TestClock();
    const redis = new FakeRedis(clock);
    const { store, coordination } = coordinatedPair(redis);
    for (const deviceId of ['device-live', 'device-revoked', 'device-silent']) {
      await store.record({ groupId: 'group-01', deviceId, status: 'ONLINE' });
    }

    await store.forget({ groupId: 'group-01', deviceId: 'device-revoked' });
    // The group stays awake: one device keeps polling, and the renewal script
    // extends the membership set along with that device's own key.
    for (let elapsed = 0; elapsed < 60; elapsed += pollIntervalSeconds) {
      clock.advanceSeconds(pollIntervalSeconds);
      await store.renew({ groupId: 'group-01', deviceId: 'device-live' });
    }

    // Both halves again, and this is the argument for withdrawing rather than
    // waiting. `device-silent` went quiet without leaving: its key lapsed, so
    // `listPresence` no longer reports it — and its identifier is still in the
    // set, because nothing but an explicit withdrawal ever removes one, and
    // the set outlives every key in it for as long as one device renews. The
    // revoked device is out of the set entirely, so it is not fetched again on
    // every poll for the life of the group.
    expect(await redis.smembers('hq:group:group-01:presence:members')).toEqual([
      'device-live',
      'device-silent',
    ]);
    expect((await coordination.listPresence('group-01')).map((entry) => entry.deviceId)).toEqual([
      'device-live',
    ]);
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

  it('shows a reported screen through the live key rather than the durable row', async () => {
    const clock = new TestClock();
    const durable = new InMemoryPresenceStore();
    const store = coordinatedStore(new FakeRedis(clock), durable);
    await store.record({
      groupId: 'group-01',
      deviceId: 'device-01',
      status: 'ONLINE',
      activeScreen: '/operations/map',
      latencyMs: 40,
    });

    const reported = await store.reportDetail({
      groupId: 'group-01',
      deviceId: 'device-01',
      activeScreen: '/materials',
      selectedElement: 'case-12',
      clockOffsetMs: -8n,
      latencyMs: 11,
    });

    expect(reported?.activeScreen).toBe('/materials');
    // `list` prefers the key over the row, so a report that reached only the
    // durable half would be invisible on exactly the deployments that have
    // Redis — the row would say `/materials` and every reader would still be
    // shown `/operations/map` from the key beside it.
    const listed = await store.list('group-01');
    expect(listed[0]).toMatchObject({
      status: 'ONLINE',
      activeScreen: '/materials',
      selectedElement: 'case-12',
      latencyMs: 11,
    });
  });

  it('extends the lease of a device that reports, and refuses to revive one that lapsed', async () => {
    const clock = new TestClock();
    const store = coordinatedStore(new FakeRedis(clock));
    await store.record({ groupId: 'group-01', deviceId: 'device-live', status: 'ONLINE' });
    await store.record({ groupId: 'group-01', deviceId: 'device-gone', status: 'ONLINE' });

    // Ninety seconds — twice the lease — reported in the fifteen-second steps a
    // client already polls at. Only one device reports.
    for (let elapsed = 0; elapsed < 90; elapsed += pollIntervalSeconds) {
      clock.advanceSeconds(pollIntervalSeconds);
      await store.reportDetail({
        groupId: 'group-01',
        deviceId: 'device-live',
        activeScreen: '/materials',
        selectedElement: '',
        clockOffsetMs: 0n,
        latencyMs: 12,
      });
    }
    const revived = await store.reportDetail({
      groupId: 'group-01',
      deviceId: 'device-gone',
      activeScreen: '/system',
      selectedElement: '',
      clockOffsetMs: 0n,
      latencyMs: 12,
    });

    const listed = await store.list('group-01');
    // Reporting a screen is evidence of being at it, so it keeps the reporter
    // alive — and the device that went quiet is gone from the same list, read
    // at the same moment.
    expect(statusOf(listed, 'device-live')).toBe('ONLINE');
    expect(statusOf(listed, 'device-gone')).toBe('OFFLINE');
    // The lapsed device's durable row is still updated — it is a member, and
    // what it last said is worth keeping — but the key stays gone, so the
    // report cannot put it back on the list. Announcing presence remains the
    // one operation that creates it.
    expect(revived?.activeScreen).toBe('/system');
    expect(listed.find((entry) => entry.deviceId === 'device-gone')?.activeScreen).toBe('/system');
  });

  it('refuses a report from a device with no presence row, and writes nothing for it', async () => {
    const clock = new TestClock();
    const redis = new FakeRedis(clock);
    const { store, coordination } = coordinatedPair(redis);

    const reported = await store.reportDetail({
      groupId: 'group-01',
      deviceId: 'device-never-joined',
      activeScreen: '/materials',
      selectedElement: '',
      clockOffsetMs: 0n,
      latencyMs: 5,
    });

    expect(reported).toBeUndefined();
    // Neither half took the report: the durable store answered no row, and the
    // Redis write is not even attempted, so nothing appears in the membership
    // set for a device that never joined.
    expect(await coordination.listPresence('group-01')).toEqual([]);
    expect(await redis.smembers('hq:group:group-01:presence:members')).toEqual([]);
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
   * Runs the calls the script source actually contains, in order, against this
   * fake's own primitives.
   *
   * Reading the source rather than assuming it is the whole point: a double
   * that hardcoded what the renewal is supposed to do would keep passing after
   * the script stopped doing it — after it dropped the membership set, say, or
   * pinned the lease to a literal instead of the argument. The first call is
   * the guard, exactly as the Lua reads it: the rest run only if it answered
   * one. That is `EXPIRE` for a renewal, which cannot extend a key that is not
   * there, and `EXISTS` for a report, which must not write one back.
   */
  createScript<Result>(source: string): {
    exec(keys: readonly string[], args: readonly string[]): Promise<Result>;
  } {
    if (source.includes('GET')) {
      return { exec: () => Promise.reject(new Error('leases are not used by these tests')) };
    }
    const calls = [...source.matchAll(/redis\.call\((?<operands>[^)]*)\)/gu)];
    if (calls.length === 0) throw new Error('the presence script must call Redis at all');
    return {
      exec: async (keys, args) => {
        let guard = 0;
        for (const [index, call] of calls.entries()) {
          const applied = await this.runScriptCall(
            (call.groups?.operands ?? '')
              .split(',')
              .map((operand) => operand.trim())
              .filter((operand) => operand.length > 0)
              .map((operand) =>
                operand.startsWith('KEYS')
                  ? resolveSlot(operand, keys)
                  : operand.startsWith('ARGV')
                    ? resolveSlot(operand, args)
                    : operand.replaceAll('"', ''),
              ),
          );
          if (index === 0) {
            guard = applied;
            if (guard !== 1) break;
          }
        }
        return guard as Result;
      },
    };
  }

  /**
   * The three commands the presence scripts use, and nothing else: an unknown
   * one fails rather than being ignored, so a script that starts doing
   * something this double does not model cannot pass by silence.
   *
   * `SET` parses its value because the real client serializes on write and
   * deserializes on read; a script argument is already a string, so storing it
   * raw here would make `listPresence` answer a JSON string where the
   * production client answers a record.
   */
  private async runScriptCall(operands: readonly string[]): Promise<number> {
    const [command, key, ...rest] = operands;
    if (command === 'EXISTS') return (await this.mget(key ?? ''))[0] === null ? 0 : 1;
    if (command === 'EXPIRE') return this.expire(key ?? '', Number(rest[0] ?? 0));
    if (command === 'SET') {
      const [value, , seconds] = rest;
      await this.set(key ?? '', JSON.parse(value ?? 'null'), { ex: Number(seconds ?? 0) });
      return 1;
    }
    throw new Error(`the presence scripts do not use ${command ?? 'an empty command'}`);
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
