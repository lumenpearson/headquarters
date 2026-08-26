// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fireKeybind } from '../components/keybinds/KeybindRuntime';
import { operationsStore } from '../state/operationsStore';
import { FilesScreen } from './FilesScreen';

/*
 * R1/R2: an import used to reach the registry only while the hidden dialog was
 * open, and only for as long as that screen was mounted. These tests hold the
 * screen to the record it now writes: one entry in `materials.imported`, with
 * the category the operator chose and the library that took the bytes, visible
 * to the table whether or not the dialog is open.
 */
const imported = vi.hoisted(() => ({
  categories: [] as string[],
  material: {
    materialId: '018f0f1a-8000-7000-8000-000000000000',
    displayName: 'perehvat.mp4',
    mimeType: 'video/mp4',
    byteSize: 2_097_152n,
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-25T00:00:00.000Z',
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

// The loopback bridge is not running under test, so a real client would let the
// outcome be decided by how quickly the connection is refused.
vi.mock('@/infrastructure/materials/BridgeMaterialClient', () => {
  class FakeBridgeMaterialClient {
    readonly origin = 'local-mirror';
    // Not the default the dialog opens on, so an import that never declares a
    // category is visible as one rather than passing for the default.
    #category = 'undeclared';
    withCategory(category: string): FakeBridgeMaterialClient {
      this.#category = category;
      return this;
    }
    list(): Promise<{ readonly materials: readonly never[]; readonly nextCursor: string }> {
      return Promise.resolve({ materials: [], nextCursor: '' });
    }
    importFile(): Promise<{
      readonly material: typeof imported.material;
      readonly deduplicated: boolean;
    }> {
      imported.categories.push(this.#category);
      return Promise.resolve({ material: imported.material, deduplicated: false });
    }
  }
  return { BridgeMaterialClient: FakeBridgeMaterialClient };
});

function openImportDialog(): void {
  act(() => {
    fireKeybind('files.import');
  });
}

async function importOneFile(): Promise<void> {
  const input = screen.getByLabelText('Выбрать материалы для локального импорта');
  await act(async () => {
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'perehvat.mp4', { type: 'video/mp4' })] },
    });
  });
}

describe('what an import leaves behind', () => {
  beforeEach(() => {
    imported.categories.length = 0;
    operationsStore.getState().resetWorld();
    operationsStore.setState({ materials: { imported: {} } });
  });

  it('writes one record naming the category and the library that took the bytes', async () => {
    render(<FilesScreen archive={false} />);
    openImportDialog();
    await importOneFile();

    await waitFor(() =>
      expect(
        operationsStore.getState().materials.imported[imported.material.materialId],
      ).toBeDefined(),
    );
    const record = operationsStore.getState().materials.imported[imported.material.materialId];
    expect(record?.displayName).toBe('perehvat.mp4');
    expect(record?.origin).toBe('local-mirror');
    expect(record?.category).toBe('other');
    // A decimal string and not a bigint: the slice is persisted through
    // `JSON.stringify`, which throws on a bigint rather than dropping it.
    expect(record?.byteSize).toBe('2097152');
    // The declared category reaches the library too, for the one that can
    // carry it on the wire.
    expect(imported.categories).toEqual(['other']);
  });

  it('counts the import in the registry of a screen that never opened the dialog', async () => {
    /*
     * The registry's own total, not a table row. `TileGrid` packs against
     * measured boxes and jsdom computes none, so no tile is placed and the
     * table never enters the DOM under test; the header the screen prints
     * beside it is the same `filePage.total` the table pages through, and it
     * moves for the same reason.
     */
    const { unmount } = render(<FilesScreen archive={false} />);
    expect(registryTotal()).toBe(24);
    openImportDialog();
    await importOneFile();
    await waitFor(() => expect(registryTotal()).toBe(25));
    unmount();

    // A second screen, which never opened the importer: it used to show 24,
    // because the listing lived in the dialog's own React state.
    render(<FilesScreen archive={false} />);

    expect(registryTotal()).toBe(25);
  });
});

function registryTotal(): number {
  const label = screen.getByText('FILES');
  return Number(label.parentElement?.textContent?.replace('FILES', '') ?? '');
}
