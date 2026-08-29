import { isControlPlaneError } from '@/application/sync/controlPlanePort';
import type {
  TelemetryDataSource,
  TelemetryDataSourcePage,
  TelemetrySnapshot,
} from '@/infrastructure/controlPlane/TelemetryClient';

/**
 * Reads `TelemetryService`'s measurement half — `ListDataSources` and
 * `GetTelemetrySnapshot` joined by source key — into the shape
 * `SystemScreen`'s measured panel draws, and turns every way that half can be
 * absent into a typed reason instead of a thrown error.
 *
 * Absence is not one fact. A deployment built without a measurement store
 * (predating migration 0011) answers both RPCs `unimplemented`
 * (`apps/control-plane/src/telemetry/routes.ts`, `telemetry.measurement`);
 * a deployment that has one but whose group published no simulation profile
 * answers `FAILED_PRECONDITION` (`telemetry/service.ts`, `captureOrRead`) —
 * the registry exists and holds nothing. The panel tells the two apart
 * because the second is fixed by publishing a profile and the first is not
 * fixed by this client at all.
 */

/** The port `readTelemetryMeasurement` needs; `TelemetryClient` satisfies it. */
export interface TelemetryMeasurementClient {
  listDataSources(
    cursor?: string,
    pageSize?: number,
    signal?: AbortSignal,
  ): Promise<TelemetryDataSourcePage>;
  getTelemetrySnapshot(
    sourceKeys?: readonly string[],
    signal?: AbortSignal,
  ): Promise<TelemetrySnapshot>;
}

export interface MeasuredDataSource {
  readonly sourceKey: string;
  readonly name: string;
  readonly unit: string;
  /** `undefined` when the group declares the source but no sample named it. */
  readonly value: number | undefined;
  readonly severity: 'normal' | 'elevated' | 'degraded' | 'critical' | 'unspecified';
  readonly simulated: boolean;
}

export interface TelemetryMeasurementReading {
  readonly available: true;
  readonly capturedAt: string;
  readonly sources: readonly MeasuredDataSource[];
}

export type TelemetryMeasurementUnavailableReason = 'not-built' | 'no-sources' | 'error';

export interface TelemetryMeasurementUnavailable {
  readonly available: false;
  readonly reason: TelemetryMeasurementUnavailableReason;
  readonly notice: string;
}

export type TelemetryMeasurement = TelemetryMeasurementReading | TelemetryMeasurementUnavailable;

export async function readTelemetryMeasurement(
  client: TelemetryMeasurementClient,
  signal?: AbortSignal,
): Promise<TelemetryMeasurement> {
  try {
    const [page, snapshot] = await Promise.all([
      client.listDataSources(undefined, undefined, signal),
      client.getTelemetrySnapshot(undefined, signal),
    ]);
    return {
      available: true,
      capturedAt: snapshot.capturedAt,
      sources: toReadings(page, snapshot),
    };
  } catch (error: unknown) {
    return toUnavailable(error);
  }
}

function toReadings(
  page: TelemetryDataSourcePage,
  snapshot: TelemetrySnapshot,
): readonly MeasuredDataSource[] {
  const samplesByKey = new Map(snapshot.samples.map((sample) => [sample.sourceKey, sample]));
  return page.sources.map((source) => toReading(source, samplesByKey.get(source.sourceKey)));
}

function toReading(
  source: TelemetryDataSource,
  sample: TelemetrySnapshot['samples'][number] | undefined,
): MeasuredDataSource {
  return {
    sourceKey: source.sourceKey,
    name: source.name,
    unit: source.unit.length > 0 ? source.unit : (sample?.unit ?? ''),
    value: sample?.value,
    severity: sample?.severity ?? 'unspecified',
    simulated: source.simulated,
  };
}

function toUnavailable(error: unknown): TelemetryMeasurementUnavailable {
  if (isControlPlaneError(error, 'unimplemented')) {
    return {
      available: false,
      reason: 'not-built',
      notice:
        'ИЗМЕРЕННАЯ ТЕЛЕМЕТРИЯ НЕ ПОСТРОЕНА НА ЭТОМ CONTROL PLANE: СХЕМА ПРЕДШЕСТВУЕТ МИГРАЦИИ 0011.',
    };
  }
  if (isControlPlaneError(error, 'failed-precondition')) {
    return {
      available: false,
      reason: 'no-sources',
      notice: 'ГРУППА НЕ ОБЪЯВИЛА ИСТОЧНИКОВ ТЕЛЕМЕТРИИ: ОПУБЛИКУЙТЕ ПРОФИЛЬ СИМУЛЯЦИИ.',
    };
  }
  return {
    available: false,
    reason: 'error',
    notice:
      error instanceof Error
        ? `ИЗМЕРЕННАЯ ТЕЛЕМЕТРИЯ НЕДОСТУПНА: ${error.message}`
        : 'ИЗМЕРЕННАЯ ТЕЛЕМЕТРИЯ НЕДОСТУПНА.',
  };
}
