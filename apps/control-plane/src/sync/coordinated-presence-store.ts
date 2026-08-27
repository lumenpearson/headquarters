import type { UpstashCoordination } from '../redis/coordination.js';

import type {
  PresenceSnapshot,
  PresenceStore,
  RecordPresenceInput,
  RenewPresenceInput,
} from './presence-store.js';

/**
 * Presence read through Redis and written to both stores.
 *
 * The two stores answer different questions and neither answers both.
 * `presence_snapshots` remembers what a device last reported and survives a
 * restart; it cannot say whether that device is still there, because a row does
 * not expire. Redis keys do expire, which is exactly what liveness means — but
 * Redis holds nothing after a flush and knows nothing about membership.
 *
 * So the durable row stays the record of membership and last-known state, and
 * the Redis key decides `ONLINE` versus `OFFLINE` and supplies the fresher
 * screen, offset and latency. Without this composition a device that closed its
 * laptop an hour ago would still be reported as present, which is the one thing
 * presence exists to prevent.
 *
 * When Redis is not configured this decorator is not constructed at all; the
 * durable store is used directly and reports what was last recorded. That is a
 * weaker answer, and it is the honest one for a deployment with no Redis.
 */
export class CoordinatedPresenceStore implements PresenceStore {
  readonly #durable: PresenceStore;
  readonly #coordination: UpstashCoordination;

  constructor(durable: PresenceStore, coordination: UpstashCoordination) {
    if (!coordination.configured) {
      throw new Error(
        'CoordinatedPresenceStore requires a configured Upstash coordination client; ' +
          'use the durable store directly when Redis is absent',
      );
    }
    this.#durable = durable;
    this.#coordination = coordination;
  }

  async record(input: RecordPresenceInput): Promise<PresenceSnapshot> {
    // The durable write goes first because it is the one that authorizes: it
    // refuses a device whose membership was revoked. Publishing liveness for a
    // device that may not write is worse than losing a liveness update.
    const snapshot = await this.#durable.record(input);
    if (input.status === 'ONLINE') {
      await this.#coordination.recordPresence({
        groupId: input.groupId,
        deviceId: input.deviceId,
        ...(snapshot.activeScreen === '' ? {} : { activeScreen: snapshot.activeScreen }),
        ...(snapshot.selectedElement === '' ? {} : { selectedElement: snapshot.selectedElement }),
        clockOffsetMs: Number(snapshot.clockOffsetMs),
        latencyMs: snapshot.latencyMs,
      });
    } else {
      // Leaving withdraws the key rather than letting it run out. The durable
      // row already says OFFLINE, and `list` below prefers a live key over the
      // row, so a key left behind would keep reporting a departed device as
      // present — and, now that a read refreshes the caller's own key, would
      // keep reporting it for as long as the departed device stayed open.
      await this.#coordination.forgetPresence({
        groupId: input.groupId,
        deviceId: input.deviceId,
      });
    }
    return snapshot;
  }

  /**
   * Refreshes the caller's own liveness key, and touches neither store's state.
   *
   * The durable store has nothing to renew and says so; the Redis key is the
   * only thing here with a clock running out. The renewal cannot create a key,
   * so a device that never joined, or that left, stays absent from presence no
   * matter how often it reads it.
   */
  async renew(input: RenewPresenceInput): Promise<void> {
    await this.#coordination.renewPresence({
      groupId: input.groupId,
      deviceId: input.deviceId,
    });
  }

  async list(groupId: string): Promise<readonly PresenceSnapshot[]> {
    const durable = await this.#durable.list(groupId);
    const live = new Map(
      (await this.#coordination.listPresence(groupId)).map((record) => [record.deviceId, record]),
    );
    return durable.map((snapshot) => {
      const record = live.get(snapshot.deviceId);
      if (record === undefined) {
        // The key expired, so whatever the row says the device is not here.
        return snapshot.status === 'REVOKED' ? snapshot : { ...snapshot, status: 'OFFLINE' };
      }
      return {
        ...snapshot,
        status: 'ONLINE',
        activeScreen: record.activeScreen ?? snapshot.activeScreen,
        selectedElement: record.selectedElement ?? snapshot.selectedElement,
        clockOffsetMs: BigInt(Math.trunc(record.clockOffsetMs)),
        latencyMs: record.latencyMs,
        observedAt: new Date(record.observedAtMs),
      };
    });
  }
}
