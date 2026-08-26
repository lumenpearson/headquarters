// @vitest-environment jsdom
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';

import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  toggleMaximizeWindow,
} from './nativeWindowControls';

interface RecordedCall {
  readonly command: string;
  readonly args: unknown;
}

function mockNativeShell(handler: (command: string, args: unknown) => unknown): RecordedCall[] {
  const calls: RecordedCall[] = [];
  Object.assign(globalThis, { isTauri: true });
  // `getCurrentWindow` reads the label out of the metadata the shell injects;
  // without it there is no window to command.
  mockWindows('control');
  mockIPC((command, args) => {
    calls.push({ command, args });
    return handler(command, args);
  });
  return calls;
}

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(globalThis, 'isTauri');
});

describe('native window controls inside the desktop shell', () => {
  it('names the window command each control stands for', async () => {
    const calls = mockNativeShell(() => null);

    await minimizeWindow();
    await toggleMaximizeWindow();
    await closeWindow();

    expect(calls).toEqual([
      { command: 'plugin:window|minimize', args: { label: 'control' } },
      { command: 'plugin:window|toggle_maximize', args: { label: 'control' } },
      { command: 'plugin:window|close', args: { label: 'control' } },
    ]);
  });

  it('reads whether the window is maximized rather than remembering its own toggles', async () => {
    // The window can be maximized by a double click on the bar, by the system
    // menu or by a keyboard chord, none of which pass through this module.
    mockNativeShell((command) => (command === 'plugin:window|is_maximized' ? true : null));

    await expect(isWindowMaximized()).resolves.toBe(true);
  });
});

describe('native window controls on the web build', () => {
  it('invokes nothing at all and reports the window as not maximized', async () => {
    const calls = mockNativeShell(() => null);
    Reflect.deleteProperty(globalThis, 'isTauri');

    await minimizeWindow();
    await toggleMaximizeWindow();
    await closeWindow();

    // A browser tab is not a maximized window, and the restore glyph would be a
    // promise the button cannot keep.
    await expect(isWindowMaximized()).resolves.toBe(false);
    expect(calls).toEqual([]);
  });
});
