import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { MaterialImportEntry } from './MaterialMirror.js';

const defaultGrantIdleTtlMs = 5 * 60 * 1000;
const defaultMaximumActiveGrants = 256;
const grantTokenPattern = /^[a-f0-9]{64}$/u;

export interface MaterialPlaybackSource {
  readonly material: MaterialImportEntry;
  readonly path: string;
}

export interface IssuedMaterialPlaybackGrant {
  readonly grantId: string;
  readonly url: string;
  readonly expiresAtMs: number;
  readonly mimeType: string;
  readonly byteSize: number;
}

interface ActiveMaterialPlaybackGrant extends MaterialPlaybackSource {
  readonly grantId: string;
  readonly tokenDigest: Buffer;
  expiresAtMs: number;
}

export class MaterialPlaybackGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterialPlaybackGrantError';
  }
}

/**
 * Keeps short-lived playback capabilities in process memory. A URL contains a
 * random bearer token but never a material path. Every successful range
 * request extends the five-minute idle deadline; explicit UI cleanup revokes
 * the grant immediately.
 */
export class MaterialPlaybackRegistry {
  readonly #grants = new Map<string, ActiveMaterialPlaybackGrant>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly idleTtlMs = defaultGrantIdleTtlMs,
    private readonly maximumActiveGrants = defaultMaximumActiveGrants,
  ) {
    if (!Number.isSafeInteger(idleTtlMs) || idleTtlMs <= 0) {
      throw new MaterialPlaybackGrantError('Playback grant TTL must be a positive integer.');
    }
    if (!Number.isSafeInteger(maximumActiveGrants) || maximumActiveGrants <= 0) {
      throw new MaterialPlaybackGrantError('Playback grant capacity must be a positive integer.');
    }
  }

  issue(source: MaterialPlaybackSource, loopbackOrigin: string): IssuedMaterialPlaybackGrant {
    assertPlaybackSource(source);
    const origin = normalizeLoopbackOrigin(loopbackOrigin);
    this.sweepExpired();
    if (this.#grants.size >= this.maximumActiveGrants) {
      throw new MaterialPlaybackGrantError('Playback grant capacity has been reached.');
    }

    const grantId = randomUUID();
    const token = randomBytes(32).toString('hex');
    const expiresAtMs = this.now() + this.idleTtlMs;
    this.#grants.set(grantId, {
      ...source,
      grantId,
      tokenDigest: digestToken(token),
      expiresAtMs,
    });
    return {
      grantId,
      url: `${origin}/v1/material-playback/${grantId}/${token}`,
      expiresAtMs,
      mimeType: source.material.mimeType,
      byteSize: source.material.byteSize,
    };
  }

  authorize(grantId: string, token: string): MaterialPlaybackSource | undefined {
    if (!isUuid(grantId) || !grantTokenPattern.test(token)) return undefined;
    const active = this.#grants.get(grantId);
    if (active === undefined) return undefined;
    if (active.expiresAtMs <= this.now()) {
      this.#grants.delete(grantId);
      return undefined;
    }
    if (!timingSafeEqual(active.tokenDigest, digestToken(token))) return undefined;
    active.expiresAtMs = this.now() + this.idleTtlMs;
    return { material: active.material, path: active.path };
  }

  revoke(grantId: string): boolean {
    return isUuid(grantId) && this.#grants.delete(grantId);
  }

  activeCount(): number {
    this.sweepExpired();
    return this.#grants.size;
  }

  clear(): void {
    this.#grants.clear();
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [grantId, grant] of this.#grants) {
      if (grant.expiresAtMs <= now) this.#grants.delete(grantId);
    }
  }
}

function assertPlaybackSource(source: MaterialPlaybackSource): void {
  const mimeType = source.material.mimeType.toLocaleLowerCase('en-US');
  if (!mimeType.startsWith('video/') && !mimeType.startsWith('audio/')) {
    throw new MaterialPlaybackGrantError(
      'Only audio and video materials can receive a playback grant.',
    );
  }
  if (!Number.isSafeInteger(source.material.byteSize) || source.material.byteSize < 0) {
    throw new MaterialPlaybackGrantError('Playback material size is invalid.');
  }
}

function normalizeLoopbackOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new Error('not loopback');
    }
    return url.origin;
  } catch {
    throw new MaterialPlaybackGrantError('Playback grants require an explicit loopback origin.');
  }
}

function digestToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
