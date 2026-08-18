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
import type { PairedDeviceRuntime } from './runtime.js';

export interface PairedDeviceServiceOptions {
  readonly runtime: PairedDeviceRuntime;
  /**
   * An operator-controlled deployment secret. It gates unauthenticated initial
   * group creation; raw values are compared in constant time and are never
   * added to responses, telemetry, or error messages.
   */
  readonly bootstrapSecret: string;
}

/**
 * ConnectRPC adapter for the first six lifecycle RPCs. It is intentionally a
 * partial implementation: all CRDT, presence, leader-election, and event
 * methods remain typed `UNIMPLEMENTED` until their storage semantics exist.
 */
export function createPairedDeviceSyncService(
  options: PairedDeviceServiceOptions,
): Partial<ServiceImpl<typeof SyncService>> {
  const bootstrapSecret = requireBootstrapSecret(options.bootstrapSecret);

  return {
    createGroup(request, context) {
      return withRuntimeErrors(() => {
        requireBootstrapAuthorization(context, bootstrapSecret);
        const created = options.runtime.createGroup({
          name: request.name,
          initialDevice: {
            name: request.initialDevice?.name ?? '',
            publicKey: request.initialDevice?.publicKey ?? '',
            platform: request.initialDevice?.platform ?? '',
            applicationVersion: request.initialDevice?.applicationVersion ?? '',
          },
        });
        return {
          group: toGroup(created.group),
          device: toDevice(created.device),
          session: toSession(created.session),
        };
      });
    },

    createPairingCode(request, context) {
      return withRuntimeErrors(() => {
        const authenticated = authenticateRequest(options.runtime, context);
        options.runtime.assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const grant = options.runtime.createPairingCode(
          authenticated,
          requireResourceId(request.groupId?.value, 'group_id'),
          toPairingRole(request.role),
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

    pairDevice(request) {
      return withRuntimeErrors(() => {
        const paired = options.runtime.pairDevice({
          pairingCode: request.pairingCode,
          name: request.deviceName,
          publicKey: request.publicKey,
          platform: request.platform,
          applicationVersion: request.applicationVersion,
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

    refreshDeviceSession(request) {
      return withRuntimeErrors(() => ({
        session: toSession(options.runtime.refreshDeviceSession(request.refreshToken)),
      }));
    },

    listDevices(request, context) {
      return withRuntimeErrors(() => {
        const authenticated = authenticateRequest(options.runtime, context);
        const page = options.runtime.listDevices(
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

    revokeDevice(request, context) {
      return withRuntimeErrors(() => {
        const authenticated = authenticateRequest(options.runtime, context);
        options.runtime.assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const revoked = options.runtime.revokeDevice(
          authenticated,
          requireResourceId(request.groupId?.value, 'group_id'),
          requireResourceId(request.deviceId?.value, 'device_id'),
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
  runtime: PairedDeviceRuntime,
  context: HandlerContext,
): AuthenticatedDevice {
  return runtime.authenticateAccessToken(readBearerToken(context));
}

function requireBootstrapAuthorization(context: HandlerContext, expected: string): void {
  const supplied = context.requestHeader.get('x-hq-bootstrap-secret');
  if (supplied === null || !constantTimeEqual(supplied, expected)) {
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

function requireBootstrapSecret(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 32) {
    throw new Error('bootstrapSecret must contain at least 32 non-whitespace characters');
  }
  return normalized;
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
    status: device.status === 'ONLINE' ? syncV1.DeviceStatus.ONLINE : syncV1.DeviceStatus.REVOKED,
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

function withRuntimeErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error: unknown) {
    if (error instanceof ConnectError) throw error;
    if (error instanceof PairedDeviceRuntimeError) {
      throw new ConnectError(error.message, toConnectCode(error.code));
    }
    throw error;
  }
}

function toConnectCode(code: PairedDeviceRuntimeError['code']): Code {
  if (code === 'ALREADY_EXISTS') return Code.AlreadyExists;
  if (code === 'FAILED_PRECONDITION') return Code.FailedPrecondition;
  if (code === 'INVALID_ARGUMENT') return Code.InvalidArgument;
  if (code === 'NOT_FOUND') return Code.NotFound;
  if (code === 'PERMISSION_DENIED') return Code.PermissionDenied;
  return Code.Unauthenticated;
}
