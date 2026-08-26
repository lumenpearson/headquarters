import type { DeviceRole } from '@/application/sync/connection';

/**
 * The seventh persisted key. Listed in CLAUDE.md's state-ownership paragraph
 * and in `docs/release/environment.md` beside the other six.
 */
export const deviceSessionStorageKey = 'gremuchaya-hq:device-session:v2';

/**
 * The key `v1` sessions were written under, still read once so a device paired
 * before this client recorded the control plane's identity does not lose its
 * pairing to an upgrade.
 *
 * What such a session does lose is the claim of knowing which database it
 * belongs to: a `v1` blob is carried forward with an empty
 * `controlPlaneInstallationId`, which the connection reads as unknown rather
 * than as a match. Unknown is the truth -- the pairing happened before anything
 * recorded the answer.
 */
export const legacyDeviceSessionStorageKey = 'gremuchaya-hq:device-session:v1';

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
  readonly version: 2;
  /** The control plane the tokens belong to; a session is not moved between hosts. */
  readonly controlPlaneUrl: string;
  /**
   * Which database behind that address the session was minted against, as
   * `GetCapabilities` reported it at the moment of pairing.
   *
   * An address is not an identity. A control plane deployed on a free Neon
   * project can be handed a new, empty database at the same URL, and a client
   * that remembered only the URL would re-pair into an empty group and
   * reconcile its local state against nothing. This field is what makes the
   * replacement detectable.
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
  readonly #legacyKey: string;

  constructor(
    storage: KeyValueStorage = browserStorage(),
    key = deviceSessionStorageKey,
    legacyKey = legacyDeviceSessionStorageKey,
  ) {
    this.#storage = storage;
    this.#key = key;
    this.#legacyKey = legacyKey;
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
    // Both keys, so that forgetting a pairing is not undone by the legacy blob
    // being carried forward again on the next read.
    for (const key of [this.#key, this.#legacyKey]) {
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
   * Carries a `v1` session forward under the current key, with no installation
   * identity.
   *
   * The pairing survives the upgrade -- on a shoot day, nine screens asking for
   * fresh codes because the client learned a new field is a worse outcome than
   * the one being prevented -- while the gap is recorded rather than papered
   * over: such a session cannot prove which database it belongs to, so the
   * connection treats it as unknown until a probe supplies the answer.
   */
  #adoptLegacy(): StoredDeviceSession | null {
    let raw: string | null;
    try {
      raw = this.#storage.getItem(this.#legacyKey);
    } catch {
      return null;
    }
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.clear();
      return null;
    }
    if (!isLegacyStoredDeviceSession(parsed)) {
      this.clear();
      return null;
    }
    const { version: _version, ...rest } = parsed;
    const upgraded: StoredDeviceSession = { ...rest, version: 2, controlPlaneInstallationId: '' };
    this.write(upgraded);
    try {
      this.#storage.removeItem(this.#legacyKey);
    } catch {
      // The upgraded copy is written; a legacy blob left behind is shadowed by
      // it on every later read.
    }
    return upgraded;
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

type LegacyStoredDeviceSession = Omit<
  StoredDeviceSession,
  'version' | 'controlPlaneInstallationId'
> & { readonly version: 1 };

function isStoredDeviceSession(value: unknown): value is StoredDeviceSession {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate['version'] === 2 &&
    // Required rather than defaulted: a `v2` blob without it was hand-edited or
    // truncated, and guessing `''` would turn a damaged record into a session
    // that merely cannot prove where it came from.
    typeof candidate['controlPlaneInstallationId'] === 'string' &&
    typeof candidate['controlPlaneUrl'] === 'string' &&
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

function isLegacyStoredDeviceSession(value: unknown): value is LegacyStoredDeviceSession {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate['version'] === 1 &&
    typeof candidate['controlPlaneUrl'] === 'string' &&
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
 */
function browserStorage(): KeyValueStorage {
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
