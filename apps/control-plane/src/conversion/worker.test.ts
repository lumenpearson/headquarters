import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConversionObjectStore } from '../storage/s3-object-store.js';

import { RenditionRenderError, type RenderRequest, type RenditionRenderer } from './renderer.js';
import type {
  CompletedRenditionInput,
  ConversionJobClaim,
  ConversionJobStateName,
  DurableConversionStore,
} from './store.js';
import { MaterialConversionWorker } from './worker.js';

/**
 * What one pass of the worker does, proved against a deterministic queue, a
 * deterministic bucket and a deterministic renderer.
 *
 * These are the semantics: which order the bucket and the database are written
 * in, what a failure records, which failures are final, and that the pass
 * leaves nothing on disk. What they cannot show is that any of it survives a
 * real lease, a real lock or a real ffmpeg -- `conversion.integration.test.ts`
 * and `conversion.live.integration.test.ts` do that.
 */
const groupId = '018b2a02-0000-7000-8000-0000000000a1';
const materialId = '018b2a02-0000-7000-8000-0000000000b1';
const versionId = '018b2a02-0000-7000-8000-0000000000d1';
const contentHash = '4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a';

describe('material conversion worker', () => {
  let workDirectory = '';

  beforeEach(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'hq-worker-test-'));
  });

  afterEach(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  it('answers idle without touching the bucket when nothing is claimable', async () => {
    const queue = new FakeQueue([]);
    const objects = new FakeObjectStore();
    const worker = createWorker(queue, objects, renderingTo(1280, 720));

    await expect(worker.runOnce()).resolves.toEqual({ outcome: 'idle' });
    expect(objects.downloads).toEqual([]);
    expect(objects.uploads).toEqual([]);
  });

  it('fetches the source, renders the rung and records the rendition it produced', async () => {
    const queue = new FakeQueue([claim('720p')]);
    const objects = new FakeObjectStore();
    const worker = createWorker(queue, objects, renderingTo(1280, 720));

    const outcome = await worker.runOnce();

    expect(outcome).toMatchObject({
      outcome: 'completed',
      variant: '720p',
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      storageKey: `renditions/${groupId}/${contentHash}/720p.mp4`,
    });
    expect(objects.downloads).toEqual([`materials/${groupId}/${contentHash}`]);
    expect(queue.completions).toEqual([
      {
        storageKey: `renditions/${groupId}/${contentHash}/720p.mp4`,
        mimeType: 'video/mp4',
        byteSize: 2048n,
        width: 1280,
        height: 720,
      },
    ]);
    expect(queue.failures).toEqual([]);
  });

  /*
   * The bucket first, the database second. A crash between them leaves an
   * orphan object at a content-addressed key and a job that is re-claimed after
   * its lease; the other order would record a rendition the bucket answers 404
   * for, which the menu would offer and the player would fail to open.
   */
  it('writes the object before the database row that names it', async () => {
    const order: string[] = [];
    const queue = new FakeQueue([claim('720p')], order);
    const objects = new FakeObjectStore(order);
    const worker = createWorker(queue, objects, renderingTo(1280, 720));

    await worker.runOnce();

    expect(order).toEqual(['download', 'upload', 'complete']);
  });

  it('reports a claim taken over while it was rendering, without failing the job', async () => {
    const queue = new FakeQueue([claim('720p')]);
    queue.completionAnswer = false;
    const worker = createWorker(queue, new FakeObjectStore(), renderingTo(1280, 720));

    await expect(worker.runOnce()).resolves.toMatchObject({ outcome: 'stale', variant: '720p' });
    expect(queue.failures).toEqual([]);
  });

  /*
   * The honest-failure requirement: a failed job names the tail of what the
   * renderer said, so a variant that was never built can be told from a variant
   * that was never asked for.
   */
  it('records the renderer detail on the job when a render fails', async () => {
    const queue = new FakeQueue([claim('720p')]);
    const failing: RenditionRenderer = {
      render: () =>
        Promise.reject(new RenditionRenderError('ffmpeg exited with 1: Invalid data found')),
    };
    const seen: string[] = [];
    const worker = createWorker(queue, new FakeObjectStore(), failing, {
      onFailure: (failure) => seen.push(failure.detail),
    });

    const outcome = await worker.runOnce();

    expect(outcome).toMatchObject({
      outcome: 'failed',
      failure: { detail: 'ffmpeg exited with 1: Invalid data found', state: 'PENDING' },
    });
    expect(queue.failures).toEqual([
      { detail: 'ffmpeg exited with 1: Invalid data found', permanent: false },
    ]);
    expect(seen).toEqual(['ffmpeg exited with 1: Invalid data found']);
    // Nothing was uploaded, so no key names a rendition that does not exist.
    expect(queue.completions).toEqual([]);
  });

  it('records a bucket failure with the operation that failed', async () => {
    const queue = new FakeQueue([claim('720p')]);
    const objects = new FakeObjectStore();
    objects.downloadError = new Error('Object storage GetObject failed with status 403');
    const worker = createWorker(queue, objects, renderingTo(1280, 720));

    await expect(worker.runOnce()).resolves.toMatchObject({
      outcome: 'failed',
      failure: { detail: 'Object storage GetObject failed with status 403' },
    });
  });

  it('fails a variant the ladder does not declare permanently, before any download', async () => {
    const queue = new FakeQueue([claim('4k')]);
    const objects = new FakeObjectStore();
    const worker = createWorker(queue, objects, renderingTo(1280, 720));

    const outcome = await worker.runOnce();

    expect(outcome).toMatchObject({
      outcome: 'failed',
      failure: { detail: 'no rendition rung named 4k for video/mp4', state: 'FAILED' },
    });
    expect(queue.failures[0]?.permanent).toBe(true);
    expect(objects.downloads).toEqual([]);
  });

  it('fails a source above the ceiling permanently, before any download', async () => {
    const queue = new FakeQueue([{ ...claim('720p'), sourceByteSize: 4_096n }]);
    const objects = new FakeObjectStore();
    const worker = createWorker(queue, objects, renderingTo(1280, 720), {
      maxSourceBytes: 1_024n,
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      outcome: 'failed',
      failure: {
        detail: 'source of 4096 bytes exceeds the 1024-byte conversion ceiling',
        state: 'FAILED',
      },
    });
    expect(objects.downloads).toEqual([]);
  });

  /*
   * A worker that kept its scratch files would accumulate a copy of the whole
   * library on the control plane's disk. The directory goes whether the pass
   * succeeded or failed.
   */
  it('leaves nothing on disk, after a success and after a failure', async () => {
    const objects = new FakeObjectStore();
    await createWorker(new FakeQueue([claim('720p')]), objects, renderingTo(1280, 720)).runOnce();
    expect(await readdir(workDirectory)).toEqual([]);

    const failing: RenditionRenderer = {
      render: () => Promise.reject(new RenditionRenderError('boom')),
    };
    await createWorker(new FakeQueue([claim('720p')]), objects, failing).runOnce();
    expect(await readdir(workDirectory)).toEqual([]);
  });

  it('drains the queue one job at a time and stops when it is empty', async () => {
    const queue = new FakeQueue([claim('1080p'), claim('720p'), claim('480p')]);
    const worker = createWorker(queue, new FakeObjectStore(), renderingTo(1280, 720));

    const outcomes = await worker.runUntilIdle();

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(queue.claims).toBe(4);
  });

  function createWorker(
    queue: FakeQueue,
    objects: ConversionObjectStore,
    renderer: RenditionRenderer,
    options: {
      readonly maxSourceBytes?: bigint;
      readonly onFailure?: (failure: { readonly detail: string }) => void;
    } = {},
  ): MaterialConversionWorker {
    return new MaterialConversionWorker({
      store: queue as unknown as DurableConversionStore,
      objects,
      renderer,
      workDirectory,
      ...(options.maxSourceBytes === undefined ? {} : { maxSourceBytes: options.maxSourceBytes }),
      ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
    });
  }
});

function claim(variant: string): ConversionJobClaim {
  return {
    jobId: `job-${variant}`,
    groupId,
    materialId,
    versionId,
    variant,
    attempt: 1,
    sourceStorageKey: `materials/${groupId}/${contentHash}`,
    sourceContentHash: contentHash,
    sourceMimeType: 'video/mp4',
    sourceByteSize: 1_048_576n,
  };
}

/** A renderer that writes a real file, so the worker's upload has something to send. */
function renderingTo(width: number, height: number): RenditionRenderer {
  return {
    async render(request: RenderRequest) {
      await writeFile(request.outputPath, 'x'.repeat(2048));
      return { width, height, byteSize: 2048n };
    },
  };
}

class FakeQueue {
  readonly completions: CompletedRenditionInput[] = [];
  readonly failures: { readonly detail: string; readonly permanent: boolean }[] = [];
  completionAnswer = true;
  claims = 0;
  readonly #pending: ConversionJobClaim[];
  readonly #order: string[] | undefined;

  constructor(claims: readonly ConversionJobClaim[], order?: string[]) {
    this.#pending = [...claims];
    this.#order = order;
  }

  claimNextJob(): Promise<ConversionJobClaim | undefined> {
    this.claims += 1;
    return Promise.resolve(this.#pending.shift());
  }

  completeJob(_claim: ConversionJobClaim, rendition: CompletedRenditionInput): Promise<boolean> {
    this.#order?.push('complete');
    this.completions.push(rendition);
    return Promise.resolve(this.completionAnswer);
  }

  failJob(
    _claim: ConversionJobClaim,
    detail: string,
    permanent = false,
  ): Promise<ConversionJobStateName | undefined> {
    this.failures.push({ detail, permanent });
    return Promise.resolve(permanent ? 'FAILED' : 'PENDING');
  }
}

class FakeObjectStore implements ConversionObjectStore {
  readonly downloads: string[] = [];
  readonly uploads: { readonly storageKey: string; readonly mimeType: string }[] = [];
  downloadError: Error | undefined;
  readonly #order: string[] | undefined;

  constructor(order?: string[]) {
    this.#order = order;
  }

  async downloadObject(storageKey: string, destinationPath: string): Promise<void> {
    this.#order?.push('download');
    if (this.downloadError !== undefined) throw this.downloadError;
    this.downloads.push(storageKey);
    await writeFile(destinationPath, 'source bytes');
  }

  uploadObject(storageKey: string, _sourcePath: string, mimeType: string): Promise<void> {
    this.#order?.push('upload');
    this.uploads.push({ storageKey, mimeType });
    return Promise.resolve();
  }
}
