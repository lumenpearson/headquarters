import { getSettingDefinition, settingsDefinitions } from '@gremuchaya/settings-schema';
import { describe, expect, it } from 'vitest';

import {
  presentationBindings,
  resolvePresentation,
  settingsWithoutPresentation,
} from './presentation';

describe('personalization presentation bindings', () => {
  it('binds only settings the schema actually declares', () => {
    const unknown = presentationBindings
      .map((binding) => binding.setting)
      .filter((id) => getSettingDefinition(id) === undefined);

    expect(unknown).toEqual([]);
  });

  it('accounts for every declared setting, so none can be inert unnoticed', () => {
    const bound = new Set(presentationBindings.map((binding) => binding.setting));
    const excused = new Set(Object.keys(settingsWithoutPresentation));

    const unaccounted = settingsDefinitions
      .map((definition) => definition.id)
      .filter((id) => !bound.has(id) && !excused.has(id));

    // Sixteen of thirty-nine definitions were drawn, validated, saved and read
    // by nothing, and nothing said so until the registry was recounted by hand
    // twice (C20, C31). A new definition now has to declare where it is read.
    expect(unaccounted).toEqual([]);
  });

  it('excuses only settings that exist, and only once each', () => {
    const bound = new Set(presentationBindings.map((binding) => binding.setting));
    for (const [id, reason] of Object.entries(settingsWithoutPresentation)) {
      expect(getSettingDefinition(id), `${id} is excused but not declared`).toBeDefined();
      // An excuse and a binding together would mean the excuse is stale.
      expect(bound.has(id), `${id} is both bound and excused`).toBe(false);
      expect(reason.length, `${id} is excused without a reason`).toBeGreaterThan(20);
    }
  });

  it('falls back to the definition’s own default rather than a literal at the call site', () => {
    const resolved = resolvePresentation({});

    // Every attribute is present with the schema's default, so a value that was
    // never set and one that was set to the default look identical downstream.
    expect(resolved.attributes['data-theme']).toBe('terminal-red');
    expect(resolved.attributes['data-layout-density']).toBe('dense');
    expect(resolved.attributes['data-operational-context']).toBe('on');
    // A custom property at its default is not emitted at all: declaring one
    // would inherit a value where the design had none, and `letter-spacing` at
    // the shell root changes the metrics of every line in the application.
    expect(resolved.customProperties['--ops-type-scale-setting']).toBeUndefined();
    expect(resolved.customProperties['--ops-letter-spacing']).toBeUndefined();
  });

  it('refuses a value the definition would reject and uses the default instead', () => {
    const resolved = resolvePresentation({
      'themes.id': 'a-theme-that-does-not-exist',
      'typography.scale': Number.NaN,
    });

    // The draft is validated on the way in, but a persisted blob from an older
    // build is not: falling back keeps a stale value from reaching a selector
    // that has no rule for it.
    expect(resolved.attributes['data-theme']).toBe('terminal-red');
    expect(resolved.customProperties['--ops-type-scale-setting']).toBeUndefined();
  });

  it('carries a chosen value through unchanged', () => {
    const resolved = resolvePresentation({
      'themes.id': 'amber-crt',
      'colors.accent': 'cyan',
      'accessibility.reducedMotion': true,
      'animations.intensity': 0.25,
    });

    expect(resolved.attributes['data-theme']).toBe('amber-crt');
    expect(resolved.attributes['data-accent']).toBe('cyan');
    expect(resolved.attributes['data-reduced-motion']).toBe('on');
    expect(resolved.customProperties['--ops-animation-intensity']).toBe('0.25');
  });
});
