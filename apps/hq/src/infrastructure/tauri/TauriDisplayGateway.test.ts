// @vitest-environment jsdom
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';

import { parseNativeMonitors, TauriDisplayGateway } from './TauriDisplayGateway';

interface RecordedCall {
  readonly command: string;
  readonly args: unknown;
}

function mockNativeShell(handler: (command: string, args: unknown) => unknown): RecordedCall[] {
  const calls: RecordedCall[] = [];
  Object.assign(globalThis, { isTauri: true });
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

describe('TauriDisplayGateway on the web build', () => {
  it('reports no displays and refuses no caller', async () => {
    const gateway = new TauriDisplayGateway();

    expect(gateway.isAvailable()).toBe(false);
    await expect(gateway.listMonitors()).resolves.toEqual([]);
    await expect(gateway.openScreenWindow('wall-center', 1, true)).resolves.toEqual({
      status: 'unavailable',
    });
    await expect(gateway.closeManagedWindows()).resolves.toEqual({ status: 'unavailable' });
  });

  it('invokes nothing at all without a native shell', async () => {
    // The absence is the claim: a browser session must not reach the IPC
    // bridge, which is not there to reach.
    const calls = mockNativeShell(() => undefined);
    Reflect.deleteProperty(globalThis, 'isTauri');
    const gateway = new TauriDisplayGateway();

    await gateway.listMonitors();
    await gateway.closeManagedWindows();

    expect(calls).toEqual([]);
  });
});

describe('TauriDisplayGateway inside the native shell', () => {
  const monitors = [
    { name: 'HQ-LEFT', x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1, primary: true },
    {
      name: null,
      x: 1920,
      y: 0,
      width: 3840,
      height: 2160,
      scaleFactor: 1.5,
      primary: false,
    },
  ];

  it('reads the monitor list the native side reports', async () => {
    mockNativeShell((command) => (command === 'list_monitors' ? monitors : undefined));
    const gateway = new TauriDisplayGateway();

    await expect(gateway.listMonitors()).resolves.toEqual(monitors);
  });

  it('names the screen, the monitor and the fullscreen flag the command expects', async () => {
    const calls = mockNativeShell(() => null);
    const gateway = new TauriDisplayGateway();

    await expect(gateway.openScreenWindow('wall-center', 2, false)).resolves.toEqual({
      status: 'opened',
      screenId: 'wall-center',
    });

    expect(calls).toEqual([
      {
        command: 'open_screen_window',
        // camelCase on the wire; Tauri maps it onto `screen_id`,
        // `monitor_index` and `fullscreen` in `managed_windows.rs`.
        args: { screenId: 'wall-center', monitorIndex: 2, fullscreen: false },
      },
    ]);
  });

  it('reports the native rejection rather than throwing at the operator', async () => {
    mockNativeShell(() => {
      throw 'unknown screen id';
    });
    const gateway = new TauriDisplayGateway();

    await expect(gateway.openScreenWindow('not-a-screen', 0, true)).resolves.toEqual({
      status: 'failed',
      reason: 'unknown screen id',
    });
  });

  it('closes the managed windows', async () => {
    const calls = mockNativeShell(() => null);
    const gateway = new TauriDisplayGateway();

    await expect(gateway.closeManagedWindows()).resolves.toEqual({ status: 'closed' });

    expect(calls).toEqual([{ command: 'close_managed_windows', args: {} }]);
  });
});

describe('parseNativeMonitors', () => {
  it('reads an absent monitor name as no name rather than as a name', () => {
    expect(
      parseNativeMonitors([
        { x: 0, y: 0, width: 1280, height: 1024, scaleFactor: 1, primary: false },
      ]),
    ).toEqual([
      { name: null, x: 0, y: 0, width: 1280, height: 1024, scaleFactor: 1, primary: false },
    ]);
  });

  it('refuses a list the native side could not have produced', () => {
    expect(() => parseNativeMonitors('two monitors')).toThrow(/invalid monitor list/u);
    expect(() => parseNativeMonitors([{ x: 0, y: 0 }])).toThrow(/invalid monitor list/u);
    expect(() =>
      parseNativeMonitors([
        { name: 'HQ', x: 0, y: 0, width: 100, height: 100, scaleFactor: 1, primary: 'yes' },
      ]),
    ).toThrow(/invalid monitor list/u);
  });
});
