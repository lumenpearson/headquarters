// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { appStore } from '@/state/appStore';
import { operationsStore } from '@/state/operationsStore';

import { VirtualExplorer } from './VirtualExplorer';

afterEach(() => {
  cleanup();
});

/** Mirrors `RuntimeController`'s own writes into `connections`. */
function patchConnections(patch: {
  readonly bridgeStatus?: 'online' | 'offline' | 'connecting' | 'incompatible';
  readonly lastFilesystemEvent?: string | null;
}): void {
  act(() => {
    const state = appStore.getState();
    state.replaceRuntimeState({
      ...state,
      connections: { ...state.connections, ...patch },
    });
  });
}

/*
 * `connections.bridgeStatus` and `connections.lastFilesystemEvent` used to be
 * initialized and never read by anything -- item m21. This proves the reader
 * half: the values `RuntimeController` writes over the watch path actually
 * reach the screen, in the "ИСТОЧНИКИ" panel beside the per-source statuses
 * that already lived there.
 */
describe('VirtualExplorer reads connections.bridgeStatus and connections.lastFilesystemEvent', () => {
  it('prints the file bridge status beside the other sources', () => {
    patchConnections({ bridgeStatus: 'online' });
    render(<VirtualExplorer />);

    // The status word is translated (`bridgeStatusMessageIds`), not the raw
    // enum value -- an operator on the Russian default reads "В СЕТИ", not
    // the identifier `RuntimeController` wrote.
    expect(screen.getByText('МОСТ ФАЙЛОВ').closest('.source-state')?.textContent).toContain(
      'В СЕТИ',
    );

    patchConnections({ bridgeStatus: 'offline' });
    expect(screen.getByText('МОСТ ФАЙЛОВ').closest('.source-state')?.textContent).toContain(
      'НЕ В СЕТИ',
    );
  });

  it('prints the last filesystem event, and a placeholder before one ever arrives', () => {
    patchConnections({ lastFilesystemEvent: null });
    render(<VirtualExplorer />);

    expect(screen.getByText('НЕТ СОБЫТИЙ')).toBeTruthy();

    patchConnections({ lastFilesystemEvent: 'FILE_CHANGED tauri /LOCAL-0/cases/K-01/report.txt' });

    expect(screen.getByText('FILE_CHANGED tauri /LOCAL-0/cases/K-01/report.txt')).toBeTruthy();
    expect(screen.queryByText('НЕТ СОБЫТИЙ')).toBeNull();
  });
});

describe('VirtualExplorer locale', () => {
  it('draws its chrome in the locale now in force', () => {
    patchConnections({ bridgeStatus: 'online' });
    const { rerender } = render(<VirtualExplorer />);

    expect(screen.getByText('БЫСТРЫЙ ДОСТУП')).toBeTruthy();
    expect(screen.getByText('ДЕЛА')).toBeTruthy();

    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: 'en' }]);
    });
    rerender(<VirtualExplorer />);

    expect(screen.getByText('QUICK ACCESS')).toBeTruthy();
    expect(screen.getByText('CASES')).toBeTruthy();
    expect(screen.queryByText('БЫСТРЫЙ ДОСТУП')).toBeNull();

    operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: 'ru' }]);
  });
});
