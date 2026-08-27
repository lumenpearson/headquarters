import type { Awaitable, MutationOutcome } from './lifecycle.js';
import type { MutationReceiptContext } from './receipts.js';
import type {
  AuthenticatedDevice,
  AuthorityMode,
  DeviceRole,
  PairedDevice,
  PairedGroup,
} from './runtime.js';

/** What a group-shaped mutation answers with, plus whether it actually ran. */
export interface MutatedGroup extends MutationOutcome {
  readonly group: PairedGroup;
}

/**
 * What a membership-shaped mutation answers with. The group rides along because
 * every one of these bumps the group revision in the same statement, and that
 * revision is how a subscriber orders the change.
 */
export interface MutatedGroupDevice extends MutatedGroup {
  readonly device: PairedDevice;
}

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
  ): Awaitable<MutatedGroup>;
  setAuthorityMode(
    authenticated: AuthenticatedDevice,
    groupId: string,
    mode: AuthorityMode,
    mutation?: MutationReceiptContext,
  ): Awaitable<MutatedGroup>;
  setLeader(
    authenticated: AuthenticatedDevice,
    groupId: string,
    deviceId: string,
    mutation?: MutationReceiptContext,
  ): Awaitable<MutatedGroup>;
  setDeviceRole(
    authenticated: AuthenticatedDevice,
    groupId: string,
    deviceId: string,
    role: DeviceRole,
    mutation?: MutationReceiptContext,
  ): Awaitable<MutatedGroupDevice>;
}
