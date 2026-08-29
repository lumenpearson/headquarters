import type {
  AuthorityMode,
  ConnectionSession,
  ControlPlaneCapabilities,
  DeviceRole,
  GroupDevice,
  GroupSummary,
  PairingRole,
  PresenceDetail,
  PresenceEntry,
} from './connection';
import type {
  DocumentDeltaPublication,
  DocumentDeltaReceipt,
  DocumentSnapshot,
  GroupSessionCommand,
  SessionCommandPublication,
} from './groupChannel';
import type { GroupEventPage } from './groupEventFeed';

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
  /**
   * Creates the group and pairs this device into it as its first `ADMIN`.
   *
   * The one call on this port that presents no bearer token, because there is
   * no session yet and no group for one to belong to. What authorizes it is the
   * deployment's own bootstrap secret, carried on the request and nowhere else:
   * see {@link CreateGroupRequest}.
   *
   * It answers exactly what pairing answers, and for the same reason -- a group,
   * a device and a session -- so a caller that has one has no second shape to
   * learn.
   */
  createGroup(request: CreateGroupRequest, signal?: AbortSignal): Promise<PairingResult>;
  pair(pairingCode: string, deviceName: string, signal?: AbortSignal): Promise<PairingResult>;
  /**
   * Issues one pairing code for this session's group.
   *
   * The code is a credential: it is what a neighbouring device presents to
   * `PairDevice` to earn a session. It is therefore *returned* rather than
   * recorded, and no caller may put it in the `connection` slice, which is
   * persisted, broadcast and copied into diagnostics.
   */
  createPairingCode(role: PairingRole, signal?: AbortSignal): Promise<PairingCodeGrant>;
  /** Renames this session's group. An administrator may; anyone else is refused. */
  updateGroup(name: string, signal?: AbortSignal): Promise<GroupSummary>;
  /**
   * Changes what a member of this session's group may do.
   *
   * Answers the device alone -- `SetDeviceRoleResponse` carries no group, so no
   * revision comes back with it, and the group's own fields are left to the
   * `DEVICE_UPDATED` event the same mutation publishes.
   */
  setDeviceRole(deviceId: string, role: DeviceRole, signal?: AbortSignal): Promise<GroupDevice>;
  refresh(signal?: AbortSignal): Promise<ConnectionSession>;
  /**
   * Enters the group's session, and reports what this device is showing on
   * the same call (F10 presence publish).
   *
   * `detail` is optional so a caller with nothing to report -- a test, or a
   * client built before this existed -- may omit it; the wire message is
   * still sent, filled with the proto3 defaults, because `JoinGroup` already
   * publishes `PRESENCE_UPDATED` and a bare join must not leave a neighbour's
   * previous participation showing on the row.
   */
  join(detail?: PresenceDetail, signal?: AbortSignal): Promise<GroupSummary>;
  leave(signal?: AbortSignal): Promise<void>;
  listDevices(signal?: AbortSignal): Promise<readonly GroupDevice[]>;
  revoke(deviceId: string, signal?: AbortSignal): Promise<void>;
  setAuthorityMode(mode: AuthorityMode, signal?: AbortSignal): Promise<GroupSummary>;
  setLeader(deviceId: string, signal?: AbortSignal): Promise<GroupSummary>;
  timeSync(signal?: AbortSignal): Promise<ClockSample>;
  getPresence(signal?: AbortSignal): Promise<readonly PresenceEntry[]>;
  /**
   * Reports what this device is currently showing, and renews its liveness
   * with the same call (F10 presence publish).
   *
   * The answer is the group's presence after the report -- the same list
   * `getPresence` answers -- so a caller that reports on a timer learns both
   * what a neighbour changed and what its own report just produced, from one
   * round trip rather than two.
   */
  updatePresence(detail: PresenceDetail, signal?: AbortSignal): Promise<readonly PresenceEntry[]>;
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
  /**
   * One page of the group log after `afterSequence`.
   *
   * Not a second `WatchGroup`: that one means "push what arrives" and needs the
   * realtime hub's process-local listener set, which a deployment answering
   * successive requests on different instances cannot keep. This one means
   * "give me the page after N", needs no hub, and is what makes the log
   * readable where no socket can exist.
   *
   * `limit` is omitted rather than filled in, so the ceiling stays the server's
   * one. A value above it is refused rather than clamped, because a silently
   * shortened page looks exactly like the end of the log.
   */
  readGroupEvents(afterSequence: bigint, signal?: AbortSignal): Promise<GroupEventPage>;
}

export interface PairingResult {
  readonly session: ConnectionSession;
  readonly group: GroupSummary;
  readonly device: GroupDevice;
}

/**
 * What it takes to bring a group into existence.
 *
 * `bootstrapSecret` is the deployment's `HQ_CONTROL_PLANE_BOOTSTRAP_SECRET`,
 * which `CreateGroup` -- and only `CreateGroup` -- requires
 * (`sync/service.ts`, `requireBootstrapAuthorization`). It is the one credential
 * this application takes from the operator and does not keep: it is passed
 * straight through to the transport as a request header, is never written to
 * the session store, never enters the `connection` slice, and never appears in
 * a failure message. The alternative -- a deployment secret in
 * `project.override.json` on every screen machine -- would put it permanently
 * on every disk on set and read it into the runtime configuration besides.
 */
export interface CreateGroupRequest {
  readonly name: string;
  readonly deviceName: string;
  readonly bootstrapSecret: string;
}

/**
 * One issued pairing code, as the operator has to read it out to a neighbour.
 *
 * `expiresAtMs` is not decoration. The code lives ten minutes by default
 * (`HQ_CONTROL_PLANE_AUTH_PAIRING_CODE_TTL_SECONDS`), and a code shown without
 * its deadline is one an operator will still be reading out after the server
 * has forgotten it -- which presents as "the code is wrong" rather than as
 * "the code is old". Zero means the control plane sent no instant.
 */
export interface PairingCodeGrant {
  readonly code: string;
  readonly role: DeviceRole;
  readonly expiresAtMs: number;
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
