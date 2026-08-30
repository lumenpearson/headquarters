import { describe, expect, it, vi } from 'vitest';

import { AppUpdateService } from './AppUpdateService';
import type { AppUpdatePort } from './appUpdatePort';

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

describe('AppUpdateService', () => {
  describe('with no adapter', () => {
    it('pins the state to unavailable and turns every method into a no-op', async () => {
      const service = new AppUpdateService(null);
      expect(service.getState()).toEqual({ status: 'unavailable' });

      await service.checkForUpdate();
      await service.download();
      await service.pause();
      await service.resume();
      await service.cancel();
      await service.install();
      await expect(service.isAutostartEnabled()).resolves.toBe(false);

      expect(service.getState()).toEqual({ status: 'unavailable' });
    });
  });

  it('checking that finds nothing to install is upToDate, not idle again', async () => {
    const port = createPort({ checkForUpdate: vi.fn().mockResolvedValue(null) });
    const service = new AppUpdateService(port);

    await service.checkForUpdate();

    expect(service.getState()).toEqual({ status: 'upToDate' });
  });

  it('a check failure lands in error carrying the message', async () => {
    const port = createPort({
      checkForUpdate: vi.fn().mockRejectedValue(new Error('network unreachable')),
    });
    const service = new AppUpdateService(port);

    await service.checkForUpdate();

    expect(service.getState()).toEqual({ status: 'error', message: 'network unreachable' });
  });

  it('a download failure lands in error carrying the message', async () => {
    const port = createPort({
      checkForUpdate: vi.fn().mockResolvedValue({ version: '5.0.0' }),
      startDownload: vi.fn().mockRejectedValue(new Error('signature mismatch')),
    });
    const service = new AppUpdateService(port);

    await service.checkForUpdate();
    await service.download();

    expect(service.getState()).toEqual({ status: 'error', message: 'signature mismatch' });
  });

  it('download/pause/resume/cancel/install are no-ops from the wrong state', async () => {
    const port = createPort();
    const service = new AppUpdateService(port);

    // Still idle: none of these apply from here.
    await service.download();
    await service.pause();
    await service.resume();
    await service.cancel();
    await service.install();

    expect(port.startDownload).not.toHaveBeenCalled();
    expect(port.pause).not.toHaveBeenCalled();
    expect(port.resume).not.toHaveBeenCalled();
    expect(port.cancel).not.toHaveBeenCalled();
    expect(port.install).not.toHaveBeenCalled();
    expect(service.getState()).toEqual({ status: 'idle' });
  });

  it('a download that completes without pausing reaches ready, and install is not called until requested', async () => {
    const port = createPort({
      checkForUpdate: vi.fn().mockResolvedValue({ version: '4.0.0' }),
      startDownload: vi
        .fn()
        .mockImplementation(
          async (onProgress: (received: number, total: number | null) => void) => {
            onProgress(50, 100);
            onProgress(100, 100);
          },
        ),
    });
    const service = new AppUpdateService(port);

    await service.checkForUpdate();
    await service.download();

    expect(service.getState()).toEqual({ status: 'ready', version: '4.0.0' });
    expect(port.install).not.toHaveBeenCalled();
  });

  it('cancel discards progress and returns to idle, requiring a fresh check before downloading again', async () => {
    const port = createPort({
      checkForUpdate: vi.fn().mockResolvedValue({ version: '3.0.0' }),
      startDownload: vi
        .fn()
        .mockImplementation(
          async (onProgress: (received: number, total: number | null) => void) => {
            onProgress(20, 100);
            return new Promise<void>(() => {
              // Deliberately never settles within this test: cancel() must not need it to.
            });
          },
        ),
      cancel: vi.fn().mockResolvedValue(undefined),
    });
    const service = new AppUpdateService(port);

    await service.checkForUpdate();
    void service.download();
    expect(service.getState()).toMatchObject({ status: 'downloading', percent: 20 });

    await service.cancel();

    expect(port.cancel).toHaveBeenCalledTimes(1);
    // Not 'available': the native session `port.cancel()` just cancelled is gone (see
    // `AppUpdateService.cancel`'s comment), so `download()` from here has nothing to
    // resume -- only a fresh `checkForUpdate` can produce another downloadable state.
    expect(service.getState()).toEqual({ status: 'idle' });
  });

  it('drives the whole lifecycle: check, download with percent updates, pause holds percent, resume continues to ready, install called once', async () => {
    let firstAttemptSettled: (() => void) | undefined;
    let progressCallback: ((received: number, total: number | null) => void) | undefined;
    const port = createPort({
      checkForUpdate: vi.fn().mockResolvedValue({ version: '2.0.0', notes: 'Fixes things' }),
      startDownload: vi
        .fn()
        .mockImplementation(
          async (onProgress: (received: number, total: number | null) => void) => {
            progressCallback = onProgress;
            onProgress(50, 100);
            return new Promise<void>((resolve) => {
              firstAttemptSettled = resolve;
            });
          },
        ),
      pause: vi.fn().mockResolvedValue(undefined),
      // The real adapter keeps routing native progress events to the same callback
      // `startDownload` registered, across a pause/resume cycle; the fake reproduces
      // that by calling the captured callback directly rather than taking a new one.
      resume: vi.fn().mockImplementation(async () => {
        progressCallback?.(100, 100);
      }),
      install: vi.fn().mockResolvedValue(undefined),
    });
    const service = new AppUpdateService(port);

    await service.checkForUpdate();
    expect(service.getState()).toEqual({
      status: 'available',
      version: '2.0.0',
      notes: 'Fixes things',
    });

    const downloadCall = service.download();
    expect(service.getState()).toEqual({
      status: 'downloading',
      version: '2.0.0',
      notes: 'Fixes things',
      percent: 50,
    });

    await service.pause();
    expect(port.pause).toHaveBeenCalledTimes(1);
    expect(service.getState()).toEqual({
      status: 'paused',
      version: '2.0.0',
      notes: 'Fixes things',
      percent: 50,
    });

    // The original `startDownload` call is still pending underneath; letting it settle
    // now must not clobber the `paused` state `pause()` already committed.
    firstAttemptSettled?.();
    await downloadCall;
    expect(service.getState()).toEqual({
      status: 'paused',
      version: '2.0.0',
      notes: 'Fixes things',
      percent: 50,
    });

    await service.resume();
    expect(port.resume).toHaveBeenCalledTimes(1);
    expect(service.getState()).toEqual({
      status: 'ready',
      version: '2.0.0',
      notes: 'Fixes things',
    });

    await service.install();
    expect(port.install).toHaveBeenCalledTimes(1);
  });

  it('autostart getter and setter pass straight through to the port', async () => {
    const port = createPort({
      isAutostartEnabled: vi.fn().mockResolvedValue(true),
      setAutostart: vi.fn().mockResolvedValue(undefined),
    });
    const service = new AppUpdateService(port);

    await expect(service.isAutostartEnabled()).resolves.toBe(true);
    await service.setAutostart(true);

    expect(port.setAutostart).toHaveBeenCalledWith(true);
  });

  it('subscribe delivers every transition until unsubscribe', async () => {
    const port = createPort({ checkForUpdate: vi.fn().mockResolvedValue({ version: '6.0.0' }) });
    const service = new AppUpdateService(port);
    const seen: string[] = [];
    const unsubscribe = service.subscribe((state) => seen.push(state.status));

    await service.checkForUpdate();
    unsubscribe();
    await service.checkForUpdate();

    expect(seen).toEqual(['checking', 'available']);
  });
});
