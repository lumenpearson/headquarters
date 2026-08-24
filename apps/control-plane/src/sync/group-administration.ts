import type { Awaitable } from './lifecycle.js';
import type { MutationReceiptContext } from './receipts.js';
import type {
  AuthenticatedDevice,
  AuthorityMode,
  DeviceRole,
  PairedDevice,
  PairedGroup,
} from './runtime.js';

/**
 * The administrative half of a paired group.
 *
 * It is a port of its own rather than four more methods on
 * `PairedDeviceLifecycle` because the deterministic in-process runtime is still
 * a valid injected adapter for the pairing lifecycle and has no group
 * administration to offer. Keeping them apart means a suite that injects the
 * in-process runtime keeps compiling, and the RPCs that need administration
 * stay `unimplemented` there instead of pretending to work.
 */
export interface GroupAdministration {
  updateGroup(
    authenticated: AuthenticatedDevice,
    groupId: string,
    name: string,
    mutation?: MutationReceiptContext,
  ): Awaitable<{ readonly group: PairedGroup }>;
  setAuthorityMode(
    authenticated: AuthenticatedDevice,
    groupId: string,
    mode: AuthorityMode,
    mutation?: MutationReceiptContext,
  ): Awaitable<{ readonly group: PairedGroup }>;
  setLeader(
    authenticated: AuthenticatedDevice,
    groupId: string,
    deviceId: string,
    mutation?: MutationReceiptContext,
  ): Awaitable<{ readonly group: PairedGroup }>;
  setDeviceRole(
    authenticated: AuthenticatedDevice,
    groupId: string,
    deviceId: string,
    role: DeviceRole,
    mutation?: MutationReceiptContext,
  ): Awaitable<{ readonly group: PairedGroup; readonly device: PairedDevice }>;
}
