'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

import { classNames } from './classNames.js';

/** Mirrors `gremuchaya.telemetry.v1.CurvePoint`; tangents are value units per time unit. */
export type CurveEditorPoint = {
  readonly time: number;
  readonly value: number;
  readonly inTangent: number;
  readonly outTangent: number;
};

export type CurveEditorDomain = {
  readonly time: readonly [number, number];
  readonly value: readonly [number, number];
};

export type CurveEditorPathPoint = { readonly time: number; readonly value: number };

export type CurveEditorSnap = { readonly time?: number; readonly value?: number };

export type TerminalCurveEditorProps = {
  /** Sorted by `time`; the first and last point sit on the domain's time edges. */
  points: readonly CurveEditorPoint[];
  onPointsChange: (points: readonly CurveEditorPoint[]) => void;
  /**
   * The curve as the consumer sampled it. This primitive never interpolates:
   * the domain evaluator that owns the interpolation mode draws the curve
   * through this prop, and the editor only moves the points that feed it.
   */
  path: readonly CurveEditorPathPoint[];
  domain: CurveEditorDomain;
  /** Accessible name of the whole editor and prefix of every handle's name. */
  label: string;
  /** Render draggable in/out tangent handles for hermite and bezier consumers. */
  showTangents?: boolean;
  readOnly?: boolean;
  minPoints?: number;
  maxPoints?: number;
  snap?: CurveEditorSnap;
  formatTime?: (time: number) => string;
  formatValue?: (value: number) => string;
  className?: string;
};

type HandleKind = 'point' | 'in' | 'out';

const tangentSides = ['in', 'out'] as const;

type PlotPosition = { readonly u: number; readonly v: number };

type TangentHandle = {
  readonly index: number;
  readonly side: 'in' | 'out';
  /** The owning point, in plot shares. */
  readonly u: number;
  readonly v: number;
  readonly anchor: PlotPosition;
  readonly slope: number;
};

type Drag = {
  readonly kind: HandleKind;
  readonly index: number;
  readonly pointerId: number;
  readonly originX: number;
  readonly originY: number;
  moved: boolean;
};

/** Same travel as the tile and edit-panel drags: a press that never moves is a click. */
const dragThresholdPx = 6;

/** Keyboard steps per axis when no snap grid is given. */
const keyboardSteps = 100;

/** Tangent handle lever, as a share of the time domain. */
const tangentLever = 0.08;

/** The lever shortens so a steep tangent's handle stays within this share of the value domain. */
const tangentLeverLimit = 0.3;

/**
 * Tangents are clamped to this multiple of the domain's own aspect (value span
 * over time span), which is 88 degrees on the plot -- a slider needs a finite
 * `aria-valuemax`, and past this angle the handle would sit on the point.
 */
const slopeLimitFactor = 32;

const formatNumber = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

const span = (axis: readonly [number, number]): number => axis[1] - axis[0];

/** Position along an axis as a 0..1 share; a collapsed axis reads as its midpoint. */
const unit = (value: number, axis: readonly [number, number]): number =>
  span(axis) === 0 ? 0.5 : (value - axis[0]) / span(axis);

const snapTo = (value: number, origin: number, grid: number | undefined): number =>
  grid === undefined || grid <= 0 ? value : origin + Math.round((value - origin) / grid) * grid;

/** Smallest separation two neighbours keep, so an interpolator never divides by zero. */
const minimumGap = (domain: CurveEditorDomain, snap: CurveEditorSnap | undefined): number =>
  snap?.time !== undefined && snap.time > 0 ? snap.time : Math.abs(span(domain.time)) / 1000;

const slopeLimit = (domain: CurveEditorDomain): number =>
  slopeLimitFactor * (Math.abs(span(domain.value)) / (Math.abs(span(domain.time)) || 1));

/**
 * Moves one point, keeping the invariants a drag must not break: endpoints
 * stay on the domain's time edges, no point crosses a neighbour, and every
 * coordinate stays within the domain. Returns `null` when nothing moved.
 */
function placePoint(
  points: readonly CurveEditorPoint[],
  index: number,
  time: number,
  value: number,
  domain: CurveEditorDomain,
  snap: CurveEditorSnap | undefined,
): readonly CurveEditorPoint[] | null {
  const current = points[index];
  if (current === undefined) return null;
  const last = points.length - 1;
  let nextTime: number;
  if (index === 0) {
    nextTime = domain.time[0];
  } else if (index === last) {
    nextTime = domain.time[1];
  } else {
    const gap = minimumGap(domain, snap);
    const low = (points[index - 1]?.time ?? domain.time[0]) + gap;
    const high = (points[index + 1]?.time ?? domain.time[1]) - gap;
    const snapped = snapTo(time, domain.time[0], snap?.time);
    // A snap grid finer than the neighbours' distance leaves no slot; the
    // point stays where it is rather than landing on a neighbour.
    nextTime = low > high ? current.time : clamp(snapped, low, high);
  }
  const valueLow = Math.min(domain.value[0], domain.value[1]);
  const valueHigh = Math.max(domain.value[0], domain.value[1]);
  const nextValue = clamp(snapTo(value, domain.value[0], snap?.value), valueLow, valueHigh);
  if (nextTime === current.time && nextValue === current.value) return null;
  return points.map((point, at) =>
    at === index ? { ...point, time: nextTime, value: nextValue } : point,
  );
}

function placeTangent(
  points: readonly CurveEditorPoint[],
  index: number,
  side: 'in' | 'out',
  slope: number,
  domain: CurveEditorDomain,
): readonly CurveEditorPoint[] | null {
  const current = points[index];
  if (current === undefined) return null;
  const limit = slopeLimit(domain);
  const next = clamp(slope, -limit, limit);
  const key = side === 'in' ? 'inTangent' : 'outTangent';
  if (next === current[key]) return null;
  return points.map((point, at) => (at === index ? { ...point, [key]: next } : point));
}

/**
 * Reads the drawn curve at `time` -- a lerp between the two samples the
 * consumer supplied around it, i.e. exactly the polyline on screen, not an
 * interpolation of the curve. A point added from the keyboard lands on the
 * line the operator is looking at instead of jumping the curve.
 */
function drawnValueAt(path: readonly CurveEditorPathPoint[], time: number): number | null {
  for (let at = 1; at < path.length; at += 1) {
    const before = path[at - 1];
    const after = path[at];
    if (before === undefined || after === undefined) continue;
    if (time < before.time || time > after.time) continue;
    const width = after.time - before.time;
    if (width === 0) return before.value;
    return before.value + ((time - before.time) / width) * (after.value - before.value);
  }
  return null;
}

/** A new point takes the chord slope of its neighbours so a hermite curve stays smooth through it. */
function chordSlope(
  before: CurveEditorPoint | undefined,
  after: CurveEditorPoint | undefined,
): number {
  if (before === undefined || after === undefined) return 0;
  const width = after.time - before.time;
  return width === 0 ? 0 : (after.value - before.value) / width;
}

function insertPoint(
  points: readonly CurveEditorPoint[],
  time: number,
  value: number,
  domain: CurveEditorDomain,
  snap: CurveEditorSnap | undefined,
): { readonly points: readonly CurveEditorPoint[]; readonly index: number } | null {
  const index = points.findIndex((point) => point.time > time);
  // The endpoints own the domain edges, so nothing goes before the first or
  // after the last.
  if (index <= 0) return null;
  const slope = chordSlope(points[index - 1], points[index]);
  const inserted: CurveEditorPoint = { time, value, inTangent: slope, outTangent: slope };
  const widened = [...points.slice(0, index), inserted, ...points.slice(index)];
  const placed = placePoint(widened, index, time, value, domain, snap) ?? widened;
  return { points: placed, index };
}

/** The keyboard has no pointer to place a point under; the widest gap is where one is missing most. */
function widestGap(points: readonly CurveEditorPoint[]): number | null {
  let best: { readonly index: number; readonly width: number } | null = null;
  for (let at = 1; at < points.length; at += 1) {
    const before = points[at - 1];
    const after = points[at];
    if (before === undefined || after === undefined) continue;
    const width = after.time - before.time;
    if (best === null || width > best.width) best = { index: at, width };
  }
  return best === null ? null : best.index;
}

/** Pointer position as plot shares: `u` left to right, `v` bottom to top. */
function plotPosition(plot: HTMLElement, clientX: number, clientY: number): PlotPosition | null {
  const rect = plot.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return { u: (clientX - rect.left) / rect.width, v: 1 - (clientY - rect.top) / rect.height };
}

/** Where a tangent handle sits, in plot shares, for the slope it carries. */
function tangentAnchor(
  point: CurveEditorPoint,
  side: 'in' | 'out',
  domain: CurveEditorDomain,
): PlotPosition {
  const slope = side === 'in' ? point.inTangent : point.outTangent;
  const timeSpan = span(domain.time);
  const valueSpan = span(domain.value);
  const unitSlope = valueSpan === 0 || timeSpan === 0 ? 0 : (slope * timeSpan) / valueSpan;
  let du = tangentLever;
  let dv = unitSlope * du;
  if (Math.abs(dv) > tangentLeverLimit) {
    const scale = tangentLeverLimit / Math.abs(dv);
    du *= scale;
    dv *= scale;
  }
  const sign = side === 'out' ? 1 : -1;
  const u = unit(point.time, domain.time);
  const v = unit(point.value, domain.value);
  // Shorten the lever, direction kept, until the handle is inside the plot.
  let fit = 1;
  const targetU = u + sign * du;
  const targetV = v + sign * dv;
  if (targetU < 0) fit = Math.min(fit, u / Math.abs(sign * du));
  if (targetU > 1) fit = Math.min(fit, (1 - u) / Math.abs(sign * du));
  if (dv !== 0 && targetV < 0) fit = Math.min(fit, v / Math.abs(sign * dv));
  if (dv !== 0 && targetV > 1) fit = Math.min(fit, (1 - v) / Math.abs(sign * dv));
  fit = clamp(fit, 0, 1);
  return { u: u + sign * du * fit, v: v + sign * dv * fit };
}

/** The slope a tangent handle reads when dragged to `position`. */
function slopeTowards(
  point: CurveEditorPoint,
  side: 'in' | 'out',
  position: PlotPosition,
  domain: CurveEditorDomain,
): number {
  const sign = side === 'out' ? 1 : -1;
  // The handle never crosses to the other side of its point: a tangent points
  // forward in time for `out` and backward for `in`, whatever the pointer does.
  const du = Math.max(0.005, sign * (position.u - unit(point.time, domain.time)));
  const dv = sign * (position.v - unit(point.value, domain.value));
  const timeSpan = span(domain.time);
  const valueSpan = span(domain.value);
  if (timeSpan === 0) return 0;
  return (dv / du) * (valueSpan / timeSpan);
}

const percent = (share: number): string => `${(share * 100).toFixed(3)}%`;

export function TerminalCurveEditor({
  points,
  onPointsChange,
  path,
  domain,
  label,
  showTangents = false,
  readOnly = false,
  minPoints = 2,
  maxPoints = 512,
  snap,
  formatTime = formatNumber,
  formatValue = formatNumber,
  className,
}: TerminalCurveEditorProps): JSX.Element {
  const plotRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const pendingFocus = useRef<{ readonly kind: HandleKind; readonly index: number } | null>(null);
  /*
   * Published as `data-adjusting` on the root while a handle is actually being
   * moved -- the same attribute TerminalSlider publishes for R23, so the
   * stylesheet's grabbing cursor and highlight read one idiom for both.
   */
  const [adjusting, setAdjusting] = useState(false);
  const [active, setActive] = useState<{
    readonly kind: HandleKind;
    readonly index: number;
  } | null>(null);

  // A point added or removed from the keyboard moves focus to where the
  // operator now is: the new handle, or the neighbour of the removed one.
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    plotRef.current
      ?.querySelector<HTMLElement>(`[data-handle="${target.kind}"][data-index="${target.index}"]`)
      ?.focus();
  });

  const valueStep = snap?.value ?? Math.abs(span(domain.value)) / keyboardSteps;
  const timeStep = snap?.time ?? Math.abs(span(domain.time)) / keyboardSteps;
  const slopeStep = slopeLimit(domain) / 160;
  const last = points.length - 1;

  const commit = (next: readonly CurveEditorPoint[] | null): void => {
    if (next !== null) onPointsChange(next);
  };

  const addPoint = (time: number, value: number): void => {
    if (readOnly || points.length >= maxPoints) return;
    const inserted = insertPoint(points, time, value, domain, snap);
    if (inserted === null) return;
    pendingFocus.current = { kind: 'point', index: inserted.index };
    onPointsChange(inserted.points);
  };

  const removePoint = (index: number): void => {
    if (readOnly || index <= 0 || index >= last || points.length <= minPoints) return;
    pendingFocus.current = { kind: 'point', index: index - 1 };
    onPointsChange(points.filter((_, at) => at !== index));
  };

  const handlePlotKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    const index = widestGap(points);
    const before = index === null ? undefined : points[index - 1];
    const after = index === null ? undefined : points[index];
    if (before === undefined || after === undefined) return;
    const time = (before.time + after.time) / 2;
    addPoint(time, drawnValueAt(path, time) ?? (before.value + after.value) / 2);
  };

  const handlePlotDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if ((event.target as Element).closest('[data-handle]') !== null) return;
    const position = plotPosition(event.currentTarget, event.clientX, event.clientY);
    if (position === null) return;
    addPoint(
      domain.time[0] + clamp(position.u, 0, 1) * span(domain.time),
      domain.value[0] + clamp(position.v, 0, 1) * span(domain.value),
    );
  };

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    kind: HandleKind,
    index: number,
  ): void => {
    if (readOnly) return;
    const point = points[index];
    if (point === undefined) return;
    const multiplier = event.shiftKey ? 10 : 1;
    if (kind !== 'point') {
      const current = kind === 'in' ? point.inTangent : point.outTangent;
      const delta =
        event.key === 'ArrowUp' ? slopeStep : event.key === 'ArrowDown' ? -slopeStep : null;
      if (delta === null) return;
      event.preventDefault();
      commit(placeTangent(points, index, kind, current + delta * multiplier, domain));
      return;
    }
    switch (event.key) {
      case 'ArrowUp':
        commit(
          placePoint(points, index, point.time, point.value + valueStep * multiplier, domain, snap),
        );
        break;
      case 'ArrowDown':
        commit(
          placePoint(points, index, point.time, point.value - valueStep * multiplier, domain, snap),
        );
        break;
      case 'PageUp':
        commit(placePoint(points, index, point.time, point.value + valueStep * 10, domain, snap));
        break;
      case 'PageDown':
        commit(placePoint(points, index, point.time, point.value - valueStep * 10, domain, snap));
        break;
      case 'ArrowRight':
        commit(
          placePoint(points, index, point.time + timeStep * multiplier, point.value, domain, snap),
        );
        break;
      case 'ArrowLeft':
        commit(
          placePoint(points, index, point.time - timeStep * multiplier, point.value, domain, snap),
        );
        break;
      case 'Home':
        commit(placePoint(points, index, point.time, domain.value[0], domain, snap));
        break;
      case 'End':
        commit(placePoint(points, index, point.time, domain.value[1], domain, snap));
        break;
      case 'Delete':
      case 'Backspace':
        removePoint(index);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    kind: HandleKind,
    index: number,
  ): void => {
    // A press on a handle is never a press on the plot beneath it.
    event.stopPropagation();
    event.currentTarget.focus();
    if (readOnly || event.button !== 0) return;
    event.preventDefault();
    /*
     * Capture, as the tile and edit-panel drags do: the release lands wherever
     * the pointer ended up, and without capture this handle never hears it and
     * the curve stays stuck mid-drag.
     */
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind,
      index,
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      moved: false,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    const plot = plotRef.current;
    if (drag === null || plot === null || drag.pointerId !== event.pointerId) return;
    if (!drag.moved) {
      const travelled =
        Math.abs(event.clientX - drag.originX) + Math.abs(event.clientY - drag.originY);
      if (travelled < dragThresholdPx) return;
      drag.moved = true;
      setAdjusting(true);
    }
    const position = plotPosition(plot, event.clientX, event.clientY);
    const point = points[drag.index];
    if (position === null || point === undefined) return;
    if (drag.kind === 'point') {
      commit(
        placePoint(
          points,
          drag.index,
          domain.time[0] + clamp(position.u, 0, 1) * span(domain.time),
          domain.value[0] + clamp(position.v, 0, 1) * span(domain.value),
          domain,
          snap,
        ),
      );
      return;
    }
    commit(
      placeTangent(
        points,
        drag.index,
        drag.kind,
        slopeTowards(point, drag.kind, position, domain),
        domain,
      ),
    );
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setAdjusting(false);
  };

  const activePoint = active === null ? undefined : points[active.index];
  const readout =
    active === null || activePoint === undefined
      ? null
      : active.kind === 'point'
        ? `${formatTime(activePoint.time)} → ${formatValue(activePoint.value)}`
        : `${active.kind === 'in' ? '←' : '→'} ${formatNumber(
            active.kind === 'in' ? activePoint.inTangent : activePoint.outTangent,
          )}`;

  const pathData = path
    .map(
      (sample, at) =>
        `${at === 0 ? 'M' : 'L'}${(unit(sample.time, domain.time) * 100).toFixed(3)} ${(
          (1 - unit(sample.value, domain.value)) *
          100
        ).toFixed(3)}`,
    )
    .join(' ');

  const slopeMax = slopeLimit(domain);
  const slopeMin = -slopeMax;

  // Laid out flat before the JSX: the tangent line and the tangent handle are
  // drawn from the same anchor, and one plain list keeps both maps simple
  // expressions.
  const tangents: TangentHandle[] = [];
  if (showTangents) {
    for (const [index, point] of points.entries()) {
      for (const side of tangentSides) {
        tangents.push({
          index,
          side,
          u: unit(point.time, domain.time),
          v: unit(point.value, domain.value),
          anchor: tangentAnchor(point, side, domain),
          slope: side === 'in' ? point.inTangent : point.outTangent,
        });
      }
    }
  }

  return (
    <div
      role="group"
      aria-label={label}
      className={classNames(
        'terminal-curve-editor',
        'group grid min-w-0 gap-hq-2 text-hq-text-1 font-mono text-hq-xs',
        className,
      )}
      data-adjusting={adjusting ? '' : undefined}
      data-readonly={readOnly ? '' : undefined}
    >
      <div className="terminal-curve-editor__header flex justify-between gap-hq-2 uppercase">
        <span className="terminal-curve-editor__label">{label}</span>
        {readout === null ? null : (
          <span
            className="terminal-curve-editor__readout text-hq-text-0 tabular-nums"
            aria-live="polite"
          >
            {readout}
          </span>
        )}
      </div>
      <div
        ref={plotRef}
        className="terminal-curve-editor__plot relative w-full aspect-[var(--terminal-curve-editor-aspect,2/1)] border border-hq-line-1 outline-none bg-hq-bg-0 cursor-crosshair touch-none select-none focus-visible:border-hq-line-focus group-data-[adjusting]:cursor-grabbing group-data-[readonly]:cursor-default"
        tabIndex={readOnly ? -1 : 0}
        onKeyDown={handlePlotKeyDown}
        onDoubleClick={handlePlotDoubleClick}
      >
        <svg
          className="terminal-curve-editor__svg absolute inset-0 block w-full h-full overflow-visible"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <g className="terminal-curve-editor__grid stroke-hq-line-1 stroke-1">
            {[25, 50, 75].map((at) => (
              <line
                key={`v${at}`}
                x1={at}
                y1={0}
                x2={at}
                y2={100}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {[25, 50, 75].map((at) => (
              <line
                key={`h${at}`}
                x1={0}
                y1={at}
                x2={100}
                y2={at}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
          {tangents.map((tangent) => (
            <line
              key={`${tangent.side}${tangent.index}`}
              className="terminal-curve-editor__tangent-line stroke-hq-text-2 stroke-1 [stroke-dasharray:3_3]"
              x1={tangent.u * 100}
              y1={(1 - tangent.v) * 100}
              x2={tangent.anchor.u * 100}
              y2={(1 - tangent.anchor.v) * 100}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {pathData === '' ? null : (
            <path
              className="terminal-curve-editor__path fill-none stroke-hq-accent stroke-[1.5] [stroke-linecap:round] [stroke-linejoin:round]"
              d={pathData}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {points.map((point, index) => (
          <div
            key={`point${index}`}
            role="slider"
            tabIndex={0}
            className="terminal-curve-editor__handle absolute box-border w-3 h-3 border border-hq-accent outline-none bg-hq-bg-0 cursor-grab touch-none -translate-x-1/2 -translate-y-1/2 hover:bg-hq-accent data-[active]:bg-hq-accent focus-visible:border-hq-line-focus focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] group-data-[adjusting]:cursor-grabbing group-data-[readonly]:cursor-default group-data-[readonly]:opacity-[0.62]"
            data-handle="point"
            data-index={index}
            data-active={active?.kind === 'point' && active.index === index ? '' : undefined}
            aria-label={`${label}: точка ${index + 1} из ${points.length}, ${formatTime(point.time)}`}
            aria-orientation="vertical"
            aria-valuemin={Math.min(domain.value[0], domain.value[1])}
            aria-valuemax={Math.max(domain.value[0], domain.value[1])}
            aria-valuenow={point.value}
            aria-valuetext={`${formatValue(point.value)} при ${formatTime(point.time)}`}
            aria-readonly={readOnly ? true : undefined}
            style={{
              left: percent(unit(point.time, domain.time)),
              top: percent(1 - unit(point.value, domain.value)),
            }}
            onFocus={() => setActive({ kind: 'point', index })}
            onBlur={() => setActive(null)}
            onKeyDown={(event) => handleKeyDown(event, 'point', index)}
            onPointerDown={(event) => handlePointerDown(event, 'point', index)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
          />
        ))}
        {tangents.map((tangent) => (
          <div
            key={`${tangent.side}${tangent.index}`}
            role="slider"
            tabIndex={0}
            className="terminal-curve-editor__tangent absolute box-border w-2 h-2 rounded-full border border-hq-text-2 outline-none bg-hq-bg-0 cursor-grab touch-none -translate-x-1/2 -translate-y-1/2 hover:bg-hq-text-2 data-[active]:bg-hq-text-2 focus-visible:border-hq-line-focus focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] group-data-[adjusting]:cursor-grabbing group-data-[readonly]:cursor-default group-data-[readonly]:opacity-[0.62]"
            data-handle={tangent.side}
            data-index={tangent.index}
            data-active={
              active?.kind === tangent.side && active.index === tangent.index ? '' : undefined
            }
            aria-label={`${label}: точка ${tangent.index + 1}, касательная ${
              tangent.side === 'in' ? 'входа' : 'выхода'
            }`}
            aria-orientation="vertical"
            aria-valuemin={slopeMin}
            aria-valuemax={slopeMax}
            aria-valuenow={tangent.slope}
            aria-valuetext={formatNumber(tangent.slope)}
            aria-readonly={readOnly ? true : undefined}
            style={{ left: percent(tangent.anchor.u), top: percent(1 - tangent.anchor.v) }}
            onFocus={() => setActive({ kind: tangent.side, index: tangent.index })}
            onBlur={() => setActive(null)}
            onKeyDown={(event) => handleKeyDown(event, tangent.side, tangent.index)}
            onPointerDown={(event) => handlePointerDown(event, tangent.side, tangent.index)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
          />
        ))}
      </div>
    </div>
  );
}
