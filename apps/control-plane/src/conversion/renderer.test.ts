import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renditionSpecFor, type RenditionSpec } from './ladder.js';
import {
  RenditionRenderError,
  createFfmpegRenditionRenderer,
  parseDimensions,
  type ProcessResult,
  type RunProcess,
} from './renderer.js';

/**
 * How the renderer invokes another program, proved without invoking one.
 *
 * The process seam is injected, so these are assertions about the argument
 * vector and about what each kind of failure becomes. That a real ffmpeg
 * accepts this vector and produces a smaller picture is a different claim and
 * is proved in `conversion.live.integration.test.ts` against the real binary.
 */
const spec = renditionSpecFor('video/mp4', '720p') as RenditionSpec;

describe('ffmpeg rendition renderer', () => {
  let directory = '';
  let outputPath = '';

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hq-renderer-test-'));
    outputPath = join(directory, 'rendition.mp4');
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('passes the source, the rung and the output as arguments, never as a command line', async () => {
    await writeFile(outputPath, 'x'.repeat(4096));
    const calls: { command: string; args: readonly string[] }[] = [];
    const renderer = createFfmpegRenditionRenderer({
      ffmpegPath: '/opt/ffmpeg',
      ffprobePath: '/opt/ffprobe',
      run: scriptedRun(calls, [ok(''), ok('1280x720\n')]),
    });

    const result = await renderer.render({ sourcePath: '/src/take.mov', outputPath, spec });

    expect(result).toEqual({ width: 1280, height: 720, byteSize: 4096n });
    const rendered = calls[0];
    expect(rendered?.command).toBe('/opt/ffmpeg');
    // `-nostdin` matters: a worker has no terminal, and without it a malformed
    // input can leave ffmpeg waiting on a keypress that never comes.
    expect(rendered?.args.slice(0, 6)).toEqual([
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
    ]);
    expect(rendered?.args[6]).toBe('/src/take.mov');
    expect(rendered?.args.at(-1)).toBe(outputPath);
    // The rung's own arguments sit between the input and the output, unaltered.
    expect(rendered?.args.slice(7, -1)).toEqual([...spec.ffmpegArguments]);
    expect(calls[1]?.command).toBe('/opt/ffprobe');
  });

  /*
   * The dimensions are measured, not declared. A 480-tall source asked for
   * `720p` produces a 480-tall object because the ladder never upscales, and a
   * grant reporting 720 would be a lie the client prints in the menu.
   */
  it('reports the dimensions ffprobe measured, not the ones the rung asked for', async () => {
    await writeFile(outputPath, 'x'.repeat(2048));
    const renderer = createFfmpegRenditionRenderer({
      run: scriptedRun([], [ok(''), ok('854x480')]),
    });

    await expect(
      renderer.render({ sourcePath: '/src/small.mov', outputPath, spec }),
    ).resolves.toEqual({ width: 854, height: 480, byteSize: 2048n });
  });

  it('names the ffmpeg stderr tail when the render fails', async () => {
    const renderer = createFfmpegRenditionRenderer({
      run: scriptedRun(
        [],
        [{ code: 1, stdout: '', stderr: 'Invalid data found', timedOut: false }],
      ),
    });

    await expect(
      renderer.render({ sourcePath: '/src/broken.mov', outputPath, spec }),
    ).rejects.toMatchObject({
      detail: 'ffmpeg exited with 1: Invalid data found',
    });
  });

  it('names the budget when a render is stopped for exceeding it', async () => {
    const renderer = createFfmpegRenditionRenderer({
      timeoutMs: 1_500,
      run: scriptedRun([], [{ code: null, stdout: '', stderr: '', timedOut: true }]),
    });

    await expect(
      renderer.render({ sourcePath: '/src/hangs.mov', outputPath, spec }),
    ).rejects.toMatchObject({ detail: 'ffmpeg exceeded its 1500ms budget and was stopped' });
  });

  /*
   * An input with no video stream and a video-only filter graph makes ffmpeg
   * exit zero having written nothing. An empty rendition must not become a
   * variant the menu offers and the bucket answers 404 for.
   */
  it('refuses an empty file even when ffmpeg reported success', async () => {
    await writeFile(outputPath, '');
    const renderer = createFfmpegRenditionRenderer({ run: scriptedRun([], [ok('')]) });

    await expect(
      renderer.render({ sourcePath: '/src/audio-only.mov', outputPath, spec }),
    ).rejects.toMatchObject({ detail: 'ffmpeg produced an empty file' });
  });

  it('refuses a rendition ffprobe cannot measure', async () => {
    await writeFile(outputPath, 'x'.repeat(64));
    const renderer = createFfmpegRenditionRenderer({
      run: scriptedRun([], [ok(''), ok('N/A\n')]),
    });

    await expect(
      renderer.render({ sourcePath: '/src/take.mov', outputPath, spec }),
    ).rejects.toBeInstanceOf(RenditionRenderError);
  });

  /*
   * `execFile` reports a process that never started with a string code such as
   * `ENOENT`. Reading that as exit status zero would report a missing ffmpeg as
   * a successful render of nothing.
   */
  it('treats a program that never started as a failure, not as success', async () => {
    const renderer = createFfmpegRenditionRenderer({
      ffmpegPath: '/nonexistent/ffmpeg',
      timeoutMs: 5_000,
    });

    await expect(
      renderer.render({ sourcePath: '/src/take.mov', outputPath, spec }),
    ).rejects.toBeInstanceOf(RenditionRenderError);
  });
});

describe('ffprobe dimension parsing', () => {
  it('takes the first video stream and ignores a trailing blank line', () => {
    expect(parseDimensions('1920x1080\n')).toEqual({ width: 1920, height: 1080 });
    expect(parseDimensions('1280x720\n640x360\n')).toEqual({ width: 1280, height: 720 });
  });

  it('answers with nothing when there is no picture size to read', () => {
    expect(parseDimensions('')).toBeUndefined();
    expect(parseDimensions('N/AxN/A')).toBeUndefined();
    expect(parseDimensions('0x0')).toBeUndefined();
  });
});

function ok(stdout: string): ProcessResult {
  return { code: 0, stdout, stderr: '', timedOut: false };
}

function scriptedRun(
  calls: { command: string; args: readonly string[] }[],
  results: readonly ProcessResult[],
): RunProcess {
  const remaining = [...results];
  return (command, args) => {
    calls.push({ command, args: [...args] });
    return Promise.resolve(remaining.shift() ?? ok(''));
  };
}
