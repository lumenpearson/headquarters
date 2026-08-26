import type {
  AuthorityMode,
  ConnectionSession,
  ControlPlaneCapabilities,
  GroupDevice,
  PresenceEntry,
} from './connection';
import type {
  DocumentDeltaPublication,
  DocumentDeltaReceipt,
  DocumentSnapshot,
  GroupSessionCommand,
  SessionCommandPublication,
} from './groupChannel';

/**
 * What the session service needs of the control plane, stated here so the
 * application layer owns the contract and `ControlPlaneClient` in
 * infrastructure implements it -- the direction `dependency-map.md` fixes.
 * A test hands the service a fake of this interface and no transport at all.
 */
export interface ControlPlanePort {
  readonly baseUrl: string;
  /** The stored identity, or `null` when this client has not been paired. */
  session(): ConnectionSession | null;
  /** Epoch milliseconds, or `null` without a session. */
  accessTokenExpiresAt(): number | null;
  /** Drops the session for good. The next connection needs a pairing code. */
  forgetSession(): void;
  /**
   * The control-plane installation the stored session was minted against, or
   * `null` when there is no session at all.
   *
   * `''` is a third answer and not the same as `null`: a session stored before
   * this client recorded the identity, or one paired against a control plane
   * that reported none. Unknown is deliberately not a match -- a client that
   * cannot compare must say so rather than assume the database is the one it
   * knew.
   */
  storedInstallationId(): string | null;
  /**
   * Records which installation the stored session belongs to.
   *
   * Called after pairing, and once for a session that predates the field, so
   * the *next* replacement of the database is caught. It never overwrites a
   * recorded identity with a different one: that disagreement is the fact the
   * whole check exists to report, and silently adopting it would erase it.
   */
  adoptInstallationId(installationId: string): void;
  probeCapabilities(signal?: AbortSignal): Promise<ControlPlaneCapabilities>;
  pair(pairingCode: string, deviceName: string, signal?: AbortSignal): Promise<PairingResult>;
  refresh(signal?: AbortSignal): Promise<ConnectionSession>;
  join(signal?: AbortSignal): Promise<GroupSummary>;
  leave(signal?: AbortSignal): Promise<void>;
  listDevices(signal?: AbortSignal): Promise<readonly GroupDevice[]>;
  revoke(deviceId: string, signal?: AbortSignal): Promise<void>;
  setAuthorityMode(mode: AuthorityMode, signal?: AbortSignal): Promise<GroupSummary>;
  setLeader(deviceId: string, signal?: AbortSignal): Promise<GroupSummary>;
  timeSync(signal?: AbortSignal): Promise<ClockSample>;
  getPresence(signal?: AbortSignal): Promise<readonly PresenceEntry[]>;
  /**
   * Appends one document delta to the group log. The server allocates the
   * sequence; an editor role is required and a viewer is refused.
   */
  publishDocumentDelta(
    publication: DocumentDeltaPublication,
    signal?: AbortSignal,
  ): Promise<DocumentDeltaReceipt>;
  /**
   * Appends one session command. Under `LEADER` authority only the leader may,
   * and the refusal is `failed-precondition` rather than a silent no-op.
   * `epoch` and `sequence` come back from the server; neither is sent.
   */
  publishSessionCommand(
    publication: SessionCommandPublication,
    signal?: AbortSignal,
  ): Promise<GroupSessionCommand>;
  /**
   * The document state a resume falls back to. `null` rather than a throw when
   * the server has recorded no snapshot, because "no snapshot yet" is the
   * ordinary state of a group whose log has never been pruned.
   */
  getDocumentSnapshot(documentId: string, signal?: AbortSignal): Promise<DocumentSnapshot | null>;
}

export interface GroupSummary {
  readonly groupId: string;
  readonly name: string;
  readonly authority: AuthorityMode;
  readonly leaderDeviceId: string;
}

export interface PairingResult {
  readonly session: ConnectionSession;
  readonly group: GroupSummary;
  readonly device: GroupDevice;
}

/** The four instants of one `TimeSync` round, all in epoch milliseconds. */
export interface ClockSample {
  readonly clientSendMs: number;
  readonly serverReceiveMs: number;
  readonly serverSendMs: number;
  readonly clientReceiveMs: number;
}

export type ControlPlaneErrorKind =
  | 'unauthenticated'
  | 'permission-denied'
  | 'unimplemented'
  | 'unavailable'
  | 'invalid-argument'
  | 'not-found'
  | 'failed-precondition'
  | 'unknown';

/**
 * A control-plane failure as the session service reasons about it.
 *
 * The Connect code is folded into a kind because the service takes exactly
 * three decisions on it -- refresh and retry, tell the operator to pair
 * again, or note that this deployment lacks the collaborator -- and a
 * `Code` import in the application layer would be the transport leaking up.
 */
export class ControlPlaneError extends Error {
  constructor(
    readonly kind: ControlPlaneErrorKind,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ControlPlaneError';
  }
}

export function isControlPlaneError(
  error: unknown,
  kind?: ControlPlaneErrorKind,
): error is ControlPlaneError {
  return error instanceof ControlPlaneError && (kind === undefined || error.kind === kind);
}
