'use client';

import { intlTag } from './locale';

/**
 * Every locale-dependent comparison and every locale-dependent format, in one
 * place, built from the locale the operator selected rather than from a
 * literal at the call site.
 *
 * There were forty-two `'ru-RU'` literals across fifteen files and they were
 * two different things wearing one spelling. About two dozen were collation
 * and casing -- `localeCompare`, `toLocaleLowerCase`, `Intl.Collator` -- inside
 * search and sort predicates, where the tag decides whether `ё` sorts with `е`
 * and whether a query in capitals finds a row in lower case. The rest were
 * display: `Intl.DateTimeFormat` and `toLocale*String`, where the tag decides
 * what the operator reads. Only the second kind belongs to a date formatter,
 * which is why this module offers both shapes instead of one.
 *
 * ## Why the instances are cached
 *
 * `dateTime.ts` hoisted four `Intl.DateTimeFormat` instances to module scope
 * because the shell clock formats once a second for the life of the session
 * and constructing a formatter inside that tick is real work. Hoisting also
 * made them permanent: they were built at import from `'ru-RU'` and no change
 * of locale could ever reach them. The cache below keeps the saving and drops
 * the permanence -- the key carries the locale tag, so a locale change simply
 * misses and builds the instance the new locale needs, once.
 */

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const collators = new Map<string, Intl.Collator>();
const pluralRules = new Map<string, Intl.PluralRules>();

function cacheKey(tag: string, options: object | undefined): string {
  // `Intl` options are flat records of primitives, so their own serialisation
  // is a sufficient identity. Sorted, because `{hour, minute}` and
  // `{minute, hour}` ask for the same formatter.
  if (options === undefined) return tag;
  const entries = Object.entries(options).sort(([left], [right]) => (left < right ? -1 : 1));
  return `${tag}|${JSON.stringify(entries)}`;
}

/** A date/time formatter for the current locale, built once per shape. */
export function dateTimeFormat(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const tag = intlTag();
  const key = cacheKey(tag, options);
  const existing = dateTimeFormats.get(key);
  if (existing !== undefined) return existing;
  const format = new Intl.DateTimeFormat(tag, options);
  dateTimeFormats.set(key, format);
  return format;
}

/**
 * A collator for the current locale.
 *
 * `numeric` on by default, because every list this application sorts is a list
 * of operational identifiers -- `K-2`, `K-10`, `K-17` -- and the alternative
 * puts the tenth camera between the first and the second.
 */
export function collator(options: Intl.CollatorOptions = { numeric: true }): Intl.Collator {
  const tag = intlTag();
  const key = cacheKey(tag, options);
  const existing = collators.get(key);
  if (existing !== undefined) return existing;
  const instance = new Intl.Collator(tag, options);
  collators.set(key, instance);
  return instance;
}

/**
 * The comparator a sort predicate takes.
 *
 * Replaces `left.localeCompare(right, 'ru-RU')` at a call site: the same
 * ordering, decided by the setting, and one cached instance rather than the
 * implicit collator `localeCompare` builds on every comparison.
 */
export function compareText(left: string, right: string): number {
  return collator().compare(left, right);
}

/**
 * The form a search predicate compares in.
 *
 * `toLocaleLowerCase` and not `toLowerCase`: Turkish dotless `ı` is the
 * standing example, but the reason this application needs it is nearer -- a
 * locale-blind fold is a second answer to "does this query match this row",
 * and the sort beside it already has a locale-aware one.
 */
export function foldCase(text: string): string {
  return text.toLocaleLowerCase(intlTag());
}

/**
 * The plural category `Intl.PluralRules` resolves `count` to, for the current
 * locale by default -- the same "default to the operator's locale, cache by
 * tag" shape as {@link dateTimeFormat} and {@link collator}.
 *
 * `messages.ts`'s `translateWith` needs the same selection for a locale it is
 * given as an argument, which may not be the one this module's `intlTag()`
 * default would read from the store; it keeps a cache of its own next to this
 * one instead of calling through here, because importing this module would
 * pull in `./locale`, which imports `./messages` back, and `translateWith` has
 * to stay a leaf `locale.ts` can build on without a cycle. The two caches
 * never disagree; this one exists for a caller that already depends on this
 * module and wants the operator's own locale, the way every other function
 * here does.
 */
export function pluralCategory(count: number, tag: string = intlTag()): Intl.LDMLPluralRule {
  const existing = pluralRules.get(tag);
  const rules = existing ?? new Intl.PluralRules(tag);
  if (existing === undefined) pluralRules.set(tag, rules);
  return rules.select(count);
}

/** Test seam. The caches key on the locale tag, so they are never stale in use. */
export function forgetIntlCaches(): void {
  dateTimeFormats.clear();
  collators.clear();
  pluralRules.clear();
}
