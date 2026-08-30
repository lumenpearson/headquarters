import { getSettingDefinition } from '@gremuchaya/settings-schema';
import { iconSetIds } from '@gremuchaya/ui/primitives';
import { describe, expect, it } from 'vitest';

describe('styles.iconSet', () => {
  // The names are written twice -- once in the schema, once in the icon
  // registry `@gremuchaya/ui` keeps -- because the definition exposes only a
  // validator. This is the same drift guard `schemes.test.ts` applies to
  // `keybindSchemes`: the two lists cannot move apart without a test failing.
  it('offers exactly the libraries the icon registry can answer for', () => {
    const definition = getSettingDefinition('styles.iconSet');
    expect(definition?.editor.kind).toBe('enum');
    const options = definition?.editor.kind === 'enum' ? definition.editor.options : [];
    expect([...options].sort()).toEqual([...iconSetIds].sort());
  });

  it('defaults to terminal, so an operator who never opens this setting sees no change', () => {
    const definition = getSettingDefinition('styles.iconSet');
    expect(definition?.defaultValue).toBe('terminal');
  });
});
