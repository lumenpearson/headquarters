// @vitest-environment jsdom
import { getSettingDefinition, type SettingDefinition } from '@gremuchaya/settings-schema';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { localizedSettingLabel } from '../../application/localization/settingLocalization';
import { operationsStore } from '../../state/operationsStore';
import { SchemaSetting } from './SchemaSetting';

function definitionFor(id: string): SettingDefinition {
  const definition = getSettingDefinition(id);
  if (definition === undefined) throw new Error(`${id} is not declared`);
  return definition;
}

/**
 * Rendered exactly as `SettingsScreen` and `EditPanel` render every other
 * setting: the current draft value in, `applySettingsPatch` out. A curve that
 * wrote through some path of its own would be a curve outside undo, outside the
 * history and outside the issue draft.
 */
function renderCurve(id: string) {
  const definition = definitionFor(id);
  const value = operationsStore.getState().personalization.draft.values[id];
  return render(
    <SchemaSetting
      definition={definition}
      value={value ?? definition.defaultValue}
      changed={false}
      onValueChange={(next) => {
        operationsStore.getState().applySettingsPatch([{ id, value: next }]);
      }}
    />,
  );
}

/**
 * Only the point handles. A hermite or bezier curve also draws a slider for
 * each tangent, and a query by role alone would count six controls on a
 * two-point curve and call it a six-point one.
 */
const pointHandles = (container: HTMLElement): readonly HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-handle="point"]'),
];

const storedCurve = (id: string): readonly string[] => {
  const value = operationsStore.getState().personalization.draft.values[id];
  return Array.isArray(value) ? value : [];
};

describe('CurveSetting', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('mounts the curve editor for a curve setting rather than a text field', () => {
    // The safe editor has no arbitrary text mode, and a curve is the newest
    // reason someone might reach for one: four numbers per point is exactly the
    // shape that invites a free-text field.
    const { container } = renderCurve('simulation.valueCurve');

    expect(container.querySelector('.terminal-curve-editor')).not.toBeNull();
    expect(container.querySelector('input')).toBeNull();
  });

  it('names the channel it is drawing, and follows simulation.channel', () => {
    // Asserted through the catalogue rather than against a pasted literal: the
    // label is translated now, so a hard-coded string would prove only that
    // somebody kept two copies of it in step.
    const curveLabel = localizedSettingLabel(definitionFor('simulation.valueCurve'), 'ru');
    renderCurve('simulation.valueCurve');
    expect(screen.getByRole('group', { name: new RegExp(`${curveLabel} · CPU`) })).toBeTruthy();

    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'simulation.channel', value: 'ram' }]);
    });

    expect(screen.getByRole('group', { name: new RegExp(`${curveLabel} · RAM`) })).toBeTruthy();
  });

  it('opens an undrawn channel on the flat resting line the schema declares', () => {
    // Two handles, because two points are the fewest a drag can be offered on,
    // and both at the resting reading: nothing has been drawn yet, and the plot
    // must not invent a shape the simulation would then run.
    const { container } = renderCurve('simulation.criticalityCurve');
    const handles = pointHandles(container);

    expect(handles).toHaveLength(2);
    expect(handles[0]?.getAttribute('aria-valuenow')).toBe('0');
    expect(handles[1]?.getAttribute('aria-valuenow')).toBe('0');
    // Nothing is stored until the operator actually moves something.
    expect(storedCurve('simulation.criticalityCurve')).toEqual([]);
  });

  it('writes a moved point back through the ordinary settings patch', () => {
    const { container } = renderCurve('simulation.valueCurve');
    const handle = pointHandles(container)[0];
    if (handle === undefined) throw new Error('the editor drew no handle');

    act(() => {
      fireEvent.keyDown(handle, { key: 'ArrowUp' });
    });

    // The patch went through `applySettingsPatch`, so it passed the schema's
    // own validator on the way in: an entry this component spelled wrongly
    // would have thrown rather than landed.
    expect(storedCurve('simulation.valueCurve')).toEqual(['cpu=0,51,0,0', 'cpu=1,50,0,0']);
    expect(operationsStore.getState().personalization.draft.changedIds).toContain(
      'simulation.valueCurve',
    );
    // Undo is the point of writing it as a setting rather than as state of its
    // own, so the curve has to come back off the stack with everything else.
    act(() => {
      operationsStore.getState().undoSettingsDraft();
    });
    expect(storedCurve('simulation.valueCurve')).toEqual([]);
  });

  it('leaves another channel’s points alone when one channel is dragged', () => {
    act(() => {
      operationsStore.getState().applySettingsPatch([
        { id: 'simulation.valueCurve', value: ['ram=0,40,0,0', 'ram=1,60,0,0'] },
        { id: 'simulation.channel', value: 'cpu' },
      ]);
    });
    const { container } = renderCurve('simulation.valueCurve');
    const handle = pointHandles(container)[0];
    if (handle === undefined) throw new Error('the editor drew no handle');

    act(() => {
      fireEvent.keyDown(handle, { key: 'ArrowUp' });
    });

    expect(storedCurve('simulation.valueCurve')).toEqual([
      'cpu=0,51,0,0',
      'cpu=1,50,0,0',
      'ram=0,40,0,0',
      'ram=1,60,0,0',
    ]);
  });

  it('draws the points already stored for the channel', () => {
    act(() => {
      operationsStore.getState().applySettingsPatch([
        {
          id: 'simulation.valueCurve',
          value: ['cpu=0,10,0,0', 'cpu=0.5,90,0,0', 'cpu=1,10,0,0'],
        },
      ]);
    });
    const { container } = renderCurve('simulation.valueCurve');

    expect(pointHandles(container).map((handle) => handle.getAttribute('aria-valuenow'))).toEqual([
      '10',
      '90',
      '10',
    ]);
  });

  it('offers tangent handles only for the interpolations that read them', () => {
    // A linear or a stepped curve would otherwise offer a control that moves
    // nothing: `evaluateCurve` never looks at a tangent for either.
    act(() => {
      operationsStore
        .getState()
        .applySettingsPatch([{ id: 'simulation.interpolation', value: 'linear' }]);
    });
    const linear = renderCurve('simulation.valueCurve');
    expect(linear.container.querySelectorAll('.terminal-curve-editor__tangent')).toHaveLength(0);
    linear.unmount();

    act(() => {
      operationsStore
        .getState()
        .applySettingsPatch([{ id: 'simulation.interpolation', value: 'bezier' }]);
    });
    const bezier = renderCurve('simulation.valueCurve');
    // Two sides on each of the two resting points.
    expect(bezier.container.querySelectorAll('.terminal-curve-editor__tangent')).toHaveLength(4);
  });

  it('labels the time axis in the seconds of one period', () => {
    // The period is a setting, so the axis has no number of its own.
    act(() => {
      operationsStore
        .getState()
        .applySettingsPatch([{ id: 'simulation.periodSeconds', value: 300 }]);
    });
    const { container } = renderCurve('simulation.valueCurve');

    expect(pointHandles(container)[1]?.getAttribute('aria-label')).toContain('300 с');
  });
});
