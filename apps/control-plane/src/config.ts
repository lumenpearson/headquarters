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

/** One client upload token, minted for exactly one object and one window. */
export interface BlobClientTokenRequest {
  /** The object's pathname in the store, which is this deployment's storage key. */
  readonly pathname: string;
  readonly contentType: string;
  /** The largest body the token may be spent on; the store's own second bound. */
  readonly maximumSizeInBytes: bigint;
  /** When the token stops being accepted, which is also when the grant expires. */
  readonly validUntil: Date;
}

/**
 * Safe-to-pass Vercel Blob policy, the second object-storage shape.
 *
 * It is a separate interface from {@link ControlPlaneStorageConfig} rather than
 * a variant of it because almost nothing is shared: there is no region, no
 * bucket, no access key pair and no SigV4 signature. A Blob upload is signed
 * *on the client*, with a token this deployment mints from its read-write
 * token, which is the opposite of the presigned-URL design the S3 issuer is
 * built on.
 *
 * The read-write token stays inside the two closures and is not a property, so
 * nothing that receives this object can enumerate, serialize or log it. The
 * store id is exposed because it is in every public URL the store serves and is
 * not a secret.
 */
export interface ControlPlaneBlobStorageConfig {
  /** The Blob API origin; every call to it carries the read-write token. */
  readonly apiBaseUrl: string;
  /** The store origin objects are served from, without a path. */
  readonly publicBaseUrl: string;
  readonly storeId: string;
  /** How long an upload, download or preview grant is offered for. */
  readonly grantTtlMs: number;
  /**
   * The largest object this deployment will accept in one request.
   *
   * Vercel publishes no single-request ceiling, so the deployment states one.
   * It is not decoration: this issuer plans exactly one part, so the ceiling is
   * the whole of what bounds an upload, and a file above it is refused before a
   * material row exists rather than at the last byte.
   */
  readonly maxObjectBytes: bigint;
  /** Mints a client upload token for one object; the token never reaches a database. */
  mintClientToken(request: BlobClientTokenRequest): string;
  /** The deployment credential, for the one call about to spend it. */
  openToken(): string;
}

/**
 * Safe-to-pass GitHub egress policy, built the way {@link ControlPlaneAuthConfig}
 * and {@link ControlPlaneStorageConfig} are: the deployment credential lives
 * inside a closure and is not a property, so nothing that receives this object
 * can enumerate, serialize or log it.
 *
 * Unlike SigV4 there is no signature to hand out in the credential's place — a
 * GitHub API call authenticates with the token itself in an `Authorization`
 * header — so the closure cannot hide the value from its one caller. What it
 * does instead is what `DurableIntegrationStore.openInstallationCredentials`
 * does with the group's own credential: the plaintext is obtained only by
 * asking for it by name, in the function that is about to spend it, so a
 * response, a log line or an error that serialized this object cannot carry it.
 */
export interface ControlPlaneGitHubConfig {
  /** The API origin, `https://api.github.com` or a GitHub Enterprise `/api/v3` base. */
  readonly apiBaseUrl: string;
  /** The one repository this deployment's own credential may be spent against. */
  readonly repository: string;
  /** Labels every issue this control plane opens carries. */
  readonly issueLabels: readonly string[];
  /** Where a translation proposal is committed; carries `{locale}` and `{key}`. */
  readonly translationPathTemplate: string;
  /** The deployment credential, for the one call about to spend it. */
  openToken(): string;
}

/**
 * The conversion pipeline's own policy: whether this process renders variants,
 * and with what.
 *
 * It carries no credential, which is why it is a plain record rather than a
 * closure like {@link ControlPlaneStorageConfig}: the worker spends the bucket
 * credential through that configuration's signing closures and holds none of
 * its own. What is here is a program to run and four bounds on how it is run.
 *
 * Its presence is what decides whether a worker exists at all. Absent -- and
 * absent is the default -- the control plane behaves exactly as it did before
 * this pipeline: `conversion_jobs` accumulates the ladder each upload declares,
 * nothing consumes it, and every preview variant is the original. That is the
 * deliberate default because starting an ffmpeg process is not something a
 * version bump should begin doing to a machine on its own.
 */
export interface ControlPlaneConversionConfig {
  /** The ffmpeg executable; `ffmpeg` means "whatever is on PATH". */
  readonly ffmpegPath: string;
  /** The ffprobe executable, which measures the rendition the render produced. */
  readonly ffprobePath: string;
  /** How long a claimed job is owned before another worker may take it over. */
  readonly leaseMs: number;
  /** After this many attempts a job stays FAILED with its last detail. */
  readonly maxAttempts: number;
  /** How often the worker asks for a job. */
  readonly pollIntervalMs: number;
  /** The wall-clock budget for one ffmpeg or ffprobe run. */
  readonly renderTimeoutMs: number;
  /** The largest source this deployment converts; a larger take stays original. */
  readonly maxSourceBytes: bigint;
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
  /**
   * The second grant issuer, configured instead of `storage` rather than beside
   * it: a material's bytes live in one store, and two configured stores would
   * leave every read to guess which one holds an object.
   */
  readonly blobStorage?: ControlPlaneBlobStorageConfig;
  readonly github?: ControlPlaneGitHubConfig;
  /** Present only when `HQ_CONTROL_PLANE_CONVERSION_WORKER` is `true`. */
  readonly conversion?: ControlPlaneConversionConfig;
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
/** `vercel_blob_rw_<storeId>_<secret>`; the parts are what the token format is made of. */
const blobTokenPattern = /^vercel_blob_rw_[A-Za-z0-9]+_[A-Za-z0-9]+$/u;
const defaultBlobApiBaseUrl = 'https://blob.vercel-storage.com';
/**
 * The single-request ceiling, which the platform does not publish.
 *
 * A hundred mebibytes is the conservative default: large enough for the
 * documents and stills a shoot uploads through a browser, small enough that it
 * is well inside any limit a hosted upload endpoint is likely to enforce. A
 * deployment that has measured its own store raises it deliberately.
 */
const defaultBlobMaxObjectBytes = 100n * 1024n * 1024n;
const minimumBlobMaxObjectBytes = 1024n * 1024n;
const maximumBlobMaxObjectBytes = 1024n * 1024n * 1024n;
const storageService = 's3';
/**
 * Conversion bounds.
 *
 * The lease is five minutes and the render budget is four, so a healthy but
 * slow transcode always finishes inside the lease it started under. The
 * ceilings are generous rather than tight: a feature-length take on a slow
 * machine is a legitimate hour, and the thing being bounded is a runaway, not a
 * long job.
 */
const defaultConversionLeaseSeconds = 300;
const minimumConversionLeaseSeconds = 30;
const maximumConversionLeaseSeconds = 4 * 60 * 60;
const defaultConversionTimeoutSeconds = 240;
const minimumConversionTimeoutSeconds = 5;
const maximumConversionTimeoutSeconds = 4 * 60 * 60;
const defaultConversionPollSeconds = 5;
const minimumConversionPollSeconds = 1;
const maximumConversionPollSeconds = 600;
const defaultConversionMaxAttempts = 3;
const defaultConversionMaxSourceMegabytes = 8 * 1024;
const maximumConversionMaxSourceMegabytes = 512 * 1024;
/**
 * The GitHub API's own default host. A GitHub Enterprise Server deployment
 * answers under `https://<host>/api/v3`, which is why the value is a base URL
 * with an optional path rather than an origin.
 */
const defaultGitHubApiBaseUrl = 'https://api.github.com';
/**
 * Where a translation proposal is committed on the branch its pull request
 * opens from. It is a template rather than a fixed path because only the
 * deployment knows its repository's layout, and it defaults to a directory of
 * proposal records rather than to a catalogue file: this control plane cannot
 * parse an arbitrary repository's message catalogue, and a pull request that
 * rewrote one it had guessed at would be a worse answer than a reviewable
 * record of what was proposed.
 */
const defaultGitHubTranslationPath = 'translations/proposals/{locale}/{key}.json';
/**
 * Short enough to admit every token format GitHub has issued -- a 40-character
 * classic token, a `ghp_`/`ghs_` fine-grained one, an App installation token --
 * and long enough that a placeholder left in a deployment file is refused at
 * startup rather than at the first outbound call.
 */
const minimumGitHubTokenLength = 20;
/** `owner/name`, and nothing that could steer an API path somewhere else. */
const gitHubRepositoryPattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;

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

const blobStorageEnvironmentVariableNames = [
  'HQ_CONTROL_PLANE_BLOB_STORAGE_TOKEN',
  'HQ_CONTROL_PLANE_BLOB_STORAGE_PUBLIC_BASE_URL',
  'HQ_CONTROL_PLANE_BLOB_STORAGE_API_BASE_URL',
  'HQ_CONTROL_PLANE_BLOB_STORAGE_GRANT_TTL_SECONDS',
  'HQ_CONTROL_PLANE_BLOB_STORAGE_MAX_OBJECT_BYTES',
] as const;

/**
 * Both, or neither. A token with no store origin leaves every download grant
 * without an address, and an origin with no token leaves every upload without a
 * signature.
 */
const requiredBlobStorageEnvironmentVariableNames = [
  'HQ_CONTROL_PLANE_BLOB_STORAGE_TOKEN',
  'HQ_CONTROL_PLANE_BLOB_STORAGE_PUBLIC_BASE_URL',
] as const;

const githubEnvironmentVariableNames = [
  'HQ_CONTROL_PLANE_GITHUB_TOKEN',
  'HQ_CONTROL_PLANE_GITHUB_REPOSITORY',
  'HQ_CONTROL_PLANE_GITHUB_API_BASE_URL',
  'HQ_CONTROL_PLANE_GITHUB_ISSUE_LABELS',
  'HQ_CONTROL_PLANE_GITHUB_TRANSLATION_PATH',
] as const;

/**
 * Both, or neither. A token with no repository is a credential with nowhere it
 * may be spent, and a repository with no token is a name nothing can reach; a
 * deployment that wrote one and forgot the other must be told which, rather
 * than start into a GitHub surface that refuses every call it is given.
 */
const requiredGithubEnvironmentVariableNames = [
  'HQ_CONTROL_PLANE_GITHUB_TOKEN',
  'HQ_CONTROL_PLANE_GITHUB_REPOSITORY',
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
  const blobStorage = parseBlobStorage(environment, storage !== undefined);
  const github = parseGitHub(environment);
  const conversion = parseConversion(environment);
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
    ...(blobStorage === undefined ? {} : { blobStorage }),
    ...(github === undefined ? {} : { github }),
    ...(conversion === undefined ? {} : { conversion }),
  };
}

/**
 * The conversion pipeline's configuration, or none at all.
 *
 * Every value is parsed and bounds-checked *before* the enabling flag is
 * consulted, so a deployment that wrote a nonsense lease and left the worker off
 * is told at startup rather than at the moment it turns the worker on. Only the
 * flag decides whether the result is returned: this is one switch and a set of
 * bounds, not an all-or-nothing group, because none of the bounds is a
 * credential and every one of them has a defensible default.
 */
function parseConversion(
  environment: Readonly<Record<string, string | undefined>>,
): ControlPlaneConversionConfig | undefined {
  const ffmpegPath = parseExecutablePath(
    environment.HQ_CONTROL_PLANE_FFMPEG_PATH,
    'HQ_CONTROL_PLANE_FFMPEG_PATH',
    'ffmpeg',
  );
  const ffprobePath = parseExecutablePath(
    environment.HQ_CONTROL_PLANE_FFPROBE_PATH,
    'HQ_CONTROL_PLANE_FFPROBE_PATH',
    'ffprobe',
  );
  const leaseMs =
    boundedSeconds(
      environment.HQ_CONTROL_PLANE_CONVERSION_LEASE_SECONDS,
      'HQ_CONTROL_PLANE_CONVERSION_LEASE_SECONDS',
      minimumConversionLeaseSeconds,
      maximumConversionLeaseSeconds,
    ) ?? defaultConversionLeaseSeconds * 1000;
  const renderTimeoutMs =
    boundedSeconds(
      environment.HQ_CONTROL_PLANE_CONVERSION_TIMEOUT_SECONDS,
      'HQ_CONTROL_PLANE_CONVERSION_TIMEOUT_SECONDS',
      minimumConversionTimeoutSeconds,
      maximumConversionTimeoutSeconds,
    ) ?? defaultConversionTimeoutSeconds * 1000;
  const pollIntervalMs =
    boundedSeconds(
      environment.HQ_CONTROL_PLANE_CONVERSION_POLL_SECONDS,
      'HQ_CONTROL_PLANE_CONVERSION_POLL_SECONDS',
      minimumConversionPollSeconds,
      maximumConversionPollSeconds,
    ) ?? defaultConversionPollSeconds * 1000;
  const maxAttempts = boundedCount(
    environment.HQ_CONTROL_PLANE_CONVERSION_MAX_ATTEMPTS,
    'HQ_CONTROL_PLANE_CONVERSION_MAX_ATTEMPTS',
    1,
    10,
    defaultConversionMaxAttempts,
  );
  const maxSourceBytes = parseMaxSourceBytes(
    environment.HQ_CONTROL_PLANE_CONVERSION_MAX_SOURCE_MEGABYTES,
  );
  // The render budget must fit inside the lease it is spent under. Otherwise a
  // slow but healthy transcode is taken over by a second worker while the first
  // is still running, and both write the same key: not a corruption -- the
  // attempt fence makes only one completion count -- but two ffmpeg processes
  // and one wasted upload, forever, on every large file.
  if (renderTimeoutMs > leaseMs) {
    throw new Error(
      'HQ_CONTROL_PLANE_CONVERSION_TIMEOUT_SECONDS must not exceed HQ_CONTROL_PLANE_CONVERSION_LEASE_SECONDS',
    );
  }
  if (
    !parseBoolean(
      environment.HQ_CONTROL_PLANE_CONVERSION_WORKER,
      'HQ_CONTROL_PLANE_CONVERSION_WORKER',
    )
  ) {
    return undefined;
  }
  return {
    ffmpegPath,
    ffprobePath,
    leaseMs,
    maxAttempts,
    pollIntervalMs,
    renderTimeoutMs,
    maxSourceBytes,
  };
}

/**
 * An executable name or an absolute path, and nothing that could become a
 * command line.
 *
 * The worker spawns without a shell, so a space or a semicolon here is only
 * ever part of a file name; the check exists so a value that was meant as a
 * command with arguments is refused at startup instead of failing as a missing
 * file on the first transcode.
 */
function parseExecutablePath(value: string | undefined, name: string, fallback: string): string {
  if (value === undefined || value.trim().length === 0) return fallback;
  const trimmed = value.trim();
  if (/[\r\n\0]/u.test(trimmed)) {
    throw new Error(`${name} must be an executable name or path on one line`);
  }
  return trimmed;
}

function boundedSeconds(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < minimum || seconds > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum.toString()} and ${maximum.toString()}`,
    );
  }
  return seconds * 1000;
}

function boundedCount(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  const count = Number(value);
  if (!Number.isInteger(count) || count < minimum || count > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum.toString()} and ${maximum.toString()}`,
    );
  }
  return count;
}

/**
 * Megabytes rather than bytes, because the value an operator writes is a size
 * of a film take and a byte count of that magnitude is unreadable. Returned as
 * a `bigint` because the comparison it takes part in is against a `bigint`
 * column, and a number would round above 2^53.
 */
function parseMaxSourceBytes(value: string | undefined): bigint {
  if (value === undefined || value.trim().length === 0) {
    return BigInt(defaultConversionMaxSourceMegabytes) * 1024n * 1024n;
  }
  const megabytes = Number(value);
  if (
    !Number.isInteger(megabytes) ||
    megabytes < 1 ||
    megabytes > maximumConversionMaxSourceMegabytes
  ) {
    throw new Error(
      `HQ_CONTROL_PLANE_CONVERSION_MAX_SOURCE_MEGABYTES must be an integer between 1 and ${maximumConversionMaxSourceMegabytes.toString()}`,
    );
  }
  return BigInt(megabytes) * 1024n * 1024n;
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
  // `new URL` guarded for the same reason as in parseRedis: Node attaches the
  // raw input to the TypeError, and a malformed connection string carries its
  // own password into the startup log.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('HQ_CONTROL_PLANE_DATABASE_URL must be a PostgreSQL connection URL');
  }
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
 * The Vercel Blob issuer's configuration, or none at all.
 *
 * It is all-or-nothing like every other group here, and it is refused outright
 * when the S3 group is also configured: a material's bytes live in exactly one
 * store, and a deployment that named two would leave every download grant to
 * guess which one holds the object. Naming the conflict at startup is the only
 * moment it can be answered.
 */
function parseBlobStorage(
  environment: Readonly<Record<string, string | undefined>>,
  s3Configured: boolean,
): ControlPlaneBlobStorageConfig | undefined {
  if (!blobStorageEnvironmentVariableNames.some((name) => isPresent(environment[name]))) {
    return undefined;
  }
  if (s3Configured) {
    throw new Error(
      'HQ_CONTROL_PLANE_BLOB_STORAGE_* and HQ_CONTROL_PLANE_STORAGE_* configure two object ' +
        'stores for one library: set exactly one of them',
    );
  }
  const missing = requiredBlobStorageEnvironmentVariableNames.filter(
    (name) => !isPresent(environment[name]),
  );
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(', ')} must be set when Vercel Blob storage is configured: ` +
        'HQ_CONTROL_PLANE_BLOB_STORAGE_TOKEN and HQ_CONTROL_PLANE_BLOB_STORAGE_PUBLIC_BASE_URL ' +
        'are set together',
    );
  }

  const token = requireBlobToken(environment.HQ_CONTROL_PLANE_BLOB_STORAGE_TOKEN);
  const publicBaseUrl = parseBlobOrigin(
    environment.HQ_CONTROL_PLANE_BLOB_STORAGE_PUBLIC_BASE_URL ?? '',
    'HQ_CONTROL_PLANE_BLOB_STORAGE_PUBLIC_BASE_URL',
  );
  const apiBaseUrl = isPresent(environment.HQ_CONTROL_PLANE_BLOB_STORAGE_API_BASE_URL)
    ? parseBlobOrigin(
        environment.HQ_CONTROL_PLANE_BLOB_STORAGE_API_BASE_URL,
        'HQ_CONTROL_PLANE_BLOB_STORAGE_API_BASE_URL',
      )
    : defaultBlobApiBaseUrl;
  const grantTtlSeconds = parseLifetimeSeconds(
    environment.HQ_CONTROL_PLANE_BLOB_STORAGE_GRANT_TTL_SECONDS,
    'HQ_CONTROL_PLANE_BLOB_STORAGE_GRANT_TTL_SECONDS',
    defaultStorageGrantTtlSeconds,
    minimumStorageGrantTtlSeconds,
    maximumStorageGrantTtlSeconds,
  );
  const maxObjectBytes = parseBlobMaxObjectBytes(
    environment.HQ_CONTROL_PLANE_BLOB_STORAGE_MAX_OBJECT_BYTES,
  );
  // Index 3 of the token, which is the store id every public URL already
  // carries. It is read here so nothing downstream has to split the token --
  // and splitting a credential outside this closure is how a credential leaves
  // it.
  const storeId = token.split('_')[3] ?? '';

  // The token is captured by this closure and is never a property of the
  // returned object, so freezing and serializing that object cannot disclose
  // it, and neither can an error that stringifies it.
  return Object.freeze({
    apiBaseUrl,
    publicBaseUrl,
    storeId,
    grantTtlMs: secondsToMilliseconds(grantTtlSeconds),
    maxObjectBytes,
    mintClientToken(request: BlobClientTokenRequest): string {
      return mintBlobClientToken(token, storeId, request);
    },
    openToken(): string {
      return token;
    },
  });
}

/**
 * Derives a client upload token in the format the Vercel Blob upload endpoint
 * accepts, as `@vercel/blob`'s own client-token helper documents it: a base64
 * payload naming the object and the window, an HMAC-SHA-256 of that payload
 * under the read-write token, and the pair carried under a
 * `vercel_blob_client_<storeId>_` prefix.
 *
 * Two properties matter here and hold whatever the platform does with the value.
 * The token is derived per grant and never persisted -- no column of this
 * schema holds one, and `upload_sessions.storage_upload_id` deliberately does
 * not receive it. And the read-write token itself never leaves this closure:
 * it is the HMAC key, not part of the result.
 *
 * The derivation has never been presented to the live service. This repository
 * has no Blob store and no read-write token, so the scripted server in
 * `vercel-blob-grant-issuer.test.ts` proves the shape and the binding, not that
 * Vercel accepts it. Verify it against `@vercel/blob` before pointing a
 * deployment at a real store.
 */
function mintBlobClientToken(
  token: string,
  storeId: string,
  request: BlobClientTokenRequest,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      pathname: request.pathname,
      contentType: request.contentType,
      // The store's own bound on the body, so a stolen grant cannot be spent on
      // an object larger than the one it was issued for.
      maximumSizeInBytes: Number(request.maximumSizeInBytes),
      validUntil: request.validUntil.getTime(),
      // The key is content-addressed, so the pathname is the object's identity
      // and a random suffix would break deduplication; overwriting it with the
      // same bytes is the only thing a repeat upload can do.
      addRandomSuffix: false,
      allowOverwrite: true,
    }),
    'utf8',
  ).toString('base64');
  const signature = createHmac('sha256', token).update(payload).digest('hex');
  const encoded = Buffer.from(`${signature}.${payload}`, 'utf8').toString('base64');
  return `vercel_blob_client_${storeId}_${encoded}`;
}

/**
 * A bearer credential, refused for whitespace and for shape: a token copied out
 * of a wrapped deployment file arrives with a newline in it, and the store id is
 * read out of this value, so a token that is not the documented five-part form
 * would leave every public URL addressed at an empty store.
 */
function requireBlobToken(value: string | undefined): string {
  const token = value?.trim() ?? '';
  if (!blobTokenPattern.test(token)) {
    throw new Error(
      'HQ_CONTROL_PLANE_BLOB_STORAGE_TOKEN must be a vercel_blob_rw_<store>_<secret> token ' +
        'with no whitespace',
    );
  }
  return token;
}

/**
 * HTTPS only, and an origin alone.
 *
 * There is no loopback exception here, unlike the S3 endpoint: an upload to
 * this origin carries a client token in an `Authorization` header rather than a
 * signature, so a cleartext request would disclose the credential itself. A
 * local Blob emulator is out of scope for exactly that reason.
 */
function parseBlobOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${name} must be an HTTPS URL`);
  }
  if (url.hostname.length === 0 || url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${name} must name a host and carry no credentials`);
  }
  if (
    (url.pathname !== '/' && url.pathname.length > 0) ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`${name} must be the store origin alone, without a path, query or fragment`);
  }
  return url.origin;
}

function parseBlobMaxObjectBytes(value: string | undefined): bigint {
  if (!isPresent(value)) return defaultBlobMaxObjectBytes;
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) {
    throw new Error('HQ_CONTROL_PLANE_BLOB_STORAGE_MAX_OBJECT_BYTES must be an integer');
  }
  const bytes = BigInt(normalized);
  if (bytes < minimumBlobMaxObjectBytes || bytes > maximumBlobMaxObjectBytes) {
    throw new Error(
      'HQ_CONTROL_PLANE_BLOB_STORAGE_MAX_OBJECT_BYTES must be between ' +
        `${minimumBlobMaxObjectBytes.toString()} and ${maximumBlobMaxObjectBytes.toString()}`,
    );
  }
  return bytes;
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

/**
 * GitHub egress is all-or-nothing like Redis and object storage: one variable
 * of the group set means the whole group is meant, and a missing member is
 * named rather than defaulted. Absent, this returns `undefined`, no gateway is
 * built, and `CreateIssue`, `CreateTranslationPullRequest` and
 * `GetPullRequestStatus` refuse with `FAILED_PRECONDITION` naming these
 * variables — the same shape the four grant-minting material RPCs take without
 * a bucket. It is not tied to the database URL, so the reduced health-only mode
 * stays reachable with any subset of the other groups.
 */
function parseGitHub(
  environment: Readonly<Record<string, string | undefined>>,
): ControlPlaneGitHubConfig | undefined {
  if (!githubEnvironmentVariableNames.some((name) => isPresent(environment[name]))) {
    return undefined;
  }
  const missing = requiredGithubEnvironmentVariableNames.filter(
    (name) => !isPresent(environment[name]),
  );
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(', ')} must be set when GitHub egress is configured: ` +
        'HQ_CONTROL_PLANE_GITHUB_TOKEN and HQ_CONTROL_PLANE_GITHUB_REPOSITORY are set together',
    );
  }

  const token = requireGitHubToken(environment.HQ_CONTROL_PLANE_GITHUB_TOKEN);
  const repository = parseGitHubRepository(environment.HQ_CONTROL_PLANE_GITHUB_REPOSITORY ?? '');
  const apiBaseUrl = parseGitHubApiBaseUrl(environment.HQ_CONTROL_PLANE_GITHUB_API_BASE_URL);
  const issueLabels = parseGitHubIssueLabels(environment.HQ_CONTROL_PLANE_GITHUB_ISSUE_LABELS);
  const translationPathTemplate = parseGitHubTranslationPath(
    environment.HQ_CONTROL_PLANE_GITHUB_TRANSLATION_PATH,
  );

  // The token is captured here and nowhere else: it is a parameter of this
  // function's closure, never a property of the returned object, so freezing
  // and serializing that object cannot disclose it.
  return Object.freeze({
    apiBaseUrl,
    repository,
    issueLabels,
    translationPathTemplate,
    openToken(): string {
      return token;
    },
  });
}

/**
 * A bearer credential, so it is refused for whitespace as well as for length:
 * a token copied out of a wrapped deployment file arrives with a newline in it
 * and authenticates nowhere, and GitHub's answer to that is a flat 401 that
 * names nothing.
 */
function requireGitHubToken(value: string | undefined): string {
  const token = value?.trim() ?? '';
  if (token.length < minimumGitHubTokenLength || /\s/u.test(token)) {
    throw new Error(
      `HQ_CONTROL_PLANE_GITHUB_TOKEN must contain at least ${minimumGitHubTokenLength.toString()} characters and no whitespace`,
    );
  }
  return token;
}

/**
 * `owner/name` and nothing else. The value is interpolated into an API path, so
 * a repository of `a/b/../../elsewhere` would send this deployment's credential
 * to an endpoint the operator did not name.
 */
function parseGitHubRepository(value: string): string {
  const repository = value.trim();
  if (!gitHubRepositoryPattern.test(repository)) {
    throw new Error('HQ_CONTROL_PLANE_GITHUB_REPOSITORY must be owner/name');
  }
  return repository;
}

/**
 * HTTPS, or plain HTTP to the loopback interface only — the same rule the
 * storage endpoint takes, and for a stronger reason: every request to this base
 * carries the deployment token in an `Authorization` header, and a cleartext
 * request over a network anyone can observe discloses the credential itself
 * rather than a signature over one. The trailing slash is stripped so a path is
 * appended exactly once.
 */
function parseGitHubApiBaseUrl(value: string | undefined): string {
  if (!isPresent(value)) return defaultGitHubApiBaseUrl;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('HQ_CONTROL_PLANE_GITHUB_API_BASE_URL must be an absolute URL');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(
      'HQ_CONTROL_PLANE_GITHUB_API_BASE_URL must be an HTTPS URL; http is accepted only for 127.0.0.1, localhost or [::1]',
    );
  }
  if (url.hostname.length === 0 || url.username.length > 0 || url.password.length > 0) {
    throw new Error(
      'HQ_CONTROL_PLANE_GITHUB_API_BASE_URL must name a host and carry no credentials',
    );
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error('HQ_CONTROL_PLANE_GITHUB_API_BASE_URL must carry no query string or fragment');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/u, '');
}

/** Comma-separated, in the order written, with duplicates and blanks dropped. */
function parseGitHubIssueLabels(value: string | undefined): readonly string[] {
  if (!isPresent(value)) return Object.freeze([]);
  const labels = value
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
  for (const label of labels) {
    if (label.length > 50) {
      throw new Error('HQ_CONTROL_PLANE_GITHUB_ISSUE_LABELS entries must be at most 50 characters');
    }
  }
  return Object.freeze([...new Set(labels)]);
}

/**
 * A repository-relative path template. Both placeholders are required: without
 * `{key}` every proposal in a locale would commit to one path, so the second
 * pull request would silently overwrite the first one's proposal on its own
 * branch. Traversal and absolute paths are refused for the same reason the
 * repository is validated — the value becomes part of an API path.
 */
function parseGitHubTranslationPath(value: string | undefined): string {
  if (!isPresent(value)) return defaultGitHubTranslationPath;
  const template = value.trim();
  if (!template.includes('{locale}') || !template.includes('{key}')) {
    throw new Error(
      'HQ_CONTROL_PLANE_GITHUB_TRANSLATION_PATH must contain both {locale} and {key}',
    );
  }
  if (
    template.startsWith('/') ||
    template.includes('..') ||
    !/^[A-Za-z0-9._/{}-]+$/u.test(template)
  ) {
    throw new Error(
      'HQ_CONTROL_PLANE_GITHUB_TRANSLATION_PATH must be a relative path of letters, digits, dots, dashes, slashes and the two placeholders',
    );
  }
  return template;
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
