// @vitest-environment jsdom
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolvePresentation } from '@/application/personalization/presentation';
import { operationsStore } from '@/state/operationsStore';

import { TitleBar } from './TitleBar';

interface RecordedCall {
  readonly command: string;
  readonly args: unknown;
}

/** The payloads `classify` produces in `host_profile.rs`, family for family. */
const profiles = {
  win11: { family: 'win11', buildNumber: 22631, rounded: true },
  win10: { family: 'win10', buildNumber: 19045, rounded: false },
  legacy: { family: 'legacy', buildNumber: 9600, rounded: false },
} as const;

function mockNativeShell(profile: unknown, extra: (command: string) => unknown = () => null) {
  const calls: RecordedCall[] = [];
  Object.assign(globalThis, { isTauri: true });
  mockWindows('control');
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === 'host_window_profile') return profile;
    return extra(command);
  });
  return calls;
}

/** Renders and lets the mount effects settle: both read over the IPC bridge. */
async function mountTitleBar(): Promise<void> {
  render(<TitleBar route="objects" />);
  await act(async () => {
    await Promise.resolve();
  });
}

function elementOrder(): readonly string[] {
  return Array.from(document.querySelectorAll('[data-titlebar-element]')).map(
    (node) => node.getAttribute('data-titlebar-element') ?? '',
  );
}

function patch(id: string, value: unknown): void {
  operationsStore.getState().applySettingsPatch([{ id, value }]);
}

beforeEach(() => {
  // Rebuilds the personalization slice from the factory snapshot, so each case
  // starts from the schema default rather than the previous patch.
  operationsStore.getState().resetWorld();
});

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(globalThis, 'isTauri');
});

describe('R24: the host family decides the corner treatment and nothing else', () => {
  it('asks DWM to round the window on Windows 11', async () => {
    const calls = mockNativeShell(profiles.win11);

    await mountTitleBar();

    expect(calls).toContainEqual({
      command: 'apply_window_corners',
      args: { rounded: true },
    });
  });

  it('asks for square corners on Windows 10 and on a legacy host, through the same call', async () => {
    for (const profile of [profiles.win10, profiles.legacy]) {
      cleanup();
      clearMocks();
      const calls = mockNativeShell(profile);

      await mountTitleBar();

      expect(calls).toContainEqual({
        command: 'apply_window_corners',
        args: { rounded: false },
      });
      // The bar itself is the same on all three; only the corners differ.
      expect(elementOrder()).toEqual(['title', 'information', 'minimize', 'maximize', 'close']);
    }
  });

  it('carries the family so a screenshot says which host it was taken on', async () => {
    mockNativeShell(profiles.win10);

    await mountTitleBar();

    expect(document.querySelector('.ops-titlebar')?.getAttribute('data-host-family')).toBe('win10');
  });

  it('reaches no IPC bridge at all in a browser session', async () => {
    const calls = mockNativeShell(profiles.win11);
    Reflect.deleteProperty(globalThis, 'isTauri');

    await mountTitleBar();

    expect(calls).toEqual([]);
    // The same chrome is still drawn: the web build differs in what the
    // controls do, not in what the operator sees.
    expect(elementOrder()).toEqual(['title', 'information', 'minimize', 'maximize', 'close']);
    expect(document.querySelector('.ops-titlebar')?.getAttribute('data-host-family')).toBe('other');
  });
});

describe('R24: the window commands the custom bar took over', () => {
  it('invokes the command each control stands for', async () => {
    const calls = mockNativeShell(profiles.win11);
    await mountTitleBar();

    for (const label of ['Свернуть окно', 'Развернуть окно', 'Закрыть окно']) {
      fireEvent.click(screen.getByRole('button', { name: label }));
    }
    await act(async () => {
      await Promise.resolve();
    });

    const commands = calls.map((call) => call.command);
    expect(commands).toContain('plugin:window|minimize');
    expect(commands).toContain('plugin:window|toggle_maximize');
    expect(commands).toContain('plugin:window|close');
  });

  it('offers restore instead of maximize once the window is maximized', async () => {
    mockNativeShell(profiles.win11, (command) =>
      command === 'plugin:window|is_maximized' ? true : null,
    );

    await mountTitleBar();

    expect(screen.queryByRole('button', { name: 'Восстановить окно' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Развернуть окно' })).toBeNull();
  });

  it('answers a click with nothing at all on the web build', async () => {
    const calls = mockNativeShell(profiles.win11);
    Reflect.deleteProperty(globalThis, 'isTauri');
    await mountTitleBar();

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть окно' }));
    await act(async () => {
      await Promise.resolve();
    });

    // Inert, not absent: a browser session draws the control and refuses no
    // caller, which is what keeps one bar for both builds.
    expect(calls).toEqual([]);
  });
});

describe('R25: the bar an operator arranged', () => {
  it('draws exactly the elements titlebar.elements names, in that order', async () => {
    patch('titlebar.elements', ['close', 'title', 'minimize']);
    mockNativeShell(profiles.win11);

    await mountTitleBar();

    expect(elementOrder()).toEqual(['close', 'title', 'minimize']);
    expect(screen.queryByRole('button', { name: 'Развернуть окно' })).toBeNull();
  });

  it('draws no control at all when the roster is emptied', async () => {
    patch('titlebar.elements', []);
    mockNativeShell(profiles.win11);

    await mountTitleBar();

    expect(elementOrder()).toEqual([]);
    // The bar itself stays: it is the window's frame, and R26 sizes the
    // workspace against a row that is always there.
    expect(document.querySelector('.ops-titlebar')).not.toBeNull();
  });

  it('shows the reading titlebar.information names, and nothing when it names none', async () => {
    mockNativeShell(profiles.win11);
    await mountTitleBar();
    // `route` is the default, and the title bar names the route it was handed.
    expect(document.querySelector('.ops-titlebar__information')?.textContent).toBe(
      'РЕЕСТР ОБЪЕКТОВ',
    );

    for (const [value, expected] of [
      ['operation', operationsStore.getState().operation.code],
      ['connection', 'LOCAL/OFF'],
    ] as const) {
      patch('titlebar.information', value);
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.querySelector('.ops-titlebar__information')?.textContent).toContain(expected);
    }

    patch('titlebar.information', 'none');
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector('.ops-titlebar__information')).toBeNull();
    expect(elementOrder()).toEqual(['title', 'minimize', 'maximize', 'close']);
  });

  it('marks the drag region titlebar.dragRegion asks for, and only that much', async () => {
    mockNativeShell(profiles.win11);
    await mountTitleBar();
    const bar = document.querySelector('.ops-titlebar');
    const title = document.querySelector('.ops-titlebar__title');
    const control = document.querySelector('.ops-titlebar__control');

    // `full`: the bar and everything on it that is not a command.
    expect(bar?.hasAttribute('data-tauri-drag-region')).toBe(true);
    expect(title?.hasAttribute('data-tauri-drag-region')).toBe(true);
    // A control that dragged the window would never register the click.
    expect(control?.hasAttribute('data-tauri-drag-region')).toBe(false);

    patch('titlebar.dragRegion', 'title');
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector('.ops-titlebar')?.hasAttribute('data-tauri-drag-region')).toBe(
      false,
    );
    expect(
      document.querySelector('.ops-titlebar__title')?.hasAttribute('data-tauri-drag-region'),
    ).toBe(true);

    patch('titlebar.dragRegion', 'none');
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      document.querySelector('.ops-titlebar__title')?.hasAttribute('data-tauri-drag-region'),
    ).toBe(false);
    expect(document.querySelector('.ops-titlebar')?.getAttribute('data-drag-region')).toBe('none');
  });

  it('reaches the stylesheet with the alignment, which is where the four arrangements live', () => {
    // The alignment is a `justify-content` and one auto margin, so it is bound
    // to the shell root rather than read in the component. The accounting test
    // proves the attribute is selected on; this proves the value carries.
    expect(resolvePresentation({}).attributes['data-titlebar-alignment']).toBe('split');
    expect(
      resolvePresentation({ 'titlebar.alignment': 'center' }).attributes['data-titlebar-alignment'],
    ).toBe('center');
    expect(
      resolvePresentation({ 'titlebar.alignment': 'a-side-that-does-not-exist' }).attributes[
        'data-titlebar-alignment'
      ],
    ).toBe('split');
  });
});
