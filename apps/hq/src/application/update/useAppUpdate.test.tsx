// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { operationsStore } from '@/state/operationsStore';

import type { AppUpdatePort } from './appUpdatePort';
import { resetAppUpdateRuntimeForTests } from './appUpdateRuntime';
import { useAppUpdate } from './useAppUpdate';

function createPort(overrides: Partial<AppUpdatePort> = {}): AppUpdatePort & { close: () => void } {
  return {
    available: () => true,
    checkForUpdate: vi.fn(),
    startDownload: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    install: vi.fn(),
    isAutostartEnabled: vi.fn().mockResolvedValue(false),
    setAutostart: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    ...overrides,
  };
}

describe('useAppUpdate', () => {
  beforeEach(() => {
    operationsStore.getState().discardSettingsDraft();
    resetAppUpdateRuntimeForTests(null);
  });

  /*
   * Item 10 (H3 review): the previous title -- "closes the port on unmount,
   * whether or not it created it" -- claimed the opposite of what
   * `useAppUpdate.ts`'s own effect does (`if (portOverride === undefined)
   * return;`). This test only ever exercised the `portOverride` branch; the
   * negative case below is what actually proves "whether or not."
   */
  it('closes the port on unmount when a portOverride brought it into being', () => {
    const port = createPort();
    const { unmount } = renderHook(() => useAppUpdate(port));

    unmount();

    expect(port.close).toHaveBeenCalledTimes(1);
  });

  it('does not close the process service’s port on unmount when no portOverride is given', () => {
    const port = createPort();
    resetAppUpdateRuntimeForTests(port);
    const { unmount } = renderHook(() => useAppUpdate());

    unmount();

    // The process service's adapter listens for as long as the session
    // does; a mount that merely subscribed to it must not end it just
    // because that particular surface went away.
    expect(port.close).not.toHaveBeenCalled();
  });

  it('never checks on mount: the launch check is the shell root\u2019s to run', async () => {
    /*
     * Mounting the surface is not a launch. The check used to happen here,
     * which meant `startup.autoUpdate` fired when the operator opened
     * settings and never when they did not -- and restarted a download that
     * was already running. It moved to `appUpdateRuntime`, called once by
     * `OperationalShell` (see `RuntimeProvider`'s `LaunchUpdateCheck`).
     */
    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'startup.autoUpdate', value: true }]);
    });
    const port = createPort({ checkForUpdate: vi.fn().mockResolvedValue({ version: '9.0.0' }) });

    renderHook(() => useAppUpdate(port));

    // Give any stray microtask a turn; there should be nothing to wait for.
    await act(async () => {
      await Promise.resolve();
    });
    expect(port.checkForUpdate).not.toHaveBeenCalled();
  });
});
