import { createHmac, timingSafeEqual } from 'node:crypto';

import { presign, signHeaders } from './storage/sigv4.js';

export type AuthCredentialKind = 'access' | 'pair' | 'receipt' | 'refresh';

/**
 * The durable authentication migration currently stores HMAC values with this
 * exact domain-version prefix. Do not make it configurable until a deliberate
 * data migration supports more than one stored version.
 */
export type AuthTokenHashVersion = 'v1';

/**
 * Safe-to-pass authentication policy. The environment secrets remain inside
 * closures; neither token pepper nor bootstrap secret is enumerable, serializable,
 * or returned to callers.
 */
export interface ControlPlaneAuthConfig {
  readonly tokenHashVersion: AuthTokenHashVersion;
  readonly accessTokenLifetimeMs: number;
  readonly refreshTokenLifetimeMs: number;
  readonly pairingCodeLifetimeMs: number;
  hashCredential(kind: AuthCredentialKind, credential: string): string;
  verifyBootstrapSecret(candidate: string): boolean;
}

/** A request the storage configuration presigns for a client to send later. */
export interface StoragePresignRequest {
  readonly method: string;
  readonly url: URL;
  readonly signedAt: Date;
}

/** A request the control plane sends the object store itself. */
export interface StorageSignRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers?: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. */
  readonly payloadHash: string;
  readonly signedAt: Date;
}

/**
 * Safe-to-pass object storage policy, built the way {@link ControlPlaneAuthConfig}
 * is: the access key pair lives inside the two signing closures and is not a
 * property, so nothing that receives this object can enumerate, serialize or
 * log it. What is exposed is what an operator may need to read back — where
 * the bucket is and how long a grant lives — and none of it is a credential.
 *
 * The access key *id* does appear inside every presigned URL as
 * `X-Amz-Credential`; that is the protocol, and the id is not a secret.
 */
export interface ControlPlaneStorageConfig {
  /** The service origin, e.g. `https://s3.eu-central-1.amazonaws.com`; no path. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  /** `https://endpoint/bucket/key` rather than `https://bucket.endpoint/key`. */
  readonly forcePathStyle: boolean;
  /** How long an upload, download or preview grant is valid after it is issued. */
  readonly grantTtlMs: number;
  /** Presigns `url` for `grantTtlMs` from `signedAt`, signing the host alone. */
  presign(request: StoragePresignRequest): URL;
  /** Signs a request the control plane sends; returns the complete header set. */
  sign(request: StorageSignRequest): Readonly<Record<string, string>>;
}

export interface ControlPlaneConfig {
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly databaseUrl?: string;
  readonly redis?: {
    readonly restUrl: string;
    readonly restToken: string;
  };
  readonly auth?: ControlPlaneAuthConfig;
  readonly storage?: ControlPlaneStorageConfig;
}

const defaultPort = 4100;
const defaultAccessTokenLifetimeSeconds = 15 * 60;
const defaultRefreshTokenLifetimeSeconds = 30 * 24 * 60 * 60;
const defaultPairingCodeLifetimeSeconds = 10 * 60;
const minimumSecretLength = 32;
const maximumAccessTokenLifetimeSeconds = 24 * 60 * 60;
const minimumRefreshTokenLifetimeSeconds = 60 * 60;
const maximumRefreshTokenLifetimeSeconds = 90 * 24 * 60 * 60;
const maximumPairingCodeLifetimeSeconds = 60 * 60;
/**
 * A grant is a bearer capability on the bucket: whoever holds the URL can use
 * it until it expires, whatever happened to their device session meanwhile.
 * Fifteen minutes is the access-token lifetime, and a grant must not outlive
 * the credential that obtained it, so that is the ceiling as well as the default.
 */
const defaultStorageGrantTtlSeconds = 15 * 60;
const minimumStorageGrantTtlSeconds = 60;
const maximumStorageGrantTtlSeconds = 15 * 60;
const minimumStorageSecretLength = 8;
const storageService = 's3';

const authEnvironmentVariableNames = [
  'HQ_CONTROL_PLANE_AUTH_TOKEN_PEPPER',
  'HQ_CONTROL_PLANE_BOOTSTRAP_SECRET',
  'HQ_CONTROL_PLANE_AUTH_TOKEN_HASH_VERSION',
  'HQ_CONTROL_PLANE_AUTH_ACCESS_TOKEN_TTL_SECONDS',
  'HQ_CONTROL_PLANE_AUTH_REFRESH_TOKEN_TTL_SECONDS',
  'HQ_CONTROL_PLANE_AUTH_PAIRING_CODE_TTL_SECONDS',
] as const;

const storageEnvironmentVariableNames = [
  'HQ_CONTROL_PLANE_STORAGE_ENDPOINT',
  'HQ_CONTROL_PLANE_STORAGE_REGION',
  'HQ_CONTROL_PLANE_STORAGE_BUCKET',
  'HQ_CONTROL_PLANE_STORAGE_ACCESS_KEY_ID',
  'HQ_CONTROL_PLANE_STORAGE_SECRET_ACCESS_KEY',
  'HQ_CONTROL_PLANE_STORAGE_FORCE_PATH_STYLE',
  'HQ_CONTROL_PLANE_STORAGE_GRANT_TTL_SECONDS',
] as const;

const requiredStorageEnvironmentVariableNames = [
  'HQ_CONTROL_PLANE_STORAGE_ENDPOINT',
  'HQ_CONTROL_PLANE_STORAGE_REGION',
  'HQ_CONTROL_PLANE_STORAGE_BUCKET',
  'HQ_CONTROL_PLANE_STORAGE_ACCESS_KEY_ID',
  'HQ_CONTROL_PLANE_STORAGE_SECRET_ACCESS_KEY',
] as const;

export function loadControlPlaneConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ControlPlaneConfig {
  const port = parsePort(environment.HQ_CONTROL_PLANE_PORT);
  const allowedOrigins = parseOrigins(environment.HQ_CONTROL_PLANE_ALLOWED_ORIGINS);
  const databaseUrl = parseDatabaseUrl(environment.HQ_CONTROL_PLANE_DATABASE_URL);
  const redis = parseRedis(
    environment.HQ_CONTROL_PLANE_REDIS_REST_URL,
    environment.HQ_CONTROL_PLANE_REDIS_REST_TOKEN,
  );
  const auth = parseAuth(environment, databaseUrl);
  const storage = parseStorage(environment);
  return {
    port,
    allowedOrigins,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(redis === undefined ? {} : { redis }),
    ...(auth === undefined ? {} : { auth }),
    ...(storage === undefined ? {} : { storage }),
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.length === 0) return defaultPort;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('HQ_CONTROL_PLANE_PORT must be an integer between 0 and 65535');
  }
  return port;
}

function parseOrigins(value: string | undefined): readonly string[] {
  const origins = (value ?? 'http://127.0.0.1:3000,http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map(normalizeOrigin);
  if (origins.length === 0) {
    throw new Error('HQ_CONTROL_PLANE_ALLOWED_ORIGINS must contain at least one origin');
  }
  return [...new Set(origins)];
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) {
    throw new Error(`Invalid control-plane origin: ${value}`);
  }
  return url.origin;
}

function parseDatabaseUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname.length === 0) {
    throw new Error('HQ_CONTROL_PLANE_DATABASE_URL must be a PostgreSQL connection URL');
  }
  return value;
}

function parseRedis(
  restUrl: string | undefined,
  restToken: string | undefined,
): ControlPlaneConfig['redis'] {
  const hasUrl = restUrl !== undefined && restUrl.trim().length > 0;
  const hasToken = restToken !== undefined && restToken.trim().length > 0;
  if (!hasUrl && !hasToken) return undefined;
  if (!hasUrl || !hasToken) {
    throw new Error(
      'HQ_CONTROL_PLANE_REDIS_REST_URL and HQ_CONTROL_PLANE_REDIS_REST_TOKEN must be set together',
    );
  }
  const url = new URL(restUrl);
  if (url.protocol !== 'https:' || url.hostname.length === 0) {
    throw new Error('HQ_CONTROL_PLANE_REDIS_REST_URL must be an HTTPS Upstash REST URL');
  }
  // Trimmed on the way out, not only on the way in: the presence checks above
  // read the trimmed value, so a token written as `"  x  "` passed them and then
  // reached Upstash with its padding, failing authentication with no hint why.
  return { restUrl: restUrl.trim(), restToken: restToken.trim() };
}

function parseAuth(
  environment: Readonly<Record<string, string | undefined>>,
  databaseUrl: string | undefined,
): ControlPlaneAuthConfig | undefined {
  if (!authEnvironmentVariableNames.some((name) => environment[name] !== undefined)) {
    return undefined;
  }
  if (databaseUrl === undefined) {
    throw new Error(
      'HQ_CONTROL_PLANE_DATABASE_URL is required when control-plane authentication is configured',
    );
  }

  const tokenPepper = requireSecret(
    environment.HQ_CONTROL_PLANE_AUTH_TOKEN_PEPPER,
    'HQ_CONTROL_PLANE_AUTH_TOKEN_PEPPER',
  );
  const bootstrapSecret = requireSecret(
    environment.HQ_CONTROL_PLANE_BOOTSTRAP_SECRET,
    'HQ_CONTROL_PLANE_BOOTSTRAP_SECRET',
  );
  const tokenHashVersion = parseTokenHashVersion(
    environment.HQ_CONTROL_PLANE_AUTH_TOKEN_HASH_VERSION,
  );
  const accessTokenLifetimeSeconds = parseLifetimeSeconds(
    environment.HQ_CONTROL_PLANE_AUTH_ACCESS_TOKEN_TTL_SECONDS,
    'HQ_CONTROL_PLANE_AUTH_ACCESS_TOKEN_TTL_SECONDS',
    defaultAccessTokenLifetimeSeconds,
    60,
    maximumAccessTokenLifetimeSeconds,
  );
  const refreshTokenLifetimeSeconds = parseLifetimeSeconds(
    environment.HQ_CONTROL_PLANE_AUTH_REFRESH_TOKEN_TTL_SECONDS,
    'HQ_CONTROL_PLANE_AUTH_REFRESH_TOKEN_TTL_SECONDS',
    defaultRefreshTokenLifetimeSeconds,
    minimumRefreshTokenLifetimeSeconds,
    maximumRefreshTokenLifetimeSeconds,
  );
  const pairingCodeLifetimeSeconds = parseLifetimeSeconds(
    environment.HQ_CONTROL_PLANE_AUTH_PAIRING_CODE_TTL_SECONDS,
    'HQ_CONTROL_PLANE_AUTH_PAIRING_CODE_TTL_SECONDS',
    defaultPairingCodeLifetimeSeconds,
    60,
    maximumPairingCodeLifetimeSeconds,
  );
  if (refreshTokenLifetimeSeconds <= accessTokenLifetimeSeconds) {
    throw new Error(
      'HQ_CONTROL_PLANE_AUTH_REFRESH_TOKEN_TTL_SECONDS must be greater than HQ_CONTROL_PLANE_AUTH_ACCESS_TOKEN_TTL_SECONDS',
    );
  }

  return createAuthConfig({
    tokenPepper,
    bootstrapSecret,
    tokenHashVersion,
    accessTokenLifetimeMs: secondsToMilliseconds(accessTokenLifetimeSeconds),
    refreshTokenLifetimeMs: secondsToMilliseconds(refreshTokenLifetimeSeconds),
    pairingCodeLifetimeMs: secondsToMilliseconds(pairingCodeLifetimeSeconds),
  });
}

function requireSecret(value: string | undefined, name: string): string {
  if (value === undefined || value.replace(/\s/gu, '').length < minimumSecretLength) {
    throw new Error(
      `${name} must contain at least ${minimumSecretLength} non-whitespace characters`,
    );
  }
  return value;
}

function parseTokenHashVersion(value: string | undefined): AuthTokenHashVersion {
  if (value === undefined) return 'v1';
  if (value !== 'v1') {
    throw new Error('HQ_CONTROL_PLANE_AUTH_TOKEN_HASH_VERSION must be exactly v1');
  }
  return 'v1';
}

function parseLifetimeSeconds(
  value: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`${name} must be an integer number of seconds`);
  }
  const seconds = Number(normalized);
  if (!Number.isSafeInteger(seconds) || seconds < minimum || seconds > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum} seconds`);
  }
  return seconds;
}

function secondsToMilliseconds(seconds: number): number {
  return seconds * 1000;
}

function createAuthConfig(input: {
  readonly tokenPepper: string;
  readonly bootstrapSecret: string;
  readonly tokenHashVersion: AuthTokenHashVersion;
  readonly accessTokenLifetimeMs: number;
  readonly refreshTokenLifetimeMs: number;
  readonly pairingCodeLifetimeMs: number;
}): ControlPlaneAuthConfig {
  const expectedBootstrapDigest = bootstrapDigest(input.bootstrapSecret);
  return Object.freeze({
    tokenHashVersion: input.tokenHashVersion,
    accessTokenLifetimeMs: input.accessTokenLifetimeMs,
    refreshTokenLifetimeMs: input.refreshTokenLifetimeMs,
    pairingCodeLifetimeMs: input.pairingCodeLifetimeMs,
    hashCredential(kind: AuthCredentialKind, credential: string): string {
      if (credential.length === 0) throw new Error('Credential value must not be empty');
      return createHmac('sha256', input.tokenPepper)
        .update(`${input.tokenHashVersion}\u0000${credentialDomain(kind)}\u0000${credential}`)
        .digest('base64url');
    },
    verifyBootstrapSecret(candidate: string): boolean {
      return timingSafeEqual(expectedBootstrapDigest, bootstrapDigest(candidate));
    },
  });
}

function bootstrapDigest(secret: string): Buffer {
  return createHmac('sha256', 'gremuchaya-control-plane-bootstrap-v1').update(secret).digest();
}

/**
 * Object storage is all-or-nothing like Redis: one variable of the group set
 * means the whole group is meant, and a missing member is named rather than
 * defaulted. Unlike auth it is not tied to the database URL — a health-only
 * process simply never constructs the issuer — so the reduced mode stays
 * reachable with any subset of the other groups.
 */
function parseStorage(
  environment: Readonly<Record<string, string | undefined>>,
): ControlPlaneStorageConfig | undefined {
  if (!storageEnvironmentVariableNames.some((name) => isPresent(environment[name]))) {
    return undefined;
  }
  const missing = requiredStorageEnvironmentVariableNames.filter(
    (name) => !isPresent(environment[name]),
  );
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(', ')} must be set when object storage is configured: ` +
        'HQ_CONTROL_PLANE_STORAGE_ENDPOINT, HQ_CONTROL_PLANE_STORAGE_REGION, ' +
        'HQ_CONTROL_PLANE_STORAGE_BUCKET, HQ_CONTROL_PLANE_STORAGE_ACCESS_KEY_ID and ' +
        'HQ_CONTROL_PLANE_STORAGE_SECRET_ACCESS_KEY are set together',
    );
  }

  const endpoint = parseStorageEndpoint(environment.HQ_CONTROL_PLANE_STORAGE_ENDPOINT ?? '');
  const region = parseStorageRegion(environment.HQ_CONTROL_PLANE_STORAGE_REGION ?? '');
  const bucket = parseStorageBucket(environment.HQ_CONTROL_PLANE_STORAGE_BUCKET ?? '');
  const accessKeyId = requireStorageKey(
    environment.HQ_CONTROL_PLANE_STORAGE_ACCESS_KEY_ID,
    'HQ_CONTROL_PLANE_STORAGE_ACCESS_KEY_ID',
    1,
  );
  const secretAccessKey = requireStorageKey(
    environment.HQ_CONTROL_PLANE_STORAGE_SECRET_ACCESS_KEY,
    'HQ_CONTROL_PLANE_STORAGE_SECRET_ACCESS_KEY',
    minimumStorageSecretLength,
  );
  const forcePathStyle = parseBoolean(
    environment.HQ_CONTROL_PLANE_STORAGE_FORCE_PATH_STYLE,
    'HQ_CONTROL_PLANE_STORAGE_FORCE_PATH_STYLE',
  );
  const grantTtlSeconds = parseLifetimeSeconds(
    environment.HQ_CONTROL_PLANE_STORAGE_GRANT_TTL_SECONDS,
    'HQ_CONTROL_PLANE_STORAGE_GRANT_TTL_SECONDS',
    defaultStorageGrantTtlSeconds,
    minimumStorageGrantTtlSeconds,
    maximumStorageGrantTtlSeconds,
  );

  return createStorageConfig({
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
    grantTtlMs: secondsToMilliseconds(grantTtlSeconds),
  });
}

/**
 * HTTPS, or plain HTTP to the loopback interface only. A presigned URL carries
 * a signature that any observer of a cleartext request could replay for the
 * grant's lifetime, so the one exception is a MinIO on the developer's own
 * machine, where there is no network to observe.
 */
function parseStorageEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('HQ_CONTROL_PLANE_STORAGE_ENDPOINT must be an absolute URL');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(
      'HQ_CONTROL_PLANE_STORAGE_ENDPOINT must be an HTTPS URL; http is accepted only for 127.0.0.1, localhost or [::1]',
    );
  }
  if (url.hostname.length === 0 || url.username.length > 0 || url.password.length > 0) {
    throw new Error('HQ_CONTROL_PLANE_STORAGE_ENDPOINT must name a host and carry no credentials');
  }
  if (
    (url.pathname !== '/' && url.pathname.length > 0) ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      'HQ_CONTROL_PLANE_STORAGE_ENDPOINT must be the service origin alone, without a path, query or fragment',
    );
  }
  return url.origin;
}

function parseStorageRegion(value: string): string {
  const region = value.trim();
  if (!/^[a-z0-9-]{1,32}$/u.test(region)) {
    throw new Error(
      'HQ_CONTROL_PLANE_STORAGE_REGION must be 1 to 32 lowercase letters, digits or hyphens',
    );
  }
  return region;
}

/** The S3 bucket naming rules, which every compatible store enforces or relaxes. */
function parseStorageBucket(value: string): string {
  const bucket = value.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) || bucket.includes('..')) {
    throw new Error(
      'HQ_CONTROL_PLANE_STORAGE_BUCKET must be 3 to 63 lowercase letters, digits, dots or hyphens, starting and ending with a letter or digit',
    );
  }
  return bucket;
}

function requireStorageKey(value: string | undefined, name: string, minimumLength: number): string {
  const key = value?.trim() ?? '';
  if (key.length < minimumLength || /\s/u.test(key)) {
    throw new Error(
      `${name} must contain at least ${minimumLength.toString()} characters and no whitespace`,
    );
  }
  return key;
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim().length === 0) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`${name} must be true or false`);
}

function isPresent(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function createStorageConfig(input: {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
  readonly grantTtlMs: number;
}): ControlPlaneStorageConfig {
  // Both keys are captured here and nowhere else. The AWS SigV4 algorithm,
  // implemented in ./storage/sigv4.ts, receives them as arguments on each call
  // and keeps nothing between calls.
  const credentials = { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey };
  const scope = { region: input.region, service: storageService };
  const expiresInSeconds = Math.trunc(input.grantTtlMs / 1000);
  return Object.freeze({
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    forcePathStyle: input.forcePathStyle,
    grantTtlMs: input.grantTtlMs,
    presign(request: StoragePresignRequest): URL {
      return presign({
        credentials,
        scope,
        method: request.method,
        url: request.url,
        signedAt: request.signedAt,
        expiresInSeconds,
      });
    },
    sign(request: StorageSignRequest): Readonly<Record<string, string>> {
      return signHeaders({
        credentials,
        scope,
        method: request.method,
        url: request.url,
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        payloadHash: request.payloadHash,
        signedAt: request.signedAt,
      });
    },
  });
}

function credentialDomain(kind: AuthCredentialKind): AuthCredentialKind {
  if (kind === 'access' || kind === 'pair' || kind === 'receipt' || kind === 'refresh') {
    return kind;
  }
  throw new Error('Unsupported credential kind');
}
