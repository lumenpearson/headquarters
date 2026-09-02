import { describe, expect, it, vi } from 'vitest';

import type { ControlPlaneConfig } from '../config.js';
import {
  createUpstashCoordination,
  RedisConfigurationError,
  type CoordinationClientFactory,
  type CoordinationRedisClient,
  type RateLimiterFactory,
} from './coordination.js';

const redisConfig: NonNullable<ControlPlaneConfig['redis']> = {
  restUrl: 'https://hq-redis.upstash.io',
  restToken: 'upstash-token',
};

describe('Upstash coordination', () => {
  it('creates the Redis client lazily and stores bounded presence under a group namespace', async () => {
    const calls: Array<{ method: string; args: readonly unknown[] }> = [];
    const client = fakeRedis(calls);
    const factory = vi.fn<CoordinationClientFactory>(() => client);
    const coordination = createUpstashCoordination(redisConfig, factory);

    expect(coordination.configured).toBe(true);
    expect(coordination.initialized).toBe(false);
    expect(factory).not.toHaveBeenCalled();

    await coordination.recordPresence({
      groupId: 'group/01',
      deviceId: 'device:one',
      activeScreen: 'video',
      clockOffsetMs: 7,
      latencyMs: 12,
      ttlSeconds: 45,
    });

    expect(factory).toHaveBeenCalledExactlyOnceWith(redisConfig);
    expect(coordination.initialized).toBe(true);
    expect(calls).toContainEqual({
      method: 'set',
      args: [
        'hq:group:group%2F01:presence:device%3Aone',
        expect.objectContaining({ deviceId: 'device:one', activeScreen: 'video' }),
        { ex: 45 },
      ],
    });
    expect(calls).toContainEqual({
      method: 'sadd',
      args: ['hq:group:group%2F01:presence:members', 'device:one'],
    });
    expect(calls).toContainEqual({
      method: 'expire',
      args: ['hq:group:group%2F01:presence:members', 45],
    });
  });

  it('renews a liveness key without rewriting it, and withdraws one outright', async () => {
    const calls: Array<{ method: string; args: readonly unknown[] }> = [];
    const coordination = createUpstashCoordination(redisConfig, () => fakeRedis(calls));

    await expect(
      coordination.renewPresence({ groupId: 'group-01', deviceId: 'device-01' }),
    ).resolves.toBe(true);
    await coordination.forgetPresence({ groupId: 'group-01', deviceId: 'device-01' });

    // A change detector for the statement, not a proof of expiry: what a
    // renewal does to a key that is or is not there is proved against a
    // deadline-keeping double in `sync/coordinated-presence-store.test.ts`.
    // Both keys travel in one script because `listPresence` reads the
    // membership set first, and the default lease is the same forty-five
    // seconds an announcement gets.
    expect(calls).toContainEqual({
      method: 'script.exec',
      args: [
        'RENEW-PRESENCE',
        ['hq:group:group-01:presence:device-01', 'hq:group:group-01:presence:members'],
        ['45'],
      ],
    });
    // Nothing is written: a renewal must not be able to invent a device that
    // never joined, and it does not overwrite what one reported either.
    expect(calls.map((call) => call.method)).not.toContain('set');
    expect(calls).toContainEqual({
      method: 'del',
      args: ['hq:group:group-01:presence:device-01'],
    });
    expect(calls).toContainEqual({
      method: 'srem',
      args: ['hq:group:group-01:presence:members', 'device-01'],
    });
  });

  it('writes a report through one guarded script rather than a plain set', async () => {
    const calls: Array<{ method: string; args: readonly unknown[] }> = [];
    const coordination = createUpstashCoordination(redisConfig, () => fakeRedis(calls));

    await expect(
      coordination.reportPresence({
        groupId: 'group-01',
        deviceId: 'device-01',
        activeScreen: '/materials',
        clockOffsetMs: -4,
        latencyMs: 11,
      }),
    ).resolves.toBe(true);

    // A change detector for the statement, not a proof of expiry: what a report
    // does to a key that is or is not there is proved against a
    // deadline-keeping double in `sync/coordinated-presence-store.test.ts`.
    // Both keys travel in one script for the same reason the renewal's do, and
    // the value is serialized here because a script argument is a string while
    // `listPresence` parses JSON.
    const script = calls.find((call) => call.method === 'script.exec');
    expect(script?.args[0]).toBe('REPORT-PRESENCE');
    expect(script?.args[1]).toEqual([
      'hq:group:group-01:presence:device-01',
      'hq:group:group-01:presence:members',
    ]);
    const [payload, ttl] = script?.args[2] as [string, string];
    expect(JSON.parse(payload)).toMatchObject({
      deviceId: 'device-01',
      activeScreen: '/materials',
      clockOffsetMs: -4,
      latencyMs: 11,
    });
    expect(ttl).toBe('45');
    // Nothing is written outside the script: a plain `set` would create the key
    // for a device that had left or lapsed, which is precisely what reporting
    // must not be able to do.
    expect(calls.map((call) => call.method)).not.toContain('set');
    expect(calls.map((call) => call.method)).not.toContain('sadd');
  });

  it('uses compare-and-set scripts for lease renewal and release', async () => {
    const calls: Array<{ method: string; args: readonly unknown[] }> = [];
    const coordination = createUpstashCoordination(redisConfig, () => fakeRedis(calls));

    await expect(
      coordination.renewLeaderLease({ groupId: 'group-01', deviceId: 'device-01', ttlSeconds: 15 }),
    ).resolves.toBe(true);
    await expect(
      coordination.releaseLeaderLease({ groupId: 'group-01', deviceId: 'device-01' }),
    ).resolves.toBe(false);

    expect(calls).toContainEqual({
      method: 'script.exec',
      args: ['EXPIRE', ['hq:group:group-01:leader'], ['device-01', '15']],
    });
    expect(calls).toContainEqual({
      method: 'script.exec',
      args: ['DEL', ['hq:group:group-01:leader'], ['device-01']],
    });
  });

  it('delegates mutation limits to the hardened Upstash rate-limit primitive', async () => {
    const rateLimiterFactory = vi.fn<RateLimiterFactory>(() => ({
      limit: async () => ({
        success: false,
        limit: 120,
        remaining: 0,
        reset: 1_725_000_000_000,
        pending: Promise.resolve(),
      }),
    }));
    const coordination = createUpstashCoordination(
      redisConfig,
      () => fakeRedis([]),
      rateLimiterFactory,
    );

    await expect(
      coordination.limitMutation('group-01', 'device-01', 'settings.publish'),
    ).resolves.toEqual({
      allowed: false,
      limit: 120,
      remaining: 0,
      resetAtMs: 1_725_000_000_000,
    });
    expect(rateLimiterFactory).toHaveBeenCalledOnce();
  });

  it('does not initialize an absent Redis configuration', async () => {
    const coordination = createUpstashCoordination(undefined);

    expect(() => coordination.nextSequence('group-01', 'settings')).toThrow(
      RedisConfigurationError,
    );
    // Renewal is no exception: without Redis there is no key with a clock
    // running out, so the path that would renew one must not quietly open a
    // connection to look for it.
    await expect(
      coordination.renewPresence({ groupId: 'group-01', deviceId: 'device-01' }),
    ).rejects.toThrow(RedisConfigurationError);
    expect(coordination.configured).toBe(false);
    expect(coordination.initialized).toBe(false);
  });
});

function fakeRedis(
  calls: Array<{ method: string; args: readonly unknown[] }>,
): CoordinationRedisClient {
  return {
    async set(...args) {
      calls.push({ method: 'set', args });
      return 'OK';
    },
    async sadd(...args) {
      calls.push({ method: 'sadd', args });
      return 1;
    },
    async srem(...args) {
      calls.push({ method: 'srem', args });
      return 1;
    },
    async del(...args) {
      calls.push({ method: 'del', args });
      return 1;
    },
    async expire(...args) {
      calls.push({ method: 'expire', args });
      return 1;
    },
    async smembers(...args) {
      calls.push({ method: 'smembers', args });
      return [];
    },
    async mget(...args) {
      calls.push({ method: 'mget', args });
      return [];
    },
    async incr(...args) {
      calls.push({ method: 'incr', args });
      return 1;
    },
    createScript<Result>(source: string) {
      // The lease scripts compare a holder before acting, so they read; the
      // presence renewal only extends, and the presence report guards its write
      // on `EXISTS`. Classifying on those two words keeps the four apart now
      // that three of them call `EXPIRE`.
      const operation = source.includes('EXISTS')
        ? 'REPORT-PRESENCE'
        : !source.includes('GET')
          ? 'RENEW-PRESENCE'
          : source.includes('EXPIRE')
            ? 'EXPIRE'
            : 'DEL';
      return {
        async exec(keys: readonly string[], args: readonly string[]): Promise<Result> {
          calls.push({ method: 'script.exec', args: [operation, keys, args] });
          // The scripts under test answer a numeric reply; the port is generic in it,
          // so the double casts rather than the port narrowing to please a test.
          return (operation === 'DEL' ? 0 : 1) as Result;
        },
      };
    },
  };
}
