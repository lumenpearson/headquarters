import type { CatalogModule } from './catalogTypes';

/**
 * Messages whose text depends on a count.
 *
 * Kept in one module rather than filed under the surface that draws them,
 * because what they have in common is the mechanism: each is a
 * `PluralForms` value that `translateWith` selects from with
 * `Intl.PluralRules`, and a reader checking that the mechanism is exercised
 * should find every user of it in one place.
 *
 * Both entries replace a Russian noun frozen in the genitive plural. The
 * screens concatenated a number with `СОВПАДЕНИЙ` and `ИЗМЕНЕНИЙ`, which is
 * right for five and wrong for one and for two: Russian selects between four
 * categories where English selects between two, so a single hard-coded form
 * is wrong for most counts rather than for an unusual few.
 */
export const pluralMessages = {
  'search.matchCount': {
    ru: {
      one: '{count} СОВПАДЕНИЕ',
      few: '{count} СОВПАДЕНИЯ',
      many: '{count} СОВПАДЕНИЙ',
      other: '{count} СОВПАДЕНИЯ',
    },
    en: { one: '{count} MATCH', other: '{count} MATCHES' },
  },
  'settings.draftChangeCount': {
    ru: {
      one: '{count} ИЗМЕНЕНИЕ',
      few: '{count} ИЗМЕНЕНИЯ',
      many: '{count} ИЗМЕНЕНИЙ',
      other: '{count} ИЗМЕНЕНИЯ',
    },
    en: { one: '{count} CHANGE', other: '{count} CHANGES' },
  },
} as const satisfies CatalogModule;
