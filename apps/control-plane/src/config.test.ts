import { describe, expect, it } from 'vitest';

import { loadControlPlaneConfig } from './config.js';

describe('control-plane configuration', () => {
  it('normalizes an explicit origin allow-list and ephemeral port', () => {
    expect(
      loadControlPlaneConfig({
        HQ_CONTROL_PLANE_PORT: '0',
        HQ_CONTROL_PLANE_ALLOWED_ORIGINS:
          'http://127.0.0.1:3000, https://hq.example.test,http://127.0.0.1:3000',
        HQ_CONTROL_PLANE_DATABASE_URL:
          'postgresql://role:password@ep-hq.neon.tech/headquarters?sslmode=require',
        HQ_CONTROL_PLANE_REDIS_REST_URL: 'https://hq-redis.upstash.io',
        HQ_CONTROL_PLANE_REDIS_REST_TOKEN: 'upstash-token',
      }),
    ).toEqual({
      port: 0,
      allowedOrigins: ['http://127.0.0.1:3000', 'https://hq.example.test'],
      databaseUrl: 'postgresql://role:password@ep-hq.neon.tech/headquarters?sslmode=require',
      redis: { restUrl: 'https://hq-redis.upstash.io', restToken: 'upstash-token' },
    });
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
