// @vitest-environment jsdom
import { getSettingDefinition } from '@gremuchaya/settings-schema';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SchemaSetting, settingLabel } from './SchemaSetting';

/*
 * The `control` member of a number editor decides the control, and the row is
 * what prints the setting's name -- both halves of the slider work: a slider
 * where the definition asks for one, and no second copy of the name above the
 * track. The duplicate is what the catalogue walk in `EditPanel.test.tsx`
 * tripped over when the slider still drew its own label.
 */
describe('SchemaSetting number editors', () => {
  it('draws a slider where the definition asks for one, printing the name once', () => {
    const definition = getSettingDefinition('sizes.tileGap');
    if (definition === undefined) throw new Error('sizes.tileGap is not declared');
    if (definition.editor.kind !== 'number') throw new Error('sizes.tileGap is not a number');
    expect(definition.editor.control).toBe('slider');

    render(
      <SchemaSetting definition={definition} value={4} changed={false} onValueChange={() => {}} />,
    );

    expect(screen.getByRole('slider', { name: settingLabel('sizes.tileGap') })).toBeTruthy();
    expect(screen.getAllByText(settingLabel('sizes.tileGap'))).toHaveLength(1);
  });

  it('keeps the typed field for a number no definition marked as a slider', () => {
    const definition = getSettingDefinition('sizes.panelHeader');
    if (definition === undefined) throw new Error('sizes.panelHeader is not declared');

    render(
      <SchemaSetting definition={definition} value={42} changed={false} onValueChange={() => {}} />,
    );

    expect(screen.getByRole('textbox', { name: settingLabel('sizes.panelHeader') })).toBeTruthy();
    expect(screen.queryByRole('slider')).toBeNull();
  });
});

/**
 * `settingsAwaitingTheirFeature` names two settings an operator can already
 * change with no effect. Before this, the catalogue said nothing: the row
 * looked exactly like every wired one.
 */
describe('SchemaSetting warns about settings nothing reads yet', () => {
  it('prints the awaiting-feature notice beside layout.tileMinimumWidth', () => {
    const definition = getSettingDefinition('layout.tileMinimumWidth');
    if (definition === undefined) throw new Error('layout.tileMinimumWidth is not declared');

    render(
      <SchemaSetting
        definition={definition}
        value={definition.defaultValue}
        changed={false}
        onValueChange={() => {}}
      />,
    );

    expect(screen.getByText('ПОКА НЕ ДЕЙСТВУЕТ — изменение ни на что не влияет')).toBeTruthy();
  });

  /*
   * `simulation.preset` left `settingsAwaitingTheirFeature` once
   * `simulateChannelReading` started falling back to
   * `simulationPresetCriticality` for a channel with no drawn curve (F12,
   * R31). The notice would otherwise tell an operator a working control does
   * nothing.
   */
  it('prints no notice beside simulation.preset, which now has a reader', () => {
    const definition = getSettingDefinition('simulation.preset');
    if (definition === undefined) throw new Error('simulation.preset is not declared');

    render(
      <SchemaSetting
        definition={definition}
        value={definition.defaultValue}
        changed={false}
        onValueChange={() => {}}
      />,
    );

    expect(screen.queryByText('ПОКА НЕ ДЕЙСТВУЕТ — изменение ни на что не влияет')).toBeNull();
  });

  it('prints no notice beside a setting with a real reader', () => {
    const definition = getSettingDefinition('sizes.tileGap');
    if (definition === undefined) throw new Error('sizes.tileGap is not declared');

    render(
      <SchemaSetting definition={definition} value={4} changed={false} onValueChange={() => {}} />,
    );

    expect(screen.queryByText('ПОКА НЕ ДЕЙСТВУЕТ — изменение ни на что не влияет')).toBeNull();
  });
});
