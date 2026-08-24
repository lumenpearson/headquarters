import { createHmac, randomBytes as nodeRandomBytes } from 'node:crypto';

import { normalizePageSize as boundPageSize } from './paging.js';
import {
  encodeFingerprintPayload,
  encodeRequestIdPayload,
  normalizeRequestId,
  type FingerprintField,
  type MutationReceiptContext,
  type MutationScope,
} from './receipts.js';

export type DeviceRole = 'VIEWER' | 'EDITOR' | 'ADMIN';
export type DeviceStatus = 'OFFLINE' | 'ONLINE' | 'REVOKED';
export type AuthorityMode = 'LEADER' | 'MULTI_AUTHORITY';

export interface PairedGroup {
  readonly id: string;
  readonly name: string;
  readonly authorityMode: AuthorityMode;
  readonly leaderDeviceId: string;
  readonly revision: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PairedDevice {
  readonly id: string;
  readonly name: string;
  readonly publicKey: string;
  readonly role: DeviceRole;
  readonly status: DeviceStatus;
  readonly platform: string;
  readonly applicationVersion: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

export interface PairedDeviceSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshTokenExpiresAt: Date;
  readonly deviceId: string;
  readonly groupId: string;
  readonly role: DeviceRole;
}

export interface AuthenticatedDevice {
  readonly group: PairedGroup;
  readonly device: PairedDevice;
  readonly role: DeviceRole;
  readonly sessionId: string;
  /**
   * Internal exact bearer identity. This value is never serialized through
   * the public RPC contract; it binds sensitive grants to the access token
   * that actually authenticated the caller.
   */
  readonly accessTokenId: string;
}

export interface CreateGroupInput {
  readonly name: string;
  readonly initialDevice: {
    readonly name: string;
    readonly publicKey: string;
    readonly platform: string;
    readonly applicationVersion: string;
  };
  /**
   * Optional durable-retry identity. Bootstrap is rare but not harmless to
   * repeat: without a receipt a lost response leaves the operator with two
   * groups and no way to tell which one their next call will reach.
   */
  readonly mutation?: MutationReceiptContext;
}

export interface PairDeviceInput {
  readonly pairingCode: string;
  readonly name: string;
  readonly publicKey: string;
  readonly platform: string;
  readonly applicationVersion: string;
  /**
   * Optional durable-retry identity. Absent means the caller has not opted
   * into idempotency, which keeps the pre-receipt contract intact.
   */
  readonly mutation?: MutationReceiptContext;
}

export interface PairingCodeGrant {
  readonly code: string;
  readonly groupId: string;
  readonly role: Exclude<DeviceRole, 'ADMIN'>;
  readonly expiresAt: Date;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string;
  readonly previousCursor: string;
  readonly hasMore: boolean;
  readonly approximateTotal: bigint;
}

export interface PairedDeviceRuntimeOptions {
  /**
   * HMAC pepper used to persist only token hashes. This runtime intentionally
   * never stores raw access, refresh, or pairing tokens.
   */
  readonly tokenPepper: string;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly accessTokenLifetimeMs?: number;
  readonly refreshTokenLifetimeMs?: number;
  readonly pairingCodeLifetimeMs?: number;
  /**
   * How long a completed idempotency receipt keeps answering retries. It
   * bounds both storage and the window in which a recorded mutation can
   * re-issue credentials.
   */
  readonly mutationReceiptLifetimeMs?: number;
}

export type PairedDeviceErrorCode =
  | 'ABORTED'
  | 'ALREADY_EXISTS'
  | 'FAILED_PRECONDITION'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'UNAUTHENTICATED';

export class PairedDeviceRuntimeError extends Error {
  constructor(
    readonly code: PairedDeviceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PairedDeviceRuntimeError';
  }
}

interface DeviceRecord {
  readonly id: string;
  readonly name: string;
  readonly publicKey: string;
  readonly platform: string;
  readonly applicationVersion: string;
  readonly createdAt: Date;
  status: DeviceStatus;
  lastSeenAt: Date;
}

interface MembershipRecord {
  readonly groupId: string;
  readonly deviceId: string;
  readonly role: DeviceRole;
  readonly joinedAt: Date;
  revokedAt?: Date;
}

interface PairingCodeRecord {
  readonly tokenHash: string;
  readonly groupId: string;
  readonly role: Exclude<DeviceRole, 'ADMIN'>;
  readonly expiresAt: Date;
  readonly createdByDeviceId: string;
  readonly createdBySessionId: string;
  readonly createdByAccessTokenId: string;
  consumedAt?: Date;
  revokedAt?: Date;
}

interface SessionRecord {
  readonly id: string;
  readonly groupId: string;
  readonly deviceId: string;
  accessTokenId: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  issuedAt: Date;
  revokedAt?: Date;
}

/**
 * A refresh credential remains addressable after rotation so a late duplicate
 * request can revoke the same session family rather than merely failing after
 * a replacement session was already issued.
 */
interface RefreshTokenReference {
  readonly session: SessionRecord;
  readonly expiresAt: Date;
}

/**
 * The in-memory counterpart of the `mutation_receipts` row. It records no
 * response for the same reason the table does not: pairing and refresh
 * responses carry raw bearer credentials, and a retry is answered by
 * re-issuing credentials for `sessionId` instead of by replaying bytes.
 *
 * `completedAt === undefined` means exactly one thing — the mutation did not
 * finish — so such a receipt stays re-claimable and a failed attempt never
 * permanently burns its request identifier.
 */
interface MutationReceiptRecord {
  readonly scope: MutationScope;
  readonly expiresAt: Date;
  fingerprint: string;
  claimedAt: Date;
  completedAt?: Date;
  groupId?: string;
  deviceId?: string;
  sessionId?: string;
  /**
   * A pairing code's hash. Not every mutation produces a session, and a code is
   * the one outcome a retry has to be able to reach in order to retire it.
   */
  resourceHash?: string;
  /** The group revision a revoke produced, so a replay does not report drift. */
  revision?: bigint;
}

interface MutationReceiptClaim {
  readonly key: string;
  readonly fingerprint: string;
  /** Present only when a previous attempt already committed this mutation. */
  readonly replay: MutationReceiptRecord | undefined;
}

interface CompletedMutationOutcome {
  readonly groupId: string;
  readonly deviceId: string;
  readonly sessionId: string;
}

const defaultAccessTokenLifetimeMs = 15 * 60 * 1000;
const defaultRefreshTokenLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const defaultPairingCodeLifetimeMs = 10 * 60 * 1000;
const defaultMutationReceiptLifetimeMs = 24 * 60 * 60 * 1000;
const defaultPageSize = 50;
const maxPageSize = 100;

/**
 * Deterministic domain runtime used by the ConnectRPC service and integration
 * tests. It is deliberately injected into the HTTP server rather than created
 * from environment variables: production startup must use a durable adapter
 * once the Neon repository is wired, never an accidental in-memory store.
 */
export class PairedDeviceRuntime {
  readonly #groups = new Map<string, PairedGroup>();
  readonly #devicesById = new Map<string, DeviceRecord>();
  readonly #deviceIdByPublicKey = new Map<string, string>();
  readonly #memberships = new Map<string, MembershipRecord>();
  readonly #pairingCodesByHash = new Map<string, PairingCodeRecord>();
  readonly #sessionsById = new Map<string, SessionRecord>();
  readonly #sessionsByAccessHash = new Map<string, SessionRecord>();
  readonly #sessionsByRefreshHash = new Map<string, RefreshTokenReference>();
  readonly #receipts = new Map<string, MutationReceiptRecord>();
  readonly #now: () => Date;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #accessTokenLifetimeMs: number;
  readonly #refreshTokenLifetimeMs: number;
  readonly #pairingCodeLifetimeMs: number;
  readonly #mutationReceiptLifetimeMs: number;
  readonly #tokenPepper: string;

  constructor(options: PairedDeviceRuntimeOptions) {
    this.#tokenPepper = options.tokenPepper.trim();
    if (this.#tokenPepper.length < 32) {
      throw new Error('tokenPepper must contain at least 32 non-whitespace characters');
    }
    this.#now = options.now ?? (() => new Date());
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.#accessTokenLifetimeMs = positiveLifetime(
      options.accessTokenLifetimeMs ?? defaultAccessTokenLifetimeMs,
      'accessTokenLifetimeMs',
    );
    this.#refreshTokenLifetimeMs = positiveLifetime(
      options.refreshTokenLifetimeMs ?? defaultRefreshTokenLifetimeMs,
      'refreshTokenLifetimeMs',
    );
    this.#pairingCodeLifetimeMs = positiveLifetime(
      options.pairingCodeLifetimeMs ?? defaultPairingCodeLifetimeMs,
      'pairingCodeLifetimeMs',
    );
    this.#mutationReceiptLifetimeMs = positiveLifetime(
      options.mutationReceiptLifetimeMs ?? defaultMutationReceiptLifetimeMs,
      'mutationReceiptLifetimeMs',
    );
  }

  createGroup(input: CreateGroupInput): {
    readonly group: PairedGroup;
    readonly device: PairedDevice;
    readonly session: PairedDeviceSession;
  } {
    const now = this.currentTime();
    const groupName = requireText(input.name, 'name');
    const initialDevice = normalizeDeviceInput(input.initialDevice);
    const claim = this.claimReceipt(
      'CREATE_GROUP',
      input.mutation,
      [
        ['group_name', groupName],
        ['device_name', initialDevice.name],
        ['public_key', initialDevice.publicKey],
        ['platform', initialDevice.platform],
        ['application_version', initialDevice.applicationVersion],
      ],
      now,
    );
    if (claim?.replay !== undefined) return this.replayCreatedLifecycle(claim, claim.replay, now);
    // Checked after the receipt lookup: a retry of a committed bootstrap
    // legitimately presents the key its own first attempt registered.
    this.ensurePublicKeyAvailable(initialDevice.publicKey);

    const groupId = this.createId();
    const deviceId = this.createId();
    const group: PairedGroup = {
      id: groupId,
      name: groupName,
      authorityMode: 'LEADER',
      leaderDeviceId: deviceId,
      revision: 1n,
      createdAt: now,
      updatedAt: now,
    };
    const device: DeviceRecord = {
      id: deviceId,
      ...initialDevice,
      createdAt: now,
      status: 'ONLINE',
      lastSeenAt: now,
    };
    const membership: MembershipRecord = {
      groupId,
      deviceId,
      role: 'ADMIN',
      joinedAt: now,
    };

    this.#groups.set(groupId, group);
    this.#devicesById.set(deviceId, device);
    this.#deviceIdByPublicKey.set(device.publicKey, deviceId);
    this.#memberships.set(membershipKey(groupId, deviceId), membership);
    const session = this.issueSession(group, device, membership, now);
    this.completeReceipt(claim, groupId, deviceId, session.record.id, now);
    return {
      group: copyGroup(group),
      device: this.toPairedDevice(device, membership),
      session: session.envelope,
    };
  }

  createPairingCode(
    authenticated: AuthenticatedDevice,
    groupId: string,
    role: Exclude<DeviceRole, 'ADMIN'>,
    mutation?: MutationReceiptContext,
  ): PairingCodeGrant {
    const now = this.currentTime();
    const claim = this.claimReceipt(
      'CREATE_PAIRING_CODE',
      mutation,
      [
        ['group_id', groupId],
        ['role', role],
        ['actor_device_id', authenticated.device.id],
        ['actor_access_token_id', authenticated.accessTokenId],
      ],
      now,
    );
    const issuer = this.requireActivePairingIssuer(authenticated, now);
    const group = this.requireGroup(groupId);
    this.requireSameGroup(authenticated, group.id);
    this.requireRole(authenticated, 'ADMIN');
    if (issuer.groupId !== group.id || issuer.deviceId !== authenticated.device.id) {
      throw new PairedDeviceRuntimeError(
        'UNAUTHENTICATED',
        'The authenticated access token is invalid or expired.',
      );
    }
    if (claim?.replay !== undefined) this.retireReplacedPairingCode(claim, claim.replay);
    const code = this.createToken('pair');
    const grant: PairingCodeRecord = {
      tokenHash: this.hashToken('pair', code),
      groupId: group.id,
      role,
      expiresAt: new Date(now.getTime() + this.#pairingCodeLifetimeMs),
      createdByDeviceId: authenticated.device.id,
      createdBySessionId: issuer.id,
      createdByAccessTokenId: issuer.accessTokenId,
    };
    this.#pairingCodesByHash.set(grant.tokenHash, grant);
    this.completePairingCodeReceipt(claim, group.id, grant.tokenHash, now);
    return {
      code,
      groupId: group.id,
      role,
      expiresAt: copyDate(grant.expiresAt),
    };
  }

  /**
   * A retry of a pairing-code request cannot return the original code: only its
   * hash was stored. Minting a replacement is the only way to answer, so the
   * code the lost response carried is retired in the same step. Without that,
   * one retry would leave two live capabilities and the operator would know
   * about only one of them.
   */
  private retireReplacedPairingCode(
    claim: MutationReceiptClaim,
    receipt: MutationReceiptRecord,
  ): void {
    if (receipt.fingerprint !== claim.fingerprint) {
      throw new PairedDeviceRuntimeError(
        'ALREADY_EXISTS',
        'The mutation request identifier was already used with a different request payload.',
      );
    }
    const recorded =
      receipt.resourceHash === undefined
        ? undefined
        : this.#pairingCodesByHash.get(receipt.resourceHash);
    if (recorded === undefined) throw replayNoLongerAuthorized();
    if (recorded.consumedAt !== undefined) {
      // The pairing already happened. Minting a second code here would grant a
      // capability the operator never asked for a second time.
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The pairing code created by this request has already been used.',
      );
    }
    recorded.revokedAt ??= this.currentTime();
  }

  private completePairingCodeReceipt(
    claim: MutationReceiptClaim | undefined,
    groupId: string,
    resourceHash: string,
    now: Date,
  ): void {
    if (claim === undefined) return;
    const receipt = this.#receipts.get(claim.key);
    if (receipt === undefined) return;
    receipt.groupId = groupId;
    receipt.resourceHash = resourceHash;
    receipt.completedAt = now;
  }

  pairDevice(input: PairDeviceInput): {
    readonly group: PairedGroup;
    readonly device: PairedDevice;
    readonly session: PairedDeviceSession;
  } {
    const code = requireText(input.pairingCode, 'pairing_code');
    const deviceInput = normalizeDeviceInput(input);
    const now = this.currentTime();
    const claim = this.claimReceipt(
      'PAIR_DEVICE',
      input.mutation,
      [
        ['pairing_code_hash', this.hashToken('pair', code)],
        ['device_name', deviceInput.name],
        ['public_key', deviceInput.publicKey],
        ['platform', deviceInput.platform],
        ['application_version', deviceInput.applicationVersion],
      ],
      now,
    );
    if (claim?.replay !== undefined) {
      // The pairing code was already consumed by this exact request. Replaying
      // the mutation would fail closed and strand a device that holds a
      // membership but never received its credentials.
      return this.replayCreatedLifecycle(claim, claim.replay, now);
    }
    // Public-key availability is checked after the receipt lookup: a retry of a
    // committed pairing legitimately presents the key its own first attempt
    // registered.
    this.ensurePublicKeyAvailable(deviceInput.publicKey);
    const grant = this.#pairingCodesByHash.get(this.hashToken('pair', code));
    if (
      grant === undefined ||
      grant.consumedAt !== undefined ||
      grant.revokedAt !== undefined ||
      grant.expiresAt.getTime() <= now.getTime()
    ) {
      throw new PairedDeviceRuntimeError(
        'UNAUTHENTICATED',
        'The pairing code is invalid, expired, or has already been consumed.',
      );
    }
    const group = this.requireGroup(grant.groupId);
    const creatorMembership = this.#memberships.get(
      membershipKey(group.id, grant.createdByDeviceId),
    );
    const creatorDevice = this.#devicesById.get(grant.createdByDeviceId);
    const issuerSession = this.#sessionsById.get(grant.createdBySessionId);
    if (
      creatorMembership === undefined ||
      creatorMembership.revokedAt !== undefined ||
      creatorDevice === undefined ||
      creatorDevice.status === 'REVOKED' ||
      issuerSession === undefined ||
      issuerSession.groupId !== group.id ||
      issuerSession.deviceId !== grant.createdByDeviceId ||
      issuerSession.revokedAt !== undefined ||
      issuerSession.refreshTokenExpiresAt.getTime() <= now.getTime() ||
      issuerSession.accessTokenExpiresAt.getTime() <= now.getTime() ||
      issuerSession.accessTokenId !== grant.createdByAccessTokenId ||
      this.#sessionsByAccessHash.get(issuerSession.accessTokenHash) !== issuerSession
    ) {
      throw new PairedDeviceRuntimeError(
        'UNAUTHENTICATED',
        'The pairing code is invalid, expired, or has already been consumed.',
      );
    }
    const deviceId = this.createId();
    const device: DeviceRecord = {
      id: deviceId,
      ...deviceInput,
      createdAt: now,
      status: 'ONLINE',
      lastSeenAt: now,
    };
    const membership: MembershipRecord = {
      groupId: group.id,
      deviceId,
      role: grant.role,
      joinedAt: now,
    };
    grant.consumedAt = now;
    this.#devicesById.set(deviceId, device);
    this.#deviceIdByPublicKey.set(device.publicKey, deviceId);
    this.#memberships.set(membershipKey(group.id, deviceId), membership);
    const updatedGroup: PairedGroup = {
      ...group,
      revision: group.revision + 1n,
      updatedAt: now,
    };
    this.#groups.set(updatedGroup.id, updatedGroup);
    const session = this.issueSession(updatedGroup, device, membership, now);
    this.completeReceipt(claim, updatedGroup.id, deviceId, session.record.id, now);
    return {
      group: copyGroup(updatedGroup),
      device: this.toPairedDevice(device, membership),
      session: session.envelope,
    };
  }

  refreshDeviceSession(
    refreshToken: string,
    mutation?: MutationReceiptContext,
  ): PairedDeviceSession {
    const token = requireText(refreshToken, 'refresh_token');
    const refreshTokenHash = this.hashToken('refresh', token);
    const now = this.currentTime();
    const claim = this.claimReceipt(
      'REFRESH_DEVICE_SESSION',
      mutation,
      [['refresh_token_hash', refreshTokenHash]],
      now,
    );
    if (claim?.replay !== undefined) {
      // Without this branch the retry presents an already-rotated token, which
      // the replay detector below would correctly read as an attack and answer
      // by revoking the whole session family.
      return this.reissueSessionCredentials(claim, claim.replay, now);
    }
    const reference = this.#sessionsByRefreshHash.get(refreshTokenHash);
    if (
      reference === undefined ||
      reference.expiresAt.getTime() <= now.getTime() ||
      reference.session.revokedAt !== undefined ||
      reference.session.refreshTokenExpiresAt.getTime() <= now.getTime()
    ) {
      throw new PairedDeviceRuntimeError(
        'UNAUTHENTICATED',
        'The refresh token is invalid or expired.',
      );
    }
    const session = reference.session;
    if (session.refreshTokenHash !== refreshTokenHash) {
      this.revokeSession(session, now);
      throw new PairedDeviceRuntimeError(
        'UNAUTHENTICATED',
        'The refresh token is invalid or expired.',
      );
    }
    const group = this.requireGroup(session.groupId);
    const device = this.requireDevice(session.deviceId);
    const membership = this.requireActiveMembership(group.id, device.id);
    const nextAccessToken = this.createToken('access');
    const nextRefreshToken = this.createToken('refresh');
    const nextAccessTokenHash = this.hashToken('access', nextAccessToken);
    const nextRefreshTokenHash = this.hashToken('refresh', nextRefreshToken);
    const previousRefreshExpiresAt = copyDate(session.refreshTokenExpiresAt);
    this.revokePairingCodesForAccessToken(session.accessTokenId, now);
    this.#sessionsByAccessHash.delete(session.accessTokenHash);
    session.accessTokenId = this.createId();
    session.accessTokenHash = nextAccessTokenHash;
    session.refreshTokenHash = nextRefreshTokenHash;
    session.accessTokenExpiresAt = new Date(now.getTime() + this.#accessTokenLifetimeMs);
    session.refreshTokenExpiresAt = new Date(now.getTime() + this.#refreshTokenLifetimeMs);
    session.issuedAt = now;
    this.#sessionsByAccessHash.set(session.accessTokenHash, session);
    this.#sessionsByRefreshHash.set(refreshTokenHash, {
      session,
      expiresAt: previousRefreshExpiresAt,
    });
    this.#sessionsByRefreshHash.set(session.refreshTokenHash, {
      session,
      expiresAt: copyDate(session.refreshTokenExpiresAt),
    });
    this.completeReceipt(claim, group.id, device.id, session.id, now);
    return this.toSessionEnvelope(session, membership, nextAccessToken, nextRefreshToken);
  }

  authenticateAccessToken(accessToken: string): AuthenticatedDevice {
    const token = requireText(accessToken, 'access token');
    const session = this.#sessionsByAccessHash.get(this.hashToken('access', token));
    const now = this.currentTime();
    if (
      session === undefined ||
      session.revokedAt !== undefined ||
      session.accessTokenExpiresAt.getTime() <= now.getTime()
    ) {
      throw new PairedDeviceRuntimeError(
        'UNAUTHENTICATED',
        'The access token is invalid or expired.',
      );
    }
    const group = this.requireGroup(session.groupId);
    const device = this.requireDevice(session.deviceId);
    const membership = this.requireActiveMembership(group.id, device.id);
    device.lastSeenAt = now;
    return {
      group: copyGroup(group),
      device: this.toPairedDevice(device, membership),
      role: membership.role,
      sessionId: session.id,
      accessTokenId: session.accessTokenId,
    };
  }

  listDevices(
    authenticated: AuthenticatedDevice,
    groupId: string,
    requestedPageSize: number,
    cursor: string,
  ): Page<PairedDevice> {
    const group = this.requireGroup(groupId);
    this.requireSameGroup(authenticated, group.id);
    const pageSize = boundPageSize(requestedPageSize, { defaultPageSize, maxPageSize });
    const members = [...this.#memberships.values()]
      .filter((membership) => membership.groupId === group.id && membership.revokedAt === undefined)
      .sort((left, right) => {
        const leftDevice = this.requireDevice(left.deviceId);
        const rightDevice = this.requireDevice(right.deviceId);
        return (
          leftDevice.createdAt.getTime() - rightDevice.createdAt.getTime() ||
          leftDevice.id.localeCompare(rightDevice.id)
        );
      });
    const startIndex = resolveCursor(members, cursor);
    const selected = members.slice(startIndex, startIndex + pageSize);
    const hasMore = startIndex + selected.length < members.length;
    return {
      items: selected.map((membership) =>
        this.toPairedDevice(this.requireDevice(membership.deviceId), membership),
      ),
      nextCursor: hasMore ? encodeCursor(selected.at(-1)?.deviceId ?? '') : '',
      previousCursor:
        startIndex > 0
          ? encodeCursor(members[Math.max(0, startIndex - pageSize)]?.deviceId ?? '')
          : '',
      hasMore,
      approximateTotal: BigInt(members.length),
    };
  }

  revokeDevice(
    authenticated: AuthenticatedDevice,
    groupId: string,
    deviceId: string,
    mutation?: MutationReceiptContext,
  ): { readonly group: PairedGroup; readonly device: PairedDevice } {
    const claim = this.claimReceipt(
      'REVOKE_DEVICE',
      mutation,
      [
        ['group_id', groupId],
        ['device_id', deviceId],
        ['actor_device_id', authenticated.device.id],
      ],
      this.currentTime(),
    );
    if (claim?.replay !== undefined) return this.replayRevokedDevice(claim, claim.replay);
    const group = this.requireGroup(groupId);
    this.requireSameGroup(authenticated, group.id);
    this.requireRole(authenticated, 'ADMIN');
    if (authenticated.device.id === deviceId) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'An administrator cannot revoke the active device session.',
      );
    }
    const targetDevice = this.requireDevice(deviceId);
    const targetMembership = this.requireActiveMembership(group.id, targetDevice.id);
    const activeAdmins = [...this.#memberships.values()].filter(
      (membership) =>
        membership.groupId === group.id &&
        membership.role === 'ADMIN' &&
        membership.revokedAt === undefined,
    );
    if (group.authorityMode === 'LEADER' && group.leaderDeviceId === targetDevice.id) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'Transfer group leadership before revoking the current leader.',
      );
    }
    if (targetMembership.role === 'ADMIN' && activeAdmins.length === 1) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'A group must retain at least one active administrator.',
      );
    }
    const now = this.currentTime();
    targetMembership.revokedAt = now;
    for (const pairingCode of this.#pairingCodesByHash.values()) {
      if (
        pairingCode.groupId === group.id &&
        pairingCode.createdByDeviceId === targetDevice.id &&
        pairingCode.consumedAt === undefined
      ) {
        pairingCode.revokedAt = now;
      }
    }
    for (const session of this.#sessionsByAccessHash.values()) {
      if (session.groupId === group.id && session.deviceId === targetDevice.id) {
        this.revokeSession(session, now);
      }
    }
    const updatedGroup: PairedGroup = {
      ...group,
      revision: group.revision + 1n,
      updatedAt: now,
    };
    this.#groups.set(group.id, updatedGroup);
    this.completeRevokeReceipt(claim, group.id, targetDevice.id, updatedGroup.revision, now);
    return {
      group: copyGroup(updatedGroup),
      // A device can remain globally online in another group. This result is
      // scoped to the membership just revoked, so expose its lifecycle state.
      device: { ...this.toPairedDevice(targetDevice, targetMembership), status: 'REVOKED' },
    };
  }

  /**
   * A revoke is not naturally idempotent: re-running it bumps the group
   * revision a second time and then fails, because the membership it wants is
   * already gone. The receipt answers with the revision the caller's own
   * mutation produced rather than whatever the group has drifted to since.
   */
  private replayRevokedDevice(
    claim: MutationReceiptClaim,
    receipt: MutationReceiptRecord,
  ): { readonly group: PairedGroup; readonly device: PairedDevice } {
    if (receipt.fingerprint !== claim.fingerprint) {
      throw new PairedDeviceRuntimeError(
        'ALREADY_EXISTS',
        'The mutation request identifier was already used with a different request payload.',
      );
    }
    const { groupId, deviceId, revision } = receipt;
    if (groupId === undefined || deviceId === undefined || revision === undefined) {
      throw replayNoLongerAuthorized();
    }
    const group = this.#groups.get(groupId);
    const device = this.#devicesById.get(deviceId);
    const membership = this.#memberships.get(membershipKey(groupId, deviceId));
    if (group === undefined || device === undefined || membership === undefined) {
      throw replayNoLongerAuthorized();
    }
    return {
      group: { ...copyGroup(group), revision },
      device: { ...this.toPairedDevice(device, membership), status: 'REVOKED' },
    };
  }

  private completeRevokeReceipt(
    claim: MutationReceiptClaim | undefined,
    groupId: string,
    deviceId: string,
    revision: bigint,
    now: Date,
  ): void {
    if (claim === undefined) return;
    const receipt = this.#receipts.get(claim.key);
    if (receipt === undefined) return;
    receipt.groupId = groupId;
    receipt.deviceId = deviceId;
    receipt.revision = revision;
    receipt.completedAt = now;
  }

  assertContextActor(authenticated: AuthenticatedDevice, actorDeviceId: string | undefined): void {
    if (actorDeviceId === undefined || actorDeviceId.length === 0) return;
    if (actorDeviceId !== authenticated.device.id) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'The mutation context actor does not match the authenticated device.',
      );
    }
  }

  /**
   * Claims the idempotency identity of one mutation. An absent request id is
   * the proto3 default for a client that has not opted into retries, so it
   * disables receipt handling and leaves the pre-receipt contract intact.
   *
   * A stored receipt is authoritative only once it is complete. An incomplete
   * one belongs to an attempt that never committed, carries no fingerprint
   * authority, and is therefore overwritten rather than treated as a conflict.
   */
  private claimReceipt(
    scope: MutationScope,
    mutation: MutationReceiptContext | undefined,
    fields: readonly FingerprintField[],
    now: Date,
  ): MutationReceiptClaim | undefined {
    const requestId = normalizeRequestId(mutation?.requestId);
    if (requestId === undefined) return undefined;
    const key = this.hashToken('receipt', encodeRequestIdPayload(scope, requestId));
    const fingerprint = this.hashToken('receipt', encodeFingerprintPayload(scope, fields));
    const stored = this.#receipts.get(key);
    const live =
      stored === undefined || stored.expiresAt.getTime() <= now.getTime() ? undefined : stored;
    if (live?.completedAt !== undefined) return { key, fingerprint, replay: live };
    this.#receipts.set(key, {
      scope,
      fingerprint,
      claimedAt: now,
      expiresAt: new Date(now.getTime() + this.#mutationReceiptLifetimeMs),
    });
    return { key, fingerprint, replay: undefined };
  }

  private completeReceipt(
    claim: MutationReceiptClaim | undefined,
    groupId: string,
    deviceId: string,
    sessionId: string,
    now: Date,
  ): void {
    if (claim === undefined) return;
    const receipt = this.#receipts.get(claim.key);
    if (receipt === undefined) return;
    receipt.groupId = groupId;
    receipt.deviceId = deviceId;
    receipt.sessionId = sessionId;
    receipt.completedAt = now;
  }

  /**
   * A completed receipt stores no response, so a retry is answered by issuing
   * fresh credentials on the recorded session. The client observes the
   * property it needs — the mutation ran exactly once and it now holds usable
   * credentials — while raw tokens stay absent from storage.
   */
  private reissueSessionCredentials(
    claim: MutationReceiptClaim,
    receipt: MutationReceiptRecord,
    now: Date,
  ): PairedDeviceSession {
    const outcome = this.requireReplayableReceipt(claim, receipt);
    const session = this.#sessionsById.get(outcome.sessionId);
    if (session === undefined) throw replayNoLongerAuthorized();
    const membership = this.#memberships.get(membershipKey(session.groupId, session.deviceId));
    const device = this.#devicesById.get(session.deviceId);
    if (
      membership === undefined ||
      device === undefined ||
      membership.revokedAt !== undefined ||
      device.status === 'REVOKED' ||
      session.revokedAt !== undefined ||
      session.refreshTokenExpiresAt.getTime() <= now.getTime()
    ) {
      throw replayNoLongerAuthorized();
    }
    const nextAccessToken = this.createToken('access');
    const nextRefreshToken = this.createToken('refresh');
    const previousRefreshExpiresAt = copyDate(session.refreshTokenExpiresAt);
    const previousRefreshTokenHash = session.refreshTokenHash;
    this.revokePairingCodesForAccessToken(session.accessTokenId, now);
    this.#sessionsByAccessHash.delete(session.accessTokenHash);
    session.accessTokenId = this.createId();
    session.accessTokenHash = this.hashToken('access', nextAccessToken);
    session.refreshTokenHash = this.hashToken('refresh', nextRefreshToken);
    session.accessTokenExpiresAt = new Date(now.getTime() + this.#accessTokenLifetimeMs);
    session.refreshTokenExpiresAt = new Date(now.getTime() + this.#refreshTokenLifetimeMs);
    session.issuedAt = now;
    this.#sessionsByAccessHash.set(session.accessTokenHash, session);
    // The superseded credential stays addressable so a genuine later replay of
    // it is still detected rather than merely rejected as unknown.
    this.#sessionsByRefreshHash.set(previousRefreshTokenHash, {
      session,
      expiresAt: previousRefreshExpiresAt,
    });
    this.#sessionsByRefreshHash.set(session.refreshTokenHash, {
      session,
      expiresAt: copyDate(session.refreshTokenExpiresAt),
    });
    return this.toSessionEnvelope(session, membership, nextAccessToken, nextRefreshToken);
  }

  private replayCreatedLifecycle(
    claim: MutationReceiptClaim,
    receipt: MutationReceiptRecord,
    now: Date,
  ): {
    readonly group: PairedGroup;
    readonly device: PairedDevice;
    readonly session: PairedDeviceSession;
  } {
    const envelope = this.reissueSessionCredentials(claim, receipt, now);
    const group = this.requireGroup(envelope.groupId);
    const device = this.requireDevice(envelope.deviceId);
    const membership = this.requireActiveMembership(group.id, device.id);
    return {
      group: copyGroup(group),
      device: this.toPairedDevice(device, membership),
      session: envelope,
    };
  }

  /**
   * A completed receipt answers only the request that produced it. A request
   * identifier reused with a different payload is a client defect or a
   * deliberate collision attempt, and either way must not inherit another
   * request's credentials.
   */
  private requireReplayableReceipt(
    claim: MutationReceiptClaim,
    receipt: MutationReceiptRecord,
  ): CompletedMutationOutcome {
    if (receipt.fingerprint !== claim.fingerprint) {
      throw new PairedDeviceRuntimeError(
        'ALREADY_EXISTS',
        'The mutation request identifier was already used with a different request payload.',
      );
    }
    const { groupId, deviceId, sessionId } = receipt;
    if (groupId === undefined || deviceId === undefined || sessionId === undefined) {
      throw replayNoLongerAuthorized();
    }
    return { groupId, deviceId, sessionId };
  }

  private issueSession(
    group: PairedGroup,
    device: DeviceRecord,
    membership: MembershipRecord,
    now: Date,
  ): { readonly envelope: PairedDeviceSession; readonly record: SessionRecord } {
    const accessToken = this.createToken('access');
    const refreshToken = this.createToken('refresh');
    const session: SessionRecord = {
      id: this.createId(),
      groupId: group.id,
      deviceId: device.id,
      accessTokenId: this.createId(),
      accessTokenHash: this.hashToken('access', accessToken),
      refreshTokenHash: this.hashToken('refresh', refreshToken),
      issuedAt: now,
      accessTokenExpiresAt: new Date(now.getTime() + this.#accessTokenLifetimeMs),
      refreshTokenExpiresAt: new Date(now.getTime() + this.#refreshTokenLifetimeMs),
    };
    this.#sessionsById.set(session.id, session);
    this.#sessionsByAccessHash.set(session.accessTokenHash, session);
    this.#sessionsByRefreshHash.set(session.refreshTokenHash, {
      session,
      expiresAt: copyDate(session.refreshTokenExpiresAt),
    });
    return {
      envelope: this.toSessionEnvelope(session, membership, accessToken, refreshToken),
      record: session,
    };
  }

  private toSessionEnvelope(
    session: SessionRecord,
    membership: MembershipRecord,
    accessToken: string,
    refreshToken: string,
  ): PairedDeviceSession {
    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: copyDate(session.accessTokenExpiresAt),
      refreshTokenExpiresAt: copyDate(session.refreshTokenExpiresAt),
      deviceId: session.deviceId,
      groupId: session.groupId,
      role: membership.role,
    };
  }

  private revokeSession(session: SessionRecord, now: Date): void {
    session.revokedAt ??= now;
    this.#sessionsByAccessHash.delete(session.accessTokenHash);
    this.revokePairingCodesForSession(session.id, now);
  }

  /**
   * An authenticated context is an internal capability, but it may have gone
   * stale after a refresh, expiry, session revoke, device revoke, or membership
   * revoke. Pairing-code issuance must therefore re-check the exact session and
   * bearer identity rather than trust the previously returned object.
   */
  private requireActivePairingIssuer(authenticated: AuthenticatedDevice, now: Date): SessionRecord {
    const session = this.#sessionsById.get(authenticated.sessionId);
    const membership =
      session === undefined
        ? undefined
        : this.#memberships.get(membershipKey(session.groupId, session.deviceId));
    const device = session === undefined ? undefined : this.#devicesById.get(session.deviceId);
    if (
      session === undefined ||
      membership === undefined ||
      device === undefined ||
      session.groupId !== authenticated.group.id ||
      session.deviceId !== authenticated.device.id ||
      session.accessTokenId !== authenticated.accessTokenId ||
      session.revokedAt !== undefined ||
      session.refreshTokenExpiresAt.getTime() <= now.getTime() ||
      session.accessTokenExpiresAt.getTime() <= now.getTime() ||
      membership.revokedAt !== undefined ||
      membership.role !== authenticated.role ||
      device.status === 'REVOKED' ||
      this.#sessionsByAccessHash.get(session.accessTokenHash) !== session
    ) {
      throw new PairedDeviceRuntimeError(
        'UNAUTHENTICATED',
        'The authenticated access token is invalid or expired.',
      );
    }
    return session;
  }

  private revokePairingCodesForAccessToken(accessTokenId: string, now: Date): void {
    for (const pairingCode of this.#pairingCodesByHash.values()) {
      if (
        pairingCode.createdByAccessTokenId === accessTokenId &&
        pairingCode.consumedAt === undefined
      ) {
        pairingCode.revokedAt ??= now;
      }
    }
  }

  private revokePairingCodesForSession(sessionId: string, now: Date): void {
    for (const pairingCode of this.#pairingCodesByHash.values()) {
      if (pairingCode.createdBySessionId === sessionId && pairingCode.consumedAt === undefined) {
        pairingCode.revokedAt ??= now;
      }
    }
  }

  private requireGroup(groupId: string): PairedGroup {
    const group = this.#groups.get(requireText(groupId, 'group_id'));
    if (group === undefined)
      throw new PairedDeviceRuntimeError('NOT_FOUND', 'The group does not exist.');
    return group;
  }

  private requireDevice(deviceId: string): DeviceRecord {
    const device = this.#devicesById.get(requireText(deviceId, 'device_id'));
    if (device === undefined)
      throw new PairedDeviceRuntimeError('NOT_FOUND', 'The device does not exist.');
    return device;
  }

  private requireActiveMembership(groupId: string, deviceId: string): MembershipRecord {
    const membership = this.#memberships.get(membershipKey(groupId, deviceId));
    if (membership === undefined || membership.revokedAt !== undefined) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'The device is not an active member of this group.',
      );
    }
    return membership;
  }

  private requireSameGroup(authenticated: AuthenticatedDevice, groupId: string): void {
    if (authenticated.group.id !== groupId) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'The authenticated device does not belong to the requested group.',
      );
    }
  }

  private requireRole(authenticated: AuthenticatedDevice, required: DeviceRole): void {
    if (roleWeight(authenticated.role) < roleWeight(required)) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'The authenticated device does not have sufficient group permissions.',
      );
    }
  }

  private ensurePublicKeyAvailable(publicKey: string): void {
    if (this.#deviceIdByPublicKey.has(publicKey)) {
      throw new PairedDeviceRuntimeError(
        'ALREADY_EXISTS',
        'A device with this public key is already registered.',
      );
    }
  }

  private toPairedDevice(device: DeviceRecord, membership: MembershipRecord): PairedDevice {
    return {
      id: device.id,
      name: device.name,
      publicKey: device.publicKey,
      role: membership.role,
      status: device.status,
      platform: device.platform,
      applicationVersion: device.applicationVersion,
      createdAt: copyDate(device.createdAt),
      lastSeenAt: copyDate(device.lastSeenAt),
    };
  }

  private createId(): string {
    const bytes = this.#randomBytes(16);
    if (bytes.length < 16) throw new Error('randomBytes must return at least 16 bytes');
    const now = BigInt(this.currentTime().getTime());
    const uuid = new Uint8Array(16);
    for (let index = 5; index >= 0; index -= 1) {
      uuid[index] = Number((now >> BigInt((5 - index) * 8)) & 0xffn);
    }
    const random0 = bytes[0] ?? 0;
    const random1 = bytes[1] ?? 0;
    const random2 = bytes[2] ?? 0;
    uuid[6] = (random0 & 0x0f) | 0x70;
    uuid[7] = random1;
    uuid[8] = (random2 & 0x3f) | 0x80;
    uuid.set(bytes.slice(3, 10), 9);
    return `${hex(uuid.slice(0, 4))}-${hex(uuid.slice(4, 6))}-${hex(uuid.slice(6, 8))}-${hex(
      uuid.slice(8, 10),
    )}-${hex(uuid.slice(10, 16))}`;
  }

  private createToken(kind: 'access' | 'pair' | 'refresh'): string {
    return `hq_${kind}_${Buffer.from(this.#randomBytes(32)).toString('base64url')}`;
  }

  private hashToken(kind: 'access' | 'pair' | 'receipt' | 'refresh', value: string): string {
    return createHmac('sha256', this.#tokenPepper)
      .update(`v1\u0000${kind}\u0000${value}`)
      .digest('base64url');
  }

  private currentTime(): Date {
    const value = this.#now();
    if (Number.isNaN(value.getTime())) throw new Error('now must return a valid Date');
    return copyDate(value);
  }
}

function normalizeDeviceInput(input: {
  readonly name: string;
  readonly publicKey: string;
  readonly platform: string;
  readonly applicationVersion: string;
}): {
  readonly name: string;
  readonly publicKey: string;
  readonly platform: string;
  readonly applicationVersion: string;
} {
  return {
    name: requireText(input.name, 'device_name'),
    publicKey: requireText(input.publicKey, 'public_key'),
    platform: requireText(input.platform, 'platform'),
    applicationVersion: requireText(input.applicationVersion, 'application_version'),
  };
}

function positiveLifetime(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', `${field} must not be empty.`);
  }
  return normalized;
}

/**
 * A receipt records identity, never authority. Membership, session and device
 * state are re-checked at replay time, so a mutation that was valid when it
 * committed cannot resurrect credentials after a revoke.
 */
function replayNoLongerAuthorized(): PairedDeviceRuntimeError {
  return new PairedDeviceRuntimeError(
    'UNAUTHENTICATED',
    'The recorded mutation can no longer issue credentials.',
  );
}

function membershipKey(groupId: string, deviceId: string): string {
  return `${groupId}:${deviceId}`;
}

function roleWeight(role: DeviceRole): number {
  if (role === 'ADMIN') return 3;
  if (role === 'EDITOR') return 2;
  return 1;
}

function encodeCursor(deviceId: string): string {
  return Buffer.from(deviceId, 'utf8').toString('base64url');
}

function resolveCursor(memberships: readonly MembershipRecord[], cursor: string): number {
  if (cursor.length === 0) return 0;
  let deviceId: string;
  try {
    deviceId = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'The page cursor is invalid.');
  }
  const index = memberships.findIndex((membership) => membership.deviceId === deviceId);
  if (index < 0)
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'The page cursor is invalid.');
  return index + 1;
}

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function copyGroup(group: PairedGroup): PairedGroup {
  return {
    ...group,
    createdAt: copyDate(group.createdAt),
    updatedAt: copyDate(group.updatedAt),
  };
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
