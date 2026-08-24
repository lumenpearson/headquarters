import { describe, expect, it } from 'vitest';

import { createUpstashCoordination, type CoordinationRedisClient } from '../redis/coordination.js';

import { CoordinatedPresenceStore } from './coordinated-presence-store.js';
import { InMemoryPresenceStore } from './presence-store.js';

/**
 * These are offline: the fake client stands in for Upstash so the composition
 * can be exercised without a cloud connection. What they cannot show is TTL
 * expiry in real time — the fake forgets a key only when the test tells it to,
 * which is enough to prove the read path and nothing about Redis itself.
 */
describe('coordinated presence store', () => {
  it('reports a device offline once its liveness key has gone', async () => {
    const redis = new FakeRedis();
    const store = coordinatedStore(redis);

    await store.record({ groupId: 'group-01', deviceId: 'device-01', status: 'ONLINE' });
    expect((await store.list('group-01'))[0]?.status).toBe('ONLINE');

    redis.expireAll();

    const listed = await store.list('group-01');
    // The durable row still says ONLINE. Presence must not: a device that
    // stopped reporting an hour ago is not present, and the row cannot know it.
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe('OFFLINE');
  });

  it('prefers the live screen and latency over the last durable reading', async () => {
    const redis = new FakeRedis();
    const durable = new InMemoryPresenceStore();
    const store = new CoordinatedPresenceStore(
      durable,
      createUpstashCoordination(
        { restUrl: 'https://example.invalid', restToken: 'token' },
        () => redis,
      ),
    );

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
    const redis = new FakeRedis();
    const durable = new InMemoryPresenceStore();
    const store = new CoordinatedPresenceStore(
      durable,
      createUpstashCoordination(
        { restUrl: 'https://example.invalid', restToken: 'token' },
        () => redis,
      ),
    );
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

function coordinatedStore(redis: FakeRedis): CoordinatedPresenceStore {
  return new CoordinatedPresenceStore(
    new InMemoryPresenceStore(),
    createUpstashCoordination(
      { restUrl: 'https://example.invalid', restToken: 'token' },
      () => redis,
    ),
  );
}

class FakeRedis implements CoordinationRedisClient {
  readonly #values = new Map<string, unknown>();
  readonly #sets = new Map<string, Set<string>>();

  set(key: string, value: unknown): Promise<'OK' | null> {
    this.#values.set(key, value);
    return Promise.resolve('OK');
  }

  sadd(key: string, ...members: readonly string[]): Promise<number> {
    const set = this.#sets.get(key) ?? new Set<string>();
    for (const member of members) set.add(member);
    this.#sets.set(key, set);
    return Promise.resolve(members.length);
  }

  expire(): Promise<number> {
    return Promise.resolve(1);
  }

  smembers(key: string): Promise<string[]> {
    return Promise.resolve([...(this.#sets.get(key) ?? [])]);
  }

  mget<Value>(...keys: readonly string[]): Promise<(Value | null)[]> {
    return Promise.resolve(keys.map((key) => (this.#values.get(key) as Value | undefined) ?? null));
  }

  incr(): Promise<number> {
    return Promise.resolve(1);
  }

  createScript<Result>(): { exec: () => Promise<Result> } {
    return { exec: () => Promise.reject(new Error('not used by these tests')) };
  }

  /** Stands in for every liveness key reaching its TTL at once. */
  expireAll(): void {
    this.#values.clear();
  }
}
