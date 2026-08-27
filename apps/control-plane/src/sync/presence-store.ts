import type { SqlClient } from '../db/database.js';

import {
  normalizeDatabaseError,
  readBigInt,
  readDate,
  readOptionalText,
  readText,
  sql,
} from './rows.js';
import { PairedDeviceRuntimeError, type DeviceStatus } from './runtime.js';

/**
 * Who is present in a group, and what they are looking at.
 *
 * Participation is deliberately not membership. `RevokeDevice` removes a device
 * from a group; joining and leaving are about whether a device is taking part
 * in the group's synchronized session right now, which is what R27 asks for
 * when it says sessions enter and leave synchronization groups. Keeping the two
 * apart is why leaving does not revoke a session and rejoining needs no pairing
 * code.
 */
export interface PresenceSnapshot {
  readonly deviceId: string;
  readonly status: DeviceStatus;
  readonly activeScreen: string;
  readonly selectedElement: string;
  readonly clockOffsetMs: bigint;
  readonly latencyMs: number;
  readonly observedAt: Date;
}

export interface RecordPresenceInput {
  readonly groupId: string;
  readonly deviceId: string;
  readonly status: DeviceStatus;
  readonly activeScreen?: string;
  readonly selectedElement?: string;
  readonly clockOffsetMs?: bigint;
  readonly latencyMs?: number;
}

/**
 * A renewal names the device and nothing else, because it changes nothing the
 * device reported. The identifier always comes from the caller's own
 * authenticated session; there is no field on the wire that could name another.
 */
export interface RenewPresenceInput {
  readonly groupId: string;
  readonly deviceId: string;
}

export interface PresenceStore {
  record(input: RecordPresenceInput): Promise<PresenceSnapshot>;
  /**
   * Keeps an already-announced device alive without reporting anything new.
   *
   * `record` is what enters and leaves the session, and each call of it also
   * appends a durable `PRESENCE_UPDATED` row to `sync_events` and consumes a
   * sequence number. A device that is merely still here must not pay that: a
   * renewal every fifteen seconds per device would add thousands of rows a day
   * to the log every polling client reads back in pages. So liveness is
   * refreshed on its own, and the log records only the two facts that are
   * events — a device joined, a device left.
   */
  renew(input: RenewPresenceInput): Promise<void>;
  list(groupId: string): Promise<readonly PresenceSnapshot[]>;
}

export interface DurablePresenceStoreOptions {
  readonly database: SqlClient;
  readonly now?: () => Date;
}

/**
 * The `presence_snapshots` adapter.
 *
 * The table has no CHECK on `status`, so this adapter is the only thing keeping
 * the column to the three values `Presence.status` can carry. Writing anything
 * else would produce a row that reads back as `DEVICE_STATUS_UNSPECIFIED` and
 * looks like a client bug rather than a server one.
 */
export class DurablePresenceStore implements PresenceStore {
  readonly #database: SqlClient;
  readonly #now: () => Date;

  constructor(options: DurablePresenceStoreOptions) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
  }

  async record(input: RecordPresenceInput): Promise<PresenceSnapshot> {
    const observedAt = this.#now();
    // Membership is re-checked inside the write rather than trusted from the
    // caller: an access token stays valid for its lifetime, and a device
    // revoked a moment ago must not be able to announce itself as present.
    const rows = await this.query(
      sql(
        `WITH active_member AS (
           SELECT membership.group_id, membership.device_id
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           WHERE membership.group_id = $1
             AND membership.device_id = $2
             AND membership.revoked_at IS NULL
             AND devices.status <> 'REVOKED'
         )
         INSERT INTO presence_snapshots (
           group_id, device_id, status, active_screen, selected_element,
           clock_offset_ms, latency_ms, observed_at
         )
         SELECT active_member.group_id, active_member.device_id, $3, $4, $5, $6, $7, $8
         FROM active_member
         ON CONFLICT (group_id, device_id) DO UPDATE
           SET status = EXCLUDED.status,
               active_screen = EXCLUDED.active_screen,
               selected_element = EXCLUDED.selected_element,
               clock_offset_ms = EXCLUDED.clock_offset_ms,
               latency_ms = EXCLUDED.latency_ms,
               observed_at = EXCLUDED.observed_at
         RETURNING
           device_id,
           status,
           active_screen,
           selected_element,
           clock_offset_ms,
           latency_ms,
           observed_at`,
        [
          input.groupId,
          input.deviceId,
          input.status,
          input.activeScreen ?? '',
          input.selectedElement ?? '',
          (input.clockOffsetMs ?? 0n).toString(),
          input.latencyMs ?? 0,
          observedAt,
        ],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'Only an active member of the group can announce its presence.',
      );
    }
    return toPresenceSnapshot(row);
  }

  /**
   * There is no lease here to keep alive.
   *
   * A `presence_snapshots` row never expires, so without Redis a device stays
   * exactly as `JoinGroup` left it until it says otherwise, and `list` reads
   * `status` without ever comparing `observed_at` to now. Writing `observed_at`
   * on every poll would therefore cost one row write per device every fifteen
   * seconds and change no answer this store gives. What a reader gets here
   * remains "what this device last reported, and when" rather than "this device
   * is here now" — the weaker reading `Health` already names when it reports
   * Redis unconfigured. A deployment that needs presence to expire configures
   * Redis; that is the trade, and it is not hidden.
   */
  renew(): Promise<void> {
    return Promise.resolve();
  }

  async list(groupId: string): Promise<readonly PresenceSnapshot[]> {
    const rows = await this.query(
      sql(
        `SELECT
           presence.device_id,
           presence.status,
           presence.active_screen,
           presence.selected_element,
           presence.clock_offset_ms,
           presence.latency_ms,
           presence.observed_at
         FROM presence_snapshots AS presence
         JOIN group_memberships AS membership
           ON membership.group_id = presence.group_id
          AND membership.device_id = presence.device_id
         WHERE presence.group_id = $1
           AND membership.revoked_at IS NULL
         ORDER BY presence.observed_at DESC, presence.device_id ASC`,
        [groupId],
      ),
    );
    return rows.map(toPresenceSnapshot);
  }

  private async query(
    statement: ReturnType<typeof sql>,
  ): Promise<readonly Record<string, unknown>[]> {
    try {
      return await this.#database.query(statement);
    } catch (error: unknown) {
      throw normalizeDatabaseError(error);
    }
  }
}

/** A process-local adapter, for the suites that own no group rows. */
export class InMemoryPresenceStore implements PresenceStore {
  readonly #byGroup = new Map<string, Map<string, PresenceSnapshot>>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  record(input: RecordPresenceInput): Promise<PresenceSnapshot> {
    const snapshot: PresenceSnapshot = {
      deviceId: input.deviceId,
      status: input.status,
      activeScreen: input.activeScreen ?? '',
      selectedElement: input.selectedElement ?? '',
      clockOffsetMs: input.clockOffsetMs ?? 0n,
      latencyMs: input.latencyMs ?? 0,
      observedAt: this.#now(),
    };
    const group = this.#byGroup.get(input.groupId) ?? new Map<string, PresenceSnapshot>();
    group.set(input.deviceId, snapshot);
    this.#byGroup.set(input.groupId, group);
    return Promise.resolve(snapshot);
  }

  /** Nothing in this map expires either, so there is nothing to extend. */
  renew(): Promise<void> {
    return Promise.resolve();
  }

  list(groupId: string): Promise<readonly PresenceSnapshot[]> {
    return Promise.resolve([...(this.#byGroup.get(groupId)?.values() ?? [])]);
  }
}

function toPresenceSnapshot(row: Record<string, unknown>): PresenceSnapshot {
  return {
    deviceId: readText(row.device_id, 'device_id'),
    status: readPresenceStatus(row.status),
    activeScreen: readOptionalText(row.active_screen) ?? '',
    selectedElement: readOptionalText(row.selected_element) ?? '',
    clockOffsetMs: readBigInt(row.clock_offset_ms, 'clock_offset_ms'),
    latencyMs: Number(readBigInt(row.latency_ms, 'latency_ms')),
    observedAt: readDate(row.observed_at, 'observed_at'),
  };
}

function readPresenceStatus(value: unknown): DeviceStatus {
  const status = readText(value, 'status');
  if (status === 'OFFLINE' || status === 'ONLINE' || status === 'REVOKED') return status;
  throw new Error('The database returned an invalid presence status.');
}
