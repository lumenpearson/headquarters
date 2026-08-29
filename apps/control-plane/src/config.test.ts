import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadControlPlaneConfig } from './config.js';

const databaseUrl = 'postgresql://role:password@ep-hq.neon.tech/headquarters?sslmode=require';
const tokenPepper = 'token-pepper-for-control-plane-authentication-0123456789';
const bootstrapSecret = 'bootstrap-secret-for-control-plane-authentication-012345';

function authenticatedEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    HQ_CONTROL_PLANE_DATABASE_URL: databaseUrl,
    HQ_CONTROL_PLANE_AUTH_TOKEN_PEPPER: tokenPepper,
    HQ_CONTROL_PLANE_BOOTSTRAP_SECRET: bootstrapSecret,
    ...overrides,
  };
}

describe('control-plane configuration', () => {
  it('normalizes an explicit origin allow-list and ephemeral port', () => {
    expect(
      loadControlPlaneConfig({
        HQ_CONTROL_PLANE_PORT: '0',
        HQ_CONTROL_PLANE_ALLOWED_ORIGINS:
          'http://127.0.0.1:3000, https://hq.example.test,http://127.0.0.1:3000',
        HQ_CONTROL_PLANE_DATABASE_URL: databaseUrl,
        HQ_CONTROL_PLANE_REDIS_REST_URL: 'https://hq-redis.upstash.io',
        HQ_CONTROL_PLANE_REDIS_REST_TOKEN: 'upstash-token',
      }),
    ).toEqual({
      port: 0,
      host: '127.0.0.1',
      allowedOrigins: ['http://127.0.0.1:3000', 'https://hq.example.test'],
      runMigrationsOnStart: true,
      databaseUrl,
      redis: { restUrl: 'https://hq-redis.upstash.io', restToken: 'upstash-token' },
    });
  });

  it('keeps health-only startup valid when no auth environment is supplied', () => {
    expect(loadControlPlaneConfig({})).toEqual({
      port: 4100,
      host: '127.0.0.1',
      allowedOrigins: [
        'http://127.0.0.1:3000',
        'http://localhost:3000',
        'http://tauri.localhost',
        'https://tauri.localhost',
      ],
      runMigrationsOnStart: true,
    });
    expect(
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_DATABASE_URL: databaseUrl }).auth,
    ).toBeUndefined();
  });

  /*
   * A packaged WebView2 shell serving the static export requests with
   * `Origin: http://tauri.localhost`. Without it in the default list
   * `prepareRpcResponse` answers the packaged desktop's own control plane with
   * a flat 403 on the same machine, and the operator sees a control plane that
   * looks down. The default is asserted rather than the parser, because the
   * default is the thing that was wrong.
   */
  /*
   * A serverless deployment cold-starts often and concurrently, and every one
   * of those starts would otherwise open the same `pg_advisory_xact_lock`
   * transaction. Moving the sequence to a build step is therefore a deployment
   * decision -- but an unset variable must not quietly make an existing
   * long-lived process stop migrating, so the default is the old behaviour and
   * only an explicit `false` changes it.
   */
  it('runs migrations at startup unless a deployment explicitly moved them', () => {
    expect(loadControlPlaneConfig({}).runMigrationsOnStart).toBe(true);
    expect(
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_RUN_MIGRATIONS_ON_START: '' }).runMigrationsOnStart,
    ).toBe(true);
    expect(
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_RUN_MIGRATIONS_ON_START: 'true' })
        .runMigrationsOnStart,
    ).toBe(true);
    expect(
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_RUN_MIGRATIONS_ON_START: 'false' })
        .runMigrationsOnStart,
    ).toBe(false);
    expect(
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_RUN_MIGRATIONS_ON_START: ' 0 ' })
        .runMigrationsOnStart,
    ).toBe(false);
    // Anything else is named rather than read as one of the two, because
    // guessing here decides whether a schema is migrated at all.
    expect(() =>
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_RUN_MIGRATIONS_ON_START: 'no' }),
    ).toThrow('HQ_CONTROL_PLANE_RUN_MIGRATIONS_ON_START must be true or false');
  });

  it('admits the packaged desktop shell by default, in both schemes', () => {
    const origins = loadControlPlaneConfig({}).allowedOrigins;

    expect(origins).toContain('http://tauri.localhost');
    expect(origins).toContain('https://tauri.localhost');
  });

  /*
   * The bind address decides whether any other machine on the set's LAN can
   * reach the control plane at all. Loopback stays the default so no
   * deployment starts answering more widely because it was upgraded; widening
   * it is a value an operator writes down.
   */
  it('binds loopback unless an operator names another interface', () => {
    expect(loadControlPlaneConfig({}).host).toBe('127.0.0.1');
    expect(loadControlPlaneConfig({ HQ_CONTROL_PLANE_HOST: '' }).host).toBe('127.0.0.1');
    expect(loadControlPlaneConfig({ HQ_CONTROL_PLANE_HOST: '  0.0.0.0 ' }).host).toBe('0.0.0.0');
    expect(loadControlPlaneConfig({ HQ_CONTROL_PLANE_HOST: '192.168.10.4' }).host).toBe(
      '192.168.10.4',
    );
    expect(loadControlPlaneConfig({ HQ_CONTROL_PLANE_HOST: '::' }).host).toBe('::');
    // The bracketed form is what an operator copies out of a URL, and
    // `listen` refuses it; unwrapping it here beats a startup crash on set.
    expect(loadControlPlaneConfig({ HQ_CONTROL_PLANE_HOST: '[::1]' }).host).toBe('::1');
    expect(loadControlPlaneConfig({ HQ_CONTROL_PLANE_HOST: 'hq-shoot-01.local' }).host).toBe(
      'hq-shoot-01.local',
    );
  });

  it('names a bind address written as a URL rather than letting listen fail on it', () => {
    for (const value of ['http://127.0.0.1', '127.0.0.1:4100', 'hq.local/path', '-hq.local']) {
      expect(() => loadControlPlaneConfig({ HQ_CONTROL_PLANE_HOST: value })).toThrow(
        'HQ_CONTROL_PLANE_HOST must be an IPv4 address, an IPv6 address or a hostname',
      );
    }
  });

  it('creates a secret-safe auth policy with Phase 3 defaults', () => {
    const config = loadControlPlaneConfig(authenticatedEnvironment());
    const auth = config.auth;

    expect(auth).toMatchObject({
      tokenHashVersion: 'v1',
      accessTokenLifetimeMs: 15 * 60 * 1000,
      refreshTokenLifetimeMs: 30 * 24 * 60 * 60 * 1000,
      pairingCodeLifetimeMs: 10 * 60 * 1000,
    });
    expect(auth?.verifyBootstrapSecret(bootstrapSecret)).toBe(true);
    expect(auth?.verifyBootstrapSecret(`${bootstrapSecret}-incorrect`)).toBe(false);
    expect(auth?.hashCredential('access', 'opaque-token')).toBe(
      createHmac('sha256', tokenPepper)
        .update('v1\u0000access\u0000opaque-token')
        .digest('base64url'),
    );
    expect(auth?.hashCredential('access', 'opaque-token')).not.toBe(
      auth?.hashCredential('refresh', 'opaque-token'),
    );
    expect(auth).not.toHaveProperty('tokenPepper');
    expect(auth).not.toHaveProperty('bootstrapSecret');
    expect(JSON.stringify(config)).not.toContain(tokenPepper);
    expect(JSON.stringify(config)).not.toContain(bootstrapSecret);
  });

  it('accepts explicitly bounded auth TTL overrides and exact v1 hash version', () => {
    const auth = loadControlPlaneConfig(
      authenticatedEnvironment({
        HQ_CONTROL_PLANE_AUTH_TOKEN_HASH_VERSION: 'v1',
        HQ_CONTROL_PLANE_AUTH_ACCESS_TOKEN_TTL_SECONDS: '120',
        HQ_CONTROL_PLANE_AUTH_REFRESH_TOKEN_TTL_SECONDS: '7200',
        HQ_CONTROL_PLANE_AUTH_PAIRING_CODE_TTL_SECONDS: '1800',
      }),
    ).auth;

    expect(auth).toMatchObject({
      tokenHashVersion: 'v1',
      accessTokenLifetimeMs: 120_000,
      refreshTokenLifetimeMs: 7_200_000,
      pairingCodeLifetimeMs: 1_800_000,
    });
  });

  it('fails closed for partial auth configuration without serializing a supplied secret', () => {
    const suppliedSecret = 'do-not-leak-this-control-plane-pepper-0123456789';
    let error: Error | undefined;
    try {
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_AUTH_TOKEN_PEPPER: suppliedSecret });
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }

    expect(error?.message).toContain('HQ_CONTROL_PLANE_DATABASE_URL');
    expect(error?.message).not.toContain(suppliedSecret);
    expect(() =>
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_AUTH_ACCESS_TOKEN_TTL_SECONDS: '900' }),
    ).toThrow('HQ_CONTROL_PLANE_DATABASE_URL');
    expect(() =>
      loadControlPlaneConfig({
        HQ_CONTROL_PLANE_DATABASE_URL: databaseUrl,
        HQ_CONTROL_PLANE_AUTH_TOKEN_PEPPER: tokenPepper,
      }),
    ).toThrow('HQ_CONTROL_PLANE_BOOTSTRAP_SECRET');
    expect(() =>
      loadControlPlaneConfig({
        HQ_CONTROL_PLANE_DATABASE_URL: databaseUrl,
        HQ_CONTROL_PLANE_BOOTSTRAP_SECRET: bootstrapSecret,
      }),
    ).toThrow('HQ_CONTROL_PLANE_AUTH_TOKEN_PEPPER');
  });

  it('rejects unsupported auth versions, weak secrets, and unsafe TTL values', () => {
    expect(() =>
      loadControlPlaneConfig(
        authenticatedEnvironment({ HQ_CONTROL_PLANE_AUTH_TOKEN_HASH_VERSION: 'v2' }),
      ),
    ).toThrow('HQ_CONTROL_PLANE_AUTH_TOKEN_HASH_VERSION');
    expect(() =>
      loadControlPlaneConfig(
        authenticatedEnvironment({ HQ_CONTROL_PLANE_AUTH_TOKEN_HASH_VERSION: ' v1 ' }),
      ),
    ).toThrow('HQ_CONTROL_PLANE_AUTH_TOKEN_HASH_VERSION');
    expect(() =>
      loadControlPlaneConfig(
        authenticatedEnvironment({ HQ_CONTROL_PLANE_AUTH_TOKEN_PEPPER: 'too-short' }),
      ),
    ).toThrow('HQ_CONTROL_PLANE_AUTH_TOKEN_PEPPER');
    expect(() =>
      loadControlPlaneConfig(
        authenticatedEnvironment({ HQ_CONTROL_PLANE_AUTH_ACCESS_TOKEN_TTL_SECONDS: '59' }),
      ),
    ).toThrow('HQ_CONTROL_PLANE_AUTH_ACCESS_TOKEN_TTL_SECONDS');
    expect(() =>
      loadControlPlaneConfig(
        authenticatedEnvironment({ HQ_CONTROL_PLANE_AUTH_PAIRING_CODE_TTL_SECONDS: '3601' }),
      ),
    ).toThrow('HQ_CONTROL_PLANE_AUTH_PAIRING_CODE_TTL_SECONDS');
    expect(() =>
      loadControlPlaneConfig(
        authenticatedEnvironment({
          HQ_CONTROL_PLANE_AUTH_ACCESS_TOKEN_TTL_SECONDS: '7200',
          HQ_CONTROL_PLANE_AUTH_REFRESH_TOKEN_TTL_SECONDS: '7200',
        }),
      ),
    ).toThrow('HQ_CONTROL_PLANE_AUTH_REFRESH_TOKEN_TTL_SECONDS must be greater');
    expect(() =>
      loadControlPlaneConfig(
        authenticatedEnvironment({ HQ_CONTROL_PLANE_AUTH_REFRESH_TOKEN_TTL_SECONDS: '0' }),
      ),
    ).toThrow('HQ_CONTROL_PLANE_AUTH_REFRESH_TOKEN_TTL_SECONDS');
    expect(() =>
      loadControlPlaneConfig(
        authenticatedEnvironment({ HQ_CONTROL_PLANE_AUTH_ACCESS_TOKEN_TTL_SECONDS: '1e3' }),
      ),
    ).toThrow('HQ_CONTROL_PLANE_AUTH_ACCESS_TOKEN_TTL_SECONDS');
  });

  it('rejects invalid ports and non-origin URLs', () => {
    expect(() => loadControlPlaneConfig({ HQ_CONTROL_PLANE_PORT: '70000' })).toThrow(
      'HQ_CONTROL_PLANE_PORT',
    );
    expect(() =>
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_ALLOWED_ORIGINS: 'file:///C:/HQ' }),
    ).toThrow('Invalid control-plane origin');
    expect(() =>
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_DATABASE_URL: 'https://database.example.test' }),
    ).toThrow('HQ_CONTROL_PLANE_DATABASE_URL');
    expect(() =>
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_REDIS_REST_URL: 'https://hq-redis.upstash.io' }),
    ).toThrow('HQ_CONTROL_PLANE_REDIS_REST_URL');
  });

  it('keeps a malformed database URL out of its own startup error', () => {
    // A connection string that fails `new URL` still carries its password;
    // the error must name the variable and never quote the value, because in
    // a container this message lands in `docker compose logs`.
    const malformed = 'postgres//hq:fixture-password-value@db.example.test:5432/hq';
    let error: Error | undefined;
    try {
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_DATABASE_URL: malformed });
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    expect(error?.message).toBe(
      'HQ_CONTROL_PLANE_DATABASE_URL must be a PostgreSQL connection URL',
    );
    expect(error?.message).not.toContain('fixture-password-value');
  });
});

describe('redis configuration', () => {
  it('trims the pair it accepts, so padding never reaches Upstash', () => {
    const config = loadControlPlaneConfig({
      HQ_CONTROL_PLANE_REDIS_REST_URL: '  https://example.upstash.io  ',
      HQ_CONTROL_PLANE_REDIS_REST_TOKEN: '  token-value  ',
    });

    // The presence checks read the trimmed value, so an untrimmed return let a
    // padded token pass validation and then fail authentication with no hint.
    expect(config.redis).toEqual({
      restUrl: 'https://example.upstash.io',
      restToken: 'token-value',
    });
  });

  it('refuses half a pair', () => {
    expect(() =>
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_REDIS_REST_URL: 'https://example.upstash.io' }),
    ).toThrow('must be set together');
  });

  /*
   * The Vercel Upstash Marketplace integration writes its own names into a
   * project's Production and Preview environments and the platform cannot alias
   * one variable onto another, so the pair is read under either naming scheme.
   * The project's own names win, because a deployment that writes them is
   * pointing somewhere on purpose and a platform-injected pair must not
   * outrank that.
   */
  it('prefers the explicit HQ_* pair over the platform-injected one', () => {
    const config = loadControlPlaneConfig({
      HQ_CONTROL_PLANE_REDIS_REST_URL: 'https://explicit.upstash.io',
      HQ_CONTROL_PLANE_REDIS_REST_TOKEN: 'explicit-token',
      KV_REST_API_URL: 'https://platform.upstash.io',
      KV_REST_API_TOKEN: 'platform-token',
    });

    expect(config.redis).toEqual({
      restUrl: 'https://explicit.upstash.io',
      restToken: 'explicit-token',
    });
  });

  it('accepts the platform pair alone, trimmed and HTTPS-checked like the other', () => {
    expect(
      loadControlPlaneConfig({
        KV_REST_API_URL: '  https://platform.upstash.io  ',
        KV_REST_API_TOKEN: '  platform-token  ',
      }).redis,
    ).toEqual({ restUrl: 'https://platform.upstash.io', restToken: 'platform-token' });
    expect(() =>
      loadControlPlaneConfig({
        KV_REST_API_URL: 'http://platform.upstash.io',
        KV_REST_API_TOKEN: 'platform-token',
      }),
    ).toThrow('KV_REST_API_URL must be an HTTPS Upstash REST URL');
    expect(() => loadControlPlaneConfig({ KV_REST_API_TOKEN: 'platform-token' })).toThrow(
      'KV_REST_API_URL and KV_REST_API_TOKEN must be set together',
    );
    // Blank is not set: an all-whitespace explicit name does not select the
    // HQ_* scheme, so a complete platform pair behind it is still taken. This
    // is exactly what a half-edited .env copied from .env.example produces.
    expect(
      loadControlPlaneConfig({
        HQ_CONTROL_PLANE_REDIS_REST_URL: '   ',
        KV_REST_API_URL: 'https://platform.upstash.io',
        KV_REST_API_TOKEN: 'platform-token',
      }).redis,
    ).toEqual({ restUrl: 'https://platform.upstash.io', restToken: 'platform-token' });
  });

  /*
   * Node's `new URL` attaches the offending input to its TypeError, and the
   * web route logs startup errors whole -- so an unparseable value (a token
   * pasted into the URL variable, say) must be caught and replaced with the
   * names-only message before it can reach a deployment log.
   */
  it('names the variable and never the value when the URL does not parse', () => {
    const pastedToken = 'AXbc-live-token-pasted-into-the-url-slot';
    let error: Error | undefined;
    try {
      loadControlPlaneConfig({
        KV_REST_API_URL: pastedToken,
        KV_REST_API_TOKEN: 'platform-token',
      });
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    expect(error?.message).toBe('KV_REST_API_URL must be an HTTPS Upstash REST URL');
    expect(error?.message).not.toContain(pastedToken);
  });

  /*
   * A pair split across the two schemes is refused rather than completed from
   * the other one: the two names can point at two different Redis instances, so
   * a URL joined to a token minted elsewhere would either authenticate nowhere
   * or coordinate against an instance nobody chose. The error names the scheme
   * that was selected and never the token it was handed.
   */
  it('refuses a pair split across the two naming schemes', () => {
    const platformToken = 'do-not-leak-this-platform-redis-token';
    let error: Error | undefined;
    try {
      loadControlPlaneConfig({
        HQ_CONTROL_PLANE_REDIS_REST_URL: 'https://explicit.upstash.io',
        KV_REST_API_TOKEN: platformToken,
      });
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    expect(error?.message).toBe(
      'HQ_CONTROL_PLANE_REDIS_REST_URL and HQ_CONTROL_PLANE_REDIS_REST_TOKEN must be set together',
    );
    expect(error?.message).not.toContain(platformToken);

    // The mirror image, which is the one that could have mixed instances
    // silently: an HQ_* token beside a platform URL still selects HQ_*.
    expect(() =>
      loadControlPlaneConfig({
        HQ_CONTROL_PLANE_REDIS_REST_TOKEN: 'explicit-token',
        KV_REST_API_URL: 'https://platform.upstash.io',
      }),
    ).toThrow(
      'HQ_CONTROL_PLANE_REDIS_REST_URL and HQ_CONTROL_PLANE_REDIS_REST_TOKEN must be set together',
    );
  });

  /*
   * The no-Redis branch is what an absent pair selects: `configured-lifecycle.ts`
   * reads `config.redis === undefined` to keep the durable presence store, and
   * `Health` reports Redis unconfigured. The same integration also injects
   * `KV_URL`, `REDIS_URL` and `KV_REST_API_READ_ONLY_TOKEN`; none of them is a
   * writable REST pair, so none of them may switch that branch.
   */
  it('leaves redis absent when neither scheme supplies a REST pair', () => {
    expect(loadControlPlaneConfig({}).redis).toBeUndefined();
    expect(
      loadControlPlaneConfig({
        HQ_CONTROL_PLANE_REDIS_REST_URL: '   ',
        KV_REST_API_TOKEN: '  ',
      }).redis,
    ).toBeUndefined();
    expect(
      loadControlPlaneConfig({
        KV_URL: 'rediss://default:platform-token@platform.upstash.io:6379',
        REDIS_URL: 'rediss://default:platform-token@platform.upstash.io:6379',
        KV_REST_API_READ_ONLY_TOKEN: 'platform-read-only-token',
      }).redis,
    ).toBeUndefined();
  });
});

describe('object storage configuration', () => {
  const storageEnvironment = {
    HQ_CONTROL_PLANE_STORAGE_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com',
    HQ_CONTROL_PLANE_STORAGE_REGION: 'eu-central-1',
    HQ_CONTROL_PLANE_STORAGE_BUCKET: 'gremuchaya-materials',
    HQ_CONTROL_PLANE_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    HQ_CONTROL_PLANE_STORAGE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  it('keeps both keys inside the signing closures and exposes only the bucket coordinates', () => {
    const storage = loadControlPlaneConfig(storageEnvironment).storage;

    expect(storage).toMatchObject({
      endpoint: 'https://s3.eu-central-1.amazonaws.com',
      region: 'eu-central-1',
      bucket: 'gremuchaya-materials',
      forcePathStyle: false,
      grantTtlMs: 15 * 60 * 1000,
    });
    expect(Object.keys(storage ?? {}).sort()).toEqual([
      'bucket',
      'endpoint',
      'forcePathStyle',
      'grantTtlMs',
      'presign',
      'region',
      'sign',
    ]);
    expect(JSON.stringify(storage)).not.toContain('wJalrXUtnFEMI');
    expect(Object.isFrozen(storage)).toBe(true);

    // The closures can still sign: the access key id is in the credential
    // scope by protocol, the secret only in the signature it produced.
    const presigned = storage?.presign({
      method: 'GET',
      url: new URL('https://gremuchaya-materials.s3.eu-central-1.amazonaws.com/materials/a/b'),
      signedAt: new Date('2026-08-25T10:00:00Z'),
    });
    expect(presigned?.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAIOSFODNN7EXAMPLE/20260825/eu-central-1/s3/aws4_request',
    );
    expect(presigned?.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(presigned?.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/u);
    expect(presigned?.toString()).not.toContain('wJalrXUtnFEMI');
    const signed = storage?.sign({
      method: 'HEAD',
      url: new URL('https://gremuchaya-materials.s3.eu-central-1.amazonaws.com/materials/a/b'),
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      signedAt: new Date('2026-08-25T10:00:00Z'),
    });
    expect(signed?.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260825\/eu-central-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/u,
    );
  });

  it('accepts the optional path-style and TTL overrides within bounds', () => {
    const storage = loadControlPlaneConfig({
      ...storageEnvironment,
      HQ_CONTROL_PLANE_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
      HQ_CONTROL_PLANE_STORAGE_FORCE_PATH_STYLE: 'true',
      HQ_CONTROL_PLANE_STORAGE_GRANT_TTL_SECONDS: '120',
    }).storage;

    expect(storage).toMatchObject({
      endpoint: 'http://127.0.0.1:9000',
      forcePathStyle: true,
      grantTtlMs: 120_000,
    });
  });

  it('refuses a partial group by naming what is missing, never the secret it was given', () => {
    const secret = 'do-not-leak-this-storage-secret-0123456789';
    let error: Error | undefined;
    try {
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_STORAGE_SECRET_ACCESS_KEY: secret });
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    expect(error?.message).toContain('HQ_CONTROL_PLANE_STORAGE_ENDPOINT');
    expect(error?.message).toContain('HQ_CONTROL_PLANE_STORAGE_ACCESS_KEY_ID');
    expect(error?.message).toContain('must be set when object storage is configured');
    expect(error?.message).not.toContain(secret);

    expect(() =>
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_STORAGE_GRANT_TTL_SECONDS: '300' }),
    ).toThrow('must be set when object storage is configured');
    const { HQ_CONTROL_PLANE_STORAGE_BUCKET: _bucket, ...withoutBucket } = storageEnvironment;
    expect(() => loadControlPlaneConfig(withoutBucket)).toThrow(
      'HQ_CONTROL_PLANE_STORAGE_BUCKET must be set',
    );
  });

  it('requires HTTPS except to the loopback interface, and the bare service origin', () => {
    const withEndpoint = (endpoint: string) =>
      loadControlPlaneConfig({
        ...storageEnvironment,
        HQ_CONTROL_PLANE_STORAGE_ENDPOINT: endpoint,
      });

    expect(() => withEndpoint('http://minio.internal:9000')).toThrow('must be an HTTPS URL');
    expect(withEndpoint('http://localhost:9000').storage?.endpoint).toBe('http://localhost:9000');
    expect(withEndpoint('http://[::1]:9000').storage?.endpoint).toBe('http://[::1]:9000');
    expect(() => withEndpoint('https://s3.example.test/bucket')).toThrow('service origin alone');
    expect(() => withEndpoint('https://s3.example.test/?x=1')).toThrow('service origin alone');
    expect(() => withEndpoint('https://user:pass@s3.example.test')).toThrow('no credentials');
    expect(() => withEndpoint('not a url')).toThrow('absolute URL');
    expect(() => withEndpoint('ftp://s3.example.test')).toThrow('must be an HTTPS URL');
  });

  it('bounds the grant lifetime, the flag, the bucket name and the region', () => {
    const withOverride = (overrides: Record<string, string>) =>
      loadControlPlaneConfig({ ...storageEnvironment, ...overrides });

    expect(() => withOverride({ HQ_CONTROL_PLANE_STORAGE_GRANT_TTL_SECONDS: '59' })).toThrow(
      'between 60 and 900 seconds',
    );
    expect(() => withOverride({ HQ_CONTROL_PLANE_STORAGE_GRANT_TTL_SECONDS: '901' })).toThrow(
      'between 60 and 900 seconds',
    );
    expect(() => withOverride({ HQ_CONTROL_PLANE_STORAGE_GRANT_TTL_SECONDS: '15m' })).toThrow(
      'integer number of seconds',
    );
    expect(() => withOverride({ HQ_CONTROL_PLANE_STORAGE_FORCE_PATH_STYLE: 'yes' })).toThrow(
      'must be true or false',
    );
    expect(() => withOverride({ HQ_CONTROL_PLANE_STORAGE_BUCKET: 'Materials' })).toThrow(
      'HQ_CONTROL_PLANE_STORAGE_BUCKET must be',
    );
    expect(() => withOverride({ HQ_CONTROL_PLANE_STORAGE_BUCKET: 'a..b' })).toThrow(
      'HQ_CONTROL_PLANE_STORAGE_BUCKET must be',
    );
    expect(() => withOverride({ HQ_CONTROL_PLANE_STORAGE_REGION: 'EU Central' })).toThrow(
      'HQ_CONTROL_PLANE_STORAGE_REGION must be',
    );
    expect(() => withOverride({ HQ_CONTROL_PLANE_STORAGE_SECRET_ACCESS_KEY: 'short' })).toThrow(
      'HQ_CONTROL_PLANE_STORAGE_SECRET_ACCESS_KEY must contain at least 8 characters',
    );
    expect(() => withOverride({ HQ_CONTROL_PLANE_STORAGE_ACCESS_KEY_ID: 'has space' })).toThrow(
      'no whitespace',
    );
  });

  it('leaves storage absent when no HQ_CONTROL_PLANE_STORAGE_* value is set', () => {
    expect(loadControlPlaneConfig({}).storage).toBeUndefined();
    expect(
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_STORAGE_ENDPOINT: '   ' }).storage,
    ).toBeUndefined();
  });
});

describe('GitHub egress configuration', () => {
  const token = 'ghp_do_not_leak_this_github_token_0123456789';
  const githubEnvironment = {
    HQ_CONTROL_PLANE_GITHUB_TOKEN: token,
    HQ_CONTROL_PLANE_GITHUB_REPOSITORY: 'gremuchaya/headquarters',
  };

  it('keeps the token inside the closure and exposes only what an operator may read back', () => {
    const github = loadControlPlaneConfig(githubEnvironment).github;

    expect(github).toMatchObject({
      apiBaseUrl: 'https://api.github.com',
      repository: 'gremuchaya/headquarters',
      issueLabels: [],
      translationPathTemplate: 'translations/proposals/{locale}/{key}.json',
    });
    // The same property test the storage group takes: the credential is a
    // closure variable, so it is not a key, not serializable and not frozen
    // into the object anything downstream receives.
    expect(Object.keys(github ?? {}).sort()).toEqual([
      'apiBaseUrl',
      'issueLabels',
      'openToken',
      'repository',
      'translationPathTemplate',
    ]);
    expect(JSON.stringify(github)).not.toContain(token);
    expect(Object.isFrozen(github)).toBe(true);
    // Asking for it by name is the one way to obtain it.
    expect(github?.openToken()).toBe(token);
  });

  it('accepts an enterprise base, labels and a translation path within the rules', () => {
    const github = loadControlPlaneConfig({
      ...githubEnvironment,
      HQ_CONTROL_PLANE_GITHUB_API_BASE_URL: 'https://ghe.example.com/api/v3/',
      HQ_CONTROL_PLANE_GITHUB_ISSUE_LABELS: ' hq , report ,hq, ',
      HQ_CONTROL_PLANE_GITHUB_TRANSLATION_PATH: 'i18n/{locale}/{key}.json',
    }).github;

    // The trailing slash is stripped, so a path is appended exactly once.
    expect(github?.apiBaseUrl).toBe('https://ghe.example.com/api/v3');
    expect(github?.issueLabels).toEqual(['hq', 'report']);
    expect(github?.translationPathTemplate).toBe('i18n/{locale}/{key}.json');
  });

  it('refuses a partial group by naming what is missing, never the token it was given', () => {
    let error: Error | undefined;
    try {
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_GITHUB_TOKEN: token });
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    expect(error?.message).toContain('HQ_CONTROL_PLANE_GITHUB_REPOSITORY');
    expect(error?.message).toContain('must be set when GitHub egress is configured');
    expect(error?.message).not.toContain(token);

    expect(() =>
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_GITHUB_REPOSITORY: 'gremuchaya/headquarters' }),
    ).toThrow('HQ_CONTROL_PLANE_GITHUB_TOKEN');
  });

  it('refuses a value that would steer a request or disclose the token', () => {
    const withOverride = (overrides: Readonly<Record<string, string>>) =>
      loadControlPlaneConfig({ ...githubEnvironment, ...overrides });

    expect(() =>
      withOverride({ HQ_CONTROL_PLANE_GITHUB_REPOSITORY: 'a/b/../../elsewhere' }),
    ).toThrow('must be owner/name');
    expect(() => withOverride({ HQ_CONTROL_PLANE_GITHUB_TOKEN: 'ghp_short' })).toThrow(
      'at least 20 characters',
    );
    expect(() =>
      withOverride({ HQ_CONTROL_PLANE_GITHUB_TOKEN: `${token.slice(0, 25)}\n${token.slice(25)}` }),
    ).toThrow('no whitespace');
    // The token travels in a header on every call, so a cleartext base would
    // disclose the credential itself rather than a signature over one.
    expect(() =>
      withOverride({ HQ_CONTROL_PLANE_GITHUB_API_BASE_URL: 'http://api.example.com' }),
    ).toThrow('must be an HTTPS URL');
    expect(
      withOverride({ HQ_CONTROL_PLANE_GITHUB_API_BASE_URL: 'http://127.0.0.1:4200' }).github
        ?.apiBaseUrl,
    ).toBe('http://127.0.0.1:4200');
    expect(() =>
      withOverride({ HQ_CONTROL_PLANE_GITHUB_TRANSLATION_PATH: 'i18n/{locale}.json' }),
    ).toThrow('must contain both {locale} and {key}');
    expect(() =>
      withOverride({ HQ_CONTROL_PLANE_GITHUB_TRANSLATION_PATH: '../{locale}/{key}.json' }),
    ).toThrow('must be a relative path');
  });

  it('leaves GitHub absent when no HQ_CONTROL_PLANE_GITHUB_* value is set', () => {
    expect(loadControlPlaneConfig({}).github).toBeUndefined();
    expect(loadControlPlaneConfig({ HQ_CONTROL_PLANE_GITHUB_TOKEN: '  ' }).github).toBeUndefined();
  });
});
