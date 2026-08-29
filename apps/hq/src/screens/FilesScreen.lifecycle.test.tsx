// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GroupChannel } from '@/application/sync/groupChannel';
import { setGroupRuntime } from '@/components/sync/groupRuntimeHolder';
import type {
  MaterialLibraryClient,
  MaterialLibraryEvent,
  MaterialLifecycleClient,
} from '@/infrastructure/materials/materialLibrary';

import { fireKeybind } from '../components/keybinds/KeybindRuntime';
import { operationsStore } from '../state/operationsStore';
import { FilesScreen } from './FilesScreen';

/*
 * The lifecycle surfaces (R1, R2: rename, new version, trash/restore/purge,
 * the library event feed) only ever render behind a group library --
 * `isMaterialLifecycleClient` is origin-gated -- so every test here joins a
 * group with a fake `MaterialLifecycleClient` rather than exercising the
 * loopback bridge, which `FilesScreen.import.test.tsx` already covers.
 */

const materialId = '018f0f1a-8000-7000-8000-0000000000f0';

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

vi.mock('@/infrastructure/materials/BridgeMaterialClient', () => {
  class FakeBridgeMaterialClient {
    readonly origin = 'local-mirror';
    withCategory(): FakeBridgeMaterialClient {
      return this;
    }
    list(): Promise<{ readonly materials: readonly never[]; readonly nextCursor: string }> {
      return Promise.resolve({ materials: [], nextCursor: '' });
    }
  }
  return { BridgeMaterialClient: FakeBridgeMaterialClient };
});

// Playback is `LocalMaterialPreview`'s own concern; this file tests the
// lifecycle wiring around it, not the player.
vi.mock('@/components/operations/LocalMaterialPreview', () => ({
  LocalMaterialPreview: () => null,
}));

/*
 * The preview tile that hosts `MaterialLifecyclePanel` renders nothing until
 * `TileGrid` has measured a box; the shared stub in `vitest.setup.ts` observes
 * nothing on purpose. Reporting both boxes here, the same way
 * `SearchScreen.pagination.test.tsx` does, is what puts the tile's content in
 * the DOM under jsdom at all.
 */
globalThis.ResizeObserver = class {
  constructor(private readonly report: (entries: readonly ResizeObserverEntry[]) => void) {}
  observe(target: Element): void {
    const floor = target.classList.contains('tile-grid__floor');
    target.getBoundingClientRect = () =>
      ({ height: floor ? 68 : 2000, width: floor ? 0 : 1600 }) as DOMRect;
    this.report([{ target, contentRect: { height: 2000, width: 1600 } } as ResizeObserverEntry]);
  }
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

function fakeLifecycleClient(
  overrides: Partial<MaterialLifecycleClient> = {},
): MaterialLibraryClient & MaterialLifecycleClient {
  const base: MaterialLibraryClient & MaterialLifecycleClient = {
    origin: 'group-library',
    withCategory() {
      return base;
    },
    importFile: () => Promise.reject(new Error('importFile not used by this test')),
    list: () => Promise.resolve({ materials: [], nextCursor: '' }),
    renditions: () => [],
    openRendition: () => Promise.reject(new Error('openRendition not used by this test')),
    getPlaybackGrant: () => Promise.reject(new Error('getPlaybackGrant not used by this test')),
    revokePlaybackGrant: () => Promise.resolve(false),
    readChunks: () => (async function* () {})(),
    createVersion: () => Promise.reject(new Error('createVersion not configured')),
    updateMetadata: () => Promise.reject(new Error('updateMetadata not configured')),
    moveToTrash: () => Promise.reject(new Error('moveToTrash not configured')),
    restoreMaterial: () => Promise.reject(new Error('restoreMaterial not configured')),
    purgeMaterial: () => Promise.reject(new Error('purgeMaterial not configured')),
    listVersions: () => Promise.resolve({ versions: [], nextCursor: '' }),
    listTrash: () => Promise.resolve({ materials: [], nextCursor: '' }),
    watchEvents: () => (async function* () {})(),
    ...overrides,
  };
  return base;
}

function joinGroup(client: MaterialLibraryClient & MaterialLifecycleClient): void {
  setGroupRuntime({
    groupId: 'group',
    deviceId: 'device',
    channel: {} as unknown as GroupChannel,
    delivery: 'socket',
    settings: null,
    materials: client,
  });
  operationsStore.getState().patchConnection({
    mode: 'online',
    capabilities: {
      installationId: 'test-installation',
      sync: true,
      deviceLifecycle: true,
      realtimeAdmission: false,
      settings: false,
      materials: true,
    },
  });
}

function seedImportedGroupMaterial(): void {
  operationsStore.setState({
    materials: {
      imported: {
        [materialId]: {
          materialId,
          displayName: 'clip.mp4',
          mimeType: 'video/mp4',
          byteSize: '1024',
          contentHash: 'a'.repeat(64),
          createdAt: '2026-08-20T00:00:00.000Z',
          category: 'video',
          origin: 'group-library',
          importedAt: '2026-08-20T00:00:00.000Z',
        },
      },
    },
  });
  operationsStore.getState().selectFile(materialId);
}

function openImportDialog(): void {
  act(() => {
    fireKeybind('files.import');
  });
}

describe('the material lifecycle panel on a selected group-library material', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    operationsStore.setState({ materials: { imported: {} } });
    setGroupRuntime(null);
    operationsStore.getState().patchConnection({ mode: 'local-only', capabilities: undefined });
  });

  it('renames a material and writes the update back to the store', async () => {
    const updateMetadata = vi.fn().mockResolvedValue({
      materialId,
      displayName: 'renamed.mp4',
      mimeType: 'video/mp4',
      byteSize: 1024n,
      contentHash: 'a'.repeat(64),
      createdAt: '2026-08-20T00:00:00.000Z',
    });
    joinGroup(fakeLifecycleClient({ updateMetadata }));
    seedImportedGroupMaterial();

    render(<FilesScreen archive={false} />);

    const nameField = screen.getByLabelText('Название материала');
    fireEvent.change(nameField, { target: { value: 'renamed.mp4' } });
    fireEvent.click(screen.getByRole('button', { name: '[S] СОХРАНИТЬ' }));

    await waitFor(() =>
      expect(operationsStore.getState().materials.imported[materialId]?.displayName).toBe(
        'renamed.mp4',
      ),
    );
    expect(updateMetadata).toHaveBeenCalledWith(materialId, {
      displayName: 'renamed.mp4',
      category: 'video',
      metadata: {},
      tags: [],
    });
  });

  it('moves the material to trash on confirmation and clears the selection', async () => {
    const moveToTrash = vi.fn().mockResolvedValue({
      materialId,
      displayName: 'clip.mp4',
      mimeType: 'video/mp4',
      byteSize: 1024n,
      contentHash: 'a'.repeat(64),
      createdAt: '2026-08-20T00:00:00.000Z',
    });
    joinGroup(fakeLifecycleClient({ moveToTrash }));
    seedImportedGroupMaterial();

    render(<FilesScreen archive={false} />);

    fireEvent.click(screen.getByRole('button', { name: '[T] В КОРЗИНУ' }));
    const alert = screen.getByRole('alertdialog');
    const confirm = within(alert).getAllByRole('button')[1];
    if (confirm === undefined) throw new Error('confirm button not rendered');
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(operationsStore.getState().materials.imported[materialId]).toBeUndefined(),
    );
    expect(moveToTrash).toHaveBeenCalledWith(materialId);
    expect(operationsStore.getState().ui.selectedFileId).not.toBe(materialId);
  });
});

describe('the group trash inside the import dialog', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    operationsStore.setState({ materials: { imported: {} } });
    setGroupRuntime(null);
    operationsStore.getState().patchConnection({ mode: 'local-only', capabilities: undefined });
  });

  it('lists trashed materials and restores one back into the recent list', async () => {
    const trashedEntry = {
      materialId,
      displayName: 'trashed.mp4',
      mimeType: 'video/mp4',
      byteSize: 2048n,
      contentHash: 'b'.repeat(64),
      createdAt: '2026-08-19T00:00:00.000Z',
    };
    const restoreMaterial = vi.fn().mockResolvedValue(trashedEntry);
    const listTrash = vi.fn().mockResolvedValue({ materials: [trashedEntry], nextCursor: '' });
    joinGroup(fakeLifecycleClient({ listTrash, restoreMaterial }));

    render(<FilesScreen archive={false} />);
    openImportDialog();
    fireEvent.click(screen.getByRole('button', { name: 'КОРЗИНА' }));

    await waitFor(() => expect(screen.getByText('trashed.mp4')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: '[R] ВОССТАНОВИТЬ' }));

    await waitFor(() => expect(restoreMaterial).toHaveBeenCalledWith(materialId));
    await waitFor(() => expect(screen.queryByText('trashed.mp4')).toBeNull());
  });

  it('purges a trashed material with its own id as confirmation', async () => {
    const trashedEntry = {
      materialId,
      displayName: 'gone.mp4',
      mimeType: 'video/mp4',
      byteSize: 512n,
      contentHash: 'c'.repeat(64),
      createdAt: '2026-08-19T00:00:00.000Z',
    };
    const purgeMaterial = vi.fn().mockResolvedValue(undefined);
    const listTrash = vi.fn().mockResolvedValue({ materials: [trashedEntry], nextCursor: '' });
    joinGroup(fakeLifecycleClient({ listTrash, purgeMaterial }));

    render(<FilesScreen archive={false} />);
    openImportDialog();
    fireEvent.click(screen.getByRole('button', { name: 'КОРЗИНА' }));

    await waitFor(() => expect(screen.getByText('gone.mp4')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: '[P] УДАЛИТЬ НАВСЕГДА' }));
    const alert = screen.getByRole('alertdialog');
    const confirm = within(alert).getAllByRole('button')[1];
    if (confirm === undefined) throw new Error('confirm button not rendered');
    fireEvent.click(confirm);

    await waitFor(() => expect(purgeMaterial).toHaveBeenCalledWith(materialId, materialId));
  });
});

describe('the library event feed inside the import dialog', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    operationsStore.setState({ materials: { imported: {} } });
    setGroupRuntime(null);
    operationsStore.getState().patchConnection({ mode: 'local-only', capabilities: undefined });
  });

  it('shows a count once the group library reports an event', async () => {
    const event: MaterialLibraryEvent = {
      sequence: 1,
      kind: 'created',
      materialId: 'some-other-device-material',
      occurredAt: '',
      correlationId: '',
    };
    joinGroup(
      fakeLifecycleClient({
        watchEvents: () =>
          (async function* () {
            yield event;
          })(),
      }),
    );

    render(<FilesScreen archive={false} />);
    openImportDialog();

    await waitFor(() =>
      expect(screen.getByText('СОБЫТИЯ БИБЛИОТЕКИ: 1 / ПОСЛЕДНЕЕ CREATED')).toBeDefined(),
    );
  });
});
