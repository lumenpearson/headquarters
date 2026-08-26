'use client';

import { readStringSetting, useStringSetting } from '@/application/personalization/useSetting';

import {
  appLocales,
  sourceLocale,
  translateWith,
  type AppLocale,
  type MessageId,
  type MessageParams,
} from './messages';

/**
 * `localization.locale`, read the way every other personalization setting is.
 *
 * The definition has existed since the settings catalogue was written and had
 * no reader at all: switching `ru`/`en` moved a value in the draft and changed
 * nothing on screen. This module is that reader, and it deliberately goes
 * through `personalization/useSetting` rather than holding a locale of its
 * own -- a second source of truth for the current language is how a panel and
 * the shell around it come to disagree about which one is in force.
 *
 * The consequence worth stating: `t` is a plain function that reads the store
 * at call time, so it is correct from an event handler, from a module-level
 * label helper and from a component alike. What it cannot do is subscribe. A
 * component that draws translated text calls {@link useAppLocale} once -- that
 * is the subscription, and it is why a locale change re-renders rather than
 * leaving the previous language on screen until something else moves.
 */

/**
 * Narrows a stored value to a locale.
 *
 * Not a second copy of the default: the readers in `personalization/useSetting`
 * have already resolved the definition's own default and rejected anything it
 * would not accept. The branch exists for the compiler, and `locale.test.ts`
 * asserts it lands on the definition's default so the literal cannot drift
 * from the schema.
 */
export function resolveAppLocale(value: string): AppLocale {
  return appLocales.find((locale) => locale === value) ?? sourceLocale;
}

export function readAppLocale(): AppLocale {
  return resolveAppLocale(readStringSetting('localization.locale'));
}

export function useAppLocale(): AppLocale {
  return resolveAppLocale(useStringSetting('localization.locale'));
}

/**
 * The BCP 47 tag `Intl` is given for an application locale.
 *
 * Separate from the locale itself because they answer different questions.
 * `ru` names a catalogue; `ru-RU` names collation, casing and date order, and
 * the two are not interchangeable -- `Intl.Collator('ru')` and
 * `Intl.Collator('ru-RU')` happen to agree today and nothing promises they
 * will. `en-GB` rather than `en-US` because this application prints
 * day-month-year everywhere and an American order in one locale would be a
 * different reading of the same shoot sheet.
 */
const intlTags: Readonly<Record<AppLocale, string>> = {
  ru: 'ru-RU',
  en: 'en-GB',
};

export function intlTag(locale: AppLocale = readAppLocale()): string {
  return intlTags[locale];
}

/** One message, in the locale now in force. */
export function t(id: MessageId, params?: MessageParams): string {
  return translateWith(readAppLocale(), id, params);
}

/**
 * The same reader, bound to a subscription.
 *
 * A component that takes this re-renders when the locale changes, which is the
 * whole difference between it and {@link t}. Returned as a function rather
 * than as a locale so a call site reads the same in both forms.
 */
export function useTranslate(): (id: MessageId, params?: MessageParams) => string {
  const locale = useAppLocale();
  return (id, params) => translateWith(locale, id, params);
}

/** One message, subscribed. The single-string form of {@link useTranslate}. */
export function useMessage(id: MessageId, params?: MessageParams): string {
  return translateWith(useAppLocale(), id, params);
}
