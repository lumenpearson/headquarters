import {
  channelValue,
  clampNumber,
  deterministicUnit,
  evaluateCurve,
  normalizeCurvePoints,
  severityForCriticality,
  type CurveInterpolationKind,
  type CurvePointLike,
  type SimulationChannelLike,
  type SimulationCurveLike,
  type TelemetrySeverityKind,
} from '@gremuchaya/domain';
import {
  curveInterpolations,
  getSettingDefinition,
  simulationChannels,
  simulationPresets,
  type SettingValues,
  type SimulationChannelName,
  type SimulationPresetName,
} from '@gremuchaya/settings-schema';

/**
 * The stored form of an operator-drawn simulation curve, and the arithmetic
 * that turns it into something `@gremuchaya/domain` can evaluate.
 *
 * R31 asks for a graph whose curve is dragged to move the maxima and minima of
 * the rate of change, and a second curve deciding criticality and how high a
 * reading may climb. Both are ordinary settings, so a curve edit lands in undo,
 * in the settings history and in the issue draft with everything else — which
 * is the whole argument for storing a curve as a setting rather than as a field
 * of some simulation state nothing else can see.
 *
 * A `SettingValue` is `boolean | number | string | readonly string[]`, and the
 * wire's `gremuchaya.common.v1.SettingValue` is a oneof of the same scalars
 * plus a string list. A curve therefore cannot be a nested object: it is a list
 * of entries, one per control point, each carrying its own channel. The shape
 * follows `tiles.spans` and `tiles.animations` deliberately — anything
 * addressed per element has to state its address in the entry or lose it.
 *
 * Everything here is a pure function of its arguments. Neither the evaluator
 * nor `curvePhaseAt` is written here: both are the domain's, because a preview
 * drawn on one machine and a simulation running on another have to agree
 * reading for reading, and they only can while there is one arithmetic. What
 * this module owns is the translation either side of it — the stored entry
 * form, and the percentage-of-range scale a drawn curve is read on.
 */

/** The decimals an entry may carry, matching the schema's own entry pattern. */
const curveDecimals = 6;

/** The percentage scale `simulation.valueCurve` is drawn on. */
const percentScale = 100;

export interface CurveShape {
  readonly interpolation: CurveInterpolationKind;
  readonly loop: boolean;
}

export interface ChannelRange {
  readonly minimum: number;
  readonly maximum: number;
}

export interface ChannelReading {
  readonly value: number;
  readonly severity: TelemetrySeverityKind;
}

/**
 * The bounds each reading lives inside, one entry per channel of the roster.
 *
 * A table, and deliberately not twenty-four settings of its own. A range is not
 * a preference: it is the channel's unit and physical meaning — a node runs
 * between 30 °C and 78 °C because that is the hardware the seed world models,
 * and a link reports 5 ms to 210 ms because that is the link. The operator
 * never has to know any of them, which is the entire reason
 * `simulation.valueCurve` is drawn as a percentage of the channel's own range:
 * one curve then reads the same on processor load and on link latency.
 *
 * Two bound settings per channel would give that up twice over. They would let
 * a minimum be set above its maximum, and they would make "percent of the
 * channel's range" mean a different number of milliseconds in every profile,
 * so a curve exported from one machine would draw the same line and produce a
 * different series on another.
 *
 * The numbers are the ones `simulationTick` clamped to before it read any of
 * this, moved here unchanged, so the world keeps the shape it already had.
 * `storage` was the first addition: the roster declared the channel and the
 * metric never moved, which is a channel with nothing on the other end of it.
 * `camera-signal`, `packet-loss` and `sensor-signal` are the second: a comms
 * channel's packet loss and a sensor's or a camera's signal strength read
 * straight off the entity before this, which is the same defect one level
 * down from `storage` — a field the seed drew and nothing ever moved again.
 */
export const simulationChannelRanges: Readonly<Record<SimulationChannelName, ChannelRange>> = {
  'camera-signal': { minimum: 5, maximum: 100 },
  cpu: { minimum: 12, maximum: 94 },
  gpu: { minimum: 8, maximum: 89 },
  'link-latency': { minimum: 5, maximum: 210 },
  'link-load': { minimum: 4, maximum: 99 },
  'link-signal': { minimum: 8, maximum: 100 },
  'network-in': { minimum: 80, maximum: 620 },
  'network-out': { minimum: 40, maximum: 410 },
  'node-load': { minimum: 8, maximum: 96 },
  'node-temperature': { minimum: 30, maximum: 78 },
  'packet-loss': { minimum: 0, maximum: 35 },
  ram: { minimum: 24, maximum: 92 },
  readiness: { minimum: 71, maximum: 96 },
  'sensor-signal': { minimum: 40, maximum: 100 },
  storage: { minimum: 55, maximum: 95 },
};

/**
 * A channel's bounds as a plot domain.
 *
 * A chart of a channel's readings spans what the channel can produce, not what
 * the last minute happened to contain: a run that sat still would otherwise
 * draw its own scatter as a mountain range, and two charts of the same channel
 * on two screens would disagree on scale.
 */
export function channelDomain(channel: SimulationChannelName): readonly [number, number] {
  const range = simulationChannelRanges[channel];
  return [range.minimum, range.maximum];
}

/**
 * The seven session counters the shell shows, in the order their readings are
 * taken.
 *
 * Written as a list and a record rather than one object, because both are
 * needed: the list fixes the order the sample indices are handed out in, and
 * the record's type makes a channel missing from the mapping a compile error
 * rather than a metric that quietly stops moving.
 */
export const sessionMetricNames = [
  'cpu',
  'ram',
  'storage',
  'gpu',
  'networkIn',
  'networkOut',
  'readiness',
] as const;

export type SessionMetricName = (typeof sessionMetricNames)[number];

/** Which channel of the roster each session counter takes its readings from. */
export const sessionMetricChannels: Readonly<Record<SessionMetricName, SimulationChannelName>> = {
  cpu: 'cpu',
  ram: 'ram',
  storage: 'storage',
  gpu: 'gpu',
  networkIn: 'network-in',
  networkOut: 'network-out',
  readiness: 'readiness',
};

/**
 * A deterministic offset in `[-1, 1]` for one sample of one series.
 *
 * The same generator the channel readings scatter with, exposed for the parts
 * of the world that have no channel in the roster — an object's position is
 * not a telemetry reading and never will be, but it should still answer to
 * `simulation.seed` rather than to a tick counter.
 */
export function deterministicOffset(seed: bigint, index: number): number {
  return (deterministicUnit(seed, index) - 0.5) * 2;
}

/**
 * One reading scattered deterministically around another, for a value that is
 * a part of a channel's own contour rather than a channel of its own.
 *
 * `/system`'s storage contour is the shape worth naming: `storage` is on the
 * roster as one aggregate reading, and the six areas the panel lists were six
 * literals frozen at whatever the seed drew once, moving with nothing the
 * operator's curve or preset ever touched. A second channel per area would
 * say each shelf has its own physical meaning the way `node-temperature` and
 * `link-latency` do; it does not, it is a division of the one number the
 * roster already reads. So each area's reading is `storage`'s own reading,
 * offset by {@link deterministicOffset} at an ordinal built from the area's
 * own index and the tick, and clamped back into a display percentage.
 */
export function scatteredAreaReading(
  overall: number,
  seed: bigint,
  ordinal: number,
  spread: number,
): number {
  return clampNumber(Math.round(overall + deterministicOffset(seed, ordinal) * spread), 0, 100);
}

/**
 * Every simulation setting, resolved once.
 *
 * Each identifier is written out here rather than assembled from a prefix, so
 * the definition and its reader can be found from either end by searching for
 * the identifier — which is also what the personalization accounting test asks
 * of anything claimed to be read.
 */
export interface SimulationSettings {
  readonly channel: SimulationChannelName;
  readonly preset: SimulationPresetName;
  readonly valueCurve: readonly string[];
  readonly criticalityCurve: readonly string[];
  readonly interpolation: CurveInterpolationKind;
  readonly loop: boolean;
  readonly periodSeconds: number;
  readonly updateIntervalMs: number;
  readonly timeScale: number;
  readonly noise: number;
  readonly smoothing: number;
  readonly seed: bigint;
}

export function isSimulationChannelName(value: string): value is SimulationChannelName {
  return (simulationChannels as readonly string[]).includes(value);
}

export function isSimulationPresetName(value: string): value is SimulationPresetName {
  return (simulationPresets as readonly string[]).includes(value);
}

function isCurveInterpolation(value: string): value is CurveInterpolationKind {
  return (curveInterpolations as readonly string[]).includes(value);
}

export function readSimulationSettings(values: SettingValues): SimulationSettings {
  const channel = settingString(values, 'simulation.channel');
  const preset = settingString(values, 'simulation.preset');
  const interpolation = settingString(values, 'simulation.interpolation');
  return {
    channel: isSimulationChannelName(channel) ? channel : 'cpu',
    preset: isSimulationPresetName(preset) ? preset : 'normal',
    valueCurve: settingList(values, 'simulation.valueCurve'),
    criticalityCurve: settingList(values, 'simulation.criticalityCurve'),
    interpolation: isCurveInterpolation(interpolation) ? interpolation : 'linear',
    loop: settingBoolean(values, 'simulation.loop'),
    periodSeconds: settingNumber(values, 'simulation.periodSeconds'),
    updateIntervalMs: settingNumber(values, 'simulation.updateIntervalMs'),
    timeScale: settingNumber(values, 'simulation.timeScale'),
    noise: settingNumber(values, 'simulation.noise'),
    smoothing: settingNumber(values, 'simulation.smoothing'),
    seed: BigInt(Math.trunc(settingNumber(values, 'simulation.seed'))),
  };
}

/**
 * The per-channel criticality baseline each named preset stands for, read
 * when a channel has no operator-drawn criticality curve of its own.
 *
 * A hand-drawn curve always wins — a preset marks the world, an operator's own
 * curve overrides one channel of it — so this is a floor under
 * {@link simulateChannelReading}, not a second curve stacked on top of the
 * first. `normal` supplies none: it is the world exactly as an unmarked
 * simulation already reads it, criticality curve absent, severity `normal`.
 *
 * `elevated`, `degraded` and `critical` are uniform across the whole roster,
 * at a level inside the matching band of {@link severityForCriticality} — the
 * preset's name is the severity every channel reports while it is marked.
 * `incident` sits at the top of the `critical` band rather than merely inside
 * it, for a reading worse than the `critical` preset's own. `recovery` sits at
 * the bottom of `normal`, low but not zero, so a recovering world still reads
 * as having just come down from something.
 *
 * `network-attack`, `storage-exhaustion` and `cpu-overload` name the channels
 * their own scenario touches and leave every other channel unmarked, which is
 * what makes them read differently from the four uniform presets and from one
 * another.
 */
export const simulationPresetCriticality: Readonly<
  Record<SimulationPresetName, Readonly<Partial<Record<SimulationChannelName, number>>>>
> = {
  normal: {},
  elevated: uniformCriticality(0.35),
  degraded: uniformCriticality(0.55),
  critical: uniformCriticality(0.85),
  incident: uniformCriticality(0.97),
  recovery: uniformCriticality(0.1),
  'network-attack': {
    'link-latency': 0.9,
    'link-load': 0.85,
    'link-signal': 0.8,
    'network-in': 0.75,
    'network-out': 0.75,
    'packet-loss': 0.9,
  },
  'storage-exhaustion': {
    storage: 0.92,
    'node-load': 0.4,
  },
  'cpu-overload': {
    cpu: 0.92,
    'node-load': 0.7,
    'node-temperature': 0.55,
  },
};

function uniformCriticality(
  level: number,
): Readonly<Partial<Record<SimulationChannelName, number>>> {
  return Object.fromEntries(simulationChannels.map((channel) => [channel, level]));
}

/** The preset's own baseline for one channel, or `undefined` where it names none. */
export function presetCriticalityFor(
  preset: SimulationPresetName,
  channel: SimulationChannelName,
): number | undefined {
  return simulationPresetCriticality[preset][channel];
}

/** The shape both curves are read with; they share one timeline and one mode. */
export function curveShapeOf(settings: SimulationSettings): CurveShape {
  return { interpolation: settings.interpolation, loop: settings.loop };
}

/**
 * Reads `channel=time,value,inTangent,outTangent` entries into the points of
 * each channel.
 *
 * Parsing is lenient where the schema's validator is strict, and deliberately
 * so: the validator is the trust boundary every value crosses on the way in,
 * while this runs over whatever a persisted blob from an older build happens to
 * hold. An entry it cannot read is skipped rather than thrown on, so one stale
 * point does not cost the operator the rest of the curve.
 */
export function readCurvePoints(
  entries: readonly string[],
): ReadonlyMap<SimulationChannelName, readonly CurvePointLike[]> {
  const points = new Map<SimulationChannelName, CurvePointLike[]>();
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const channel = entry.slice(0, separator);
    if (!isSimulationChannelName(channel)) continue;
    const coordinates = entry.slice(separator + 1).split(',');
    if (coordinates.length !== 4) continue;
    const [time, value, inTangent, outTangent] = coordinates.map(toFiniteNumber);
    if (
      time === undefined ||
      value === undefined ||
      inTangent === undefined ||
      outTangent === undefined
    ) {
      continue;
    }
    const existing = points.get(channel);
    const point: CurvePointLike = { time, value, inTangent, outTangent };
    if (existing === undefined) points.set(channel, [point]);
    else existing.push(point);
  }
  return new Map(
    [...points].map(([channel, list]) => [channel, normalizeCurvePoints(list)] as const),
  );
}

/**
 * One channel's curve, or `undefined` when nothing has been drawn for it.
 *
 * Absence is not an empty curve. `evaluateCurve` answers `undefined` for a
 * curve it has no points for, and `channelValue` reads the middle of the range
 * instead — so "this channel is not scripted" and "this channel is scripted to
 * sit at zero" stay two different statements.
 */
export function readChannelCurve(
  entries: readonly string[],
  channel: SimulationChannelName,
  shape: CurveShape,
): SimulationCurveLike | undefined {
  // `readCurvePoints` names a channel only once it has a point for it, so an
  // absent channel is the whole of absence here; a second guard for an empty
  // list would be a branch no input can take.
  const points = readCurvePoints(entries).get(channel);
  if (points === undefined) return undefined;
  return { points, interpolation: shape.interpolation, loop: shape.loop };
}

/**
 * Rewrites one channel's points, leaving every other channel's alone.
 *
 * The result is canonical — channels ascending, each channel's points ascending
 * in time — because the schema refuses anything else. Two lists that describe
 * the same curve are then the same list, so undo and the issue draft treat a
 * curve as one value rather than as a set that happens to compare unequal.
 */
export function withChannelCurve(
  entries: readonly string[],
  channel: SimulationChannelName,
  points: readonly CurvePointLike[],
): readonly string[] {
  const byChannel = new Map(readCurvePoints(entries));
  if (points.length === 0) byChannel.delete(channel);
  // Rounded to the stored precision before the points are normalized, not
  // after. Two points a millionth of a period apart are one point once written,
  // and normalizing first would leave the pair to be discovered by the
  // validator as a duplicate time it must refuse.
  else byChannel.set(channel, normalizeCurvePoints(points.map(roundCurvePoint)));
  return [...byChannel]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([name, list]) => list.map((point) => formatCurvePoint(name, point)));
}

export function formatCurvePoint(channel: SimulationChannelName, point: CurvePointLike): string {
  return [
    `${channel}=${formatCurveNumber(point.time)}`,
    formatCurveNumber(point.value),
    formatCurveNumber(point.inTangent),
    formatCurveNumber(point.outTangent),
  ].join(',');
}

/**
 * The canonical spelling of a coordinate: at most six decimals, no trailing
 * zeros and no exponent. The schema's pattern accepts exactly this, so a curve
 * written here always survives its own validator.
 *
 * Negative zero needs no guard of its own — `String(-0)` is `'0'` — and a
 * guard for it would be a branch no input can take.
 */
export function formatCurveNumber(value: number): string {
  return String(roundCurveNumber(value));
}

/** The value an entry would read back as, without writing the entry. */
export function roundCurveNumber(value: number): number {
  return Number(value.toFixed(curveDecimals));
}

function roundCurvePoint(point: CurvePointLike): CurvePointLike {
  return {
    time: roundCurveNumber(point.time),
    value: roundCurveNumber(point.value),
    inTangent: roundCurveNumber(point.inTangent),
    outTangent: roundCurveNumber(point.outTangent),
  };
}

/**
 * Where a channel's curve starts when nothing has been drawn for it: a flat
 * line across the whole period at the resting value the schema declares, which
 * is the reading the domain evaluator produces when it is handed no curve.
 *
 * Two points, because that is the fewest an editor can offer a drag on.
 */
export function restingCurvePoints(
  timeDomain: readonly [number, number],
  restingValue: number,
): readonly CurvePointLike[] {
  return [timeDomain[0], timeDomain[1]].map((time) => ({
    time,
    value: restingValue,
    inTangent: 0,
    outTangent: 0,
  }));
}

/**
 * One channel, assembled for the domain evaluator.
 *
 * `simulation.valueCurve` is drawn as a percentage of the channel's own range
 * so that a single curve reads the same on processor load and on link latency,
 * which have nothing in common but a range. The conversion into the channel's
 * units happens here, once, and the tangents scale with the values because a
 * tangent is value units per unit of time.
 */
export function simulationChannelFor(
  settings: SimulationSettings,
  channel: SimulationChannelName,
  range: ChannelRange,
): SimulationChannelLike {
  const span = range.maximum - range.minimum;
  const shape = curveShapeOf(settings);
  const percent = readChannelCurve(settings.valueCurve, channel, shape);
  const valueCurve =
    percent === undefined
      ? undefined
      : {
          ...percent,
          points: percent.points.map((point) => ({
            time: point.time,
            value: range.minimum + (point.value / percentScale) * span,
            inTangent: (point.inTangent / percentScale) * span,
            outTangent: (point.outTangent / percentScale) * span,
          })),
        };
  const criticalityCurve = readChannelCurve(settings.criticalityCurve, channel, shape);
  return {
    minimum: range.minimum,
    maximum: range.maximum,
    ...(valueCurve === undefined ? {} : { valueCurve }),
    ...(criticalityCurve === undefined ? {} : { criticalityCurve }),
    noise: settings.noise,
    smoothing: settings.smoothing,
    seed: settings.seed,
  };
}

/**
 * The inverse of the percent-to-units conversion `simulationChannelFor`
 * applies to `valueCurve`: a curve already in the channel's own units, read
 * back as the percentage of its range `simulation.valueCurve` stores.
 *
 * Written for the telemetry client (`application/telemetry`), which reads a
 * `SimulationChannel` off the wire in absolute units — the same units
 * `TelemetryService`'s own arithmetic uses, because the server evaluates the
 * identical curve the client would (`apps/control-plane/src/telemetry/service.ts`,
 * `readSource`) — and has to fold it back into this build's percentage-of-range
 * storage before an operator's local curve editor can show it. The
 * criticality curve needs no such inverse: it is stored and sent as the same
 * `[0, 1]` fraction on both sides, `simulationChannelFor` passes it through
 * unscaled, and a caller that inverted it here would double-convert.
 */
export function absoluteToPercentPoints(
  points: readonly CurvePointLike[],
  range: ChannelRange,
): readonly CurvePointLike[] {
  const span = range.maximum - range.minimum;
  return points.map((point) => ({
    time: point.time,
    value: span === 0 ? 0 : ((point.value - range.minimum) / span) * percentScale,
    inTangent: span === 0 ? 0 : (point.inTangent / span) * percentScale,
    outTangent: span === 0 ? 0 : (point.outTangent / span) * percentScale,
  }));
}

/**
 * One reading, and the band it falls in.
 *
 * The criticality curve is what R31 means by deciding how high values may go:
 * it is not a second reading laid over the first but the ceiling the first is
 * clamped to, so a channel at criticality 0.25 stays inside the lowest quarter
 * of its range and reports `normal` while it does. A channel with no
 * criticality curve is not capped at all — a missing ceiling is not a low one.
 *
 * An operator-drawn curve is read first; where it says nothing for this
 * channel, the marked `simulation.preset` supplies a criticality of its own —
 * see {@link simulationPresetCriticality} — so a preset with no curve drawn
 * still moves the world, and a curve the operator did draw is never
 * overridden by the preset that happens to be marked alongside it.
 *
 * The ceiling narrows the channel rather than trimming the result afterwards,
 * because `channelValue` clamps before it smooths and a value smoothed from
 * outside the range would drift the whole series out of it. The severity is
 * read off the same resolved criticality as the ceiling, through
 * {@link severityForCriticality}, so the two can never disagree about which
 * band a reading is in.
 */
export function simulateChannelReading(
  settings: SimulationSettings,
  channel: SimulationChannelName,
  range: ChannelRange,
  phase: number,
  index: number,
  previous: number | undefined,
): ChannelReading {
  const assembled = simulationChannelFor(settings, channel, range);
  const drawn = evaluateCurve(assembled.criticalityCurve, phase);
  const criticality = drawn ?? presetCriticalityFor(settings.preset, channel);
  const ceiling =
    criticality === undefined
      ? range.maximum
      : range.minimum + clampNumber(criticality, 0, 1) * (range.maximum - range.minimum);
  return {
    value: channelValue({ ...assembled, maximum: ceiling }, phase, index, previous),
    severity: criticality === undefined ? 'normal' : severityForCriticality(criticality),
  };
}

function toFiniteNumber(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/*
 * A setting's current value, falling back to the schema's own default rather
 * than to a literal here — the rule `resolvePresentation` already follows, for
 * the same reason: a second copy of a default is a second thing to keep in
 * step. Values reaching a render from persisted storage were validated when
 * they were written and not since, so a value of the wrong type falls back too.
 *
 * The last fallback in each reader stands for a definition that has been
 * removed from the schema. It is unreachable while the definition exists, and
 * it is there so a render answers rather than throws if it ever stops existing.
 */
function settingNumber(values: SettingValues, id: string): number {
  const value = values[id];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const fallback = getSettingDefinition(id)?.defaultValue;
  return typeof fallback === 'number' ? fallback : 0;
}

function settingBoolean(values: SettingValues, id: string): boolean {
  const value = values[id];
  if (typeof value === 'boolean') return value;
  return getSettingDefinition(id)?.defaultValue === true;
}

function settingString(values: SettingValues, id: string): string {
  const value = values[id];
  if (typeof value === 'string') return value;
  const fallback = getSettingDefinition(id)?.defaultValue;
  return typeof fallback === 'string' ? fallback : '';
}

function settingList(values: SettingValues, id: string): readonly string[] {
  const value = values[id];
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}
