import { describe, expect, it } from 'vitest';

import {
  channelSeverity,
  channelValue,
  clampNumber,
  curvePhaseAt,
  deterministicUnit,
  evaluateCurve,
  monotoneTangents,
  normalizeCurvePoints,
  positiveRemainder,
  sampleCurve,
  type CurveInterpolationKind,
  type CurvePointLike,
  type SimulationChannelLike,
  type SimulationCurveLike,
} from './simulationCurve.js';

function point(
  time: number,
  value: number,
  tangents: { readonly in?: number; readonly out?: number } = {},
): CurvePointLike {
  return { time, value, inTangent: tangents.in ?? 0, outTangent: tangents.out ?? 0 };
}

function curve(
  points: readonly CurvePointLike[],
  interpolation: CurveInterpolationKind = 'linear',
  loop = false,
): SimulationCurveLike {
  return { points, interpolation, loop };
}

/** A rise from 0 to 10 over one unit of time; the segment the four kinds are read on. */
const rise = [point(0, 0), point(1, 10)];

describe('normalizeCurvePoints', () => {
  it('sorts by time without touching the points themselves', () => {
    const late = point(2, 20);
    const early = point(0, 0);
    const middle = point(1, 10);
    expect(normalizeCurvePoints([late, early, middle])).toEqual([early, middle, late]);
  });

  it('keeps the last of the points that share a time', () => {
    const normalized = normalizeCurvePoints([point(1, 1), point(0, 0), point(1, 2), point(1, 3)]);
    expect(normalized).toEqual([point(0, 0), point(1, 3)]);
  });

  it('leaves an empty list empty', () => {
    expect(normalizeCurvePoints([])).toEqual([]);
  });
});

describe('evaluateCurve', () => {
  it('answers undefined for no curve and for an empty curve', () => {
    expect(evaluateCurve(undefined, 0.5)).toBeUndefined();
    expect(evaluateCurve(curve([]), 0.5)).toBeUndefined();
  });

  it('holds a single point everywhere on the timeline', () => {
    const single = curve([point(3, 7)]);
    expect(evaluateCurve(single, -100)).toBe(7);
    expect(evaluateCurve(single, 3)).toBe(7);
    expect(evaluateCurve(single, 100)).toBe(7);
  });

  it('reads a linear segment as a straight line', () => {
    const linear = curve(rise, 'linear');
    expect(evaluateCurve(linear, 0.25)).toBe(2.5);
    expect(evaluateCurve(linear, 0.5)).toBe(5);
    expect(evaluateCurve(linear, 0.75)).toBe(7.5);
  });

  it('reads a step segment as the value of the point it left', () => {
    const step = curve([...rise, point(2, 20)], 'step');
    expect(evaluateCurve(step, 0.5)).toBe(0);
    expect(evaluateCurve(step, 0.999)).toBe(0);
    expect(evaluateCurve(step, 1)).toBe(10);
    expect(evaluateCurve(step, 1.5)).toBe(10);
    expect(evaluateCurve(step, 2)).toBe(20);
  });

  it('reads a hermite segment from its end tangents', () => {
    // Zero tangents at both ends give the smoothstep 3p² - 2p³, scaled by the rise.
    const flat = curve(rise, 'hermite');
    expect(evaluateCurve(flat, 0.5)).toBe(5);
    expect(evaluateCurve(flat, 0.25)).toBeCloseTo(10 * (3 * 0.0625 - 2 * 0.015625), 12);
    // A tangent equal to the secant slope at both ends is the straight line again.
    const secant = curve([point(0, 0, { out: 10 }), point(1, 10, { in: 10 })], 'hermite');
    expect(evaluateCurve(secant, 0.25)).toBeCloseTo(2.5, 12);
    expect(evaluateCurve(secant, 0.75)).toBeCloseTo(7.5, 12);
    // A segment two units long scales the tangent by its length.
    const long = curve([point(0, 0, { out: 5 }), point(2, 10, { in: 5 })], 'hermite');
    expect(evaluateCurve(long, 1)).toBeCloseTo(5, 12);
  });

  it('reads a bezier segment from control points a third of the way out', () => {
    // With the start tangent at 30 and a flat end, the start control point sits
    // at 10 and the curve leaves faster than the line.
    const eager = curve([point(0, 0, { out: 30 }), point(1, 10)], 'bezier');
    // (1-p)³·0 + 3(1-p)²p·10 + 3(1-p)p²·10 + p³·10 at p = 0.5
    expect(evaluateCurve(eager, 0.5)).toBeCloseTo(
      3 * 0.25 * 0.5 * 10 + 3 * 0.5 * 0.25 * 10 + 0.125 * 10,
      12,
    );
    expect(evaluateCurve(eager, 0.5)).toBeGreaterThan(5);
  });

  it('agrees between hermite and bezier when the tangents are the same', () => {
    const points = [point(0, 1, { out: 4 }), point(1.5, 6, { in: -2 })];
    for (let step = 0; step <= 20; step += 1) {
      const phase = (1.5 * step) / 20;
      expect(evaluateCurve(curve(points, 'hermite'), phase)).toBeCloseTo(
        evaluateCurve(curve(points, 'bezier'), phase) ?? Number.NaN,
        12,
      );
    }
  });

  it('holds the nearest end outside the span of a curve that does not loop', () => {
    const held = curve(rise, 'linear', false);
    expect(evaluateCurve(held, -1)).toBe(0);
    expect(evaluateCurve(held, 0)).toBe(0);
    expect(evaluateCurve(held, 1)).toBe(10);
    expect(evaluateCurve(held, 7)).toBe(10);
  });

  it('wraps a looping curve over its own span, backwards too', () => {
    const looping = curve([point(1, 0), point(3, 10)], 'linear', true);
    expect(evaluateCurve(looping, 2)).toBe(5);
    expect(evaluateCurve(looping, 4)).toBe(5);
    expect(evaluateCurve(looping, 3.5)).toBe(2.5);
    expect(evaluateCurve(looping, -0.5)).toBe(2.5);
    // The end of the span is the start of the next lap.
    expect(evaluateCurve(looping, 3)).toBe(0);
  });

  it('holds a looping curve of one distinct time like a single point', () => {
    const degenerate = curve([point(2, 4), point(2, 6)], 'linear', true);
    expect(evaluateCurve(degenerate, 0)).toBe(6);
    expect(evaluateCurve(degenerate, 9)).toBe(6);
  });

  it('reads unsorted input the same as sorted input', () => {
    const sorted = curve([point(0, 0), point(1, 10), point(2, 0)], 'hermite');
    const shuffled = curve([point(2, 0), point(0, 0), point(1, 10)], 'hermite');
    for (const phase of [-1, 0, 0.3, 1, 1.7, 2, 5]) {
      expect(evaluateCurve(shuffled, phase)).toBe(evaluateCurve(sorted, phase));
    }
  });

  it('lets the last of two points at one time win on both sides of it', () => {
    const duplicated = curve([point(0, 0), point(1, 4), point(1, 8), point(2, 8)], 'linear');
    expect(evaluateCurve(duplicated, 0.5)).toBe(4);
    expect(evaluateCurve(duplicated, 1)).toBe(8);
    expect(evaluateCurve(duplicated, 1.5)).toBe(8);
  });

  it('is exact where the arithmetic is exact', () => {
    // The server's preview relied on these readings; the shared evaluator must
    // not drift from them by so much as a rounding.
    const hermite = curve(
      [point(0, 12, { out: 40 }), point(1, 96, { in: 10, out: 0 })],
      'hermite',
      true,
    );
    expect(evaluateCurve(hermite, 0.5)).toBe(
      (2 * 0.125 - 3 * 0.25 + 1) * 12 +
        (0.125 - 2 * 0.25 + 0.5) * 40 +
        (-2 * 0.125 + 3 * 0.25) * 96 +
        (0.125 - 0.25) * 10,
    );
  });
});

describe('sampleCurve', () => {
  it('spreads the samples evenly over the span, ends included', () => {
    const samples = sampleCurve(curve(rise), 5);
    expect(samples.map((sample) => sample.time)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(samples.map((sample) => sample.value)).toEqual([0, 2.5, 5, 7.5, 10]);
  });

  it('samples an explicit range, holding the ends of a curve that does not loop', () => {
    const samples = sampleCurve(curve(rise), 3, { from: -1, to: 3 });
    expect(samples).toEqual([
      { time: -1, value: 0 },
      { time: 1, value: 10 },
      { time: 3, value: 10 },
    ]);
  });

  it('answers nothing for an empty curve or a count below one', () => {
    expect(sampleCurve(curve([]), 10)).toEqual([]);
    expect(sampleCurve(curve(rise), 0)).toEqual([]);
    expect(sampleCurve(curve(rise), -3)).toEqual([]);
    expect(sampleCurve(curve(rise), Number.NaN)).toEqual([]);
  });

  it('places a single sample at the start of the range', () => {
    expect(sampleCurve(curve(rise), 1)).toEqual([{ time: 0, value: 0 }]);
    expect(sampleCurve(curve(rise), 1, { from: 0.5, to: 1 })).toEqual([{ time: 0.5, value: 5 }]);
  });

  it('floors a fractional count', () => {
    expect(sampleCurve(curve(rise), 2.9)).toHaveLength(2);
  });
});

describe('monotoneTangents', () => {
  function hermiteSamples(
    points: readonly CurvePointLike[],
    from: number,
    to: number,
  ): readonly number[] {
    return sampleCurve(curve(points, 'hermite'), 101, { from, to }).map((sample) => sample.value);
  }

  it('gives two ascending points the secant slope, which draws the straight line', () => {
    const tangents = monotoneTangents(rise);
    expect(tangents.map((point) => point.outTangent)).toEqual([10, 10]);
    expect(tangents.map((point) => point.inTangent)).toEqual([10, 10]);
    for (const value of hermiteSamples(tangents, 0, 1)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(10);
    }
  });

  it('keeps every segment inside its own end values where an averaged tangent would overshoot', () => {
    // A steep rise into a near-plateau: averaging the secants gives the middle
    // point a tangent of 5.25 that carries the curve above 10.5.
    const points = [point(0, 0), point(1, 10), point(2, 10.5)];
    const averaged = [
      point(0, 0, { out: 10 }),
      point(1, 10, { in: 5.25, out: 5.25 }),
      point(2, 10.5, { in: 0.5 }),
    ];
    expect(Math.max(...hermiteSamples(averaged, 1, 2))).toBeGreaterThan(10.5);

    const tangents = monotoneTangents(points);
    for (const value of hermiteSamples(tangents, 0, 1)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(10);
    }
    for (const value of hermiteSamples(tangents, 1, 2)) {
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThanOrEqual(10.5);
    }
  });

  it('flattens the tangent at a turn and along a plateau', () => {
    const tangents = monotoneTangents([point(0, 0), point(1, 10), point(2, 0), point(3, 0)]);
    expect(tangents.map((point) => point.outTangent)).toEqual([10, 0, 0, 0]);
    for (const value of hermiteSamples(tangents, 1, 3)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(10);
    }
  });

  it('normalizes the points it is given and zeroes the tangents of fewer than two', () => {
    expect(monotoneTangents([])).toEqual([]);
    expect(monotoneTangents([point(4, 2, { in: 9, out: 9 })])).toEqual([point(4, 2)]);
    const unsorted = monotoneTangents([point(1, 10), point(0, 0), point(1, 10)]);
    expect(unsorted.map((point) => point.time)).toEqual([0, 1]);
  });
});

describe('channelValue and channelSeverity', () => {
  const channel: SimulationChannelLike = {
    minimum: 0,
    maximum: 100,
    noise: 0,
    smoothing: 0,
    seed: 42n,
    valueCurve: curve(rise),
    criticalityCurve: curve([point(0, 0), point(1, 1)]),
  };

  it('follows the value curve when there is no noise and no smoothing', () => {
    expect(channelValue(channel, 0.5, 0, undefined)).toBe(5);
    expect(channelValue(channel, 1, 3, undefined)).toBe(10);
  });

  it('reads the middle of the range without a value curve', () => {
    const { valueCurve: _valueCurve, ...bare } = channel;
    expect(channelValue(bare, 0.5, 0, undefined)).toBe(50);
  });

  it('adds noise from the seed and the index alone, and stays inside the range', () => {
    // A quarter of the range around the middle keeps the noise clear of the
    // clamp, so two readings that differ are seen to differ.
    const noisy: SimulationChannelLike = {
      ...channel,
      valueCurve: curve([point(0, 50)]),
      noise: 0.25,
    };
    const first = channelValue(noisy, 0.5, 7, undefined);
    expect(first).toBe(channelValue(noisy, 0.5, 7, undefined));
    expect(first).not.toBe(50);
    expect(first).toBeGreaterThanOrEqual(25);
    expect(first).toBeLessThanOrEqual(75);
    expect(first).not.toBe(channelValue(noisy, 0.5, 8, undefined));
    expect(first).not.toBe(channelValue({ ...noisy, seed: 43n }, 0.5, 7, undefined));
    for (let index = 0; index < 50; index += 1) {
      const value = channelValue({ ...noisy, noise: 1 }, 0, index, undefined);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it('weights the previous reading by the smoothing after the clamp', () => {
    const smoothed: SimulationChannelLike = { ...channel, smoothing: 0.75 };
    expect(channelValue(smoothed, 1, 0, 0)).toBe(2.5);
    expect(channelValue({ ...channel, smoothing: 1 }, 1, 0, 3)).toBe(3);
    expect(channelValue({ ...channel, smoothing: 0 }, 1, 0, 3)).toBe(10);
  });

  it('clamps noise and smoothing into [0, 1]', () => {
    expect(channelValue({ ...channel, smoothing: 4 }, 1, 0, 3)).toBe(3);
    expect(channelValue({ ...channel, smoothing: -4 }, 1, 0, 3)).toBe(10);
    expect(channelValue({ ...channel, noise: -1 }, 0.5, 9, undefined)).toBe(5);
  });

  it('bands the criticality curve at quarter steps', () => {
    expect(channelSeverity(channel, 0)).toBe('normal');
    expect(channelSeverity(channel, 0.2499)).toBe('normal');
    expect(channelSeverity(channel, 0.25)).toBe('elevated');
    expect(channelSeverity(channel, 0.5)).toBe('degraded');
    expect(channelSeverity(channel, 0.75)).toBe('critical');
    expect(channelSeverity(channel, 5)).toBe('critical');
  });

  it('reports normal without a criticality curve', () => {
    const { criticalityCurve: _criticalityCurve, ...bare } = channel;
    expect(channelSeverity(bare, 0.9)).toBe('normal');
  });
});

describe('deterministicUnit', () => {
  it('lies in [0, 1) and depends on the seed and the index', () => {
    const seen = new Set<number>();
    for (let index = 0; index < 100; index += 1) {
      const value = deterministicUnit(7n, index);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      seen.add(value);
    }
    expect(seen.size).toBe(100);
    expect(deterministicUnit(7n, 3)).toBe(deterministicUnit(7n, 3));
    expect(deterministicUnit(7n, 3)).not.toBe(deterministicUnit(8n, 3));
  });

  it('reads only the low 32 bits of the seed', () => {
    expect(deterministicUnit(1n, 0)).toBe(deterministicUnit(1n + (1n << 32n), 0));
  });
});

describe('curvePhaseAt', () => {
  /*
   * The formula both sides of the wire read their curves at. It lives here so
   * that the control plane's preview sampler and the client's own tick share
   * one arithmetic rather than two that currently agree: the client used to
   * carry its own copy, and a copy is only ever as correct as the last time
   * someone compared the two.
   *
   * The cases state the phase in terms the formula does not: a period is how
   * long one pass takes in seconds, and a time scale multiplies the clock. Half
   * a period at double speed is a quarter of the wall-clock period, and that
   * relation is the contract — not the expression it happens to be written as.
   */
  it('reads a full period at the end of that many seconds', () => {
    expect(curvePhaseAt({ periodSeconds: 60, timeScale: 1 }, 60_000)).toBe(1);
    expect(curvePhaseAt({ periodSeconds: 60, timeScale: 1 }, 30_000)).toBe(0.5);
    expect(curvePhaseAt({ periodSeconds: 60, timeScale: 1 }, 0)).toBe(0);
  });

  it('spends the timeline faster or slower as the time scale says', () => {
    // The same elapsed moment, three scales: the phase is the only thing that
    // moves, which is what makes the scale a control rather than a stored number.
    expect(curvePhaseAt({ periodSeconds: 60, timeScale: 2 }, 30_000)).toBe(1);
    expect(curvePhaseAt({ periodSeconds: 60, timeScale: 0.5 }, 30_000)).toBe(0.25);
    expect(curvePhaseAt({ periodSeconds: 60, timeScale: 0 }, 30_000)).toBe(0);
  });

  it('holds a timeline still rather than dividing by a period of zero', () => {
    // Proto3 writes an unset numeric field as zero, so a profile that never
    // named a period arrives with one. A second falls in, which is the shortest
    // period the schema allows; the alternative is an infinite phase.
    expect(curvePhaseAt({ periodSeconds: 0, timeScale: 1 }, 2_000)).toBe(2);
    expect(Number.isFinite(curvePhaseAt({ periodSeconds: -5, timeScale: 1 }, 1_000))).toBe(true);
  });

  it('is linear in elapsed time, so splitting an interval cannot change it', () => {
    const timeline = { periodSeconds: 7, timeScale: 1.5 };

    expect(curvePhaseAt(timeline, 4_000)).toBeCloseTo(
      curvePhaseAt(timeline, 1_000) + curvePhaseAt(timeline, 3_000),
      12,
    );
  });
});

describe('positiveRemainder and clampNumber', () => {
  it('folds a negative value forwards into the span', () => {
    expect(positiveRemainder(-1, 4)).toBe(3);
    expect(positiveRemainder(5, 4)).toBe(1);
    expect(positiveRemainder(4, 4)).toBe(0);
  });

  it('clamps, treating NaN as the lower bound', () => {
    expect(clampNumber(5, 0, 1)).toBe(1);
    expect(clampNumber(-5, 0, 1)).toBe(0);
    expect(clampNumber(0.5, 0, 1)).toBe(0.5);
    expect(clampNumber(Number.NaN, 2, 3)).toBe(2);
  });
});
