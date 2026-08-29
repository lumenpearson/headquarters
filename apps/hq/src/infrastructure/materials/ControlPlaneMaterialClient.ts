import { createClient, type Transport } from '@connectrpc/connect';
import { MaterialService, materialV1 } from '@gremuchaya/protocol';

import { ControlPlaneError } from '@/application/sync/controlPlanePort';
import { toControlPlaneError } from '@/infrastructure/controlPlane/ControlPlaneClient';

import { browserBlake3Hasher, type BrowserFileHasher } from './BrowserBlake3Hasher';
import type {
  MaterialEntry,
  MaterialImportProgress,
  MaterialImportResult,
  MaterialPage,
  MaterialPlaybackGrant,
  MaterialReadChunk,
} from './BridgeMaterialClient';
import {
  renditionsForMaterial,
  type MaterialLibraryClient,
  type MaterialLifecycleClient,
  type MaterialLibraryEvent,
  type MaterialMetadataPatch,
  type MaterialOrigin,
  type MaterialRendition,
  type MaterialRenditionSource,
  type MaterialVersionEntry,
  type MaterialVersionPage,
} from './materialLibrary';

/*
 * Wire shapes declared structurally, in the idiom `ControlPlaneClient` and
 * `GroupSettingsClient` set: the generated client is assignable to these and so
 * is a hand-written fake in a test. Only the fields this facade reads or writes
 * are named.
 */
interface WireTimestamp {
  readonly seconds: bigint;
  readonly nanos: number;
}

interface WireResourceId {
  readonly value: string;
}

interface WireMutationContext {
  readonly requestId: string;
  readonly actorDeviceId?: WireResourceId;
}

interface WireMaterial {
  readonly id?: WireResourceId | undefined;
  readonly displayName: string;
  readonly mimeType: string;
  readonly byteSize: bigint;
  readonly contentHash: string;
  readonly category: materialV1.MaterialCategory;
  readonly status: materialV1.MaterialStatus;
  readonly currentVersionId?: WireResourceId | undefined;
  readonly createdAt?: WireTimestamp | undefined;
}

interface WireUploadSession {
  readonly id?: WireResourceId | undefined;
  readonly materialId?: WireResourceId | undefined;
  readonly versionId?: WireResourceId | undefined;
  readonly state: materialV1.UploadState;
  readonly totalSize: bigint;
  readonly receivedSize: bigint;
  readonly chunkSize: number;
}

interface WireUploadPartGrant {
  readonly partNumber: number;
  readonly offset: bigint;
  readonly length: bigint;
  readonly uploadUrl: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

interface WireDownloadGrant {
  readonly url: string;
  readonly contentHash: string;
  readonly byteSize: bigint;
  readonly expiresAt?: WireTimestamp | undefined;
}

interface WirePreviewGrant {
  readonly url: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly expiresAt?: WireTimestamp | undefined;
}

interface WireMaterialVersion {
  readonly id?: WireResourceId | undefined;
  readonly materialId?: WireResourceId | undefined;
  readonly sequence: bigint;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly byteSize: bigint;
  readonly originalFileName: string;
  readonly createdAt?: WireTimestamp | undefined;
}

interface WireOperationResult {
  readonly resourceId?: WireResourceId | undefined;
}

interface WireMaterialEvent {
  readonly sequence: bigint;
  readonly kind: materialV1.MaterialEventKind;
  readonly materialId?: WireResourceId | undefined;
  readonly occurredAt?: WireTimestamp | undefined;
  readonly correlationId: string;
}

interface WirePage {
  readonly pageSize: number;
  readonly cursor: string;
}

interface WirePageInfo {
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

interface CallOptions {
  readonly signal?: AbortSignal;
}

export interface MaterialRpcClient {
  listMaterials(
    request: {
      readonly groupId: WireResourceId;
      readonly page: { readonly pageSize: number; readonly cursor: string };
    },
    options?: CallOptions,
  ): Promise<{
    readonly materials: readonly WireMaterial[];
    readonly page?: { readonly nextCursor: string; readonly hasMore: boolean } | undefined;
  }>;
  getMaterial(
    request: { readonly materialId: WireResourceId },
    options?: CallOptions,
  ): Promise<{ readonly material?: WireMaterial | undefined }>;
  beginUpload(
    request: {
      readonly context: WireMutationContext;
      readonly groupId: WireResourceId;
      readonly displayName: string;
      readonly originalFileName: string;
      readonly category: materialV1.MaterialCategory;
      readonly mimeType: string;
      readonly totalSize: bigint;
      readonly contentHash: string;
      readonly metadata: Readonly<Record<string, string>>;
    },
    options?: CallOptions,
  ): Promise<{
    readonly session?: WireUploadSession | undefined;
    readonly parts: readonly WireUploadPartGrant[];
    readonly deduplicated: boolean;
  }>;
  getUploadStatus(
    request: { readonly uploadId: WireResourceId },
    options?: CallOptions,
  ): Promise<{
    readonly session?: WireUploadSession | undefined;
    readonly completedParts: readonly number[];
  }>;
  completeUpload(
    request: {
      readonly context: WireMutationContext;
      readonly uploadId: WireResourceId;
      readonly parts: readonly {
        readonly partNumber: number;
        readonly etag: string;
        readonly checksum: string;
      }[];
      readonly contentHash: string;
    },
    options?: CallOptions,
  ): Promise<{ readonly material?: WireMaterial | undefined }>;
  cancelUpload(
    request: { readonly context: WireMutationContext; readonly uploadId: WireResourceId },
    options?: CallOptions,
  ): Promise<unknown>;
  getDownloadGrant(
    request: {
      readonly materialId: WireResourceId;
      readonly versionId: WireResourceId;
    },
    options?: CallOptions,
  ): Promise<{ readonly grant?: WireDownloadGrant | undefined }>;
  getPreviewGrant(
    request: {
      readonly materialId: WireResourceId;
      readonly versionId: WireResourceId;
      readonly variant: string;
    },
    options?: CallOptions,
  ): Promise<{ readonly grant?: WirePreviewGrant | undefined }>;
  createMaterialVersion(
    request: {
      readonly context: WireMutationContext;
      readonly materialId: WireResourceId;
      readonly originalFileName: string;
      readonly mimeType: string;
      readonly totalSize: bigint;
      readonly contentHash: string;
    },
    options?: CallOptions,
  ): Promise<{
    readonly session?: WireUploadSession | undefined;
    readonly parts: readonly WireUploadPartGrant[];
  }>;
  updateMaterialMetadata(
    request: {
      readonly context: WireMutationContext;
      readonly materialId: WireResourceId;
      readonly displayName: string;
      readonly category: materialV1.MaterialCategory;
      readonly metadata: Readonly<Record<string, string>>;
      readonly tags: readonly string[];
    },
    options?: CallOptions,
  ): Promise<{ readonly material?: WireMaterial | undefined }>;
  moveToTrash(
    request: { readonly context: WireMutationContext; readonly materialId: WireResourceId },
    options?: CallOptions,
  ): Promise<{ readonly material?: WireMaterial | undefined }>;
  restoreMaterial(
    request: { readonly context: WireMutationContext; readonly materialId: WireResourceId },
    options?: CallOptions,
  ): Promise<{ readonly material?: WireMaterial | undefined }>;
  purgeMaterial(
    request: {
      readonly context: WireMutationContext;
      readonly materialId: WireResourceId;
      readonly confirmation: string;
    },
    options?: CallOptions,
  ): Promise<{ readonly result?: WireOperationResult | undefined }>;
  listVersions(
    request: { readonly materialId: WireResourceId; readonly page: WirePage },
    options?: CallOptions,
  ): Promise<{
    readonly versions: readonly WireMaterialVersion[];
    readonly page?: WirePageInfo | undefined;
  }>;
  listTrash(
    request: { readonly groupId: WireResourceId; readonly page: WirePage },
    options?: CallOptions,
  ): Promise<{
    readonly materials: readonly WireMaterial[];
    readonly page?: WirePageInfo | undefined;
  }>;
  watchMaterialEvents(
    request: { readonly groupId: WireResourceId; readonly afterSequence: bigint },
    options?: CallOptions,
  ): AsyncIterable<{ readonly event?: WireMaterialEvent | undefined }>;
}

/**
 * The subset of `fetch` this client uses, so a test can hand it one.
 *
 * One seam for both directions. A part upload and an object read are the same
 * act as far as this module is concerned -- an addressed request to a bucket
 * this client does not otherwise talk to -- and two seams would mean two places
 * where a validated address could stop being the one that is actually
 * requested.
 */
export type MaterialFetch = (
  input: string,
  init: {
    readonly method: string;
    readonly body?: Blob | undefined;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal | undefined;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body?: ReadableStream<Uint8Array> | null | undefined;
}>;

export interface ControlPlaneMaterialClientOptions {
  readonly groupId: string;
  readonly deviceId: string;
  /**
   * Where the bucket answers, as an origin -- `https://materials.s3.host`.
   *
   * Configured rather than discovered. No RPC reports it: the control plane
   * deliberately keeps the bucket's address and credentials inside a
   * configuration closure (`material/service.ts`, `StorageGrantIssuer`), so the
   * only honest way for a browser to know which host it may be sent to is to be
   * told separately. Absent, and every presigned address is refused rather than
   * followed, because a client that follows whatever host a response names has
   * no validator at all.
   */
  readonly storageOrigin?: string | undefined;
  /** The shared authenticated transport; unused when `client` is injected. */
  readonly transport?: Transport;
  readonly client?: MaterialRpcClient;
  readonly fetchPart?: MaterialFetch;
  readonly fileHasher?: BrowserFileHasher;
  readonly mintRequestId?: () => string;
  /** What `BeginUpload` records as the operator's reading of the content. */
  readonly category?: string;
}

/**
 * Browser-facing adapter for the control plane's `MaterialService` (R1, R2).
 *
 * The same contract `BridgeMaterialClient` implements, over a different shape
 * of transfer. The loopback bridge takes the bytes itself in gRPC-Web chunks
 * and commits them; the control plane never sees a byte -- it reserves parts,
 * presigns an address for each, and the browser writes straight into the
 * bucket. What crosses gRPC-Web here is only the reservation, the etags the
 * bucket answered with, and the grants that read the object back.
 *
 * Written against a running `MaterialService` and an S3-compatible bucket;
 * neither exists in this repository's test environment, so every claim below
 * about what the bucket answers is a claim about the contract, proven against
 * fakes rather than against a wire.
 */
export class ControlPlaneMaterialClient implements MaterialLibraryClient, MaterialLifecycleClient {
  readonly origin: MaterialOrigin = 'group-library';
  readonly #client: MaterialRpcClient;
  readonly #groupId: string;
  readonly #deviceId: string;
  readonly #storageOrigin: string | undefined;
  readonly #fetch: MaterialFetch;
  readonly #hasher: BrowserFileHasher;
  readonly #mintRequestId: () => string;
  readonly #category: string;

  constructor(options: ControlPlaneMaterialClientOptions) {
    this.#groupId = options.groupId;
    this.#deviceId = options.deviceId;
    this.#storageOrigin = options.storageOrigin;
    this.#hasher = options.fileHasher ?? browserBlake3Hasher;
    this.#mintRequestId = options.mintRequestId ?? (() => crypto.randomUUID());
    this.#category = options.category ?? 'other';
    this.#fetch = options.fetchPart ?? defaultPartFetch;
    if (options.client !== undefined) {
      this.#client = options.client;
    } else if (options.transport !== undefined) {
      this.#client = createClient(MaterialService, options.transport) as MaterialRpcClient;
    } else {
      throw new Error('ControlPlaneMaterialClient needs a transport or an injected client.');
    }
  }

  /**
   * The same client with a different declared category, for one import batch.
   *
   * The category is the operator's reading of the content and it belongs to the
   * import, not to the session; rebuilding the whole client for a dialog would
   * mean a second place that decides which transport and which validator apply.
   */
  withCategory(category: string): ControlPlaneMaterialClient {
    return new ControlPlaneMaterialClient({
      groupId: this.#groupId,
      deviceId: this.#deviceId,
      storageOrigin: this.#storageOrigin,
      client: this.#client,
      fetchPart: this.#fetch,
      fileHasher: this.#hasher,
      mintRequestId: this.#mintRequestId,
      category,
    });
  }

  /**
   * Hashes the file, reserves its parts, writes them to the bucket and commits.
   *
   * The request id is minted once and reused by every call of this import, so a
   * `BeginUpload` retried after a dropped answer replays its receipt instead of
   * creating a second material.
   */
  async importFile(
    file: File,
    onProgress?: (progress: MaterialImportProgress) => void,
    signal?: AbortSignal,
  ): Promise<MaterialImportResult> {
    assertSafeBrowserFile(file);
    const requestId = this.#mintRequestId();
    onProgress?.({
      phase: 'starting',
      fileName: file.name,
      receivedBytes: 0,
      totalBytes: file.size,
    });
    const contentHash = await this.#hasher.hash(
      file,
      ({ processedBytes, totalBytes }) =>
        onProgress?.({
          phase: 'hashing',
          fileName: file.name,
          receivedBytes: processedBytes,
          totalBytes,
        }),
      signal,
    );

    const begun = await call(() =>
      this.#client.beginUpload(
        {
          context: { requestId, actorDeviceId: { value: this.#deviceId } },
          groupId: { value: this.#groupId },
          displayName: file.name,
          originalFileName: file.name,
          category: toCategoryEnum(this.#category),
          mimeType: file.type,
          totalSize: BigInt(file.size),
          // The control plane recomputes nothing: the bytes never reach it.
          // This digest is what the group's content addressing is built on, so
          // it is computed here and verified again at `CompleteUpload`, which
          // refuses a completion whose hash is not the one the material
          // reserved (`material/store.ts`, `verified_material`).
          contentHash,
          metadata: {},
        },
        options(signal),
      ),
    );
    return this.#runUploadSession(
      file,
      requestId,
      contentHash,
      { session: begun.session, parts: begun.parts, deduplicated: begun.deduplicated },
      onProgress,
      signal,
    );
  }

  /**
   * Uploads a new version of an existing material's bytes (R1).
   *
   * `CreateMaterialVersion` opens a fresh `PENDING` session the same way
   * `BeginUpload` does for a first version -- `material/store.ts` never
   * deduplicates a version against the material's own history, only against
   * the group's object table by content hash inside the same statement -- so
   * this reuses the identical part-upload and completion path.
   */
  async createVersion(
    materialId: string,
    file: File,
    onProgress?: (progress: MaterialImportProgress) => void,
    signal?: AbortSignal,
  ): Promise<MaterialImportResult> {
    assertSafeBrowserFile(file);
    const requestId = this.#mintRequestId();
    onProgress?.({
      phase: 'starting',
      fileName: file.name,
      receivedBytes: 0,
      totalBytes: file.size,
    });
    const contentHash = await this.#hasher.hash(
      file,
      ({ processedBytes, totalBytes }) =>
        onProgress?.({
          phase: 'hashing',
          fileName: file.name,
          receivedBytes: processedBytes,
          totalBytes,
        }),
      signal,
    );
    const begun = await call(() =>
      this.#client.createMaterialVersion(
        {
          context: { requestId, actorDeviceId: { value: this.#deviceId } },
          materialId: { value: materialId },
          originalFileName: file.name,
          mimeType: file.type,
          totalSize: BigInt(file.size),
          contentHash,
        },
        options(signal),
      ),
    );
    return this.#runUploadSession(
      file,
      requestId,
      contentHash,
      { session: begun.session, parts: begun.parts, deduplicated: false },
      onProgress,
      signal,
    );
  }

  /**
   * Writes the parts a reservation opened and completes or replays the
   * session, shared by `importFile`'s first version and `createVersion`'s
   * later ones -- the two RPCs that open a session disagree about nothing this
   * needs to know once the reservation is in hand.
   */
  async #runUploadSession(
    file: File,
    requestId: string,
    contentHash: string,
    begun: {
      readonly session?: WireUploadSession | undefined;
      readonly parts: readonly WireUploadPartGrant[];
      readonly deduplicated: boolean;
    },
    onProgress: ((progress: MaterialImportProgress) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<MaterialImportResult> {
    const session = required(begun.session, 'Control plane returned no upload session.');
    const uploadId = required(
      session.id?.value,
      'Control plane returned an upload session with no id.',
    );

    try {
      if (begun.deduplicated) {
        /*
         * The group already held these bytes, so the material was created
         * `READY` and its session `COMPLETED` in the same statement
         * (`material/store.ts`, `locked_object`). There is nothing to upload
         * and nothing to complete -- calling `CompleteUpload` on a session that
         * is not `PENDING`/`UPLOADING`/`VERIFYING` is refused -- and
         * `BeginUploadResponse` carries no material, so the record is read back
         * by id.
         */
        const material = await this.#readMaterial(session.materialId?.value, signal);
        onProgress?.({
          phase: 'completed',
          fileName: file.name,
          receivedBytes: file.size,
          totalBytes: file.size,
        });
        return { material, deduplicated: true };
      }

      const held = await this.#alreadyHeldParts(uploadId, signal);
      const pending = begun.parts.filter((part) => !held.has(part.partNumber));
      if (pending.length === 0 && held.size > 0) {
        /*
         * Every reserved part is already recorded against the session, which
         * this deployment writes only inside `CompleteUpload`
         * (`upload_parts.completed_at` has one writer). So this is a replayed
         * request id whose upload was assembled by an earlier run: the object
         * exists, the material is committed, and re-sending the bytes would
         * write them a second time for no change.
         */
        const material = await this.#readMaterial(session.materialId?.value, signal);
        onProgress?.({
          phase: 'completed',
          fileName: file.name,
          receivedBytes: file.size,
          totalBytes: file.size,
        });
        return { material, deduplicated: false };
      }

      const uploaded = await this.#uploadParts(file, pending, onProgress, signal);
      onProgress?.({
        phase: 'verifying',
        fileName: file.name,
        receivedBytes: file.size,
        totalBytes: file.size,
      });
      const completed = await call(() =>
        this.#client.completeUpload(
          {
            context: { requestId, actorDeviceId: { value: this.#deviceId } },
            uploadId: { value: uploadId },
            parts: uploaded,
            contentHash,
          },
          options(signal),
        ),
      );
      const material = toMaterialEntry(
        required(completed.material, 'Control plane completed without a material record.'),
      );
      onProgress?.({
        phase: 'completed',
        fileName: file.name,
        receivedBytes: file.size,
        totalBytes: file.size,
      });
      return { material, deduplicated: false };
    } catch (error: unknown) {
      /*
       * `CancelUpload` is what releases the bucket's multipart upload: the
       * control plane reads the session's remote upload id and issues an
       * `AbortMultipartUpload` for it (`material/service.ts`). An abort by the
       * operator gets the same treatment as a failure, because the parts
       * already written are just as abandoned either way -- but it is sent
       * without the aborted signal, which would refuse the call that cleans up.
       */
      await call(() =>
        this.#client.cancelUpload({
          context: { requestId: this.#mintRequestId(), actorDeviceId: { value: this.#deviceId } },
          uploadId: { value: uploadId },
        }),
      ).catch(() => undefined);
      throw error;
    }
  }

  async list(cursor = '', pageSize = 50, signal?: AbortSignal): Promise<MaterialPage> {
    const response = await call(() =>
      this.#client.listMaterials(
        { groupId: { value: this.#groupId }, page: { pageSize, cursor } },
        options(signal),
      ),
    );
    return {
      materials: response.materials
        .filter((material) => material.status === materialV1.MaterialStatus.READY)
        .map(toMaterialEntry),
      nextCursor: response.page?.nextCursor ?? '',
    };
  }

  /**
   * Streams a material's bytes by following its download grant.
   *
   * The material contract has no server-streaming read: the bytes live in a
   * bucket the control plane never touches, and the one address it can give a
   * browser is a presigned GET. So the chunking the bounded preview reader
   * expects comes from the response body's own reader rather than from an RPC
   * stream, and the address is checked before it is followed.
   */
  async *readChunks(materialId: string, signal?: AbortSignal): AsyncGenerator<MaterialReadChunk> {
    const material = await this.#readMaterial(materialId, signal);
    const grant = await this.#downloadGrant(material, signal);
    const response = await this.#fetch(grant.url, {
      method: 'GET',
      headers: {},
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok || response.body === null || response.body === undefined) {
      throw new ControlPlaneError(
        'unavailable',
        `Object storage refused the material download (HTTP ${response.status}).`,
      );
    }
    const reader = response.body.getReader();
    let first = true;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield first ? { data: value, material } : { data: value };
        first = false;
      }
    } finally {
      reader.releaseLock();
    }
  }

  async getPlaybackGrant(
    material: MaterialEntry,
    signal?: AbortSignal,
  ): Promise<MaterialPlaybackGrant> {
    const grant = await this.#downloadGrant(material, signal);
    return {
      grantId: `${material.materialId}:download`,
      url: grant.url,
      expiresAtMs: grant.expiresAtMs,
      mimeType: material.mimeType,
      byteSize: material.byteSize,
    };
  }

  /**
   * A presigned address cannot be handed back.
   *
   * The bridge's grant is a capability the bridge holds and can drop; this one
   * is a signature the bucket will honour until it expires, and no RPC in
   * `material.proto` withdraws it. Answering `false` says so plainly, which is
   * what `openMaterialSource`'s release path needs to hear -- there is nothing
   * to release, and pretending otherwise would leave a caller believing an
   * address had been closed.
   */
  async revokePlaybackGrant(): Promise<boolean> {
    return false;
  }

  renditions(material: MaterialEntry): readonly MaterialRendition[] {
    return renditionsForMaterial(material);
  }

  async openRendition(
    material: MaterialEntry,
    rendition: MaterialRendition,
    signal?: AbortSignal,
  ): Promise<MaterialRenditionSource> {
    if (rendition.variant.length === 0) {
      const grant = await this.#downloadGrant(material, signal);
      return {
        grantId: `${material.materialId}:download`,
        url: grant.url,
        mimeType: material.mimeType,
        variant: '',
        rendered: false,
      };
    }
    const response = await call(() =>
      this.#client.getPreviewGrant(
        {
          materialId: { value: material.materialId },
          versionId: { value: '' },
          variant: rendition.variant,
        },
        options(signal),
      ),
    );
    const grant = required(response.grant, 'Control plane returned no preview grant.');
    const url = assertRemoteGrantUrl(grant.url, this.#storageOrigin);
    /*
     * A grant that reports the stored object's own type and no dimensions is
     * the original served under another name -- which is what every deployment
     * in this repository answers, because `issuePreview` presigns the same key
     * for every variant. Saying so is the difference between a quality menu
     * and a menu-shaped control.
     */
    const rendered = grant.width > 0 || grant.height > 0 || grant.mimeType !== material.mimeType;
    return {
      grantId: `${material.materialId}:${rendition.variant}`,
      url,
      mimeType: grant.mimeType.length > 0 ? grant.mimeType : material.mimeType,
      variant: rendition.variant,
      rendered,
    };
  }

  /** Renames, re-categorizes, or re-tags a material. Every field is sent, none merged. */
  async updateMetadata(
    materialId: string,
    patch: MaterialMetadataPatch,
    signal?: AbortSignal,
  ): Promise<MaterialEntry> {
    const response = await call(() =>
      this.#client.updateMaterialMetadata(
        {
          context: { requestId: this.#mintRequestId(), actorDeviceId: { value: this.#deviceId } },
          materialId: { value: materialId },
          displayName: patch.displayName,
          category: toCategoryEnum(patch.category),
          metadata: patch.metadata,
          tags: patch.tags,
        },
        options(signal),
      ),
    );
    return toMaterialEntry(
      required(response.material, 'Control plane updated metadata without a material record.'),
    );
  }

  async moveToTrash(materialId: string, signal?: AbortSignal): Promise<MaterialEntry> {
    const response = await call(() =>
      this.#client.moveToTrash(
        {
          context: { requestId: this.#mintRequestId(), actorDeviceId: { value: this.#deviceId } },
          materialId: { value: materialId },
        },
        options(signal),
      ),
    );
    return toMaterialEntry(
      required(response.material, 'Control plane moved a material to trash without a record.'),
    );
  }

  async restoreMaterial(materialId: string, signal?: AbortSignal): Promise<MaterialEntry> {
    const response = await call(() =>
      this.#client.restoreMaterial(
        {
          context: { requestId: this.#mintRequestId(), actorDeviceId: { value: this.#deviceId } },
          materialId: { value: materialId },
        },
        options(signal),
      ),
    );
    return toMaterialEntry(
      required(response.material, 'Control plane restored a material without a record.'),
    );
  }

  /**
   * Permanently deletes a trashed material and releases its object reference.
   *
   * `confirmation` must equal `materialId` -- `store.ts` refuses a purge whose
   * confirmation does not name the material before any statement runs -- so a
   * mistyped or generic "yes" fails here rather than deleting the wrong thing.
   */
  async purgeMaterial(
    materialId: string,
    confirmation: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await call(() =>
      this.#client.purgeMaterial(
        {
          context: { requestId: this.#mintRequestId(), actorDeviceId: { value: this.#deviceId } },
          materialId: { value: materialId },
          confirmation,
        },
        options(signal),
      ),
    );
  }

  async listVersions(
    materialId: string,
    cursor = '',
    pageSize = 50,
    signal?: AbortSignal,
  ): Promise<MaterialVersionPage> {
    const response = await call(() =>
      this.#client.listVersions(
        { materialId: { value: materialId }, page: { pageSize, cursor } },
        options(signal),
      ),
    );
    return {
      versions: response.versions.map(toMaterialVersionEntry),
      nextCursor: response.page?.nextCursor ?? '',
    };
  }

  async listTrash(cursor = '', pageSize = 50, signal?: AbortSignal): Promise<MaterialPage> {
    const response = await call(() =>
      this.#client.listTrash(
        { groupId: { value: this.#groupId }, page: { pageSize, cursor } },
        options(signal),
      ),
    );
    return {
      materials: response.materials.map(toMaterialEntry),
      nextCursor: response.page?.nextCursor ?? '',
    };
  }

  /**
   * The library's own change feed (R1's "notification of another device's
   * upload"). A long-lived server stream: this generator runs until `signal`
   * aborts or the stream itself ends, translating each event as it arrives
   * rather than buffering the connection's whole future.
   */
  async *watchEvents(
    afterSequence: number,
    signal?: AbortSignal,
  ): AsyncGenerator<MaterialLibraryEvent> {
    try {
      for await (const response of this.#client.watchMaterialEvents(
        { groupId: { value: this.#groupId }, afterSequence: BigInt(Math.max(0, afterSequence)) },
        options(signal),
      )) {
        if (response.event === undefined) continue;
        yield toMaterialLibraryEvent(response.event);
      }
    } catch (error: unknown) {
      throw toControlPlaneError(error);
    }
  }

  async #readMaterial(
    materialId: string | undefined,
    signal?: AbortSignal,
  ): Promise<MaterialEntry> {
    const id = required(materialId, 'Control plane returned no material id.');
    const response = await call(() =>
      this.#client.getMaterial({ materialId: { value: id } }, options(signal)),
    );
    return toMaterialEntry(required(response.material, 'Control plane returned no material.'));
  }

  async #downloadGrant(
    material: MaterialEntry,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly url: string; readonly expiresAtMs: number }> {
    const response = await call(() =>
      this.#client.getDownloadGrant(
        { materialId: { value: material.materialId }, versionId: { value: '' } },
        options(signal),
      ),
    );
    const grant = required(response.grant, 'Control plane returned no download grant.');
    if (grant.contentHash !== material.contentHash || grant.byteSize !== material.byteSize) {
      throw new ControlPlaneError(
        'unknown',
        'Download grant metadata differs from the selected material.',
      );
    }
    return {
      url: assertRemoteGrantUrl(grant.url, this.#storageOrigin),
      expiresAtMs: toEpochMs(grant.expiresAt),
    };
  }

  /**
   * The part numbers the session already accounts for.
   *
   * A status read is cheap and a re-uploaded part is not, so it is asked for on
   * every import rather than only after a visible failure.
   */
  async #alreadyHeldParts(uploadId: string, signal: AbortSignal | undefined): Promise<Set<number>> {
    const status = await call(() =>
      this.#client.getUploadStatus({ uploadId: { value: uploadId } }, options(signal)),
    );
    return new Set(status.completedParts);
  }

  async #uploadParts(
    file: File,
    parts: readonly WireUploadPartGrant[],
    onProgress: ((progress: MaterialImportProgress) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<
    readonly { readonly partNumber: number; readonly etag: string; readonly checksum: string }[]
  > {
    // Ascending part number, because `CompleteMultipartUpload` assembles the
    // object in the order the parts are named and the reservation's own order
    // is the file's.
    const ordered = [...parts].sort((left, right) => left.partNumber - right.partNumber);
    const completed: {
      readonly partNumber: number;
      readonly etag: string;
      readonly checksum: string;
    }[] = [];
    let sentBytes = 0;
    for (const part of ordered) {
      throwIfAborted(signal);
      const offset = toSafeInteger(part.offset, 'part offset');
      const length = toSafeInteger(part.length, 'part length');
      const url = assertRemoteGrantUrl(part.uploadUrl, this.#storageOrigin);
      const response = await this.#fetch(url, {
        method: 'PUT',
        body: file.slice(offset, offset + length),
        headers: { ...part.requiredHeaders },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        throw new ControlPlaneError(
          'unavailable',
          `Object storage refused part ${part.partNumber} (HTTP ${response.status}).`,
        );
      }
      /*
       * The etag is the bucket's receipt for the part and the only thing
       * `CompleteMultipartUpload` accepts as one. A bucket whose CORS policy
       * does not expose `ETag` answers `null` here, and the import fails now,
       * naming the header, rather than at a completion the store would refuse
       * for reasons that have nothing to do with the cause.
       */
      const etag = response.headers.get('etag');
      if (etag === null || etag.length === 0) {
        throw new ControlPlaneError(
          'unknown',
          `Object storage returned no ETag for part ${part.partNumber}. The bucket must expose the ETag header to this origin.`,
        );
      }
      completed.push({ partNumber: part.partNumber, etag: normalizeEtag(etag), checksum: '' });
      sentBytes += length;
      onProgress?.({
        phase: 'uploading',
        fileName: file.name,
        receivedBytes: sentBytes,
        totalBytes: file.size,
      });
    }
    return completed;
  }
}

/**
 * Whether a presigned address may be followed.
 *
 * `normalizePlaybackGrantUrl` in `BridgeMaterialClient` stays where it is and
 * is not reused here. It is loopback-only by design and correctly so: the
 * bridge's grant is an opaque capability at a fixed path on `127.0.0.1`, and
 * relaxing it to admit a remote bucket would relax it for the bridge too --
 * turning the one validator that can be exact into one that cannot.
 *
 * A presigned bucket address is a different shape and admits a different, and
 * weaker, set of checks. The path is the object key, which this client does not
 * know; the query is the signature, which it cannot recompute. What it can
 * insist on, and does:
 *
 * - the address parses, and carries no `user:password` -- credentials in a URL
 *   would be sent to the host by the browser and logged by anything in between;
 * - the scheme is the configured endpoint's scheme, so a bucket reached over
 *   TLS cannot be downgraded by an answer that names `http:`;
 * - the host is the configured endpoint's host, or exactly one label below it.
 *   Both are the bucket: `s3-grant-issuer.ts` addresses it path-style
 *   (`endpoint/bucket/key`) or virtual-host style (`bucket.endpoint/key`)
 *   depending on `forcePathStyle`, and the client is told the endpoint, not
 *   which style the deployment configured.
 *
 * Without a configured endpoint nothing is admitted. A validator that fell back
 * to trusting whatever host the response named would be a validator only in
 * name, and the failure it prevents -- a compromised or misconfigured control
 * plane pointing the browser at a host of its choosing -- is exactly the one
 * worth keeping.
 */
export function assertRemoteGrantUrl(value: string, storageOrigin: string | undefined): string {
  if (storageOrigin === undefined || storageOrigin.trim().length === 0) {
    throw new ControlPlaneError(
      'failed-precondition',
      'No object storage origin is configured for this client, so a presigned address cannot be followed. Set NEXT_PUBLIC_HQ_MATERIAL_STORAGE_ORIGIN.',
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(storageOrigin);
  } catch {
    throw new ControlPlaneError(
      'failed-precondition',
      'The configured object storage origin is not a URL.',
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ControlPlaneError('unknown', 'Control plane returned an unparseable grant address.');
  }
  const sameHost =
    url.host === endpoint.host ||
    (url.host.endsWith(`.${endpoint.host}`) &&
      !url.host.slice(0, -`.${endpoint.host}`.length).includes('.'));
  if (
    url.protocol !== endpoint.protocol ||
    url.username !== '' ||
    url.password !== '' ||
    !sameHost
  ) {
    throw new ControlPlaneError(
      'unknown',
      'Control plane returned a grant address outside the configured object storage endpoint.',
    );
  }
  return url.toString();
}

const defaultPartFetch: MaterialFetch = (input, init) =>
  fetch(input, {
    method: init.method,
    headers: { ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  });

/**
 * The twelve categories of `MaterialCategory`, by the identifiers the settings
 * catalogue offers. `photo` and `IMAGE` are the same category under two names:
 * the operator's vocabulary is the one in `materials.defaultCategory`, and the
 * wire's is the enum, so the mapping is stated once here.
 */
const categoryEnums: Readonly<Record<string, materialV1.MaterialCategory>> = {
  video: materialV1.MaterialCategory.VIDEO,
  camera: materialV1.MaterialCategory.CAMERA,
  photo: materialV1.MaterialCategory.IMAGE,
  image: materialV1.MaterialCategory.IMAGE,
  audio: materialV1.MaterialCategory.AUDIO,
  document: materialV1.MaterialCategory.DOCUMENT,
  map: materialV1.MaterialCategory.MAP,
  intercept: materialV1.MaterialCategory.INTERCEPT,
  dossier: materialV1.MaterialCategory.DOSSIER,
  report: materialV1.MaterialCategory.REPORT,
  archive: materialV1.MaterialCategory.ARCHIVE,
  technical: materialV1.MaterialCategory.TECHNICAL,
  other: materialV1.MaterialCategory.OTHER,
};

export function toCategoryEnum(category: string): materialV1.MaterialCategory {
  return categoryEnums[category.toLocaleLowerCase('en-US')] ?? materialV1.MaterialCategory.OTHER;
}

function toMaterialEntry(material: WireMaterial): MaterialEntry {
  const createdAt = toEpochMs(material.createdAt);
  return {
    materialId: material.id?.value ?? '',
    displayName: material.displayName,
    mimeType: material.mimeType,
    byteSize: material.byteSize,
    contentHash: material.contentHash,
    createdAt: createdAt === 0 ? '' : new Date(createdAt).toISOString(),
  };
}

function toMaterialVersionEntry(version: WireMaterialVersion): MaterialVersionEntry {
  const createdAt = toEpochMs(version.createdAt);
  return {
    versionId: version.id?.value ?? '',
    materialId: version.materialId?.value ?? '',
    sequence: toSafeInteger(version.sequence, 'version sequence'),
    contentHash: version.contentHash,
    mimeType: version.mimeType,
    byteSize: version.byteSize,
    originalFileName: version.originalFileName,
    createdAt: createdAt === 0 ? '' : new Date(createdAt).toISOString(),
  };
}

const eventKinds: Readonly<Record<materialV1.MaterialEventKind, MaterialLibraryEvent['kind']>> = {
  [materialV1.MaterialEventKind.UNSPECIFIED]: 'unspecified',
  [materialV1.MaterialEventKind.CREATED]: 'created',
  [materialV1.MaterialEventKind.UPDATED]: 'updated',
  [materialV1.MaterialEventKind.VERSION_ADDED]: 'version-added',
  [materialV1.MaterialEventKind.TRASHED]: 'trashed',
  [materialV1.MaterialEventKind.RESTORED]: 'restored',
  [materialV1.MaterialEventKind.PURGED]: 'purged',
  [materialV1.MaterialEventKind.CONVERSION_UPDATED]: 'conversion-updated',
};

function toMaterialLibraryEvent(event: WireMaterialEvent): MaterialLibraryEvent {
  const occurredAt = toEpochMs(event.occurredAt);
  return {
    sequence: toSafeInteger(event.sequence, 'event sequence'),
    kind: eventKinds[event.kind] ?? 'unspecified',
    materialId: event.materialId?.value ?? '',
    occurredAt: occurredAt === 0 ? '' : new Date(occurredAt).toISOString(),
    correlationId: event.correlationId,
  };
}

/** `google.protobuf.Timestamp` to epoch milliseconds; `0` when absent. */
function toEpochMs(timestamp: WireTimestamp | undefined): number {
  if (timestamp === undefined) return 0;
  return Number(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1_000_000);
}

/** S3 returns the etag quoted; the quotes are part of neither the value nor XML. */
function normalizeEtag(value: string): string {
  return value.replaceAll('"', '').trim();
}

function toSafeInteger(value: bigint, name: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new ControlPlaneError(
      'unknown',
      `Control plane returned a ${name} outside the safe browser range.`,
    );
  }
  return numeric;
}

function assertSafeBrowserFile(file: File): void {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.name.length === 0) {
    throw new Error('The selected material has invalid browser metadata.');
  }
}

async function call<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation();
  } catch (error: unknown) {
    throw toControlPlaneError(error);
  }
}

function options(signal: AbortSignal | undefined): CallOptions {
  return signal === undefined ? {} : { signal };
}

function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new ControlPlaneError('unknown', message);
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
