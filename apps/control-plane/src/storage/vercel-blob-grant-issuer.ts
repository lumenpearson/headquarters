import type { BlobClientTokenRequest, ControlPlaneBlobStorageConfig } from '../config.js';
import type {
  StorageGrant,
  StorageGrantIssuer,
  StorageMultipartAbort,
  StorageMultipartCompletion,
  StorageMultipartHandle,
  StorageMultipartTarget,
  StorageObjectRequest,
  StorageObjectVerification,
  StorageObjectVerificationRequest,
  StoragePreviewGrant,
  StoragePreviewRequest,
  StorageUploadPartRequest,
} from '../material/service.js';
import type { UploadPartPlan } from '../material/store.js';

import { digestStream, parseDeclaredDigest } from './object-digest.js';
import type { StorageFetch, StorageFetchResponse } from './s3-grant-issuer.js';

/**
 * The Vercel Blob grant issuer: the second implementation of
 * {@link StorageGrantIssuer}, and a deliberately different one.
 *
 * **It plans one part and refuses any other.** Blob has a multipart API, but it
 * is driven from the client with a token this deployment mints, which is the
 * opposite of the port's design — the port exists so the *server* addresses each
 * part and the client only PUTs bytes to a URL. Rather than pretend, this issuer
 * declares `whole-object` in {@link StorageGrantIssuer.uploadPartPlan}, and
 * `DurableMaterialStore` plans exactly one part covering the object before it
 * writes anything. The declaration alone would not be enough: `issueUploadPart`
 * refuses a part number it was not asked for, because the failure it prevents
 * is the silent one correction C48 measured — several parts sent to one address,
 * each overwriting the last, leaving an object equal to the final slice under
 * the declared hash of the whole file.
 *
 * **It signs nothing itself.** An S3 grant is a signature over a URL; a Blob
 * grant is a URL plus a short-lived client token in a header. The token is
 * minted by `config.mintClientToken`, a closure over the deployment's
 * read-write token, so the credential reaches neither this object, nor a
 * response, nor an error text — and it is never persisted: nothing writes a
 * client token to a column, and `upload_sessions.storage_upload_id` receives a
 * constant naming the absence of a multipart upload instead.
 *
 * **A download grant is a public URL that does not expire.** A Blob store
 * serves its objects from `publicBaseUrl` with no signature to check, so
 * `expiresAt` on a download or preview grant says when the client should ask
 * again, not when the address stops working. That is a real difference from the
 * S3 issuer, stated here rather than discovered later.
 *
 * Nothing in this module has been presented to the live service: this
 * repository has no Blob store and no token. What is proved is the request
 * shape, the header set, the refusals and the digest round-trip, against a
 * scripted server that speaks the documented API.
 */

/** The API version header every documented Blob request carries. */
const blobApiVersion = '7';

/**
 * What `upload_sessions.storage_upload_id` holds for a Blob upload.
 *
 * The column is not nullable-by-meaning here: a session with no upload id is
 * the deduplicated path, which skips the completion *and the read-back*. A Blob
 * upload has bytes that must be verified, so it records a value — and the value
 * is this constant rather than the client token, because the column is durable
 * and a client token is a credential.
 *
 * `StorageUploadPartRequest.remoteUploadId` stays required in the port for the
 * same reason: making it optional changes the S3 contract, which addresses a
 * part by the bucket's own upload id, and correction C48 mandates that as a
 * separate decision rather than a passenger on this one.
 */
export const wholeObjectUploadId = 'vercel-blob-whole-object';

export class VercelBlobContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VercelBlobContractError';
  }
}

export class VercelBlobBackendError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    detail: string,
  ) {
    // The response body can echo the pathname; it never carries the token,
    // which travels in a header and is not reflected.
    super(`Vercel Blob ${operation} failed with status ${status.toString()}: ${detail}`);
    this.name = 'VercelBlobBackendError';
  }
}

export interface VercelBlobGrantIssuerOptions {
  /** Defaults to `globalThis.fetch`; injected so the delete and read-back are testable. */
  readonly fetch?: StorageFetch;
  readonly now?: () => Date;
}

export type VercelBlobGrantIssuerFactory = (
  config: ControlPlaneBlobStorageConfig,
  options?: VercelBlobGrantIssuerOptions,
) => StorageGrantIssuer;

export const createVercelBlobGrantIssuer: VercelBlobGrantIssuerFactory = (config, options = {}) => {
  const doFetch = options.fetch ?? defaultFetch;
  const now = options.now ?? (() => new Date());

  const uploadPartPlan: UploadPartPlan = {
    mode: 'whole-object',
    maxObjectBytes: config.maxObjectBytes,
  };

  return {
    uploadPartPlan,

    /**
     * Opens nothing.
     *
     * There is no multipart upload to open: the object arrives in one request
     * the client makes with its own token. The handle exists so the session
     * records that bytes are outstanding, which is what makes `CompleteUpload`
     * read the object back and verify it.
     */
    createMultipartUpload(_target: StorageMultipartTarget): StorageMultipartHandle {
      return { remoteUploadId: wholeObjectUploadId };
    },

    /**
     * Mints the grant for the one and only part.
     *
     * The refusal above the mint is the belt to the plan's braces: a store that
     * planned more than one part for this issuer would otherwise be handed one
     * address per slice and would assemble a corrupt object in silence.
     */
    issueUploadPart(request: StorageUploadPartRequest): StorageGrant {
      if (request.partNumber !== 1) {
        throw new VercelBlobContractError(
          'The Vercel Blob issuer signs one whole-object upload and cannot address part ' +
            `${request.partNumber.toString()}: the upload plan must be whole-object.`,
        );
      }
      const signedAt = now();
      const expiresAt = new Date(signedAt.getTime() + config.grantTtlMs);
      const tokenRequest: BlobClientTokenRequest = {
        pathname: request.storageKey,
        // The client sends the bytes and declares the type; the material's own
        // MIME type is not on this request, so the store decides nothing about
        // it here and the token binds only what it can name.
        contentType: 'application/octet-stream',
        maximumSizeInBytes: config.maxObjectBytes,
        validUntil: expiresAt,
      };
      return {
        url: objectUrl(config.apiBaseUrl, request.storageKey).toString(),
        expiresAt,
        requiredHeaders: {
          authorization: `Bearer ${config.mintClientToken(tokenRequest)}`,
          'x-api-version': blobApiVersion,
        },
      };
    },

    /**
     * Assembles nothing, because the whole object arrived in one request.
     *
     * The completion is not skipped in the caller: the same call site then reads
     * the object back and re-derives its digest, which is what decides whether
     * the material may point at these bytes.
     */
    completeMultipartUpload(completion: StorageMultipartCompletion): void {
      if (completion.parts.length > 1) {
        throw new VercelBlobContractError(
          'A Vercel Blob upload is one whole object; a completion naming ' +
            `${completion.parts.length.toString()} parts cannot be assembled.`,
        );
      }
    },

    /**
     * Removes the object, which is the only thing an abandoned Blob upload can
     * leave behind. There is no multipart upload for the store to reclaim
     * through a lifecycle rule, so a cancelled upload that wrote its bytes
     * would otherwise keep them forever.
     */
    async abortMultipartUpload(abort: StorageMultipartAbort): Promise<void> {
      const response = await callApi(
        'POST',
        new URL(`${config.apiBaseUrl}/delete`),
        JSON.stringify({ urls: [objectUrl(config.publicBaseUrl, abort.storageKey).toString()] }),
      );
      // An object that is already gone is the state an abort asks for.
      if (response.ok || response.status === 404) return;
      throw new VercelBlobBackendError('DeleteBlob', response.status, boundedDetail(response.body));
    },

    /**
     * Reads the stored object back and re-derives its digest.
     *
     * The read goes to the public origin rather than the API, because that is
     * where a Blob store serves bytes and it needs no credential. The digest
     * rule itself is the shared one in `object-digest.ts`: an unrecomputable
     * `content_hash` fails closed here exactly as it does for S3.
     */
    async verifyObject(
      request: StorageObjectVerificationRequest,
    ): Promise<StorageObjectVerification> {
      const declared = parseDeclaredDigest(request.contentHash);
      if (declared === undefined) return { outcome: 'unverifiable-digest' };

      const url = objectUrl(config.publicBaseUrl, request.storageKey);
      const response = await doFetch(url.toString(), { method: 'GET', headers: {} });
      if (response.status === 404) return { outcome: 'missing' };
      if (!response.ok) {
        throw new VercelBlobBackendError(
          'GetBlob',
          response.status,
          boundedDetail(await response.text()),
        );
      }
      const chunks = response.chunks?.();
      if (chunks === undefined) {
        throw new VercelBlobBackendError(
          'GetBlob',
          response.status,
          'response carried no readable body',
        );
      }
      const digest = await digestStream(declared.algorithm, chunks);
      if (digest.byteSize !== request.byteSize) {
        return { outcome: 'size-mismatch', actualByteSize: digest.byteSize };
      }
      if (digest.hex !== declared.hex) return { outcome: 'hash-mismatch' };
      return { outcome: 'verified' };
    },

    /**
     * The public address, with the store's own download switch.
     *
     * `?download=1` is what makes a Blob URL answer with an attachment
     * disposition; there is no per-request content type to override, because
     * the type is a property the object carries from its upload.
     */
    issueDownload(request: StorageObjectRequest): StorageGrant {
      const url = objectUrl(config.publicBaseUrl, request.storageKey);
      url.searchParams.set('download', '1');
      return { url: url.toString(), expiresAt: grantExpiry() };
    },

    /**
     * The same address without the download switch, so the preview renders in
     * place. The issuer decides nothing about which key it is handed:
     * `getPreviewGrant` resolves a variant to a rendition row and passes that
     * key when one has been built, or the original's when none has, and
     * reporting `request.mimeType` back is what lets the client tell the two
     * apart.
     */
    issuePreview(request: StoragePreviewRequest): StoragePreviewGrant {
      return {
        url: objectUrl(config.publicBaseUrl, request.storageKey).toString(),
        expiresAt: grantExpiry(),
        mimeType: request.mimeType,
      };
    },
  };

  function grantExpiry(): Date {
    return new Date(now().getTime() + config.grantTtlMs);
  }

  async function callApi(
    method: string,
    url: URL,
    body: string,
  ): Promise<StorageFetchResponse & { readonly body: string }> {
    const response = await doFetch(url.toString(), {
      method,
      headers: {
        // The deployment credential is opened at the moment it is spent and is
        // not held anywhere else in this module.
        authorization: `Bearer ${config.openToken()}`,
        'x-api-version': blobApiVersion,
        'content-type': 'application/json',
      },
      body,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text: () => Promise.resolve(text),
      body: text,
    };
  }
};

/**
 * Builds an object URL under an origin, percent-encoding each path segment so a
 * content hash's `:` is a path character and nothing else. The key is the
 * pathname the client uploads to and the pathname the store serves from, which
 * is what keeps a content-addressed key content-addressed.
 */
export function objectUrl(origin: string, storageKey: string): URL {
  const encodedKey = storageKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return new URL(`${origin}/${encodedKey}`);
}

/** Error bodies can be large; a bounded slice is enough to diagnose. */
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
    // `text` and `chunks` consume the same body, so exactly one of them is
    // called per response: the verification path reads chunks on success and
    // text only on the failure branch it never reaches afterwards.
    chunks: () => readResponseChunks(response.body),
  };
};

/**
 * A reader loop rather than `for await (const chunk of body)`: asynchronous
 * iteration over a `ReadableStream` is a Node extension, and the adapter is
 * meant to be readable by whichever runtime the deployment mounts.
 */
async function* readResponseChunks(
  body: ReadableStream<Uint8Array> | null,
): AsyncIterable<Uint8Array> {
  if (body === null) return;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
