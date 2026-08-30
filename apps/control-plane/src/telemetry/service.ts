import { randomUUID } from 'node:crypto';

import { create, fromJson, toJson, type JsonValue } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import {
  channelSeverity,
  channelValue,
  curvePhaseAt,
  type CurveInterpolationKind,
  type SimulationChannelLike,
  type SimulationCurveLike,
  type TelemetrySeverityKind,
} from '@gremuchaya/domain';
import {
  ControlPlaneFailure,
  ResourceIdSchema,
  RevisionSchema,
  telemetryV1,
} from '@gremuchaya/protocol';
import type { TelemetryService } from '@gremuchaya/protocol';

import { controlPlaneFailure, withRuntimeErrors } from '../errors.js';

import type { Awaitable, PairedDeviceLifecycle } from '../sync/lifecycle.js';
import {
  MutationRequestIdError,
  normalizeRequestId,
  type MutationReceiptContext,
} from '../sync/receipts.js';
import { isRecord } from '../sync/rows.js';
import { PairedDeviceRuntimeError, type AuthenticatedDevice } from '../sync/runtime.js';

import type { DurableSimulationProfileStore, SimulationProfileRecord } from './store.js';

/**
 * ConnectRPC adapter for `TelemetryService`.
 *
 * Seven of the contract's ten methods are here. Three are deliberately absent,
 * and they are absent for one reason: this schema has nowhere to put what they
 * return.
 *
 * - `ListDataSources` needs a registry of the sources a device exposes.
 * - `GetTelemetrySnapshot` needs a store of samples read from those sources.
 * - `StreamTelemetry` needs the same store, plus a reader that follows it.
 *
 * Migrations 0001 to 0008 declare neither table, and a migration is immutable
 * once written, so guessing a shape for them here would commit this repository
 * to that guess permanently. The three stay out of the returned implementation
 * object instead, which makes ConnectRPC answer `unimplemented` for them. That
 * is an answer a client can act on: it asks `ControlPlaneService.getCapabilities`,
 * learns what this deployment actually serves, and reads live telemetry from
 * the machine it is running on rather than from here. An empty success would
 * have told it a shoot is healthy when nothing was measured.
 *
 * What remains is the simulation half of the contract, which is complete: a
 * group's profiles are listed, created, updated, deleted, driven from a preset,
 * re-timed, and previewed without being stored at all.
 */

export interface TelemetryServiceOptions {
  /** Supplies `authenticateAccessToken`; the same lifecycle the sync service uses. */
  readonly runtime: PairedDeviceLifecycle;
  readonly profiles: DurableSimulationProfileStore;
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

export function createTelemetryService(
  options: TelemetryServiceOptions,
): Partial<ServiceImpl<typeof TelemetryService>> {
  const now = options.now ?? ((): Date => new Date());

  return {
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
  return { name, presetKindName: presetKindName(profile.presetKind), body };
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
    throw controlPlaneFailure(ControlPlaneFailure.BEARER_TOKEN_REQUIRED);
  }
  return match[1];
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
