'use client';

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  BridgeMaterialClient,
  type MaterialEntry,
} from '@/infrastructure/materials/BridgeMaterialClient';

export type MaterialCatalogStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface MaterialCatalogValue {
  readonly materials: readonly MaterialEntry[];
  readonly status: MaterialCatalogStatus;
  /** Starts the one load. Idempotent, and safe to call from a render effect. */
  readonly request: () => void;
}

const MaterialCatalogContext = createContext<MaterialCatalogValue>({
  materials: [],
  status: 'idle',
  request: () => undefined,
});

/**
 * Supplies the material catalogue to whichever settings are pickers over it.
 *
 * Mounted once, but deliberately inert until something asks: most settings are
 * not material pickers, and an application that called the local bridge on
 * every boot -- including the many sessions that never open settings -- would
 * be paying for a list nobody reads. `request` is what a picker calls when it
 * actually renders.
 */
interface CatalogOutcome {
  readonly materials: readonly MaterialEntry[];
  readonly status: 'ready' | 'unavailable';
}

export function MaterialCatalogProvider({ children }: { readonly children: ReactNode }) {
  const [outcome, setOutcome] = useState<CatalogOutcome | null>(null);
  const [requested, setRequested] = useState(false);
  const request = useCallback(() => setRequested(true), []);

  useEffect(() => {
    if (!requested) return;
    const controller = new AbortController();
    const client = new BridgeMaterialClient();
    void client
      .list('', 100, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setOutcome({
          materials: [...page.materials].sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt, 'en-US'),
          ),
          status: 'ready',
        });
      })
      .catch(() => {
        // The bridge is opt-in and routinely absent. That is a state to show,
        // not an error to throw: the rest of settings must keep working.
        if (controller.signal.aborted) return;
        setOutcome({ materials: [], status: 'unavailable' });
      });
    return () => controller.abort();
  }, [requested]);

  // `loading` is what "asked, no answer yet" looks like, so it is derived
  // rather than stored. Writing it from inside the effect would be a second
  // render for something already implied by the state that is there.
  const status: MaterialCatalogStatus = !requested
    ? 'idle'
    : outcome === null
      ? 'loading'
      : outcome.status;
  const materials = outcome?.materials ?? emptyMaterials;

  const value = useMemo<MaterialCatalogValue>(
    () => ({ materials, status, request }),
    [materials, status, request],
  );

  return <MaterialCatalogContext value={value}>{children}</MaterialCatalogContext>;
}

const emptyMaterials: readonly MaterialEntry[] = [];

export function useMaterialCatalog(): MaterialCatalogValue {
  return use(MaterialCatalogContext);
}
