import { timingSafeEqual } from 'node:crypto';

import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from '@connectrpc/connect';
import { syncV1 } from '@gremuchaya/protocol';
import type { SyncService } from '@gremuchaya/protocol';

import {
  PairedDeviceRuntimeError,
  type AuthenticatedDevice,
  type DeviceRole,
  type PairedDevice,
  type PairedDeviceSession,
  type PairedGroup,
} from './runtime.js';
import type { Awaitable, PairedDeviceLifecycle } from './lifecycle.js';
import {
  MutationRequestIdError,
  normalizeRequestId,
  type MutationReceiptContext,
} from './receipts.js';

export interface PairedDeviceServiceOptions {
  readonly runtime: PairedDeviceLifecycle;
  /**
   * A configuration-owned verifier for the operator bootstrap secret. The raw
   * deployment value remains in a configuration closure and is never added to
   * the service object, responses, telemetry, or error text.
   */
  readonly verifyBootstrapSecret: (candidate: string) => boolean;
}

/**
 * ConnectRPC adapter for the first six lifecycle RPCs. It is intentionally a
 * partial implementation: all CRDT, presence, leader-election, and event
 * methods remain typed `UNIMPLEMENTED` until their storage semantics exist.
 */
export function createPairedDeviceSyncService(
  options: PairedDeviceServiceOptions,
): Partial<ServiceImpl<typeof SyncService>> {
  const verifyBootstrapSecret = requireBootstrapVerifier(options.verifyBootstrapSecret);

  return {
    async createGroup(request, context) {
      return withRuntimeErrors(async () => {
        requireBootstrapAuthorization(context, verifyBootstrapSecret);
        const created = await options.runtime.createGroup({
          name: request.name,
          initialDevice: {
            name: request.initialDevice?.name ?? '',
            publicKey: request.initialDevice?.publicKey ?? '',
            platform: request.initialDevice?.platform ?? '',
            applicationVersion: request.initialDevice?.applicationVersion ?? '',
          },
          ...toMutationReceiptInput(request.context?.requestId),
        });
        return {
          group: toGroup(created.group),
          device: toDevice(created.device),
          session: toSession(created.session),
        };
      });
    },

    async createPairingCode(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticateRequest(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const mutation = toMutationReceiptContext(request.context?.requestId);
        const grant = await callWithMutation(mutation, (context) =>
          options.runtime.createPairingCode(
            authenticated,
            requireResourceId(request.groupId?.value, 'group_id'),
            toPairingRole(request.role),
            ...context,
          ),
        );
        return {
          pairingCode: {
            code: grant.code,
            groupId: { value: grant.groupId },
            role: toProtocolRole(grant.role),
            expiresAt: timestampFromDate(grant.expiresAt),
          },
        };
      });
    },

    async pairDevice(request) {
      return withRuntimeErrors(async () => {
        const paired = await options.runtime.pairDevice({
          pairingCode: request.pairingCode,
          name: request.deviceName,
          publicKey: request.publicKey,
          platform: request.platform,
          applicationVersion: request.applicationVersion,
          ...toMutationReceiptInput(request.context?.requestId),
        });
        return {
          group: toGroup(paired.group),
          device: toDevice(paired.device),
          // Deprecated scalar credential fields are deliberately left empty.
          // `session` is the only canonical credential envelope.
          session: toSession(paired.session),
        };
      });
    },

    async refreshDeviceSession(request) {
      return withRuntimeErrors(async () => {
        const mutation = toMutationReceiptContext(request.context?.requestId);
        const session =
          mutation === undefined
            ? await options.runtime.refreshDeviceSession(request.refreshToken)
            : await options.runtime.refreshDeviceSession(request.refreshToken, mutation);
        return { session: toSession(session) };
      });
    },

    async listDevices(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticateRequest(options.runtime, context);
        const page = await options.runtime.listDevices(
          authenticated,
          requireResourceId(request.groupId?.value, 'group_id'),
          request.page?.pageSize ?? 0,
          request.page?.cursor ?? '',
        );
        return {
          devices: page.items.map(toDevice),
          page: {
            nextCursor: page.nextCursor,
            previousCursor: page.previousCursor,
            hasMore: page.hasMore,
            approximateTotal: page.approximateTotal,
          },
        };
      });
    },

    async revokeDevice(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticateRequest(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const mutation = toMutationReceiptContext(request.context?.requestId);
        const revoked = await callWithMutation(mutation, (context) =>
          options.runtime.revokeDevice(
            authenticated,
            requireResourceId(request.groupId?.value, 'group_id'),
            requireResourceId(request.deviceId?.value, 'device_id'),
            ...context,
          ),
        );
        return {
          result: {
            resourceId: { value: revoked.device.id },
            revision: toRevision(revoked.group),
            correlationId: request.context?.correlationId ?? '',
          },
        };
      });
    },
  };
}

function authenticateRequest(
  runtime: PairedDeviceLifecycle,
  context: HandlerContext,
): Awaitable<AuthenticatedDevice> {
  return runtime.authenticateAccessToken(readBearerToken(context));
}

/**
 * `request_id` is the only part of `MutationContext` that carries idempotency
 * meaning. `correlation_id` is response metadata and `issued_at` is a client
 * clock reading, so neither may take part in retry identity.
 *
 * An oversized identifier is rejected as an argument error rather than
 * silently truncated: truncation would let two different retries share one
 * receipt.
 */
function toMutationReceiptContext(
  requestId: string | undefined,
): MutationReceiptContext | undefined {
  try {
    const normalized = normalizeRequestId(requestId);
    return normalized === undefined ? undefined : { requestId: normalized };
  } catch (error: unknown) {
    if (error instanceof MutationRequestIdError) {
      throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', error.message);
    }
    throw error;
  }
}

/**
 * Applies an optional trailing `mutation` argument without ever passing an
 * explicit `undefined`, which `exactOptionalPropertyTypes` rejects against an
 * optional parameter.
 */
function callWithMutation<T>(
  mutation: MutationReceiptContext | undefined,
  call: (context: [MutationReceiptContext] | []) => T,
): T {
  return call(mutation === undefined ? [] : [mutation]);
}

/** Spread form, because `exactOptionalPropertyTypes` rejects an explicit `undefined`. */
function toMutationReceiptInput(requestId: string | undefined): {
  readonly mutation?: MutationReceiptContext;
} {
  const mutation = toMutationReceiptContext(requestId);
  return mutation === undefined ? {} : { mutation };
}

function assertContextActor(
  authenticated: AuthenticatedDevice,
  actorDeviceId: string | undefined,
): void {
  if (actorDeviceId === undefined || actorDeviceId.length === 0) return;
  if (actorDeviceId !== authenticated.device.id) {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      'The mutation context actor does not match the authenticated device.',
    );
  }
}
function requireBootstrapAuthorization(
  context: HandlerContext,
  verifyBootstrapSecret: (candidate: string) => boolean,
): void {
  const supplied = context.requestHeader.get('x-hq-bootstrap-secret');
  if (supplied === null || !verifyBootstrapSecret(supplied)) {
    throw new ConnectError('Bootstrap authorization is required.', Code.Unauthenticated);
  }
}

function readBearerToken(context: HandlerContext): string {
  const header = context.requestHeader.get('authorization');
  const match = header === null ? undefined : /^Bearer ([^\s]+)$/u.exec(header.trim());
  if (match?.[1] === undefined) {
    throw new ConnectError('A bearer access token is required.', Code.Unauthenticated);
  }
  return match[1];
}

export function createBootstrapSecretVerifier(value: string): (candidate: string) => boolean {
  const normalized = value.trim();
  if (normalized.length < 32) {
    throw new Error('bootstrapSecret must contain at least 32 non-whitespace characters');
  }
  return (candidate) => constantTimeEqual(candidate, normalized);
}

function requireBootstrapVerifier(
  value: ((candidate: string) => boolean) | undefined,
): (candidate: string) => boolean {
  if (value === undefined) throw new Error('verifyBootstrapSecret is required');
  return value;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

function toGroup(group: PairedGroup) {
  return {
    id: { value: group.id },
    name: group.name,
    authorityMode:
      group.authorityMode === 'LEADER'
        ? syncV1.AuthorityMode.LEADER
        : syncV1.AuthorityMode.MULTI_AUTHORITY,
    leaderDeviceId: { value: group.leaderDeviceId },
    revision: toRevision(group),
    createdAt: timestampFromDate(group.createdAt),
    updatedAt: timestampFromDate(group.updatedAt),
  };
}

function toRevision(group: PairedGroup) {
  return {
    number: group.revision,
    etag: `group-${group.id}-revision-${group.revision.toString()}`,
  };
}

function toDevice(device: PairedDevice) {
  return {
    id: { value: device.id },
    name: device.name,
    publicKey: device.publicKey,
    role: toProtocolRole(device.role),
    status: toProtocolDeviceStatus(device.status),
    platform: device.platform,
    applicationVersion: device.applicationVersion,
    lastSeenAt: timestampFromDate(device.lastSeenAt),
  };
}

function toSession(session: PairedDeviceSession) {
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    accessTokenExpiresAt: timestampFromDate(session.accessTokenExpiresAt),
    refreshTokenExpiresAt: timestampFromDate(session.refreshTokenExpiresAt),
    deviceId: { value: session.deviceId },
    groupId: { value: session.groupId },
    role: toProtocolRole(session.role),
  };
}

function toProtocolDeviceStatus(status: PairedDevice['status']): syncV1.DeviceStatus {
  if (status === 'OFFLINE') return syncV1.DeviceStatus.OFFLINE;
  if (status === 'ONLINE') return syncV1.DeviceStatus.ONLINE;
  return syncV1.DeviceStatus.REVOKED;
}

function toPairingRole(role: syncV1.DeviceRole): Exclude<DeviceRole, 'ADMIN'> {
  if (role === syncV1.DeviceRole.VIEWER) return 'VIEWER';
  if (role === syncV1.DeviceRole.EDITOR) return 'EDITOR';
  throw new PairedDeviceRuntimeError(
    'INVALID_ARGUMENT',
    'Pairing codes can grant only VIEWER or EDITOR access.',
  );
}

function toProtocolRole(role: DeviceRole): syncV1.DeviceRole {
  if (role === 'VIEWER') return syncV1.DeviceRole.VIEWER;
  if (role === 'EDITOR') return syncV1.DeviceRole.EDITOR;
  return syncV1.DeviceRole.ADMIN;
}

function requireResourceId(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', `${field} must not be empty.`);
  }
  return value.trim();
}

async function withRuntimeErrors<T>(operation: () => Awaitable<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof ConnectError) throw error;
    if (error instanceof PairedDeviceRuntimeError) {
      throw new ConnectError(error.message, toConnectCode(error.code));
    }
    throw error;
  }
}

function toConnectCode(code: PairedDeviceRuntimeError['code']): Code {
  if (code === 'ABORTED') return Code.Aborted;
  if (code === 'ALREADY_EXISTS') return Code.AlreadyExists;
  if (code === 'FAILED_PRECONDITION') return Code.FailedPrecondition;
  if (code === 'INVALID_ARGUMENT') return Code.InvalidArgument;
  if (code === 'NOT_FOUND') return Code.NotFound;
  if (code === 'PERMISSION_DENIED') return Code.PermissionDenied;
  return Code.Unauthenticated;
}
