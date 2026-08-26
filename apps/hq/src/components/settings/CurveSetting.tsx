'use client';

import { sampleCurve, type SimulationCurveLike } from '@gremuchaya/domain';
import type { SettingEditor } from '@gremuchaya/settings-schema';
import { TerminalCurveEditor } from '@gremuchaya/ui/primitives';
import { useMemo } from 'react';

import {
  formatCurveNumber,
  readCurvePoints,
  readSimulationSettings,
  restingCurvePoints,
  withChannelCurve,
} from '@/application/simulation/simulationCurves';
import { useOperationsStore } from '@/state/operationsStore';

/**
 * The safe editor's control for a `curve` setting.
 *
 * R31 asks for a function graph the operator drags to move the maxima and
 * minima of the rate of change. The plot itself is `TerminalCurveEditor` in
 * `packages/ui`, which never interpolates: it draws the polyline it is handed
 * and moves the points that produced it. The interpolation is the domain's
 * `sampleCurve`, so the line under the operator's pointer is drawn by the same
 * arithmetic the simulation will read the curve with.
 *
 * Every change leaves through `onValueChange`, which is the caller's ordinary
 * `applySettingsPatch`. A dragged point therefore lands in undo, in the
 * settings history and in the issue draft exactly as a toggled switch does.
 */
type CurveEditorDeclaration = Extract<SettingEditor, { kind: 'curve' }>;

/**
 * How finely the curve is drawn. A drawing resolution, not a property of the
 * curve: the stored points are whatever the operator placed, and this only
 * decides how smooth the line between them looks.
 */
const plotSampleCount = 160;

/** The snap grid, as a hundredth of each declared domain rather than a constant. */
const snapShare = 100;

export function CurveSetting({
  editor,
  label,
  value,
  onValueChange,
}: {
  readonly editor: CurveEditorDeclaration;
  readonly label: string;
  readonly value: unknown;
  readonly onValueChange: (value: readonly string[]) => void;
}) {
  /*
   * The whole draft, because a curve is drawn from five settings at once: the
   * two curves themselves, the channel being edited, the interpolation and the
   * period the timeline is measured in. The record's identity only changes when
   * a patch is applied, so the shallow comparison runs over settled values.
   */
  const values = useOperationsStore((state) => state.personalization.draft.values);
  const settings = useMemo(() => readSimulationSettings(values), [values]);

  const entries = useMemo(
    () => (Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : []),
    [value],
  );

  const points = useMemo(() => {
    const drawn = readCurvePoints(entries).get(settings.channel);
    // Nothing drawn for this channel is not an empty curve: the operator gets
    // the flat line the schema declares as its resting reading, and the first
    // drag is what writes an entry.
    return drawn === undefined ? restingCurvePoints(editor.timeDomain, editor.restingValue) : drawn;
  }, [entries, settings.channel, editor.timeDomain, editor.restingValue]);

  const path = useMemo(() => {
    const curve: SimulationCurveLike = {
      points,
      interpolation: settings.interpolation,
      loop: settings.loop,
    };
    return sampleCurve(curve, plotSampleCount, {
      from: editor.timeDomain[0],
      to: editor.timeDomain[1],
    });
  }, [points, settings.interpolation, settings.loop, editor.timeDomain]);

  const timeSpan = editor.timeDomain[1] - editor.timeDomain[0];
  const valueSpan = editor.valueDomain[1] - editor.valueDomain[0];

  return (
    <TerminalCurveEditor
      label={`${label} · ${settings.channel.toUpperCase()}`}
      points={points}
      path={path}
      domain={{ time: editor.timeDomain, value: editor.valueDomain }}
      // Tangents are only a control on the two interpolations that read them;
      // a linear or a stepped curve would offer handles that move nothing.
      showTangents={settings.interpolation === 'hermite' || settings.interpolation === 'bezier'}
      maxPoints={editor.maximumPoints}
      snap={{ time: timeSpan / snapShare, value: valueSpan / snapShare }}
      formatTime={(time) => formatSeconds(time * settings.periodSeconds)}
      formatValue={(reading) => `${formatCurveNumber(reading)}${editor.unit}`}
      onPointsChange={(next) => onValueChange(withChannelCurve(entries, settings.channel, next))}
    />
  );
}

/** A short period needs a decimal to say anything; a long one is noise with it. */
function formatSeconds(seconds: number): string {
  return `${seconds >= 10 ? Math.round(seconds).toString() : seconds.toFixed(1)} с`;
}
