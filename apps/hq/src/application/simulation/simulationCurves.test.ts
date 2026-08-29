import { curvePhaseAt, evaluateCurve } from '@gremuchaya/domain';
import {
  applyDraftPatch,
  createFactorySnapshot,
  createSettingsDraft,
  getSettingDefinition,
  maximumCurvePoints,
  simulationChannels,
  simulationPresets,
} from '@gremuchaya/settings-schema';
import { describe, expect, it } from 'vitest';

import {
  channelDomain,
  deterministicOffset,
  formatCurveNumber,
  presetCriticalityFor,
  readChannelCurve,
  readCurvePoints,
  readSimulationSettings,
  restingCurvePoints,
  sessionMetricChannels,
  sessionMetricNames,
  simulateChannelReading,
  simulationChannelFor,
  simulationChannelRanges,
  simulationPresetCriticality,
  withChannelCurve,
} from './simulationCurves';

const flat = { inTangent: 0, outTangent: 0 };

/** Runs a written curve through the schema's own validator, not a copy of it. */
const store = (id: string, value: unknown): readonly string[] => {
  const draft = applyDraftPatch(createSettingsDraft(createFactorySnapshot()), [{ id, value }], {
    id: 'curve-1',
    at: '2026-08-26T09:00:00.000Z',
  });
  const stored = draft.values[id];
  if (!Array.isArray(stored)) throw new Error(`${id} did not store a list`);
  return stored;
};

describe('reading stored curve entries', () => {
  it('groups points by the channel each entry names', () => {
    const points = readCurvePoints([
      'cpu=0,20,0,0',
      'cpu=1,80,0,0',
      'link-latency=0.5,40,1.5,-1.5',
    ]);

    expect(points.get('cpu')).toEqual([
      { time: 0, value: 20, ...flat },
      { time: 1, value: 80, ...flat },
    ]);
    expect(points.get('link-latency')).toEqual([
      { time: 0.5, value: 40, inTangent: 1.5, outTangent: -1.5 },
    ]);
    expect(points.get('ram')).toBeUndefined();
  });

  it('sorts a channel’s points and keeps the last of two at one time', () => {
    // The domain's own rule, applied on the way in: an editor dragging a curve
    // and the simulation reading it have to agree on which point holds at a
    // contested time.
    const points = readCurvePoints(['cpu=1,80,0,0', 'cpu=0.5,10,0,0', 'cpu=0.5,60,0,0']);

    expect(points.get('cpu')).toEqual([
      { time: 0.5, value: 60, ...flat },
      { time: 1, value: 80, ...flat },
    ]);
  });

  it.each([
    ['no channel separator', 'cpu:0.5,20,0,0'],
    ['a channel outside the declared roster', 'disk=0.5,20,0,0'],
    ['too few coordinates', 'cpu=0.5,20,0'],
    ['too many coordinates', 'cpu=0.5,20,0,0,0'],
    ['a coordinate that is not a number', 'cpu=0.5,twenty,0,0'],
    ['an empty coordinate', 'cpu=0.5,,0,0'],
    ['an infinite coordinate', 'cpu=0.5,Infinity,0,0'],
  ])('skips an entry with %s rather than losing the rest of the curve', (_reason, broken) => {
    /*
     * Lenient where the validator is strict, and deliberately: this runs over
     * whatever a persisted blob from an older build holds, and one stale entry
     * must not cost the operator the points around it.
     *
     * Every fixture sits at its own time rather than on top of a good point.
     * On top of one, an entry wrongly accepted would be deduplicated away and
     * the count would still read two — the assertion would then pass over the
     * very acceptance it exists to refuse.
     */
    const points = readCurvePoints(['cpu=0,20,0,0', broken, 'cpu=1,80,0,0']);

    expect(points.get('cpu')).toEqual([
      { time: 0, value: 20, ...flat },
      { time: 1, value: 80, ...flat },
    ]);
    // And the map holds no channel the roster does not name: a skipped entry
    // that quietly opened a key of its own would be a `SimulationChannelName`
    // this map claims to be keyed by and is not.
    expect([...points.keys()]).toEqual(['cpu']);
  });

  it('reports no curve at all for a channel nothing was drawn for', () => {
    // Absence is not an emptiness: `channelValue` reads the middle of the range
    // when it is handed no curve, and "not scripted" has to stay distinct from
    // "scripted to sit at zero".
    const shape = { interpolation: 'linear', loop: false } as const;

    expect(readChannelCurve(['cpu=0,20,0,0'], 'ram', shape)).toBeUndefined();
    expect(readChannelCurve([], 'cpu', shape)).toBeUndefined();
    expect(readChannelCurve(['cpu=0,20,0,0'], 'cpu', shape)).toEqual({
      points: [{ time: 0, value: 20, ...flat }],
      interpolation: 'linear',
      loop: false,
    });
  });
});

describe('writing curve entries back', () => {
  it('round-trips a curve through the form the schema validates', () => {
    const points = [
      { time: 0, value: 20, ...flat },
      { time: 0.25, value: 88.25, inTangent: -12.5, outTangent: 3 },
      { time: 1, value: 20, ...flat },
    ];
    const written = withChannelCurve([], 'cpu', points);

    expect(written).toEqual(['cpu=0,20,0,0', 'cpu=0.25,88.25,-12.5,3', 'cpu=1,20,0,0']);
    // Written, then accepted by the definition's own validator, then read back
    // as the points that were written. A copy of the pattern in this file would
    // prove only that the copy agrees with itself.
    expect(readCurvePoints(store('simulation.valueCurve', written)).get('cpu')).toEqual(points);
  });

  it('leaves every other channel’s points alone', () => {
    const existing = ['cpu=0,20,0,0', 'ram=0,40,0,0', 'ram=1,60,0,0'];
    const written = withChannelCurve(existing, 'cpu', [{ time: 0.5, value: 70, ...flat }]);

    expect(written).toEqual(['cpu=0.5,70,0,0', 'ram=0,40,0,0', 'ram=1,60,0,0']);
  });

  it('drops a channel entirely when its last point goes', () => {
    expect(withChannelCurve(['cpu=0,20,0,0', 'ram=0,40,0,0'], 'cpu', [])).toEqual(['ram=0,40,0,0']);
  });

  it('writes channels in ascending order whatever order they arrived in', () => {
    // The canonical order is what makes two lists describing one curve the same
    // list, so undo and the issue draft treat a curve as a single value.
    const written = withChannelCurve(['ram=0,40,0,0'], 'cpu', [{ time: 0, value: 20, ...flat }]);

    expect(written).toEqual(['cpu=0,20,0,0', 'ram=0,40,0,0']);
    expect(store('simulation.valueCurve', written)).toEqual(written);
  });

  it('rounds to the stored precision before deciding two points are one', () => {
    // Two points a millionth of a period apart are one point once written.
    // Normalizing first would leave the validator to refuse a duplicate time
    // this side had already produced.
    const written = withChannelCurve([], 'cpu', [
      { time: 0.3, value: 10, ...flat },
      { time: 0.30000004, value: 90, ...flat },
      { time: 1, value: 50, ...flat },
    ]);

    expect(written).toEqual(['cpu=0.3,90,0,0', 'cpu=1,50,0,0']);
    expect(store('simulation.valueCurve', written)).toEqual(written);
  });

  it('writes what a snapped drag produces without a floating-point tail', () => {
    const dragged = Array.from({ length: 4 }, (_unused, index) => ({
      time: Math.round((index * 0.29) / 0.01) * 0.01,
      value: 10,
      ...flat,
    }));

    expect(withChannelCurve([], 'cpu', dragged)).toEqual([
      'cpu=0,10,0,0',
      'cpu=0.29,10,0,0',
      'cpu=0.58,10,0,0',
      'cpu=0.87,10,0,0',
    ]);
  });

  it.each([
    ['negative zero', -0, '0'],
    ['a floating-point tail', 0.1 + 0.2, '0.3'],
    ['more precision than an entry carries', 1 / 3, '0.333333'],
    ['a trailing zero', 88.2, '88.2'],
    ['a whole number', 42, '42'],
    ['a value below the stored precision', 0.0000001, '0'],
  ])('spells %s canonically', (_reason, value, expected) => {
    expect(formatCurveNumber(value)).toBe(expected);
  });

  it('produces a full-length curve the schema still accepts', () => {
    const points = Array.from({ length: maximumCurvePoints }, (_unused, index) => ({
      time: index / 1_000,
      value: 20,
      ...flat,
    }));

    expect(store('simulation.valueCurve', withChannelCurve([], 'cpu', points))).toHaveLength(
      maximumCurvePoints,
    );
  });
});

describe('the curve the domain evaluator reads', () => {
  const shape = (interpolation: 'linear' | 'step' | 'hermite', loop: boolean) =>
    ({ interpolation, loop }) as const;
  const ramp = ['cpu=0,0,0,0', 'cpu=1,100,0,0'];

  it('reads a linear curve at known phases', () => {
    const curve = readChannelCurve(ramp, 'cpu', shape('linear', false));

    expect(evaluateCurve(curve, 0)).toBe(0);
    expect(evaluateCurve(curve, 0.25)).toBe(25);
    expect(evaluateCurve(curve, 0.5)).toBe(50);
    expect(evaluateCurve(curve, 1)).toBe(100);
  });

  it('holds a non-looping curve at its ends and wraps a looping one', () => {
    expect(evaluateCurve(readChannelCurve(ramp, 'cpu', shape('linear', false)), 1.25)).toBe(100);
    expect(evaluateCurve(readChannelCurve(ramp, 'cpu', shape('linear', true)), 1.25)).toBe(25);
    // A negative phase wraps forwards into the span rather than extrapolating.
    expect(evaluateCurve(readChannelCurve(ramp, 'cpu', shape('linear', true)), -0.25)).toBe(75);
  });

  it('holds the earlier point across a step segment', () => {
    expect(evaluateCurve(readChannelCurve(ramp, 'cpu', shape('step', false)), 0.9)).toBe(0);
  });

  it('carries the stored tangents into a hermite reading', () => {
    // The tangents are the operator's, so a hermite curve through the same two
    // points reads differently from a straight line between them.
    const bowed = ['cpu=0,0,0,60', 'cpu=1,100,60,0'];
    const curve = readChannelCurve(bowed, 'cpu', shape('hermite', false));

    // Tangents of 60 are shallower than the chord's own slope of 100, so the
    // curve leaves the first point slower than a straight line would and is
    // below it at a quarter of the way across. A linear reading there is 25.
    expect(evaluateCurve(curve, 0.5)).toBeCloseTo(50, 10);
    expect(evaluateCurve(curve, 0.25)).toBeCloseTo(21.25, 10);
    expect(evaluateCurve(readChannelCurve(bowed, 'cpu', shape('linear', false)), 0.25)).toBe(25);
  });
});

describe('assembling a channel for the simulation', () => {
  const settings = (values: Record<string, unknown>) =>
    readSimulationSettings({
      'simulation.interpolation': 'linear',
      'simulation.loop': false,
      'simulation.noise': 0,
      'simulation.smoothing': 0,
      ...values,
    } as Parameters<typeof readSimulationSettings>[0]);

  const cpuRange = { minimum: 12, maximum: 94 };

  it('reads the value curve as a percentage of the channel’s own range', () => {
    // One curve has to read the same on processor load and on link latency,
    // which have nothing in common but a range.
    const channel = simulationChannelFor(
      settings({ 'simulation.valueCurve': ['cpu=0,0,0,0', 'cpu=1,100,0,0'] }),
      'cpu',
      cpuRange,
    );

    expect(evaluateCurve(channel.valueCurve, 0)).toBe(12);
    expect(evaluateCurve(channel.valueCurve, 0.5)).toBe(53);
    expect(evaluateCurve(channel.valueCurve, 1)).toBe(94);
  });

  it('scales the tangents with the values, because a tangent is value per time', () => {
    const channel = simulationChannelFor(
      settings({ 'simulation.valueCurve': ['cpu=0,0,0,100', 'cpu=1,100,50,0'] }),
      'cpu',
      cpuRange,
    );

    expect(channel.valueCurve?.points[0]?.outTangent).toBeCloseTo(82, 10);
    expect(channel.valueCurve?.points[1]?.inTangent).toBeCloseTo(41, 10);
  });

  it('leaves the criticality curve on its own scale, which the evaluator reads directly', () => {
    const channel = simulationChannelFor(
      settings({ 'simulation.criticalityCurve': ['cpu=0,0,0,0', 'cpu=1,1,0,0'] }),
      'cpu',
      cpuRange,
    );

    expect(evaluateCurve(channel.criticalityCurve, 0.5)).toBe(0.5);
  });

  it('omits a curve for a channel nothing was drawn for', () => {
    const channel = simulationChannelFor(
      settings({ 'simulation.valueCurve': ['cpu=0,0,0,0', 'cpu=1,100,0,0'] }),
      'ram',
      cpuRange,
    );

    expect(channel.valueCurve).toBeUndefined();
    expect(channel.criticalityCurve).toBeUndefined();
  });
});

describe('one reading and the band it falls in', () => {
  const range = { minimum: 0, maximum: 100 };
  const full = ['cpu=0,100,0,0', 'cpu=1,100,0,0'];
  const settings = (criticality: readonly string[]) =>
    readSimulationSettings({
      'simulation.interpolation': 'linear',
      'simulation.loop': false,
      'simulation.noise': 0,
      'simulation.smoothing': 0,
      'simulation.valueCurve': full,
      'simulation.criticalityCurve': criticality,
    } as Parameters<typeof readSimulationSettings>[0]);

  it('caps the reading at the height the criticality curve allows', () => {
    // This is what R31 means by the second curve deciding how high values may
    // go: it is the ceiling the first is clamped to, not a second reading.
    const capped = simulateChannelReading(
      settings(['cpu=0,0.25,0,0', 'cpu=1,0.25,0,0']),
      'cpu',
      range,
      0.5,
      0,
      undefined,
    );

    expect(capped.value).toBe(25);
    expect(capped.severity).toBe('elevated');
  });

  it('does not cap a channel that has no criticality curve', () => {
    // A missing ceiling is not a low one.
    const uncapped = simulateChannelReading(settings([]), 'cpu', range, 0.5, 0, undefined);

    expect(uncapped.value).toBe(100);
    expect(uncapped.severity).toBe('normal');
  });

  it.each([
    [0.1, 'normal'],
    [0.3, 'elevated'],
    [0.6, 'degraded'],
    [0.9, 'critical'],
  ])('reports criticality %s as %s', (level, expected) => {
    const reading = simulateChannelReading(
      settings([`cpu=0,${String(level)},0,0`, `cpu=1,${String(level)},0,0`]),
      'cpu',
      range,
      0.5,
      0,
      undefined,
    );

    expect(reading.severity).toBe(expected);
    expect(reading.value).toBeCloseTo(level * 100, 10);
  });

  it('hands the resolved settings to the domain’s phase formula unchanged', () => {
    /*
     * The formula itself is pinned in `@gremuchaya/domain`, which is where it
     * lives now, and this checks the other half: that the record
     * `readSimulationSettings` produces is a `CurveTimelineLike` the shared
     * function reads directly. A conversion here would be a second place for
     * the two sides to drift.
     */
    const timed = readSimulationSettings({
      'simulation.periodSeconds': 60,
      'simulation.timeScale': 2,
    } as Parameters<typeof readSimulationSettings>[0]);

    expect(curvePhaseAt(timed, 30_000)).toBe(1);
    expect(curvePhaseAt(timed, 0)).toBe(0);
    expect(curvePhaseAt(timed, 7_500)).toBe(0.25);
  });
});

describe('resolving the simulation settings', () => {
  it('falls back to the schema’s own defaults rather than to literals here', () => {
    const resolved = readSimulationSettings({});

    expect(resolved.channel).toBe(getSettingDefinition('simulation.channel')?.defaultValue);
    expect(resolved.preset).toBe(getSettingDefinition('simulation.preset')?.defaultValue);
    expect(resolved.interpolation).toBe(
      getSettingDefinition('simulation.interpolation')?.defaultValue,
    );
    expect(resolved.loop).toBe(getSettingDefinition('simulation.loop')?.defaultValue);
    expect(resolved.periodSeconds).toBe(
      getSettingDefinition('simulation.periodSeconds')?.defaultValue,
    );
    expect(resolved.updateIntervalMs).toBe(
      getSettingDefinition('simulation.updateIntervalMs')?.defaultValue,
    );
    expect(resolved.timeScale).toBe(getSettingDefinition('simulation.timeScale')?.defaultValue);
    expect(resolved.noise).toBe(getSettingDefinition('simulation.noise')?.defaultValue);
    expect(resolved.smoothing).toBe(getSettingDefinition('simulation.smoothing')?.defaultValue);
    expect(resolved.seed).toBe(
      BigInt(Number(getSettingDefinition('simulation.seed')?.defaultValue)),
    );
    expect(resolved.valueCurve).toEqual([]);
  });

  it('falls back for a persisted value of the wrong type, which storage never revalidates', () => {
    const resolved = readSimulationSettings({
      'simulation.channel': 'disk',
      'simulation.preset': 'apocalypse',
      'simulation.interpolation': 'catmull-rom',
      'simulation.periodSeconds': 'soon',
      'simulation.valueCurve': 'cpu=0,20,0,0',
    } as unknown as Parameters<typeof readSimulationSettings>[0]);

    expect(resolved.channel).toBe('cpu');
    expect(resolved.preset).toBe('normal');
    expect(resolved.interpolation).toBe('linear');
    expect(resolved.periodSeconds).toBe(60);
    expect(resolved.valueCurve).toEqual([]);
  });

  it('starts an undrawn channel on the flat line the schema declares', () => {
    const editor = getSettingDefinition('simulation.criticalityCurve')?.editor;
    if (editor?.kind !== 'curve') throw new Error('the criticality curve is not a curve editor');

    expect(restingCurvePoints(editor.timeDomain, editor.restingValue)).toEqual([
      { time: 0, value: 0, ...flat },
      { time: 1, value: 0, ...flat },
    ]);
  });
});

describe('the bounds a channel’s readings live inside', () => {
  it('covers every channel the roster declares, and nothing else', () => {
    // The table is what the ranges became instead of twenty-four settings. A
    // channel missing from it is a channel the simulation cannot read at all,
    // and one left in it after the roster drops it is a range for nothing.
    expect(Object.keys(simulationChannelRanges).sort()).toEqual([...simulationChannels].sort());
  });

  it('gives every channel a span wide enough to show a curve on', () => {
    for (const [channel, range] of Object.entries(simulationChannelRanges)) {
      expect(range.maximum, channel).toBeGreaterThan(range.minimum);
      // A channel whose whole range rounds to a couple of units is a channel
      // whose curve cannot be seen: every reading lands on the same number and
      // the operator's drag changes nothing on any screen.
      expect(range.maximum - range.minimum, channel).toBeGreaterThanOrEqual(10);
    }
  });

  it('hands a chart the channel’s own bounds rather than the last minute’s', () => {
    expect(channelDomain('cpu')).toEqual([
      simulationChannelRanges.cpu.minimum,
      simulationChannelRanges.cpu.maximum,
    ]);
  });

  it('names a channel of the roster for every session counter', () => {
    for (const name of sessionMetricNames) {
      expect(simulationChannelRanges[sessionMetricChannels[name]], name).toBeDefined();
    }
    expect(Object.keys(sessionMetricChannels).sort()).toEqual([...sessionMetricNames].sort());
  });
});

describe('the offset the parts of the world with no channel take', () => {
  it('stays inside [-1, 1] and depends on the seed', () => {
    const first = deterministicOffset(7n, 3);
    expect(first).toBeGreaterThanOrEqual(-1);
    expect(first).toBeLessThanOrEqual(1);
    expect(deterministicOffset(8n, 3)).not.toBe(first);
    expect(deterministicOffset(7n, 4)).not.toBe(first);
    expect(deterministicOffset(7n, 3)).toBe(first);
  });
});

describe('the named preset a marked simulation stands for', () => {
  const range = { minimum: 0, maximum: 100 };
  const settingsFor = (preset: string) =>
    readSimulationSettings({
      'simulation.preset': preset,
      'simulation.interpolation': 'linear',
      'simulation.loop': false,
      'simulation.noise': 0,
      'simulation.smoothing': 0,
    } as Parameters<typeof readSimulationSettings>[0]);

  it('reads simulation.preset into the resolved settings', () => {
    expect(settingsFor('critical').preset).toBe('critical');
  });

  it('leaves the world exactly as an unmarked simulation reads it', () => {
    // `normal` supplies no baseline for any channel: it is not a fourth
    // uniform level beside `elevated`/`degraded`/`critical`, it is the
    // absence of one.
    expect(simulationPresetCriticality.normal).toEqual({});
    const reading = simulateChannelReading(settingsFor('normal'), 'cpu', range, 0.5, 0, undefined);
    expect(reading.severity).toBe('normal');
    expect(reading.value).toBe(50);
  });

  it('changes an undrawn channel’s reading deterministically when the preset changes', () => {
    // The whole point of R31's reader: an operator who only ever moves
    // `simulation.preset` still gets a different, reproducible world.
    const normal = simulateChannelReading(settingsFor('normal'), 'cpu', range, 0.5, 3, undefined);
    const critical = simulateChannelReading(
      settingsFor('critical'),
      'cpu',
      range,
      0.5,
      3,
      undefined,
    );

    expect(critical.severity).toBe('critical');
    expect(critical.value).not.toBe(normal.value);
    expect(normal.severity).toBe('normal');

    // Determinism: the same preset, phase and index reads back the same
    // value and severity on a second, independent call.
    expect(
      simulateChannelReading(settingsFor('critical'), 'cpu', range, 0.5, 3, undefined),
    ).toEqual(critical);
  });

  it('marks each of the four uniform presets on the severity band its name is', () => {
    const bandOf = (preset: string) =>
      simulateChannelReading(settingsFor(preset), 'ram', range, 0.5, 1, undefined).severity;

    expect(bandOf('normal')).toBe('normal');
    expect(bandOf('elevated')).toBe('elevated');
    expect(bandOf('degraded')).toBe('degraded');
    expect(bandOf('critical')).toBe('critical');
    // `incident` sits inside the same top band as `critical`, at a higher
    // criticality than the `critical` preset's own.
    expect(bandOf('incident')).toBe('critical');
    expect(presetCriticalityFor('incident', 'ram') as number).toBeGreaterThan(
      presetCriticalityFor('critical', 'ram') as number,
    );
    // `recovery` stays inside `normal`, low but not the plain absence a
    // curveless, presetless reading would be.
    expect(bandOf('recovery')).toBe('normal');
    expect(presetCriticalityFor('recovery', 'ram')).toBeGreaterThan(0);
  });

  it('touches only the channels a scenario preset names, leaving the rest unmarked', () => {
    // `network-attack` names the comms channels; a channel outside that
    // scenario, such as `storage`, is read exactly as `normal` reads it.
    expect(presetCriticalityFor('network-attack', 'link-latency')).toBeGreaterThan(0.5);
    expect(presetCriticalityFor('network-attack', 'storage')).toBeUndefined();

    const untouched = simulateChannelReading(
      settingsFor('network-attack'),
      'storage',
      range,
      0.5,
      2,
      undefined,
    );
    expect(untouched.severity).toBe('normal');
    expect(untouched.value).toBe(50);

    const attacked = simulateChannelReading(
      settingsFor('network-attack'),
      'link-latency',
      range,
      0.5,
      2,
      undefined,
    );
    expect(attacked.severity).toBe('critical');
  });

  it('never overrides a criticality curve the operator actually drew', () => {
    // A preset marks the world; an operator's own curve on one channel is
    // never second-guessed by whichever preset happens to be marked with it.
    const drawn = readSimulationSettings({
      'simulation.preset': 'critical',
      'simulation.interpolation': 'linear',
      'simulation.loop': false,
      'simulation.noise': 0,
      'simulation.smoothing': 0,
      'simulation.criticalityCurve': ['cpu=0,0.1,0,0', 'cpu=1,0.1,0,0'],
    } as Parameters<typeof readSimulationSettings>[0]);

    const reading = simulateChannelReading(drawn, 'cpu', range, 0.5, 0, undefined);
    expect(reading.severity).toBe('normal');
    // Ceiling 10 (10% of the 0–100 range at criticality 0.1), midpoint 5
    // since no value curve is drawn either.
    expect(reading.value).toBeCloseTo(5, 10);
  });

  it('declares a baseline table for exactly the declared presets', () => {
    expect(Object.keys(simulationPresetCriticality).sort()).toEqual([...simulationPresets].sort());
  });

  it('names only channels the roster declares', () => {
    for (const [preset, baseline] of Object.entries(simulationPresetCriticality)) {
      for (const channel of Object.keys(baseline)) {
        expect(
          (simulationChannels as readonly string[]).includes(channel),
          `${preset}.${channel}`,
        ).toBe(true);
      }
    }
  });
});
