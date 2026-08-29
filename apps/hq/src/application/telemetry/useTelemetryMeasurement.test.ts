// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  TelemetryDataSourcePage,
  TelemetrySnapshot,
} from '@/infrastructure/controlPlane/TelemetryClient';

import type { TelemetryMeasurementClient } from './telemetryMeasurement';
import { setTelemetryMeasurementClient } from './telemetryMeasurementClient';
import { useTelemetryMeasurement } from './useTelemetryMeasurement';

const page: TelemetryDataSourcePage = {
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
};

function snapshotAt(sequence: number): TelemetrySnapshot {
  return {
    deviceId: 'device-a',
    sequence,
    samples: [
      {
        sourceKey: 'cpu',
        value: sequence,
        unit: '%',
        severity: 'normal',
        observedAt: '',
        labels: {},
      },
    ],
    capturedAt: '',
    simulated: true,
  };
}

afterEach(() => {
  setTelemetryMeasurementClient(null);
});

describe('useTelemetryMeasurement', () => {
  it('reads null while no client is registered, exactly today’s screen', () => {
    const { result } = renderHook(() => useTelemetryMeasurement(1_000));

    expect(result.current).toBeNull();
  });

  it('reads a measurement once a client is registered', async () => {
    let calls = 0;
    const client: TelemetryMeasurementClient = {
      listDataSources: async () => page,
      getTelemetrySnapshot: async () => snapshotAt((calls += 1)),
    };
    setTelemetryMeasurementClient(client);

    const { result } = renderHook(() => useTelemetryMeasurement(1_000));

    await waitFor(() => expect(result.current?.available).toBe(true));
    expect(calls).toBe(1);
  });

  it('picks up a client registered after the hook already mounted, on the next poll', async () => {
    const { result } = renderHook(() => useTelemetryMeasurement(10));

    expect(result.current).toBeNull();

    setTelemetryMeasurementClient({
      listDataSources: async () => page,
      getTelemetrySnapshot: async () => snapshotAt(1),
    });

    await waitFor(() => expect(result.current?.available).toBe(true), { timeout: 2_000 });
  });

  it('stops polling once unmounted', async () => {
    let calls = 0;
    setTelemetryMeasurementClient({
      listDataSources: async () => page,
      getTelemetrySnapshot: async () => {
        calls += 1;
        return snapshotAt(calls);
      },
    });

    const { result, unmount } = renderHook(() => useTelemetryMeasurement(10));
    await waitFor(() => expect(result.current?.available).toBe(true));
    const callsAtUnmount = calls;
    unmount();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toBe(callsAtUnmount);
  });
});
