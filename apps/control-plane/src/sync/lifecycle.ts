import type {
  AuthenticatedDevice,
  CreateGroupInput,
  DeviceRole,
  Page,
  PairedDevice,
  PairedDeviceSession,
  PairedGroup,
  PairDeviceInput,
  PairingCodeGrant,
} from './runtime.js';

/** A result may be supplied by the deterministic local runtime or a durable repository. */
export type Awaitable<T> = T | Promise<T>;

export interface CreatedPairedGroup {
  readonly group: PairedGroup;
  readonly device: PairedDevice;
  readonly session: PairedDeviceSession;
}

export interface RevokedPairedDevice {
  readonly group: PairedGroup;
  readonly device: PairedDevice;
}

/**
 * The feature-facing lifecycle boundary. The existing deterministic runtime
 * remains a valid injected test adapter; the durable Neon adapter implements
 * the exact same contract asynchronously. This prevents ConnectRPC handlers
 * and realtime admission from knowing which persistence model is active.
 */
export interface PairedDeviceLifecycle {
  createGroup(input: CreateGroupInput): Awaitable<CreatedPairedGroup>;
  createPairingCode(
    authenticated: AuthenticatedDevice,
    groupId: string,
    role: Exclude<DeviceRole, 'ADMIN'>,
  ): Awaitable<PairingCodeGrant>;
  pairDevice(input: PairDeviceInput): Awaitable<CreatedPairedGroup>;
  refreshDeviceSession(refreshToken: string): Awaitable<PairedDeviceSession>;
  authenticateAccessToken(accessToken: string): Awaitable<AuthenticatedDevice>;
  listDevices(
    authenticated: AuthenticatedDevice,
    groupId: string,
    requestedPageSize: number,
    cursor: string,
  ): Awaitable<Page<PairedDevice>>;
  revokeDevice(
    authenticated: AuthenticatedDevice,
    groupId: string,
    deviceId: string,
  ): Awaitable<RevokedPairedDevice>;
}
