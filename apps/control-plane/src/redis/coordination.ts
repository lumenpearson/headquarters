import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

import type { ControlPlaneConfig } from '../config.js';

const defaultPresenceTtlSeconds = 45;
const defaultLeaseTtlSeconds = 15;

export interface PresenceRecord {
  readonly deviceId: string;
  readonly activeScreen?: string;
  readonly selectedElement?: string;
  readonly clockOffsetMs: number;
  readonly latencyMs: number;
  readonly observedAtMs: number;
}

export interface PresenceInput extends Omit<PresenceRecord, 'observedAtMs'> {
  readonly groupId: string;
  readonly ttlSeconds?: number;
}

/**
 * A renewal names only a group and a device: it carries no state, because it
 * changes none. What the device last reported stays exactly as `recordPresence`
 * left it; only the moment the key lapses moves.
 */
export interface PresenceRenewalInput {
  readonly groupId: string;
  readonly deviceId: string;
  readonly ttlSeconds?: number;
}

export interface LeaderLeaseInput {
  readonly groupId: string;
  readonly deviceId: string;
  readonly ttlSeconds?: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtMs: number;
}

interface RedisScript<Result> {
  exec(keys: readonly string[], args: readonly string[]): Promise<Result>;
}

export interface CoordinationRedisClient {
  set(
    key: string,
    value: unknown,
    options?: { readonly ex?: number; readonly nx?: boolean },
  ): Promise<'OK' | null>;
  sadd(key: string, ...members: readonly string[]): Promise<number>;
  srem(key: string, ...members: readonly string[]): Promise<number>;
  del(...keys: readonly string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  smembers(key: string): Promise<string[]>;
  mget<Value>(...keys: readonly string[]): Promise<(Value | null)[]>;
  incr(key: string): Promise<number>;
  createScript<Result>(source: string): RedisScript<Result>;
}

interface RateLimiter {
  limit(identifier: string): Promise<{
    readonly success: boolean;
    readonly limit: number;
    readonly remaining: number;
    readonly reset: number;
    readonly pending: Promise<unknown>;
  }>;
}

export type CoordinationClientFactory = (
  config: NonNullable<ControlPlaneConfig['redis']>,
) => CoordinationRedisClient;
export type RateLimiterFactory = (client: CoordinationRedisClient) => RateLimiter;

export class RedisConfigurationError extends Error {
  constructor() {
    super('Upstash Redis is not configured for this control-plane instance');
    this.name = 'RedisConfigurationError';
  }
}

/**
 * Redis owns ephemeral coordination only: database state remains the source
 * of truth. The adapter is deliberately lazy, so local UI and health checks do
 * not create a cloud connection in the absence of an Upstash configuration.
 */
export class UpstashCoordination {
  #client: CoordinationRedisClient | undefined;
  #mutationRateLimiter: RateLimiter | undefined;
  #renewPresenceScript: RedisScript<number> | undefined;
  #renewLeaseScript: RedisScript<number> | undefined;
  #releaseLeaseScript: RedisScript<number> | undefined;

  constructor(
    private readonly config: ControlPlaneConfig['redis'],
    private readonly clientFactory: CoordinationClientFactory = createRedisClient,
    private readonly rateLimiterFactory: RateLimiterFactory = createMutationRateLimiter,
  ) {}

  get configured(): boolean {
    return this.config !== undefined;
  }

  get initialized(): boolean {
    return this.#client !== undefined;
  }

  async recordPresence(input: PresenceInput): Promise<void> {
    const client = this.getClient();
    const ttlSeconds = normalizeTtl(input.ttlSeconds, defaultPresenceTtlSeconds);
    const record: PresenceRecord = {
      deviceId: input.deviceId,
      ...(input.activeScreen === undefined ? {} : { activeScreen: input.activeScreen }),
      ...(input.selectedElement === undefined ? {} : { selectedElement: input.selectedElement }),
      clockOffsetMs: input.clockOffsetMs,
      latencyMs: input.latencyMs,
      observedAtMs: Date.now(),
    };
    const membershipKey = presenceMembershipKey(input.groupId);

    await Promise.all([
      client.set(presenceKey(input.groupId, input.deviceId), record, { ex: ttlSeconds }),
      client.sadd(membershipKey, input.deviceId),
      client.expire(membershipKey, ttlSeconds),
    ]);
  }

  /**
   * Extends a liveness key that already exists, and nothing else.
   *
   * `EXPIRE` answers 0 for a key that is not there, so a renewal can only keep
   * alive what a join established: a device that left the session, or whose key
   * already lapsed, is not brought back by asking who is present. Announcing
   * presence stays the one operation that creates it, which is why this one is
   * cheap enough to run on every read.
   *
   * The membership set is extended inside the same script because
   * `listPresence` reads it first: letting the set lapse while the device keys
   * lived would report an empty group. Doing both in one script also means a
   * renewal cannot half-apply.
   */
  async renewPresence(input: PresenceRenewalInput): Promise<boolean> {
    const ttlSeconds = normalizeTtl(input.ttlSeconds, defaultPresenceTtlSeconds);
    const client = this.getClient();
    this.#renewPresenceScript ??= client.createScript<number>(
      'if redis.call("EXPIRE", KEYS[1], ARGV[1]) == 1 then redis.call("EXPIRE", KEYS[2], ARGV[1]) return 1 else return 0 end',
    );
    return (
      (await this.#renewPresenceScript.exec(
        [presenceKey(input.groupId, input.deviceId), presenceMembershipKey(input.groupId)],
        [String(ttlSeconds)],
      )) === 1
    );
  }

  /**
   * Withdraws a device's liveness immediately rather than waiting out its TTL.
   *
   * Leaving the synchronized session has to remove the key, not merely stop
   * refreshing it: a device that left and kept polling would otherwise renew
   * itself for as long as it stayed open, and until this existed a departure
   * was invisible for up to a full TTL anyway.
   */
  async forgetPresence(input: Pick<PresenceRenewalInput, 'groupId' | 'deviceId'>): Promise<void> {
    const client = this.getClient();
    await Promise.all([
      client.del(presenceKey(input.groupId, input.deviceId)),
      client.srem(presenceMembershipKey(input.groupId), input.deviceId),
    ]);
  }

  async listPresence(groupId: string): Promise<readonly PresenceRecord[]> {
    const client = this.getClient();
    const deviceIds = await client.smembers(presenceMembershipKey(groupId));
    if (deviceIds.length === 0) return [];
    const records = await client.mget<PresenceRecord>(
      ...deviceIds.map((deviceId) => presenceKey(groupId, deviceId)),
    );
    return records.filter((record): record is PresenceRecord => record !== null);
  }

  async acquireLeaderLease(input: LeaderLeaseInput): Promise<boolean> {
    const ttlSeconds = normalizeTtl(input.ttlSeconds, defaultLeaseTtlSeconds);
    const result = await this.getClient().set(leaderLeaseKey(input.groupId), input.deviceId, {
      nx: true,
      ex: ttlSeconds,
    });
    return result === 'OK';
  }

  async renewLeaderLease(input: LeaderLeaseInput): Promise<boolean> {
    const ttlSeconds = normalizeTtl(input.ttlSeconds, defaultLeaseTtlSeconds);
    const client = this.getClient();
    this.#renewLeaseScript ??= client.createScript<number>(
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("EXPIRE", KEYS[1], ARGV[2]) else return 0 end',
    );
    return (
      (await this.#renewLeaseScript.exec(
        [leaderLeaseKey(input.groupId)],
        [input.deviceId, String(ttlSeconds)],
      )) === 1
    );
  }

  async releaseLeaderLease(
    input: Pick<LeaderLeaseInput, 'groupId' | 'deviceId'>,
  ): Promise<boolean> {
    const client = this.getClient();
    this.#releaseLeaseScript ??= client.createScript<number>(
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
    );
    return (
      (await this.#releaseLeaseScript.exec([leaderLeaseKey(input.groupId)], [input.deviceId])) === 1
    );
  }

  nextSequence(groupId: string, stream: string): Promise<number> {
    return this.getClient().incr(sequenceKey(groupId, stream));
  }

  async limitMutation(
    groupId: string,
    deviceId: string,
    category: string,
  ): Promise<RateLimitDecision> {
    this.#mutationRateLimiter ??= this.rateLimiterFactory(this.getClient());
    const result = await this.#mutationRateLimiter.limit(
      `${keySegment(groupId)}:${keySegment(deviceId)}:${keySegment(category)}`,
    );
    void result.pending.catch(() => undefined);
    return {
      allowed: result.success,
      limit: result.limit,
      remaining: result.remaining,
      resetAtMs: result.reset,
    };
  }

  private getClient(): CoordinationRedisClient {
    if (this.config === undefined) throw new RedisConfigurationError();
    this.#client ??= this.clientFactory(this.config);
    return this.#client;
  }
}

export function createUpstashCoordination(
  config: ControlPlaneConfig['redis'],
  clientFactory?: CoordinationClientFactory,
  rateLimiterFactory?: RateLimiterFactory,
): UpstashCoordination {
  return new UpstashCoordination(config, clientFactory, rateLimiterFactory);
}

function createRedisClient(
  config: NonNullable<ControlPlaneConfig['redis']>,
): CoordinationRedisClient {
  return new Redis({
    url: config.restUrl,
    token: config.restToken,
  }) as unknown as CoordinationRedisClient;
}

function createMutationRateLimiter(client: CoordinationRedisClient): RateLimiter {
  return new Ratelimit({
    redis: client as unknown as Redis,
    limiter: Ratelimit.slidingWindow(120, '1 m'),
    prefix: 'hq:rate-limit:mutation',
    ephemeralCache: new Map(),
  }) as unknown as RateLimiter;
}

function normalizeTtl(value: number | undefined, fallback: number): number {
  const ttl = value ?? fallback;
  if (!Number.isInteger(ttl) || ttl < 5 || ttl > 300) {
    throw new Error('Redis coordination TTL must be an integer between 5 and 300 seconds');
  }
  return ttl;
}

function keySegment(value: string): string {
  return encodeURIComponent(value);
}

function presenceMembershipKey(groupId: string): string {
  return `hq:group:${keySegment(groupId)}:presence:members`;
}

function presenceKey(groupId: string, deviceId: string): string {
  return `hq:group:${keySegment(groupId)}:presence:${keySegment(deviceId)}`;
}

function leaderLeaseKey(groupId: string): string {
  return `hq:group:${keySegment(groupId)}:leader`;
}

function sequenceKey(groupId: string, stream: string): string {
  return `hq:group:${keySegment(groupId)}:sequence:${keySegment(stream)}`;
}
