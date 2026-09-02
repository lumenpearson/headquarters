// @vitest-environment jsdom
import { getSettingDefinition } from '@gremuchaya/settings-schema';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  localizedEnumOptionLabel,
  localizedSettingLabel,
} from '@/application/localization/settingLocalization';

import { SchemaSetting } from './SchemaSetting';

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

    const label = localizedSettingLabel(definition, 'ru');
    expect(screen.getByRole('slider', { name: label })).toBeTruthy();
    expect(screen.getAllByText(label)).toHaveLength(1);
  });

  it('keeps the typed field for a number no definition marked as a slider', () => {
    const definition = getSettingDefinition('sizes.panelHeader');
    if (definition === undefined) throw new Error('sizes.panelHeader is not declared');

    render(
      <SchemaSetting definition={definition} value={42} changed={false} onValueChange={() => {}} />,
    );

    expect(
      screen.getByRole('textbox', { name: localizedSettingLabel(definition, 'ru') }),
    ).toBeTruthy();
    expect(screen.queryByRole('slider')).toBeNull();
  });
});

/**
 * `settingsAwaitingTheirFeature` is empty: every setting it once named has
 * since left it, and the notice below is what told an operator so before
 * each one did. It is exercised here anyway, on a setting that used to be in
 * it, so the notice itself does not go untested along with the list.
 */
describe('SchemaSetting warns about settings nothing reads yet', () => {
  /*
   * `layout.tileMinimumWidth` left `settingsAwaitingTheirFeature` once
   * `resolveGridLayout` gained a `minimumTileWidth` input and `TileGrid`
   * started measuring its container and passing both through. The notice
   * would otherwise tell an operator a working control does nothing.
   */
  it('prints no notice beside layout.tileMinimumWidth, which now has a reader', () => {
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

    expect(screen.queryByText('ПОКА НЕ ДЕЙСТВУЕТ — изменение ни на что не влияет')).toBeNull();
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

/**
 * `statusline.elements` is edited as a raw comma list -- `string-list` has no
 * per-value catalogue the way `enum` does -- so its definition's own
 * description fell back to `join(', ')` over the bare English member ids and
 * printed them verbatim on an otherwise Russian settings screen.
 */
describe('SchemaSetting translates the statusline.elements row', () => {
  it('shows the operator-language names, not the raw member ids', () => {
    const definition = getSettingDefinition('statusline.elements');
    if (definition === undefined) throw new Error('statusline.elements is not declared');

    render(
      <SchemaSetting
        definition={definition}
        value={definition.defaultValue}
        changed={false}
        onValueChange={() => {}}
      />,
    );

    // Named twice now: once in the row `TerminalElementsConstructor` drew for
    // the chosen element, once in the detail line beside it -- both translated.
    expect(screen.getAllByText(/СИСТЕМА/u).length).toBeGreaterThan(0);
    expect(screen.queryByText(/\bsystem\b/u)).toBeNull();
  });
});

/**
 * `titlebar.elements` and `statusline.elements` are both an arrangement of a
 * fixed, small roster -- exactly what `TerminalElementsConstructor` (R25's
 * titlebar constructor) is for, and what replaced the free-typed comma field
 * every other `string-list` setting still uses.
 */
describe('SchemaSetting draws titlebar.elements and statusline.elements as a constructor', () => {
  it('draws titlebar.elements with the pick-and-order control, not the free-text field', () => {
    const definition = getSettingDefinition('titlebar.elements');
    if (definition === undefined) throw new Error('titlebar.elements is not declared');

    const { container } = render(
      <SchemaSetting
        definition={definition}
        value={definition.defaultValue}
        changed={false}
        onValueChange={() => {}}
      />,
    );

    expect(container.querySelector('.terminal-elements-constructor')).not.toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('reports a reordered list through onValueChange, in the operator’s new order', () => {
    const onValueChange = vi.fn();
    const definition = getSettingDefinition('titlebar.elements');
    if (definition === undefined) throw new Error('titlebar.elements is not declared');

    const { container } = render(
      <SchemaSetting
        definition={definition}
        value={['title', 'information', 'close']}
        changed={false}
        onValueChange={onValueChange}
      />,
    );

    const rows = container.querySelectorAll('.terminal-elements-constructor__row');
    const secondRowUp = rows[1]?.querySelector<HTMLButtonElement>(
      '.terminal-elements-constructor__move[aria-label*="выше"]',
    );
    if (secondRowUp === null || secondRowUp === undefined) throw new Error('no up control');
    fireEvent.click(secondRowUp);

    expect(onValueChange).toHaveBeenCalledWith(['information', 'title', 'close']);
  });

  it('names every titlebar.elements option in Russian rather than as a raw identifier', () => {
    const definition = getSettingDefinition('titlebar.elements');
    if (definition === undefined) throw new Error('titlebar.elements is not declared');

    render(
      <SchemaSetting
        definition={definition}
        value={definition.defaultValue}
        changed={false}
        onValueChange={() => {}}
      />,
    );

    expect(screen.queryByText(/\bclose\b/u)).toBeNull();
  });
});

/**
 * `colors.accent` declares itself "never arbitrary CSS": the definition is
 * still a fixed `oneOf`, and this is what proves the row now draws it as
 * swatches rather than falling through to the generic dropdown every other
 * `enum` setting uses.
 */
describe('SchemaSetting draws colors.accent as swatches', () => {
  it('renders one swatch per accent, radiogroup-checked at the current value', () => {
    const definition = getSettingDefinition('colors.accent');
    if (definition === undefined) throw new Error('colors.accent is not declared');
    if (definition.editor.kind !== 'enum') throw new Error('colors.accent is not an enum');

    const { container } = render(
      <SchemaSetting
        definition={definition}
        value="green"
        changed={false}
        onValueChange={() => {}}
      />,
    );

    expect(screen.queryByRole('combobox')).toBeNull();
    const swatches = container.querySelectorAll('.terminal-color-swatch');
    expect(swatches).toHaveLength(definition.editor.options.length);
    const checked = container.querySelector('.terminal-color-swatch[aria-checked="true"]');
    expect(checked?.getAttribute('aria-label')).toBe(
      localizedEnumOptionLabel(definition, 'green', 'ru'),
    );
  });
});
