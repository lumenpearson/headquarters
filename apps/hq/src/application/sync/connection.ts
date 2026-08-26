import type { GroupEventDelivery } from './groupEventFeed';

/**
 * What this session knows about its synchronization group (R27).
 *
 * Runtime state, and only that: the tokens the group was earned with live in
 * `DeviceSessionStore`, never here, so a snapshot of the store -- persisted,
 * broadcast or copied into a diagnostic report -- can never carry a credential.
 * This slice is likewise left out of `persistedSnapshot`: a mode read back on
 * the next launch would describe a connection that no longer exists, and the
 * runtime re-establishes it from the session store in any case.
 */

export type ConnectionMode =
  /** `general.localOnly` is on, or no control plane address is configured. */
  | 'local-only'
  /** An address is configured and the control plane did not answer the probe. */
  | 'offline'
  /** Probing, restoring a session or joining the group. */
  | 'connecting'
  /** Paired, joined, and answering. */
  | 'online'
  /** The session was refused and could not be refreshed; a new pairing code is needed. */
  | 'reauth-required'
  /**
   * The address answers, but its database is not the one this device paired
   * against.
   *
   * A separate member because `reauth-required` states that this device's
   * credentials went stale, which the operator answers with a fresh pairing
   * code. This states something else entirely: the credentials may be perfectly
   * good and there is simply no longer a database that knows them, because the
   * one behind this address was deleted and recreated. Folding the two together
   * would send the operator to pair into an empty group and reconcile the
   * local state against nothing -- the loss this mode exists to prevent.
   *
   * Nothing is cleared when a session lands here. The stored session stays on
   * disk and the connection stays out of `online`, so no group settings are
   * adopted, no socket opens and no local state is overwritten, until the
   * operator decides.
   */
  | 'installation-changed';

export type DeviceRole = 'VIEWER' | 'EDITOR' | 'ADMIN';

/** The two values of `groups.authority`, which `SetAuthorityMode` also takes. */
export type AuthorityMode = 'leader' | 'multi-authority';

export type PresenceStatus = 'OFFLINE' | 'ONLINE' | 'REVOKED';

/** What `GetCapabilities` answered, reduced to the flags this client acts on. */
export interface ControlPlaneCapabilities {
  /**
   * The identity of the database behind this address, as `GetCapabilities`
   * reported it, or `''` when it reported none -- a control plane that reached
   * no database, or whose schema predates the migration that mints one.
   *
   * Not a credential and not a secret: it names a database, opens nothing, and
   * is answered to any caller that can reach the port. It lives on the
   * capabilities rather than beside the session because it is a fact about the
   * deployment, which is what this record holds.
   */
  readonly installationId: string;
  /** The group-event, presence and session-command surface. */
  readonly sync: boolean;
  /** Pairing and refresh -- without it no session can be started. */
  readonly deviceLifecycle: boolean;
  /** The authenticated realtime hub task 2 connects to. */
  readonly realtimeAdmission: boolean;
  readonly settings: boolean;
  readonly materials: boolean;
}

/**
 * Where the group's realtime socket stands (R27, F10 task 2).
 *
 * The status line used to say `SYNC:ONLINE` for a session whose only contact
 * with the group was a fifteen-second presence poll, which on set reads as
 * "this screen is following" when it is not. The link is therefore reported
 * beside the mode rather than folded into it: a session can be admitted and
 * still have no socket, because the deployment registered no realtime
 * admission or because the socket is between attempts.
 */
export type RealtimeLinkStatus =
  /** No socket is wanted: local-only, offline, or not yet joined. */
  | 'off'
  /** The socket is open or opening and has not been answered with `ServerReady`. */
  | 'connecting'
  /** `ServerReady` arrived; group events are being delivered. */
  | 'live'
  /** The socket dropped and the next attempt is waiting out its backoff. */
  | 'reconnecting'
  /** Admitted, but this control plane answers no realtime admission at all. */
  | 'polling';

export interface RealtimeLinkState {
  readonly status: RealtimeLinkStatus;
  /** What `ServerReady` named this connection; empty until it answers. */
  readonly connectionId: string;
  /**
   * The last group-event sequence this client applied, as a number because the
   * slice is read by React and a `bigint` in a store is a serialization trap.
   * A sequence never exceeds `Number.MAX_SAFE_INTEGER` in this deployment: it
   * counts appended events, not milliseconds.
   */
  readonly lastSequence: number;
  /**
   * How many times the retained log no longer covered the resume point and a
   * snapshot had to be taken instead. Nonzero says the socket dropped for
   * longer than the server keeps history, which is worth seeing.
   */
  readonly resyncCount: number;
}

export const initialRealtimeLinkState: RealtimeLinkState = {
  status: 'off',
  connectionId: '',
  lastSequence: 0,
  resyncCount: 0,
};

/**
 * Which of a device's links owns the session (F14, stage 7).
 *
 * `primary` is the first address the operator configured and the only client
 * allowed to write credentials: it probes, pairs, refreshes, joins, and carries
 * the group's settings. `secondary` links present the same credentials, deliver
 * the same group log and may be published to, and write nothing.
 *
 * The ranking is the operator's order and nothing else. There is no discovery
 * on the LAN and there is not going to be one, so the near plane is the address
 * written first, and the ordering is a statement rather than a guess.
 */
export type ControlPlaneLinkRole = 'primary' | 'secondary';

/**
 * One link to the group, and what it is currently doing.
 *
 * A device may hold more than one at a time, because a group may be reachable
 * two ways at once: a control plane on the set's LAN that admits a realtime
 * socket, and one on the public internet that does not, standing in front of
 * the same database. A screen on the LAN holds both -- the socket for
 * promptness and the poll so that it experiences the group exactly as the
 * members outside the LAN do.
 *
 * The live fields are {@link RealtimeLinkState}, unchanged, because they are
 * what a transport reports and both transports already report them. What is
 * added is the identity of the link they belong to, so that two reports can no
 * longer overwrite one another -- which is what a single record meant.
 */
export interface ControlPlaneLinkState extends RealtimeLinkState {
  /** Stable for the life of the runtime; assigned from the configured order. */
  readonly linkId: string;
  readonly baseUrl: string;
  readonly role: ControlPlaneLinkRole;
  /**
   * Whether this link's control plane reported the group's own database.
   *
   * True for the primary by definition -- it is the one the session's
   * installation identity was checked against -- and true for a secondary whose
   * `GetCapabilities` reported the same identity, or reported none. False is a
   * second address standing in front of a *different* database, which is not a
   * second way to this group but another group: it shares no sequence
   * allocator, no token table and no receipts, so following it would merge two
   * logs into one cursor. Such a link is kept in the list, with its address and
   * what it answered, and is never followed or published to.
   */
  readonly admitted: boolean;
  /**
   * How this link carries the group's events, as its own probe reported it.
   *
   * Per link and not per connection: the near plane answers
   * `sync.realtime-admission` true and the cloud plane answers it false, and a
   * single record of the answer meant the second probe erased the first.
   */
  readonly delivery: GroupEventDelivery;
  /** What this link's own `GetCapabilities` said; absent until it answers. */
  readonly capabilities?: ControlPlaneCapabilities | undefined;
}

export interface ConnectionSession {
  readonly deviceId: string;
  readonly groupId: string;
  readonly role: DeviceRole;
}

export interface PresenceEntry {
  readonly deviceId: string;
  readonly status: PresenceStatus;
  readonly activeScreen: string;
  readonly clockOffsetMs: number;
  readonly latencyMs: number;
  /** ISO 8601, or empty when the server sent no instant. */
  readonly observedAt: string;
}

export interface GroupDevice {
  readonly deviceId: string;
  readonly name: string;
  readonly role: DeviceRole;
  readonly status: PresenceStatus;
}

/**
 * The clock estimate against the control plane, NTP-style: `offsetMs` is what
 * to add to this machine's clock to read the server's, `latencyMs` the
 * one-way trip. `sampledAt` is empty until the first round completes, in the
 * store's idiom of an empty string rather than an absent field.
 */
export interface ClockEstimate {
  readonly offsetMs: number;
  readonly latencyMs: number;
  readonly sampledAt: string;
}

/**
 * What the local copy of the group's state holds, for the status line (F14,
 * stage 9).
 *
 * A summary and not the copy: the values live under
 * `gremuchaya-hq:group-mirror:v1` and are read there by
 * `GroupSnapshotDownloader`. What the operator needs on the status line is
 * whether there is a copy at all and when it was last refreshed, which is the
 * one fact that distinguishes "the group is unreachable and this screen is
 * showing what it last agreed" from "the group is unreachable and this screen
 * is showing the compiled-in defaults".
 *
 * Empty and zero mean no copy. The slice is not persisted -- see the note on
 * this module -- so it is re-read from storage on every launch.
 */
export interface GroupMirrorSummary {
  /** ISO 8601 of the last refresh that replaced the copy; empty when none. */
  readonly refreshedAt: string;
  /** The settings revision the copy holds; 0 when there is no copy. */
  readonly revision: number;
  /** The group-log position the copy is stamped at; 0 when none was recorded. */
  readonly sequence: number;
}

/**
 * The optional fields are written `| undefined` rather than merely optional,
 * which is the one place this application asks for an explicit `undefined`.
 * The slice is a merge target -- `patchConnection` spreads a patch over it --
 * and a session that has just ended has to be able to say so. Without the
 * explicit form, `exactOptionalPropertyTypes` refuses the only patch that
 * clears a field, and a group left behind would go on being displayed. The
 * same idiom `MaterialReadChunk` uses in `BridgeMaterialClient`.
 */
export interface ConnectionState {
  readonly mode: ConnectionMode;
  readonly capabilities?: ControlPlaneCapabilities | undefined;
  readonly session?: ConnectionSession | undefined;
  readonly groupName?: string | undefined;
  readonly authority?: AuthorityMode | undefined;
  readonly leaderDeviceId?: string | undefined;
  readonly presence: readonly PresenceEntry[];
  readonly devices: readonly GroupDevice[];
  readonly clock: ClockEstimate;
  /**
   * Every link this device holds to the group, in the operator's order.
   *
   * A set rather than one record, and installed by `ControlPlaneRuntime` from
   * the configured addresses rather than by a transport, so the addresses stay
   * readable while nothing is connected -- which is exactly when an operator
   * needs to see them.
   */
  readonly links: readonly ControlPlaneLinkState[];
  /**
   * The local copy of the group's state, which is a fact about the disk rather
   * than about the connection and survives every mode this slice can take.
   */
  readonly mirror: GroupMirrorSummary;
  /** The last failure worth showing, in the operator's language; empty when none. */
  readonly failure: string;
}

export const initialGroupMirrorSummary: GroupMirrorSummary = {
  refreshedAt: '',
  revision: 0,
  sequence: 0,
};

export const initialConnectionState: ConnectionState = {
  mode: 'local-only',
  presence: [],
  devices: [],
  clock: { offsetMs: 0, latencyMs: 0, sampledAt: '' },
  links: [],
  mirror: initialGroupMirrorSummary,
  failure: '',
};

/**
 * The slice with nothing connected, as both a state and a clearing patch.
 *
 * Every optional field is named `undefined` rather than left out, because
 * `patchConnection` merges: a group omitted here would go on being displayed
 * after the session that named it ended. Shared by `ControlPlaneSession`,
 * which resets on a revoked session, and by `ControlPlaneRuntime`, which uses
 * it when there is no connection to reset -- `general.localOnly` is on, or no
 * control plane address is configured at all.
 *
 * `mirror` and `links` are the two fields left out, and deliberately. The local
 * copy is a fact about the disk rather than about the connection, and clearing
 * it here would make the status line report "no local copy" for a session that
 * has one -- at exactly the moment the operator most needs to know it does. The
 * links are a fact about the configuration: the addresses this device was told
 * to try do not stop existing because a probe failed, and an operator looking
 * at an offline screen is looking for exactly those addresses. Their *live*
 * fields are reset by whoever owns them, through `resetLinkDelivery`.
 */
export function disconnectedConnection(
  mode: ConnectionMode,
): Omit<ConnectionState, 'mirror' | 'links'> {
  const { mirror: _mirror, links: _links, ...cleared } = initialConnectionState;
  return {
    ...cleared,
    mode,
    capabilities: undefined,
    session: undefined,
    groupName: undefined,
    authority: undefined,
    leaderDeviceId: undefined,
  };
}

/**
 * The link token the shell prints after the mode, in the same Latin register.
 *
 * `POLL` is the one that earns its place: it says the session is in the group
 * and is reading it on a timer, which is the truth on a control plane started
 * without realtime admission. Without it that session read exactly like one
 * with a live socket.
 */
export function realtimeStatusToken(status: RealtimeLinkStatus): string {
  switch (status) {
    case 'off':
      return 'OFF';
    case 'connecting':
      return 'DIAL';
    case 'live':
      return 'LIVE';
    case 'reconnecting':
      return 'RETRY';
    case 'polling':
      return 'POLL';
  }
}

/** The same link states, as the operator reads them in the transport popover. */
export function realtimeStatusLabel(status: RealtimeLinkStatus): string {
  switch (status) {
    case 'off':
      return 'СОКЕТ НЕ ОТКРЫТ';
    case 'connecting':
      return 'ПОДКЛЮЧЕНИЕ СОКЕТА';
    case 'live':
      return 'СОБЫТИЯ ГРУППЫ В РЕАЛЬНОМ ВРЕМЕНИ';
    case 'reconnecting':
      return 'ПЕРЕПОДКЛЮЧЕНИЕ СОКЕТА';
    case 'polling':
      return 'ОПРОС ПО ТАЙМЕРУ — CONTROL PLANE БЕЗ REALTIME';
  }
}

/** The status token the shell prints beside the bus, in the status line's Latin register. */
export function connectionModeToken(mode: ConnectionMode): string {
  switch (mode) {
    case 'local-only':
      return 'LOCAL';
    case 'offline':
      return 'OFFLINE';
    case 'connecting':
      return 'CONNECTING';
    case 'online':
      return 'ONLINE';
    case 'reauth-required':
      return 'REAUTH';
    case 'installation-changed':
      return 'FOREIGN';
  }
}

/** The same modes, as the operator reads them in the pairing surface. */
export function connectionModeLabel(mode: ConnectionMode): string {
  switch (mode) {
    case 'local-only':
      return 'ТОЛЬКО ЭТА МАШИНА';
    case 'offline':
      return 'CONTROL PLANE НЕ ОТВЕЧАЕТ';
    case 'connecting':
      return 'ПОДКЛЮЧЕНИЕ';
    case 'online':
      return 'В ГРУППЕ';
    case 'reauth-required':
      return 'НУЖЕН НОВЫЙ КОД ПАРЫ';
    case 'installation-changed':
      return 'ПО ЭТОМУ АДРЕСУ ДРУГАЯ БАЗА CONTROL PLANE';
  }
}

export function deviceRoleLabel(role: DeviceRole): string {
  switch (role) {
    case 'VIEWER':
      return 'НАБЛЮДАТЕЛЬ';
    case 'EDITOR':
      return 'РЕДАКТОР';
    case 'ADMIN':
      return 'АДМИНИСТРАТОР';
  }
}

export function authorityModeLabel(mode: AuthorityMode): string {
  return mode === 'leader' ? 'ОДНА ГЛАВНАЯ СЕССИЯ' : 'ВСЕ СЕССИИ ГЛАВНЫЕ';
}
