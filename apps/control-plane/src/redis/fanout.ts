import { randomUUID } from 'node:crypto';

import {
  decodeGroupEventNotification,
  encodeGroupEventNotification,
  type RealtimeFanout,
} from '../realtime/fanout.js';

import type { UpstashCoordination } from './coordination.js';

/**
 * One channel for the whole deployment, not one per group.
 *
 * A per-group channel would let a process receive only the groups it holds
 * sockets for, at the cost of subscribing and unsubscribing as groups gain and
 * lose their last local connection — a second piece of distributed state, kept
 * over an SSE stream, that has to be right for fan-out to be right. A single
 * channel makes the filter local and free: the hub drops an announcement for a
 * group it has no audience for before it reads anything.
 *
 * What it costs is that every process sees every group's announcements. The
 * announcement is a group id and a number, so the traffic is proportional to
 * publications rather than to their size, and this deployment shape is a
 * handful of replicas serving one shoot.
 *
 * The prefix matches the coordination keys: an Upstash database is not shared
 * between deployments here, and `hq:` says whose it is if one ever is.
 */
export const realtimeFanoutChannel = 'hq:realtime:group-events';

export interface RedisRealtimeFanoutOptions {
  readonly coordination: UpstashCoordination;
  /** Overridable so a test can assert which process an announcement came from. */
  readonly originId?: string;
  readonly onError?: (error: unknown) => void;
}

/**
 * The production carrier: Redis pub/sub over the Upstash REST endpoint.
 *
 * Answers `undefined` when no Redis is configured, which is what keeps a
 * control plane without one on exactly the behaviour it had before this
 * existed — one process, its own sockets, and replay for everything else.
 */
export function createRedisRealtimeFanout(
  options: RedisRealtimeFanoutOptions,
): RealtimeFanout | undefined {
  const coordination = options.coordination;
  if (!coordination.configured) return undefined;
  const originId = options.originId ?? randomUUID();
  const onError = options.onError ?? (() => {});

  return {
    originId,
    announce: async (notification) => {
      // The boolean answer is deliberately dropped here. An endpoint without
      // `PUBLISH` is not an error to raise per publication: the hub's contract
      // is that a failed announcement costs liveness only, and reporting it
      // once is `subscribeMessages` answering `undefined` on the way in.
      await coordination.publishMessage(
        realtimeFanoutChannel,
        encodeGroupEventNotification(notification),
      );
    },
    listen: (handler) => {
      const subscription = coordination.subscribeMessages(realtimeFanoutChannel, {
        onMessage: (message) => {
          // A malformed message is dropped, not thrown: the channel is shared
          // and one unreadable announcement must not tear down the stream that
          // every readable one behind it arrives on.
          const notification = decodeGroupEventNotification(message);
          if (notification !== undefined) handler(notification);
        },
        onError,
      });
      if (subscription === undefined) {
        onError(new RealtimeFanoutUnsupportedError());
        // A release that releases nothing, so shutdown has one shape whether or
        // not the endpoint could stream.
        return Promise.resolve(() => Promise.resolve());
      }
      return Promise.resolve(() => subscription.unsubscribe());
    },
  };
}

/**
 * Raised when the configured Redis REST endpoint answers commands but offers no
 * streaming subscribe — a stand-in proxy, typically. It names the consequence
 * rather than the endpoint: the message is written where a deployment's
 * configuration must not appear.
 */
export class RealtimeFanoutUnsupportedError extends Error {
  constructor() {
    super('The configured Redis endpoint offers no pub/sub subscribe');
    this.name = 'RealtimeFanoutUnsupportedError';
  }
}
