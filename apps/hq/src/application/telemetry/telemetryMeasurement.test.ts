import { describe, expect, it } from 'vitest';

import { ControlPlaneError } from '@/application/sync/controlPlanePort';
import type {
  TelemetryDataSourcePage,
  TelemetrySnapshot,
} from '@/infrastructure/controlPlane/TelemetryClient';

import { readTelemetryMeasurement, type TelemetryMeasurementClient } from './telemetryMeasurement';

function client(overrides: Partial<TelemetryMeasurementClient> = {}): TelemetryMeasurementClient {
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
      {
        sourceKey: 'storage',
        name: 'STORAGE',
        kind: 3,
        unit: '',
        simulated: true,
        warningThreshold: 0,
        criticalThreshold: 0,
        labels: {},
      },
    ],
    nextCursor: '',
    hasMore: false,
  };
  const snapshot: TelemetrySnapshot = {
    deviceId: 'device-a',
    sequence: 9,
    samples: [
      {
        sourceKey: 'cpu',
        value: 61,
        unit: '%',
        severity: 'degraded',
        observedAt: '2026-08-29T00:00:00.000Z',
        labels: {},
      },
    ],
    capturedAt: '2026-08-29T00:00:01.000Z',
    simulated: true,
  };
  return {
    listDataSources: async () => page,
    getTelemetrySnapshot: async () => snapshot,
    ...overrides,
  };
}

describe('readTelemetryMeasurement', () => {
  it('joins a declared source to its sample by source key', async () => {
    const reading = await readTelemetryMeasurement(client());

    expect(reading.available).toBe(true);
    if (!reading.available) throw new Error('expected an available reading');
    expect(reading.capturedAt).toBe('2026-08-29T00:00:01.000Z');
    expect(reading.sources).toEqual([
      {
        sourceKey: 'cpu',
        name: 'CPU',
        unit: '%',
        value: 61,
        severity: 'degraded',
        simulated: true,
      },
      {
        sourceKey: 'storage',
        name: 'STORAGE',
        unit: '',
        value: undefined,
        severity: 'unspecified',
        simulated: true,
      },
    ]);
  });

  it('reports a source with no sample as measured but unread, not as zero', async () => {
    const reading = await readTelemetryMeasurement(client());

    if (!reading.available) throw new Error('expected an available reading');
    expect(reading.sources.find((source) => source.sourceKey === 'storage')?.value).toBeUndefined();
  });

  it('names a deployment with no measurement store, not a generic failure', async () => {
    const reading = await readTelemetryMeasurement(
      client({
        listDataSources: () => {
          throw new ControlPlaneError('unimplemented', 'listDataSources is not implemented');
        },
      }),
    );

    expect(reading).toEqual({
      available: false,
      reason: 'not-built',
      notice:
        'ИЗМЕРЕННАЯ ТЕЛЕМЕТРИЯ НЕ ПОСТРОЕНА НА ЭТОМ CONTROL PLANE: СХЕМА ПРЕДШЕСТВУЕТ МИГРАЦИИ 0011.',
    });
  });

  it('names a group with no published sources, not the same reason as an unbuilt deployment', async () => {
    const reading = await readTelemetryMeasurement(
      client({
        getTelemetrySnapshot: () => {
          throw new ControlPlaneError(
            'failed-precondition',
            'The group declares no telemetry data sources.',
          );
        },
      }),
    );

    expect(reading.available).toBe(false);
    if (reading.available) throw new Error('expected an unavailable reading');
    expect(reading.reason).toBe('no-sources');
  });

  it('falls back to a generic notice for any other failure', async () => {
    const reading = await readTelemetryMeasurement(
      client({
        listDataSources: () => {
          throw new ControlPlaneError('unavailable', 'Control plane unreachable.');
        },
      }),
    );

    expect(reading.available).toBe(false);
    if (reading.available) throw new Error('expected an unavailable reading');
    expect(reading.reason).toBe('error');
    expect(reading.notice).toContain('Control plane unreachable.');
  });
});
