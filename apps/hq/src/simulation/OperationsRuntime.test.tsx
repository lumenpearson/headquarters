// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { operationsStore } from '@/state/operationsStore';

import { minimumTickIntervalMs, OperationsRuntime } from './OperationsRuntime';

// The runtime pushes demo routes through the router; the stub only has to
// survive the render, because no case here turns the demo loop on.
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

/**
 * The cadence the simulation runs at (R31).
 *
 * The timer used to reschedule itself with a 3-8 s delay derived from the step
 * counter and read no setting at all, so `simulation.updateIntervalMs` was a
 * control an operator could move for nothing.
 */
function steps(): number {
  return operationsStore.getState().metrics.simulationStep;
}

function askFor(updateIntervalMs: number): void {
  act(() => {
    operationsStore
      .getState()
      .applySettingsPatch([{ id: 'simulation.updateIntervalMs', value: updateIntervalMs }]);
  });
}

describe('simulation.updateIntervalMs sets the tick cadence', () => {
  beforeEach(() => {
    /*
     * The runtime hydrates the persisted blob on mount, and the store writes
     * one on every change. Without this, the second case in the file mounts
     * with the first case's settings restored under it and runs at a cadence
     * nobody in that case asked for -- which is exactly the defect these cases
     * exist to catch, arriving from the wrong direction.
     */
    localStorage.clear();
    vi.useFakeTimers();
    operationsStore.getState().resetWorld();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks once per interval the operator asked for', () => {
    askFor(2_000);
    render(<OperationsRuntime>{null}</OperationsRuntime>);

    vi.advanceTimersByTime(6_000);

    expect(steps()).toBe(3);
  });

  it('takes a shorter interval as more readings over the same span', () => {
    askFor(500);
    render(<OperationsRuntime>{null}</OperationsRuntime>);

    vi.advanceTimersByTime(6_000);

    expect(steps()).toBe(12);
  });

  it('changes cadence when the setting moves, without a remount', () => {
    askFor(2_000);
    render(<OperationsRuntime>{null}</OperationsRuntime>);
    vi.advanceTimersByTime(4_000);
    const afterSlow = steps();

    askFor(1_000);
    vi.advanceTimersByTime(4_000);

    expect(afterSlow).toBe(2);
    expect(steps() - afterSlow).toBe(4);
  });

  it('refuses a cadence faster than the shell can render, and says so in one place', () => {
    // The schema bounds the setting from one millisecond, because that is what
    // `TelemetryService` bounds a server-side sampler to. A tick here writes a
    // store the whole shell renders from, so the floor is stated in the runtime
    // rather than pretended away.
    askFor(1);
    render(<OperationsRuntime>{null}</OperationsRuntime>);

    vi.advanceTimersByTime(minimumTickIntervalMs * 10);

    expect(steps()).toBe(10);
  });

  it('stops ticking once the runtime unmounts', () => {
    askFor(1_000);
    const { unmount } = render(<OperationsRuntime>{null}</OperationsRuntime>);
    vi.advanceTimersByTime(2_000);
    const atUnmount = steps();

    unmount();
    vi.advanceTimersByTime(10_000);

    expect(atUnmount).toBe(2);
    expect(steps()).toBe(atUnmount);
  });
});
