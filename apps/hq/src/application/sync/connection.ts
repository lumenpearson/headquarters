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
  | 'reauth-required';

export type DeviceRole = 'VIEWER' | 'EDITOR' | 'ADMIN';

/** The two values of `groups.authority`, which `SetAuthorityMode` also takes. */
export type AuthorityMode = 'leader' | 'multi-authority';

export type PresenceStatus = 'OFFLINE' | 'ONLINE' | 'REVOKED';

/** What `GetCapabilities` answered, reduced to the flags this client acts on. */
export interface ControlPlaneCapabilities {
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
  /** The realtime socket, which is a separate fact from the session's mode. */
  readonly realtime: RealtimeLinkState;
  /** The last failure worth showing, in the operator's language; empty when none. */
  readonly failure: string;
}

export const initialConnectionState: ConnectionState = {
  mode: 'local-only',
  presence: [],
  devices: [],
  clock: { offsetMs: 0, latencyMs: 0, sampledAt: '' },
  realtime: initialRealtimeLinkState,
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
 */
export function disconnectedConnection(mode: ConnectionMode): ConnectionState {
  return {
    ...initialConnectionState,
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
