// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { operationsStore } from '@/state/operationsStore';
import type { MaterialEntry } from '@/infrastructure/materials/BridgeMaterialClient';
import type { MaterialLifecycleClient } from '@/infrastructure/materials/materialLibrary';

import { MaterialLifecyclePanel } from './MaterialLifecyclePanel';

const material: MaterialEntry = {
  materialId: '018f0f1a-8000-7000-8000-000000000000',
  displayName: 'clip.mp4',
  mimeType: 'video/mp4',
  byteSize: 1024n,
  contentHash: 'a'.repeat(64),
  createdAt: '2026-08-25T00:00:00.000Z',
};

function fakeLifecycle(): MaterialLifecycleClient {
  return {
    listVersions: () => Promise.resolve({ versions: [], nextCursor: '' }),
    createVersion: () => Promise.reject(new Error('not used')),
    updateMetadata: () => Promise.reject(new Error('not used')),
    moveToTrash: () => Promise.reject(new Error('not used')),
    restoreMaterial: () => Promise.reject(new Error('not used')),
    purgeMaterial: () => Promise.reject(new Error('not used')),
    listTrash: () => Promise.resolve({ materials: [], nextCursor: '' }),
    watchEvents: () => (async function* () {})(),
  } as unknown as MaterialLifecycleClient;
}

describe('MaterialLifecyclePanel locale', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('draws its labels in the locale now in force', () => {
    const { rerender } = render(
      <MaterialLifecyclePanel
        lifecycle={fakeLifecycle()}
        material={material}
        category="video"
        onUpdated={() => undefined}
        onTrashed={() => undefined}
      />,
    );

    expect(screen.getByText('НАЗВАНИЕ')).toBeTruthy();
    expect(screen.getByText('КАТЕГОРИЯ')).toBeTruthy();
    expect(screen.getByRole('button', { name: '[S] СОХРАНИТЬ' })).toBeTruthy();

    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: 'en' }]);
    });
    rerender(
      <MaterialLifecyclePanel
        lifecycle={fakeLifecycle()}
        material={material}
        category="video"
        onUpdated={() => undefined}
        onTrashed={() => undefined}
      />,
    );

    expect(screen.getByText('NAME')).toBeTruthy();
    expect(screen.getByText('CATEGORY')).toBeTruthy();
    expect(screen.getByRole('button', { name: '[S] SAVE' })).toBeTruthy();
    expect(screen.queryByText('НАЗВАНИЕ')).toBeNull();
  });
});
