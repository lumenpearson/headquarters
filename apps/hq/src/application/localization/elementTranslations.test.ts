import { describe, expect, it } from 'vitest';

import {
  elementTranslation,
  elementTranslationsFor,
  maxElementTranslationLength,
  readElementTranslations,
  withElementTranslation,
} from './elementTranslations';

const brief = { locale: 'ru', screen: 'overview', element: 'brief' } as const;

describe('per-element captions', () => {
  it('stores and reads one caption', () => {
    const entries = withElementTranslation([], brief, 'СВОДКА СМЕНЫ');

    expect(elementTranslation(entries, brief)).toBe('СВОДКА СМЕНЫ');
  });

  it('keeps a caption to the screen it was written on', () => {
    // `registry` is the table on four screens and `edit.selectedElementId`
    // holds the bare tile id, so a caption stored without the screen would
    // rename the objects registry, the cases registry, the files registry and
    // the reports registry at once. This is the assertion that says it does
    // not.
    const cases = { locale: 'ru', screen: 'cases', element: 'registry' } as const;
    const objects = { locale: 'ru', screen: 'objects', element: 'registry' } as const;
    const entries = withElementTranslation(
      withElementTranslation([], cases, 'ДОСЬЕ'),
      objects,
      'НАБЛЮДЕНИЕ',
    );

    expect(elementTranslation(entries, cases)).toBe('ДОСЬЕ');
    expect(elementTranslation(entries, objects)).toBe('НАБЛЮДЕНИЕ');
  });

  it('keeps a caption to the language it was written in', () => {
    const russian = { locale: 'ru', screen: 'overview', element: 'brief' } as const;
    const english = { locale: 'en', screen: 'overview', element: 'brief' } as const;
    const entries = withElementTranslation(
      withElementTranslation([], russian, 'СВОДКА СМЕНЫ'),
      english,
      'SHIFT BRIEF',
    );

    // Without the locale in the key, typing the English caption would have
    // overwritten the Russian one and the operator would have translated the
    // tile out of their own language.
    expect(elementTranslation(entries, russian)).toBe('СВОДКА СМЕНЫ');
    expect(elementTranslation(entries, english)).toBe('SHIFT BRIEF');
  });

  it('replaces rather than appends when the same element is written twice', () => {
    const once = withElementTranslation([], brief, 'ПЕРВОЕ');
    const twice = withElementTranslation(once, brief, 'ВТОРОЕ');

    expect(twice).toHaveLength(1);
    expect(elementTranslation(twice, brief)).toBe('ВТОРОЕ');
  });

  it('drops the entry when the caption is cleared', () => {
    const entries = withElementTranslation(withElementTranslation([], brief, 'СВОДКА'), brief, '');

    // An override equal to no override is a change the operator would then
    // have to find and undo.
    expect(entries).toEqual([]);
    expect(elementTranslation(entries, brief)).toBeUndefined();
  });

  it('survives a caption holding the separators the list is built from', () => {
    // A `string-list` is split on `,`, the entry on `=` and the key on `:`.
    // A caption carrying all three is exactly what percent-encoding is for.
    const awkward = 'СВОДКА: смена 1, смена 2 = обе';
    const entries = withElementTranslation([], brief, awkward);

    expect(entries[0]).not.toContain(',');
    expect(elementTranslation(entries, brief)).toBe(awkward);
  });

  it('trims and caps what it stores', () => {
    const entries = withElementTranslation([], brief, `  ${'Я'.repeat(400)}  `);

    expect(elementTranslation(entries, brief)).toHaveLength(maxElementTranslationLength);
  });

  it('skips an entry it cannot read rather than losing the rest', () => {
    // The list is editable by hand in the settings catalogue. A lone `%` is a
    // `URIError` from `decodeURIComponent`, and one bad line should cost that
    // line.
    const entries = [
      'ru:overview:brief=%D0%A1%D0%92%D0%9E%D0%94%D0%9A%D0%90',
      'ru:overview:broken=%',
      'ru:overview',
      'xx:overview:brief=abc',
      'ru:Overview:brief=abc',
    ];

    expect([...readElementTranslations(entries).keys()]).toEqual(['ru:overview:brief']);
  });
});

describe('the captions a proposal carries', () => {
  it('returns only the locale asked for, with the address of each', () => {
    const entries = withElementTranslation(
      withElementTranslation([], { locale: 'en', screen: 'overview', element: 'brief' }, 'BRIEF'),
      { locale: 'ru', screen: 'overview', element: 'brief' },
      'СВОДКА',
    );

    expect(elementTranslationsFor(entries, 'en')).toEqual([
      { locale: 'en', screen: 'overview', element: 'brief', text: 'BRIEF' },
    ]);
  });

  it('returns nothing for a locale nobody has written for', () => {
    expect(elementTranslationsFor(withElementTranslation([], brief, 'СВОДКА'), 'en')).toEqual([]);
  });
});
