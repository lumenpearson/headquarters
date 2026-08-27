import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appLocales,
  forgetMissingMessageReports,
  messageIds,
  messagesFor,
  sourceLocale,
  tokens,
  translateWith,
  type MessageId,
} from './messages';

const localeIds = (locale: (typeof appLocales)[number]): readonly string[] =>
  Object.keys(messagesFor(locale));

describe('message catalogue', () => {
  it('declares every id in every locale', () => {
    // The annotation on `en` already makes a gap a compile error. This is the
    // guard against that annotation being loosened later: a catalogue with a
    // hole renders the source language in the middle of a translated screen,
    // and nothing else in the build would say so.
    const source = new Set(localeIds(sourceLocale));
    for (const locale of appLocales) {
      expect(
        [...source].filter((id) => !localeIds(locale).includes(id)),
        locale,
      ).toEqual([]);
    }
  });

  it('declares no id that exists only outside the source locale', () => {
    // The other direction, and the one a type annotation catches least well
    // once a table is assembled rather than written: an id only `en` has is a
    // string no Russian session can ever render, so it is a translation of
    // nothing.
    const source = new Set(localeIds(sourceLocale));
    for (const locale of appLocales) {
      expect(
        localeIds(locale).filter((id) => !source.has(id)),
        locale,
      ).toEqual([]);
    }
  });

  it('gives every id text in both languages, and different text where it should differ', () => {
    for (const id of messageIds) {
      for (const locale of appLocales) {
        expect(translateWith(locale, id).length, `${locale}:${id}`).toBeGreaterThan(0);
      }
    }
    // Not a blanket claim that every pair differs -- `НАВИГАЦИЯ` and
    // `NAVIGATION` differ, `POP-UP` and `POPUPS` nearly do not -- but the two
    // tables must not be one table copied twice.
    const identical = messageIds.filter(
      (id) => translateWith('ru', id) === translateWith('en', id),
    );
    expect(identical.every((id) => id.startsWith('token.'))).toBe(true);
  });
});

describe('what a keybind description promises', () => {
  it('does not promise the import writes locally, because it may not', () => {
    /*
     * The description read `Локальный импорт материалов` / `Local material
     * import`. The gesture opens one dialog, and that dialog writes to the
     * group library whenever a group is admitted -- it says so itself, in two
     * different titles and two different descriptions. The shortcut list had no
     * such branch and named the destination anyway, so under an admitted group
     * it named the wrong one.
     *
     * The claim held here is the honest one: this label may not name a
     * destination. It is not a check that the wording never changes.
     */
    for (const locale of appLocales) {
      expect(translateWith(locale, 'keybind.files.import'), locale).not.toMatch(
        /локальн|local|групп|group/iu,
      );
    }
  });
});

describe('the non-translatable namespace', () => {
  it('answers with the same token whichever locale is asked', () => {
    for (const id of Object.keys(tokens) as MessageId[]) {
      expect(translateWith('en', id)).toBe(translateWith('ru', id));
    }
    expect(translateWith('en', 'token.utc')).toBe('UTC');
  });

  it('keeps tokens out of the locale tables entirely', () => {
    // A token declared in a locale table as well would be translatable by
    // accident: whichever table was edited first would win, and the decision
    // that `UTC` is the name of a time scale rather than a word would have to
    // be taken again for every locale.
    for (const locale of appLocales) {
      expect(
        localeIds(locale).filter((id) => id.startsWith('token.')),
        locale,
      ).toEqual([]);
    }
  });

  it('holds only machine register', () => {
    // A token is a protocol name, a unit or a state -- `UTC`, `RPC:GRPC-WEB`,
    // `UTF-8`, `PTZ`. Anything outside printable ASCII in here is a word
    // somebody put in the wrong namespace.
    for (const token of Object.values(tokens)) {
      expect(token, token).toMatch(/^[\x20-\x7E]+$/u);
    }
  });
});

describe('parameters', () => {
  it('substitutes a named parameter in both languages', () => {
    expect(translateWith('ru', 'keybind.navigate', { target: 'ОБЗОР' })).toBe('Перейти: ОБЗОР');
    expect(translateWith('en', 'keybind.navigate', { target: 'OVERVIEW' })).toBe('Go to: OVERVIEW');
  });

  it('accepts a number without the call site stringifying it', () => {
    expect(translateWith('en', 'edit.translation.count', { count: 3 })).toContain('3');
  });

  it('leaves a placeholder standing when nothing is passed for it', () => {
    // Visible rather than blank, for the same reason a missing id is
    // bracketed: `Go to: {target}` is a bug someone reports and `Go to: ` is
    // one they read past.
    expect(translateWith('en', 'keybind.navigate')).toBe('Go to: {target}');
    expect(translateWith('en', 'keybind.navigate', { other: 'x' })).toBe('Go to: {target}');
  });
});

describe('the missing-id guard', () => {
  let reported: string[];

  beforeEach(() => {
    forgetMissingMessageReports();
    reported = [];
    vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      reported.push(String(message));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a missing id visibly rather than as a plausible label', () => {
    // Cast because the type system is the first guard and refuses this call.
    // The second guard exists for the ids the compiler cannot see: a catalogue
    // entry deleted while a call site survives, or a table assembled at
    // runtime.
    const rendered = translateWith('ru', 'edit.tiles.nothing' as MessageId);

    expect(rendered).toBe('⟦edit.tiles.nothing⟧');
    // Rendering the bare id would put `edit.tiles.nothing` where a heading
    // belongs and survive a review as something somebody chose.
    expect(rendered).not.toBe('edit.tiles.nothing');
  });

  it('names the id once, however many times it is rendered', () => {
    translateWith('ru', 'no.such.id' as MessageId);
    translateWith('en', 'no.such.id' as MessageId);
    translateWith('ru', 'no.such.id' as MessageId);

    // A list of two hundred rows drawing one missing label must not produce
    // two hundred console lines; the first one is the report.
    expect(reported.filter((line) => line.includes('no.such.id'))).toHaveLength(1);
  });
});
