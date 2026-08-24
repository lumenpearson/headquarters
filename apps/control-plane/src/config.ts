import { createHmac, timingSafeEqual } from 'node:crypto';

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

export interface ControlPlaneConfig {
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly databaseUrl?: string;
  readonly redis?: {
    readonly restUrl: string;
    readonly restToken: string;
  };
  readonly auth?: ControlPlaneAuthConfig;
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

const authEnvironmentVariableNames = [
  'HQ_CONTROL_PLANE_AUTH_TOKEN_PEPPER',
  'HQ_CONTROL_PLANE_BOOTSTRAP_SECRET',
  'HQ_CONTROL_PLANE_AUTH_TOKEN_HASH_VERSION',
  'HQ_CONTROL_PLANE_AUTH_ACCESS_TOKEN_TTL_SECONDS',
  'HQ_CONTROL_PLANE_AUTH_REFRESH_TOKEN_TTL_SECONDS',
  'HQ_CONTROL_PLANE_AUTH_PAIRING_CODE_TTL_SECONDS',
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
  return {
    port,
    allowedOrigins,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(redis === undefined ? {} : { redis }),
    ...(auth === undefined ? {} : { auth }),
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

function credentialDomain(kind: AuthCredentialKind): AuthCredentialKind {
  if (kind === 'access' || kind === 'pair' || kind === 'receipt' || kind === 'refresh') {
    return kind;
  }
  throw new Error('Unsupported credential kind');
}
