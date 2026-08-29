import { describe, expect, it } from 'vitest';

import {
  withChannelCurve,
  type SimulationSettings,
} from '@/application/simulation/simulationCurves';
import type {
  TelemetryChannel,
  TelemetryProfile,
} from '@/infrastructure/controlPlane/TelemetryClient';

import {
  localCurvesToTelemetryChannels,
  telemetryChannelsToLocalCurves,
  telemetryProfilePresetName,
  telemetryProfileToSettingsPatch,
} from './profileSync';

function settings(overrides: Partial<SimulationSettings> = {}): SimulationSettings {
  return {
    channel: 'cpu',
    preset: 'normal',
    valueCurve: [],
    criticalityCurve: [],
    interpolation: 'linear',
    loop: false,
    periodSeconds: 60,
    updateIntervalMs: 1_000,
    timeScale: 1,
    noise: 0.2,
    smoothing: 0.1,
    seed: 42n,
    ...overrides,
  };
}

describe('localCurvesToTelemetryChannels', () => {
  it('publishes only the channels an operator actually drew', () => {
    const valueCurve = withChannelCurve([], 'cpu', [
      { time: 0, value: 0, inTangent: 0, outTangent: 0 },
      { time: 1, value: 100, inTangent: 0, outTangent: 0 },
    ]);

    const channels = localCurvesToTelemetryChannels(settings({ valueCurve }));

    expect(channels).toHaveLength(1);
    expect(channels[0]?.sourceKey).toBe('cpu');
  });

  it('converts a percent-of-range curve into the channel’s own units', () => {
    const valueCurve = withChannelCurve([], 'cpu', [
      { time: 0, value: 0, inTangent: 0, outTangent: 0 },
      { time: 1, value: 100, inTangent: 0, outTangent: 0 },
    ]);

    const [channel] = localCurvesToTelemetryChannels(settings({ valueCurve }));

    expect(channel?.minimum).toBe(12);
    expect(channel?.maximum).toBe(94);
    expect(channel?.valueCurve?.points[0]?.value).toBe(12);
    expect(channel?.valueCurve?.points[1]?.value).toBe(94);
  });

  it('sends this session’s noise, smoothing and seed on every published channel', () => {
    const valueCurve = withChannelCurve([], 'ram', [
      { time: 0, value: 50, inTangent: 0, outTangent: 0 },
      { time: 1, value: 50, inTangent: 0, outTangent: 0 },
    ]);

    const [channel] = localCurvesToTelemetryChannels(
      settings({ valueCurve, noise: 0.4, smoothing: 0.6, seed: 7n }),
    );

    expect(channel?.noise).toBe(0.4);
    expect(channel?.smoothing).toBe(0.6);
    expect(channel?.seed).toBe(7);
  });

  it('leaves a channel with nothing drawn out of the publish entirely', () => {
    expect(localCurvesToTelemetryChannels(settings())).toEqual([]);
  });
});

describe('telemetryChannelsToLocalCurves', () => {
  it('round-trips a value curve through absolute units and back to percent', () => {
    const valueCurve = withChannelCurve([], 'link-latency', [
      { time: 0, value: 0, inTangent: 0, outTangent: 0 },
      { time: 1, value: 50, inTangent: 0, outTangent: 0 },
    ]);
    const [published] = localCurvesToTelemetryChannels(settings({ valueCurve }));

    const local = telemetryChannelsToLocalCurves([published as TelemetryChannel]);

    expect(local.valueCurve).toEqual(valueCurve);
  });

  it('passes a criticality curve straight through, unscaled', () => {
    const criticalityCurve = withChannelCurve([], 'cpu', [
      { time: 0, value: 0.25, inTangent: 0, outTangent: 0 },
      { time: 1, value: 0.9, inTangent: 0, outTangent: 0 },
    ]);
    const [published] = localCurvesToTelemetryChannels(settings({ criticalityCurve }));

    const local = telemetryChannelsToLocalCurves([published as TelemetryChannel]);

    expect(local.criticalityCurve).toEqual(criticalityCurve);
  });

  it('drops a channel name this build’s roster does not recognize', () => {
    const foreign: TelemetryChannel = {
      sourceKey: 'not-a-real-channel',
      minimum: 0,
      maximum: 1,
      valueCurve: {
        points: [
          { time: 0, value: 0, inTangent: 0, outTangent: 0 },
          { time: 1, value: 1, inTangent: 0, outTangent: 0 },
        ],
        interpolation: 'linear',
        loop: false,
      },
      noise: 0,
      smoothing: 0,
      seed: 0,
    };

    expect(telemetryChannelsToLocalCurves([foreign])).toEqual({
      valueCurve: [],
      criticalityCurve: [],
    });
  });
});

describe('telemetryProfileToSettingsPatch', () => {
  it('names the two settings a fetched profile writes', () => {
    const profile: TelemetryProfile = {
      id: 'profile-a',
      groupId: 'group-a',
      name: 'preset:CRITICAL',
      presetKind: 'CRITICAL',
      channels: [],
      periodSeconds: 60,
      updateIntervalMs: 1_000,
      timeScale: 1,
      revision: 3,
      updatedAt: '',
    };

    const patch = telemetryProfileToSettingsPatch(profile);

    expect(patch.map((operation) => operation.id)).toEqual([
      'simulation.valueCurve',
      'simulation.criticalityCurve',
    ]);
  });
});

describe('telemetryProfilePresetName', () => {
  function profile(name: string, presetKind: string): TelemetryProfile {
    return {
      id: '',
      groupId: '',
      name,
      presetKind,
      channels: [],
      periodSeconds: 60,
      updateIntervalMs: 1_000,
      timeScale: 1,
      revision: 0,
      updatedAt: '',
    };
  }

  it('reads a preset name off the reserved profile name', () => {
    expect(
      telemetryProfilePresetName(profile('preset:STORAGE_EXHAUSTION', 'STORAGE_EXHAUSTION')),
    ).toBe('storage-exhaustion');
  });

  it('answers undefined for a hand-authored profile, never a made-up preset', () => {
    expect(telemetryProfilePresetName(profile('Ночная смена', 'CUSTOM'))).toBeUndefined();
  });
});
