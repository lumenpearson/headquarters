'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import {
  initializeOperationsClient,
  operationsStore,
  useOperationsStore,
} from '@/state/operationsStore';

const demoRoutes = [
  '/overview',
  '/map',
  '/video/cameras',
  '/objects/K-17',
  '/cases/CASE-01',
  '/communications',
  '/analytics',
  '/system',
] as const;

export function OperationsRuntime({ children }: { readonly children: ReactNode }) {
  const router = useRouter();
  const autoDemo = useOperationsStore((state) => state.production.autoDemo);
  useEffect(() => initializeOperationsClient(), []);

  useEffect(() => {
    let active = true;
    let timeoutId = 0;
    const schedule = () => {
      const step = operationsStore.getState().metrics.simulationStep;
      const delay = 3_000 + ((step * 1_379 + 2_117) % 5_000);
      timeoutId = window.setTimeout(() => {
        if (!active) return;
        operationsStore.getState().simulationTick();
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    if (!autoDemo) return;
    let index = 0;
    const intervalId = window.setInterval(() => {
      index = (index + 1) % demoRoutes.length;
      router.push(demoRoutes[index] ?? '/overview');
    }, 12_000);
    return () => window.clearInterval(intervalId);
  }, [autoDemo, router]);

  return children;
}
