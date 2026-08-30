// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  MaterialEntry,
  MaterialReadChunk,
} from '@/infrastructure/materials/BridgeMaterialClient';
import type { MaterialLibraryClient } from '@/infrastructure/materials/materialLibrary';
import { operationsStore } from '@/state/operationsStore';

import { LocalMaterialPreview } from './LocalMaterialPreview';

/*
 * The real `LocalMaterialPlayer` mounts a Vidstack `<MediaPlayer>` against a
 * real media element, which jsdom does not implement (`LocalMaterialPlayer.test.tsx`
 * carries the same reasoning for the layer below this one). This stub renders
 * nothing of Vidstack's own; it exposes exactly the contract
 * `LocalMaterialPreview` drives it through -- `initialTime` at construction,
 * and the `onTimeUpdate`/`onEnd` callbacks this file is testing -- so what a
 * material reopens at is read the same way `LocalMaterialPreview` itself
 * would hand it to a real player, not a field a test reached in and set.
 */
const latestPlayerProps = vi.hoisted(() => ({
  current: undefined as
    | {
        readonly sourceUrl: string;
        readonly initialTime: number;
        readonly onTimeUpdate: ((seconds: number) => void) | undefined;
        readonly onEnd: (() => void) | undefined;
      }
    | undefined,
}));

vi.mock('./LocalMaterialPlayer', () => ({
  LocalMaterialPlayer: (props: {
    readonly sourceUrl: string;
    readonly initialTime?: number;
    readonly onTimeUpdate?: (seconds: number) => void;
    readonly onEnd?: () => void;
    readonly quality?: ReactNode;
  }) => {
    latestPlayerProps.current = {
      sourceUrl: props.sourceUrl,
      initialTime: props.initialTime ?? 0,
      onTimeUpdate: props.onTimeUpdate,
      onEnd: props.onEnd,
    };
    return null;
  },
}));

function material(overrides: Partial<MaterialEntry> = {}): MaterialEntry {
  return {
    materialId: 'clip-01',
    displayName: 'clip.webm',
    mimeType: 'video/webm',
    byteSize: 3n,
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

/** Same shape `materialSubtitleTracks.test.ts` already builds, minus what this file never calls. */
function fakeClient(): MaterialLibraryClient {
  return {
    origin: 'local-mirror',
    withCategory() {
      return this as unknown as MaterialLibraryClient;
    },
    importFile: () => Promise.reject(new Error('not used')),
    list: () => Promise.resolve({ materials: [], nextCursor: '' }),
    renditions: () => [],
    openRendition: () => Promise.reject(new Error('not used')),
    async *readChunks(): AsyncGenerator<MaterialReadChunk> {
      yield { data: new Uint8Array([1, 2, 3]) };
    },
    getPlaybackGrant: () => Promise.reject(new Error('not used')),
    revokePlaybackGrant: () => Promise.resolve(true),
  } as unknown as MaterialLibraryClient;
}

const createdUrls: string[] = [];

async function flushPreviewLoad(): Promise<void> {
  // The source-loading effect defers its first `setState` behind a resolved
  // promise and then awaits an async blob read (`materialSubtitleTracks.ts`
  // and `MaterialPreviewReader.ts` follow the same idiom); two microtask
  // turns is what it takes for both effects in `LocalMaterialPreview` to
  // settle against the fake client's single-chunk generator.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  operationsStore.getState().resetWorld();
  act(() => {
    operationsStore
      .getState()
      .applySettingsPatch([{ id: 'materials.rememberPreviewPosition', value: true }]);
  });
  createdUrls.length = 0;
  latestPlayerProps.current = undefined;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      const url = `blob:object-${createdUrls.length.toString()}-${blob.size.toString()}`;
      createdUrls.push(url);
      return url;
    },
    revokeObjectURL: () => undefined,
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('materials.rememberPreviewPosition', () => {
  it('resumes a reselected material at the position it left off mid-clip', async () => {
    const client = fakeClient();
    const clip = material({ materialId: 'clip-mid' });

    const { unmount } = render(<LocalMaterialPreview material={clip} client={client} />);
    await flushPreviewLoad();
    expect(latestPlayerProps.current?.initialTime).toBe(0);

    act(() => {
      latestPlayerProps.current?.onTimeUpdate?.(12.5);
    });
    unmount();

    render(<LocalMaterialPreview material={clip} client={client} />);
    await flushPreviewLoad();

    expect(latestPlayerProps.current?.initialTime).toBe(12.5);
  });

  /*
   * A clip watched to its end reopens at the start, not on its frozen last
   * frame: the last `onTimeUpdate` tick before completion is still within a
   * fraction of a second of `duration`, and `onEnd` is what clears that
   * near-end reading back out of the cache rather than leaving it as "the"
   * remembered position.
   */
  it('does not remember the end of a clip, so a reselect reopens it at the start', async () => {
    const client = fakeClient();
    const clip = material({ materialId: 'clip-end' });

    const { unmount } = render(<LocalMaterialPreview material={clip} client={client} />);
    await flushPreviewLoad();

    act(() => {
      latestPlayerProps.current?.onTimeUpdate?.(29.98);
      latestPlayerProps.current?.onEnd?.();
    });
    unmount();

    render(<LocalMaterialPreview material={clip} client={client} />);
    await flushPreviewLoad();

    expect(latestPlayerProps.current?.initialTime).toBe(0);
  });
});
