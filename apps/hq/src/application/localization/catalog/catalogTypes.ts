/**
 * The shape every catalogue module under `catalog/` is written against.
 *
 * `appLocales` and `AppLocale` live here rather than in `messages.ts`: a
 * catalogue module needs the locale union to type its own entries, and
 * `messages.ts` needs the catalogue modules to build its tables, so the union
 * has to sit below both or the two would import each other. `messages.ts`
 * re-exports both names, which is the only place any other file in this
 * application is meant to import them from -- this module is catalogue-internal
 * plumbing, not a second front door.
 */

export const appLocales = ['ru', 'en'] as const;

export type AppLocale = (typeof appLocales)[number];

/**
 * The plural forms one message needs, keyed by the CLDR category
 * `Intl.PluralRules` resolves a count to.
 *
 * `other` is required because every locale this application ships resolves to
 * it for some count; the rest are whichever categories the locale in question
 * distinguishes -- English selects between `one` and `other`, Russian between
 * `one`, `few`, `many` and `other`. A form a locale never selects is simply
 * never written for it, the same way a `Partial` leaves an unused key out
 * rather than empty.
 */
export type PluralForms = Readonly<Partial<Record<Intl.LDMLPluralRule, string>>> & {
  readonly other: string;
};

/** One catalogue id's text in one locale: a fixed string, or a count-selected one. */
export type MessageValue = string | PluralForms;

/**
 * One catalogue id's text in every locale the application ships.
 *
 * Keyed by `AppLocale` rather than `Partial<Record<AppLocale, MessageValue>>`
 * on purpose: a locale missing from an entry is a property the object cannot
 * satisfy, caught where the entry is written, not a hole a lookup falls
 * through at runtime. Widen {@link appLocales} to a third locale and every
 * entry in every module under `catalog/` stops compiling until that locale's
 * line is filled in -- the mandate that every string has a translation in
 * every available language, enforced once here instead of carried as a
 * convention several hundred entries, written by several different people,
 * would each have to keep remembering on their own.
 */
export type CatalogEntry = Readonly<Record<AppLocale, MessageValue>>;

/**
 * One namespace's worth of the catalogue -- what a module under `catalog/`
 * exports, and the only shape `catalog/index.ts` will merge.
 */
export type CatalogModule = Readonly<Record<string, CatalogEntry>>;
