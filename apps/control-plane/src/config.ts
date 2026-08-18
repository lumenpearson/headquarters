export interface ControlPlaneConfig {
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly databaseUrl?: string;
  readonly redis?: {
    readonly restUrl: string;
    readonly restToken: string;
  };
}

const defaultPort = 4100;

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
  return {
    port,
    allowedOrigins,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(redis === undefined ? {} : { redis }),
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
  return { restUrl, restToken };
}
