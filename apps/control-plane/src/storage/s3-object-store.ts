import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import type { ControlPlaneStorageConfig } from '../config.js';
import type { Awaitable } from '../sync/lifecycle.js';

import { objectUrl, StorageBackendError } from './s3-grant-issuer.js';
import { emptyPayloadHash } from './sigv4.js';

/**
 * Reading and writing objects with the server's own credential.
 *
 * This is deliberately *not* part of {@link StorageGrantIssuer}. That port
 * exists to mint URLs a browser follows and to run the multipart lifecycle a
 * browser cannot; every one of its operations is on behalf of a client holding
 * an access token. These two are on behalf of the control plane itself: the
 * conversion worker fetches bytes nobody asked it for and writes bytes nobody
 * uploaded. Keeping them on their own port means a deployment with no worker
 * builds no reader and no writer, and means the grant issuer's surface does not
 * grow an operation that hands raw object bytes to whoever holds the object.
 *
 * Both operations move through the filesystem rather than through memory.
 * ffmpeg reads a file and writes a file, and a source in this library is a video
 * take: buffering one to hash it would put the largest upload the library
 * accepts into the control plane's heap, which is the same reason
 * `verifyObject` streams.
 *
 * The credential never reaches this module. Signing is the closure
 * {@link ControlPlaneStorageConfig} carries, exactly as in the grant issuer, so
 * no pepper, key or secret can be read off this object, its errors or its
 * results.
 */

/** The subset of a Fetch response this module reads. */
export interface ObjectStoreResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  /** The body as a stream of chunks; only the download reads it. */
  chunks?(): AsyncIterable<Uint8Array>;
}

export interface ObjectStoreRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** A file the request streams as its body, for the upload. */
  readonly bodyPath?: string;
  readonly bodyByteLength?: number;
}

export type ObjectStoreFetch = (
  url: string,
  request: ObjectStoreRequest,
) => Awaitable<ObjectStoreResponse>;

/**
 * What the conversion worker needs from a bucket, and nothing else.
 *
 * A port rather than a class so the worker's tests drive a store that writes to
 * a map, and so a second issuer (a Vercel Blob store, say) can satisfy it
 * without inheriting the S3 signer.
 */
export interface ConversionObjectStore {
  /** Streams the object at `storageKey` into `destinationPath`. */
  downloadObject(storageKey: string, destinationPath: string): Promise<void>;
  /** Writes `sourcePath` to `storageKey` as a single PUT. */
  uploadObject(storageKey: string, sourcePath: string, mimeType: string): Promise<void>;
}

export interface S3ObjectStoreOptions {
  readonly fetch?: ObjectStoreFetch;
  readonly now?: () => Date;
  /**
   * The largest object this store will PUT whole.
   *
   * A rendition is a derived, size-bounded artifact, so one PUT is the right
   * shape and multipart would be ceremony. The ceiling exists because a single
   * PUT is capped by every S3-compatible service -- 5 GiB on AWS -- and because
   * a render that produced something enormous is a failure worth naming rather
   * than an upload worth attempting.
   */
  readonly maxUploadBytes?: number;
}

const defaultMaxUploadBytes = 512 * 1024 * 1024;

export function createS3ObjectStore(
  config: ControlPlaneStorageConfig,
  options: S3ObjectStoreOptions = {},
): ConversionObjectStore {
  const doFetch = options.fetch ?? defaultObjectStoreFetch;
  const now = options.now ?? (() => new Date());
  const maxUploadBytes = options.maxUploadBytes ?? defaultMaxUploadBytes;

  return {
    async downloadObject(storageKey: string, destinationPath: string): Promise<void> {
      const url = objectUrl(config, storageKey);
      const headers = config.sign({
        method: 'GET',
        url,
        headers: {},
        payloadHash: emptyPayloadHash,
        signedAt: now(),
      });
      const response = await doFetch(url.toString(), { method: 'GET', headers });
      if (!response.ok) {
        throw new StorageBackendError('GetObject', response.status, bounded(await response.text()));
      }
      const chunks = response.chunks?.();
      if (chunks === undefined) {
        throw new StorageBackendError('GetObject', response.status, 'response carried no body');
      }
      // Straight to disk. The worker's next step hands this path to ffmpeg, so
      // there is never a moment where the whole source is in the heap.
      await pipeline(Readable.from(chunks), createWriteStream(destinationPath));
    },

    async uploadObject(storageKey: string, sourcePath: string, mimeType: string): Promise<void> {
      const { size } = await stat(sourcePath);
      if (size <= 0) {
        throw new StorageBackendError('PutObject', 0, 'refusing to store a zero-byte rendition');
      }
      if (size > maxUploadBytes) {
        throw new StorageBackendError(
          'PutObject',
          0,
          `rendition of ${size.toString()} bytes exceeds the ${maxUploadBytes.toString()}-byte single-PUT ceiling`,
        );
      }
      // SigV4 signs a payload digest, so the file is hashed before it is sent.
      // That is a second pass over the file rather than a second copy of it in
      // memory; UNSIGNED-PAYLOAD would avoid the pass and would also mean the
      // signature no longer binds the bytes to the request.
      const payloadHash = await filePayloadHash(sourcePath);
      const url = objectUrl(config, storageKey);
      const headers = config.sign({
        method: 'PUT',
        url,
        headers: { 'content-type': mimeType, 'content-length': size.toString() },
        payloadHash,
        signedAt: now(),
      });
      const response = await doFetch(url.toString(), {
        method: 'PUT',
        headers,
        bodyPath: sourcePath,
        bodyByteLength: size,
      });
      if (!response.ok) {
        throw new StorageBackendError('PutObject', response.status, bounded(await response.text()));
      }
    },
  };
}

async function filePayloadHash(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk as Uint8Array);
  }
  return digest.digest('hex');
}

/**
 * The bucket's error body can echo request metadata; it never carries a
 * credential, because the credential is in a signature rather than a parameter.
 * Bounded for the same reason the grant issuer bounds its own.
 */
function bounded(text: string): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) return 'empty response body';
  return collapsed.length > 300 ? `${collapsed.slice(0, 297)}...` : collapsed;
}

const defaultObjectStoreFetch: ObjectStoreFetch = async (url, request) => {
  const body =
    request.bodyPath === undefined
      ? undefined
      : // A stream body, so the rendition is never held whole in the heap.
        // `duplex: 'half'` is required by the Fetch standard for a streaming
        // request body and is not yet in the DOM types Node ships against.
        (Readable.toWeb(
          createReadStream(request.bodyPath),
        ) as unknown as ReadableStream<Uint8Array>);
  const response = await fetch(url, {
    method: request.method,
    headers: { ...request.headers },
    ...(body === undefined ? {} : { body, duplex: 'half' }),
  } as RequestInit);
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
    chunks: () => streamChunks(response),
  };
};

async function* streamChunks(response: Response): AsyncIterable<Uint8Array> {
  const body = response.body;
  if (body === null) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
