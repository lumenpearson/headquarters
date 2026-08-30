import { describe, expect, it, vi } from 'vitest';

import type { AppUpdatePort } from './appUpdatePort';
import { reconcileAutostart } from './AutostartReconciler';

function createPort(overrides: Partial<AppUpdatePort> = {}): AppUpdatePort {
  return {
    available: () => true,
    checkForUpdate: vi.fn(),
    startDownload: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    install: vi.fn(),
    isAutostartEnabled: vi.fn(),
    setAutostart: vi.fn(),
    ...overrides,
  };
}

describe('reconcileAutostart', () => {
  it('reconciles to no registration and no error when there is no adapter', async () => {
    await expect(reconcileAutostart(null, true)).resolves.toEqual({ enabled: false, error: null });
  });

  it('asks the port to register, then reads the actual registration back', async () => {
    const port = createPort({
      setAutostart: vi.fn().mockResolvedValue(undefined),
      isAutostartEnabled: vi.fn().mockResolvedValue(true),
    });

    await expect(reconcileAutostart(port, true)).resolves.toEqual({ enabled: true, error: null });
    expect(port.setAutostart).toHaveBeenCalledWith(true);
    expect(port.isAutostartEnabled).toHaveBeenCalledTimes(1);
  });

  it('carries the failure but still reports the actual state when the shell refuses', async () => {
    const port = createPort({
      setAutostart: vi.fn().mockRejectedValue(new Error('permission denied')),
      isAutostartEnabled: vi.fn().mockResolvedValue(false),
    });

    await expect(reconcileAutostart(port, true)).resolves.toEqual({
      enabled: false,
      error: 'permission denied',
    });
  });

  it('reports honestly even when the follow-up read itself fails', async () => {
    const port = createPort({
      setAutostart: vi.fn().mockResolvedValue(undefined),
      isAutostartEnabled: vi.fn().mockRejectedValue(new Error('registry unreachable')),
    });

    await expect(reconcileAutostart(port, true)).resolves.toEqual({
      enabled: false,
      error: 'registry unreachable',
    });
  });

  it('keeps the write failure, not the read failure, when both calls reject', async () => {
    const port = createPort({
      setAutostart: vi.fn().mockRejectedValue(new Error('write refused')),
      isAutostartEnabled: vi.fn().mockRejectedValue(new Error('read refused')),
    });

    await expect(reconcileAutostart(port, false)).resolves.toEqual({
      enabled: false,
      error: 'write refused',
    });
  });
});
