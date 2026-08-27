import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

import type { SqlDriverName } from './db/database.js';
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
  /**
   * The interface the RPC and realtime server binds to.
   *
   * `127.0.0.1` by default, so an existing deployment keeps answering exactly
   * where it did. It is configurable because the shoot-day topology this
   * project's own project schema describes is one machine serving the others
   * over the set's LAN, and a loopback bind makes that topology unreachable
   * from any other machine -- with no error anywhere, because the server is
   * serving perfectly to the one client that shares its network namespace.
   */
  readonly host: string;
  readonly allowedOrigins: readonly string[];
  /**
   * Whether auth-configured startup applies the schema migrations itself.
   *
   * `true` — and absent means `true` — so a long-lived process keeps the
   * behaviour it has always had: the migration transaction completes before a
   * single RPC is served. A serverless deployment sets it `false` and runs
   * `pnpm --filter @gremuchaya/control-plane migrate` as a build step instead,
   * because there every cold start would otherwise open the same
   * `pg_advisory_xact_lock` transaction, and cold starts are frequent and
   * concurrent. Setting it `false` without running that step leaves the
   * process serving against whatever schema the database happens to have.
   */
  readonly runMigrationsOnStart?: boolean;
  readonly databaseUrl?: string;
  /**
   * Which driver reaches {@link databaseUrl}, when the operator has said.
   *
   * Absent means the driver this package has always used, and `sqlClientFactoryFor`
   * resolves it: a deployment that sets nothing gets the Neon HTTP driver and
   * behaves exactly as it did before the TCP driver existed. It is optional for
   * the same reason `databaseUrl`, `redis`, `auth` and `storage` are -- the
   * configuration object says what an operator configured, not what the
   * defaults are.
   */
  readonly databaseDriver?: SqlDriverName;
  readonly redis?: {
    readonly restUrl: string;
    readonly restToken: string;
  };
  readonly auth?: ControlPlaneAuthConfig;
  readonly storage?: ControlPlaneStorageConfig;
}

const defaultPort = 4100;
/**
 * Loopback, so that widening the bind is a deliberate act an operator writes
 * down rather than something a version bump does to a machine on its own.
 */
const defaultHost = '127.0.0.1';
/**
 * The origins a browser client may present.
 *
 * The two development addresses, and the two a packaged Tauri build sends: a
 * WebView2 shell serving a static export requests with `Origin:
 * http://tauri.localhost`, and the HTTPS form on the platforms that use it.
 * Without them `prepareRpcResponse` answers the packaged desktop's own control
 * plane with a flat 403 -- on the same machine, over loopback -- and the
 * failure looks like a control plane that is down. The same four addresses the
 * native media gateway allows (`apps/hq/src-tauri/src/media_gateway.rs`,
 * `allowed_origin`), so the two allowlists say one thing.
 */
const defaultAllowedOrigins =
  'http://127.0.0.1:3000,http://localhost:3000,http://tauri.localhost,https://tauri.localhost';
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

/**
 * The naming schemes a Redis REST pair may arrive under, in the order they are
 * preferred.
 *
 * `HQ_CONTROL_PLANE_REDIS_REST_URL`/`_TOKEN` are this project's own names and
 * always win. `KV_REST_API_URL`/`KV_REST_API_TOKEN` are the names the Vercel
 * Upstash Marketplace integration writes into a project's Production and
 * Preview environments: the platform cannot alias one variable onto another,
 * and copying a live token by hand into a second variable is the manual
 * credential handling this repository avoids everywhere else.
 *
 * Only those two are a REST pair. The same integration also writes `KV_URL` and
 * `REDIS_URL`, which are `rediss://` connection strings for a TCP client rather
 * than an HTTPS REST endpoint, and `KV_REST_API_READ_ONLY_TOKEN`, which cannot
 * write a liveness key or a rate-limit counter. None of the three is read here,
 * so their presence alone leaves the control plane in its no-Redis branch
 * rather than half-configuring coordination that would fail on first use.
 */
const redisEnvironmentSchemes = [
  { url: 'HQ_CONTROL_PLANE_REDIS_REST_URL', token: 'HQ_CONTROL_PLANE_REDIS_REST_TOKEN' },
  { url: 'KV_REST_API_URL', token: 'KV_REST_API_TOKEN' },
] as const;

export function loadControlPlaneConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ControlPlaneConfig {
  const port = parsePort(environment.HQ_CONTROL_PLANE_PORT);
  const host = parseHost(environment.HQ_CONTROL_PLANE_HOST);
  const allowedOrigins = parseOrigins(environment.HQ_CONTROL_PLANE_ALLOWED_ORIGINS);
  const databaseUrl = parseDatabaseUrl(environment.HQ_CONTROL_PLANE_DATABASE_URL);
  const databaseDriver = parseDatabaseDriver(environment.HQ_CONTROL_PLANE_DATABASE_DRIVER);
  const redis = parseRedis(environment);
  const auth = parseAuth(environment, databaseUrl);
  const storage = parseStorage(environment);
  const runMigrationsOnStart = parseRunMigrationsOnStart(
    environment.HQ_CONTROL_PLANE_RUN_MIGRATIONS_ON_START,
  );
  return {
    port,
    host,
    allowedOrigins,
    runMigrationsOnStart,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(databaseDriver === undefined ? {} : { databaseDriver }),
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

/**
 * The bind address, as `net.Server.listen` takes it.
 *
 * IP literals are checked by `node:net`'s own `isIP` rather than by a regex
 * written here, so `0.0.0.0`, `::` and `::1` are accepted for exactly the
 * reason the runtime accepts them. A bracketed IPv6 literal is unwrapped
 * because that is the form an operator copies out of a URL, and `listen`
 * refuses it. Anything else must look like a DNS name; a value carrying a
 * scheme, a port or a path is a URL written where an address belongs and is
 * named as such rather than passed on to fail at `listen` with no context.
 */
function parseHost(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) return defaultHost;
  const trimmed = value.trim();
  const host = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  if (isIP(host) !== 0) return host;
  if (/^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/u.test(host)) {
    return host;
  }
  throw new Error(
    'HQ_CONTROL_PLANE_HOST must be an IPv4 address, an IPv6 address or a hostname, without a scheme or port',
  );
}

/**
 * Defaults to `true`, unlike {@link parseBoolean}, because an unset variable
 * must leave every existing deployment running migrations exactly as it did.
 * Only an explicit `false` moves them to a build step.
 */
function parseRunMigrationsOnStart(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return true;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error('HQ_CONTROL_PLANE_RUN_MIGRATIONS_ON_START must be true or false');
}

function parseOrigins(value: string | undefined): readonly string[] {
  const origins = (value ?? defaultAllowedOrigins)
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

/**
 * The driver name, or `undefined` when the operator left the choice alone.
 *
 * An unrecognised value is refused rather than treated as the default. The two
 * drivers differ in what they need from the network -- one an open route to the
 * public internet, the other a route to one machine -- so a typo silently
 * resolving to `neon` would produce a control plane that works in the office and
 * has no database at all on the set, which is the failure this whole stage
 * exists to remove.
 */
function parseDatabaseDriver(value: string | undefined): SqlDriverName | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const driver = value.trim().toLowerCase();
  if (driver !== 'neon' && driver !== 'postgres') {
    throw new Error("HQ_CONTROL_PLANE_DATABASE_DRIVER must be 'neon' or 'postgres'");
  }
  return driver;
}

/**
 * The Redis REST pair, taken whole from one scheme in
 * {@link redisEnvironmentSchemes} or from none at all.
 *
 * A scheme is selected by *either* of its two names being set, and the other
 * scheme is never consulted to complete it. The two schemes can name two
 * different Redis instances -- the one a marketplace integration provisioned and
 * whatever an operator pointed the HQ_* names at -- so completing a half-written
 * pair from the other scheme would pair a URL with a token minted elsewhere. That
 * either authenticates nowhere or, on a second instance the same token happens to
 * open, coordinates presence and rate limits against a database nobody chose,
 * and neither failure names itself at startup. A split pair is a misconfiguration
 * with two readings, so it is refused by naming the scheme that was selected and
 * the half that is missing; half a deliberately-written scheme must not silently
 * become the other scheme either.
 *
 * Absent both, this returns `undefined`, which is what selects the no-Redis
 * branch in `configured-lifecycle.ts` and what `Health` reports as unconfigured.
 */
function parseRedis(
  environment: Readonly<Record<string, string | undefined>>,
): ControlPlaneConfig['redis'] {
  const scheme = redisEnvironmentSchemes.find(
    (candidate) => isPresent(environment[candidate.url]) || isPresent(environment[candidate.token]),
  );
  if (scheme === undefined) return undefined;
  const suppliedUrl = environment[scheme.url];
  const suppliedToken = environment[scheme.token];
  if (!isPresent(suppliedUrl) || !isPresent(suppliedToken)) {
    throw new Error(`${scheme.url} and ${scheme.token} must be set together`);
  }
  // Trimmed before validation and before the return, not only for the presence
  // checks: those read a trimmed value, so a token written as `"  x  "` passed
  // them and then reached Upstash with its padding, failing authentication with
  // no hint why.
  const restUrl = suppliedUrl.trim();
  const restToken = suppliedToken.trim();
  // Guarded like parseStorageEndpoint: an unparseable value must not reach
  // `new URL` unhandled, because Node attaches the raw input to the TypeError
  // and a transposed pair would print the live token into the deployment log.
  let url: URL;
  try {
    url = new URL(restUrl);
  } catch {
    throw new Error(`${scheme.url} must be an HTTPS Upstash REST URL`);
  }
  if (url.protocol !== 'https:' || url.hostname.length === 0) {
    throw new Error(`${scheme.url} must be an HTTPS Upstash REST URL`);
  }
  return { restUrl, restToken };
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

/**
 * A type predicate rather than a plain boolean, so that a caller which has just
 * established a value is set can go on to trim and parse it without a second,
 * differently-written check standing in for the same question.
 */
function isPresent(value: string | undefined): value is string {
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
