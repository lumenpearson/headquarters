import { createReadStream } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { BridgeConfig } from '@gremuchaya/config';
import { BridgeFailure } from '@gremuchaya/protocol';

import { BridgeFailureError, type BridgeFailureCode } from './errors.js';
import { mimeForPath } from './mime.js';

const materialMountId = 'materials';
const internalDirectory = '.hq';
const importState = {
  pending: 'PENDING',
  uploading: 'UPLOADING',
  verifying: 'VERIFYING',
  completed: 'COMPLETED',
  cancelled: 'CANCELLED',
  failed: 'FAILED',
} as const;

type ImportState = (typeof importState)[keyof typeof importState];

export interface MaterialImportSession {
  readonly uploadId: string;
  readonly totalSize: number;
  readonly receivedSize: number;
  readonly chunkSize: number;
  readonly state: ImportState;
}

export interface MaterialImportEntry {
  readonly materialId: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly contentHash: string;
  readonly createdAt: string;
}

interface ActiveImport extends MaterialImportSession {
  readonly mountRoot: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly expectedHash: string | undefined;
  readonly temporaryPath: string;
}

interface StoredMaterial extends MaterialImportEntry {
  readonly objectPath: string;
}

/**
 * A refusal from the mirror, carrying the code it crosses the wire with.
 *
 * The message stays for this process's logs and for the tests that read it; it
 * is not what a device is shown. Several refusals deliberately share one code --
 * the four chunk rejections, the five unreadable-record cases -- because they
 * are one situation to whoever is looking at the screen, and a code exists to
 * be translated, not to enumerate branches.
 */
export class MaterialMirrorError extends BridgeFailureError {
  constructor(code: BridgeFailureCode, message: string) {
    super(code, message);
    this.name = 'MaterialMirrorError';
  }
}

/**
 * A bounded local mirror for browser uploads. Files are first written below
 * `.hq/upload-cache`, verified with BLAKE3, and then atomically moved to the
 * content-addressed object tree. Nothing from the transient tree is visible to
 * the ordinary bridge explorer.
 */
export class MaterialMirror {
  readonly #imports = new Map<string, ActiveImport>();

  constructor(private readonly config: BridgeConfig) {}

  async initialize(): Promise<void> {
    const root = this.materialRoot();
    await Promise.all([
      mkdir(join(root, internalDirectory, 'upload-cache'), { recursive: true }),
      mkdir(join(root, internalDirectory, 'objects', 'blake3'), { recursive: true }),
      mkdir(join(root, internalDirectory, 'material-records'), { recursive: true }),
      mkdir(join(root, internalDirectory, 'quarantine'), { recursive: true }),
    ]);
  }

  async begin(input: {
    readonly mountId: string;
    readonly fileName: string;
    readonly declaredMimeType: string;
    readonly totalSize: bigint;
    readonly expectedBlake3: string;
  }): Promise<MaterialImportSession> {
    this.assertEnabled();
    const root = this.materialRoot(input.mountId);
    const totalSize = numberFromUint64(input.totalSize, 'total_size');
    if (totalSize > this.config.materialImport.maxFileBytes) {
      throw new MaterialMirrorError(
        BridgeFailure.MATERIAL_TOO_LARGE,
        'Material exceeds the configured maximum file size.',
      );
    }
    assertSafeFileName(input.fileName);
    const expectedHash = normalizeHash(input.expectedBlake3);
    const uploadId = createUuidV7();
    const temporaryPath = join(root, internalDirectory, 'upload-cache', `${uploadId}.part`);
    await open(temporaryPath, 'wx').then((file) => file.close());
    const session: ActiveImport = {
      uploadId,
      totalSize,
      receivedSize: 0,
      chunkSize: this.config.materialImport.chunkSizeBytes,
      state: importState.pending,
      mountRoot: root,
      fileName: input.fileName,
      // Extension-derived MIME is deterministic; the browser-provided value is
      // deliberately not trusted as a content classification decision.
      mimeType: mimeForPath(input.fileName),
      expectedHash,
      temporaryPath,
    };
    this.#imports.set(uploadId, session);
    return toPublicSession(session);
  }

  async append(uploadId: string, offset: bigint, data: Uint8Array): Promise<MaterialImportSession> {
    const active = this.requireActive(uploadId);
    const expectedOffset = BigInt(active.receivedSize);
    if (offset !== expectedOffset) {
      throw new MaterialMirrorError(
        BridgeFailure.MATERIAL_CHUNK_REJECTED,
        'Chunk offset does not match the resumable upload position.',
      );
    }
    if (data.byteLength === 0 && active.totalSize !== 0) {
      throw new MaterialMirrorError(
        BridgeFailure.MATERIAL_CHUNK_REJECTED,
        'Empty chunks are not accepted for a non-empty material.',
      );
    }
    if (data.byteLength > active.chunkSize) {
      throw new MaterialMirrorError(
        BridgeFailure.MATERIAL_CHUNK_REJECTED,
        'Chunk exceeds the configured import chunk size.',
      );
    }
    if (active.receivedSize + data.byteLength > active.totalSize) {
      throw new MaterialMirrorError(
        BridgeFailure.MATERIAL_CHUNK_REJECTED,
        'Chunk would exceed the declared material size.',
      );
    }
    const file = await open(active.temporaryPath, 'r+');
    try {
      await file.write(data, 0, data.byteLength, active.receivedSize);
    } finally {
      await file.close();
    }
    const next: ActiveImport = {
      ...active,
      receivedSize: active.receivedSize + data.byteLength,
      state: importState.uploading,
    };
    this.#imports.set(uploadId, next);
    return toPublicSession(next);
  }

  status(uploadId: string): MaterialImportSession {
    return toPublicSession(this.requireActive(uploadId));
  }

  async complete(
    uploadId: string,
  ): Promise<{ readonly material: MaterialImportEntry; readonly deduplicated: boolean }> {
    let active = this.requireActive(uploadId);
    if (active.receivedSize !== active.totalSize) {
      throw new MaterialMirrorError(
        BridgeFailure.MATERIAL_UPLOAD_INCOMPLETE,
        'Material upload is incomplete.',
      );
    }
    active = { ...active, state: importState.verifying };
    this.#imports.set(uploadId, active);
    try {
      const contentHash = await hashFile(active.temporaryPath);
      if (active.expectedHash !== undefined && active.expectedHash !== contentHash) {
        await this.quarantine(active);
        const failed = { ...active, state: importState.failed };
        this.#imports.set(uploadId, failed);
        throw new MaterialMirrorError(
          BridgeFailure.MATERIAL_HASH_MISMATCH,
          'BLAKE3 verification failed for the uploaded material.',
        );
      }
      const objectPath = join(
        active.mountRoot,
        internalDirectory,
        'objects',
        'blake3',
        contentHash.slice(0, 2),
        contentHash,
      );
      await mkdir(
        join(active.mountRoot, internalDirectory, 'objects', 'blake3', contentHash.slice(0, 2)),
        {
          recursive: true,
        },
      );
      const deduplicated = await fileExists(objectPath);
      if (deduplicated) await unlink(active.temporaryPath);
      else await rename(active.temporaryPath, objectPath);

      const record: StoredMaterial = {
        materialId: createUuidV7(),
        displayName: active.fileName,
        mimeType: active.mimeType,
        byteSize: active.totalSize,
        contentHash,
        createdAt: new Date().toISOString(),
        objectPath,
      };
      await writeStoredMaterial(active.mountRoot, record);
      this.#imports.delete(uploadId);
      return { material: stripObjectPath(record), deduplicated };
    } catch (error: unknown) {
      if (error instanceof MaterialMirrorError) throw error;
      const failed = { ...active, state: importState.failed };
      this.#imports.set(uploadId, failed);
      throw error;
    }
  }

  async cancel(uploadId: string): Promise<MaterialImportSession> {
    const active = this.requireActive(uploadId);
    await rm(active.temporaryPath, { force: true });
    const cancelled = { ...active, state: importState.cancelled };
    this.#imports.delete(uploadId);
    return toPublicSession(cancelled);
  }

  async list(
    mountId: string,
    pageSize: number,
    cursor: string,
  ): Promise<{ readonly materials: readonly MaterialImportEntry[]; readonly nextCursor: string }> {
    const root = this.materialRoot(mountId);
    const recordsDirectory = join(root, internalDirectory, 'material-records');
    const fileNames = await readdir(recordsDirectory).catch((error: unknown) => {
      if (hasCode(error, 'ENOENT')) return [];
      throw error;
    });
    const entries = await Promise.all(
      fileNames
        .filter((fileName) => fileName.endsWith('.json'))
        .map(async (fileName) =>
          parseStoredMaterial(await readFile(join(recordsDirectory, fileName), 'utf8')),
        ),
    );
    const sorted = entries.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.materialId.localeCompare(left.materialId),
    );
    const startIndex =
      cursor.length === 0
        ? 0
        : Math.max(0, sorted.findIndex((entry) => entry.materialId === cursor) + 1);
    const size = Math.max(1, Math.min(pageSize || 50, 200));
    const page = sorted.slice(startIndex, startIndex + size);
    return {
      materials: page.map(stripObjectPath),
      nextCursor: startIndex + page.length < sorted.length ? (page.at(-1)?.materialId ?? '') : '',
    };
  }

  async resolve(
    mountId: string,
    materialId: string,
  ): Promise<{ readonly material: MaterialImportEntry; readonly path: string }> {
    const root = this.materialRoot(mountId);
    if (!isUuid(materialId))
      throw new MaterialMirrorError(BridgeFailure.MATERIAL_NOT_FOUND, 'Material ID is malformed.');
    const recordPath = join(root, internalDirectory, 'material-records', `${materialId}.json`);
    // The ENOENT `readFile` raises quotes the absolute record path. It is
    // classified here, where the absence of the record is what the answer means,
    // rather than left to the transport -- which would otherwise be deciding
    // what to say from a Node message that names the mirror on disk.
    const serialized = await readFile(recordPath, 'utf8').catch((error: unknown) => {
      if (hasCode(error, 'ENOENT')) {
        throw new MaterialMirrorError(
          BridgeFailure.MATERIAL_NOT_FOUND,
          'No material record answers that identifier.',
        );
      }
      throw error;
    });
    const record = parseStoredMaterial(serialized);
    if (!isPathContained(root, record.objectPath)) {
      throw new MaterialMirrorError(
        BridgeFailure.MATERIAL_RECORD_UNREADABLE,
        'Material record points outside the configured mirror.',
      );
    }
    const [canonicalRoot, canonicalObject] = await Promise.all([
      realpath(root),
      realpath(record.objectPath),
    ]);
    if (!isPathContained(canonicalRoot, canonicalObject)) {
      throw new MaterialMirrorError(
        BridgeFailure.MATERIAL_RECORD_UNREADABLE,
        'Material object resolves outside the configured mirror.',
      );
    }
    const metadata = await stat(canonicalObject);
    if (!metadata.isFile() || metadata.size !== record.byteSize) {
      throw new MaterialMirrorError(
        BridgeFailure.MATERIAL_RECORD_UNREADABLE,
        'Material object is missing or has an unexpected size.',
      );
    }
    return { material: stripObjectPath(record), path: canonicalObject };
  }

  private materialRoot(mountId = materialMountId): string {
    if (mountId !== materialMountId) {
      throw new MaterialMirrorError(
        BridgeFailure.MATERIAL_MOUNT_UNAVAILABLE,
        `Material imports are restricted to the '${materialMountId}' mount.`,
      );
    }
    const mount = this.config.mounts.find((candidate) => candidate.id === mountId);
    if (mount === undefined)
      throw new MaterialMirrorError(
        BridgeFailure.MATERIAL_MOUNT_UNAVAILABLE,
        `Missing '${materialMountId}' bridge mount.`,
      );
    return resolve(mount.root);
  }

  private requireActive(uploadId: string): ActiveImport {
    const active = this.#imports.get(uploadId);
    if (active === undefined)
      throw new MaterialMirrorError(
        BridgeFailure.MATERIAL_SESSION_NOT_FOUND,
        'Material import session was not found.',
      );
    return active;
  }

  private assertEnabled(): void {
    if (this.config.readOnly || !this.config.materialImport.enabled) {
      throw new MaterialMirrorError(
        BridgeFailure.MATERIAL_IMPORT_DISABLED,
        'Material imports are disabled for this bridge.',
      );
    }
  }

  private async quarantine(active: ActiveImport): Promise<void> {
    const destination = join(
      active.mountRoot,
      internalDirectory,
      'quarantine',
      `${active.uploadId}.part`,
    );
    await rename(active.temporaryPath, destination);
  }
}

function toPublicSession(session: MaterialImportSession): MaterialImportSession {
  return {
    uploadId: session.uploadId,
    totalSize: session.totalSize,
    receivedSize: session.receivedSize,
    chunkSize: session.chunkSize,
    state: session.state,
  };
}

function stripObjectPath(record: StoredMaterial): MaterialImportEntry {
  const { objectPath: _objectPath, ...material } = record;
  return material;
}

async function hashFile(path: string): Promise<string> {
  const hash = blake3.create();
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk);
  }
  return bytesToHex(hash.digest());
}

async function writeStoredMaterial(root: string, record: StoredMaterial): Promise<void> {
  const recordsDirectory = join(root, internalDirectory, 'material-records');
  const target = join(recordsDirectory, `${record.materialId}.json`);
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, target);
}

function parseStoredMaterial(serialized: string): StoredMaterial {
  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value))
    throw new MaterialMirrorError(
      BridgeFailure.MATERIAL_RECORD_UNREADABLE,
      'Material record is malformed.',
    );
  const requiredString = (key: keyof StoredMaterial): string => {
    const candidate = value[key];
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new MaterialMirrorError(
        BridgeFailure.MATERIAL_RECORD_UNREADABLE,
        `Material record is missing '${key}'.`,
      );
    }
    return candidate;
  };
  const byteSize = value.byteSize;
  if (typeof byteSize !== 'number' || !Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new MaterialMirrorError(
      BridgeFailure.MATERIAL_RECORD_UNREADABLE,
      'Material record has an invalid byte size.',
    );
  }
  const materialId = requiredString('materialId');
  if (!isUuid(materialId))
    throw new MaterialMirrorError(
      BridgeFailure.MATERIAL_RECORD_UNREADABLE,
      'Material record has an invalid ID.',
    );
  const contentHash = requiredString('contentHash');
  if (!/^[a-f0-9]{64}$/u.test(contentHash)) {
    throw new MaterialMirrorError(
      BridgeFailure.MATERIAL_RECORD_UNREADABLE,
      'Material record has an invalid BLAKE3 hash.',
    );
  }
  return {
    materialId,
    displayName: requiredString('displayName'),
    mimeType: requiredString('mimeType'),
    byteSize,
    contentHash,
    createdAt: requiredString('createdAt'),
    objectPath: requiredString('objectPath'),
  };
}

function assertSafeFileName(fileName: string): void {
  if (
    fileName.length === 0 ||
    fileName.length > 255 ||
    basename(fileName) !== fileName ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('\0')
  ) {
    throw new MaterialMirrorError(
      BridgeFailure.MATERIAL_NAME_UNSAFE,
      'Material file name is unsafe.',
    );
  }
}

function normalizeHash(value: string): string | undefined {
  if (value.length === 0) return undefined;
  const normalized = value.toLocaleLowerCase('en-US');
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new MaterialMirrorError(
      BridgeFailure.MATERIAL_REQUEST_INVALID,
      'Expected BLAKE3 must be a 32-byte hexadecimal digest.',
    );
  }
  return normalized;
}

function numberFromUint64(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MaterialMirrorError(
      BridgeFailure.MATERIAL_REQUEST_INVALID,
      `${label} exceeds the supported safe integer range.`,
    );
  }
  return Number(value);
}

function createUuidV7(): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hexadecimal = bytes.toString('hex');
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathContained(root: string, target: string): boolean {
  const difference = relative(resolve(root), resolve(target));
  return (
    difference === '' ||
    (!difference.startsWith('../') &&
      !difference.startsWith('..\\') &&
      difference !== '..' &&
      !isAbsolute(difference))
  );
}
