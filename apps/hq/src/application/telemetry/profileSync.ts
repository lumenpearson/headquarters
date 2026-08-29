import type { SettingsPatch } from '@gremuchaya/settings-schema';

import {
  absoluteToPercentPoints,
  isSimulationChannelName,
  readCurvePoints,
  simulationChannelFor,
  simulationChannelRanges,
  withChannelCurve,
  type SimulationSettings,
} from '@/application/simulation/simulationCurves';
import type {
  TelemetryChannel,
  TelemetryPresetName,
  TelemetryProfile,
} from '@/infrastructure/controlPlane/TelemetryClient';

/**
 * Connects `TelemetryService`'s server-side simulation profiles and curves
 * (R31) with this build's own copy of a curve: the `simulation.valueCurve`
 * and `simulation.criticalityCurve` settings `simulationCurves.ts` reads and
 * `simulationTick` drives the local world with.
 *
 * Neither direction is automatic. A device edits its curve locally — that is
 * what the settings draft, undo stack and issue-draft machinery are for — and
 * publishing it or pulling a group's published profile down are separate,
 * operator-initiated acts. This module is the arithmetic both acts share: the
 * percentage-of-range storage `simulationCurves.ts` keeps against the
 * absolute-units wire shape `TelemetryClient` speaks, so a curve dragged on
 * one screen and evaluated on the server describe the same line.
 *
 * `noise`, `smoothing` and `seed` travel with a published channel because the
 * wire has nowhere else to put them, but they are session-wide settings here,
 * not a fact of any one channel — `simulationChannelFor` reads them off
 * `SimulationSettings` for every channel alike. Reading a fetched profile back
 * therefore folds its curves into the local store and leaves those three
 * alone; a caller that wants to adopt a profile's noise or seed as well does
 * so explicitly, through the ordinary settings patch for `simulation.noise`,
 * `simulation.smoothing` or `simulation.seed`.
 */

/** The setting ids `applyTelemetryProfileToSettings` writes. */
export const telemetryProfileSettingIds = {
  valueCurve: 'simulation.valueCurve',
  criticalityCurve: 'simulation.criticalityCurve',
} as const;

/**
 * This device's drawn curves, read into the channels a `SimulationProfile`
 * publish carries.
 *
 * Only a channel with at least one drawn point — in the value curve or the
 * criticality curve — is included: a channel the operator never touched has
 * nothing of its own to publish, and `simulationChannelFor` would otherwise
 * hand back the resting value as though it had been drawn.
 */
export function localCurvesToTelemetryChannels(
  settings: SimulationSettings,
): readonly TelemetryChannel[] {
  const named = new Set([
    ...readCurvePoints(settings.valueCurve).keys(),
    ...readCurvePoints(settings.criticalityCurve).keys(),
  ]);
  return [...named].sort().map((channel) => {
    const assembled = simulationChannelFor(settings, channel, simulationChannelRanges[channel]);
    return {
      sourceKey: channel,
      minimum: assembled.minimum,
      maximum: assembled.maximum,
      ...(assembled.valueCurve === undefined ? {} : { valueCurve: assembled.valueCurve }),
      ...(assembled.criticalityCurve === undefined
        ? {}
        : { criticalityCurve: assembled.criticalityCurve }),
      noise: assembled.noise,
      smoothing: assembled.smoothing,
      seed: toSafeSeed(assembled.seed),
    };
  });
}

/**
 * A published profile's channels, read back into this build's percentage-
 * of-range curve entries.
 *
 * A channel the profile names that this build's roster does not recognize —
 * `isSimulationChannelName` refuses it — is skipped rather than stored under
 * a key nothing reads: `simulationCurves.ts`'s parser already drops an entry
 * it cannot address, and doing the same filtering here keeps a caller from
 * ever seeing a channel name this schema will not round-trip.
 */
export function telemetryChannelsToLocalCurves(channels: readonly TelemetryChannel[]): {
  readonly valueCurve: readonly string[];
  readonly criticalityCurve: readonly string[];
} {
  let valueCurve: readonly string[] = [];
  let criticalityCurve: readonly string[] = [];
  for (const entry of [...channels].sort((left, right) =>
    left.sourceKey < right.sourceKey ? -1 : left.sourceKey > right.sourceKey ? 1 : 0,
  )) {
    if (!isSimulationChannelName(entry.sourceKey)) continue;
    const channel = entry.sourceKey;
    const range = simulationChannelRanges[channel];
    if (entry.valueCurve !== undefined) {
      const percent = absoluteToPercentPoints(entry.valueCurve.points, range);
      valueCurve = withChannelCurve(valueCurve, channel, percent);
    }
    if (entry.criticalityCurve !== undefined) {
      criticalityCurve = withChannelCurve(criticalityCurve, channel, entry.criticalityCurve.points);
    }
  }
  return { valueCurve, criticalityCurve };
}

/**
 * A fetched profile, ready to apply through `applySettingsPatch` — the same
 * use case every other settings edit goes through, so a curve pulled from the
 * group lands in the draft, the undo stack and the issue draft exactly as a
 * hand-drawn one would.
 *
 * This function computes the patch and nothing more; it does not call
 * `applySettingsPatch` itself; `apps/hq/src/application/` performs IO and
 * cross-region transitions, and a pure conversion carries no store reference
 * to do that with.
 */
export function telemetryProfileToSettingsPatch(
  profile: TelemetryProfile,
): readonly SettingsPatch[] {
  const local = telemetryChannelsToLocalCurves(profile.channels);
  return [
    { id: telemetryProfileSettingIds.valueCurve, value: local.valueCurve },
    { id: telemetryProfileSettingIds.criticalityCurve, value: local.criticalityCurve },
  ];
}

/**
 * This build's local `simulation.preset` value, read from a published
 * profile's reserved preset name.
 *
 * `apps/control-plane` writes `preset:<KIND>` for `ApplySimulationPreset` and
 * whatever name the operator chose for a hand-authored profile otherwise
 * (`readAuthoredProfile`, `presetProfileName`); only the reserved form maps
 * onto one of this build's nine presets, so a hand-authored profile answers
 * `undefined` rather than the meaningless `'normal'`.
 */
export function telemetryProfilePresetName(
  profile: TelemetryProfile,
): TelemetryPresetName | undefined {
  const prefixed = /^preset:(.+)$/u.exec(profile.name);
  const kind = prefixed?.[1] ?? profile.presetKind;
  return presetNameByWireName[kind];
}

const presetNameByWireName: Readonly<Record<string, TelemetryPresetName>> = {
  NORMAL: 'normal',
  ELEVATED: 'elevated',
  DEGRADED: 'degraded',
  CRITICAL: 'critical',
  INCIDENT: 'incident',
  RECOVERY: 'recovery',
  NETWORK_ATTACK: 'network-attack',
  STORAGE_EXHAUSTION: 'storage-exhaustion',
  CPU_OVERLOAD: 'cpu-overload',
};

function toSafeSeed(seed: bigint): number {
  const numeric = Number(seed);
  return Number.isSafeInteger(numeric) ? numeric : 0;
}
