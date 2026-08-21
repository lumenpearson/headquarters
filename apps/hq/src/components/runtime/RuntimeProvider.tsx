'use client';

import { createContext, use, useEffect, useState, type ReactNode } from 'react';

import { RuntimeController } from '@/application/RuntimeController';
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
