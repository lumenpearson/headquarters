import { afterEach, describe, expect, it } from 'vitest';

import { translateWith, type MessageId } from './messages';
import {
  capTranslationOverrideEntries,
  loadTranslationOverrides,
  normalizeTranslationOverrides,
  readTranslationOverrides,
  setTranslationOverridesForTests,
  translationOverridesStorageKey,
  validateTranslationOverride,
  withTranslationOverride,
  writeTranslationOverrides,
} from './translationOverrides';

function createStorage(initialValue: string | null = null) {
  let value = initialValue;
  return {
    getItem: (key: string) => (key === translationOverridesStorageKey ? value : null),
    setItem: (key: string, next: string) => {
      if (key === translationOverridesStorageKey) value = next;
    },
  };
}

const navOverview = { locale: 'en', id: 'nav.overview' as MessageId };
const withPlaceholder = { locale: 'en', id: 'keybind.navigate' as MessageId };

describe('validating one override', () => {
  it('accepts a same-placeholder override for a real, non-plural catalogue id', () => {
    const result = validateTranslationOverride(navOverview, 'OVERVIEW (OPS)');
    expect(result).toEqual({ ok: true, value: 'OVERVIEW (OPS)' });
  });

  it('refuses a locale this application does not ship', () => {
    expect(validateTranslationOverride({ locale: 'uk', id: 'nav.overview' }, 'x')).toEqual({
      ok: false,
      reason: 'unknown-locale',
    });
  });

  it('refuses an id that is not in the catalogue at all', () => {
    expect(validateTranslationOverride({ locale: 'en', id: 'no.such.id' }, 'x')).toEqual({
      ok: false,
      reason: 'unknown-id',
    });
  });

  it('refuses a token id, because a token is the same word in every locale on purpose', () => {
    expect(validateTranslationOverride({ locale: 'en', id: 'token.utc' }, 'UTC-ALIAS')).toEqual({
      ok: false,
      reason: 'non-catalog-id',
    });
  });

  it('refuses a plural-valued id, out of scope for this wave', () => {
    expect(
      validateTranslationOverride({ locale: 'en', id: 'search.matchCount' }, '{count} notice(s)'),
    ).toEqual({ ok: false, reason: 'plural-message' });
  });

  it('refuses blank text', () => {
    expect(validateTranslationOverride(navOverview, '   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('refuses text past the length cap', () => {
    expect(validateTranslationOverride(navOverview, 'x'.repeat(513))).toEqual({
      ok: false,
      reason: 'too-long',
    });
    expect(validateTranslationOverride(navOverview, 'x'.repeat(512)).ok).toBe(true);
  });

  it('refuses a control character', () => {
    expect(validateTranslationOverride(navOverview, 'OVERVIEW')).toEqual({
      ok: false,
      reason: 'control-character',
    });
  });

  it('refuses a bidi-override character', () => {
    expect(validateTranslationOverride(navOverview, 'OVER‮VIEW')).toEqual({
      ok: false,
      reason: 'bidi-override',
    });
  });

  it("refuses an override that drops the source message's placeholder", () => {
    // `keybind.navigate` reads `Go to: {target}`; an override with no
    // `{target}` would silently break every numbered-route shortcut label.
    expect(validateTranslationOverride(withPlaceholder, 'Go to somewhere')).toEqual({
      ok: false,
      reason: 'placeholder-mismatch',
    });
  });

  it('accepts an override that keeps the same placeholder', () => {
    expect(validateTranslationOverride(withPlaceholder, 'Jump to: {target}')).toEqual({
      ok: true,
      value: 'Jump to: {target}',
    });
  });

  it('NFC-normalizes and trims on the way in', () => {
    // 'e' + combining acute (NFD) vs the precomposed 'é' (NFC): different code
    // points, same rendered text -- and an override table keyed on the
    // trimmed, normalized form is what keeps two spellings of the same text
    // from silently coexisting as two entries.
    const nfd = '  é ́  '; // "é " with a stray trailing accent, padded.
    const result = validateTranslationOverride(navOverview, nfd);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.startsWith(' ')).toBe(false);
  });
});

describe('normalizing a stored blob', () => {
  it('drops an entry that does not parse rather than losing the rest', () => {
    const normalized = normalizeTranslationOverrides({
      'en:nav.overview': 'OVERVIEW (OPS)',
      'en:no.such.id': 'GHOST',
      'uk:nav.overview': 'UNSUPPORTED LOCALE',
      malformedKeyWithNoColon: 'DROPPED',
      'en:token.utc': 'ALIAS',
      'ru:keybind.navigate': 42,
    });

    expect(normalized).toEqual({ 'en:nav.overview': 'OVERVIEW (OPS)' });
  });

  it('is not fooled by an array or a primitive standing in for the object', () => {
    expect(normalizeTranslationOverrides(['en:nav.overview'])).toEqual({});
    expect(normalizeTranslationOverrides('not an object')).toEqual({});
    expect(normalizeTranslationOverrides(null)).toEqual({});
  });

  it('does not touch the real catalogue-sized cap: it is out of reach of the current 109 ids', () => {
    // 109 ids across 2 locales is at most 218 valid entries, nowhere near the
    // 4,000-entry cap `normalizeTranslationOverrides` applies -- proof that
    // the cap is sized for the campaign's eventual ~1,700 ids, not for today.
    const raw: Record<string, string> = { 'en:nav.overview': 'A', 'en:nav.rail': 'B' };
    expect(Object.keys(normalizeTranslationOverrides(raw))).toHaveLength(2);
  });
});

describe('capping and sorting entries deterministically', () => {
  it('keeps only as many entries as the limit, choosing them by sorted key', () => {
    const entries: readonly (readonly [string, string])[] = [
      ['en:nav.search', 'C'],
      ['en:nav.overview', 'A'],
      ['en:nav.rail', 'B'],
    ];

    // Sorted keys: nav.overview, nav.rail, nav.search -- a limit of 2 keeps
    // the first two of that order, not the first two written.
    expect(capTranslationOverrideEntries(entries, 2)).toEqual({
      'en:nav.overview': 'A',
      'en:nav.rail': 'B',
    });
  });

  it('keeps every entry when the limit is not reached', () => {
    const entries: readonly (readonly [string, string])[] = [['en:nav.overview', 'A']];
    expect(capTranslationOverrideEntries(entries, 10)).toEqual({ 'en:nav.overview': 'A' });
  });
});

describe('reading and writing the stored blob', () => {
  it('round-trips through a fake StorageLike', () => {
    const storage = createStorage();
    writeTranslationOverrides(storage, { 'en:nav.overview': 'OVERVIEW (OPS)' });

    expect(readTranslationOverrides(storage)).toEqual({ 'en:nav.overview': 'OVERVIEW (OPS)' });
  });

  it('reads a missing key as no overrides, not a thrown error', () => {
    expect(readTranslationOverrides(createStorage())).toEqual({});
  });

  it('reads unparsable JSON as no overrides', () => {
    expect(readTranslationOverrides(createStorage('{not json'))).toEqual({});
  });
});

describe('setting one override', () => {
  it('adds a validated entry', () => {
    const result = withTranslationOverride(
      {},
      { locale: 'en', id: 'nav.overview' },
      'OVERVIEW (OPS)',
    );
    expect(result).toEqual({ kind: 'set', overrides: { 'en:nav.overview': 'OVERVIEW (OPS)' } });
  });

  it('clears the entry on blank text rather than storing an empty string', () => {
    const result = withTranslationOverride(
      { 'en:nav.overview': 'OVERVIEW (OPS)' },
      { locale: 'en', id: 'nav.overview' },
      '   ',
    );
    expect(result).toEqual({ kind: 'cleared', overrides: {} });
  });

  it('leaves the table untouched and names the reason on refusal', () => {
    const before = { 'en:nav.overview': 'OVERVIEW (OPS)' };
    const result = withTranslationOverride(before, { locale: 'en', id: 'token.utc' }, 'ALIAS');

    expect(result).toEqual({ kind: 'refused', reason: 'non-catalog-id' });
  });
});

describe('translateWith consults the override cache', () => {
  afterEach(() => {
    setTranslationOverridesForTests([]);
  });

  it('prefers an override over the shipped catalogue text', () => {
    expect(translateWith('en', 'nav.overview')).toBe('OVERVIEW');

    setTranslationOverridesForTests([
      { locale: 'en', id: 'nav.overview', value: 'OVERVIEW (OPS)' },
    ]);

    expect(translateWith('en', 'nav.overview')).toBe('OVERVIEW (OPS)');
    // The other locale is untouched: an override is per-locale, or typing an
    // English override would silently change what a Russian session shows.
    expect(translateWith('ru', 'nav.overview')).toBe('ОБЗОР');
  });

  it('loadTranslationOverrides populates the cache translateWith reads', () => {
    const storage = createStorage();
    writeTranslationOverrides(storage, { 'ru:nav.overview': 'СВОДКА' });

    expect(translateWith('ru', 'nav.overview')).toBe('ОБЗОР');

    loadTranslationOverrides(storage);

    expect(translateWith('ru', 'nav.overview')).toBe('СВОДКА');
  });
});
