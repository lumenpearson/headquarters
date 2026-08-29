import { randomUUID } from 'node:crypto';

import { create, fromJson, toJson, type JsonValue } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from '@connectrpc/connect';
import {
  channelSeverity,
  channelValue,
  curvePhaseAt,
  type CurveInterpolationKind,
  type SimulationChannelLike,
  type SimulationCurveLike,
  type TelemetrySeverityKind,
} from '@gremuchaya/domain';
import { ResourceIdSchema, RevisionSchema, telemetryV1 } from '@gremuchaya/protocol';
import type { TelemetryService } from '@gremuchaya/protocol';

import type { Awaitable, PairedDeviceLifecycle } from '../sync/lifecycle.js';
import {
  MutationRequestIdError,
  normalizeRequestId,
  type MutationReceiptContext,
} from '../sync/receipts.js';
import { isRecord } from '../sync/rows.js';
import { PairedDeviceRuntimeError, type AuthenticatedDevice } from '../sync/runtime.js';

import type {
  DurableTelemetryMeasurementStore,
  TelemetryCaptureSource,
  TelemetrySampleRecord,
  TelemetrySnapshotRecord,
  TelemetrySourceRecord,
} from './measurement-store.js';
import { declaredSources, toDataSourceKind } from './sources.js';
import type { TelemetrySourceDeclaration } from './sources.js';
import type { DurableSimulationProfileStore, SimulationProfileRecord } from './store.js';

/**
 * ConnectRPC adapter for `TelemetryService`.
 *
 * Both halves of the contract are here now. The simulation half lists, creates,
 * updates, deletes, presets, re-times and previews a group's profiles. The
 * measurement half — `ListDataSources`, `GetTelemetrySnapshot` and
 * `StreamTelemetry` — reads the registry and the sample store that migration
 * 0011 declares, and it is wired to the same profiles rather than to a second
 * source of truth: a data source exists because a published `SimulationChannel`
 * names it, and a reading is that channel evaluated by the arithmetic the
 * preview and the client's own simulation already share.
 *
 * That is what makes the two halves one contract instead of two. An operator
 * shapes a curve, sees it in `PreviewSimulationProfile`, publishes it, and the
 * measured stream every screen of the group reads is that same curve at the
 * same phase. A second implementation of the reading would agree with the
 * preview until the day one of them was edited.
 *
 * The three measurement methods are still built only when a measurement store
 * was supplied. Without one they stay out of the returned object, ConnectRPC
 * answers `unimplemented`, and `GetCapabilities` reports
 * `telemetry.measurement` off — an answer a client can act on, where an empty
 * success would have told it a shoot is healthy when nothing was measured.
 */

export interface TelemetryServiceOptions {
  /** Supplies `authenticateAccessToken`; the same lifecycle the sync service uses. */
  readonly runtime: PairedDeviceLifecycle;
  readonly profiles: DurableSimulationProfileStore;
  /**
   * The registry and sample store behind the measurement half. Absent in a
   * deployment whose schema predates migration 0011, and in the deterministic
   * tests that exercise the simulation half alone.
   */
  readonly measurements?: DurableTelemetryMeasurementStore;
  readonly now?: () => Date;
}

/**
 * How many samples a preview returns when the request names no count, and the
 * ceiling it will not exceed. The ceiling is a refusal rather than a silent
 * truncation: a caller that asked for an hour of samples and received a minute
 * of them would draw a graph that is wrong without looking wrong.
 */
const defaultPreviewSampleCount = 60;
const maxPreviewSampleCount = 512;
const defaultUpdateIntervalMs = 1_000;
const defaultPeriodSeconds = 60;
const maxProfileNameLength = 120;
/** The names `ApplySimulationPreset` owns; an operator profile may not take one. */
const reservedProfileNamePrefix = 'preset:';
const maxChannelsPerProfile = 64;
const maxCurvePoints = 512;
const maxPeriodSeconds = 86_400;
const maxUpdateIntervalMs = 3_600_000;
const maxTimeScale = 1_000;
/** The uuid shape the device columns hold; a malformed one is refused before SQL casts it. */
const deviceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/**
 * The bounds a measured stream runs between.
 *
 * The floor is a bound on how often one client can make this process evaluate a
 * group's curves and write a row; the ceiling keeps a stream that names an
 * absurd interval from looking indistinguishable from a stalled one. Both are
 * refusals rather than clamps, for the reason `normalizePageSize` gives: a
 * caller served a cadence it did not ask for cannot tell that from a quiet
 * shoot.
 */
const minStreamIntervalMs = 200;
const maxStreamIntervalMs = 60_000;
/**
 * How many stored snapshots one read of the stream drains. A client resuming
 * from an old sequence has a backlog, and reading it whole in one statement
 * would build a response out of every row the retention window holds.
 */
const maxStreamBatch = 64;
/** How many sources one request may name; a filter is a selection, not a payload. */
const maxRequestedSources = 256;

export function createTelemetryService(
  options: TelemetryServiceOptions,
): Partial<ServiceImpl<typeof TelemetryService>> {
  const now = options.now ?? ((): Date => new Date());
  const measurements = options.measurements;

  return {
    ...(measurements === undefined
      ? {}
      : createMeasurementMethods({ ...options, measurements }, now)),

    async listSimulationProfiles(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options, context);
        const groupId = requireResourceId(request.groupId?.value, 'group_id');
        assertAuthenticatedGroup(authenticated, groupId);
        const page = await options.profiles.list({
          groupId,
          deviceId: authenticated.device.id,
          pageSize: request.page?.pageSize ?? 0,
          cursor: request.page?.cursor ?? '',
        });
        return {
          profiles: page.items.map(toProfileMessage),
          page: {
            nextCursor: page.nextCursor,
            previousCursor: page.previousCursor,
            hasMore: page.hasMore,
            approximateTotal: page.approximateTotal,
          },
        };
      });
    },

    async createSimulationProfile(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const profile = requireProfile(request.profile);
        const groupId = requireResourceId(
          profile.groupId?.value ?? authenticated.group.id,
          'profile.group_id',
        );
        assertAuthenticatedGroup(authenticated, groupId);
        const authored = readAuthoredProfile(profile, groupId);
        const written = await options.profiles.create({
          groupId,
          deviceId: authenticated.device.id,
          sources: authored.sources,
          // The identifier is allocated here rather than by the database so a
          // retry of this request carries the same fingerprint: a server-side
          // `gen_random_uuid()` would differ between attempts, and a client's
          // own identifier would let it dictate the primary key.
          profileId: randomUUID(),
          name: authored.name,
          presetKind: authored.presetKindName,
          profile: authored.body,
          ...mutationOf(request.context?.requestId),
        });
        return { profile: toProfileMessage(written) };
      });
    },

    async updateSimulationProfile(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const profile = requireProfile(request.profile);
        const profileId = requireResourceId(profile.id?.value, 'profile.id');
        const groupId = authenticated.group.id;
        if (profile.groupId !== undefined && profile.groupId.value.length > 0) {
          assertAuthenticatedGroup(authenticated, profile.groupId.value);
        }
        const authored = readAuthoredProfile(profile, groupId);
        const written = await options.profiles.update({
          groupId,
          deviceId: authenticated.device.id,
          sources: authored.sources,
          profileId,
          name: authored.name,
          presetKind: authored.presetKindName,
          profile: authored.body,
          ...expectedRevisionOf(request.context?.expectedRevision?.number),
          ...mutationOf(request.context?.requestId),
        });
        return { profile: toProfileMessage(written) };
      });
    },

    async deleteSimulationProfile(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const profileId = requireResourceId(request.profileId?.value, 'profile_id');
        const removed = await options.profiles.delete({
          groupId: authenticated.group.id,
          deviceId: authenticated.device.id,
          profileId,
          ...mutationOf(request.context?.requestId),
        });
        return {
          result: {
            resourceId: { value: removed.profileId },
            revision: {
              number: removed.revision,
              etag: revisionEtag(removed.profileId, removed.revision),
            },
            correlationId: request.context?.correlationId ?? '',
          },
        };
      });
    },

    async applySimulationPreset(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const groupId = requireResourceId(request.groupId?.value, 'group_id');
        assertAuthenticatedGroup(authenticated, groupId);
        const preset = requireAppliablePreset(request.preset);
        const shape = presetShape(preset);
        const name = presetProfileName(preset);
        const authored = readAuthoredProfile(
          create(telemetryV1.SimulationProfileSchema, {
            groupId: { value: groupId },
            name,
            presetKind: preset,
            periodSeconds: shape.periodSeconds,
            updateIntervalMs: shape.updateIntervalMs,
            timeScale: shape.timeScale,
          }),
          groupId,
          { reservedNameAllowed: true },
        );
        const written = await options.profiles.applyPreset({
          groupId,
          deviceId: authenticated.device.id,
          sources: authored.sources,
          profileId: randomUUID(),
          name: authored.name,
          presetKind: authored.presetKindName,
          profile: authored.body,
          ...mutationOf(request.context?.requestId),
        });
        return { profile: toProfileMessage(written) };
      });
    },

    /**
     * Re-times a profile.
     *
     * Only `time_scale` survives the call. `running` and `phase` are read and
     * validated but not stored, because neither `SimulationProfile` nor any
     * table in this schema can carry them, and this control plane runs no
     * simulation clock for them to describe — the same absence that leaves
     * `StreamTelemetry` unimplemented. The response says exactly what was
     * persisted rather than echoing back state nobody kept.
     */
    async setSimulationClock(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const profileId = requireResourceId(request.profileId?.value, 'profile_id');
        requireFinite(request.phase, 'phase');
        const written = await options.profiles.setTimeScale({
          groupId: authenticated.group.id,
          deviceId: authenticated.device.id,
          profileId,
          timeScale: requireTimeScale(request.timeScale),
          ...mutationOf(request.context?.requestId),
        });
        return { profile: toProfileMessage(written) };
      });
    },

    /**
     * Evaluates a profile without storing anything.
     *
     * It is authenticated all the same: the evaluation is bounded but not free,
     * and an open compute endpoint is a way to spend a shoot machine's CPU from
     * outside the group.
     */
    async previewSimulationProfile(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options, context);
        const profile = requireProfile(request.profile);
        if (profile.groupId !== undefined && profile.groupId.value.length > 0) {
          assertAuthenticatedGroup(authenticated, profile.groupId.value);
        }
        assertPreviewableProfile(profile);
        return {
          snapshots: previewSnapshots(profile, requireSampleCount(request.sampleCount), now()),
        };
      });
    },
  };
}

interface MeasurementOptions extends TelemetryServiceOptions {
  readonly measurements: DurableTelemetryMeasurementStore;
}

/** What a measurement request resolves to once it is authenticated and validated. */
interface MeasurementReader {
  readonly groupId: string;
  readonly deviceId: string;
  /** The device the request named, when it named one; validated as a member of the group. */
  readonly targetDeviceId?: string;
  /** The sources the request named, when it named any; absent means all of the group's. */
  readonly sourceKeys?: readonly string[];
}

/**
 * The measurement half.
 *
 * It is built as a separate object so the three methods exist exactly when the
 * store behind them does. A deployment whose schema predates migration 0011 has
 * no registry to read, and a method that answered such a deployment with an
 * empty list would be reporting a shoot with no instruments as a shoot with
 * nothing to report.
 */
function createMeasurementMethods(
  options: MeasurementOptions,
  now: () => Date,
): Partial<ServiceImpl<typeof TelemetryService>> {
  return {
    async listDataSources(request, context) {
      return withRuntimeErrors(async () => {
        const reader = await readMeasurementReader(options, context, request.deviceId?.value, []);
        const page = await options.measurements.listSources({
          groupId: reader.groupId,
          deviceId: reader.deviceId,
          ...(reader.targetDeviceId === undefined ? {} : { targetDeviceId: reader.targetDeviceId }),
          pageSize: request.page?.pageSize ?? 0,
          cursor: request.page?.cursor ?? '',
        });
        return {
          sources: page.items.map(toDataSourceMessage),
          page: {
            nextCursor: page.nextCursor,
            previousCursor: page.previousCursor,
            hasMore: page.hasMore,
            approximateTotal: page.approximateTotal,
          },
        };
      });
    },

    /**
     * One reading of every source the request names.
     *
     * A stored snapshot younger than the group's own capture interval is
     * returned as it stands rather than recomputed. That is not a cache: the
     * interval comes from the published profiles' `update_interval_ms` and
     * `time_scale`, so it is the cadence the operator asked those curves to be
     * read at, and two screens asking within one interval must see one reading
     * or they are drawing different shoots.
     */
    async getTelemetrySnapshot(request, context) {
      return withRuntimeErrors(async () => {
        const reader = await readMeasurementReader(
          options,
          context,
          request.deviceId?.value,
          request.sourceIds,
        );
        const captured = await captureOrRead(options, reader, now());
        return { snapshot: toSnapshotMessage(captured.snapshot, reader) };
      });
    },

    /**
     * Follows the group's snapshots.
     *
     * Like `WatchSettings` this is a poll rather than a subscription, and for
     * the same reason: the realtime hub carries group events and knows nothing
     * about telemetry, and there is no broker in this deployment to invent one
     * around. What the durable store buys instead is the guarantee a broker
     * would not have given: `after_sequence` is a row in a table, so a client
     * that reconnects resumes exactly where it stopped and a restarted control
     * plane answers the same as the process it replaced.
     *
     * Backpressure is the generator's own. Each `yield` suspends until the
     * consumer has taken the snapshot, so a slow client slows the reads rather
     * than filling a queue behind it; `maxStreamBatch` bounds how much of a
     * backlog one statement returns; and a full batch loops again immediately,
     * so catching up costs no sleeps while staying paced by the consumer.
     */
    async *streamTelemetry(request, context) {
      const prepared = await withRuntimeErrors(async () => {
        // Validated before anything is read, so a request naming an impossible
        // cadence is refused without making this process evaluate a curve for
        // it.
        const requestedIntervalMs = requireStreamInterval(request.intervalMs);
        const reader = await readMeasurementReader(
          options,
          context,
          request.deviceId?.value,
          request.sourceIds,
        );
        // Read once before the loop so a stream against a group that declares
        // none of the requested sources is refused now, rather than becoming a
        // connection that yields nothing and looks like a quiet shoot.
        const captured = await captureOrRead(options, reader, now());
        return {
          reader,
          captured,
          // A client that named no interval is paced by the profiles' own
          // cadence rather than by a constant this module chose.
          intervalMs: requestedIntervalMs ?? captured.intervalMs,
        };
      });
      // The capture the preparation took is not yielded here. It is the newest
      // snapshot the group holds, and yielding it first would deliver it ahead
      // of everything a resuming client has not seen yet; the loop below reads
      // it in sequence order along with the rest of the backlog.
      let after = request.afterSequence;

      while (!context.signal.aborted) {
        const backlog = await withRuntimeErrors(() =>
          options.measurements.readAfter({
            ...toReadInput(prepared.reader),
            afterSequence: after,
            limit: maxStreamBatch,
          }),
        );
        for (const snapshot of backlog) {
          if (context.signal.aborted) return;
          after = snapshot.sequence;
          yield { snapshot: toSnapshotMessage(snapshot, prepared.reader) };
        }
        // A full batch means there is more behind it. Looping without sleeping
        // is what lets a client that reconnected an hour late catch up at the
        // rate it can consume rather than at one batch per interval.
        if (backlog.length === maxStreamBatch) continue;

        const captured = await withRuntimeErrors(() =>
          captureOrRead(options, prepared.reader, now()),
        );
        if (captured.snapshot.sequence > after) {
          if (context.signal.aborted) return;
          after = captured.snapshot.sequence;
          yield { snapshot: toSnapshotMessage(captured.snapshot, prepared.reader) };
        }
        await waitForNextPoll(prepared.intervalMs, context.signal);
      }
    },
  };
}

/**
 * Authenticates a measurement request and validates what it names.
 *
 * The group is never taken from the request: a device's session names exactly
 * one group, and every measurement RPC in this contract addresses a device
 * rather than a group, so the group can only be the session's. The named device
 * is checked against that group inside the store's own statement, because a
 * check performed here would be a read whose result the following statement
 * would have to trust.
 */
async function readMeasurementReader(
  options: MeasurementOptions,
  context: HandlerContext,
  deviceId: string | undefined,
  sourceIds: readonly { readonly value: string }[],
): Promise<MeasurementReader> {
  const authenticated = await authenticate(options, context);
  const targetDeviceId = requireOptionalDeviceId(deviceId);
  const sourceKeys = requireSourceKeys(sourceIds);
  return {
    groupId: authenticated.group.id,
    deviceId: authenticated.device.id,
    ...(targetDeviceId === undefined ? {} : { targetDeviceId }),
    ...(sourceKeys === undefined ? {} : { sourceKeys }),
  };
}

function toReadInput(reader: MeasurementReader): {
  readonly groupId: string;
  readonly deviceId: string;
  readonly targetDeviceId?: string;
  readonly sourceKeys?: readonly string[];
} {
  return {
    groupId: reader.groupId,
    deviceId: reader.deviceId,
    ...(reader.targetDeviceId === undefined ? {} : { targetDeviceId: reader.targetDeviceId }),
    ...(reader.sourceKeys === undefined ? {} : { sourceKeys: reader.sourceKeys }),
  };
}

/**
 * Returns the group's current reading, taking one if the last is stale.
 *
 * A group that has published no profile declares no source, and that is refused
 * rather than answered with an empty snapshot: an empty success is exactly the
 * answer that would let a client draw a healthy wall for a shoot nothing is
 * measuring.
 */
/** A reading and the cadence the group's own profiles ask it to be taken at. */
interface CapturedTelemetry {
  readonly snapshot: TelemetrySnapshotRecord;
  readonly intervalMs: number;
}

async function captureOrRead(
  options: MeasurementOptions,
  reader: MeasurementReader,
  capturedAt: Date,
): Promise<CapturedTelemetry> {
  const context = await options.measurements.readCaptureContext(toReadInput(reader));
  if (context.sources.length === 0) {
    throw new PairedDeviceRuntimeError(
      'FAILED_PRECONDITION',
      reader.sourceKeys === undefined
        ? 'The group declares no telemetry data sources. Publish a simulation profile with channels first.'
        : 'The group declares none of the requested telemetry data sources.',
    );
  }
  const intervalMs = captureIntervalMs(context.sources);
  const latest = context.latest;
  if (latest !== undefined && capturedAt.getTime() - latest.capturedAt.getTime() < intervalMs) {
    const stored = await options.measurements.readAfter({
      ...toReadInput(reader),
      // One before the sequence wanted, because the read is exclusive; a
      // separate "read this exact sequence" would be a second statement that
      // could disagree with this one about who may see it.
      afterSequence: latest.sequence - 1n,
      limit: 1,
    });
    const snapshot = stored[0];
    if (snapshot !== undefined) return { snapshot, intervalMs };
  }
  const snapshot = await options.measurements.record({
    groupId: reader.groupId,
    deviceId: reader.deviceId,
    capturedAt,
    samples: context.sources.map((source) => readSource(source, capturedAt)),
  });
  return { snapshot, intervalMs };
}

/**
 * What one source reads at an instant.
 *
 * The timeline's origin is the declaring profile's `updated_at`, so the phase
 * is a function of the profile and the wall clock alone. Two devices reading at
 * one instant therefore compute one number, which is the property that makes a
 * server-side reading worth having at all — a per-client simulation gives every
 * screen of a shoot its own curve.
 *
 * The elapsed time is quantized onto the profile's own sample grid before the
 * phase is taken, so a reading is stable for the whole of one update interval
 * rather than drifting with whenever a request happened to arrive.
 */
function readSource(
  source: TelemetryCaptureSource,
  capturedAt: Date,
): Omit<TelemetrySampleRecord, 'observedAt'> {
  const profile = readStoredProfile(source.profile);
  const channel = channelFor(profile, source);
  if (channel === undefined) {
    // The registry names a channel the stored body no longer carries. It cannot
    // be evaluated and must not be reported as a reading of zero, so it reads
    // as the proto3 default with an unspecified severity: a client sees a
    // source it cannot draw rather than a flat line it can.
    return {
      sourceKey: source.sourceKey,
      value: 0,
      unit: source.unit,
      severity: 'UNSPECIFIED',
      labels: source.labels,
    };
  }
  const intervalMs =
    profile.updateIntervalMs > 0 ? profile.updateIntervalMs : defaultUpdateIntervalMs;
  const periodSeconds = profile.periodSeconds > 0 ? profile.periodSeconds : defaultPeriodSeconds;
  const timeScale = profile.timeScale > 0 ? profile.timeScale : 1;
  const elapsedMs = Math.max(0, capturedAt.getTime() - source.profileUpdatedAt.getTime());
  const index = Math.trunc(elapsedMs / intervalMs);
  const phase = curvePhaseAt({ periodSeconds, timeScale }, index * intervalMs);
  const simulated = toSimulationChannel(channel);
  return {
    sourceKey: source.sourceKey,
    value: channelValue(simulated, phase, index, source.previousValue),
    unit: source.unit,
    severity: severityName(channelSeverity(simulated, phase)),
    labels: source.labels,
  };
}

/**
 * The channel the registry row points at.
 *
 * The stored index is tried first and its source identifier re-checked, because
 * the index is a fact about the profile as it stood when the source was
 * declared. `SetSimulationClock` rewrites the body without re-declaring, so the
 * fallback search by identifier is what keeps a re-timed profile readable.
 */
function channelFor(
  profile: telemetryV1.SimulationProfile,
  source: TelemetryCaptureSource,
): telemetryV1.SimulationChannel | undefined {
  const indexed = profile.channels[source.channelIndex];
  if (indexed !== undefined && indexed.sourceId?.value === source.sourceKey) return indexed;
  return profile.channels.find((channel) => channel.sourceId?.value === source.sourceKey);
}

function readStoredProfile(body: Record<string, unknown>): telemetryV1.SimulationProfile {
  try {
    return fromJson(telemetryV1.SimulationProfileSchema, body as JsonValue);
  } catch {
    throw new Error('The database returned an invalid simulation profile body.');
  }
}

/**
 * How often the group's curves are worth re-reading.
 *
 * It is the shortest cadence any declaring profile asks for, divided by that
 * profile's time scale because a doubled scale means the curve moves through
 * its period twice as fast. The floor is the same one a stream may not go
 * below: a profile that named a millisecond would otherwise make every read a
 * write.
 */
function captureIntervalMs(sources: readonly TelemetryCaptureSource[]): number {
  let shortest = maxStreamIntervalMs;
  for (const source of sources) {
    const profile = readStoredProfile(source.profile);
    const intervalMs =
      profile.updateIntervalMs > 0 ? profile.updateIntervalMs : defaultUpdateIntervalMs;
    const timeScale = profile.timeScale > 0 ? profile.timeScale : 1;
    shortest = Math.min(shortest, intervalMs / timeScale);
  }
  return Math.min(maxStreamIntervalMs, Math.max(minStreamIntervalMs, shortest));
}

/**
 * The interval a stream runs at.
 *
 * Zero is the proto3 default for a client that expressed no preference, and it
 * resolves to the group's own capture interval rather than to a constant: the
 * cadence the profiles ask to be read at is the cadence a client that said
 * nothing should get.
 */
function requireStreamInterval(requested: number): number | undefined {
  if (requested === 0) return undefined;
  if (
    !Number.isInteger(requested) ||
    requested < minStreamIntervalMs ||
    requested > maxStreamIntervalMs
  ) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `interval_ms must lie between ${minStreamIntervalMs.toString()} and ${maxStreamIntervalMs.toString()}.`,
    );
  }
  return requested;
}

function requireOptionalDeviceId(value: string | undefined): string | undefined {
  const deviceId = value?.trim() ?? '';
  if (deviceId.length === 0) return undefined;
  if (!deviceIdPattern.test(deviceId)) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'device_id must be a UUID.');
  }
  return deviceId;
}

/**
 * The sources a request names, or `undefined` for all of them.
 *
 * An empty list and a list whose entries were all blank are different mistakes
 * and both resolve to "all of them", because an empty `source_ids` is the
 * proto3 default of a client that wants the whole snapshot. A list that names
 * real keys is kept verbatim, so a key the group does not declare narrows the
 * answer instead of widening it.
 */
function requireSourceKeys(
  sourceIds: readonly { readonly value: string }[],
): readonly string[] | undefined {
  if (sourceIds.length > maxRequestedSources) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `source_ids must not name more than ${maxRequestedSources.toString()} sources.`,
    );
  }
  const keys = sourceIds.map((sourceId) => sourceId.value.trim()).filter((key) => key.length > 0);
  return keys.length === 0 ? undefined : keys;
}

function toDataSourceMessage(source: TelemetrySourceRecord): telemetryV1.DataSource {
  return create(telemetryV1.DataSourceSchema, {
    id: { value: source.sourceKey },
    name: source.name,
    kind: toDataSourceKind(source.kind),
    unit: source.unit,
    simulated: source.simulated,
    // `SimulationChannel` declares no thresholds, so neither does the registry.
    // Zero is the proto3 default for an unset double, which is the honest
    // answer; a threshold derived from a channel's range would be this
    // process's opinion presented as the operator's.
    warningThreshold: 0,
    criticalThreshold: 0,
    labels: { ...source.labels },
  });
}

function toSnapshotMessage(
  snapshot: TelemetrySnapshotRecord,
  reader: MeasurementReader,
): telemetryV1.TelemetrySnapshot {
  return create(telemetryV1.TelemetrySnapshotSchema, {
    // The device the request named, or the one that asked. The reading itself
    // belongs to the group, so this identifies whose view it is answering and
    // never where the number came from.
    deviceId: { value: reader.targetDeviceId ?? reader.deviceId },
    sequence: snapshot.sequence,
    samples: snapshot.samples.map((sample) =>
      create(telemetryV1.TelemetrySampleSchema, {
        sourceId: { value: sample.sourceKey },
        value: sample.value,
        unit: sample.unit,
        severity: toSeverityEnum(sample.severity),
        observedAt: timestampFromDate(sample.observedAt),
        labels: { ...sample.labels },
      }),
    ),
    capturedAt: timestampFromDate(snapshot.capturedAt),
    // Every source this schema can hold is declared by a simulation profile, so
    // every reading it can return is simulated. Reporting otherwise would be
    // the one lie a telemetry wall cannot survive.
    simulated: true,
  });
}

function severityName(severity: TelemetrySeverityKind): string {
  switch (severity) {
    case 'normal':
      return 'NORMAL';
    case 'elevated':
      return 'ELEVATED';
    case 'degraded':
      return 'DEGRADED';
    case 'critical':
      return 'CRITICAL';
  }
}

/**
 * Mapped exhaustively rather than by reverse enum lookup, for the reason
 * `presetKindName` gives: a name this process does not know reads as
 * `UNSPECIFIED`, which a client can draw, and never as a severity it is not.
 */
function toSeverityEnum(name: string): telemetryV1.TelemetrySeverity {
  switch (name) {
    case 'NORMAL':
      return telemetryV1.TelemetrySeverity.NORMAL;
    case 'ELEVATED':
      return telemetryV1.TelemetrySeverity.ELEVATED;
    case 'DEGRADED':
      return telemetryV1.TelemetrySeverity.DEGRADED;
    case 'CRITICAL':
      return telemetryV1.TelemetrySeverity.CRITICAL;
    default:
      return telemetryV1.TelemetrySeverity.UNSPECIFIED;
  }
}

/**
 * The same sleep `WatchSettings` uses: it resolves on the timer or on the
 * abort, and the timer is unreferenced so a stream nobody is reading cannot
 * keep the process alive.
 */
function waitForNextPoll(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, intervalMs);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The timing a preset puts on a profile.
 *
 * A preset says how urgently a shoot should read: a normal watch updates once a
 * second over five minutes, an attack updates five times a second over two.
 * What it cannot say is which sources to drive, because channels name data
 * sources and this deployment has no registry of them — so an applied preset
 * arrives with no channels and the operator attaches them with
 * `UpdateSimulationProfile`.
 */
interface PresetShape {
  readonly periodSeconds: number;
  readonly updateIntervalMs: number;
  readonly timeScale: number;
}

function presetShape(preset: telemetryV1.SimulationPresetKind): PresetShape {
  switch (preset) {
    case telemetryV1.SimulationPresetKind.NORMAL:
      return { periodSeconds: 300, updateIntervalMs: 1_000, timeScale: 1 };
    case telemetryV1.SimulationPresetKind.ELEVATED:
      return { periodSeconds: 240, updateIntervalMs: 1_000, timeScale: 1 };
    case telemetryV1.SimulationPresetKind.DEGRADED:
      return { periodSeconds: 180, updateIntervalMs: 500, timeScale: 1 };
    case telemetryV1.SimulationPresetKind.CRITICAL:
      return { periodSeconds: 120, updateIntervalMs: 250, timeScale: 1 };
    case telemetryV1.SimulationPresetKind.INCIDENT:
      return { periodSeconds: 90, updateIntervalMs: 250, timeScale: 1.5 };
    case telemetryV1.SimulationPresetKind.RECOVERY:
      return { periodSeconds: 600, updateIntervalMs: 1_000, timeScale: 0.5 };
    case telemetryV1.SimulationPresetKind.NETWORK_ATTACK:
      return { periodSeconds: 120, updateIntervalMs: 200, timeScale: 2 };
    case telemetryV1.SimulationPresetKind.STORAGE_EXHAUSTION:
      return { periodSeconds: 900, updateIntervalMs: 1_000, timeScale: 1 };
    default:
      return { periodSeconds: 60, updateIntervalMs: 200, timeScale: 2 };
  }
}

/**
 * The reserved name a preset's profile occupies.
 *
 * Applying a preset upserts on `(group_id, name)`, so the name is what makes
 * the second application update the first profile instead of adding another.
 * The prefix keeps it out of the space an operator names by hand: a profile
 * called `Обычный` stays the operator's, and `preset:NORMAL` stays the
 * preset's.
 */
function presetProfileName(preset: telemetryV1.SimulationPresetKind): string {
  return `${reservedProfileNamePrefix}${presetKindName(preset)}`;
}

function requireAppliablePreset(
  preset: telemetryV1.SimulationPresetKind,
): telemetryV1.SimulationPresetKind {
  if (preset === telemetryV1.SimulationPresetKind.UNSPECIFIED) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      'A simulation preset must be named explicitly.',
    );
  }
  if (preset === telemetryV1.SimulationPresetKind.CUSTOM) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      'CUSTOM describes a profile written by hand, not a preset. ' +
        'Publish it with CreateSimulationProfile.',
    );
  }
  return preset;
}

/**
 * The `preset_kind` column carries the protobuf enum name rather than its wire
 * number, so an operator reading the table directly sees what a profile is. It
 * is mapped exhaustively instead of by reverse enum lookup: a reverse lookup
 * answers `undefined` for any value a newer client sends, and a NULL-shaped
 * kind is indistinguishable from an unset one.
 */
function presetKindName(kind: telemetryV1.SimulationPresetKind): string {
  switch (kind) {
    case telemetryV1.SimulationPresetKind.NORMAL:
      return 'NORMAL';
    case telemetryV1.SimulationPresetKind.ELEVATED:
      return 'ELEVATED';
    case telemetryV1.SimulationPresetKind.DEGRADED:
      return 'DEGRADED';
    case telemetryV1.SimulationPresetKind.CRITICAL:
      return 'CRITICAL';
    case telemetryV1.SimulationPresetKind.INCIDENT:
      return 'INCIDENT';
    case telemetryV1.SimulationPresetKind.RECOVERY:
      return 'RECOVERY';
    case telemetryV1.SimulationPresetKind.NETWORK_ATTACK:
      return 'NETWORK_ATTACK';
    case telemetryV1.SimulationPresetKind.STORAGE_EXHAUSTION:
      return 'STORAGE_EXHAUSTION';
    case telemetryV1.SimulationPresetKind.CPU_OVERLOAD:
      return 'CPU_OVERLOAD';
    case telemetryV1.SimulationPresetKind.CUSTOM:
      return 'CUSTOM';
    default:
      return 'UNSPECIFIED';
  }
}

interface AuthoredProfile {
  readonly name: string;
  readonly presetKindName: string;
  /** The whole authored profile, minus the three fields the server owns. */
  readonly body: Record<string, unknown>;
  /**
   * The data sources this profile declares, derived from its own channels. They
   * travel to the store beside the body so the statement that writes the
   * profile writes the registry too, and a registry that disagreed with the
   * profiles could not arise from a half-applied write.
   */
  readonly sources: readonly TelemetrySourceDeclaration[];
}

/**
 * Reduces a submitted profile to what the store keeps.
 *
 * Identifier, revision and updated-at are dropped rather than trusted: they are
 * facts about a write, and a client that could set them could claim a revision
 * it never produced. Everything else is kept whole, because a version row has
 * to replay into a complete profile from its own body alone.
 */
function readAuthoredProfile(
  profile: telemetryV1.SimulationProfile,
  groupId: string,
  // `ApplySimulationPreset` composes the reserved name itself and is the only
  // caller entitled to it.
  options: { readonly reservedNameAllowed?: boolean } = {},
): AuthoredProfile {
  const name = profile.name.trim();
  if (name.length === 0) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      'A simulation profile must carry a name.',
    );
  }
  if (name.length > maxProfileNameLength) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `A simulation profile name must not exceed ${maxProfileNameLength.toString()} characters.`,
    );
  }
  // `ApplySimulationPreset` writes `preset:<KIND>` and upserts on
  // `(group_id, name)`. An operator who authored a profile under that exact
  // name would have it replaced by the preset's channels without being told, so
  // the prefix is reserved rather than merely conventional.
  if (options.reservedNameAllowed !== true && name.startsWith(reservedProfileNamePrefix)) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `A simulation profile name must not start with "${reservedProfileNamePrefix}": ` +
        'that namespace belongs to the presets.',
    );
  }
  if (profile.presetKind === telemetryV1.SimulationPresetKind.UNSPECIFIED) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      'A simulation profile must name its preset kind explicitly; use CUSTOM for a hand-written one.',
    );
  }
  assertPreviewableProfile(profile);

  const authored = create(telemetryV1.SimulationProfileSchema, {
    groupId: { value: groupId },
    name,
    presetKind: profile.presetKind,
    channels: profile.channels,
    periodSeconds: profile.periodSeconds,
    updateIntervalMs: profile.updateIntervalMs,
    timeScale: profile.timeScale,
  });
  const body = toJson(telemetryV1.SimulationProfileSchema, authored);
  if (!isRecord(body)) throw new Error('A simulation profile must encode as a JSON object.');
  const kindName = presetKindName(profile.presetKind);
  return {
    name,
    presetKindName: kindName,
    body,
    // Derived from `authored` rather than from the caller's message: the
    // registry must describe what was stored, and the two differ whenever a
    // field was dropped on the way in.
    sources: declaredSources(authored, kindName),
  };
}

/**
 * Rebuilds the published message from a stored row.
 *
 * The three server-owned fields are stamped back on from the columns that hold
 * them, so a profile read from `simulation_profiles` and a profile read from
 * one `simulation_versions` row differ in nothing but where their revision came
 * from.
 */
function toProfileMessage(record: SimulationProfileRecord): telemetryV1.SimulationProfile {
  let profile: telemetryV1.SimulationProfile;
  try {
    profile = fromJson(telemetryV1.SimulationProfileSchema, record.profile as JsonValue);
  } catch {
    // A body this process wrote and cannot read back is a defect here, not a
    // client-visible outcome, so it must not reach a Connect status code.
    throw new Error('The database returned an invalid simulation profile body.');
  }
  profile.id = create(ResourceIdSchema, { value: record.id });
  profile.groupId = create(ResourceIdSchema, { value: record.groupId });
  profile.revision = create(RevisionSchema, {
    number: record.revision,
    etag: revisionEtag(record.id, record.revision),
  });
  profile.updatedAt = timestampFromDate(record.updatedAt);
  return profile;
}

function revisionEtag(profileId: string, revision: bigint): string {
  return `simulation-profile-${profileId}-revision-${revision.toString()}`;
}

/**
 * Bounds everything the preview arithmetic walks over.
 *
 * Every one of these is a bound on work this process does on a request's
 * behalf, and the unbounded version of each is a way to make one call cost a
 * shoot machine its render budget.
 */
function assertPreviewableProfile(profile: telemetryV1.SimulationProfile): void {
  if (profile.channels.length > maxChannelsPerProfile) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `A simulation profile must not carry more than ${maxChannelsPerProfile.toString()} channels.`,
    );
  }
  if (profile.periodSeconds > maxPeriodSeconds) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `period_seconds must not exceed ${maxPeriodSeconds.toString()}.`,
    );
  }
  if (profile.updateIntervalMs > maxUpdateIntervalMs) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `update_interval_ms must not exceed ${maxUpdateIntervalMs.toString()}.`,
    );
  }
  requireTimeScale(profile.timeScale);
  for (const channel of profile.channels) {
    requireFinite(channel.minimum, 'channel.minimum');
    requireFinite(channel.maximum, 'channel.maximum');
    requireFinite(channel.noise, 'channel.noise');
    requireFinite(channel.smoothing, 'channel.smoothing');
    if (channel.maximum < channel.minimum) {
      throw new PairedDeviceRuntimeError(
        'INVALID_ARGUMENT',
        'A simulation channel must not declare a maximum below its minimum.',
      );
    }
    assertCurve(channel.valueCurve);
    assertCurve(channel.criticalityCurve);
  }
}

function assertCurve(curve: telemetryV1.SimulationCurve | undefined): void {
  if (curve === undefined) return;
  if (curve.points.length > maxCurvePoints) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `A simulation curve must not carry more than ${maxCurvePoints.toString()} points.`,
    );
  }
  for (const point of curve.points) {
    requireFinite(point.time, 'curve point time');
    requireFinite(point.value, 'curve point value');
    requireFinite(point.inTangent, 'curve point in_tangent');
    requireFinite(point.outTangent, 'curve point out_tangent');
  }
}

function requireFinite(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', `${field} must be a finite number.`);
  }
  return value;
}

function requireTimeScale(value: number): number {
  requireFinite(value, 'time_scale');
  if (value < 0 || value > maxTimeScale) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `time_scale must lie between 0 and ${maxTimeScale.toString()}.`,
    );
  }
  return value;
}

function requireSampleCount(requested: number): number {
  if (requested === 0) return defaultPreviewSampleCount;
  if (!Number.isInteger(requested) || requested < 0 || requested > maxPreviewSampleCount) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `sample_count must lie between 1 and ${maxPreviewSampleCount.toString()}.`,
    );
  }
  return requested;
}

/**
 * Walks a profile's timeline and reports what each channel would read.
 *
 * The arithmetic is `@gremuchaya/domain`'s `channelValue` and
 * `channelSeverity`, the same functions the client drives its own simulation
 * with, so a preview here and a run there agree reading for reading. The walk
 * is deterministic in the profile alone: noise comes from the channel's own
 * seed and the sample's index, never from a clock or a shared generator. Two
 * previews of one profile therefore agree, which is what makes a preview worth
 * showing an operator before the profile is published.
 *
 * A zero `time_scale`, `period_seconds` or `update_interval_ms` is the proto3
 * default for a field the client left alone, so each falls back to its own
 * sensible value rather than freezing the timeline or dividing by zero.
 */
export function previewSnapshots(
  profile: telemetryV1.SimulationProfile,
  sampleCount: number,
  capturedAt: Date,
): telemetryV1.TelemetrySnapshot[] {
  const intervalMs =
    profile.updateIntervalMs > 0 ? profile.updateIntervalMs : defaultUpdateIntervalMs;
  const periodSeconds = profile.periodSeconds > 0 ? profile.periodSeconds : defaultPeriodSeconds;
  const timeScale = profile.timeScale > 0 ? profile.timeScale : 1;
  // The protocol enums are mapped once per channel here, not once per sample.
  const channels = profile.channels.map((channel) => ({
    sourceId: channel.sourceId,
    simulated: toSimulationChannel(channel),
  }));
  const previous = new Array<number | undefined>(channels.length).fill(undefined);
  const snapshots: telemetryV1.TelemetrySnapshot[] = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const elapsedMs = index * intervalMs;
    const observedAt = new Date(capturedAt.getTime() + elapsedMs);
    // The same function the client's own simulation runs on, not the same
    // arithmetic written twice: a preview an operator judges a curve by and the
    // reading that curve produces on a screen have to be the same number, and
    // two copies of one formula agree only until one of them is edited.
    const phase = curvePhaseAt({ periodSeconds, timeScale }, elapsedMs);
    const samples = channels.map((channel, channelIndex) => {
      const value = channelValue(channel.simulated, phase, index, previous[channelIndex]);
      previous[channelIndex] = value;
      return create(telemetryV1.TelemetrySampleSchema, {
        ...(channel.sourceId === undefined ? {} : { sourceId: channel.sourceId }),
        value,
        // The unit belongs to the data source, and this deployment keeps no
        // registry of data sources, so a preview reports the number and leaves
        // naming it to whoever owns the source.
        unit: '',
        severity: toSeverityMessage(channelSeverity(channel.simulated, phase)),
        observedAt: timestampFromDate(observedAt),
      });
    });
    snapshots.push(
      create(telemetryV1.TelemetrySnapshotSchema, {
        sequence: BigInt(index + 1),
        samples,
        capturedAt: timestampFromDate(observedAt),
        simulated: true,
      }),
    );
  }
  return snapshots;
}

/**
 * The protocol's channel, read into the shape the shared arithmetic takes.
 *
 * Only the enums need translating: the points and the numbers are the same
 * fields under the same names. The source identifier is left behind on
 * purpose; it names the reading and plays no part in computing it.
 */
function toSimulationChannel(channel: telemetryV1.SimulationChannel): SimulationChannelLike {
  const valueCurve = toSimulationCurve(channel.valueCurve);
  const criticalityCurve = toSimulationCurve(channel.criticalityCurve);
  return {
    minimum: channel.minimum,
    maximum: channel.maximum,
    noise: channel.noise,
    smoothing: channel.smoothing,
    seed: channel.seed,
    ...(valueCurve === undefined ? {} : { valueCurve }),
    ...(criticalityCurve === undefined ? {} : { criticalityCurve }),
  };
}

function toSimulationCurve(
  curve: telemetryV1.SimulationCurve | undefined,
): SimulationCurveLike | undefined {
  if (curve === undefined) return undefined;
  return {
    points: curve.points,
    interpolation: toCurveInterpolationKind(curve.interpolation),
    loop: curve.loop,
  };
}

/**
 * An unspecified interpolation reads as linear: a straight line is the reading
 * a curve of bare points describes without its tangents. The default branch
 * stays because a newer client can put a wire value here that this enum does
 * not name, and such a curve is still a list of points.
 */
function toCurveInterpolationKind(
  interpolation: telemetryV1.CurveInterpolation,
): CurveInterpolationKind {
  switch (interpolation) {
    case telemetryV1.CurveInterpolation.STEP:
      return 'step';
    case telemetryV1.CurveInterpolation.HERMITE:
      return 'hermite';
    case telemetryV1.CurveInterpolation.BEZIER:
      return 'bezier';
    case telemetryV1.CurveInterpolation.LINEAR:
    case telemetryV1.CurveInterpolation.UNSPECIFIED:
    default:
      return 'linear';
  }
}

function toSeverityMessage(severity: TelemetrySeverityKind): telemetryV1.TelemetrySeverity {
  switch (severity) {
    case 'normal':
      return telemetryV1.TelemetrySeverity.NORMAL;
    case 'elevated':
      return telemetryV1.TelemetrySeverity.ELEVATED;
    case 'degraded':
      return telemetryV1.TelemetrySeverity.DEGRADED;
    case 'critical':
      return telemetryV1.TelemetrySeverity.CRITICAL;
  }
}

function requireProfile(
  profile: telemetryV1.SimulationProfile | undefined,
): telemetryV1.SimulationProfile {
  if (profile === undefined) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'The request carries no profile.');
  }
  return profile;
}

function authenticate(
  options: TelemetryServiceOptions,
  context: HandlerContext,
): Awaitable<AuthenticatedDevice> {
  return options.runtime.authenticateAccessToken(readBearerToken(context));
}

/**
 * The bearer reader, the runtime-error mapping and the mutation-context
 * normalization below repeat what `sync/service.ts` already does privately.
 * They are not exported from there, and this module may not reach into it, so
 * the four sit here in the same shape rather than in a subtly different one.
 */
function readBearerToken(context: HandlerContext): string {
  const header = context.requestHeader.get('authorization');
  const match = header === null ? undefined : /^Bearer ([^\s]+)$/u.exec(header.trim());
  if (match?.[1] === undefined) {
    throw new ConnectError('A bearer access token is required.', Code.Unauthenticated);
  }
  return match[1];
}

async function withRuntimeErrors<T>(operation: () => Awaitable<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof ConnectError) throw error;
    if (error instanceof PairedDeviceRuntimeError) {
      throw new ConnectError(error.message, toConnectCode(error.code));
    }
    throw error;
  }
}

function toConnectCode(code: PairedDeviceRuntimeError['code']): Code {
  if (code === 'ABORTED') return Code.Aborted;
  if (code === 'ALREADY_EXISTS') return Code.AlreadyExists;
  if (code === 'FAILED_PRECONDITION') return Code.FailedPrecondition;
  if (code === 'INVALID_ARGUMENT') return Code.InvalidArgument;
  if (code === 'NOT_FOUND') return Code.NotFound;
  if (code === 'PERMISSION_DENIED') return Code.PermissionDenied;
  return Code.Unauthenticated;
}

/**
 * `request_id` is the only part of `MutationContext` that carries idempotency
 * meaning: `correlation_id` is response metadata and `issued_at` is a client
 * clock reading, so neither may take part in retry identity.
 */
function mutationOf(requestId: string | undefined): { readonly mutation?: MutationReceiptContext } {
  try {
    const normalized = normalizeRequestId(requestId);
    return normalized === undefined ? {} : { mutation: { requestId: normalized } };
  } catch (error: unknown) {
    if (error instanceof MutationRequestIdError) {
      throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', error.message);
    }
    throw error;
  }
}

/**
 * Zero is the proto3 default for a client that is not checking a revision, and
 * revisions start at one, so it disables the check rather than demanding a
 * profile that could never exist.
 */
function expectedRevisionOf(number: bigint | undefined): { readonly expectedRevision?: bigint } {
  if (number === undefined || number === 0n) return {};
  return { expectedRevision: number };
}

function assertContextActor(
  authenticated: AuthenticatedDevice,
  actorDeviceId: string | undefined,
): void {
  if (actorDeviceId === undefined || actorDeviceId.length === 0) return;
  if (actorDeviceId !== authenticated.device.id) {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      'The mutation context actor does not match the authenticated device.',
    );
  }
}

/**
 * A device's session names exactly one group, so a request for any other group
 * is refused before it can reach a statement. This is what keeps a valid token
 * from reading or writing a group it was never paired into.
 */
function assertAuthenticatedGroup(authenticated: AuthenticatedDevice, groupId: string): void {
  if (authenticated.group.id !== groupId) {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      'The authenticated device does not belong to the requested group.',
    );
  }
}

function requireResourceId(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', `${field} must not be empty.`);
  }
  return value.trim();
}
