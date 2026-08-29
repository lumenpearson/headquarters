// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import type {
  MaterialEntry,
  MaterialReadChunk,
} from '@/infrastructure/materials/BridgeMaterialClient';
import type { MaterialLibraryClient } from '@/infrastructure/materials/materialLibrary';

import {
  findMaterialSubtitleTracks,
  releaseMaterialSubtitleTracks,
} from './materialSubtitleTracks';

const limits = { textBytes: 10_000, binaryBytes: 10_000 };

function material(overrides: Partial<MaterialEntry>): MaterialEntry {
  return {
    materialId: 'video',
    displayName: 'clip.mp4',
    mimeType: 'video/mp4',
    byteSize: 8n,
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

function fakeLibrary(
  materials: readonly MaterialEntry[],
  content: Readonly<Record<string, string>>,
): MaterialLibraryClient {
  return {
    origin: 'local-mirror',
    withCategory() {
      return this as unknown as MaterialLibraryClient;
    },
    importFile: () => Promise.reject(new Error('not used')),
    list: () => Promise.resolve({ materials, nextCursor: '' }),
    renditions: () => [],
    openRendition: () => Promise.reject(new Error('not used')),
    async *readChunks(materialId: string): AsyncGenerator<MaterialReadChunk> {
      const text = content[materialId];
      if (text === undefined) throw new Error(`no content fixture for ${materialId}`);
      yield { data: new TextEncoder().encode(text) };
    },
    getPlaybackGrant: () => Promise.reject(new Error('not used')),
    revokePlaybackGrant: () => Promise.resolve(false),
  } as unknown as MaterialLibraryClient;
}

const video = material({ materialId: 'video', displayName: 'clip.mp4' });

describe('findMaterialSubtitleTracks', () => {
  it("finds a language-tagged companion by the video's own stem", async () => {
    const english = material({
      materialId: 'sub-en',
      displayName: 'clip.en.vtt',
      mimeType: 'text/vtt',
      byteSize: 43n,
    });
    const unrelated = material({
      materialId: 'other',
      displayName: 'other.vtt',
      mimeType: 'text/vtt',
      byteSize: 6n,
    });
    const client = fakeLibrary([video, english, unrelated], {
      'sub-en': 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello',
      other: 'WEBVTT',
    });

    const tracks = await findMaterialSubtitleTracks(client, video, undefined, limits);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.id).toBe('sub-en');
    expect(tracks[0]?.srcLang).toBe('en');
    expect(tracks[0]?.label).toBe('EN');
    expect(tracks[0]?.default).toBe(true);
    expect(tracks[0]?.url.startsWith('blob:')).toBe(true);

    releaseMaterialSubtitleTracks(tracks);
  });

  it('finds an unlabelled companion (no language tag) by exact stem match', async () => {
    const plain = material({
      materialId: 'sub-plain',
      displayName: 'clip.vtt',
      mimeType: 'text/vtt',
      byteSize: 6n,
    });
    const client = fakeLibrary([video, plain], { 'sub-plain': 'WEBVTT' });

    const tracks = await findMaterialSubtitleTracks(client, video, undefined, limits);

    expect(tracks.map((track) => track.id)).toEqual(['sub-plain']);
    expect(tracks[0]?.label).toBe('SUBTITLES');
    releaseMaterialSubtitleTracks(tracks);
  });

  it('returns nothing for a non-video material', async () => {
    const image = material({
      materialId: 'image',
      displayName: 'still.png',
      mimeType: 'image/png',
    });
    const client = fakeLibrary([image], {});

    expect(await findMaterialSubtitleTracks(client, image, undefined, limits)).toEqual([]);
  });

  it('skips a companion above the text preview limit rather than streaming it unbounded', async () => {
    const huge = material({
      materialId: 'sub-huge',
      displayName: 'clip.vtt',
      mimeType: 'text/vtt',
      byteSize: 1_000_000n,
    });
    const client = fakeLibrary([video, huge], { 'sub-huge': 'WEBVTT' });

    expect(await findMaterialSubtitleTracks(client, video, undefined, limits)).toEqual([]);
  });

  it('does not fail the whole lookup when the library listing rejects', async () => {
    const client: MaterialLibraryClient = {
      origin: 'local-mirror',
      withCategory() {
        return this;
      },
      importFile: () => Promise.reject(new Error('not used')),
      list: () => Promise.reject(new Error('offline')),
      renditions: () => [],
      openRendition: () => Promise.reject(new Error('not used')),
      async *readChunks() {
        throw new Error('not used');
      },
      getPlaybackGrant: () => Promise.reject(new Error('not used')),
      revokePlaybackGrant: () => Promise.resolve(false),
    };

    expect(await findMaterialSubtitleTracks(client, video, undefined, limits)).toEqual([]);
  });
});
