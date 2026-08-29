import { describe, expect, it } from 'vitest';

import {
  renditionLadderFor,
  renditionSpecFor,
  renditionStorageKeyFor,
  type RenditionSpec,
} from './ladder.js';

/**
 * The ladder is a table, so these are table facts. Two of them are load-bearing
 * beyond the table itself: the rung names must be the ones the client sends,
 * and no rung's arguments may be built from anything a request carries.
 */
const groupId = '018b2a02-0000-7000-8000-0000000000a1';
const contentHash = '4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a';

describe('rendition ladder', () => {
  /*
   * The four names `apps/hq/src/infrastructure/materials/materialLibrary.ts`
   * offers in `renditionsForMaterial` and `GetPreviewGrant.variant` carries. A
   * rung the client cannot ask for would be queued by the upload producer and
   * never requested; a name the client sends and the ladder does not hold would
   * make the menu permanently answer with the original.
   */
  it('declares exactly the variants the client asks for', () => {
    expect(renditionLadderFor('video/mp4').map(named)).toEqual(['1080p', '720p', '480p']);
    expect(renditionLadderFor('image/png').map(named)).toEqual(['thumbnail']);
  });

  it('matches on the type family, because a container is named a dozen ways', () => {
    expect(renditionLadderFor('video/quicktime').map(named)).toEqual(['1080p', '720p', '480p']);
    expect(renditionLadderFor('VIDEO/X-MATROSKA ').map(named)).toEqual(['1080p', '720p', '480p']);
    expect(renditionLadderFor('image/jpeg').map(named)).toEqual(['thumbnail']);
  });

  it('declares no ladder for a type ffmpeg has no picture to take', () => {
    expect(renditionLadderFor('application/pdf')).toEqual([]);
    expect(renditionLadderFor('application/octet-stream')).toEqual([]);
    expect(renditionLadderFor('')).toEqual([]);
  });

  it('resolves a rung only by exact variant name', () => {
    expect(renditionSpecFor('video/mp4', '720p')?.maxHeight).toBe(720);
    expect(renditionSpecFor('video/mp4', '720P')).toBeUndefined();
    expect(renditionSpecFor('video/mp4', 'thumbnail')).toBeUndefined();
    expect(renditionSpecFor('image/png', '720p')).toBeUndefined();
  });

  /*
   * The no-upscale rule. `min(target, ih)` is what keeps a 480-tall source
   * asked for 1080p from becoming a four-times-larger blur, and the `-2` width
   * is what keeps H.264's even-dimension requirement satisfied.
   */
  it('never upscales and always produces even dimensions', () => {
    for (const spec of renditionLadderFor('video/mp4')) {
      const filter = spec.ffmpegArguments[spec.ffmpegArguments.indexOf('-vf') + 1];
      expect(filter).toBe(`scale=-2:'min(${spec.maxHeight.toString()},ih)'`);
    }
  });

  /*
   * The argument list is a constant. If a rung's arguments ever came from a
   * request, this is the assertion that would fail: every element is a literal
   * flag or a literal value, and the paths are appended by the renderer.
   */
  it('carries only literal arguments, none of which is a path or a placeholder', () => {
    for (const spec of [...renditionLadderFor('video/mp4'), ...renditionLadderFor('image/png')]) {
      for (const argument of spec.ffmpegArguments) {
        expect(argument).not.toContain('{');
        expect(argument).not.toContain('%');
        expect(argument.startsWith('/')).toBe(false);
      }
    }
  });

  it('produces a type the client can tell apart from a stored original', () => {
    expect(renditionSpecFor('video/quicktime', '720p')?.mimeType).toBe('video/mp4');
    expect(renditionSpecFor('image/png', 'thumbnail')?.mimeType).toBe('image/jpeg');
  });

  /*
   * Keyed by the source content hash, so two materials that deduplicated onto
   * one object share one rendition rather than transcoding the same bytes
   * twice. The variant and extension come from the rung, never from a request.
   */
  it('addresses a rendition by group, source hash and rung', () => {
    const spec = renditionSpecFor('video/mp4', '480p');
    expect(spec).toBeDefined();
    expect(renditionStorageKeyFor(groupId, contentHash, spec as RenditionSpec)).toBe(
      `renditions/${groupId}/${contentHash}/480p.mp4`,
    );
  });
});

function named(spec: RenditionSpec): string {
  return spec.variant;
}
