'use client';

import { createContext, use, useEffect, useState, type ReactNode } from 'react';

import { RuntimeController } from '@/application/RuntimeController';
import { startLaunchUpdateCheck } from '@/application/update/appUpdateRuntime';
import { useKeybind } from '@/components/keybinds/KeybindRuntime';

interface RuntimeContextValue {
  readonly controller: RuntimeController | null;
  readonly status: 'booting' | 'ready' | 'failed';
  readonly error: string | null;
}

const RuntimeContext = createContext<RuntimeContextValue>({
  controller: null,
  status: 'booting',
  error: null,
});

export function RuntimeProvider({ children }: { readonly children: ReactNode }) {
  const [value, setValue] = useState<RuntimeContextValue>({
    controller: null,
    status: 'booting',
    error: null,
  });

  useEffect(() => {
    const abortController = new AbortController();
    let mounted = true;
    let activeController: RuntimeController | null = null;
    void RuntimeController.create(abortController.signal)
      .then((controller) => {
        activeController = controller;
        if (mounted) setValue({ controller, status: 'ready', error: null });
        else controller.close();
      })
      .catch((error: unknown) => {
        if (mounted && !abortController.signal.aborted) {
          setValue({
            controller: null,
            status: 'failed',
            error: error instanceof Error ? error.message : 'BOOT_FAILURE',
          });
        }
      });
    return () => {
      mounted = false;
      abortController.abort();
      activeController?.close();
    };
  }, []);

  useKeybind('developer.toggle', () => value.controller?.toggleDeveloper());

  return <RuntimeContext value={value}>{children}</RuntimeContext>;
}

export function useRuntime(): RuntimeContextValue {
  return use(RuntimeContext);
}

/**
 * Runs the `startup.autoUpdate` launch check, once, for whichever tree
 * renders it -- and only `OperationalShell` does.
 *
 * `RuntimeProvider` itself is mounted by four roots (`OperationalShell`,
 * `ScreenView`, `WallView`, `DeveloperGate`); the latter three are separate
 * Tauri windows onto the *same* running session, not separate launches. If
 * the check lived in `RuntimeProvider`, opening a wall or screen window
 * alongside the shell would fire it again in that window's own JS context
 * (`launchCheckStarted` is module state, one per webview), racing the
 * shell's own check/download and, on the losing windows, landing in
 * `status: 'error'` where nothing renders an update surface to show it.
 * `startLaunchUpdateCheck` is idempotent regardless, so mounting this
 * component more than once is harmless -- it simply isn't mounted more than
 * once, because only `OperationalShell` renders it.
 *
 * Must be rendered inside a `RuntimeProvider` (it reads `useRuntime`), and
 * after personalization has hydrated, for the same reason every other
 * setting reader waits for that.
 */
export function LaunchUpdateCheck(): null {
  const { status } = useRuntime();
  useEffect(() => {
    if (status === 'ready') startLaunchUpdateCheck();
  }, [status]);
  return null;
}
