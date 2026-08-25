// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fireKeybind } from '../components/keybinds/KeybindRuntime';
import { operationsStore } from '../state/operationsStore';
import { FilesScreen } from './FilesScreen';

// TileGrid calls useRouter(), which throws outside an App Router tree. The
// stub only has to satisfy the calls a render makes; this test never navigates.
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

// The dialog lists the local mirror the moment it opens. A real client would
// go to the loopback bridge, which is not running under test, so the outcome
// would be decided by how quickly the connection is refused.
vi.mock('@/infrastructure/materials/BridgeMaterialClient', () => ({
  BridgeMaterialClient: class {
    list(): Promise<{ readonly materials: readonly never[]; readonly nextCursor: string }> {
      return Promise.resolve({ materials: [], nextCursor: '' });
    }
  },
}));

function openImportDialog(): void {
  // The same command the shortcut and the shell menu raise; the dialog has no
  // other way in.
  act(() => {
    fireKeybind('files.import');
  });
}

function selectedCategory(): string {
  return screen.getByLabelText('Категория импортируемых материалов').textContent ?? '';
}

describe('the import dialog category', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('opens on the declared default when nothing has been chosen', () => {
    render(<FilesScreen archive={false} />);
    openImportDialog();

    expect(selectedCategory()).toContain('ПРОЧЕЕ');
  });

  it('opens on the category materials.defaultCategory names', () => {
    act(() => {
      operationsStore
        .getState()
        .applySettingsPatch([{ id: 'materials.defaultCategory', value: 'photo' }]);
    });
    render(<FilesScreen archive={false} />);
    openImportDialog();

    expect(selectedCategory()).toContain('ФОТО');
  });

  it('re-reads the setting on every open rather than only on mount', () => {
    render(<FilesScreen archive={false} />);
    openImportDialog();
    expect(selectedCategory()).toContain('ПРОЧЕЕ');

    act(() => {
      operationsStore
        .getState()
        .applySettingsPatch([{ id: 'materials.defaultCategory', value: 'intercept' }]);
    });
    fireEvent.click(screen.getByRole('button', { name: 'CLOSE' }));
    openImportDialog();

    expect(selectedCategory()).toContain('ПЕРЕХВАТ');
  });
});
