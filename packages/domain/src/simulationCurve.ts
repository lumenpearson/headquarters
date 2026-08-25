/**
 * Simulation curves: the one evaluator every consumer of an operator-edited
 * curve shares.
 *
 * The control plane previews a profile with it, and the client drives its own
 * simulation and draws the curve editor with it. Keeping a single copy is what
 * lets a preview drawn on one machine agree, reading for reading, with the
 * simulation running on another: the arithmetic is deterministic in its inputs
 * alone, and there is only one arithmetic.
 *
 * The types are structural on purpose. The generated `gremuchaya.telemetry.v1`
 * messages satisfy `CurvePointLike` as they are; their `CurveInterpolation`
 * enum is mapped to `CurveInterpolationKind` at the boundary by whoever holds
 * the message, so this package never imports the protocol.
 */

export interface CurvePointLike {
  readonly time: number;
  readonly value: number;
  /** Slope, in value per unit of time, of the segment arriving at this point. */
  readonly inTangent: number;
  /** Slope, in value per unit of time, of the segment leaving this point. */
  readonly outTangent: number;
}

export type CurveInterpolationKind = 'linear' | 'step' | 'hermite' | 'bezier';

export interface SimulationCurveLike {
  readonly points: readonly CurvePointLike[];
  readonly interpolation: CurveInterpolationKind;
  /** Whether the curve repeats over its own span instead of holding its ends. */
  readonly loop: boolean;
}

export interface CurveSample {
  readonly time: number;
  readonly value: number;
}

export interface CurveSampleRange {
  readonly from: number;
  readonly to: number;
}

/**
 * The four bands of `gremuchaya.telemetry.v1.TelemetrySeverity`, by name, so a
 * client can classify a reading without the protocol's enum numbers.
 */
export type TelemetrySeverityKind = 'normal' | 'elevated' | 'degraded' | 'critical';

/**
 * The part of `gremuchaya.telemetry.v1.SimulationChannel` the arithmetic reads.
 * The source identifier stays with the caller: it names the reading, it does
 * not change it.
 */
export interface SimulationChannelLike {
  readonly minimum: number;
  readonly maximum: number;
  readonly valueCurve?: SimulationCurveLike;
  readonly criticalityCurve?: SimulationCurveLike;
  /** Noise amplitude as a fraction of the channel's range; clamped to [0, 1]. */
  readonly noise: number;
  /** The weight the previous reading keeps; clamped to [0, 1]. */
  readonly smoothing: number;
  readonly seed: bigint;
}

/**
 * Sorts points by time and drops exact-duplicate times, keeping the last one
 * the caller listed. The evaluator and every editor go through this, so a
 * curve an operator is dragging and the curve the simulation reads agree on
 * which point holds at a contested time.
 *
 * The sort is stable, so among duplicates "last" means last in the input.
 */
export function normalizeCurvePoints(points: readonly CurvePointLike[]): readonly CurvePointLike[] {
  const sorted = [...points].sort((left, right) => left.time - right.time);
  const normalized: CurvePointLike[] = [];
  for (const point of sorted) {
    const previous = normalized[normalized.length - 1];
    if (previous !== undefined && previous.time === point.time) {
      normalized[normalized.length - 1] = point;
    } else {
      normalized.push(point);
    }
  }
  return normalized;
}

/**
 * Reads a curve at a point of its own timeline.
 *
 * An empty curve answers `undefined` rather than zero, because zero is a
 * reading a channel could legitimately produce and the caller has to be able to
 * tell "no curve" from "a curve that says nothing is happening". A single point
 * holds its value everywhere. Outside a non-looping curve's own span the
 * nearest end point holds, which is what keeps a preview flat before a curve
 * starts instead of extrapolating off the scale; a looping curve repeats over
 * its span, with negative phases wrapping forwards into it.
 */
export function evaluateCurve(
  curve: SimulationCurveLike | undefined,
  phase: number,
): number | undefined {
  if (curve === undefined) return undefined;
  return evaluateNormalizedCurve(normalizeCurvePoints(curve.points), curve, phase);
}

/**
 * Evenly spaced readings of a curve, for drawing it.
 *
 * Without a range the samples cover the curve's own span, first point to last.
 * The first sample lands on `from` and the last on `to`; a single sample lands
 * on `from`. An empty curve has nothing to draw and answers an empty list.
 */
export function sampleCurve(
  curve: SimulationCurveLike,
  sampleCount: number,
  range?: CurveSampleRange,
): readonly CurveSample[] {
  const count = Number.isFinite(sampleCount) ? Math.floor(sampleCount) : 0;
  const points = normalizeCurvePoints(curve.points);
  const first = points[0];
  const last = points[points.length - 1];
  if (count < 1 || first === undefined || last === undefined) return [];

  const from = range?.from ?? first.time;
  const to = range?.to ?? last.time;
  const samples: CurveSample[] = [];
  for (let index = 0; index < count; index += 1) {
    const time = count === 1 ? from : from + ((to - from) * index) / (count - 1);
    const value = evaluateNormalizedCurve(points, curve, time);
    // A non-empty curve always reads a number; the guard keeps the sample list
    // honest rather than inventing a zero.
    if (value !== undefined) samples.push({ time, value });
  }
  return samples;
}

/**
 * Monotone cubic tangents, so a hermite curve through ascending points never
 * overshoots them and a plateau stays flat.
 *
 * The method is Fritsch and Carlson's (SIAM Journal on Numerical Analysis,
 * 1980): start from the secant slopes on either side of each point, zero the
 * tangent wherever the curve turns or flattens, then shrink any pair of
 * tangents whose scaled magnitudes leave the circle of radius three, which is
 * the region in which a cubic segment is guaranteed monotone. It gives an
 * editor sensible default tangents for `hermite` without a new interpolation
 * kind: the result is an ordinary hermite curve whose tangents happen to be
 * well chosen.
 *
 * Points are normalized first; each returned point carries the same tangent
 * in and out, which is what makes the joined curve smooth.
 */
export function monotoneTangents(points: readonly CurvePointLike[]): readonly CurvePointLike[] {
  const normalized = normalizeCurvePoints(points);
  if (normalized.length < 2) {
    return normalized.map((point) => ({ ...point, inTangent: 0, outTangent: 0 }));
  }

  const secants: number[] = [];
  for (let index = 0; index + 1 < normalized.length; index += 1) {
    const from = normalized[index];
    const to = normalized[index + 1];
    if (from === undefined || to === undefined) break;
    secants.push((to.value - from.value) / (to.time - from.time));
  }

  const tangents: number[] = normalized.map((_point, index) => {
    const before = secants[index - 1];
    const after = secants[index];
    if (before === undefined) return after ?? 0;
    if (after === undefined) return before;
    // A turn or a plateau on either side pins the tangent flat; otherwise the
    // two secants average.
    if (before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)) return 0;
    return (before + after) / 2;
  });

  for (let index = 0; index < secants.length; index += 1) {
    const secant = secants[index];
    const start = tangents[index];
    const end = tangents[index + 1];
    if (secant === undefined || start === undefined || end === undefined) break;
    if (secant === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const alpha = start / secant;
    const beta = end / secant;
    const radius = alpha * alpha + beta * beta;
    if (radius > 9) {
      const scale = 3 / Math.sqrt(radius);
      tangents[index] = scale * alpha * secant;
      tangents[index + 1] = scale * beta * secant;
    }
  }

  return normalized.map((point, index) => {
    const tangent = tangents[index] ?? 0;
    return { ...point, inTangent: tangent, outTangent: tangent };
  });
}

/**
 * One channel's reading at one point of the timeline.
 *
 * `smoothing` is the weight the previous reading keeps, so 0 follows the curve
 * exactly and 1 holds the first reading for the whole series. It is applied
 * after the noise and after the clamp, because smoothing a value that was never
 * inside the channel's own range would drift the whole series out of it. A
 * channel without a value curve reads the middle of its range.
 */
export function channelValue(
  channel: SimulationChannelLike,
  phase: number,
  index: number,
  previous: number | undefined,
): number {
  const range = channel.maximum - channel.minimum;
  const curved = evaluateCurve(channel.valueCurve, phase);
  const base = curved ?? channel.minimum + range / 2;
  const amplitude = clampNumber(channel.noise, 0, 1) * range;
  const noise = (deterministicUnit(channel.seed, index) - 0.5) * 2 * amplitude;
  const raw = clampNumber(base + noise, channel.minimum, channel.maximum);
  if (previous === undefined) return raw;
  return previous + (raw - previous) * (1 - clampNumber(channel.smoothing, 0, 1));
}

/**
 * Where a channel sits on the four-band scale the telemetry contract declares,
 * read from its criticality curve at quarter steps.
 *
 * A channel with no criticality curve reports `normal` rather than guessing
 * from its value: warning and critical thresholds belong to the data source,
 * and a curve is the only place a profile can say what they are.
 */
export function channelSeverity(
  channel: SimulationChannelLike,
  phase: number,
): TelemetrySeverityKind {
  const criticality = evaluateCurve(channel.criticalityCurve, phase);
  if (criticality === undefined) return 'normal';
  const level = clampNumber(criticality, 0, 1);
  if (level < 0.25) return 'normal';
  if (level < 0.5) return 'elevated';
  if (level < 0.75) return 'degraded';
  return 'critical';
}

/**
 * A unit value that depends on nothing but the channel's seed and the sample's
 * index. A shared generator would make a series depend on how many series ran
 * before it, and a clock-seeded one would make two runs of one profile
 * disagree, which is the whole reason a channel carries a seed at all.
 *
 * The mixing is Chris Wellons's `lowbias32` integer hash ("Prospecting for
 * Hash Functions", nullprogram.com, 2018, with the 2021 constants) applied to
 * the seed's low word offset by the index times the golden-ratio constant.
 */
export function deterministicUnit(seed: bigint, index: number): number {
  let state = (Number(BigInt.asUintN(32, seed)) + Math.imul(index, 0x9e37_79b9)) >>> 0;
  state = Math.imul(state ^ (state >>> 16), 0x21f0_aaad) >>> 0;
  state = Math.imul(state ^ (state >>> 15), 0x735a_2d97) >>> 0;
  state = (state ^ (state >>> 15)) >>> 0;
  return state / 0x1_0000_0000;
}

/** The remainder of `value` modulo `span` in `[0, span)`, for a negative `value` too. */
export function positiveRemainder(value: number, span: number): number {
  return ((value % span) + span) % span;
}

/** Clamps to `[lowest, highest]`; `NaN` clamps to the lower bound. */
export function clampNumber(value: number, lowest: number, highest: number): number {
  if (Number.isNaN(value)) return lowest;
  return Math.min(Math.max(value, lowest), highest);
}

function evaluateNormalizedCurve(
  points: readonly CurvePointLike[],
  curve: Pick<SimulationCurveLike, 'interpolation' | 'loop'>,
  phase: number,
): number | undefined {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return undefined;
  if (points.length === 1) return first.value;

  const span = last.time - first.time;
  const time =
    curve.loop && span > 0 ? first.time + positiveRemainder(phase - first.time, span) : phase;
  if (time <= first.time) return first.value;
  if (time >= last.time) return last.value;

  let index = 0;
  while (index + 1 < points.length) {
    const next = points[index + 1];
    if (next === undefined || next.time > time) break;
    index += 1;
  }
  const from = points[index];
  const to = points[index + 1];
  if (from === undefined || to === undefined) return last.value;
  // Normalized points carry strictly ascending times, so the segment is positive.
  const segment = to.time - from.time;
  return interpolate(curve.interpolation, from, to, (time - from.time) / segment, segment);
}

function interpolate(
  interpolation: CurveInterpolationKind,
  from: CurvePointLike,
  to: CurvePointLike,
  progress: number,
  segment: number,
): number {
  switch (interpolation) {
    case 'step':
      return from.value;
    case 'hermite':
      return hermite(from, to, progress, segment);
    case 'bezier':
      return bezier(from, to, progress, segment);
    case 'linear':
      return from.value + (to.value - from.value) * progress;
  }
}

function hermite(
  from: CurvePointLike,
  to: CurvePointLike,
  progress: number,
  segment: number,
): number {
  const squared = progress * progress;
  const cubed = squared * progress;
  return (
    (2 * cubed - 3 * squared + 1) * from.value +
    (cubed - 2 * squared + progress) * segment * from.outTangent +
    (-2 * cubed + 3 * squared) * to.value +
    (cubed - squared) * segment * to.inTangent
  );
}

/**
 * The tangents are slopes, and a cubic Bézier wants control points, so each
 * tangent is carried a third of the segment out from its own end. That is the
 * standard conversion between the two ways of writing the same curve, and it is
 * what makes a Bézier segment and a Hermite segment with equal tangents agree.
 */
function bezier(
  from: CurvePointLike,
  to: CurvePointLike,
  progress: number,
  segment: number,
): number {
  const control1 = from.value + (from.outTangent * segment) / 3;
  const control2 = to.value - (to.inTangent * segment) / 3;
  const inverse = 1 - progress;
  return (
    inverse * inverse * inverse * from.value +
    3 * inverse * inverse * progress * control1 +
    3 * inverse * progress * progress * control2 +
    progress * progress * progress * to.value
  );
}
