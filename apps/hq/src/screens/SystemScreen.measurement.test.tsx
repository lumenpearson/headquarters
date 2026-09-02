// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { translateWith } from '@/application/localization/messages';
import { setTelemetryMeasurementClient } from '@/application/telemetry/telemetryMeasurementClient';

import { operationsStore } from '../state/operationsStore.js';
import { SystemScreen } from './SystemScreen.js';

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

// Same stub `SystemScreen.telemetrySource.test.tsx` sets: `TileGrid` measures
// two boxes with `ResizeObserver` before it draws anything, and jsdom
// performs no layout of its own.
globalThis.ResizeObserver = class {
  constructor(private readonly report: (entries: readonly ResizeObserverEntry[]) => void) {}
  observe(target: Element): void {
    const floor = target.classList.contains('tile-grid__floor');
    target.getBoundingClientRect = () =>
      ({ height: floor ? 68 : 900, width: floor ? 0 : 1600 }) as DOMRect;
    this.report([{ target, contentRect: { height: 900, width: 1600 } } as ResizeObserverEntry]);
  }
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

describe('the storage contour and the network graph', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('reads the storage contour off the simulated world instead of six frozen literals', () => {
    const { container } = render(<SystemScreen />);

    const areaValues = [...container.querySelectorAll('.storage-map b')].map(
      (node) => node.textContent,
    );
    expect(areaValues).toHaveLength(6);
    // Deterministic, not a frozen `[48, 63, 82, 57, 74, 12]`: every area sits
    // near the tick's own `storage` reading rather than at its own constant.
    const storage = operationsStore.getState().metrics.storage;
    for (const value of areaValues) {
      const percent = Number(value?.replace('%', ''));
      expect(percent).toBeGreaterThanOrEqual(0);
      expect(percent).toBeLessThanOrEqual(100);
      expect(Math.abs(percent - storage)).toBeLessThanOrEqual(18);
    }
  });

  it('draws the outbound half of the network graph beside the inbound one', () => {
    const { container } = render(<SystemScreen />);

    const labels = [...container.querySelectorAll('.resource-charts span')].map(
      (node) => node.textContent,
    );
    const networkInLabel = translateWith('ru', 'system.networkInLabel');
    const networkOutLabel = translateWith('ru', 'system.networkOutLabel');
    expect(labels.some((label) => label?.includes(networkInLabel))).toBe(true);
    expect(labels.some((label) => label?.includes(networkOutLabel))).toBe(true);
  });
});

describe('the measured telemetry panel (R31)', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  afterEach(() => {
    setTelemetryMeasurementClient(null);
  });

  it('stays absent while no client is registered, exactly as the screen drew before it existed', () => {
    const { container } = render(<SystemScreen />);

    expect(container.querySelector('.system-measured-telemetry')).toBeNull();
  });

  it('appears once a client answers with real sources', async () => {
    setTelemetryMeasurementClient({
      listDataSources: async () => ({
        sources: [
          {
            sourceKey: 'cpu',
            name: 'CPU',
            kind: 1,
            unit: '%',
            simulated: true,
            warningThreshold: 0,
            criticalThreshold: 0,
            labels: {},
          },
        ],
        nextCursor: '',
        hasMore: false,
      }),
      getTelemetrySnapshot: async () => ({
        deviceId: 'device-a',
        sequence: 1,
        samples: [
          {
            sourceKey: 'cpu',
            value: 77,
            unit: '%',
            severity: 'critical',
            observedAt: '',
            labels: {},
          },
        ],
        capturedAt: '',
        simulated: true,
      }),
    });

    const { container } = render(<SystemScreen />);

    await waitFor(() =>
      expect(container.querySelector('.system-measured-telemetry')).not.toBeNull(),
    );
    expect(container.querySelector('.system-measured-telemetry')?.textContent).toContain('77%');
  });
});
