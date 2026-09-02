import { describe, expect, it } from 'vitest';

import {
  countMissingLocalizedText,
  isLocalizedTextMissing,
  resolveLocalizedText,
  type LocalizedText,
} from './localizedText.js';

describe('resolveLocalizedText', () => {
  it('returns the requested locale when it is present', () => {
    const value: LocalizedText = { ru: 'Обухов / печать', en: 'Obukhov / print' };
    expect(resolveLocalizedText(value, 'en', 'ru')).toEqual({
      text: 'Obukhov / print',
      usedFallback: false,
    });
  });

  it('falls back to the fallback locale when the requested one is absent', () => {
    const value: LocalizedText = { ru: 'Обухов / печать' };
    expect(resolveLocalizedText(value, 'en', 'ru')).toEqual({
      text: 'Обухов / печать',
      usedFallback: true,
    });
  });

  it('returns an empty, fallen-back result when neither locale is present', () => {
    const value: LocalizedText = { fr: 'Obukhov / impression' };
    expect(resolveLocalizedText(value, 'en', 'ru')).toEqual({ text: '', usedFallback: true });
  });

  it('treats a bare string as fallback-locale content not yet split into a record', () => {
    const value: LocalizedText = 'Обухов / печать';
    expect(resolveLocalizedText(value, 'ru', 'ru')).toEqual({
      text: 'Обухов / печать',
      usedFallback: false,
    });
    expect(resolveLocalizedText(value, 'en', 'ru')).toEqual({
      text: 'Обухов / печать',
      usedFallback: true,
    });
  });
});

describe('isLocalizedTextMissing / countMissingLocalizedText', () => {
  it('does not count a bare string as missing its own source locale', () => {
    expect(isLocalizedTextMissing('Обухов / печать', 'ru', 'ru')).toBe(false);
  });

  it('counts a bare string as missing any locale other than the source', () => {
    expect(isLocalizedTextMissing('Обухов / печать', 'en', 'ru')).toBe(true);
  });

  it('counts a record missing an explicit key for the requested locale', () => {
    expect(isLocalizedTextMissing({ ru: 'Обухов' }, 'en', 'ru')).toBe(true);
    expect(isLocalizedTextMissing({ ru: 'Обухов', en: 'Obukhov' }, 'en', 'ru')).toBe(false);
  });

  it('sums the gap across a known-shaped list of values', () => {
    const values: readonly LocalizedText[] = [
      'Обухов / печать', // bare string: missing en
      { ru: 'Захват автозака', en: 'The prison van seizure' }, // translated: not missing
      { ru: 'Иксанов' }, // explicit record, no en key: missing en
    ];
    expect(countMissingLocalizedText(values, 'en', 'ru')).toBe(2);
    expect(countMissingLocalizedText(values, 'ru', 'ru')).toBe(0);
  });
});
