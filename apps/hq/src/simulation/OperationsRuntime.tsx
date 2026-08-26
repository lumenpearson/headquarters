'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { useNumberSetting } from '@/application/personalization/useSetting';

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

/**
 * The fastest the world is allowed to advance, whatever the setting says.
 *
 * `simulation.updateIntervalMs` is bounded as `TelemetryService` bounds
 * `update_interval_ms` — from one millisecond — because a server sampling a
 * profile can take a thousand readings a second. This is not that server: a
 * tick writes a store the whole shell renders from, and a thousand of them a
 * second would spend the frame budget on state alone. Twenty a second is
 * already faster than any of it can be read, so the floor costs the operator
 * nothing visible and is stated here rather than pretended away.
 */
export const minimumTickIntervalMs = 50;

export function OperationsRuntime({ children }: { readonly children: ReactNode }) {
  const router = useRouter();
  const autoDemo = useOperationsStore((state) => state.production.autoDemo);
  const demoRotationSeconds = useNumberSetting('advanced.demoRotationSeconds');
  const updateIntervalMs = useNumberSetting('simulation.updateIntervalMs');
  useEffect(() => initializeOperationsClient(), []);

  /*
   * The cadence the operator asked for (R31), where a self-rescheduling timer
   * used to pick 3-8 s from the step counter and read no setting at all.
   *
   * `Date.now()` is supplied here rather than inside the reducer: the store
   * takes the moment as an argument, so the curve phase, the generated event's
   * timestamp and the tracked object's `lastSeenAt` all come from one clock
   * that a test can replace.
   */
  useEffect(() => {
    const cadence = Math.max(minimumTickIntervalMs, updateIntervalMs);
    const intervalId = window.setInterval(() => {
      operationsStore.getState().simulationTick(Date.now());
    }, cadence);
    return () => window.clearInterval(intervalId);
  }, [updateIntervalMs]);

  useEffect(() => {
    if (!autoDemo) return;
    let index = 0;
    const intervalId = window.setInterval(() => {
      index = (index + 1) % demoRoutes.length;
      router.push(demoRoutes[index] ?? '/overview');
    }, demoRotationSeconds * 1000);
    return () => window.clearInterval(intervalId);
  }, [autoDemo, demoRotationSeconds, router]);

  return children;
}
