import type { DeviceRole } from '@/application/sync/connection';

/**
 * The fourth persisted key. Listed in CLAUDE.md's state-ownership paragraph
 * and in `docs/release/environment.md` beside the others.
 */
export const deviceSessionStorageKey = 'gremuchaya-hq:device-session:v3';

/**
 * The keys earlier sessions were written under, newest first, each read once so
 * that a device paired by an earlier build does not lose its pairing to an
 * upgrade.
 *
 * `v2` recorded which control plane the tokens were minted against and was only
 * ever presented back to that same address. `v3` presents the same session to
 * every address configured for the group, because a group may now be reachable
 * two ways at once (F14, stage 7) and the two addresses stand in front of one
 * database. That is a change in what the blob *means*, not only in what it
 * holds, which is why it is a new key rather than a new optional field: an
 * older build that read a `v3` blob would present it to one address and hide it
 * from the other, and reading nothing -- and asking for a pairing code -- is
 * the honest outcome of a downgrade instead.
 *
 * `v1` predates the installation identity and is carried forward with an empty
 * one, which the connection reads as unknown rather than as a match. Unknown is
 * the truth: the pairing happened before anything recorded the answer.
 */
export const legacyDeviceSessionStorageKeys = [
  'gremuchaya-hq:device-session:v2',
  'gremuchaya-hq:device-session:v1',
] as const;

/**
 * The paired session as it rests on disk.
 *
 * The refresh token is here in clear text, and that is a trade-off to state
 * rather than hide: this is a local-first desktop application with no server
 * of its own and no Tauri store plugin (ADR 0005), and a session that did not
 * survive a restart would need a fresh pairing code on every launch of every
 * screen -- on a shoot day, nine of them. `localStorage` is per-origin and
 * per-profile, which is the same boundary the operations state already trusts
 * with the audit trail. What the token can do is bounded server-side: it is
 * rotated on every refresh and its whole family is revoked by a replay, so a
 * copy lifted from one machine and used elsewhere kills the original as well.
 *
 * The bearer token never enters the operations store, a diagnostic report, a
 * URL or a log; `ControlPlaneClient` reads it here at the moment of a call.
 */
export interface StoredDeviceSession {
  readonly version: 3;
  /**
   * The address that answered when this pairing was made, kept so an operator
   * can read where the session came from.
   *
   * **It is never a filter.** Up to `v2` this field decided whether the session
   * was shown to a client at all, and a client built against any other address
   * was told there was no session. A group reachable over the set's LAN and
   * over the internet at once has two addresses and one database, so filtering
   * on the address would hide the session from one of its own planes. What
   * scopes a session is `controlPlaneInstallationId` -- the database -- and the
   * connection checks that instead.
   */
  readonly pairedAtUrl: string;
  /**
   * Which database the session was minted against, as `GetCapabilities`
   * reported it at the moment of pairing.
   *
   * An address is not an identity. A control plane deployed on a free Neon
   * project can be handed a new, empty database at the same URL, and a client
   * that remembered only the URL would re-pair into an empty group and
   * reconcile its local state against nothing. This field is what makes the
   * replacement detectable, and it is also what tells two addresses in front of
   * one database apart from two addresses in front of two.
   *
   * `''` means unknown, never "matches anything": a session carried forward
   * from the `v1` key, or one paired against a control plane that reported no
   * identity of its own.
   */
  readonly controlPlaneInstallationId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch milliseconds. */
  readonly accessTokenExpiresAt: number;
  readonly refreshTokenExpiresAt: number;
  readonly deviceId: string;
  readonly groupId: string;
  readonly role: DeviceRole;
  /**
   * The `request_id` of a refresh that was sent and not yet answered.
   *
   * Refresh rotates both tokens, and the server reads a second refresh with
   * the same token and a *different* id as a replay of a stolen token -- it
   * then revokes the whole session family. A crash between sending and
   * recording the answer would make the next launch exactly that client, so
   * the id is written before the call and cleared only once the answer is
   * stored. The retry then carries the same id and the receipt answers it.
   *
   * With two planes in front of one database this is also what makes a retry
   * safe across them: the receipt is a row in the shared database keyed by
   * `(scope, request_id_hash)`, so the same id presented to the other plane is
   * answered rather than classified. What is *not* safe is two clients each
   * minting an id of their own, which is why exactly one of them may refresh --
   * see `ControlPlaneClient`'s credential role.
   */
  readonly pendingRefreshRequestId?: string;
}

/** The part of `Storage` this store uses, so a test can hand in a map. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RefreshedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: number;
  readonly refreshTokenExpiresAt: number;
  readonly role: DeviceRole;
}

const deviceRoles: readonly DeviceRole[] = ['VIEWER', 'EDITOR', 'ADMIN'];

export class DeviceSessionStore {
  readonly #storage: KeyValueStorage;
  readonly #key: string;
  readonly #legacyKeys: readonly string[];

  constructor(
    storage: KeyValueStorage = browserStorage(),
    key = deviceSessionStorageKey,
    legacyKeys: readonly string[] = legacyDeviceSessionStorageKeys,
  ) {
    this.#storage = storage;
    this.#key = key;
    this.#legacyKeys = legacyKeys;
  }

  /** The stored session, or `null` when there is none or the blob is not one. */
  read(): StoredDeviceSession | null {
    const current = this.#readCurrent();
    if (current !== 'missing') return current;
    return this.#adoptLegacy();
  }

  write(session: StoredDeviceSession): void {
    try {
      this.#storage.setItem(this.#key, JSON.stringify(session));
    } catch {
      // Storage blocked or full. The session lives for this process only and
      // the next launch asks for a pairing code again, which is the honest
      // outcome of a machine that cannot keep one.
    }
  }

  clear(): void {
    // Every key, so that forgetting a pairing is not undone by an older blob
    // being carried forward again on the next read.
    for (const key of [this.#key, ...this.#legacyKeys]) {
      try {
        this.#storage.removeItem(key);
      } catch {
        // Nothing to recover.
      }
    }
  }

  /**
   * Records the installation a session belongs to, when it holds none.
   *
   * A recorded identity is never replaced. Two different non-empty values are
   * exactly the disagreement the connection refuses on, and a store that
   * quietly adopted the newer one would erase the evidence before anything
   * could act on it. Replacing a pairing is `clear` followed by a fresh `pair`,
   * which is an operator's decision rather than a side effect of a probe.
   */
  adoptInstallationId(installationId: string): void {
    if (installationId === '') return;
    const session = this.read();
    if (session === null || session.controlPlaneInstallationId !== '') return;
    this.write({ ...session, controlPlaneInstallationId: installationId });
  }

  /**
   * The current key's session, `'missing'` when it holds nothing, and `null`
   * when it held something that is not a session -- which is removed, as the
   * operations key does.
   */
  #readCurrent(): StoredDeviceSession | null | 'missing' {
    let raw: string | null;
    try {
      raw = this.#storage.getItem(this.#key);
    } catch {
      return null;
    }
    if (raw === null) return 'missing';
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isStoredDeviceSession(parsed)) return parsed;
    } catch {
      // Malformed: fall through and remove it, as the operations key does.
    }
    this.clear();
    return null;
  }

  /**
   * Carries the newest legacy session forward under the current key.
   *
   * The pairing survives the upgrade -- on a shoot day, nine screens asking for
   * fresh codes because the client learned a new field is a worse outcome than
   * the one being prevented -- while what the older blob could not state is
   * recorded rather than invented: a `v1` session cannot prove which database
   * it belongs to, so the connection treats it as unknown until a probe
   * supplies the answer.
   *
   * The carry happens once. The upgraded copy is written under the current key
   * and the legacy key is removed, so the next read takes the current key and
   * never reaches this path again.
   */
  #adoptLegacy(): StoredDeviceSession | null {
    for (const legacyKey of this.#legacyKeys) {
      let raw: string | null;
      try {
        raw = this.#storage.getItem(legacyKey);
      } catch {
        return null;
      }
      if (raw === null) continue;
      const upgraded = upgradeLegacy(raw);
      if (upgraded === null) {
        this.clear();
        return null;
      }
      this.write(upgraded);
      try {
        this.#storage.removeItem(legacyKey);
      } catch {
        // The upgraded copy is written; a legacy blob left behind is shadowed
        // by it on every later read.
      }
      return upgraded;
    }
    return null;
  }

  /**
   * The request id the next refresh must carry.
   *
   * A pending id from an unanswered attempt is returned again; otherwise a new
   * one is minted and persisted before the caller sends anything.
   */
  beginRefresh(mint: () => string): string {
    const session = this.read();
    if (session === null) throw new Error('No paired session to refresh.');
    if (session.pendingRefreshRequestId !== undefined) return session.pendingRefreshRequestId;
    const requestId = mint();
    this.write({ ...session, pendingRefreshRequestId: requestId });
    return requestId;
  }

  /** Records the rotated tokens and forgets the pending id in one write. */
  completeRefresh(tokens: RefreshedTokens): StoredDeviceSession {
    const session = this.read();
    if (session === null) throw new Error('No paired session to complete a refresh for.');
    const { pendingRefreshRequestId: _pending, ...rest } = session;
    const next: StoredDeviceSession = { ...rest, ...tokens };
    this.write(next);
    return next;
  }
}

/** The fields every stored version has held, under the names `v3` gives them. */
type PortableDeviceSession = Omit<StoredDeviceSession, 'version' | 'controlPlaneInstallationId'>;

type LegacyStoredDeviceSession = Omit<PortableDeviceSession, 'pairedAtUrl'> & {
  readonly controlPlaneUrl: string;
  /** Present from `v2` on; `v1` never recorded one. */
  readonly controlPlaneInstallationId?: string;
};

/**
 * One legacy blob as a `v3` session, or `null` when it is not a session at all.
 *
 * Both older versions carried the address under `controlPlaneUrl`; `v3` keeps
 * the value under `pairedAtUrl`, where nothing filters on it. `v2` also carried
 * the installation identity and keeps it; `v1` never had one and is carried
 * forward as unknown.
 */
function upgradeLegacy(raw: string): StoredDeviceSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isLegacyStoredDeviceSession(parsed)) return null;
  const { controlPlaneUrl, controlPlaneInstallationId, ...rest } = parsed;
  return {
    ...rest,
    version: 3,
    pairedAtUrl: controlPlaneUrl,
    controlPlaneInstallationId: controlPlaneInstallationId ?? '',
  };
}

function isStoredDeviceSession(value: unknown): value is StoredDeviceSession {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate['version'] === 3 &&
    // Required rather than defaulted: a `v3` blob without it was hand-edited or
    // truncated, and guessing `''` would turn a damaged record into a session
    // that merely cannot prove where it came from.
    typeof candidate['controlPlaneInstallationId'] === 'string' &&
    typeof candidate['pairedAtUrl'] === 'string' &&
    hasSessionFields(candidate)
  );
}

function isLegacyStoredDeviceSession(value: unknown): value is LegacyStoredDeviceSession {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate['version'] === 1 || candidate['version'] === 2) &&
    typeof candidate['controlPlaneUrl'] === 'string' &&
    // A `v2` blob without the identity is damaged in the same way a `v3` one
    // is, and is refused rather than carried forward as unknown: unknown is
    // reserved for versions that never recorded the answer.
    (candidate['version'] === 1 || typeof candidate['controlPlaneInstallationId'] === 'string') &&
    hasSessionFields(candidate)
  );
}

/** The credentials and identity every version has carried under the same names. */
function hasSessionFields(candidate: Record<string, unknown>): boolean {
  return (
    typeof candidate['accessToken'] === 'string' &&
    typeof candidate['refreshToken'] === 'string' &&
    typeof candidate['accessTokenExpiresAt'] === 'number' &&
    typeof candidate['refreshTokenExpiresAt'] === 'number' &&
    typeof candidate['deviceId'] === 'string' &&
    typeof candidate['groupId'] === 'string' &&
    deviceRoles.some((role) => role === candidate['role']) &&
    (candidate['pendingRefreshRequestId'] === undefined ||
      typeof candidate['pendingRefreshRequestId'] === 'string')
  );
}

/**
 * `localStorage` where it exists, and a process-lived map where it does not:
 * a server render, or a profile that blocks storage. The map keeps the
 * runtime working for the session and simply forgets it afterwards.
 *
 * Exported because `GroupSnapshotDownloader` persists under the same
 * conditions and must make the same choice; a second copy of this try/catch
 * would be a second place for "storage is blocked" to be handled differently.
 */
export function browserStorage(): KeyValueStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Access itself throws when storage is blocked.
  }
  return memoryStorage();
}

export function memoryStorage(): KeyValueStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}
