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
    const calls: Array<{ method: string; args: unknown[] }> = [];
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

  it('uses compare-and-set scripts for lease renewal and release', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
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

  it('does not initialize an absent Redis configuration', () => {
    const coordination = createUpstashCoordination(undefined);

    expect(() => coordination.nextSequence('group-01', 'settings')).toThrow(
      RedisConfigurationError,
    );
    expect(coordination.configured).toBe(false);
    expect(coordination.initialized).toBe(false);
  });
});

function fakeRedis(calls: Array<{ method: string; args: unknown[] }>): CoordinationRedisClient {
  return {
    async set(...args) {
      calls.push({ method: 'set', args });
      return 'OK';
    },
    async sadd(...args) {
      calls.push({ method: 'sadd', args });
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
    createScript(source) {
      const operation = source.includes('EXPIRE') ? 'EXPIRE' : 'DEL';
      return {
        async exec(keys, args) {
          calls.push({ method: 'script.exec', args: [operation, keys, args] });
          return operation === 'EXPIRE' ? 1 : 0;
        },
      };
    },
  };
}
