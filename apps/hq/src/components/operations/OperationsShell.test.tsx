// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MaterialLibraryClient } from '@/infrastructure/materials/materialLibrary';
import { operationsStore } from '@/state/operationsStore';

import { ImportedMaterialDrawer } from './OperationsShell';

/*
 * `useMaterialLibrary` builds a real gRPC-Web `BridgeMaterialClient` unless
 * mocked; this stub is what `readCount` actually counts against --
 * invocations of the reader `LocalMaterialPreview`'s source effect drives,
 * not an identity check on `material` itself (rule 2.3: a test that only
 * asserts a reference changed would pass on the pre-fix code too, since the
 * unstable identity is the very thing under test).
 *
 * Built once, at module scope, and handed back by every `useMaterialLibrary`
 * call: the real hook returns a stable client (`bridgeMaterialLibrary`, built
 * lazily and cached at module scope), so a mock that rebuilt a fresh object
 * per call would introduce its own re-render-triggering instability into
 * `LocalMaterialPreview`'s effect deps (`[client, limits, material, mode]`)
 * and mask the one this test exists to catch.
 */
const readCount = vi.hoisted(() => ({ current: 0 }));

const fakeMaterialClient = vi.hoisted(() => ({
  origin: 'local-mirror',
  withCategory() {
    return this;
  },
  importFile: () => Promise.reject(new Error('not used')),
  list: () => Promise.resolve({ materials: [], nextCursor: '' }),
  renditions: () => [],
  openRendition: () => Promise.reject(new Error('not used')),
  async *readChunks() {
    readCount.current += 1;
    yield { data: new Uint8Array([1, 2, 3]) };
  },
  getPlaybackGrant: () => Promise.reject(new Error('not used')),
  revokePlaybackGrant: () => Promise.resolve(true),
}));

vi.mock('@/application/materials/useMaterialLibrary', () => ({
  useMaterialLibrary: (): MaterialLibraryClient =>
    fakeMaterialClient as unknown as MaterialLibraryClient,
}));

const materialId = '018f0f1a-8000-7000-8000-0000000000aa';

async function flushPreviewLoad(): Promise<void> {
  // `LocalMaterialPreview`'s source-loading effect defers its first
  // `setState` behind a resolved promise and then awaits the bounded blob
  // read; a couple of microtask turns is what it takes to settle against the
  // stub's single-chunk generator.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  operationsStore.getState().resetWorld();
  readCount.current = 0;
  act(() => {
    operationsStore.getState().recordImportedMaterial({
      materialId,
      displayName: 'clip.png',
      mimeType: 'image/png',
      byteSize: '3',
      contentHash: 'a'.repeat(64),
      createdAt: '2026-08-29T00:00:00.000Z',
      category: 'other',
      origin: 'local-mirror',
      importedAt: '2026-08-29T00:00:00.000Z',
    });
  });
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => 'blob:material',
    revokeObjectURL: () => undefined,
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('ImportedMaterialDrawer', () => {
  it('reads the imported material once, not once per re-render', async () => {
    const { rerender } = render(
      <ImportedMaterialDrawer materialId={materialId} onClose={() => undefined} />,
    );
    await flushPreviewLoad();
    expect(readCount.current).toBe(1);

    /*
     * `OperationsDrawer`'s own `useOperationsStore((value) => value)`
     * subscription re-renders this component's parent on every store
     * mutation, not just ones naming this material -- reproduced here
     * directly by re-rendering `ImportedMaterialDrawer` itself several times
     * with the same props, standing in for the several re-renders a
     * `simulation.updateIntervalMs` tick (default 1000ms, `production.paused`
     * off) causes over the time an operator spends reading a file
     * (t5-player-rework regression). Without memoizing `material` against
     * the stored record, each of these rebuilds a new object and
     * `LocalMaterialPreview`'s source effect -- keyed on that identity --
     * reads again.
     */
    for (let i = 0; i < 5; i++) {
      act(() => {
        rerender(<ImportedMaterialDrawer materialId={materialId} onClose={() => undefined} />);
      });
    }
    await flushPreviewLoad();

    expect(readCount.current).toBe(1);
  });

  it('still reads again when the material itself actually changes', async () => {
    const { rerender } = render(
      <ImportedMaterialDrawer materialId={materialId} onClose={() => undefined} />,
    );
    await flushPreviewLoad();
    expect(readCount.current).toBe(1);

    // A genuine change -- not a re-render for its own sake -- must still
    // reach the reader; memoizing on the wrong key would silently freeze the
    // preview on the material's first revision forever.
    act(() => {
      operationsStore.getState().recordImportedMaterial({
        materialId,
        displayName: 'clip-renamed.png',
        mimeType: 'image/png',
        byteSize: '3',
        contentHash: 'b'.repeat(64),
        createdAt: '2026-08-29T00:00:00.000Z',
        category: 'other',
        origin: 'local-mirror',
        importedAt: '2026-08-29T00:00:01.000Z',
      });
    });
    rerender(<ImportedMaterialDrawer materialId={materialId} onClose={() => undefined} />);
    await flushPreviewLoad();

    expect(readCount.current).toBe(2);
  });
});
