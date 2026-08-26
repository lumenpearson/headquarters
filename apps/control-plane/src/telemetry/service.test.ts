import { create } from '@bufbuild/protobuf';
import { channelValue, curvePhaseAt, type SimulationChannelLike } from '@gremuchaya/domain';
import { telemetryV1 } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import { previewSnapshots } from './service.js';

/*
 * An operator judges a curve by the preview this endpoint returns and then
 * watches that curve drive a screen through the client's own simulation. The
 * two are worth comparing only if they are the same arithmetic — not the same
 * arithmetic written twice, which agrees until the day one copy is edited.
 *
 * These cases pin the agreement at the place it can break: the phase. The
 * expected readings are computed here through `@gremuchaya/domain`, the module
 * the client also runs on, so a phase the control plane derives its own way
 * fails them however plausible its formula looks.
 *
 * No database is involved. The preview is a pure function of the profile, the
 * sample count and the capture moment, which is why it can be proved in a suite
 * CI actually runs — the live-PostgreSQL suite beside it never runs there.
 */
describe('simulation profile preview', () => {
  it('reads a channel at the phase the shared curve function gives', () => {
    const profile = previewProfile();

    const snapshots = previewSnapshots(profile, 6, capturedAt);

    let previous: number | undefined;
    const expected = Array.from({ length: 6 }, (_unused, index) => {
      const phase = curvePhaseAt({ periodSeconds: 120, timeScale: 2 }, index * 250);
      const value = channelValue(channel, phase, index, previous);
      previous = value;
      return value;
    });
    expect(snapshots.map((snapshot) => snapshot.samples[0]?.value)).toEqual(expected);
  });

  it('scales the timeline by `time_scale`, so a doubled scale reaches a phase in half the time', () => {
    // The same phase per sample index from two different profiles: doubling the
    // scale and halving the interval leaves `elapsed × scale` unchanged. Noise
    // comes from the seed and the index, both untouched, so the readings must
    // match exactly — which they cannot if the scale is dropped from the phase.
    const fast = previewSnapshots(
      previewProfile({ timeScale: 4, updateIntervalMs: 125 }),
      6,
      capturedAt,
    );
    const slow = previewSnapshots(
      previewProfile({ timeScale: 2, updateIntervalMs: 250 }),
      6,
      capturedAt,
    );

    expect(fast.map((snapshot) => snapshot.samples[0]?.value)).toEqual(
      slow.map((snapshot) => snapshot.samples[0]?.value),
    );
  });

  it('substitutes its own minute for a period the client left at the proto3 default', () => {
    // The shared function stands one second in for a non-positive period, which
    // is the shortest the schema allows. This endpoint has a better default of
    // its own — a minute — and applies it *before* calling, which is what the
    // shared function's contract asks a caller with a default to do. Asserting
    // the minute rather than the second is what keeps the two rules from
    // quietly becoming one.
    const defaulted = previewSnapshots(previewProfile({ periodSeconds: 0 }), 4, capturedAt);

    let previous: number | undefined;
    const expected = Array.from({ length: 4 }, (_unused, index) => {
      const phase = curvePhaseAt({ periodSeconds: 60, timeScale: 2 }, index * 250);
      const value = channelValue(channel, phase, index, previous);
      previous = value;
      return value;
    });
    expect(defaulted.map((snapshot) => snapshot.samples[0]?.value)).toEqual(expected);
    // And not the second the shared function would have used on its own.
    const asIfOneSecond = channelValue(
      channel,
      curvePhaseAt({ periodSeconds: 1, timeScale: 2 }, 250),
      1,
      defaulted[0]?.samples[0]?.value,
    );
    expect(defaulted[1]?.samples[0]?.value).not.toBe(asIfOneSecond);
  });
});

const capturedAt = new Date('2026-08-26T09:00:00.000Z');

/** The channel above, as the domain sees it after the enum mapping. */
const channel: SimulationChannelLike = {
  minimum: 0,
  maximum: 100,
  noise: 0.05,
  smoothing: 0.4,
  seed: 42n,
  valueCurve: {
    interpolation: 'hermite',
    loop: true,
    points: [
      { time: 0, value: 12, inTangent: 0, outTangent: 40 },
      { time: 1, value: 96, inTangent: 10, outTangent: 0 },
    ],
  },
  criticalityCurve: {
    interpolation: 'linear',
    loop: false,
    points: [
      { time: 0, value: 0.1, inTangent: 0, outTangent: 0 },
      { time: 1, value: 0.9, inTangent: 0, outTangent: 0 },
    ],
  },
};

function previewProfile(
  overrides: Partial<
    Pick<telemetryV1.SimulationProfile, 'periodSeconds' | 'updateIntervalMs' | 'timeScale'>
  > = {},
): telemetryV1.SimulationProfile {
  return create(telemetryV1.SimulationProfileSchema, {
    groupId: { value: '018b2a02-0000-7000-8000-000000000001' },
    name: 'Проба',
    presetKind: telemetryV1.SimulationPresetKind.CPU_OVERLOAD,
    periodSeconds: 120,
    updateIntervalMs: 250,
    timeScale: 2,
    ...overrides,
    channels: [
      {
        sourceId: { value: 'cpu.total' },
        minimum: channel.minimum,
        maximum: channel.maximum,
        noise: channel.noise,
        smoothing: channel.smoothing,
        seed: channel.seed,
        valueCurve: {
          interpolation: telemetryV1.CurveInterpolation.HERMITE,
          loop: true,
          points: [
            { time: 0, value: 12, inTangent: 0, outTangent: 40 },
            { time: 1, value: 96, inTangent: 10, outTangent: 0 },
          ],
        },
        criticalityCurve: {
          interpolation: telemetryV1.CurveInterpolation.LINEAR,
          loop: false,
          points: [
            { time: 0, value: 0.1, inTangent: 0, outTangent: 0 },
            { time: 1, value: 0.9, inTangent: 0, outTangent: 0 },
          ],
        },
      },
    ],
  });
}
