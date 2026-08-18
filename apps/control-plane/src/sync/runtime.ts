import { createHmac, randomBytes as nodeRandomBytes } from 'node:crypto';

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
}

export interface CreateGroupInput {
  readonly name: string;
  readonly initialDevice: {
    readonly name: string;
    readonly publicKey: string;
    readonly platform: string;
    readonly applicationVersion: string;
  };
}

export interface PairDeviceInput {
  readonly pairingCode: string;
  readonly name: string;
  readonly publicKey: string;
  readonly platform: string;
  readonly applicationVersion: string;
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
  consumedAt?: Date;
  revokedAt?: Date;
}

interface SessionRecord {
  readonly id: string;
  readonly groupId: string;
  readonly deviceId: string;
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

const defaultAccessTokenLifetimeMs = 15 * 60 * 1000;
const defaultRefreshTokenLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const defaultPairingCodeLifetimeMs = 10 * 60 * 1000;
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
  readonly #sessionsByAccessHash = new Map<string, SessionRecord>();
  readonly #sessionsByRefreshHash = new Map<string, RefreshTokenReference>();
  readonly #now: () => Date;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #accessTokenLifetimeMs: number;
  readonly #refreshTokenLifetimeMs: number;
  readonly #pairingCodeLifetimeMs: number;
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
  }

  createGroup(input: CreateGroupInput): {
    readonly group: PairedGroup;
    readonly device: PairedDevice;
    readonly session: PairedDeviceSession;
  } {
    const now = this.currentTime();
    const groupName = requireText(input.name, 'name');
    const initialDevice = normalizeDeviceInput(input.initialDevice);
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
    return { group: copyGroup(group), device: this.toPairedDevice(device, membership), session };
  }

  createPairingCode(
    authenticated: AuthenticatedDevice,
    groupId: string,
    role: Exclude<DeviceRole, 'ADMIN'>,
  ): PairingCodeGrant {
    const group = this.requireGroup(groupId);
    this.requireSameGroup(authenticated, group.id);
    this.requireRole(authenticated, 'ADMIN');
    const now = this.currentTime();
    const code = this.createToken('pair');
    const grant: PairingCodeRecord = {
      tokenHash: this.hashToken('pair', code),
      groupId: group.id,
      role,
      expiresAt: new Date(now.getTime() + this.#pairingCodeLifetimeMs),
      createdByDeviceId: authenticated.device.id,
    };
    this.#pairingCodesByHash.set(grant.tokenHash, grant);
    return {
      code,
      groupId: group.id,
      role,
      expiresAt: copyDate(grant.expiresAt),
    };
  }

  pairDevice(input: PairDeviceInput): {
    readonly group: PairedGroup;
    readonly device: PairedDevice;
    readonly session: PairedDeviceSession;
  } {
    const code = requireText(input.pairingCode, 'pairing_code');
    const deviceInput = normalizeDeviceInput(input);
    this.ensurePublicKeyAvailable(deviceInput.publicKey);
    const now = this.currentTime();
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
    if (
      creatorMembership === undefined ||
      creatorMembership.revokedAt !== undefined ||
      creatorDevice === undefined ||
      creatorDevice.status === 'REVOKED'
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
    return {
      group: copyGroup(updatedGroup),
      device: this.toPairedDevice(device, membership),
      session,
    };
  }

  refreshDeviceSession(refreshToken: string): PairedDeviceSession {
    const token = requireText(refreshToken, 'refresh_token');
    const refreshTokenHash = this.hashToken('refresh', token);
    const reference = this.#sessionsByRefreshHash.get(refreshTokenHash);
    const now = this.currentTime();
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
    this.#sessionsByAccessHash.delete(session.accessTokenHash);
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
    const pageSize = normalizePageSize(requestedPageSize);
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
  ): { readonly group: PairedGroup; readonly device: PairedDevice } {
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
    return {
      group: copyGroup(updatedGroup),
      // A device can remain globally online in another group. This result is
      // scoped to the membership just revoked, so expose its lifecycle state.
      device: { ...this.toPairedDevice(targetDevice, targetMembership), status: 'REVOKED' },
    };
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

  private issueSession(
    group: PairedGroup,
    device: DeviceRecord,
    membership: MembershipRecord,
    now: Date,
  ): PairedDeviceSession {
    const accessToken = this.createToken('access');
    const refreshToken = this.createToken('refresh');
    const session: SessionRecord = {
      id: this.createId(),
      groupId: group.id,
      deviceId: device.id,
      accessTokenHash: this.hashToken('access', accessToken),
      refreshTokenHash: this.hashToken('refresh', refreshToken),
      issuedAt: now,
      accessTokenExpiresAt: new Date(now.getTime() + this.#accessTokenLifetimeMs),
      refreshTokenExpiresAt: new Date(now.getTime() + this.#refreshTokenLifetimeMs),
    };
    this.#sessionsByAccessHash.set(session.accessTokenHash, session);
    this.#sessionsByRefreshHash.set(session.refreshTokenHash, {
      session,
      expiresAt: copyDate(session.refreshTokenExpiresAt),
    });
    return this.toSessionEnvelope(session, membership, accessToken, refreshToken);
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

  private hashToken(kind: 'access' | 'pair' | 'refresh', value: string): string {
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

function normalizePageSize(requestedPageSize: number): number {
  if (requestedPageSize === 0) return defaultPageSize;
  if (
    !Number.isSafeInteger(requestedPageSize) ||
    requestedPageSize < 1 ||
    requestedPageSize > maxPageSize
  ) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `page_size must be between 1 and ${maxPageSize}.`,
    );
  }
  return requestedPageSize;
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
