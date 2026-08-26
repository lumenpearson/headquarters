import type { DeviceRole } from '@/application/sync/connection';

/**
 * The seventh persisted key. Listed in CLAUDE.md's state-ownership paragraph
 * and in `docs/release/environment.md` beside the other six.
 */
export const deviceSessionStorageKey = 'gremuchaya-hq:device-session:v1';

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
  readonly version: 1;
  /** The control plane the tokens belong to; a session is not moved between hosts. */
  readonly controlPlaneUrl: string;
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

  constructor(storage: KeyValueStorage = browserStorage(), key = deviceSessionStorageKey) {
    this.#storage = storage;
    this.#key = key;
  }

  /** The stored session, or `null` when there is none or the blob is not one. */
  read(): StoredDeviceSession | null {
    let raw: string | null;
    try {
      raw = this.#storage.getItem(this.#key);
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isStoredDeviceSession(parsed)) return parsed;
    } catch {
      // Malformed: fall through and remove it, as the operations key does.
    }
    this.clear();
    return null;
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
    try {
      this.#storage.removeItem(this.#key);
    } catch {
      // Nothing to recover.
    }
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

function isStoredDeviceSession(value: unknown): value is StoredDeviceSession {
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
