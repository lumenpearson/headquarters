import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TauriAppUpdateAdapter } from './TauriAppUpdateAdapter';

/*
 * `@tauri-apps/api/event`'s `listen` and `@tauri-apps/api/core`'s `invoke` are mocked
 * directly rather than through `mockIPC` (as `TauriScreenBus.test.ts` uses): these tests
 * are about whether *this adapter* calls the `UnlistenFn` it was handed, not about Tauri's
 * own event delivery -- which `mockIPC` would exercise, but which nothing here needs to
 * re-prove. `@tauri-apps/plugin-autostart` and `@tauri-apps/plugin-updater` are mocked only
 * so the module graph resolves; none of their exports are exercised below. Vitest hoists
 * every `vi.mock` call above the imports above, so the mocked modules are what
 * `TauriAppUpdateAdapter` itself resolves against.
 */
const listenMock = vi.fn();
const invokeMock = vi.fn();
const checkMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => true,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock('@tauri-apps/plugin-autostart', () => ({
  disable: vi.fn(),
  enable: vi.fn(),
  isEnabled: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: (...args: unknown[]) => checkMock(...args),
}));

// This project's vitest.config.ts sets no `clearMocks`/`mockReset`, so the module-level
// mocks above accumulate call history across tests unless reset here explicitly.
beforeEach(() => {
  listenMock.mockReset();
  invokeMock.mockReset();
  checkMock.mockReset();
});

describe('TauriAppUpdateAdapter', () => {
  it('close() calls the resolved unlisten function', async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    invokeMock.mockResolvedValue(undefined);
    const adapter = new TauriAppUpdateAdapter();

    // `resume()` needs no checked update first, unlike `startDownload` -- the shortest
    // path that still registers the native listener.
    await adapter.resume();
    expect(unlisten).not.toHaveBeenCalled();

    adapter.close();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('close() called before the native registration resolves still unlistens once it does', async () => {
    const unlisten = vi.fn();
    let resolveListen: ((value: () => void) => void) | undefined;
    listenMock.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      }),
    );
    invokeMock.mockResolvedValue(undefined);
    const adapter = new TauriAppUpdateAdapter();

    const resuming = adapter.resume();
    adapter.close(); // wins the race against `listen()` still settling
    resolveListen?.(unlisten);
    await resuming;

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('registers the native listener once across repeated calls, not once per call', async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    invokeMock.mockResolvedValue(undefined);
    const adapter = new TauriAppUpdateAdapter();

    await adapter.resume();
    await adapter.resume();

    expect(listenMock).toHaveBeenCalledTimes(1);
    adapter.close();
  });

  it('close() stops routing further native events to onProgress', async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    invokeMock.mockResolvedValue(undefined);
    checkMock.mockResolvedValue({ rid: 7, version: '1.2.3', body: undefined });
    const adapter = new TauriAppUpdateAdapter();
    const onProgress = vi.fn();

    await adapter.checkForUpdate();
    await adapter.startDownload(onProgress);
    const handler = listenMock.mock.calls[0]?.[1] as (event: { payload: unknown }) => void;
    handler({ payload: { received: 10, total: 100 } });
    expect(onProgress).toHaveBeenCalledWith(10, 100);

    adapter.close();
    handler({ payload: { received: 20, total: 100 } });

    // `#onProgress` is nulled by `close()` in addition to the native `unlisten()` call
    // above -- belt and braces against a progress event already in flight when `close()`
    // runs, which would otherwise still reach a caller that considers this adapter gone.
    expect(onProgress).toHaveBeenCalledTimes(1);
  });
});
