import { describe, expect, it } from 'vitest';

import { MaterialPlaybackRegistry } from './MaterialPlaybackRegistry.js';

const source = {
  path: 'C:\\mirror\\opaque-object',
  material: {
    materialId: '018f0f1a-8000-7000-8000-000000000000',
    displayName: 'camera-loop.mp4',
    mimeType: 'video/mp4',
    byteSize: 1024,
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-18T00:00:00.000Z',
  },
} as const;

describe('MaterialPlaybackRegistry', () => {
  it('issues an opaque loopback capability and never serializes the object path', () => {
    const registry = new MaterialPlaybackRegistry(() => 1_000, 300_000, 4);
    const grant = registry.issue(source, 'http://127.0.0.1:4177');

    expect(grant.url).toMatch(
      /^http:\/\/127\.0\.0\.1:4177\/v1\/material-playback\/[0-9a-f-]{36}\/[0-9a-f]{64}$/u,
    );
    expect(grant.url).not.toContain('opaque-object');
    const [, grantId, token] = grant.url.match(
      /\/v1\/material-playback\/([0-9a-f-]{36})\/([0-9a-f]{64})$/u,
    ) ?? ['', '', ''];
    expect(registry.authorize(grantId, token)).toEqual(source);
    expect(registry.authorize(grantId, '0'.repeat(64))).toBeUndefined();
  });

  it('expires after idle time and supports explicit revocation', () => {
    let now = 10_000;
    const registry = new MaterialPlaybackRegistry(() => now, 1_000, 4);
    const grant = registry.issue(source, 'http://127.0.0.1:4177');
    const token = grant.url.slice(grant.url.lastIndexOf('/') + 1);

    now = 10_999;
    expect(registry.authorize(grant.grantId, token)).toBeDefined();
    now = 12_000;
    expect(registry.authorize(grant.grantId, token)).toBeUndefined();

    now = 20_000;
    const second = registry.issue(source, 'http://127.0.0.1:4177');
    expect(registry.revoke(second.grantId)).toBe(true);
    expect(registry.revoke(second.grantId)).toBe(false);
  });

  it('rejects non-media grants and non-loopback origins', () => {
    const registry = new MaterialPlaybackRegistry();
    expect(() =>
      registry.issue(
        { ...source, material: { ...source.material, mimeType: 'application/pdf' } },
        'http://127.0.0.1:4177',
      ),
    ).toThrow(/audio and video/u);
    expect(() => registry.issue(source, 'https://example.test')).toThrow(/loopback origin/u);
  });
});
