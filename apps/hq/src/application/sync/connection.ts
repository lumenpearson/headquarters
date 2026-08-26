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
  /** The last failure worth showing, in the operator's language; empty when none. */
  readonly failure: string;
}

export const initialConnectionState: ConnectionState = {
  mode: 'local-only',
  presence: [],
  devices: [],
  clock: { offsetMs: 0, latencyMs: 0, sampledAt: '' },
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
