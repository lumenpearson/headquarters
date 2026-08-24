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
      allowedOrigins: ['http://127.0.0.1:3000', 'https://hq.example.test'],
      databaseUrl,
      redis: { restUrl: 'https://hq-redis.upstash.io', restToken: 'upstash-token' },
    });
  });

  it('keeps health-only startup valid when no auth environment is supplied', () => {
    expect(loadControlPlaneConfig({})).toEqual({
      port: 4100,
      allowedOrigins: ['http://127.0.0.1:3000', 'http://localhost:3000'],
    });
    expect(
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_DATABASE_URL: databaseUrl }).auth,
    ).toBeUndefined();
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
});
