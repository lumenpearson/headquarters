// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { operationsStore } from '@/state/operationsStore';

import type { AppUpdatePort } from './appUpdatePort';
import {
  appUpdateService,
  resetAppUpdateRuntimeForTests,
  startLaunchUpdateCheck,
} from './appUpdateRuntime';

function createPort(overrides: Partial<AppUpdatePort> = {}): AppUpdatePort {
  return {
    available: () => true,
    checkForUpdate: vi.fn().mockResolvedValue(null),
    startDownload: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    install: vi.fn(),
    isAutostartEnabled: vi.fn().mockResolvedValue(false),
    setAutostart: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Lets a chain of `then`s settle without asserting on a fixed tick count. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

describe('the launch update check', () => {
  beforeEach(() => {
    operationsStore.getState().discardSettingsDraft();
    resetAppUpdateRuntimeForTests(null);
  });

  it('does nothing when startup.autoUpdate is off, which is the schema default', async () => {
    const port = createPort();
    resetAppUpdateRuntimeForTests(port);

    startLaunchUpdateCheck();
    await settle();

    expect(port.checkForUpdate).not.toHaveBeenCalled();
  });

  it('checks and downloads once when startup.autoUpdate is on', async () => {
    operationsStore.getState().applySettingsPatch([{ id: 'startup.autoUpdate', value: true }]);
    const port = createPort({ checkForUpdate: vi.fn().mockResolvedValue({ version: '9.0.0' }) });
    resetAppUpdateRuntimeForTests(port);

    startLaunchUpdateCheck();
    await settle();

    expect(port.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(port.startDownload).toHaveBeenCalledTimes(1);
    expect(appUpdateService().getState().status).toBe('ready');
  });

  it('downloads nothing when the check finds no update to install', async () => {
    operationsStore.getState().applySettingsPatch([{ id: 'startup.autoUpdate', value: true }]);
    const port = createPort({ checkForUpdate: vi.fn().mockResolvedValue(null) });
    resetAppUpdateRuntimeForTests(port);

    startLaunchUpdateCheck();
    await settle();

    expect(appUpdateService().getState().status).toBe('upToDate');
    expect(port.startDownload).not.toHaveBeenCalled();
  });

  it('runs once per launch, however many times it is called', async () => {
    // A Strict Mode replay of the provider's effect is not a second launch,
    // and a second launch is what would restart a download already running.
    operationsStore.getState().applySettingsPatch([{ id: 'startup.autoUpdate', value: true }]);
    const port = createPort({ checkForUpdate: vi.fn().mockResolvedValue({ version: '9.0.0' }) });
    resetAppUpdateRuntimeForTests(port);

    startLaunchUpdateCheck();
    startLaunchUpdateCheck();
    await settle();
    startLaunchUpdateCheck();
    await settle();

    expect(port.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(port.startDownload).toHaveBeenCalledTimes(1);
  });

  it('keeps one service for the session, so a surface that reopens sees the transfer in flight', () => {
    const port = createPort();
    resetAppUpdateRuntimeForTests(port);

    expect(appUpdateService()).toBe(appUpdateService());
  });

  it('asks a browser build for nothing at all', async () => {
    operationsStore.getState().applySettingsPatch([{ id: 'startup.autoUpdate', value: true }]);
    resetAppUpdateRuntimeForTests(null);

    startLaunchUpdateCheck();
    await settle();

    // No adapter, no request, and the state says so rather than erroring.
    expect(appUpdateService().getState().status).toBe('unavailable');
  });
});
