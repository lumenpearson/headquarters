import { createClient, type Transport } from '@connectrpc/connect';
import { TelemetryService } from '@gremuchaya/protocol';
import type { CurveInterpolationKind, TelemetrySeverityKind } from '@gremuchaya/domain';

import { ControlPlaneError } from '@/application/sync/controlPlanePort';
import { toControlPlaneError } from '@/infrastructure/controlPlane/ControlPlaneClient';

/*
 * Wire shapes declared structurally, in the idiom `GroupSettingsClient` and
 * `ControlPlaneMaterialClient` set: the generated client is assignable to
 * these and so is a hand-written fake in a test. Only the fields this facade
 * reads or writes are named.
 */
interface WireTimestamp {
  readonly seconds: bigint;
  readonly nanos: number;
}

interface WireResourceId {
  readonly value: string;
}

interface WireRevision {
  readonly number: bigint;
  readonly etag: string;
}

interface WireMutationContext {
  readonly requestId: string;
  readonly actorDeviceId?: WireResourceId;
}

interface WirePage {
  readonly pageSize: number;
  readonly cursor: string;
}

interface WirePageInfo {
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

interface WireOperationResult {
  readonly resourceId?: WireResourceId | undefined;
}

interface WireDataSource {
  readonly id?: WireResourceId | undefined;
  readonly name: string;
  /** The protocol's `DataSourceKind` enum, read structurally as a number. */
  readonly kind: number;
  readonly unit: string;
  readonly simulated: boolean;
  readonly warningThreshold: number;
  readonly criticalThreshold: number;
  readonly labels: Readonly<Record<string, string>>;
}

interface WireTelemetrySample {
  readonly sourceId?: WireResourceId | undefined;
  readonly value: number;
  readonly unit: string;
  /** The protocol's `TelemetrySeverity` enum, read structurally as a number. */
  readonly severity: number;
  readonly observedAt?: WireTimestamp | undefined;
  readonly labels: Readonly<Record<string, string>>;
}

interface WireTelemetrySnapshot {
  readonly deviceId?: WireResourceId | undefined;
  readonly sequence: bigint;
  readonly samples: readonly WireTelemetrySample[];
  readonly capturedAt?: WireTimestamp | undefined;
  readonly simulated: boolean;
}

interface WireCurvePoint {
  readonly time: number;
  readonly value: number;
  readonly inTangent: number;
  readonly outTangent: number;
}

interface WireSimulationCurve {
  readonly points: readonly WireCurvePoint[];
  /** The protocol's `CurveInterpolation` enum, read structurally as a number. */
  readonly interpolation: number;
  readonly loop: boolean;
}

interface WireSimulationChannel {
  readonly sourceId?: WireResourceId | undefined;
  readonly minimum: number;
  readonly maximum: number;
  readonly valueCurve?: WireSimulationCurve | undefined;
  readonly criticalityCurve?: WireSimulationCurve | undefined;
  readonly noise: number;
  readonly smoothing: number;
  readonly seed: bigint;
}

interface WireSimulationProfile {
  readonly id?: WireResourceId | undefined;
  readonly groupId?: WireResourceId | undefined;
  readonly name: string;
  /** The protocol's `SimulationPresetKind` enum, read structurally as a number. */
  readonly presetKind: number;
  readonly channels: readonly WireSimulationChannel[];
  readonly periodSeconds: number;
  readonly updateIntervalMs: number;
  readonly timeScale: number;
  readonly revision?: WireRevision | undefined;
  readonly updatedAt?: WireTimestamp | undefined;
}

interface CallOptions {
  readonly signal?: AbortSignal;
}

export interface TelemetryRpcClient {
  listDataSources(
    request: { readonly deviceId?: WireResourceId; readonly page: WirePage },
    options?: CallOptions,
  ): Promise<{ readonly sources: readonly WireDataSource[]; readonly page?: WirePageInfo }>;
  getTelemetrySnapshot(
    request: { readonly deviceId?: WireResourceId; readonly sourceIds: readonly WireResourceId[] },
    options?: CallOptions,
  ): Promise<{ readonly snapshot?: WireTelemetrySnapshot | undefined }>;
  streamTelemetry(
    request: {
      readonly deviceId?: WireResourceId;
      readonly sourceIds: readonly WireResourceId[];
      readonly intervalMs: number;
      readonly afterSequence: bigint;
    },
    options?: CallOptions,
  ): AsyncIterable<{ readonly snapshot?: WireTelemetrySnapshot | undefined }>;
  listSimulationProfiles(
    request: { readonly groupId: WireResourceId; readonly page: WirePage },
    options?: CallOptions,
  ): Promise<{ readonly profiles: readonly WireSimulationProfile[]; readonly page?: WirePageInfo }>;
  createSimulationProfile(
    request: { readonly context: WireMutationContext; readonly profile: WireSimulationProfile },
    options?: CallOptions,
  ): Promise<{ readonly profile?: WireSimulationProfile | undefined }>;
  updateSimulationProfile(
    request: { readonly context: WireMutationContext; readonly profile: WireSimulationProfile },
    options?: CallOptions,
  ): Promise<{ readonly profile?: WireSimulationProfile | undefined }>;
  deleteSimulationProfile(
    request: { readonly context: WireMutationContext; readonly profileId: WireResourceId },
    options?: CallOptions,
  ): Promise<{ readonly result?: WireOperationResult | undefined }>;
  applySimulationPreset(
    request: {
      readonly context: WireMutationContext;
      readonly groupId: WireResourceId;
      readonly preset: number;
    },
    options?: CallOptions,
  ): Promise<{ readonly profile?: WireSimulationProfile | undefined }>;
  setSimulationClock(
    request: {
      readonly context: WireMutationContext;
      readonly profileId: WireResourceId;
      readonly running: boolean;
      readonly timeScale: number;
      readonly phase: number;
    },
    options?: CallOptions,
  ): Promise<{ readonly profile?: WireSimulationProfile | undefined }>;
  previewSimulationProfile(
    request: { readonly profile: WireSimulationProfile; readonly sampleCount: number },
    options?: CallOptions,
  ): Promise<{ readonly snapshots: readonly WireTelemetrySnapshot[] }>;
}

/** `apps/hq`'s reading of `gremuchaya.telemetry.v1.DataSource`. */
export interface TelemetryDataSource {
  readonly sourceKey: string;
  readonly name: string;
  readonly kind: number;
  readonly unit: string;
  readonly simulated: boolean;
  readonly warningThreshold: number;
  readonly criticalThreshold: number;
  readonly labels: Readonly<Record<string, string>>;
}

export interface TelemetryDataSourcePage {
  readonly sources: readonly TelemetryDataSource[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

/** `apps/hq`'s reading of `gremuchaya.telemetry.v1.TelemetrySample`. */
export interface TelemetrySample {
  readonly sourceKey: string;
  readonly value: number;
  readonly unit: string;
  readonly severity: TelemetrySeverityKind | 'unspecified';
  readonly observedAt: string;
  readonly labels: Readonly<Record<string, string>>;
}

/** `apps/hq`'s reading of `gremuchaya.telemetry.v1.TelemetrySnapshot`. */
export interface TelemetrySnapshot {
  readonly deviceId: string;
  readonly sequence: number;
  readonly samples: readonly TelemetrySample[];
  readonly capturedAt: string;
  readonly simulated: boolean;
}

/** `apps/hq`'s reading of `gremuchaya.telemetry.v1.SimulationChannel`. */
export interface TelemetryChannel {
  readonly sourceKey: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly valueCurve?: SimulationCurveInput | undefined;
  readonly criticalityCurve?: SimulationCurveInput | undefined;
  readonly noise: number;
  readonly smoothing: number;
  readonly seed: number;
}

export interface SimulationCurveInput {
  readonly points: readonly {
    readonly time: number;
    readonly value: number;
    readonly inTangent: number;
    readonly outTangent: number;
  }[];
  readonly interpolation: CurveInterpolationKind;
  readonly loop: boolean;
}

/** `apps/hq`'s reading of `gremuchaya.telemetry.v1.SimulationProfile`. */
export interface TelemetryProfile {
  readonly id: string;
  readonly groupId: string;
  readonly name: string;
  readonly presetKind: string;
  readonly channels: readonly TelemetryChannel[];
  readonly periodSeconds: number;
  readonly updateIntervalMs: number;
  readonly timeScale: number;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface TelemetryProfileInput {
  readonly id?: string;
  readonly groupId?: string;
  readonly name: string;
  readonly presetKind: string;
  readonly channels: readonly TelemetryChannel[];
  readonly periodSeconds: number;
  readonly updateIntervalMs: number;
  readonly timeScale: number;
}

export interface TelemetryProfilePage {
  readonly profiles: readonly TelemetryProfile[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

export interface TelemetryClientOptions {
  readonly groupId: string;
  readonly deviceId: string;
  /** The shared authenticated transport; unused when `client` is injected. */
  readonly transport?: Transport;
  readonly client?: TelemetryRpcClient;
  readonly mintRequestId?: () => string;
}

/**
 * Browser-facing adapter for `TelemetryService` (R31).
 *
 * The measurement half — `listDataSources`, `getTelemetrySnapshot`,
 * `streamTelemetry` — reads the group's registry and sample store, built only
 * when `apps/control-plane`'s own `createTelemetryService` was given a
 * measurement store (migration 0011); a deployment that predates it answers
 * `unimplemented`, which `toControlPlaneError` turns into
 * `ControlPlaneError('unimplemented', …)` rather than a thrown Connect code.
 * The consuming surface is expected to treat that the same way `telemetry
 * .source === 'native'` already degrades on this build: a notice in place of
 * numbers, never a substituted reading passed off as measured.
 *
 * The simulation half — the profile CRUD, the presets, the clock and the
 * preview — is the same contract `apps/control-plane/src/telemetry/service.ts`
 * always builds. Both halves are exposed here because a profile a device
 * publishes is what makes the measurement half have anything to read: an
 * empty registry is not a bug in this client, it is a group with no published
 * channels.
 */
export class TelemetryClient {
  readonly #client: TelemetryRpcClient;
  readonly #groupId: string;
  readonly #deviceId: string;
  readonly #mintRequestId: () => string;

  constructor(options: TelemetryClientOptions) {
    this.#groupId = options.groupId;
    this.#deviceId = options.deviceId;
    this.#mintRequestId = options.mintRequestId ?? (() => crypto.randomUUID());
    if (options.client !== undefined) {
      this.#client = options.client;
    } else if (options.transport !== undefined) {
      this.#client = createClient(TelemetryService, options.transport) as TelemetryRpcClient;
    } else {
      throw new Error('TelemetryClient needs a transport or an injected client.');
    }
  }

  async listDataSources(
    cursor = '',
    pageSize = 50,
    signal?: AbortSignal,
  ): Promise<TelemetryDataSourcePage> {
    const response = await call(() =>
      this.#client.listDataSources(
        { deviceId: { value: this.#deviceId }, page: { pageSize, cursor } },
        options(signal),
      ),
    );
    return {
      sources: response.sources.map(toDataSource),
      nextCursor: response.page?.nextCursor ?? '',
      hasMore: response.page?.hasMore ?? false,
    };
  }

  /**
   * One reading of every named source, or of the whole group when
   * `sourceKeys` is empty — the proto3 default `GetTelemetrySnapshot` reads
   * as "all of them" (`apps/control-plane/src/telemetry/service.ts`,
   * `requireSourceKeys`).
   */
  async getTelemetrySnapshot(
    sourceKeys: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<TelemetrySnapshot> {
    const response = await call(() =>
      this.#client.getTelemetrySnapshot(
        {
          deviceId: { value: this.#deviceId },
          sourceIds: sourceKeys.map((value) => ({ value })),
        },
        options(signal),
      ),
    );
    return toSnapshot(required(response.snapshot, 'Control plane returned no telemetry snapshot.'));
  }

  /**
   * Follows the group's snapshots, newest sequence first taken as the resume
   * point for the next call. `intervalMs` of `0` asks the server for its own
   * capture cadence rather than naming one, the same proto3-default rule
   * `getTelemetrySnapshot`'s empty `sourceIds` follows.
   */
  async *streamTelemetry(
    afterSequence = 0,
    sourceKeys: readonly string[] = [],
    intervalMs = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<TelemetrySnapshot> {
    try {
      for await (const response of this.#client.streamTelemetry(
        {
          deviceId: { value: this.#deviceId },
          sourceIds: sourceKeys.map((value) => ({ value })),
          intervalMs,
          afterSequence: BigInt(Math.max(0, Math.trunc(afterSequence))),
        },
        options(signal),
      )) {
        if (response.snapshot === undefined) continue;
        yield toSnapshot(response.snapshot);
      }
    } catch (error: unknown) {
      throw toControlPlaneError(error);
    }
  }

  async listSimulationProfiles(
    cursor = '',
    pageSize = 50,
    signal?: AbortSignal,
  ): Promise<TelemetryProfilePage> {
    const response = await call(() =>
      this.#client.listSimulationProfiles(
        { groupId: { value: this.#groupId }, page: { pageSize, cursor } },
        options(signal),
      ),
    );
    return {
      profiles: response.profiles.map(toProfile),
      nextCursor: response.page?.nextCursor ?? '',
      hasMore: response.page?.hasMore ?? false,
    };
  }

  async createSimulationProfile(
    profile: TelemetryProfileInput,
    signal?: AbortSignal,
  ): Promise<TelemetryProfile> {
    const response = await call(() =>
      this.#client.createSimulationProfile(
        { context: this.#mutation(), profile: toWireProfile(profile, this.#groupId) },
        options(signal),
      ),
    );
    return toProfile(
      required(response.profile, 'Control plane created a profile without returning one.'),
    );
  }

  async updateSimulationProfile(
    profile: TelemetryProfileInput,
    signal?: AbortSignal,
  ): Promise<TelemetryProfile> {
    const response = await call(() =>
      this.#client.updateSimulationProfile(
        { context: this.#mutation(), profile: toWireProfile(profile, this.#groupId) },
        options(signal),
      ),
    );
    return toProfile(
      required(response.profile, 'Control plane updated a profile without returning one.'),
    );
  }

  async deleteSimulationProfile(profileId: string, signal?: AbortSignal): Promise<string> {
    const response = await call(() =>
      this.#client.deleteSimulationProfile(
        { context: this.#mutation(), profileId: { value: profileId } },
        options(signal),
      ),
    );
    return response.result?.resourceId?.value ?? profileId;
  }

  async applySimulationPreset(
    preset: TelemetryPresetName,
    signal?: AbortSignal,
  ): Promise<TelemetryProfile> {
    const response = await call(() =>
      this.#client.applySimulationPreset(
        {
          context: this.#mutation(),
          groupId: { value: this.#groupId },
          preset: presetKindOf(preset),
        },
        options(signal),
      ),
    );
    return toProfile(
      required(response.profile, 'Control plane applied a preset without returning a profile.'),
    );
  }

  async setSimulationClock(
    profileId: string,
    clock: { readonly running: boolean; readonly timeScale: number; readonly phase: number },
    signal?: AbortSignal,
  ): Promise<TelemetryProfile> {
    const response = await call(() =>
      this.#client.setSimulationClock(
        {
          context: this.#mutation(),
          profileId: { value: profileId },
          running: clock.running,
          timeScale: clock.timeScale,
          phase: clock.phase,
        },
        options(signal),
      ),
    );
    return toProfile(
      required(response.profile, 'Control plane re-timed a profile without returning one.'),
    );
  }

  async previewSimulationProfile(
    profile: TelemetryProfileInput,
    sampleCount = 0,
    signal?: AbortSignal,
  ): Promise<readonly TelemetrySnapshot[]> {
    const response = await call(() =>
      this.#client.previewSimulationProfile(
        { profile: toWireProfile(profile, this.#groupId), sampleCount },
        options(signal),
      ),
    );
    return response.snapshots.map(toSnapshot);
  }

  #mutation(): WireMutationContext {
    return { requestId: this.#mintRequestId(), actorDeviceId: { value: this.#deviceId } };
  }
}

export type TelemetryPresetName =
  | 'normal'
  | 'elevated'
  | 'degraded'
  | 'critical'
  | 'incident'
  | 'recovery'
  | 'network-attack'
  | 'storage-exhaustion'
  | 'cpu-overload';

/**
 * `SimulationPresetKind`'s wire numbers, named rather than imported from the
 * generated enum: `TelemetryRpcClient` is declared structurally so a fake
 * never has to import the generated message classes, and a numeric literal
 * here is what keeps that true for the one field that is an enum by value
 * rather than by shape.
 */
const presetKinds: Readonly<Record<TelemetryPresetName, number>> = {
  normal: 1,
  elevated: 2,
  degraded: 3,
  critical: 4,
  incident: 5,
  recovery: 6,
  'network-attack': 7,
  'storage-exhaustion': 8,
  'cpu-overload': 9,
};

function presetKindOf(preset: TelemetryPresetName): number {
  return presetKinds[preset];
}

const presetKindNames: Readonly<Record<number, string>> = {
  0: 'UNSPECIFIED',
  1: 'NORMAL',
  2: 'ELEVATED',
  3: 'DEGRADED',
  4: 'CRITICAL',
  5: 'INCIDENT',
  6: 'RECOVERY',
  7: 'NETWORK_ATTACK',
  8: 'STORAGE_EXHAUSTION',
  9: 'CPU_OVERLOAD',
  10: 'CUSTOM',
};

const presetKindNumbers: Readonly<Record<string, number>> = {
  UNSPECIFIED: 0,
  NORMAL: 1,
  ELEVATED: 2,
  DEGRADED: 3,
  CRITICAL: 4,
  INCIDENT: 5,
  RECOVERY: 6,
  NETWORK_ATTACK: 7,
  STORAGE_EXHAUSTION: 8,
  CPU_OVERLOAD: 9,
  CUSTOM: 10,
};

const severityNames: Readonly<Record<number, TelemetrySeverityKind | 'unspecified'>> = {
  0: 'unspecified',
  1: 'normal',
  2: 'elevated',
  3: 'degraded',
  4: 'critical',
};

const interpolationNames: Readonly<Record<number, CurveInterpolationKind>> = {
  0: 'linear',
  1: 'linear',
  2: 'bezier',
  3: 'hermite',
  4: 'step',
};

const interpolationNumbers: Readonly<Record<CurveInterpolationKind, number>> = {
  linear: 1,
  bezier: 2,
  hermite: 3,
  step: 4,
};

function toDataSource(source: WireDataSource): TelemetryDataSource {
  return {
    sourceKey: source.id?.value ?? '',
    name: source.name,
    kind: source.kind,
    unit: source.unit,
    simulated: source.simulated,
    warningThreshold: source.warningThreshold,
    criticalThreshold: source.criticalThreshold,
    labels: { ...source.labels },
  };
}

function toSample(sample: WireTelemetrySample): TelemetrySample {
  return {
    sourceKey: sample.sourceId?.value ?? '',
    value: sample.value,
    unit: sample.unit,
    severity: severityNames[sample.severity] ?? 'unspecified',
    observedAt: toIsoInstant(sample.observedAt),
    labels: { ...sample.labels },
  };
}

function toSnapshot(snapshot: WireTelemetrySnapshot): TelemetrySnapshot {
  return {
    deviceId: snapshot.deviceId?.value ?? '',
    sequence: toSafeInteger(snapshot.sequence, 'telemetry snapshot sequence'),
    samples: snapshot.samples.map(toSample),
    capturedAt: toIsoInstant(snapshot.capturedAt),
    simulated: snapshot.simulated,
  };
}

function toCurve(curve: WireSimulationCurve | undefined): SimulationCurveInput | undefined {
  if (curve === undefined) return undefined;
  return {
    points: curve.points.map((point) => ({
      time: point.time,
      value: point.value,
      inTangent: point.inTangent,
      outTangent: point.outTangent,
    })),
    interpolation: interpolationNames[curve.interpolation] ?? 'linear',
    loop: curve.loop,
  };
}

function toWireCurve(curve: SimulationCurveInput | undefined): WireSimulationCurve | undefined {
  if (curve === undefined) return undefined;
  return {
    points: curve.points.map((point) => ({ ...point })),
    interpolation: interpolationNumbers[curve.interpolation],
    loop: curve.loop,
  };
}

function toChannel(channel: WireSimulationChannel): TelemetryChannel {
  return {
    sourceKey: channel.sourceId?.value ?? '',
    minimum: channel.minimum,
    maximum: channel.maximum,
    ...(toCurve(channel.valueCurve) === undefined
      ? {}
      : { valueCurve: toCurve(channel.valueCurve) }),
    ...(toCurve(channel.criticalityCurve) === undefined
      ? {}
      : { criticalityCurve: toCurve(channel.criticalityCurve) }),
    noise: channel.noise,
    smoothing: channel.smoothing,
    seed: toSafeInteger(channel.seed, 'simulation channel seed'),
  };
}

function toWireChannel(channel: TelemetryChannel): WireSimulationChannel {
  return {
    sourceId: { value: channel.sourceKey },
    minimum: channel.minimum,
    maximum: channel.maximum,
    valueCurve: toWireCurve(channel.valueCurve),
    criticalityCurve: toWireCurve(channel.criticalityCurve),
    noise: channel.noise,
    smoothing: channel.smoothing,
    seed: BigInt(Math.max(0, Math.trunc(channel.seed))),
  };
}

function toProfile(profile: WireSimulationProfile): TelemetryProfile {
  return {
    id: profile.id?.value ?? '',
    groupId: profile.groupId?.value ?? '',
    name: profile.name,
    presetKind: presetKindNames[profile.presetKind] ?? 'UNSPECIFIED',
    channels: profile.channels.map(toChannel),
    periodSeconds: profile.periodSeconds,
    updateIntervalMs: profile.updateIntervalMs,
    timeScale: profile.timeScale,
    revision: Number(profile.revision?.number ?? 0n),
    updatedAt: toIsoInstant(profile.updatedAt),
  };
}

function toWireProfile(profile: TelemetryProfileInput, groupId: string): WireSimulationProfile {
  return {
    ...(profile.id === undefined ? {} : { id: { value: profile.id } }),
    groupId: { value: profile.groupId ?? groupId },
    name: profile.name,
    presetKind: presetKindNumbers[profile.presetKind] ?? 0,
    channels: profile.channels.map(toWireChannel),
    periodSeconds: profile.periodSeconds,
    updateIntervalMs: profile.updateIntervalMs,
    timeScale: profile.timeScale,
  };
}

async function call<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation();
  } catch (error: unknown) {
    throw toControlPlaneError(error);
  }
}

function options(signal: AbortSignal | undefined): CallOptions {
  return signal === undefined ? {} : { signal };
}

function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new ControlPlaneError('unknown', message);
  return value;
}

function toSafeInteger(value: bigint, name: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new ControlPlaneError(
      'unknown',
      `Control plane returned a ${name} outside the safe browser range.`,
    );
  }
  return numeric;
}

function toIsoInstant(timestamp: WireTimestamp | undefined): string {
  if (timestamp === undefined) return '';
  const epochMs = Number(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1_000_000);
  return epochMs === 0 ? '' : new Date(epochMs).toISOString();
}
