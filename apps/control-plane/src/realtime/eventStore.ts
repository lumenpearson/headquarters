import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { syncV1 } from '@gremuchaya/protocol';

import type { SqlClient, SqlParameter, SqlStatement } from '../db/database.js';

/**
 * The replay store behind the realtime hub.
 *
 * A group event is a server-side fact, so the store — not the caller — owns
 * both the sequence number and the moment the event occurred. Callers describe
 * what happened; they never choose where it lands in the order.
 */
export interface RealtimeEventStore {
  append(draft: GroupEventDraft): Promise<syncV1.GroupEvent>;
  replay(input: RealtimeReplayInput): Promise<RealtimeReplay>;
}

export interface GroupEventDraft {
  readonly groupId: string;
  readonly kind: syncV1.GroupEventKind;
  readonly group?: syncV1.Group;
  readonly device?: syncV1.Device;
  readonly presence?: syncV1.Presence;
  readonly documentId?: string;
  readonly documentDelta?: Uint8Array;
  readonly sessionCommand?: syncV1.SessionCommand;
  readonly actorDeviceId?: string;
  readonly hybridLogicalClock?: bigint;
}

export interface RealtimeReplayInput {
  readonly groupId: string;
  readonly afterSequence: bigint;
  readonly limit: number;
}

export interface RealtimeReplay {
  readonly events: readonly syncV1.GroupEvent[];
  /**
   * The oldest sequence the store still holds for the group, or `undefined`
   * when it holds none. A resume that asks for anything older than this cannot
   * be answered with events and needs a snapshot instead.
   */
  readonly earliestSequence?: bigint;
}

export const defaultRealtimeHistoryLimit = 512;
export const defaultRealtimeReplayLimit = 512;

/**
 * A process-local store. It exists for the same reason the deterministic
 * `PairedDeviceRuntime` exists next to the durable one: a test that has no
 * group rows still needs the hub's ordering and resume behaviour. Production
 * startup constructs {@link DurableRealtimeEventStore} instead — the two are
 * never active at once, so the hub keeps exactly one source of truth.
 */
export class InMemoryRealtimeEventStore implements RealtimeEventStore {
  readonly #eventsByGroup = new Map<string, syncV1.GroupEvent[]>();
  readonly #sequenceByGroup = new Map<string, bigint>();
  readonly #historyLimit: number;
  readonly #now: () => Date;

  constructor(
    historyLimit: number = defaultRealtimeHistoryLimit,
    now: () => Date = () => new Date(),
  ) {
    this.#historyLimit = requireHistoryLimit(historyLimit);
    this.#now = now;
  }

  append(draft: GroupEventDraft): Promise<syncV1.GroupEvent> {
    const sequence = (this.#sequenceByGroup.get(draft.groupId) ?? 0n) + 1n;
    this.#sequenceByGroup.set(draft.groupId, sequence);
    const event = buildGroupEvent(draft, sequence, this.#now());
    const events = this.#eventsByGroup.get(draft.groupId) ?? [];
    events.push(event);
    if (events.length > this.#historyLimit) events.splice(0, events.length - this.#historyLimit);
    this.#eventsByGroup.set(draft.groupId, events);
    return Promise.resolve(event);
  }

  replay(input: RealtimeReplayInput): Promise<RealtimeReplay> {
    const events = this.#eventsByGroup.get(input.groupId) ?? [];
    const earliest = events[0]?.sequence;
    return Promise.resolve({
      events: events
        .filter((event) => event.sequence > input.afterSequence)
        .slice(0, requireReplayLimit(input.limit)),
      ...(earliest === undefined ? {} : { earliestSequence: earliest }),
    });
  }
}

export interface DurableRealtimeEventStoreOptions {
  readonly database: SqlClient;
  /**
   * How many events a group retains. Older events are pruned as new ones are
   * appended, which is what turns an unbounded log into a resume window with a
   * declared edge.
   */
  readonly historyLimit?: number;
  readonly now?: () => Date;
}

/**
 * The `sync_events` adapter.
 *
 * Every event is stored twice over: once as columns the database can filter and
 * order by, and once as the binary `GroupEvent` in `payload`, which is what
 * replay actually returns. The stored envelope deliberately leaves `sequence`
 * at its proto3 default, because the number is allocated by the same statement
 * that writes the row and therefore cannot be inside the bytes being written.
 * Replay stamps it back from the `sequence` column, so a reader observes the
 * event exactly as the publisher described it plus the order the server chose.
 */
export class DurableRealtimeEventStore implements RealtimeEventStore {
  readonly #database: SqlClient;
  readonly #historyLimit: number;
  readonly #now: () => Date;

  constructor(options: DurableRealtimeEventStoreOptions) {
    this.#database = options.database;
    this.#historyLimit = requireHistoryLimit(options.historyLimit ?? defaultRealtimeHistoryLimit);
    this.#now = options.now ?? (() => new Date());
  }

  async append(draft: GroupEventDraft): Promise<syncV1.GroupEvent> {
    const occurredAt = this.#now();
    const envelope = toBinary(syncV1.GroupEventSchema, buildGroupEvent(draft, 0n, occurredAt));
    const rows = await this.#database.query<Record<string, unknown>>(
      sql(
        `WITH allocated AS (
           INSERT INTO group_event_sequences (group_id, last_sequence, updated_at)
           VALUES ($1, 1, $2)
           ON CONFLICT (group_id) DO UPDATE
             SET last_sequence = group_event_sequences.last_sequence + 1,
                 updated_at = EXCLUDED.updated_at
           RETURNING last_sequence
         )
         INSERT INTO sync_events (
           id, group_id, sequence, kind, document_id, payload,
           hybrid_logical_clock, actor_device_id, occurred_at
         )
         SELECT gen_random_uuid(), $1, allocated.last_sequence, $3, $4, $5, $6, $7, $2
         FROM allocated
         RETURNING sequence`,
        [
          draft.groupId,
          occurredAt,
          eventKindName(draft.kind),
          draft.documentId ?? null,
          envelope,
          (draft.hybridLogicalClock ?? 0n).toString(),
          draft.actorDeviceId ?? null,
        ],
      ),
    );
    const first = rows[0];
    if (first === undefined) {
      throw new Error(`Realtime event append produced no row for group ${draft.groupId}`);
    }
    const sequence = readSequence(first.sequence);
    await this.prune(draft.groupId, sequence);
    return buildGroupEvent(draft, sequence, occurredAt);
  }

  async replay(input: RealtimeReplayInput): Promise<RealtimeReplay> {
    const limit = requireReplayLimit(input.limit);
    const rows = await this.#database.query<Record<string, unknown>>(
      sql(
        `SELECT
           stored.sequence AS sequence,
           stored.payload AS payload,
           (
             SELECT MIN(oldest.sequence)
             FROM sync_events AS oldest
             WHERE oldest.group_id = $1
           ) AS earliest_sequence
         FROM sync_events AS stored
         WHERE stored.group_id = $1 AND stored.sequence > $2
         ORDER BY stored.sequence ASC
         LIMIT $3`,
        [input.groupId, input.afterSequence.toString(), limit],
      ),
    );

    const first = rows[0];
    if (first === undefined) {
      // No row above the cursor means either an empty group or a caller that is
      // already current. Neither can need a snapshot, so the absent edge is the
      // honest answer rather than a second query.
      return { events: [] };
    }
    const earliest = readSequence(first.earliest_sequence);
    return {
      events: rows.map((row) => {
        const sequence = readSequence(row.sequence);
        const event = fromBinary(syncV1.GroupEventSchema, readBytes(row.payload));
        event.sequence = sequence;
        return event;
      }),
      earliestSequence: earliest,
    };
  }

  private async prune(groupId: string, latestSequence: bigint): Promise<void> {
    const oldestRetained = latestSequence - BigInt(this.#historyLimit);
    if (oldestRetained <= 0n) return;
    await this.#database.query(
      sql('DELETE FROM sync_events WHERE group_id = $1 AND sequence <= $2', [
        groupId,
        oldestRetained.toString(),
      ]),
    );
  }
}

function buildGroupEvent(
  draft: GroupEventDraft,
  sequence: bigint,
  occurredAt: Date,
): syncV1.GroupEvent {
  return create(syncV1.GroupEventSchema, {
    sequence,
    kind: draft.kind,
    ...(draft.group === undefined ? {} : { group: draft.group }),
    ...(draft.device === undefined ? {} : { device: draft.device }),
    ...(draft.presence === undefined ? {} : { presence: draft.presence }),
    ...(draft.documentId === undefined ? {} : { documentId: { value: draft.documentId } }),
    ...(draft.documentDelta === undefined ? {} : { documentDelta: draft.documentDelta }),
    ...(draft.sessionCommand === undefined ? {} : { sessionCommand: draft.sessionCommand }),
    occurredAt: timestampFromDate(occurredAt),
  });
}

/**
 * The `kind` column is written for operators reading the table directly, so it
 * carries the protobuf enum name rather than its wire number. It is mapped
 * exhaustively instead of by reverse enum lookup: a reverse lookup returns
 * `undefined` for any value a newer client sends, and a NULL-shaped kind would
 * be indistinguishable from an unset one.
 */
function eventKindName(kind: syncV1.GroupEventKind): string {
  switch (kind) {
    case syncV1.GroupEventKind.GROUP_UPDATED:
      return 'GROUP_UPDATED';
    case syncV1.GroupEventKind.DEVICE_UPDATED:
      return 'DEVICE_UPDATED';
    case syncV1.GroupEventKind.PRESENCE_UPDATED:
      return 'PRESENCE_UPDATED';
    case syncV1.GroupEventKind.DOCUMENT_DELTA:
      return 'DOCUMENT_DELTA';
    case syncV1.GroupEventKind.SESSION_COMMAND:
      return 'SESSION_COMMAND';
    case syncV1.GroupEventKind.SNAPSHOT_REQUIRED:
      return 'SNAPSHOT_REQUIRED';
    case syncV1.GroupEventKind.UNSPECIFIED:
      return 'UNSPECIFIED';
    default:
      return 'UNSPECIFIED';
  }
}

function requireHistoryLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('Realtime history limit must be a positive integer');
  }
  return value;
}

function requireReplayLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('Realtime replay limit must be a positive integer');
  }
  return Math.min(value, defaultRealtimeReplayLimit);
}

function readSequence(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/u.test(value)) return BigInt(value);
  throw new Error('sync_events.sequence must be a non-negative integer');
}

function readBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string' && value.startsWith('\\x')) {
    return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
  }
  throw new Error('sync_events.payload must be a bytea value');
}

function sql(text: string, values: readonly SqlParameter[]): SqlStatement {
  return { text, values };
}
