import { describe, expect, it, vi } from 'vitest';

import type { AppUpdatePort } from './appUpdatePort';
import { AutostartCoordinator, reconcileAutostart } from './AutostartReconciler';

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

/** Lets a chain of `then`s settle without asserting on a fixed tick count. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

describe('AutostartCoordinator', () => {
  it('publishes nothing when there is no adapter', async () => {
    const coordinator = new AutostartCoordinator(null);
    const listener = vi.fn();
    coordinator.subscribe(listener);

    coordinator.request(true);
    await settle();

    expect(listener).not.toHaveBeenCalled();
    expect(coordinator.getReading()).toEqual({ enabled: false, error: null, pending: false });
  });

  it('does not write on mount merely because the setting disagrees with an autostart entry a person created outside the app', async () => {
    // `startup.launchOnLogin` is at its schema default (false); the shell's
    // own registration is already on, as if set up through Windows Settings
    // rather than this app. Opening the settings card must not touch it.
    const setAutostart = vi.fn().mockResolvedValue(undefined);
    const port = createPort({
      isAutostartEnabled: vi.fn().mockResolvedValue(true),
      setAutostart,
    });
    const coordinator = new AutostartCoordinator(port);

    coordinator.request(false); // mount
    await settle();

    expect(setAutostart).not.toHaveBeenCalled();
    expect(coordinator.getReading()).toEqual({ enabled: true, error: null, pending: false });
  });

  it('reads without writing on mount even when the machine already agrees with the setting', async () => {
    const setAutostart = vi.fn().mockResolvedValue(undefined);
    const isAutostartEnabled = vi.fn().mockResolvedValue(false);
    const port = createPort({ isAutostartEnabled, setAutostart });
    const coordinator = new AutostartCoordinator(port);

    coordinator.request(false); // mount
    await settle();

    expect(isAutostartEnabled).toHaveBeenCalledTimes(1);
    expect(setAutostart).not.toHaveBeenCalled();
    expect(coordinator.getReading()).toEqual({ enabled: false, error: null, pending: false });
  });

  it('writes once the operator changes the setting after mount', async () => {
    const setAutostart = vi.fn().mockResolvedValue(undefined);
    const port = createPort({
      isAutostartEnabled: vi.fn().mockResolvedValue(false),
      setAutostart,
    });
    const coordinator = new AutostartCoordinator(port);

    coordinator.request(false); // mount: reads only
    await settle();
    coordinator.request(true); // the operator flips the switch
    await settle();

    expect(setAutostart).toHaveBeenCalledTimes(1);
    expect(setAutostart).toHaveBeenCalledWith(true);
  });

  it('does not write again for a repeated request carrying the same desired value', async () => {
    const setAutostart = vi.fn().mockResolvedValue(undefined);
    const port = createPort({
      isAutostartEnabled: vi.fn().mockResolvedValue(true),
      setAutostart,
    });
    const coordinator = new AutostartCoordinator(port);

    coordinator.request(true); // mount
    await settle();
    coordinator.request(true); // desired unchanged: no operator action happened
    await settle();

    expect(setAutostart).not.toHaveBeenCalled();
  });

  it('pending goes true then false, and an earlier slow write does not overwrite a later fast one', async () => {
    let resolveSlowWrite: (() => void) | undefined;
    let setAutostartCalls = 0;
    const isAutostartEnabled = vi
      .fn()
      .mockResolvedValueOnce(false) // the mount-time read
      .mockResolvedValueOnce(false) // the fast write's follow-up read
      .mockResolvedValueOnce(true); // the stale slow write's follow-up read, never published
    const setAutostart = vi.fn().mockImplementation(() => {
      setAutostartCalls += 1;
      if (setAutostartCalls === 1) {
        // The write for `desired: true`, deliberately left unsettled until
        // the assertions below explicitly resolve it.
        return new Promise<void>((resolve) => {
          resolveSlowWrite = resolve;
        });
      }
      return Promise.resolve();
    });
    const port = createPort({ isAutostartEnabled, setAutostart });
    const coordinator = new AutostartCoordinator(port);

    coordinator.request(false); // mount: read-only
    await settle();
    expect(coordinator.getReading()).toEqual({ enabled: false, error: null, pending: false });

    coordinator.request(true); // slow: setAutostart(true) never resolves below
    expect(coordinator.getReading().pending).toBe(true);

    coordinator.request(false); // supersedes the slow request before it settles
    expect(coordinator.getReading().pending).toBe(true);
    await settle();

    // The fast request's own write and follow-up read completed and published.
    expect(coordinator.getReading()).toEqual({ enabled: false, error: null, pending: false });

    // Letting the stale, slow request settle now must not overwrite that reading.
    resolveSlowWrite?.();
    await settle();

    expect(coordinator.getReading()).toEqual({ enabled: false, error: null, pending: false });
    expect(setAutostart).toHaveBeenNthCalledWith(1, true);
    expect(setAutostart).toHaveBeenNthCalledWith(2, false);
  });

  it('getReading() returns the same reference between publishes', async () => {
    const port = createPort({ isAutostartEnabled: vi.fn().mockResolvedValue(true) });
    const coordinator = new AutostartCoordinator(port);

    coordinator.request(false);
    await settle();

    const first = coordinator.getReading();
    const second = coordinator.getReading();
    expect(first).toBe(second);
  });
});
