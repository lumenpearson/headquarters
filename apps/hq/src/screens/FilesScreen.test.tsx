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

/**
 * The chord the dialog advertises, against the collection actually in force.
 *
 * It was written out as `[CTRL+SHIFT+ALT+S]`, which is true of exactly one of
 * the three collections `keybinds.scheme` offers. Under `vim-inspired` the
 * gesture is Shift+R and under `accessibility` it is Ctrl+S, so the dialog
 * named a combination that would not have opened it -- the same defect
 * `activeScheme.ts` names as its reason for existing and `entryShortcut` fixed
 * for the context menus.
 */
describe('the chord the import dialog prints', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  function eyebrow(): string {
    return screen.getByText(/GRPC-WEB/).textContent ?? '';
  }

  it('prints the default collection’s chord when that is what is chosen', () => {
    render(<FilesScreen archive={false} />);
    openImportDialog();

    expect(eyebrow()).toContain('[CTRL + SHIFT + ALT + S]');
  });

  it.each([
    ['vim-inspired', '[SHIFT + R]'],
    ['accessibility', '[CTRL + S]'],
  ])('follows %s to the chord that actually opens it', (scheme, printed) => {
    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'keybinds.scheme', value: scheme }]);
    });
    render(<FilesScreen archive={false} />);
    openImportDialog();

    expect(eyebrow()).toContain(printed);
    // Not merely "some chord": the collection that is no longer in force must
    // be gone from the line, or a stale literal beside a live one would pass.
    expect(eyebrow()).not.toContain('ALT');
  });
});
