import type { ControlPlaneStorageConfig } from '../config.js';
import type {
  StorageGrant,
  StorageGrantIssuer,
  StorageMultipartAbort,
  StorageMultipartCompletion,
  StorageMultipartHandle,
  StorageMultipartTarget,
  StorageObjectRequest,
  StoragePreviewGrant,
  StoragePreviewRequest,
  StorageUploadPartRequest,
} from '../material/service.js';
import type { Awaitable } from '../sync/lifecycle.js';

import { emptyPayloadHash, sha256Hex } from './sigv4.js';

/**
 * An S3-compatible object-storage grant issuer.
 *
 * The three URL-minting operations — part upload, download, preview — are pure
 * SigV4 presigning and make no network call: whoever holds the URL talks to the
 * bucket directly, which is the whole point of a grant. The three lifecycle
 * operations — create, complete and abort a multipart upload — are the calls
 * the control plane must make itself, because each carries the server's own
 * credential and cannot be a URL a browser follows. They go through an
 * injected `fetch` so a test can drive the multipart path without a bucket.
 *
 * The issuer never holds a secret. Signing is delegated to the
 * {@link ControlPlaneStorageConfig} closures the configuration parser built
 * over the access key pair, so the secret never reaches this object, its
 * responses, or its error text. Addressing follows the S3 API Reference:
 * `{bucket}.{endpoint-host}/{key}` virtual-hosted style by default, or
 * `{endpoint}/{bucket}/{key}` path style for MinIO-like endpoints whose host
 * is not the bucket's DNS parent.
 */

/** The subset of a Fetch response the issuer reads, so a test need not build a whole one. */
export interface StorageFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface StorageFetchRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export type StorageFetch = (
  url: string,
  request: StorageFetchRequest,
) => Awaitable<StorageFetchResponse>;

export interface S3GrantIssuerOptions {
  /** Defaults to `globalThis.fetch`; injected so the multipart calls are testable. */
  readonly fetch?: StorageFetch;
  readonly now?: () => Date;
}

export type StorageGrantIssuerFactory = (
  config: ControlPlaneStorageConfig,
  options?: S3GrantIssuerOptions,
) => StorageGrantIssuer;

export class StorageBackendError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    detail: string,
  ) {
    // The bucket's error body can echo request metadata; it never carries a
    // credential, because the credential is in a signature, not a parameter. The
    // status and a bounded detail are enough to diagnose without leaking a URL.
    super(`Object storage ${operation} failed with status ${status.toString()}: ${detail}`);
    this.name = 'StorageBackendError';
  }
}

export const createS3GrantIssuer: StorageGrantIssuerFactory = (config, options = {}) => {
  const doFetch = options.fetch ?? defaultFetch;
  const now = options.now ?? (() => new Date());

  function presignGrant(method: string, url: URL): StorageGrant {
    const signedAt = now();
    return {
      url: config.presign({ method, url, signedAt }).toString(),
      expiresAt: new Date(signedAt.getTime() + config.grantTtlMs),
    };
  }

  async function callBucket(
    method: string,
    url: URL,
    body: string | undefined,
    extraHeaders: Readonly<Record<string, string>>,
  ): Promise<StorageFetchResponse & { readonly body: string }> {
    const payloadHash = body === undefined ? emptyPayloadHash : sha256Hex(body);
    const headers = config.sign({
      method,
      url,
      headers: extraHeaders,
      payloadHash,
      signedAt: now(),
    });
    const response = await doFetch(url.toString(), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text: () => Promise.resolve(text),
      body: text,
    };
  }

  async function requireOk(
    operation: string,
    method: string,
    url: URL,
    body: string | undefined,
    extraHeaders: Readonly<Record<string, string>>,
  ): Promise<string> {
    const response = await callBucket(method, url, body, extraHeaders);
    // A multipart completion can answer HTTP 200 and still carry an `<Error>`
    // body, so success is both an OK status and the absence of that element.
    if (!response.ok || /<Error>/u.test(response.body)) {
      throw new StorageBackendError(operation, response.status, boundedDetail(response.body));
    }
    return response.body;
  }

  return {
    async createMultipartUpload(target: StorageMultipartTarget): Promise<StorageMultipartHandle> {
      const url = objectUrl(config, target.storageKey);
      url.searchParams.set('uploads', '');
      const body = await requireOk('CreateMultipartUpload', 'POST', url, undefined, {
        'content-type': target.mimeType,
      });
      const remoteUploadId = extractElement(body, 'UploadId');
      if (remoteUploadId === undefined) {
        throw new StorageBackendError('CreateMultipartUpload', 200, 'response carried no UploadId');
      }
      return { remoteUploadId };
    },

    issueUploadPart(request: StorageUploadPartRequest): StorageGrant {
      const url = objectUrl(config, request.storageKey);
      url.searchParams.set('partNumber', request.partNumber.toString());
      url.searchParams.set('uploadId', request.remoteUploadId);
      return presignGrant('PUT', url);
    },

    async completeMultipartUpload(completion: StorageMultipartCompletion): Promise<void> {
      const url = objectUrl(config, completion.storageKey);
      url.searchParams.set('uploadId', completion.remoteUploadId);
      const response = await callBucket('POST', url, completeMultipartBody(completion.parts), {
        'content-type': 'application/xml',
      });
      if (response.ok && !/<Error>/u.test(response.body)) return;
      // `NoSuchUpload` after a completion that already succeeded is the retry
      // case: the bucket assembled the object and the database step that
      // followed did not commit. The object at the content-addressed key is the
      // proof; a HEAD that finds it means there is nothing left to complete.
      if (response.status === 404 && /NoSuchUpload/u.test(response.body)) {
        const head = await callBucket(
          'HEAD',
          objectUrl(config, completion.storageKey),
          undefined,
          {},
        );
        if (head.ok) return;
      }
      throw new StorageBackendError(
        'CompleteMultipartUpload',
        response.status,
        boundedDetail(response.body),
      );
    },

    async abortMultipartUpload(abort: StorageMultipartAbort): Promise<void> {
      const url = objectUrl(config, abort.storageKey);
      url.searchParams.set('uploadId', abort.remoteUploadId);
      const response = await callBucket('DELETE', url, undefined, {});
      // An upload that is already gone is the state an abort asks for.
      if (response.ok || (response.status === 404 && /NoSuchUpload/u.test(response.body))) return;
      throw new StorageBackendError(
        'AbortMultipartUpload',
        response.status,
        boundedDetail(response.body),
      );
    },

    issueDownload(request: StorageObjectRequest): StorageGrant {
      const url = objectUrl(config, request.storageKey);
      // An attachment disposition is what makes a browser save the original
      // file rather than try to render it in place.
      url.searchParams.set('response-content-disposition', 'attachment');
      url.searchParams.set('response-content-type', request.mimeType);
      return presignGrant('GET', url);
    },

    issuePreview(request: StoragePreviewRequest): StoragePreviewGrant {
      const url = objectUrl(config, request.storageKey);
      // Inline, so the preview renders where it is shown. No rendered variant
      // exists on the server — `conversion_jobs` is reached by no code — so
      // every variant is the original object, and the grant says so by
      // reporting the original's MIME type.
      url.searchParams.set('response-content-disposition', 'inline');
      url.searchParams.set('response-content-type', request.mimeType);
      return { ...presignGrant('GET', url), mimeType: request.mimeType };
    },
  };
};

/**
 * Builds the object URL in the addressing style the endpoint uses. The key is
 * split on `/` and each segment percent-encoded, so a content hash's `:` is a
 * path character and nothing else. The signer re-derives the canonical path
 * from the decoded form, so the encoding here only has to be a valid one.
 */
function objectUrl(config: ControlPlaneStorageConfig, storageKey: string): URL {
  const endpoint = new URL(config.endpoint);
  const encodedKey = storageKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  if (config.forcePathStyle) {
    return new URL(`${endpoint.origin}/${config.bucket}/${encodedKey}`);
  }
  return new URL(`${endpoint.protocol}//${config.bucket}.${endpoint.host}/${encodedKey}`);
}

function completeMultipartBody(
  parts: readonly { readonly partNumber: number; readonly etag: string }[],
): string {
  const ordered = [...parts].sort((left, right) => left.partNumber - right.partNumber);
  const body = ordered
    .map(
      (part) =>
        `<Part><PartNumber>${part.partNumber.toString()}</PartNumber>` +
        `<ETag>${escapeXml(part.etag)}</ETag></Part>`,
    )
    .join('');
  return `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body}</CompleteMultipartUpload>`;
}

function extractElement(xml: string, element: string): string | undefined {
  const match = new RegExp(`<${element}>([^<]+)</${element}>`, 'u').exec(xml);
  return match?.[1];
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Bucket error bodies can be large; a bounded slice is enough to diagnose. */
function boundedDetail(text: string): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) return 'empty response body';
  return collapsed.length > 300 ? `${collapsed.slice(0, 297)}...` : collapsed;
}

const defaultFetch: StorageFetch = async (url, request) => {
  const response = await fetch(url, {
    method: request.method,
    headers: { ...request.headers },
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
  };
};
