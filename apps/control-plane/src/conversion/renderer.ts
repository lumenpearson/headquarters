import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';

import type { RenditionSpec } from './ladder.js';

/**
 * The renderer: the one place in this package that runs another program.
 *
 * Everything about how it is invoked is defensive, because the input is a file
 * a device uploaded and the variant is a string a device asked for.
 *
 * - **No shell, ever.** `execFile` with an argument array, never `exec` with a
 *   command line. A file name is an argument and cannot become a command.
 * - **No request data in the arguments.** The filter and codec arguments come
 *   from {@link RenditionSpec}'s fixed table; the only values that vary are the
 *   two paths, and both are made by the worker in a directory it created.
 * - **`-nostdin`.** ffmpeg reads its standard input for interactive keys, and a
 *   worker has no terminal to give it; without this a malformed input can leave
 *   the process waiting on a keypress that never comes.
 * - **A timeout and a killed process.** A hung transcode otherwise holds its
 *   lease until the lease expires and then holds a second one, forever. The
 *   timeout turns that into a failure with a name.
 * - **A bounded stderr.** `maxBuffer` caps what a chatty failure can allocate,
 *   and the store bounds again before the tail reaches a row.
 *
 * The dimensions in the result are *measured* from the produced file with
 * ffprobe rather than copied from the rung's table. That difference is what
 * makes a preview grant's `width`/`height` an honest statement: the ladder
 * never upscales, so a 480-tall source asked for `1080p` produces a 480-tall
 * object, and reporting 1080 would be a lie the client would print.
 */

export interface RenderRequest {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly spec: RenditionSpec;
}

export interface RenderResult {
  readonly width: number;
  readonly height: number;
  readonly byteSize: bigint;
}

export interface RenditionRenderer {
  render(request: RenderRequest): Promise<RenderResult>;
}

/**
 * A render that did not produce a usable file, carrying the detail a job row
 * records. The message is for a log; `detail` is the bounded tail the operator
 * reads out of `conversion_jobs`.
 */
export class RenditionRenderError extends Error {
  constructor(readonly detail: string) {
    super(`Rendition render failed: ${detail}`);
    this.name = 'RenditionRenderError';
  }
}

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the process was killed for exceeding its time budget. */
  readonly timedOut: boolean;
}

export type RunProcess = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<ProcessResult>;

export interface FfmpegRendererOptions {
  /** Defaults to `ffmpeg` on PATH. */
  readonly ffmpegPath?: string;
  /** Defaults to `ffprobe` on PATH. */
  readonly ffprobePath?: string;
  readonly timeoutMs?: number;
  /** Injected so the worker's tests never spawn a process. */
  readonly run?: RunProcess;
}

const defaultTimeoutMs = 10 * 60 * 1000;
/** Enough for a full ffmpeg failure; more than that is a log, not a diagnosis. */
const maxProcessOutputBytes = 256 * 1024;

export function createFfmpegRenditionRenderer(
  options: FfmpegRendererOptions = {},
): RenditionRenderer {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const run = options.run ?? runProcess;

  return {
    async render(request: RenderRequest): Promise<RenderResult> {
      const rendered = await run(
        ffmpegPath,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          // Overwrite: the worker created the output directory itself, so the
          // only file that can be there is one an earlier attempt of this same
          // job left behind.
          '-y',
          '-i',
          request.sourcePath,
          ...request.spec.ffmpegArguments,
          request.outputPath,
        ],
        timeoutMs,
      );
      if (rendered.timedOut) {
        throw new RenditionRenderError(
          `ffmpeg exceeded its ${timeoutMs.toString()}ms budget and was stopped`,
        );
      }
      if (rendered.code !== 0) {
        throw new RenditionRenderError(
          `ffmpeg exited with ${String(rendered.code)}: ${rendered.stderr}`,
        );
      }

      const size = await fileSize(request.outputPath);
      if (size <= 0n) {
        // ffmpeg can exit zero having written nothing -- an input with no video
        // stream and a video-only filter graph does exactly that. An empty
        // rendition must not become a variant the menu offers.
        throw new RenditionRenderError('ffmpeg produced an empty file');
      }

      const probed = await run(
        ffprobePath,
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=width,height',
          '-of',
          'csv=p=0:s=x',
          request.outputPath,
        ],
        timeoutMs,
      );
      if (probed.timedOut || probed.code !== 0) {
        throw new RenditionRenderError(
          `ffprobe exited with ${String(probed.code)}: ${probed.stderr}`,
        );
      }
      const dimensions = parseDimensions(probed.stdout);
      if (dimensions === undefined) {
        throw new RenditionRenderError(
          `ffprobe reported no picture size for the rendition: ${probed.stdout.trim()}`,
        );
      }
      return { ...dimensions, byteSize: size };
    },
  };
}

/**
 * `WxH` from ffprobe's CSV output, taking the first stream it printed.
 *
 * A file with several video streams prints several lines; the first is the one
 * `-select_streams v:0` asked for, and a trailing empty line is ordinary.
 */
export function parseDimensions(
  output: string,
): { readonly width: number; readonly height: number } | undefined {
  for (const line of output.split('\n')) {
    const match = /^(\d+)x(\d+)$/u.exec(line.trim());
    if (match === null) continue;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width > 0 && height > 0) return { width, height };
  }
  return undefined;
}

async function fileSize(path: string): Promise<bigint> {
  try {
    const { size } = await stat(path);
    return BigInt(size);
  } catch {
    // ffmpeg exited zero and there is no file: treat it as an empty render
    // rather than letting a missing-file error escape as an unexplained crash.
    return 0n;
  }
}

const runProcess: RunProcess = (command, args, timeoutMs) =>
  new Promise<ProcessResult>((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: timeoutMs,
        maxBuffer: maxProcessOutputBytes,
        // No shell, and no inherited environment beyond what the process
        // already has: nothing here builds a command line for one to parse.
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const killed =
          error !== null && typeof error === 'object' && 'killed' in error
            ? Boolean((error as { killed?: boolean }).killed)
            : false;
        const code =
          error !== null && typeof error === 'object' && 'code' in error
            ? toExitCode((error as { code?: number | string }).code)
            : 0;
        resolve({
          code: error === null ? 0 : code,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          timedOut: killed,
        });
      },
    );
  });

/**
 * `execFile`'s error `code` is the exit status for a process that ran, and a
 * string like `ENOENT` for one that never started. A missing ffmpeg is not exit
 * status zero, so it must not be reported as success.
 */
function toExitCode(code: number | string | undefined): number | null {
  if (typeof code === 'number') return code;
  return null;
}
