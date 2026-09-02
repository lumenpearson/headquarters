import { createHash } from 'node:crypto';

import { blake3 } from '@noble/hashes/blake3.js';

/**
 * The digest rule the object-storage issuers share.
 *
 * It lives in its own module because there is more than one issuer now: the
 * S3-compatible one and the Vercel Blob one both have to decide whether the
 * bytes a store holds are the bytes a material declared, and two copies of that
 * decision is how a rule corrected in one issuer stays uncorrected in the other.
 * Nothing here performs IO or holds a credential; it reads a declared hash and
 * hashes a stream.
 */

/** The digest algorithms a declared `content_hash` may name. */
export type DeclaredDigestAlgorithm = 'blake3' | 'sha256';

export interface DeclaredDigest {
  readonly algorithm: DeclaredDigestAlgorithm;
  readonly hex: string;
}

/**
 * Reads the algorithm and the value out of a declared `content_hash`.
 *
 * Every client this repository ships computes a bare lowercase hexadecimal
 * BLAKE3 digest — `BrowserBlake3Hasher` in `apps/hq` and `MaterialMirror` in
 * `apps/file-bridge`, which validates `^[a-f0-9]{64}$` before it accepts one —
 * so an unprefixed 64-character digest is BLAKE3 and nothing else. The two
 * explicit prefixes exist so a future client can name what it computed instead
 * of relying on that convention.
 *
 * Anything else returns `undefined`, which the caller turns into a refusal.
 * `material_objects.content_hash` accepts a wider alphabet than this — it is a
 * storage-key-safe string, not a digest grammar — and the difference is the
 * point: a value the store will happily persist but nobody can recompute must
 * not reach a READY material.
 */
export function parseDeclaredDigest(contentHash: string): DeclaredDigest | undefined {
  const normalized = contentHash.trim();
  if (/^[0-9a-f]{64}$/u.test(normalized)) return { algorithm: 'blake3', hex: normalized };
  const prefixed = /^(blake3|sha256):([0-9a-f]{64})$/u.exec(normalized);
  const algorithm = prefixed?.[1];
  const hex = prefixed?.[2];
  if (algorithm === undefined || hex === undefined) return undefined;
  return { algorithm: algorithm === 'sha256' ? 'sha256' : 'blake3', hex };
}

export interface IncrementalDigest {
  update(chunk: Uint8Array): void;
  hex(): string;
}

/**
 * SHA-256 comes from `node:crypto`, which streams it natively; BLAKE3 has no
 * OpenSSL implementation to borrow, so it comes from `@noble/hashes`, the same
 * package both upload clients hash with. Using the clients' own implementation
 * is what makes agreement here mean agreement there.
 */
export function createDigest(algorithm: DeclaredDigestAlgorithm): IncrementalDigest {
  if (algorithm === 'sha256') {
    const hash = createHash('sha256');
    return {
      update: (chunk) => void hash.update(chunk),
      hex: () => hash.digest('hex'),
    };
  }
  const hash = blake3.create();
  return {
    update: (chunk) => void hash.update(chunk),
    hex: () => Buffer.from(hash.digest()).toString('hex'),
  };
}

export interface StreamDigest {
  readonly hex: string;
  readonly byteSize: bigint;
}

/**
 * Hashes a stored object chunk by chunk without ever buffering it.
 *
 * A material is a video file, not an XML document: holding one in memory to
 * hash it would put the largest upload the library accepts into the control
 * plane's heap. The byte count comes from the same pass, so a truncated object
 * is caught by the size comparison even before the digest disagrees.
 */
export async function digestStream(
  algorithm: DeclaredDigestAlgorithm,
  chunks: AsyncIterable<Uint8Array>,
): Promise<StreamDigest> {
  const digest = createDigest(algorithm);
  let byteSize = 0n;
  for await (const chunk of chunks) {
    digest.update(chunk);
    byteSize += BigInt(chunk.byteLength);
  }
  return { hex: digest.hex(), byteSize };
}
