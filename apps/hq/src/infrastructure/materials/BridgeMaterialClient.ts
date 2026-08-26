import { isMaterialId } from '@gremuchaya/domain';
import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { FileBridgeService } from '@gremuchaya/protocol';

import { browserBlake3Hasher, type BrowserFileHasher } from './BrowserBlake3Hasher';
import {
  originalRendition,
  type MaterialLibraryClient,
  type MaterialOrigin,
  type MaterialRendition,
  type MaterialRenditionSource,
} from './materialLibrary';

const defaultBridgeUrl = 'http://127.0.0.1:4177';

interface BridgeMaterialRpcClient {
  beginMaterialImport(
    request: BeginImportRequest,
    options?: MaterialCallOptions,
  ): Promise<{ readonly session?: MaterialImportSession | undefined }>;
  uploadMaterialChunk(
    request: UploadChunkRequest,
    options?: MaterialCallOptions,
  ): Promise<{ readonly session?: MaterialImportSession | undefined }>;
  getMaterialImportStatus(
    request: { readonly uploadId: string },
    options?: MaterialCallOptions,
  ): Promise<{ readonly session?: MaterialImportSession | undefined }>;
  completeMaterialImport(
    request: { readonly uploadId: string },
    options?: MaterialCallOptions,
  ): Promise<{
    readonly material?: BridgeMaterialEntry | undefined;
    readonly deduplicated: boolean;
  }>;
  cancelMaterialImport(
    request: { readonly uploadId: string },
    options?: MaterialCallOptions,
  ): Promise<{ readonly session?: MaterialImportSession | undefined }>;
  listImportedMaterials(
    request: { readonly mountId: string; readonly cursor: string; readonly pageSize: number },
    options?: MaterialCallOptions,
  ): Promise<{ readonly materials: readonly BridgeMaterialEntry[]; readonly nextCursor: string }>;
  readImportedMaterial(
    request: { readonly mountId: string; readonly materialId: string },
    options?: MaterialCallOptions,
  ): AsyncIterable<{
    readonly data: Uint8Array;
    readonly material?: BridgeMaterialEntry | undefined;
  }>;
  getMaterialPlaybackGrant(
    request: { readonly mountId: string; readonly materialId: string },
    options?: MaterialCallOptions,
  ): Promise<{ readonly grant?: BridgeMaterialPlaybackGrant | undefined }>;
  revokeMaterialPlaybackGrant(
    request: { readonly grantId: string },
    options?: MaterialCallOptions,
  ): Promise<{ readonly revoked: boolean }>;
}

interface MaterialCallOptions {
  readonly signal?: AbortSignal;
}

interface BeginImportRequest {
  readonly mountId: string;
  readonly fileName: string;
  readonly declaredMimeType: string;
  readonly totalSize: bigint;
  readonly expectedBlake3: string;
}

interface UploadChunkRequest {
  readonly uploadId: string;
  readonly offset: bigint;
  readonly data: Uint8Array;
}

interface MaterialImportSession {
  readonly uploadId: string;
  readonly totalSize: bigint;
  readonly receivedSize: bigint;
  readonly chunkSize: number;
  readonly state: string;
}

interface BridgeMaterialEntry {
  readonly materialId: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly byteSize: bigint;
  readonly contentHash: string;
  readonly createdAt: string;
}

interface BridgeMaterialPlaybackGrant {
  readonly grantId: string;
  readonly url: string;
  readonly expiresAtMs: bigint;
  readonly mimeType: string;
  readonly byteSize: bigint;
}

export interface MaterialImportProgress {
  readonly phase: 'starting' | 'hashing' | 'uploading' | 'verifying' | 'completed';
  readonly fileName: string;
  readonly receivedBytes: number;
  readonly totalBytes: number;
}

export interface MaterialImportResult {
  readonly material: MaterialEntry;
  readonly deduplicated: boolean;
}

export interface MaterialPage {
  readonly materials: readonly MaterialEntry[];
  readonly nextCursor: string;
}

export interface MaterialEntry {
  readonly materialId: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly byteSize: bigint;
  readonly contentHash: string;
  readonly createdAt: string;
}

export interface MaterialReadChunk {
  readonly data: Uint8Array;
  readonly material?: MaterialEntry | undefined;
}

export interface MaterialPlaybackGrant {
  readonly grantId: string;
  readonly url: string;
  readonly expiresAtMs: number;
  readonly mimeType: string;
  readonly byteSize: bigint;
}

/**
 * Browser-facing adapter for the opt-in loopback material bridge. It uses only
 * binary gRPC-Web calls and streams a File in bounded chunks, leaving the
 * definitive hash and content-addressed commit to the local bridge.
 */
export class BridgeMaterialClient implements MaterialLibraryClient {
  readonly origin: MaterialOrigin = 'local-mirror';
  readonly #client: BridgeMaterialRpcClient;

  constructor(
    baseUrl = process.env.NEXT_PUBLIC_HQ_BRIDGE_URL ?? defaultBridgeUrl,
    private readonly mountId = 'materials',
    client?: BridgeMaterialRpcClient,
    private readonly fileHasher: BrowserFileHasher = browserBlake3Hasher,
  ) {
    this.#client =
      client ??
      createClient(
        FileBridgeService,
        createGrpcWebTransport({
          baseUrl,
          useBinaryFormat: true,
        }),
      );
  }

  async importFile(
    file: File,
    onProgress?: (progress: MaterialImportProgress) => void,
    signal?: AbortSignal,
  ): Promise<MaterialImportResult> {
    assertSafeBrowserFile(file);
    onProgress?.({
      phase: 'starting',
      fileName: file.name,
      receivedBytes: 0,
      totalBytes: file.size,
    });
    const expectedBlake3 = await this.fileHasher.hash(
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
    const started = await this.#client.beginMaterialImport(
      {
        mountId: this.mountId,
        fileName: file.name,
        declaredMimeType: file.type,
        totalSize: BigInt(file.size),
        // The bridge recomputes this digest while committing the object. The
        // browser value is an expected hash, never an authority decision.
        expectedBlake3,
      },
      options(signal),
    );
    const session = required(started.session, 'Bridge did not return an import session.');

    try {
      await this.uploadFileChunks(file, session.uploadId, session.chunkSize, onProgress, signal);
      onProgress?.({
        phase: 'verifying',
        fileName: file.name,
        receivedBytes: file.size,
        totalBytes: file.size,
      });
      const completed = await this.#client.completeMaterialImport(
        { uploadId: session.uploadId },
        options(signal),
      );
      const material = required(completed.material, 'Bridge completed without a material record.');
      onProgress?.({
        phase: 'completed',
        fileName: file.name,
        receivedBytes: file.size,
        totalBytes: file.size,
      });
      return { material: toMaterialEntry(material), deduplicated: completed.deduplicated };
    } catch (error: unknown) {
      if (!signal?.aborted) {
        await this.#client
          .cancelMaterialImport({ uploadId: session.uploadId })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async getStatus(uploadId: string, signal?: AbortSignal) {
    const response = await this.#client.getMaterialImportStatus({ uploadId }, options(signal));
    return required(response.session, 'Bridge did not return import status.');
  }

  async cancel(uploadId: string, signal?: AbortSignal) {
    const response = await this.#client.cancelMaterialImport({ uploadId }, options(signal));
    return required(response.session, 'Bridge did not return cancelled import status.');
  }

  async list(cursor = '', pageSize = 50, signal?: AbortSignal): Promise<MaterialPage> {
    const response = await this.#client.listImportedMaterials(
      { mountId: this.mountId, cursor, pageSize },
      options(signal),
    );
    return {
      materials: response.materials.map(toMaterialEntry),
      nextCursor: response.nextCursor,
    };
  }

  async *readChunks(materialId: string, signal?: AbortSignal): AsyncGenerator<MaterialReadChunk> {
    for await (const chunk of this.#client.readImportedMaterial(
      { mountId: this.mountId, materialId },
      options(signal),
    )) {
      yield {
        data: chunk.data,
        ...(chunk.material ? { material: toMaterialEntry(chunk.material) } : {}),
      };
    }
  }

  async getPlaybackGrant(
    material: MaterialEntry,
    signal?: AbortSignal,
  ): Promise<MaterialPlaybackGrant> {
    const response = await this.#client.getMaterialPlaybackGrant(
      { mountId: this.mountId, materialId: material.materialId },
      options(signal),
    );
    return toMaterialPlaybackGrant(
      required(response.grant, 'Bridge did not return a material playback grant.'),
      material,
    );
  }

  async revokePlaybackGrant(grantId: string, signal?: AbortSignal): Promise<boolean> {
    if (!isMaterialId(grantId)) return false;
    const response = await this.#client.revokeMaterialPlaybackGrant({ grantId }, options(signal));
    return response.revoked;
  }

  /**
   * The bridge holds content and has no opinion about it.
   *
   * `BeginMaterialImport` names a mount, a file name, a declared MIME type, a
   * size and an expected digest -- and no category. So this returns the same
   * client rather than a differently configured one, and the operator's reading
   * of the content is recorded by the caller in `materials.imported`.
   */
  withCategory(): BridgeMaterialClient {
    return this;
  }

  /**
   * One rendition, because the bridge stores exactly what it was given.
   *
   * `FileBridgeService` has no variant selector anywhere in it: a playback
   * grant names a material and nothing else. Offering a ladder here would be a
   * menu whose entries all resolve to the same bytes with nothing to say so.
   */
  renditions(): readonly MaterialRendition[] {
    return [originalRendition];
  }

  async openRendition(
    material: MaterialEntry,
    _rendition: MaterialRendition,
    signal?: AbortSignal,
  ): Promise<MaterialRenditionSource> {
    const grant = await this.getPlaybackGrant(material, signal);
    return {
      grantId: grant.grantId,
      url: grant.url,
      mimeType: grant.mimeType,
      variant: '',
      rendered: false,
    };
  }

  private async uploadFileChunks(
    file: File,
    uploadId: string,
    maximumChunkSize: number,
    onProgress: ((progress: MaterialImportProgress) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (!Number.isSafeInteger(maximumChunkSize) || maximumChunkSize <= 0) {
      throw new Error('Bridge supplied an invalid material chunk size.');
    }
    const reader = file.stream().getReader();
    let offset = 0;
    try {
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) return;
        for (let start = 0; start < value.byteLength; start += maximumChunkSize) {
          throwIfAborted(signal);
          const data = value.slice(start, start + maximumChunkSize);
          const response = await this.#client.uploadMaterialChunk(
            { uploadId, offset: BigInt(offset), data },
            options(signal),
          );
          const session = required(response.session, 'Bridge did not acknowledge an import chunk.');
          offset = Number(session.receivedSize);
          if (!Number.isSafeInteger(offset)) {
            throw new Error('Bridge reported a material position outside the safe browser range.');
          }
          onProgress?.({
            phase: 'uploading',
            fileName: file.name,
            receivedBytes: offset,
            totalBytes: file.size,
          });
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function assertSafeBrowserFile(file: File): void {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.name.length === 0) {
    throw new Error('The selected material has invalid browser metadata.');
  }
}

function options(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new Error(message);
  return value;
}

function toMaterialEntry(material: BridgeMaterialEntry): MaterialEntry {
  return {
    materialId: material.materialId,
    displayName: material.displayName,
    mimeType: material.mimeType,
    byteSize: material.byteSize,
    contentHash: material.contentHash,
    createdAt: material.createdAt,
  };
}

function toMaterialPlaybackGrant(
  grant: BridgeMaterialPlaybackGrant,
  material: MaterialEntry,
): MaterialPlaybackGrant {
  if (!isMaterialId(grant.grantId))
    throw new Error('Bridge returned a malformed playback grant ID.');
  if (grant.byteSize !== material.byteSize || grant.mimeType !== material.mimeType) {
    throw new Error('Playback grant metadata differs from the selected material.');
  }
  const expiresAtMs = Number(grant.expiresAtMs);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
    throw new Error('Bridge returned an invalid playback grant deadline.');
  }
  return {
    grantId: grant.grantId,
    url: normalizePlaybackGrantUrl(grant.url, grant.grantId),
    expiresAtMs,
    mimeType: grant.mimeType,
    byteSize: grant.byteSize,
  };
}

export function normalizePlaybackGrantUrl(value: string, grantId: string): string {
  try {
    const url = new URL(value);
    const escapedGrantId = grantId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      !new RegExp(`^/v1/material-playback/${escapedGrantId}/[0-9a-f]{64}$`, 'iu').test(url.pathname)
    ) {
      throw new Error('unsafe playback URL');
    }
    return url.toString();
  } catch {
    throw new Error('Bridge returned an unsafe material playback URL.');
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
