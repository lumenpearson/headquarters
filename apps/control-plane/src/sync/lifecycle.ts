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
import type { MutationReceiptContext } from './receipts.js';

/** A result may be supplied by the deterministic local runtime or a durable repository. */
export type Awaitable<T> = T | Promise<T>;

export interface CreatedPairedGroup {
  readonly group: PairedGroup;
  readonly device: PairedDevice;
  readonly session: PairedDeviceSession;
}

/**
 * Whether this answer came from a receipt instead of from a mutation that ran.
 *
 * A retry carrying an already-completed `request_id` is answered from
 * `mutation_receipts`: the group was revised once, by the original call. Both
 * runtimes already know which of the two happened — the durable one reads
 * `receipt_claimed` back from its own statement, the deterministic one holds
 * the completed receipt record — but neither said so, and the service layer
 * cannot re-derive it. Comparing revisions would not answer the question: a
 * concurrent mutation moves the group between the two calls, and a receipt
 * deliberately answers with the revision the original produced.
 *
 * So the fact is reported rather than reconstructed, which is what keeps the
 * receipt the single place that decides what a retry is.
 */
export interface MutationOutcome {
  readonly replayed: boolean;
}

export interface RevokedPairedDevice extends MutationOutcome {
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
    mutation?: MutationReceiptContext,
  ): Awaitable<PairingCodeGrant>;
  pairDevice(input: PairDeviceInput): Awaitable<CreatedPairedGroup>;
  /**
   * `mutation` carries the client's `MutationContext.request_id`. Supplying it
   * makes rotation safely retryable: without a receipt, a retry presents an
   * already-rotated token and is correctly classified as a replay attack,
   * which revokes the session family and strands the device.
   */
  refreshDeviceSession(
    refreshToken: string,
    mutation?: MutationReceiptContext,
  ): Awaitable<PairedDeviceSession>;
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
    mutation?: MutationReceiptContext,
  ): Awaitable<RevokedPairedDevice>;
}
