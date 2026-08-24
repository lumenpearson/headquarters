import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from '@connectrpc/connect';
import { materialV1 } from '@gremuchaya/protocol';
import type { MaterialService } from '@gremuchaya/protocol';

import type { Awaitable, PairedDeviceLifecycle } from '../sync/lifecycle.js';
import {
  MutationRequestIdError,
  normalizeRequestId,
  type MutationReceiptContext,
} from '../sync/receipts.js';
import { PairedDeviceRuntimeError, type AuthenticatedDevice } from '../sync/runtime.js';

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
  UploadPartRecord,
  UploadSessionRecord,
  UploadStateName,
} from './store.js';

/**
 * ConnectRPC adapter for `MaterialService`.
 *
 * Everything about a material that this deployment can answer from PostgreSQL
 * is answered here. What it cannot answer is a URL: `UploadPartGrant.upload_url`,
 * `DownloadGrant.url` and `PreviewGrant.url` all presuppose an object store, and
 * `ControlPlaneConfig` declares none. Rather than return an empty string a
 * client cannot tell from a real address, the four RPCs that would have to mint
 * one refuse with `FAILED_PRECONDITION` naming the missing configuration, and
 * the other twelve work exactly as they will once a bucket exists.
 */

/** One part of a multipart upload, as the object store needs it described. */
export interface StorageUploadPartRequest {
  readonly uploadId: string;
  readonly storageKey: string;
  readonly partNumber: number;
  readonly offset: bigint;
  readonly length: bigint;
}

export interface StorageObjectRequest {
  readonly materialId: string;
  readonly versionId: string;
  readonly storageKey: string;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly byteSize: bigint;
}

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
 * It is a port rather than a client because the control plane has no storage
 * configuration at all yet: the shape of a grant is known, the deployment that
 * issues one is not. Keeping it injected means the bucket's credentials stay in
 * a configuration closure and never reach this service, its responses, or its
 * error text.
 */
export interface StorageGrantIssuer {
  issueUploadPart(request: StorageUploadPartRequest): Awaitable<StorageGrant>;
  issueDownload(request: StorageObjectRequest): Awaitable<StorageGrant>;
  issuePreview(request: StoragePreviewRequest): Awaitable<StoragePreviewGrant>;
}

export interface MaterialServiceOptions {
  /** Authentication only: every material authorization decision is made in SQL. */
  readonly runtime: PairedDeviceLifecycle;
  readonly store: DurableMaterialStore;
  /** Absent until a bucket is configured; see the note on this module. */
  readonly storage?: StorageGrantIssuer;
  /** How often `WatchMaterialEvents` re-reads `materials.updated_at`. */
  readonly watchPollIntervalMs?: number;
  readonly watchBatchSize?: number;
}

const defaultWatchPollIntervalMs = 1_000;
const defaultWatchBatchSize = 64;

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
              },
              ...mutation,
            ),
        );
        return {
          session: toProtocolSession(begun.session),
          parts: await issueUploadParts(storage, begun.session.id, begun.storageKey, begun.parts),
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
        const completed = await callWithMutation(
          toMutationReceiptContext(request.context?.requestId),
          (mutation) =>
            options.store.completeUpload(
              authenticated,
              requireResourceId(request.uploadId?.value, 'upload_id'),
              request.contentHash,
              request.parts.map(toCompletedPart),
              ...mutation,
            ),
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
        const cancelled = await callWithMutation(
          toMutationReceiptContext(request.context?.requestId),
          (mutation) =>
            options.store.cancelUpload(
              authenticated,
              requireResourceId(request.uploadId?.value, 'upload_id'),
              ...mutation,
            ),
        );
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
              },
              ...mutation,
            ),
        );
        return {
          session: toProtocolSession(created.session),
          parts: await issueUploadParts(
            storage,
            created.session.id,
            created.storageKey,
            created.parts,
          ),
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

    async getPreviewGrant(request, context) {
      return withRuntimeErrors(async () => {
        const storage = requireStorage(options.storage, 'preview');
        const authenticated = await authenticate(options.runtime, context);
        const location = await resolveLocation(options.store, authenticated, request);
        const grant = await storage.issuePreview({ ...location, variant: request.variant });
        return {
          grant: {
            url: requireGrantUrl(grant.url),
            expiresAt: timestampFromDate(grant.expiresAt),
            mimeType: grant.mimeType ?? location.mimeType,
            width: grant.width ?? 0,
            height: grant.height ?? 0,
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
          yield { event: toProtocolEvent(event, request.groupId?.value ?? '') };
        }
        if (context.signal.aborted) return;
        await sleep(pollIntervalMs, context.signal);
      }
    },
  };
}

async function issueUploadParts(
  storage: StorageGrantIssuer,
  uploadId: string,
  storageKey: string,
  parts: readonly UploadPartRecord[],
) {
  const grants = [];
  for (const part of parts) {
    const grant = await storage.issueUploadPart({
      uploadId,
      storageKey,
      partNumber: part.partNumber,
      offset: part.offset,
      length: part.length,
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
        'Supply a StorageGrantIssuer to the material service before using this RPC.',
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
    throw new ConnectError('A bearer access token is required.', Code.Unauthenticated);
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

async function withRuntimeErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    return rethrowAsConnect(error);
  }
}

function rethrowAsConnect(error: unknown): never {
  if (error instanceof ConnectError) throw error;
  if (error instanceof PairedDeviceRuntimeError) {
    throw new ConnectError(error.message, toConnectCode(error.code));
  }
  throw error;
}

function toConnectCode(code: PairedDeviceRuntimeError['code']): Code {
  if (code === 'ABORTED') return Code.Aborted;
  if (code === 'ALREADY_EXISTS') return Code.AlreadyExists;
  if (code === 'FAILED_PRECONDITION') return Code.FailedPrecondition;
  if (code === 'INVALID_ARGUMENT') return Code.InvalidArgument;
  if (code === 'NOT_FOUND') return Code.NotFound;
  if (code === 'PERMISSION_DENIED') return Code.PermissionDenied;
  return Code.Unauthenticated;
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

function toProtocolEvent(event: MaterialEventRecord, correlationId: string) {
  return {
    sequence: event.sequence,
    kind: toEventKindEnum(event.kind),
    materialId: { value: event.materialId },
    revision: { number: event.revision, etag: revisionEtag(event.materialId, event.revision) },
    occurredAt: timestampFromDate(event.occurredAt),
    correlationId,
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
