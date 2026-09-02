import { getSettingDefinition, settingsDefinitions } from '@gremuchaya/settings-schema';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  derivedPresentationOutputs,
  presentationBindings,
  resolvePresentation,
  settingsReadElsewhere,
  settingsWithoutPresentation,
} from './presentation';

/** `apps/hq/src`, from this file rather than from the working directory. */
const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function everySourceFile(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return everySourceFile(path);
    return /\.(css|ts|tsx)$/.test(entry) ? [path] : [];
  });
}

/**
 * Prose cannot consume a custom property, so prose is removed before the
 * search.
 *
 * Without this the fixture counts the comment that *explains* a binding as
 * though it were the rule that reads it — and a rule explained well enough is
 * exactly the rule most likely to be deleted by someone who trusts the
 * explanation. Both block comments and line comments go; `//` is only treated
 * as one when it opens the line, so a `https://` inside a string survives.
 */
function withoutProse(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

/**
 * Everything under `apps/hq/src` that could actually consume a binding.
 *
 * Three exclusions, and each one was learned by watching this fixture pass over
 * something demonstrably dead. The bridge itself is where a property name is
 * *written*, so counting it reports every binding as consumed. Tests are
 * excluded one step removed: the first version passed because the comment
 * explaining the dead properties named them and this file was scanning itself.
 * Comments are excluded for the third turn of the same screw — the CSS comments
 * added beside two new declarations named the properties they explained, so
 * deleting the declarations would have left the fixture green.
 *
 * The rule underneath all three: a check must not be able to satisfy the thing
 * it checks.
 */
const consumingSources = everySourceFile(sourceRoot)
  .filter((path) => !path.endsWith('presentation.ts') && !/\.test\.tsx?$/.test(path))
  .map((path) => withoutProse(readFileSync(path, 'utf8')))
  .join('\n');

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

  /*
   * A binding is not a consumer, and until this test existed nothing said so.
   *
   * The two tests above prove a definition is *accounted for* — bound here or
   * excused there. Neither proves anything reads what a binding emits, and five
   * settings had been shipping a custom property that no stylesheet and no
   * module mentioned: `--ops-tile-min-width`, `--ops-line-opacity`,
   * `--ops-background-overlay`, `--ops-background-blur` and
   * `--ops-background-speed`. They were drawn, validated, saved, written onto
   * the shell root — and read by nothing, which is C20 again one level down,
   * under the very bridge built to close it.
   */
  it('emits no custom property that nothing reads', () => {
    const unread = [
      ...presentationBindings
        .filter((binding) => binding.kind === 'custom-property')
        .map((binding) => binding.property),
      // The fourth turn of the same screw. `--ops-control-floor` is written
      // beside the binding loop, not inside it, so for as long as this list
      // read only the table the one property computed from two settings was
      // the one property nothing verified.
      ...derivedPresentationOutputs.customProperties,
    ].filter((property) => !consumingSources.includes(property));

    expect(unread).toEqual([]);
  });

  it('emits no attribute that nothing selects on', () => {
    const unread = [
      ...presentationBindings
        .filter((binding) => binding.kind === 'attribute')
        .map((binding) => binding.attribute),
      // `data-control-sizing` is the switch that makes the floor rule exist at
      // all: without a selector on it the property above is inert even when a
      // stylesheet reads it.
      ...derivedPresentationOutputs.attributes,
    ]
      // A stylesheet selects on it, or a module reads it. Either is a consumer;
      // neither being present means the operator moves a control for nothing.
      .filter((attribute) => !consumingSources.includes(attribute));

    expect(unread).toEqual([]);
  });

  /*
   * The category that actually produced the defect, mechanized.
   *
   * `general.localOnly` was never a broken binding. It was an excuse — "Read by
   * the pairing surface, which decides whether a group is offered" — naming a
   * surface that does not exist, and it passed every test in this file because
   * the only thing asked of an excuse was that it be longer than twenty
   * characters. A sentence can claim anything.
   *
   * A setting said to be read somewhere must therefore be named somewhere. That
   * is weaker than proving the read does what the sentence says, and far
   * stronger than counting its characters: an excuse for a consumer that was
   * never written now fails here.
   */
  it('does not excuse a setting as read somewhere that never names it', () => {
    const absent = Object.keys(settingsReadElsewhere).filter(
      (id) => !consumingSources.includes(id),
    );

    expect(absent).toEqual([]);
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
      'patterns.opacity': 0.25,
    });

    expect(resolved.attributes['data-theme']).toBe('amber-crt');
    expect(resolved.attributes['data-accent']).toBe('cyan');
    expect(resolved.attributes['data-reduced-motion']).toBe('on');
    // `animations.intensity` used to stand here. It is no longer bound: the
    // property it emitted was read by nothing, and the shell spends the value
    // itself as two durations, so it is now accounted as derived rather than
    // bound.
    expect(resolved.customProperties['--ops-pattern-opacity']).toBe('0.25');
  });

  /*
   * `popups.overlayBlur` (default 16) is the operator-controlled strength
   * behind every dialog/drawer/panel scrim. Its consumers -- the two `::before`
   * scrims in `operations.css` and `TERMINAL_*_BACKDROP_UTILITY` in
   * `packages/ui` -- each carry their own literal `var()` fallback, so the
   * binding only has to prove it stays silent at the default and carries a
   * moved value through, the same contract as every other custom property.
   */
  it('binds popups.overlayBlur to --ops-overlay-blur, silent at its default of 16', () => {
    expect(resolvePresentation({}).customProperties['--ops-overlay-blur']).toBeUndefined();
    expect(
      resolvePresentation({ 'popups.overlayBlur': 16 }).customProperties['--ops-overlay-blur'],
    ).toBeUndefined();

    expect(
      resolvePresentation({ 'popups.overlayBlur': 0 }).customProperties['--ops-overlay-blur'],
    ).toBe('0px');
    expect(
      resolvePresentation({ 'popups.overlayBlur': 24 }).customProperties['--ops-overlay-blur'],
    ).toBe('24px');
  });
});
