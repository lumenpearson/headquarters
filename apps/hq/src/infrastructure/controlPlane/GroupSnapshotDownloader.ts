import type { ControlPlanePort } from '@/application/sync/controlPlanePort';
import type { GroupSettingsDocument } from '@/application/sync/groupSettingsPort';
import { isGroupScopedSetting } from '@/application/sync/GroupSettingsSync';
import {
  buildGroupMirror,
  decideMirrorAdoption,
  type GroupMirror,
  type GroupMirrorOutcome,
  type GroupMirrorPort,
  parseGroupMirror,
} from '@/application/sync/localMirror';

import { browserStorage, type KeyValueStorage } from './DeviceSessionStore';
import { liveEditDocumentId } from './GroupLiveEditTransport';

/**
 * The eighth persisted key. Listed in CLAUDE.md's state-ownership paragraph
 * and in `docs/release/environment.md` beside the other seven.
 */
export const groupMirrorStorageKey = 'gremuchaya-hq:group-mirror:v1';

/**
 * Where a download lands before anything has checked it.
 *
 * Not a ninth key in any meaningful sense: it holds a candidate for the length
 * of one download and is removed whether that download is taken or refused. It
 * exists so the working copy has no path to being half written. A downloader
 * that wrote the answer straight to `groupMirrorStorageKey` and validated
 * afterwards would, on a storage that refuses the write or a payload that does
 * not survive the round trip, have already replaced a good copy with a worse
 * one -- and there is nothing to roll back to, because the good copy was the
 * only record of it.
 */
export const groupMirrorDraftStorageKey = `${groupMirrorStorageKey}:draft`;

/** The one method of `ControlPlanePort` this downloader needs. */
export type DocumentSnapshotReader = Pick<ControlPlanePort, 'getDocumentSnapshot'>;

export interface GroupSnapshotDownloaderOptions {
  readonly groupId: string;
  /**
   * The control-plane installation the session is talking to, as
   * `GetCapabilities` reported it; `''` when it reported none.
   */
  readonly installationId: string;
  /**
   * Reads the group-log position the copy is stamped with. Optional: a control
   * plane without `SyncService` has no snapshot to report, and the copy is then
   * stamped with the position it already held.
   */
  readonly documents?: DocumentSnapshotReader;
  /** The document whose snapshot stamps the copy. Live edit, by default. */
  readonly documentId?: string;
  readonly storage?: KeyValueStorage;
  /** Wall clock, epoch milliseconds. */
  readonly now?: () => number;
}

/**
 * The local copy of the group's state, and the only writer of it (F14, stage 9).
 *
 * **What it guarantees.** After any call to `absorb`, the working copy is
 * either exactly what it was before the call or a complete, re-checked, strictly
 * newer state. There is no third outcome. A download that was cut off, an
 * answer that does not parse, an answer holding a value past its validator, an
 * answer whose revision is older or equal, an answer with no group values at
 * all -- every one of them leaves the copy byte for byte as it stood, and the
 * status line says the refresh did not happen.
 *
 * **Three steps, in this order, and the order is the design.** The answer is
 * staged under the draft key; it is read back out of storage and put through
 * `parseGroupMirror`, the same check a copy from disk faces; only then does one
 * `setItem` replace the working copy whole. The staged read-back is not
 * ceremony: it is what makes the check apply to the bytes that were actually
 * stored rather than to the object in memory that was supposed to become them.
 *
 * **It never touches the store.** What reaches the settings draft is decided by
 * `GroupSettingsSync` and applied by `groupValuePatches`, which is the same
 * road the cloud's own answer takes. A copy that could write settings directly
 * would be a second way into the state with its own rules.
 */
export class GroupSnapshotDownloader implements GroupMirrorPort {
  readonly #groupId: string;
  readonly #installationId: string;
  readonly #documents: DocumentSnapshotReader | undefined;
  readonly #documentId: string;
  readonly #storage: KeyValueStorage;
  readonly #now: () => number;

  constructor(options: GroupSnapshotDownloaderOptions) {
    this.#groupId = options.groupId;
    this.#installationId = options.installationId;
    this.#documents = options.documents;
    this.#documentId = options.documentId ?? liveEditDocumentId;
    this.#storage = options.storage ?? browserStorage();
    this.#now = options.now ?? (() => Date.now());
  }

  read(): GroupMirror | null {
    return readGroupMirror(this.#storage);
  }

  async absorb(document: GroupSettingsDocument, signal?: AbortSignal): Promise<GroupMirrorOutcome> {
    const local = this.#comparable();
    let sequence: number;
    try {
      sequence = await this.#readSequence(local, signal);
    } catch {
      // The snapshot position could not be read. The settings half may well be
      // sound, but a copy stamped with a position nobody confirmed would claim
      // to know where in the group's log it stands. Nothing is written.
      return 'unreachable';
    }
    const candidate = buildGroupMirror({
      groupId: this.#groupId,
      installationId: this.#installationId,
      document,
      sequence,
      refreshedAt: new Date(this.#now()).toISOString(),
    });
    if (candidate === null) {
      /*
       * Two different facts, told apart by whether the answer offered any
       * group-scoped setting at all.
       *
       * Offering none is a no-op and never a wipe -- the second line of the
       * defence stage 8.5 built. A control plane whose database was replaced
       * answers for a group that holds nothing, and a copy overwritten with
       * "nothing" would blank every group-scoped setting on the next launch.
       *
       * Offering some and having none survive is a refusal: the answer was
       * damaged, past a validator, or carried a revision that is not one.
       * Both leave the working copy exactly where it stands; they differ only
       * in what the status line is told.
       */
      const offered = Object.keys(document.values).filter(isGroupScopedSetting).length;
      return offered === 0 ? 'kept' : 'refused';
    }
    if (this.#decide(local, candidate) === 'keep-local') return 'kept';
    return this.#promote(candidate);
  }

  /**
   * Whether this candidate is worth replacing the copy with.
   *
   * `decideMirrorAdoption` is the rule and it is applied twice, because the
   * copy stands at two positions: the settings document's `revision` and the
   * group log's `sequence`. The settings revision decides -- it is what governs
   * the values being stored. The sequence gets its own say in exactly one case:
   * the same settings, seen at a later point in the log, which moves the stamp
   * without changing a single value. A sequence that ran ahead of an *older*
   * settings revision decides nothing, because taking it would install older
   * values on the strength of an unrelated counter.
   */
  #decide(local: GroupMirror | null, candidate: GroupMirror): 'adopt' | 'keep-local' {
    if (decideMirrorAdoption(local?.revision ?? null, candidate.revision) === 'adopt') {
      return 'adopt';
    }
    if (local === null || local.revision !== candidate.revision) return 'keep-local';
    return decideMirrorAdoption(local.sequence, candidate.sequence);
  }

  /**
   * The copy the candidate is measured against, or `null` when there is none to
   * measure against.
   *
   * A copy of another group, or one taken from another control-plane
   * installation, is not a comparison basis: two groups count their revisions
   * separately, and a database that replaced another starts counting again.
   * Neither case can arrive at a joined session -- the connection refuses a
   * changed installation before `online` (`ConnectionMode.installation-changed`)
   * and a device is in one group at a time -- so this is the belt to that
   * brace rather than the mechanism.
   */
  #comparable(): GroupMirror | null {
    const local = this.read();
    if (local === null) return null;
    if (local.groupId !== this.#groupId) return null;
    if (local.installationId !== this.#installationId) return null;
    return local;
  }

  /**
   * The group-log position to stamp the copy with.
   *
   * `null` from `getDocumentSnapshot` is the ordinary state of a group whose
   * log has never been pruned, and it is not a reason to move the stamp back to
   * zero: the copy keeps the position it already held. A rejected call is a
   * different fact and is thrown to the caller, which writes nothing.
   */
  async #readSequence(local: GroupMirror | null, signal?: AbortSignal): Promise<number> {
    const kept = local?.sequence ?? 0;
    if (this.#documents === undefined) return kept;
    const snapshot = await this.#documents.getDocumentSnapshot(this.#documentId, signal);
    return snapshot === null ? kept : Number(snapshot.sequence);
  }

  /**
   * Stage, read back, check, replace. The working copy is written by exactly
   * one statement in this class, and it is the last one.
   */
  #promote(candidate: GroupMirror): GroupMirrorOutcome {
    try {
      this.#storage.setItem(groupMirrorDraftStorageKey, JSON.stringify(candidate));
      const staged = readMirrorAt(this.#storage, groupMirrorDraftStorageKey);
      // What went into storage is not always what comes out: a value that does
      // not survive a JSON round trip, a quota that truncated the write, a
      // profile that accepted the call and stored nothing.
      if (staged === null) return 'refused';
      this.#storage.setItem(groupMirrorStorageKey, JSON.stringify(staged));
      return 'adopted';
    } catch {
      // Storage blocked or full. The working copy is untouched, which is the
      // whole reason the candidate went to the draft key first.
      return 'refused';
    } finally {
      try {
        this.#storage.removeItem(groupMirrorDraftStorageKey);
      } catch {
        // A draft left behind is never read as a copy: `read` looks only at
        // the working key, and the next download overwrites this one.
      }
    }
  }
}

/**
 * The local copy of the group's state, for a caller that has no session to
 * build a downloader from.
 *
 * `ControlPlaneRuntime` reads it on a launch that never reaches the control
 * plane at all, which is the case the whole stage exists for. The same
 * function the class uses, so there is one reader.
 *
 * A blob that is not a copy is left where it is rather than removed: reading is
 * not the moment to write, and the next successful download replaces it.
 */
export function readGroupMirror(storage: KeyValueStorage = browserStorage()): GroupMirror | null {
  return readMirrorAt(storage, groupMirrorStorageKey);
}

function readMirrorAt(storage: KeyValueStorage, key: string): GroupMirror | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    return parseGroupMirror(JSON.parse(raw));
  } catch {
    return null;
  }
}
