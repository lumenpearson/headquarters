// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { operationsStore } from '@/state/operationsStore';

import type { AppUpdatePort } from './appUpdatePort';
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
  });

  it('closes the port on unmount, whether or not it created it', () => {
    const port = createPort();
    const { unmount } = renderHook(() => useAppUpdate(port));

    unmount();

    expect(port.close).toHaveBeenCalledTimes(1);
  });

  it('never checks on mount: the launch check is the runtime provider\u2019s to run', async () => {
    /*
     * Mounting the surface is not a launch. The check used to happen here,
     * which meant `startup.autoUpdate` fired when the operator opened
     * settings and never when they did not -- and restarted a download that
     * was already running. It moved to `appUpdateRuntime`, called once by
     * `RuntimeProvider`.
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
