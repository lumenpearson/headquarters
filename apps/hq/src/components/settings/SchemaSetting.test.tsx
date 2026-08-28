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
