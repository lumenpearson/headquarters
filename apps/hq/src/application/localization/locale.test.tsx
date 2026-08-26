// @vitest-environment jsdom
import { getSettingDefinition } from '@gremuchaya/settings-schema';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { operationsStore } from '@/state/operationsStore';

import { collator, compareText, dateTimeFormat, foldCase } from './intl';
import { appLocales, sourceLocale } from './messages';
import { intlTag, readAppLocale, resolveAppLocale, useMessage, useTranslate } from './locale';

const definition = getSettingDefinition('localization.locale');

/** 2026-09-12 -- a date whose two locales disagree about the separators. */
const instant = new Date(Date.UTC(2026, 8, 12, 21, 5, 7));

/** Mixed registers, which is what every registry on every screen holds. */
const registry = ['ОБЪЕКТ', 'K-17', 'АРХИВ', 'Alpha'];

function chooseLocale(locale: string): void {
  act(() => {
    operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: locale }]);
  });
}

function LabelProbe() {
  return <output>{useMessage('nav.overview')}</output>;
}

function DateProbe() {
  // Through the hook rather than through `t` alone: the subscription is the
  // thing under test, and a component that only called `dateTimeFormat` would
  // pass this by re-rendering for some other reason.
  useTranslate();
  // Pinned to UTC so the reading is the same on every machine: the assertion
  // is about the separator the locale chooses, not about where the test ran.
  return <output>{dateTimeFormat({ dateStyle: 'short', timeZone: 'UTC' }).format(instant)}</output>;
}

function SortProbe() {
  useTranslate();
  return <output>{[...registry].sort(compareText).join(' ')}</output>;
}

describe('localization.locale', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('offers exactly the locales the definition accepts', () => {
    for (const locale of appLocales) {
      expect(definition?.validate(locale), locale).toBe(true);
    }
    expect(definition?.validate('uk')).toBe(false);
  });

  it('narrows an unusable value to the definition’s own default', () => {
    // The literal in `messages.ts` cannot drift from the schema without this
    // failing, which is the same guarantee `dateTime.mode` has.
    expect(resolveAppLocale('klingon')).toBe(definition?.defaultValue);
    expect(sourceLocale).toBe(definition?.defaultValue);
  });

  it('reads the setting rather than a literal of its own', () => {
    expect(readAppLocale()).toBe('ru');
    chooseLocale('en');
    expect(readAppLocale()).toBe('en');
    expect(intlTag()).toBe('en-GB');
  });
});

describe('a locale change reaches the screen', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('re-renders a label', () => {
    render(<LabelProbe />);
    expect(screen.getByRole('status').textContent).toBe('ОБЗОР');

    chooseLocale('en');

    // Not a fresh render: the same mounted component, which is what
    // `useAppLocale` buys and what a plain `t()` call could never do.
    expect(screen.getByRole('status').textContent).toBe('OVERVIEW');
  });

  it('re-renders a formatted date', () => {
    render(<DateProbe />);
    // Russian writes 12.09.2026; British English writes 12/09/2026. The
    // separator is the whole assertion: the four formatters this module
    // replaced were built once at import and could never have changed it.
    expect(screen.getByRole('status').textContent).toBe('12.09.2026');

    chooseLocale('en');

    expect(screen.getByRole('status').textContent).toBe('12/09/2026');
  });

  it('re-sorts a list', () => {
    render(<SortProbe />);
    // Russian collation puts Cyrillic before Latin, so the objects registry
    // leads with its Russian names and the call signs follow. English
    // collation reverses that. Both orders are correct for their reader, and
    // a hard-coded `'ru-RU'` gave one of them the other's.
    expect(screen.getByRole('status').textContent).toBe('АРХИВ ОБЪЕКТ Alpha K-17');

    chooseLocale('en');

    expect(screen.getByRole('status').textContent).toBe('Alpha K-17 АРХИВ ОБЪЕКТ');
  });
});

describe('the cached Intl instances', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('hands back one instance per shape while the locale stands still', () => {
    // The saving the four hoisted formatters existed for: the shell clock
    // formats once a second for the life of the session.
    expect(dateTimeFormat({ dateStyle: 'short' })).toBe(dateTimeFormat({ dateStyle: 'short' }));
    expect(dateTimeFormat({ dateStyle: 'short' })).not.toBe(dateTimeFormat({ dateStyle: 'long' }));
    expect(collator()).toBe(collator());
  });

  it('does not hand back a stale instance once the locale moves', () => {
    const before = collator();
    // ICU canonicalises the tag it was given, so the reading is `ru` rather
    // than `ru-RU`; what matters is that it is not the other language's.
    expect(before.resolvedOptions().locale).toBe('ru');

    chooseLocale('en');

    expect(collator()).not.toBe(before);
    expect(collator().resolvedOptions().locale).toBe('en');
  });

  it('ignores the order the options were written in', () => {
    // `{hour, minute}` and `{minute, hour}` ask for the same formatter; a key
    // that did not sort would build and keep two.
    expect(dateTimeFormat({ hour: '2-digit', minute: '2-digit' })).toBe(
      dateTimeFormat({ minute: '2-digit', hour: '2-digit' }),
    );
  });

  it('folds case through the locale rather than through the machine', () => {
    expect(foldCase('ОБЪЕКТ K-17')).toBe('объект k-17');
  });

  it('sorts operational identifiers by number and not by digit', () => {
    // `numeric` is the default this application needs: without it the tenth
    // camera lands between the first and the second.
    expect([...['K-2', 'K-10', 'K-9']].sort(compareText)).toEqual(['K-2', 'K-9', 'K-10']);
  });
});
