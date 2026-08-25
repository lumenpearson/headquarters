// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { operationsStore } from '../state/operationsStore.js';
import { SystemScreen } from './SystemScreen.js';

// `TileGrid`, which lays this screen out, calls useRouter() to offer a
// relocated tile its own screen. The stub only has to survive the render.
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

/*
 * `TileGrid` draws nothing until a `ResizeObserver` has told it how much room
 * the screen was given, and the shared stub in `vitest.setup.ts` observes
 * nothing on purpose. Reporting one box here is what puts the telemetry panel
 * on the screen at all; the assertions below read the numbers in it, never
 * where the resolver placed it.
 */
globalThis.ResizeObserver = class {
  constructor(private readonly report: (entries: readonly ResizeObserverEntry[]) => void) {}
  observe(target: Element): void {
    this.report([{ target, contentRect: { height: 900, width: 1600 } } as ResizeObserverEntry]);
  }
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

/** The host counters as the panel prints them, keyed by their label. */
function hostCounters(container: HTMLElement): Readonly<Record<string, string>> {
  const metrics = [...container.querySelectorAll('.system-resources .ops-metric')];
  return Object.fromEntries(
    metrics.map((metric) => [
      metric.querySelector('span')?.textContent ?? '',
      metric.querySelector('strong')?.textContent ?? '',
    ]),
  );
}

function sourceCaption(container: HTMLElement): string {
  return container.querySelector('.system-resources .ops-panel__header span')?.textContent ?? '';
}

describe('telemetry.source names what the system screen samples', () => {
  beforeEach(() => {
    // Rebuilds the personalization slice from the factory snapshot, so each
    // case starts from the schema default rather than the previous patch.
    operationsStore.getState().resetWorld();
  });

  it('samples the deterministic world by default and says so', () => {
    const simulated = operationsStore.getState().metrics;

    const { container } = render(<SystemScreen />);

    expect(hostCounters(container).CPU).toBe(`${simulated.cpu}%`);
    expect(hostCounters(container).RAM).toBe(`${simulated.ram}%`);
    expect(sourceCaption(container)).toContain('SIM');
  });

  it('shows no numbers for native, because no build here reads host counters', () => {
    operationsStore.getState().applySettingsPatch([{ id: 'telemetry.source', value: 'native' }]);

    const { container } = render(<SystemScreen />);

    // The failure this guards against is silence: the simulated series shown
    // under a native heading, telling the operator this machine is at 43%.
    const simulated = operationsStore.getState().metrics;
    expect(hostCounters(container).CPU).not.toBe(`${simulated.cpu}%`);
    expect(hostCounters(container).CPU).toBe('—');
    expect(hostCounters(container).STORAGE).toBe('—');
    expect(sourceCaption(container)).toContain('НЕДОСТУПЕН');
    expect(screen.getByText(/ИСТОЧНИК ТЕЛЕМЕТРИИ NATIVE/u)).not.toBeNull();
    // A history plotted from the fixed leading values alone would draw a line
    // the named source never produced.
    expect(container.querySelector('.system-resources .resource-charts')).toBeNull();
  });

  it('marks every hybrid series as substituted rather than presenting it as measured', () => {
    operationsStore.getState().applySettingsPatch([{ id: 'telemetry.source', value: 'hybrid' }]);

    const { container } = render(<SystemScreen />);

    const simulated = operationsStore.getState().metrics;
    expect(hostCounters(container).CPU).toBe(`${simulated.cpu}%`);
    expect(sourceCaption(container)).toContain('HYBRID');
    expect(screen.getByText(/СЧЁТЧИКИ ХОСТА НЕДОСТУПНЫ/u)).not.toBeNull();
    // The charts carry no eyebrow of their own, so each series says it too.
    expect(container.querySelector('.system-resources .resource-charts')?.textContent).toContain(
      'SIM',
    );
  });

  it('leaves the simulation reading unlabelled by a source it did not come from', () => {
    operationsStore
      .getState()
      .applySettingsPatch([{ id: 'telemetry.source', value: 'simulation' }]);

    const { container } = render(<SystemScreen />);

    expect(sourceCaption(container)).not.toContain('HYBRID');
    expect(sourceCaption(container)).not.toContain('NATIVE');
    expect(container.querySelector('.system-resources__source')).toBeNull();
  });
});
