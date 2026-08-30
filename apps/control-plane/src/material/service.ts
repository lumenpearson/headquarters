import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { ControlPlaneFailure, materialV1 } from '@gremuchaya/protocol';
import type { MaterialService } from '@gremuchaya/protocol';

import { controlPlaneFailure, toControlPlaneConnectError, withRuntimeErrors } from '../errors.js';
import { renditionLadderFor, renditionSpecFor } from '../conversion/ladder.js';
import type { ConversionQueueOutcome, RenditionRecord } from '../conversion/store.js';
import type { Awaitable, PairedDeviceLifecycle } from '../sync/lifecycle.js';
import {
  MutationRequestIdError,
  normalizeRequestId,
  type MutationReceiptContext,
} from '../sync/receipts.js';
import { PairedDeviceRuntimeError, type AuthenticatedDevice } from '../sync/runtime.js';

import { multipartUploadPlan, storageKeyFor } from './store.js';
import type {
  CompletedUploadPartInput,
  DurableMaterialStore,
  MaterialCategoryName,
  MaterialEventKindName,
  MaterialEventRecord,
  MaterialRecord,
  MaterialStatusName,
  MaterialVersionRecord,
  StoredObjectLocation,
  UploadPartPlan,
  UploadPartRecord,
  UploadSessionRecord,
  UploadStateName,
} from './store.js';

/**
 * ConnectRPC adapter for `MaterialService`.
 *
 * Everything about a material that this deployment can answer from PostgreSQL
 * is answered here. A URL — `UploadPartGrant.upload_url`, `DownloadGrant.url`,
 * `PreviewGrant.url` — presupposes an object store, which arrives as the
 * injected {@link StorageGrantIssuer} once `HQ_CONTROL_PLANE_STORAGE_*` is
 * configured. Without it, rather than return an empty string a client cannot
 * tell from a real address, the four RPCs that would have to mint one refuse
 * with `FAILED_PRECONDITION` naming the missing configuration, and the other
 * twelve work either way.
 */

/** What a multipart upload needs before any part can be addressed. */
export interface StorageMultipartTarget {
  readonly storageKey: string;
  readonly mimeType: string;
}

/** The object store's own identifier for a multipart upload it just opened. */
export interface StorageMultipartHandle {
  readonly remoteUploadId: string;
}

/**
 * One part of a multipart upload, as the object store needs it described.
 *
 * `remoteUploadId` is the store's identifier from {@link StorageMultipartHandle},
 * not the control plane's `upload_sessions.id`: S3 addresses a part by the
 * bucket's own upload id, which only exists once the multipart upload is open.
 */
export interface StorageUploadPartRequest {
  readonly remoteUploadId: string;
  readonly storageKey: string;
  readonly partNumber: number;
}

/** One finished part, named by the etag the store returned for it. */
export interface StorageCompletedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface StorageMultipartCompletion {
  readonly storageKey: string;
  readonly remoteUploadId: string;
  readonly parts: readonly StorageCompletedPart[];
}

export interface StorageMultipartAbort {
  readonly storageKey: string;
  readonly remoteUploadId: string;
}

export interface StorageObjectRequest {
  readonly materialId: string;
  readonly versionId: string;
  readonly storageKey: string;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly byteSize: bigint;
}

/**
 * What an assembled object must turn out to be before a version may name it.
 *
 * `contentHash` is the digest the *database* holds for the material, not the
 * one the completion request carried: the completion statement already refuses
 * a request whose hash differs from the material's, so re-deriving it from the
 * request would only reintroduce a client-chosen value into the check.
 */
export interface StorageObjectVerificationRequest {
  readonly storageKey: string;
  readonly contentHash: string;
  readonly byteSize: bigint;
}

/**
 * The outcome of that check.
 *
 * It is a value rather than an exception because none of these outcomes is a
 * storage failure: the store answered, and what it holds is not what the
 * client declared. `unverifiable-digest` is the fail-closed case — a
 * `content_hash` in a format the issuer cannot recompute is refused rather
 * than waved through, because a digest nobody checks is the gap this exists
 * to close.
 */
export type StorageObjectVerification =
  | { readonly outcome: 'verified' }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'size-mismatch'; readonly actualByteSize: bigint }
  | { readonly outcome: 'hash-mismatch' }
  | { readonly outcome: 'unverifiable-digest' };

export interface StoragePreviewRequest extends StorageObjectRequest {
  readonly variant: string;
}

export interface StorageGrant {
  readonly url: string;
  readonly expiresAt: Date;
  readonly requiredHeaders?: Readonly<Record<string, string>>;
}

export interface StoragePreviewGrant extends StorageGrant {
  readonly mimeType?: string;
  readonly width?: number;
  readonly height?: number;
}

/**
 * The seam between the material library and whatever stores its bytes.
 *
 * It is a port rather than a client so the bucket's credentials stay in a
 * configuration closure and never reach this service, its responses, or its
 * error text. Deployments that configure no storage leave it absent, and the
 * four RPCs that would spend it keep refusing with `FAILED_PRECONDITION`.
 *
 * The three URL-minting operations are pure presigning; the three multipart
 * lifecycle operations plus {@link StorageGrantIssuer.verifyObject} are calls
 * the control plane makes itself, because a `CreateMultipartUpload`,
 * `CompleteMultipartUpload`, `AbortMultipartUpload` or read-back of the
 * assembled object carries a server credential and cannot be a URL handed to a
 * browser.
 */
export interface StorageGrantIssuer {
  /**
   * How this issuer wants an upload split, read before the store plans a single
   * part.
   *
   * It is declarative rather than a capability the service infers, because the
   * failure it prevents is silent: an issuer that signs one address for the
   * whole object, handed a five-part plan, would receive five PUTs to one URL
   * and assemble an object equal to the last slice under the declared hash of
   * the whole file. Correction C48 measured that trap; `UploadPartPlan`
   * documents the order that closes it.
   *
   * Optional, and absent means `multipart`. Every issuer that existed before
   * this field was added is S3-compatible and multipart is what it wants, so an
   * absent value is the historically correct answer rather than a guess. An
   * issuer that cannot address a part must both declare `whole-object` here and
   * refuse a part it was not asked to sign -- declaring alone would leave the
   * corruption one forgotten line away.
   */
  readonly uploadPartPlan?: UploadPartPlan;
  createMultipartUpload(target: StorageMultipartTarget): Awaitable<StorageMultipartHandle>;
  issueUploadPart(request: StorageUploadPartRequest): Awaitable<StorageGrant>;
  completeMultipartUpload(completion: StorageMultipartCompletion): Awaitable<void>;
  abortMultipartUpload(abort: StorageMultipartAbort): Awaitable<void>;
  /**
   * Decides whether the object at `storageKey` is the content the material
   * reserved. It is a required member, not an optional one: an issuer that
   * could omit it would leave `content_hash` unchecked in exactly the
   * deployments nobody audits.
   */
  verifyObject(request: StorageObjectVerificationRequest): Awaitable<StorageObjectVerification>;
  issueDownload(request: StorageObjectRequest): Awaitable<StorageGrant>;
  issuePreview(request: StoragePreviewRequest): Awaitable<StoragePreviewGrant>;
}

/**
 * The rendition half of the library, as this service needs it.
 *
 * Two operations and no more: read what has been built for a variant, and queue
 * what has not. It is a narrow port rather than the conversion store itself so
 * that a deployment with no worker -- and every deployment before this pipeline
 * existed -- simply omits it, and `GetPreviewGrant` goes on signing the original
 * for every variant exactly as it did.
 */
export interface MaterialRenditionPort {
  readRendition(
    authenticated: AuthenticatedDevice,
    materialId: string,
    versionId: string,
    variant: string,
  ): Awaitable<RenditionRecord | undefined>;
  enqueueRenditions(
    authenticated: AuthenticatedDevice,
    materialId: string,
    versionId: string,
    variants: readonly string[],
  ): Awaitable<ConversionQueueOutcome>;
}

export interface MaterialServiceOptions {
  /** Authentication only: every material authorization decision is made in SQL. */
  readonly runtime: PairedDeviceLifecycle;
  readonly store: DurableMaterialStore;
  /** Absent until a bucket is configured; see the note on this module. */
  readonly storage?: StorageGrantIssuer;
  /**
   * Absent until the conversion pipeline is configured. Without it the quality
   * ladder is what it has always been: a menu whose every entry resolves to the
   * stored object, which the grant reports honestly by carrying the original's
   * own MIME type and no dimensions.
   */
  readonly renditions?: MaterialRenditionPort;
  /** How often `WatchMaterialEvents` re-reads `materials.updated_at`. */
  readonly watchPollIntervalMs?: number;
  readonly watchBatchSize?: number;
}

const defaultWatchPollIntervalMs = 1_000;
const defaultWatchBatchSize = 64;
/** The states in which an upload session still has a multipart upload to finish or abort. */
const openUploadStates: ReadonlySet<UploadStateName> = new Set<UploadStateName>([
  'PENDING',
  'UPLOADING',
  'VERIFYING',
]);

export function createMaterialService(
  options: MaterialServiceOptions,
): Partial<ServiceImpl<typeof MaterialService>> {
  const pollIntervalMs = positiveInteger(
    options.watchPollIntervalMs ?? defaultWatchPollIntervalMs,
    'watchPollIntervalMs',
  );
  const batchSize = positiveInteger(
    options.watchBatchSize ?? defaultWatchBatchSize,
    'watchBatchSize',
  );

  return {
    async listMaterials(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options.runtime, context);
        const page = await options.store.listMaterials(
          authenticated,
          requireResourceId(request.groupId?.value, 'group_id'),
          request.page?.pageSize ?? 0,
          request.page?.cursor ?? '',
        );
        return {
          materials: page.items.map(toProtocolMaterial),
          page: toPageInfo(page.nextCursor, page.hasMore, page.approximateTotal),
        };
      });
    },

    async getMaterial(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options.runtime, context);
        const found = await options.store.getMaterial(
          authenticated,
          requireResourceId(request.materialId?.value, 'material_id'),
        );
        return {
          material: toProtocolMaterial(found.material),
          ...(found.currentVersion === undefined
            ? {}
            : { currentVersion: toProtocolVersion(found.currentVersion) }),
        };
      });
    },

    /**
     * Creates a material and, unless the group already holds its bytes,
     * reserves the parts they will arrive in.
     *
     * The storage issuer is required before anything is written, even though a
     * deduplicated upload never needs one. Whether deduplication applies is
     * decided by the same statement that creates the material, so a check
     * afterwards could only be made by leaving a half-created material behind —
     * a worse answer than refusing the call.
     */
    async beginUpload(request, context) {
      return withRuntimeErrors(async () => {
        const storage = requireStorage(options.storage, 'upload');
        const authenticated = await authenticate(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const begun = await callWithMutation(
          toMutationReceiptContext(request.context?.requestId),
          (mutation) =>
            options.store.beginUpload(
              authenticated,
              {
                groupId: requireResourceId(request.groupId?.value, 'group_id'),
                ...(request.materialId?.value === undefined || request.materialId.value.length === 0
                  ? {}
                  : { materialId: request.materialId.value }),
                displayName: request.displayName,
                originalFileName: request.originalFileName,
                category: toCategoryName(request.category),
                mimeType: request.mimeType,
                totalSize: request.totalSize,
                contentHash: request.contentHash,
                metadata: request.metadata,
                // The issuer is asked before a single part is planned. See
                // `UploadPartPlan`: the reverse order silently corrupts an
                // object whenever the issuer cannot address a part.
                partPlan: storage.uploadPartPlan ?? multipartUploadPlan,
              },
              ...mutation,
            ),
        );
        return {
          session: toProtocolSession(begun.session),
          parts: await openMultipartAndIssueParts(storage, options.store, authenticated, {
            session: begun.session,
            storageKey: begun.storageKey,
            mimeType: request.mimeType,
            parts: begun.parts,
            deduplicated: begun.deduplicated,
          }),
          deduplicated: begun.deduplicated,
        };
      });
    },

    async getUploadStatus(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options.runtime, context);
        const status = await options.store.getUploadStatus(
          authenticated,
          requireResourceId(request.uploadId?.value, 'upload_id'),
        );
        return {
          session: toProtocolSession(status.session),
          completedParts: [...status.completedParts],
        };
      });
    },

    async completeUpload(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const uploadId = requireResourceId(request.uploadId?.value, 'upload_id');
        const completedParts = request.parts.map(toCompletedPart);
        // The bucket's own multipart upload is finished first: the assembled
        // object must exist before the material points at it, or a download
        // grant would presign a GET to a key with no object behind it. The
        // same step reads the object back and re-derives its digest, so the
        // database completion below can only run over bytes that really are
        // the content the material reserved.
        await assembleAndVerifyStoredObject(options, authenticated, uploadId, completedParts);
        const completed = await callWithMutation(
          toMutationReceiptContext(request.context?.requestId),
          (mutation) =>
            options.store.completeUpload(
              authenticated,
              uploadId,
              request.contentHash,
              completedParts,
              ...mutation,
            ),
        );
        // The ladder is queued after the version exists, never before: a job
        // pointing at a version no statement has recorded would be claimed,
        // find nothing to convert, and burn an attempt. It is best-effort for
        // the opposite reason -- the bytes are stored and the version is
        // recorded, so an unreachable queue must not turn a finished upload
        // into a failed RPC. Nothing is lost: `GetPreviewGrant` queues the
        // same rung the first time anyone opens the menu.
        await queueRenditionLadder(
          options,
          authenticated,
          completed.material.id,
          completed.version,
        );
        return {
          material: toProtocolMaterial(completed.material),
          version: toProtocolVersion(completed.version),
        };
      });
    },

    async cancelUpload(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const uploadId = requireResourceId(request.uploadId?.value, 'upload_id');
        // Read the multipart target while the session still exists, then cancel
        // it in the database, then abort it in the bucket. The abort is
        // best-effort: an S3-compatible store reclaims an abandoned multipart
        // upload through its own lifecycle rules, so a failed abort must not
        // undo a cancellation the database already recorded.
        const abort = await resolveStorageAbort(options, authenticated, uploadId);
        const cancelled = await callWithMutation(
          toMutationReceiptContext(request.context?.requestId),
          (mutation) => options.store.cancelUpload(authenticated, uploadId, ...mutation),
        );
        if (abort !== undefined) {
          await Promise.resolve(
            abort.issuer.abortMultipartUpload({
              storageKey: abort.storageKey,
              remoteUploadId: abort.remoteUploadId,
            }),
          ).catch(() => undefined);
        }
        return {
          result: {
            resourceId: { value: cancelled.uploadId },
            correlationId: request.context?.correlationId ?? '',
          },
        };
      });
    },

    async createMaterialVersion(request, context) {
      return withRuntimeErrors(async () => {
        const storage = requireStorage(options.storage, 'upload');
        const authenticated = await authenticate(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const created = await callWithMutation(
          toMutationReceiptContext(request.context?.requestId),
          (mutation) =>
            options.store.createMaterialVersion(
              authenticated,
              {
                groupId: authenticated.group.id,
                materialId: requireResourceId(request.materialId?.value, 'material_id'),
                originalFileName: request.originalFileName,
                mimeType: request.mimeType,
                totalSize: request.totalSize,
                contentHash: request.contentHash,
                partPlan: storage.uploadPartPlan ?? multipartUploadPlan,
              },
              ...mutation,
            ),
        );
        return {
          session: toProtocolSession(created.session),
          parts: await openMultipartAndIssueParts(storage, options.store, authenticated, {
            session: created.session,
            storageKey: created.storageKey,
            mimeType: request.mimeType,
            parts: created.parts,
            deduplicated: false,
          }),
        };
      });
    },

    async updateMaterialMetadata(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const updated = await callWithMutation(
          toMutationReceiptContext(request.context?.requestId),
          (mutation) =>
            options.store.updateMaterialMetadata(
              authenticated,
              {
                groupId: authenticated.group.id,
                materialId: requireResourceId(request.materialId?.value, 'material_id'),
                displayName: request.displayName,
                category: toCategoryName(request.category),
                metadata: request.metadata,
                tags: request.tags,
              },
              ...mutation,
            ),
        );
        return { material: toProtocolMaterial(updated.material) };
      });
    },

    async moveToTrash(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const trashed = await callWithMutation(
          toMutationReceiptContext(request.context?.requestId),
          (mutation) =>
            options.store.moveToTrash(
              authenticated,
              authenticated.group.id,
              requireResourceId(request.materialId?.value, 'material_id'),
              ...mutation,
            ),
        );
        return { material: toProtocolMaterial(trashed.material) };
      });
    },

    async restoreMaterial(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const restored = await callWithMutation(
          toMutationReceiptContext(request.context?.requestId),
          (mutation) =>
            options.store.restoreMaterial(
              authenticated,
              authenticated.group.id,
              requireResourceId(request.materialId?.value, 'material_id'),
              ...mutation,
            ),
        );
        return { material: toProtocolMaterial(restored.material) };
      });
    },

    async purgeMaterial(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const materialId = requireResourceId(request.materialId?.value, 'material_id');
        const purged = await callWithMutation(
          toMutationReceiptContext(request.context?.requestId),
          (mutation) =>
            options.store.purgeMaterial(
              authenticated,
              authenticated.group.id,
              materialId,
              request.confirmation,
              ...mutation,
            ),
        );
        return {
          result: {
            resourceId: { value: purged.materialId },
            revision: {
              number: purged.revision,
              etag: revisionEtag(purged.materialId, purged.revision),
            },
            correlationId: request.context?.correlationId ?? '',
          },
        };
      });
    },

    async getDownloadGrant(request, context) {
      return withRuntimeErrors(async () => {
        const storage = requireStorage(options.storage, 'download');
        const authenticated = await authenticate(options.runtime, context);
        const location = await resolveLocation(options.store, authenticated, request);
        const grant = await storage.issueDownload(location);
        return {
          grant: {
            url: requireGrantUrl(grant.url),
            expiresAt: timestampFromDate(grant.expiresAt),
            requiredHeaders: { ...(grant.requiredHeaders ?? {}) },
            contentHash: location.contentHash,
            byteSize: location.byteSize,
          },
        };
      });
    },

    /**
     * Signs the rendition a variant names, or the original when none is built.
     *
     * The variant used to be carried into `issuePreview` and dropped there,
     * because there was nothing on the server it could select. Now it selects a
     * `material_renditions` row, and the key, type and measured dimensions of
     * that row are what the grant reports; a client tells a built variant from
     * the original by exactly those fields.
     *
     * When nothing is built and the variant is a rung of the ladder, this queues
     * it. Reading a menu is the moment a deployment learns which variants anyone
     * actually wants, and queueing here means a library uploaded before the
     * pipeline existed fills in as it is used rather than needing a backfill.
     */
    async getPreviewGrant(request, context) {
      return withRuntimeErrors(async () => {
        const storage = requireStorage(options.storage, 'preview');
        const authenticated = await authenticate(options.runtime, context);
        const location = await resolveLocation(options.store, authenticated, request);
        const rendition = await resolveRendition(options, authenticated, location, request.variant);
        // The issuer signs whichever key it is handed; the decision of which
        // key that is belongs here, where membership and the variant are both
        // already known.
        const grant = await storage.issuePreview(
          rendition === undefined
            ? { ...location, variant: request.variant }
            : {
                ...location,
                storageKey: rendition.storageKey,
                mimeType: rendition.mimeType,
                byteSize: rendition.byteSize,
                variant: request.variant,
              },
        );
        return {
          grant: {
            url: requireGrantUrl(grant.url),
            expiresAt: timestampFromDate(grant.expiresAt),
            mimeType: grant.mimeType ?? rendition?.mimeType ?? location.mimeType,
            width: grant.width ?? rendition?.width ?? 0,
            height: grant.height ?? rendition?.height ?? 0,
          },
        };
      });
    },

    async listVersions(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options.runtime, context);
        const page = await options.store.listVersions(
          authenticated,
          requireResourceId(request.materialId?.value, 'material_id'),
          request.page?.pageSize ?? 0,
          request.page?.cursor ?? '',
        );
        return {
          versions: page.items.map(toProtocolVersion),
          page: toPageInfo(page.nextCursor, page.hasMore, page.approximateTotal),
        };
      });
    },

    async listTrash(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options.runtime, context);
        const page = await options.store.listTrash(
          authenticated,
          requireResourceId(request.groupId?.value, 'group_id'),
          request.page?.pageSize ?? 0,
          request.page?.cursor ?? '',
        );
        return {
          materials: page.items.map(toProtocolMaterial),
          page: toPageInfo(page.nextCursor, page.hasMore, page.approximateTotal),
        };
      });
    },

    /**
     * Streams library changes by polling `materials.updated_at`.
     *
     * This is a poll and not a subscription because the deployment has nothing
     * to subscribe to: the Neon HTTP driver carries no `LISTEN`/`NOTIFY`
     * channel, and the realtime hub's WebSocket log belongs to document
     * synchronization rather than to the library. Inventing a pub/sub here
     * would mean either a second WebSocket the client does not open or an
     * in-process bus that a second control-plane instance never hears.
     *
     * The cursor is `updated_at` in milliseconds, so a resume re-delivers the
     * whole millisecond it points at. Within one stream that repetition is
     * filtered; across a reconnect it is the honest at-least-once guarantee a
     * timestamp cursor can give.
     */
    async *watchMaterialEvents(request, context) {
      const authenticated = await authenticate(options.runtime, context).catch(rethrowAsConnect);
      const groupId = requireResourceId(request.groupId?.value, 'group_id');
      let cursor = request.afterSequence;
      let deliveredAtCursor = new Set<string>();

      while (!context.signal.aborted) {
        const events = await options.store
          .readMaterialEvents(authenticated, groupId, cursor, batchSize)
          .catch(rethrowAsConnect);
        for (const event of events) {
          if (event.sequence > cursor) {
            cursor = event.sequence;
            deliveredAtCursor = new Set<string>();
          } else if (deliveredAtCursor.has(event.materialId)) {
            continue;
          }
          deliveredAtCursor.add(event.materialId);
          yield { event: toProtocolEvent(event) };
        }
        if (context.signal.aborted) return;
        await sleep(pollIntervalMs, context.signal);
      }
    },
  };
}

/**
 * Opens the object store's multipart upload for a freshly created session and
 * presigns a URL for every part.
 *
 * A deduplicated upload has nothing to send — the group already holds the bytes
 * — so no multipart upload is opened and no grant is minted. A session that
 * already carries a `storageUploadId` is a replay: the multipart upload was
 * opened by the run that owns the receipt, so this reuses that id rather than
 * opening a second one, which is why `attachStorageUploadId` refuses to
 * overwrite the first.
 */
async function openMultipartAndIssueParts(
  storage: StorageGrantIssuer,
  store: DurableMaterialStore,
  authenticated: AuthenticatedDevice,
  input: {
    readonly session: UploadSessionRecord;
    readonly storageKey: string;
    readonly mimeType: string;
    readonly parts: readonly UploadPartRecord[];
    readonly deduplicated: boolean;
  },
) {
  if (input.deduplicated || input.parts.length === 0) return [];
  const remoteUploadId = await resolveRemoteUploadId(storage, store, authenticated, input);
  return issueUploadParts(storage, remoteUploadId, input.storageKey, input.parts);
}

async function resolveRemoteUploadId(
  storage: StorageGrantIssuer,
  store: DurableMaterialStore,
  authenticated: AuthenticatedDevice,
  input: {
    readonly session: UploadSessionRecord;
    readonly storageKey: string;
    readonly mimeType: string;
  },
): Promise<string> {
  if (input.session.storageUploadId !== undefined) return input.session.storageUploadId;
  const handle = await storage.createMultipartUpload({
    storageKey: input.storageKey,
    mimeType: input.mimeType,
  });
  await store.attachStorageUploadId(authenticated, input.session.id, handle.remoteUploadId);
  return handle.remoteUploadId;
}

async function issueUploadParts(
  storage: StorageGrantIssuer,
  remoteUploadId: string,
  storageKey: string,
  parts: readonly UploadPartRecord[],
) {
  const grants = [];
  for (const part of parts) {
    const grant = await storage.issueUploadPart({
      remoteUploadId,
      storageKey,
      partNumber: part.partNumber,
    });
    grants.push({
      partNumber: part.partNumber,
      offset: part.offset,
      length: part.length,
      uploadUrl: requireGrantUrl(grant.url),
      expiresAt: timestampFromDate(grant.expiresAt),
      requiredHeaders: { ...(grant.requiredHeaders ?? {}) },
    });
  }
  return grants;
}

/**
 * Drives `CompleteMultipartUpload` for an upload that opened one, then refuses
 * to let the caller proceed unless the assembled object really is the content
 * the material reserved.
 *
 * A session with no `storageUploadId` opened no multipart upload — the
 * deduplicated path, where the bytes already existed and were verified by the
 * completion that first stored them — so there is nothing to assemble and
 * nothing to re-read. When there is one, storage is required: an upload that
 * must be assembled in a bucket cannot be finished without the issuer that
 * opened it.
 *
 * The verification matters because `material_objects` is keyed by
 * `(group_id, content_hash)` and `storageKeyFor` derives the object key from
 * the same hash. A completion that recorded a hash the bytes do not have would
 * make every later upload of those bytes deduplicate onto the wrong object —
 * one poisoned upload, every future reference wrong. The check therefore runs
 * before the database records the version, never after.
 *
 * A failed check leaves the object where it is rather than deleting it. The
 * key is content-addressed, so a concurrent honest completion of the same hash
 * writes the same key; deleting here would remove bytes another material may
 * already point at. An unverified object is harmless while it is unreferenced,
 * and it stays unreferenced precisely because this refusal stops the row that
 * would reference it.
 */
async function assembleAndVerifyStoredObject(
  options: MaterialServiceOptions,
  authenticated: AuthenticatedDevice,
  uploadId: string,
  parts: readonly CompletedUploadPartInput[],
): Promise<void> {
  const status = await options.store.getUploadStatus(authenticated, uploadId);
  const remoteUploadId = status.session.storageUploadId;
  const materialId = status.session.materialId;
  if (remoteUploadId === undefined || materialId === undefined) return;
  // A session the database already closed was completed in the bucket before
  // it was closed, so a retry has nothing to assemble; and one it cancelled is
  // refused by the store below, without a bucket call it would only undo.
  if (!openUploadStates.has(status.session.state)) return;
  const storage = requireStorage(options.storage, 'upload');
  const object = await resolveMaterialObject(options.store, authenticated, materialId);
  await storage.completeMultipartUpload({
    storageKey: object.storageKey,
    remoteUploadId,
    parts: parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
  });
  const verification = await storage.verifyObject({
    storageKey: object.storageKey,
    // The material's own hash, read back from the database, not the one this
    // request carried: the completion statement compares the two itself, so
    // taking the client's value here would check a number against itself.
    contentHash: object.contentHash,
    byteSize: status.session.totalSize,
  });
  assertObjectVerified(verification);
}

/**
 * Turns a verification outcome into a refusal.
 *
 * The three content outcomes share one message on purpose: which of them
 * occurred says nothing a client can act on beyond "these bytes are not what
 * you declared", and enumerating them would let a caller probe what the bucket
 * currently holds at a key it did not upload. An unverifiable digest is a
 * separate message because it is a deployment fact, not a client one.
 */
function assertObjectVerified(verification: StorageObjectVerification): void {
  if (verification.outcome === 'verified') return;
  if (verification.outcome === 'unverifiable-digest') {
    throw new PairedDeviceRuntimeError(
      'FAILED_PRECONDITION',
      'content_hash is not in a digest format this control plane can verify, so the uploaded object ' +
        'cannot be checked against it. Expected a 64-character lowercase hexadecimal digest, ' +
        'optionally prefixed with "blake3:" or "sha256:".',
    );
  }
  throw new PairedDeviceRuntimeError(
    'FAILED_PRECONDITION',
    'The uploaded object does not match the content this material reserved, so no version was recorded.',
  );
}

/**
 * The multipart target of a cancellable upload, or `undefined` when there is
 * nothing in a bucket to abort — no issuer, no recorded upload id, or a session
 * that has already left the states a cancel applies to.
 */
async function resolveStorageAbort(
  options: MaterialServiceOptions,
  authenticated: AuthenticatedDevice,
  uploadId: string,
): Promise<
  | {
      readonly issuer: StorageGrantIssuer;
      readonly storageKey: string;
      readonly remoteUploadId: string;
    }
  | undefined
> {
  const issuer = options.storage;
  if (issuer === undefined) return undefined;
  const status = await options.store
    .getUploadStatus(authenticated, uploadId)
    .catch(() => undefined);
  const remoteUploadId = status?.session.storageUploadId;
  const materialId = status?.session.materialId;
  if (remoteUploadId === undefined || materialId === undefined) return undefined;
  const object = await resolveMaterialObject(options.store, authenticated, materialId);
  return { issuer, storageKey: object.storageKey, remoteUploadId };
}

/**
 * The reserved object key of a material's current content and the digest that
 * key was derived from. It is the key its open multipart upload was created
 * against: the same content hash names both.
 */
async function resolveMaterialObject(
  store: DurableMaterialStore,
  authenticated: AuthenticatedDevice,
  materialId: string,
): Promise<{ readonly storageKey: string; readonly contentHash: string }> {
  const found = await store.getMaterial(authenticated, materialId);
  return {
    storageKey: storageKeyFor(found.material.groupId, found.material.contentHash),
    contentHash: found.material.contentHash,
  };
}

/**
 * The rendition for a variant, queueing it when the ladder declares one and
 * nothing has been built.
 *
 * The empty variant is the original by definition and never reaches the queue.
 * A variant that is not a rung is never queued either, which is what keeps this
 * read RPC from being a way to create unbounded rows: the only strings that can
 * produce a job are the four in {@link renditionLadderFor}'s own table, and the
 * unique index makes a second request for the same one insert nothing.
 *
 * The queueing is best-effort and deliberately does not change the answer. A
 * grant must be issued for the original whether or not the job was accepted;
 * making a preview fail because a queue insert failed would trade a working
 * fallback for an error.
 */
async function resolveRendition(
  options: MaterialServiceOptions,
  authenticated: AuthenticatedDevice,
  location: StoredObjectLocation,
  variant: string,
): Promise<RenditionRecord | undefined> {
  const renditions = options.renditions;
  const requested = variant.trim();
  if (renditions === undefined || requested.length === 0) return undefined;
  const existing = await renditions.readRendition(
    authenticated,
    location.materialId,
    location.versionId,
    requested,
  );
  if (existing !== undefined) return existing;
  if (renditionSpecFor(location.mimeType, requested) === undefined) return undefined;
  await Promise.resolve(
    renditions.enqueueRenditions(authenticated, location.materialId, location.versionId, [
      requested,
    ]),
  ).catch(() => undefined);
  return undefined;
}

/** Queues every rung the version's own type declares; see the call site. */
async function queueRenditionLadder(
  options: MaterialServiceOptions,
  authenticated: AuthenticatedDevice,
  materialId: string,
  version: MaterialVersionRecord,
): Promise<void> {
  const renditions = options.renditions;
  if (renditions === undefined) return;
  const variants = renditionLadderFor(version.mimeType).map((spec) => spec.variant);
  if (variants.length === 0) return;
  await Promise.resolve(
    renditions.enqueueRenditions(authenticated, materialId, version.id, variants),
  ).catch(() => undefined);
}

function resolveLocation(
  store: DurableMaterialStore,
  authenticated: AuthenticatedDevice,
  request: {
    readonly materialId?: { readonly value: string } | undefined;
    readonly versionId?: { readonly value: string } | undefined;
  },
): Promise<StoredObjectLocation> {
  return store.readObjectLocation(
    authenticated,
    requireResourceId(request.materialId?.value, 'material_id'),
    request.versionId?.value,
  );
}

/**
 * An issuer that answers with an empty address is a misconfiguration, not a
 * grant: the client would treat the empty string as a URL and fail somewhere
 * far away from the cause.
 */
function requireGrantUrl(url: string): string {
  if (url.trim().length === 0) {
    throw new PairedDeviceRuntimeError(
      'FAILED_PRECONDITION',
      'The configured storage issuer returned no address for the requested object.',
    );
  }
  return url;
}

function requireStorage(
  storage: StorageGrantIssuer | undefined,
  operation: 'upload' | 'download' | 'preview',
): StorageGrantIssuer {
  if (storage === undefined) {
    throw new PairedDeviceRuntimeError(
      'FAILED_PRECONDITION',
      `This control plane has no object storage configured, so it cannot issue a ${operation} address. ` +
        'Set HQ_CONTROL_PLANE_STORAGE_ENDPOINT, HQ_CONTROL_PLANE_STORAGE_REGION, HQ_CONTROL_PLANE_STORAGE_BUCKET, ' +
        'HQ_CONTROL_PLANE_STORAGE_ACCESS_KEY_ID and HQ_CONTROL_PLANE_STORAGE_SECRET_ACCESS_KEY before using this RPC.',
    );
  }
  return storage;
}

function authenticate(
  runtime: PairedDeviceLifecycle,
  context: HandlerContext,
): Promise<AuthenticatedDevice> {
  return Promise.resolve(runtime.authenticateAccessToken(readBearerToken(context)));
}

function readBearerToken(context: HandlerContext): string {
  const header = context.requestHeader.get('authorization');
  const match = header === null ? undefined : /^Bearer ([^\s]+)$/u.exec(header.trim());
  if (match?.[1] === undefined) {
    throw controlPlaneFailure(ControlPlaneFailure.BEARER_TOKEN_REQUIRED);
  }
  return match[1];
}

/**
 * `request_id` is the only part of `MutationContext` that carries idempotency
 * meaning. `correlation_id` is response metadata and `issued_at` is a client
 * clock reading, so neither may take part in retry identity.
 */
function toMutationReceiptContext(
  requestId: string | undefined,
): MutationReceiptContext | undefined {
  try {
    const normalized = normalizeRequestId(requestId);
    return normalized === undefined ? undefined : { requestId: normalized };
  } catch (error: unknown) {
    if (error instanceof MutationRequestIdError) {
      throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', error.message);
    }
    throw error;
  }
}

/**
 * Applies an optional trailing `mutation` argument without ever passing an
 * explicit `undefined`, which `exactOptionalPropertyTypes` rejects against an
 * optional parameter.
 */
function callWithMutation<T>(
  mutation: MutationReceiptContext | undefined,
  call: (context: [MutationReceiptContext] | []) => T,
): T {
  return call(mutation === undefined ? [] : [mutation]);
}

function assertContextActor(
  authenticated: AuthenticatedDevice,
  actorDeviceId: string | undefined,
): void {
  if (actorDeviceId === undefined || actorDeviceId.length === 0) return;
  if (actorDeviceId !== authenticated.device.id) {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      'The mutation context actor does not match the authenticated device.',
    );
  }
}

function requireResourceId(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', `${field} must not be empty.`);
  }
  return value.trim();
}

/**
 * The `.catch` form of the shared classifier, for the two call sites that
 * classify one awaited step rather than a whole handler body. It has to throw
 * rather than return, so it cannot simply be the classifier itself.
 */
function rethrowAsConnect(error: unknown): never {
  throw toControlPlaneConnectError(error);
}

/** Resolves on the interval or on abort, whichever comes first, and leaks no timer. */
function sleep(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function toPageInfo(nextCursor: string, hasMore: boolean, approximateTotal: bigint) {
  return {
    nextCursor,
    // The contract exposes a backward cursor. This service publishes forward
    // keyset cursors only, until `PageRequest` gains an explicit direction.
    previousCursor: '',
    hasMore,
    approximateTotal,
  };
}

function revisionEtag(id: string, revision: bigint): string {
  return `material-${id}-revision-${revision.toString()}`;
}

function toProtocolMaterial(material: MaterialRecord) {
  return {
    id: { value: material.id },
    groupId: { value: material.groupId },
    displayName: material.displayName,
    category: toCategoryEnum(material.category),
    mimeType: material.mimeType,
    byteSize: material.byteSize,
    contentHash: material.contentHash,
    status: toStatusEnum(material.status),
    ...(material.currentVersionId === undefined
      ? {}
      : { currentVersionId: { value: material.currentVersionId } }),
    metadata: { ...material.metadata },
    tags: [...material.tags],
    revision: { number: material.revision, etag: revisionEtag(material.id, material.revision) },
    createdAt: timestampFromDate(material.createdAt),
    updatedAt: timestampFromDate(material.updatedAt),
    ...(material.trashedAt === undefined
      ? {}
      : { trashedAt: timestampFromDate(material.trashedAt) }),
  };
}

function toProtocolVersion(version: MaterialVersionRecord) {
  return {
    id: { value: version.id },
    materialId: { value: version.materialId },
    sequence: version.sequence,
    contentHash: version.contentHash,
    mimeType: version.mimeType,
    byteSize: version.byteSize,
    originalFileName: version.originalFileName,
    createdAt: timestampFromDate(version.createdAt),
    ...(version.createdByDeviceId === undefined
      ? {}
      : { createdByDeviceId: { value: version.createdByDeviceId } }),
  };
}

function toProtocolSession(session: UploadSessionRecord) {
  return {
    id: { value: session.id },
    ...(session.materialId === undefined ? {} : { materialId: { value: session.materialId } }),
    ...(session.versionId === undefined ? {} : { versionId: { value: session.versionId } }),
    state: toUploadStateEnum(session.state),
    totalSize: session.totalSize,
    receivedSize: session.receivedSize,
    chunkSize: session.chunkSize,
    maxConcurrency: session.maxConcurrency,
    expiresAt: timestampFromDate(session.expiresAt),
  };
}

/**
 * `correlation_id` is left empty rather than filled with the group id.
 *
 * It exists so a client can recognise the echo of a request it made, and
 * `materials` records no correlation for a watched change. Putting the group id
 * there gave every event on the stream the same non-correlation, which a client
 * matching on it would read as "all of these are mine".
 */
function toProtocolEvent(event: MaterialEventRecord) {
  return {
    sequence: event.sequence,
    kind: toEventKindEnum(event.kind),
    materialId: { value: event.materialId },
    revision: { number: event.revision, etag: revisionEtag(event.materialId, event.revision) },
    occurredAt: timestampFromDate(event.occurredAt),
    correlationId: '',
  };
}

function toCompletedPart(part: materialV1.CompletedUploadPart): CompletedUploadPartInput {
  return { partNumber: part.partNumber, etag: part.etag, checksum: part.checksum };
}

/**
 * Enum names, not wire numbers, are what reaches the database, and the mapping
 * is exhaustive in both directions. A reverse enum lookup would answer
 * `undefined` for any value a newer client sends, and a column holding a bare
 * number is one no operator can read.
 */
function toCategoryName(category: materialV1.MaterialCategory): MaterialCategoryName {
  switch (category) {
    case materialV1.MaterialCategory.VIDEO:
      return 'VIDEO';
    case materialV1.MaterialCategory.CAMERA:
      return 'CAMERA';
    case materialV1.MaterialCategory.IMAGE:
      return 'IMAGE';
    case materialV1.MaterialCategory.AUDIO:
      return 'AUDIO';
    case materialV1.MaterialCategory.DOCUMENT:
      return 'DOCUMENT';
    case materialV1.MaterialCategory.MAP:
      return 'MAP';
    case materialV1.MaterialCategory.INTERCEPT:
      return 'INTERCEPT';
    case materialV1.MaterialCategory.DOSSIER:
      return 'DOSSIER';
    case materialV1.MaterialCategory.REPORT:
      return 'REPORT';
    case materialV1.MaterialCategory.ARCHIVE:
      return 'ARCHIVE';
    case materialV1.MaterialCategory.TECHNICAL:
      return 'TECHNICAL';
    case materialV1.MaterialCategory.OTHER:
      return 'OTHER';
    default:
      return 'UNSPECIFIED';
  }
}

function toCategoryEnum(category: MaterialCategoryName): materialV1.MaterialCategory {
  switch (category) {
    case 'VIDEO':
      return materialV1.MaterialCategory.VIDEO;
    case 'CAMERA':
      return materialV1.MaterialCategory.CAMERA;
    case 'IMAGE':
      return materialV1.MaterialCategory.IMAGE;
    case 'AUDIO':
      return materialV1.MaterialCategory.AUDIO;
    case 'DOCUMENT':
      return materialV1.MaterialCategory.DOCUMENT;
    case 'MAP':
      return materialV1.MaterialCategory.MAP;
    case 'INTERCEPT':
      return materialV1.MaterialCategory.INTERCEPT;
    case 'DOSSIER':
      return materialV1.MaterialCategory.DOSSIER;
    case 'REPORT':
      return materialV1.MaterialCategory.REPORT;
    case 'ARCHIVE':
      return materialV1.MaterialCategory.ARCHIVE;
    case 'TECHNICAL':
      return materialV1.MaterialCategory.TECHNICAL;
    case 'OTHER':
      return materialV1.MaterialCategory.OTHER;
    case 'UNSPECIFIED':
      return materialV1.MaterialCategory.UNSPECIFIED;
  }
}

function toStatusEnum(status: MaterialStatusName): materialV1.MaterialStatus {
  switch (status) {
    case 'UPLOADING':
      return materialV1.MaterialStatus.UPLOADING;
    case 'PROCESSING':
      return materialV1.MaterialStatus.PROCESSING;
    case 'READY':
      return materialV1.MaterialStatus.READY;
    case 'FAILED':
      return materialV1.MaterialStatus.FAILED;
    case 'TRASHED':
      return materialV1.MaterialStatus.TRASHED;
    case 'QUARANTINED':
      return materialV1.MaterialStatus.QUARANTINED;
  }
}

function toUploadStateEnum(state: UploadStateName): materialV1.UploadState {
  switch (state) {
    case 'PENDING':
      return materialV1.UploadState.PENDING;
    case 'UPLOADING':
      return materialV1.UploadState.UPLOADING;
    case 'VERIFYING':
      return materialV1.UploadState.VERIFYING;
    case 'COMPLETED':
      return materialV1.UploadState.COMPLETED;
    case 'CANCELLED':
      return materialV1.UploadState.CANCELLED;
    case 'FAILED':
      return materialV1.UploadState.FAILED;
  }
}

function toEventKindEnum(kind: MaterialEventKindName): materialV1.MaterialEventKind {
  switch (kind) {
    case 'CREATED':
      return materialV1.MaterialEventKind.CREATED;
    case 'UPDATED':
      return materialV1.MaterialEventKind.UPDATED;
    case 'TRASHED':
      return materialV1.MaterialEventKind.TRASHED;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}
