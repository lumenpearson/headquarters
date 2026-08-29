import { describe, expect, it, vi } from 'vitest';

import type { ControlPlaneConfig } from '../config.js';
import { decodeGroupEventNotification, type GroupEventNotification } from '../realtime/fanout.js';

import {
  createUpstashCoordination,
  type CoordinationRedisClient,
  type CoordinationSubscription,
} from './coordination.js';
import {
  RealtimeFanoutUnsupportedError,
  createRedisRealtimeFanout,
  realtimeFanoutChannel,
} from './fanout.js';

const redisConfig: NonNullable<ControlPlaneConfig['redis']> = {
  restUrl: 'https://hq-redis.upstash.io',
  restToken: 'upstash-token',
};

const notification: GroupEventNotification = {
  groupId: 'group-01',
  sequence: 42n,
  originId: 'process-a',
};

describe('Redis realtime fan-out', () => {
  it('builds no carrier without a Redis configuration', () => {
    // Which is what keeps a control plane without Redis on exactly the
    // behaviour it had before a carrier existed.
    expect(
      createRedisRealtimeFanout({ coordination: createUpstashCoordination(undefined) }),
    ).toBeUndefined();
  });

  it('announces on the deployment channel and puts no event content on it', async () => {
    const channel = new FakeChannel();
    const fanout = createRedisRealtimeFanout({
      coordination: createUpstashCoordination(redisConfig, () => channel),
      originId: 'process-a',
    });

    await fanout?.announce(notification);

    expect(channel.published).toHaveLength(1);
    expect(channel.published[0]?.channel).toBe('hq:realtime:group-events');
    expect(channel.published[0]?.channel).toBe(realtimeFanoutChannel);
    // The whole message. A document delta, a presence record or a session
    // command reaching Redis would make the channel a second store of group
    // content; the announcement is a pointer into the one in PostgreSQL.
    expect(channel.published[0]?.message).toEqual({ g: 'group-01', s: '42', o: 'process-a' });
  });

  it('hands the hub what the sibling announced', async () => {
    const channel = new FakeChannel();
    const fanout = createRedisRealtimeFanout({
      coordination: createUpstashCoordination(redisConfig, () => channel),
      originId: 'process-a',
    });
    const received: GroupEventNotification[] = [];
    const release = await fanout?.listen((value) => received.push(value));

    expect(channel.subscribedTo).toEqual([realtimeFanoutChannel]);
    channel.emit({ g: 'group-02', s: '7', o: 'process-b' });
    await release?.();

    expect(received).toEqual([{ groupId: 'group-02', sequence: 7n, originId: 'process-b' }]);
    expect(channel.unsubscribed).toBe(true);
  });

  it('survives an unreadable message on a shared channel', async () => {
    const channel = new FakeChannel();
    const failures: unknown[] = [];
    const fanout = createRedisRealtimeFanout({
      coordination: createUpstashCoordination(redisConfig, () => channel),
      originId: 'process-a',
      onError: (error) => failures.push(error),
    });
    const received: GroupEventNotification[] = [];
    await fanout?.listen((value) => received.push(value));

    channel.emit('not an announcement');
    channel.emit({ g: 'group-02', s: '7', o: 'process-b' });

    // One unreadable message must not cost the stream every readable one
    // behind it.
    expect(received).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  it('reports an endpoint that answers commands but cannot stream', async () => {
    const channel = new FakeChannel();
    const failures: unknown[] = [];
    const fanout = createRedisRealtimeFanout({
      coordination: createUpstashCoordination(redisConfig, () =>
        channel.withoutPubSub('subscribe'),
      ),
      originId: 'process-a',
      onError: (error) => failures.push(error),
    });

    const release = await fanout?.listen(() => {});
    await release?.();

    // A proxy standing in for Upstash typically answers `PUBLISH` and refuses
    // the SSE route. The refusal is named on the way in, once, rather than
    // discovered as silence later.
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(RealtimeFanoutUnsupportedError);
    // The error text is written where a deployment's configuration must not
    // appear, so it names the consequence and not the endpoint.
    expect((failures[0] as Error).message).not.toContain(redisConfig.restUrl);
    expect((failures[0] as Error).message).not.toContain(redisConfig.restToken);
    // And the release still releases, so shutdown has one shape either way.
    expect(channel.unsubscribed).toBe(false);
  });

  it('announces without throwing on an endpoint that has no PUBLISH at all', async () => {
    const channel = new FakeChannel();
    const fanout = createRedisRealtimeFanout({
      coordination: createUpstashCoordination(redisConfig, () => channel.withoutPubSub('publish')),
      originId: 'process-a',
    });

    // The hub's contract: an announcement it cannot make costs the other
    // process's clients their live delivery and nothing else.
    await expect(fanout?.announce(notification)).resolves.toBeUndefined();
    expect(channel.published).toEqual([]);
  });

  it('round-trips through the codec both processes use', async () => {
    const channel = new FakeChannel();
    const fanout = createRedisRealtimeFanout({
      coordination: createUpstashCoordination(redisConfig, () => channel),
      originId: 'process-a',
    });

    await fanout?.announce(notification);

    expect(decodeGroupEventNotification(channel.published[0]?.message)).toEqual(notification);
  });
});

/**
 * A coordination client that records what reached the channel. Only the
 * pub/sub half is real; the key commands answer enough to satisfy the port.
 */
class FakeChannel implements CoordinationRedisClient {
  readonly published: Array<{ channel: string; message: unknown }> = [];
  readonly subscribedTo: string[] = [];
  unsubscribed = false;
  #handler: ((data: { readonly message: unknown }) => void) | undefined;

  publish = vi.fn(async (channel: string, message: unknown): Promise<number> => {
    this.published.push({ channel, message });
    return 1;
  });

  subscribe = (channel: string): CoordinationSubscription => {
    this.subscribedTo.push(channel);
    const subscription = {
      on: (event: 'message' | 'error', handler: (value: never) => void) => {
        if (event === 'message') {
          this.#handler = handler as unknown as (data: { readonly message: unknown }) => void;
        }
      },
      unsubscribe: async () => {
        this.unsubscribed = true;
      },
    };
    return subscription as unknown as CoordinationSubscription;
  };

  emit(message: unknown): void {
    this.#handler?.({ message });
  }

  /**
   * The same client with one of the optional pub/sub verbs absent, which is
   * what a REST proxy standing in for Upstash looks like. The property is
   * removed rather than set to `undefined`: under `exactOptionalPropertyTypes`
   * those are not the same thing, and the port says absent.
   */
  withoutPubSub(verb: 'publish' | 'subscribe'): CoordinationRedisClient {
    const client: CoordinationRedisClient = {
      set: this.set,
      sadd: this.sadd,
      srem: this.srem,
      del: this.del,
      expire: this.expire,
      smembers: this.smembers,
      mget: this.mget,
      incr: this.incr,
      createScript: this.createScript,
      ...(verb === 'publish' ? {} : { publish: this.publish }),
      ...(verb === 'subscribe' ? {} : { subscribe: this.subscribe }),
    };
    return client;
  }

  set = async (): Promise<'OK' | null> => 'OK';
  sadd = async (): Promise<number> => 1;
  srem = async (): Promise<number> => 1;
  del = async (): Promise<number> => 1;
  expire = async (): Promise<number> => 1;
  smembers = async (): Promise<string[]> => [];
  mget = async <Value>(): Promise<(Value | null)[]> => [];
  incr = async (): Promise<number> => 1;
  createScript = <Result>() => ({
    exec: async (): Promise<Result> => 1 as Result,
  });
}
