import { getSettingDefinition } from '@gremuchaya/settings-schema';
import type { SettingValue } from '@gremuchaya/settings-schema';

import type { GroupMirrorSummary } from './connection';
import { isGroupScopedSetting } from './GroupSettingsSync';
import type { GroupSettingsDocument } from './groupSettingsPort';

/**
 * The local copy of what the group agreed, and the rule that decides when the
 * cloud may replace it (F14, stage 9).
 *
 * **Three levels of seniority, top down: the cloud database, this copy, the
 * compiled-in constants.** The bottom level already exists and already works --
 * `createFactorySnapshot()` for the settings and `operationsSeed` for the
 * world are what bring the application up on a machine that has never seen a
 * network. Nothing here builds a second one. What this module does is stop the
 * network from overwriting either of the two levels below it on an answer that
 * did not arrive, arrived damaged, or arrived older than what is already here.
 *
 * Everything in this file is a pure function of its arguments. The storage,
 * the draft key and the two RPCs live in `GroupSnapshotDownloader`, which is
 * the only implementation of `GroupMirrorPort`.
 */

/** The blob version. A copy written by another version is not read. */
export const groupMirrorVersion = 1;

export interface GroupMirror {
  readonly version: typeof groupMirrorVersion;
  /**
   * Which group the copy belongs to.
   *
   * A copy is about one group: a device that pairs into a second one has no
   * copy of it yet, and comparing revisions across groups would compare two
   * unrelated counters.
   */
  readonly groupId: string;
  /**
   * Which control-plane installation the copy came from, as `GetCapabilities`
   * reported it, or `''` when it reported none.
   *
   * Recorded rather than acted on here. The refusal to reconcile against a
   * database that replaced the one this device paired with is the connection's,
   * and it happens before a session reaches `online` at all
   * (`ConnectionMode.installation-changed`). This field is what lets the copy
   * say which database it is a copy of.
   */
  readonly installationId: string;
  /** The settings document's revision, as the server reported it. */
  readonly revision: number;
  /**
   * The group-log position the copy is stamped at, from `GetDocumentSnapshot`,
   * or `0` when the control plane has recorded no snapshot.
   *
   * A second position and not a second precedence: the settings revision
   * decides what the copy holds, and this records how far the group's event log
   * had run when it was taken. Both are compared by `decideMirrorAdoption` --
   * the same rule over whichever pair it is handed, because a snapshot's
   * `sequence` and a settings document's `revision` are the same kind of fact
   * under different names.
   */
  readonly sequence: number;
  /** The group's share of the document, every value checked by its definition. */
  readonly values: Readonly<Record<string, SettingValue>>;
  /** ISO 8601 of the refresh that wrote this copy. */
  readonly refreshedAt: string;
}

export type MirrorDecision = 'adopt' | 'keep-local';

/** What one refresh attempt did to the working copy. */
export type GroupMirrorOutcome =
  /** A newer state passed every check and replaced the copy whole. */
  | 'adopted'
  /** The answer was readable and not newer, or held nothing this build can use. */
  | 'kept'
  /** The answer did not survive the check. The copy is exactly as it was. */
  | 'refused'
  /** Nothing arrived: the call was rejected, or the connection went away. */
  | 'unreachable';

/**
 * What the settings sync needs of the local copy.
 *
 * Declared in the application layer and implemented by
 * `GroupSnapshotDownloader` in infrastructure, the direction
 * `dependency-map.md` fixes. Neither method throws: a copy that could fail a
 * caller would be a copy that can make a session worse than no copy at all.
 */
export interface GroupMirrorPort {
  /** The working copy, or `null` when nothing has been mirrored. */
  read(): GroupMirror | null;
  /**
   * Offers the cloud's answer to the copy. The copy decides whether to take it.
   *
   * The answer reaches storage only through here, and only after it has been
   * staged, read back and checked. A refusal is silence: the working copy is
   * left byte for byte as it was.
   */
  absorb(document: GroupSettingsDocument, signal?: AbortSignal): Promise<GroupMirrorOutcome>;
}

/**
 * Whether a remote revision is worth taking over the local one.
 *
 * **Strictly newer, never equal.** A client that adopted an equal revision
 * would re-adopt the same document on every join, and one that adopted an
 * older one would overwrite changes of its own that have not reached the
 * server yet -- which is the precise failure this rule exists to prevent.
 * It is the same precedence `GroupSettingsSync` already states for the values:
 * on the way into a group the group wins, and after that a local change wins
 * and travels.
 *
 * `local === null` means nothing has been mirrored, which is the one case
 * where any well-formed remote revision is an improvement. A local number that
 * is not a revision cannot arrive from `parseGroupMirror`, which refuses such a
 * blob outright; if one does, it is treated as no copy at all rather than as a
 * ceiling no answer could clear.
 *
 * A remote number that is not a revision -- `NaN`, a fraction, a negative, a
 * value past `Number.MAX_SAFE_INTEGER` -- is refused rather than coerced. The
 * server's revision is a `bigint` on the wire and becomes a number at the
 * adapter; a value that lost precision on the way is not a revision this client
 * can compare.
 */
export function decideMirrorAdoption(local: number | null, remote: number): MirrorDecision {
  if (!isRevision(remote)) return 'keep-local';
  if (local === null || !isRevision(local)) return 'adopt';
  return remote > local ? 'adopt' : 'keep-local';
}

function isRevision(value: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The group's share of a values record, with every value checked by its own
 * definition.
 *
 * The same check `GroupSettingsSync` applies before landing a value in the
 * draft and `toGroupOperations` applies before sending one, applied here so a
 * value that could not reach the draft never reaches the disk either. An
 * identifier no definition names is dropped, which also means a key such as
 * `__proto__` is dropped: it names no setting.
 */
export function acceptableGroupValues(
  values: Readonly<Record<string, SettingValue>>,
): Readonly<Record<string, SettingValue>> {
  const accepted: Record<string, SettingValue> = {};
  for (const [id, value] of Object.entries(values)) {
    if (!isGroupScopedSetting(id)) continue;
    const definition = getSettingDefinition(id);
    if (definition === undefined || !definition.validate(value)) continue;
    accepted[id] = value;
  }
  return accepted;
}

export interface GroupMirrorCandidate {
  readonly groupId: string;
  readonly installationId: string;
  readonly document: GroupSettingsDocument;
  readonly sequence: number;
  /** ISO 8601 of the attempt that produced the candidate. */
  readonly refreshedAt: string;
}

/**
 * The copy a cloud answer would make, or `null` when it would make none.
 *
 * `null` for three reasons, and all three are the answer's own fault rather
 * than a failure to record:
 *
 * - **No group values at all.** Zero values is a no-op and never a wipe. It is
 *   the second line of the defence stage 8.5 built: a control plane whose
 *   database was replaced answers for a group that holds nothing, and a client
 *   that stored "nothing" would have blanked its copy and, on the next launch,
 *   its settings. (The first line is the installation identifier, which stops
 *   such a session from reaching `online`.)
 * - **A revision or a sequence that is not one.** See `decideMirrorAdoption`.
 * - **No group.** A copy has to say whose it is.
 */
export function buildGroupMirror(candidate: GroupMirrorCandidate): GroupMirror | null {
  if (candidate.groupId === '') return null;
  if (!isRevision(candidate.document.revision) || !isRevision(candidate.sequence)) return null;
  const values = acceptableGroupValues(candidate.document.values);
  if (Object.keys(values).length === 0) return null;
  return {
    version: groupMirrorVersion,
    groupId: candidate.groupId,
    installationId: candidate.installationId,
    revision: candidate.document.revision,
    sequence: candidate.sequence,
    values,
    refreshedAt: candidate.refreshedAt,
  };
}

/**
 * A stored blob read back as a copy, or `null` when it is not one.
 *
 * `localStorage` is a trust boundary exactly as the operations key is: the blob
 * is editable in a browser's devtools and may have been written by an older
 * build. Every field is checked and every value re-validated, so a copy that
 * survives this call is one whose values could be applied. `null` rather than a
 * throw, because there is nothing for a caller to recover: a blob that is not a
 * copy is the same fact as no copy.
 */
export function parseGroupMirror(value: unknown): GroupMirror | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate['version'] !== groupMirrorVersion) return null;
  const groupId = candidate['groupId'];
  const installationId = candidate['installationId'];
  const revision = candidate['revision'];
  const sequence = candidate['sequence'];
  const refreshedAt = candidate['refreshedAt'];
  const values = candidate['values'];
  if (typeof groupId !== 'string' || groupId === '') return null;
  if (typeof installationId !== 'string') return null;
  if (typeof revision !== 'number' || !isRevision(revision)) return null;
  if (typeof sequence !== 'number' || !isRevision(sequence)) return null;
  if (typeof refreshedAt !== 'string' || Number.isNaN(Date.parse(refreshedAt))) return null;
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return null;
  const accepted = acceptableGroupValues(values as Record<string, SettingValue>);
  // A copy holding nothing this build can use is not a copy. Returning it would
  // put an empty record where the caller expects the group's agreement and make
  // "the copy says nothing" indistinguishable from "the group agreed nothing".
  if (Object.keys(accepted).length === 0) return null;
  return {
    version: groupMirrorVersion,
    groupId,
    installationId,
    revision,
    sequence,
    values: accepted,
    refreshedAt,
  };
}

/** What the status line prints about the copy. */
export function mirrorSummary(mirror: GroupMirror | null): GroupMirrorSummary {
  if (mirror === null) return { refreshedAt: '', revision: 0, sequence: 0 };
  return { refreshedAt: mirror.refreshedAt, revision: mirror.revision, sequence: mirror.sequence };
}
