import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConversionObjectStore } from '../storage/s3-object-store.js';

import { renditionSpecFor, renditionStorageKeyFor } from './ladder.js';
import { RenditionRenderError, type RenditionRenderer } from './renderer.js';
import type {
  ConversionJobClaim,
  ConversionJobStateName,
  DurableConversionStore,
} from './store.js';

/**
 * The consumer of `conversion_jobs`.
 *
 * One pass is: claim a job, fetch the source object with the server's own
 * credential, render the rung the job names, write the result back to the
 * bucket, and record the rendition and the job's completion in one statement.
 * A failure at any step is recorded on the job with the reason it failed, which
 * is the difference between a variant that is not built and a variant nobody
 * can explain.
 *
 * Three properties are worth stating because none of them is obvious from the
 * happy path.
 *
 * **Every pass works in its own directory.** `mkdtemp` under the system
 * temporary directory, removed in `finally` whatever happened. Two workers, or
 * two attempts of one job, never share a path, so neither can read the other's
 * half-written file; and a crash mid-render leaves at most one directory rather
 * than a growing pile keyed by job id.
 *
 * **The bucket is written before the database.** If the process dies between
 * the upload and the completion, the object is an orphan at a content-addressed
 * key and the job is re-claimed after its lease expires; the retry overwrites
 * the same key and records the rendition. The other order would produce a
 * rendition row pointing at an object that was never written -- a variant the
 * menu offers and the bucket answers 404 for.
 *
 * **A failure the retry cannot change is recorded as final.** An unknown
 * variant and an oversized source both fail permanently, because spending two
 * more bucket downloads to reach the same refusal would only bury the reason
 * under two more attempts.
 */

export interface ConversionWorkerOptions {
  readonly store: DurableConversionStore;
  readonly objects: ConversionObjectStore;
  readonly renderer: RenditionRenderer;
  /**
   * The largest source this deployment converts. A take larger than this is
   * left as the original rather than pulled through the control plane's disk;
   * the menu keeps saying the original was served, which is true.
   */
  readonly maxSourceBytes?: bigint;
  /** Where the per-pass directory is created. Defaults to the system temp dir. */
  readonly workDirectory?: string;
  readonly pollIntervalMs?: number;
  /** Called with every failure, so a deployment can log what it records. */
  readonly onFailure?: (failure: ConversionFailure) => void;
}

export interface ConversionFailure {
  readonly jobId: string;
  readonly variant: string;
  readonly detail: string;
  /** `undefined` when the claim was stale and the failure changed nothing. */
  readonly state: ConversionJobStateName | undefined;
}

export type ConversionRunOutcome =
  /** Nothing was claimable. */
  | { readonly outcome: 'idle' }
  | {
      readonly outcome: 'completed';
      readonly jobId: string;
      readonly variant: string;
      readonly storageKey: string;
      readonly mimeType: string;
      readonly byteSize: bigint;
      readonly width: number;
      readonly height: number;
    }
  | { readonly outcome: 'failed'; readonly failure: ConversionFailure }
  /** The render finished, but the lease had already been taken over. */
  | { readonly outcome: 'stale'; readonly jobId: string; readonly variant: string };

const defaultMaxSourceBytes = 8n * 1024n * 1024n * 1024n;
const defaultPollIntervalMs = 5_000;

export class MaterialConversionWorker {
  readonly #store: DurableConversionStore;
  readonly #objects: ConversionObjectStore;
  readonly #renderer: RenditionRenderer;
  readonly #maxSourceBytes: bigint;
  readonly #workDirectory: string;
  readonly #pollIntervalMs: number;
  readonly #onFailure: ((failure: ConversionFailure) => void) | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #pass: Promise<unknown> = Promise.resolve();

  constructor(options: ConversionWorkerOptions) {
    this.#store = options.store;
    this.#objects = options.objects;
    this.#renderer = options.renderer;
    this.#maxSourceBytes = options.maxSourceBytes ?? defaultMaxSourceBytes;
    this.#workDirectory = options.workDirectory ?? tmpdir();
    this.#pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    this.#onFailure = options.onFailure;
  }

  /**
   * Claims and finishes at most one job.
   *
   * One job per call rather than a drain loop, so a caller decides how much of
   * the queue this process takes; `runUntilIdle` is the drain, and the interval
   * loop takes one job per tick so a single worker cannot monopolise a machine.
   */
  async runOnce(): Promise<ConversionRunOutcome> {
    const claim = await this.#store.claimNextJob();
    if (claim === undefined) return { outcome: 'idle' };

    const spec = renditionSpecFor(claim.sourceMimeType, claim.variant);
    if (spec === undefined) {
      // The ladder is the only source of variant names, so this means the row
      // outlived the rung -- a queued job for a ladder that has since changed,
      // or a type whose ladder was removed. Nothing a retry reaches.
      return this.#fail(
        claim,
        `no rendition rung named ${claim.variant} for ${claim.sourceMimeType}`,
        true,
      );
    }
    if (claim.sourceByteSize > this.#maxSourceBytes) {
      return this.#fail(
        claim,
        `source of ${claim.sourceByteSize.toString()} bytes exceeds the ${this.#maxSourceBytes.toString()}-byte conversion ceiling`,
        true,
      );
    }

    const directory = await mkdtemp(join(this.#workDirectory, 'hq-conversion-'));
    try {
      const sourcePath = join(directory, 'source');
      const outputPath = join(directory, `rendition.${spec.extension}`);
      await this.#objects.downloadObject(claim.sourceStorageKey, sourcePath);
      const rendered = await this.#renderer.render({ sourcePath, outputPath, spec });
      const storageKey = renditionStorageKeyFor(claim.groupId, claim.sourceContentHash, spec);
      await this.#objects.uploadObject(storageKey, outputPath, spec.mimeType);
      const completed = await this.#store.completeJob(claim, {
        storageKey,
        mimeType: spec.mimeType,
        byteSize: rendered.byteSize,
        width: rendered.width,
        height: rendered.height,
      });
      if (!completed) {
        return { outcome: 'stale', jobId: claim.jobId, variant: claim.variant };
      }
      return {
        outcome: 'completed',
        jobId: claim.jobId,
        variant: claim.variant,
        storageKey,
        mimeType: spec.mimeType,
        byteSize: rendered.byteSize,
        width: rendered.width,
        height: rendered.height,
      };
    } catch (error: unknown) {
      return await this.#fail(claim, describeFailure(error), false);
    } finally {
      // Whatever happened, the source and the output leave this machine. A
      // worker that kept them would accumulate a copy of the whole library on
      // the control plane's disk.
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Drains the queue, with a bound so a producing peer cannot make this loop forever. */
  async runUntilIdle(maxJobs = 32): Promise<readonly ConversionRunOutcome[]> {
    const outcomes: ConversionRunOutcome[] = [];
    for (let taken = 0; taken < maxJobs; taken += 1) {
      const outcome = await this.runOnce();
      if (outcome.outcome === 'idle') break;
      outcomes.push(outcome);
    }
    return outcomes;
  }

  /**
   * Starts the polling loop.
   *
   * A timer rather than a subscription, for the reason `WatchMaterialEvents`
   * polls: the Neon HTTP driver carries no `LISTEN`/`NOTIFY` channel, and the
   * realtime hub's log belongs to document synchronization rather than to the
   * library. `unref` so a poll pending at shutdown does not hold the process
   * open, and one pass at a time so a slow transcode cannot be overlapped by
   * the next tick.
   */
  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      this.#pass = this.#pass
        .then(() => this.runOnce())
        // A failure here is a failure to *record* a failure -- an unreachable
        // database. Swallowing it keeps the loop alive for the next tick;
        // nothing is lost, because the job's lease is what returns it to the
        // queue.
        .catch(() => undefined);
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    // Awaited, so a caller shutting down does not race a pass that is still
    // holding a temporary directory open.
    await this.#pass.catch(() => undefined);
  }

  async #fail(
    claim: ConversionJobClaim,
    detail: string,
    permanent: boolean,
  ): Promise<ConversionRunOutcome> {
    const state = await this.#store.failJob(claim, detail, permanent);
    const failure: ConversionFailure = {
      jobId: claim.jobId,
      variant: claim.variant,
      detail,
      state,
    };
    this.#onFailure?.(failure);
    return { outcome: 'failed', failure };
  }
}

/**
 * What a job records about a failure.
 *
 * A {@link RenditionRenderError} already carries the bounded tail the renderer
 * chose; anything else is described by its message alone. The stack is never
 * recorded: a `detail` column read by an operator on a shoot wants the reason,
 * and a stack is the one part of an error most likely to name a path on the
 * machine that ran it.
 */
function describeFailure(error: unknown): string {
  if (error instanceof RenditionRenderError) return error.detail;
  if (error instanceof Error) return error.message;
  return 'the conversion failed with a non-error value';
}
