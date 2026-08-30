/**
 * The message catalogue: every label the application draws for itself, keyed
 * by a stable id, in Russian and in English.
 *
 * No i18n library. The three that would fit -- i18next, FormatJS, Lingui --
 * all bring a loader, a plural/ICU compiler and a runtime message store, and
 * this application has no server, no lazy chunk boundary worth splitting a
 * catalogue across, and two locales that ship in the same static export
 * (ADR 0005). What is left of such a library once the loader is unused is a
 * table lookup, a plural selection and a placeholder substitution, which is
 * the file you are reading. Adding one would also put a second validation
 * surface beside `packages/settings-schema`, which is already the trust
 * boundary for everything the operator can change.
 *
 * The entries themselves live in `catalog/`, split by surface so several
 * people can add to the catalogue in the same afternoon without touching each
 * other's file; `catalog/index.ts` documents the split and merges the modules
 * into {@link CatalogId}. This file is the resolution policy over that
 * catalogue -- tokens, fallback, plural forms and the operator's own
 * overrides -- and the stable names everything else in the application
 * imports.
 *
 * ## The id convention
 *
 * `<area>.<name>`, lowercase, dot-separated -- the same spelling a setting id
 * uses, because an operator reading a diff should not have to learn two.
 * `<area>` is the surface that draws the string (`nav`, `menu`, `keybind`,
 * `settingsCategory`, `tileCategory`, `edit`, `clock`), never the module that
 * happens to hold it: a label moving between files must not change its id, or
 * a translation is lost by a refactor.
 *
 * Where a table is keyed by a union -- a tile category, a settings group -- the
 * consumer declares a `Record<Union, MessageId>` rather than building the id
 * with a template string. The compiler then catches a union member with no
 * message, which a built id never can.
 *
 * ## Register
 *
 * Two registers are in play and only one of them is translated. Russian is the
 * human register: what an operator reads, and what the catalogue is authored
 * in first. Latin uppercase status tokens name protocols and machine state --
 * `UTC`, `RPC:GRPC-WEB`, `UTF-8`, `PTZ` -- and are the same word in every
 * locale. Those live in {@link tokens}, a namespace `translateWith` resolves
 * before it looks at any locale, so the decision is encoded once instead of
 * being taken again for each string.
 */

import {
  appLocales,
  catalog,
  type AppLocale,
  type CatalogId,
  type MessageValue,
  type PluralForms,
} from './catalog';

export { appLocales, type AppLocale, type MessageValue, type PluralForms };

/**
 * The locale whose text is written first and reviewed as the original.
 *
 * Not where a hole falls back to -- {@link fallbackLocale} is. The two answer
 * different questions: this is where a translation starts before either
 * language is written, the other is what an operator sees if a translation
 * never got written. They happened to be the same locale before the fallback
 * direction below was decided.
 */
export const sourceLocale: AppLocale = 'ru';

/**
 * The locale a hole falls back to before {@link sourceLocale} does.
 *
 * English, not Russian. `CatalogEntry` (`catalog/catalogTypes.ts`) already
 * makes a hole in `ru` or `en` a compile error for a real id, so this chain's
 * daily work is for what the type system cannot see: a third locale
 * contributed one id at a time, an id built or cast at runtime rather than
 * named as a literal, an operator override a corrupt blob dropped. In every
 * one of those cases more readers of this codebase read English than read the
 * Russian the catalogue happens to be authored in first, so English is the
 * better placeholder while a translation is missing -- falling back to
 * Russian let "every text translated into every available language" be met by
 * leaving `ru` untouched instead of by writing the `en` line, which is the gap
 * this mandate closes.
 */
export const fallbackLocale: AppLocale = 'en';

export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * Strings that are the same in every locale.
 *
 * Not an oversight list and not "not translated yet": these name a protocol, a
 * unit or a machine state, and translating `UTC` into Russian would produce a
 * word no operator is looking for. The screens' bare `BUS:BROADCAST`,
 * `RPC:GRPC-WEB`, `UTF-8` and `PTZ` readouts call through here instead of
 * repeating the literal at each site, so the decision that they stay Latin is
 * encoded once rather than taken again for each string.
 *
 * Kept out of `catalog/` on purpose: a token has one spelling, not one per
 * locale, so it does not fit `CatalogEntry`'s per-locale shape and should
 * not -- an operator override for a token would defeat the reason it is a
 * token, and `translationOverrides.ts` refuses one explicitly with the reason
 * `'non-catalog-id'`.
 */
export const tokens = {
  'token.utc': 'UTC',
  'token.ptz': 'PTZ',
  'token.utf8': 'UTF-8',
  'token.rpcGrpcWeb': 'RPC:GRPC-WEB',
  'token.busBroadcast': 'BROADCAST',
  'token.busFallback': 'FALLBACK',
} as const satisfies Readonly<Record<`token.${string}`, string>>;

export type TokenId = keyof typeof tokens;

export type MessageId = CatalogId | TokenId;

/**
 * Every catalogue id's value, in one locale, plural forms left unresolved.
 *
 * Built once from {@link catalog} rather than read from it at call time so a
 * lookup stays O(1) the way the pre-split flat table was; `resolveFromTables`
 * is the only reader, and it takes a table of this shape as an argument
 * instead of closing over this one, so a test can hand it a table with a hole
 * without touching the immutable catalogue that cannot have one.
 */
function tableFor(locale: AppLocale): Readonly<Partial<Record<MessageId, MessageValue>>> {
  const table: Partial<Record<MessageId, MessageValue>> = {};
  for (const id of Object.keys(catalog) as CatalogId[]) {
    table[id] = catalog[id][locale];
  }
  return table;
}

const tables: Readonly<Record<AppLocale, Readonly<Partial<Record<MessageId, MessageValue>>>>> =
  Object.fromEntries(appLocales.map((locale) => [locale, tableFor(locale)])) as Readonly<
    Record<AppLocale, Readonly<Partial<Record<MessageId, MessageValue>>>>
  >;

/**
 * The tables-only tier of resolution: the requested locale, then
 * {@link fallbackLocale}, then {@link sourceLocale}.
 *
 * Exported, and taking `tables` as an argument rather than reading the
 * module's own copy, so a test can prove the fallback order directly: a hole
 * in `ru` or `en` cannot be constructed in the real catalogue (`CatalogEntry`
 * requires every locale), but a small object literal shaped like this
 * parameter can stand in for one without weakening that guarantee anywhere
 * real code reads from.
 */
export function resolveFromTables(
  localeTables: Readonly<Record<AppLocale, Readonly<Partial<Record<MessageId, MessageValue>>>>>,
  locale: AppLocale,
  id: MessageId,
): MessageValue | undefined {
  return (
    localeTables[locale][id] ?? localeTables[fallbackLocale][id] ?? localeTables[sourceLocale][id]
  );
}

function collapseToString(
  table: Readonly<Partial<Record<MessageId, MessageValue>>>,
): Readonly<Partial<Record<MessageId, string>>> {
  const collapsed: Partial<Record<MessageId, string>> = {};
  for (const [id, value] of Object.entries(table) as [MessageId, MessageValue | undefined][]) {
    if (value !== undefined) collapsed[id] = typeof value === 'string' ? value : value.other;
  }
  return collapsed;
}

const stringTables: Readonly<Record<AppLocale, Readonly<Partial<Record<MessageId, string>>>>> =
  Object.fromEntries(
    appLocales.map((locale) => [locale, collapseToString(tables[locale])]),
  ) as Readonly<Record<AppLocale, Readonly<Partial<Record<MessageId, string>>>>>;

/** Every id the catalogue declares, tokens included. Used by the tests. */
export const messageIds: readonly MessageId[] = [
  ...(Object.keys(catalog) as CatalogId[]),
  ...(Object.keys(tokens) as TokenId[]),
];

/**
 * One id's text in one locale, plural forms collapsed to {@link PluralForms}'s
 * `other`.
 *
 * The public, pre-split signature: every existing caller reads a plain
 * string, because nothing this catalogue has carried so far needs a count --
 * a chrome label, a setting description, an enum option are never plural.
 * `translateWith` does not read this; it reads {@link resolveFromTables}
 * directly so a message that does need a count still gets one.
 */
export function messagesFor(locale: AppLocale): Readonly<Partial<Record<MessageId, string>>> {
  return stringTables[locale];
}

/**
 * One id's raw value in {@link sourceLocale}, plural forms left unresolved.
 *
 * `translationOverrides.ts`'s validator reads this to compare an override's
 * placeholders against the source message's, and to refuse an override for an
 * id whose source is a {@link PluralForms} (reason `'plural-message'`) or no
 * catalogue id at all (reason `'non-catalog-id'`, which is also what a token
 * id resolves to here, since a token has no `catalog` entry).
 */
export function sourceMessageValue(id: MessageId): MessageValue | undefined {
  return tables[sourceLocale][id];
}

const placeholderPattern = /\{([a-zA-Z][a-zA-Z0-9]*)\}/gu;

/**
 * The `{name}` placeholders a message value asks for, across every plural
 * form it has.
 *
 * Shared by `translateWith`'s own substitution logic's counterpart --
 * placeholder-parity across locales -- and by `translationOverrides.ts`'s
 * validator, so the build's own guard and the operator-facing refusal reason
 * come from the same reading of "what placeholders does this text want",
 * rather than two regexes that could drift apart.
 */
export function placeholdersOf(value: MessageValue): ReadonlySet<string> {
  const forms = typeof value === 'string' ? [value] : Object.values(value);
  const found = new Set<string>();
  for (const form of forms) {
    for (const match of form.matchAll(placeholderPattern)) {
      const name = match[1];
      if (name !== undefined) found.add(name);
    }
  }
  return found;
}

/** Whether two message values ask for exactly the same set of placeholders. */
export function placeholdersMatch(left: MessageValue, right: MessageValue): boolean {
  const leftNames = placeholdersOf(left);
  const rightNames = placeholdersOf(right);
  if (leftNames.size !== rightNames.size) return false;
  for (const name of leftNames) {
    if (!rightNames.has(name)) return false;
  }
  return true;
}

const overrideCache = new Map<string, string>();

/** The cache key `setOverrideCache` and `translateWith` must agree on. */
export function overrideCacheKey(locale: AppLocale, id: MessageId): string {
  return `${locale}:${id}`;
}

/**
 * The seam `translationOverrides.ts` calls after validating a stored blob (or
 * a test's own fixture) into a `${locale}:${id}` -> text map.
 *
 * Lives here rather than in `translationOverrides.ts`: `translateWith` needs
 * synchronous, import-free access to whatever the operator has overridden,
 * and `translationOverrides.ts` already imports `messageIds`,
 * `sourceMessageValue` and `placeholdersMatch` from this file to validate an
 * entry -- this file importing that one back for the cache would close the
 * two into a cycle, and `translateWith` has to stay a leaf `locale.ts` and
 * `intl.ts` build on rather than a node inside its own dependency graph.
 * Refreshed by the editor or by a test calling `loadTranslationOverrides` /
 * `setTranslationOverridesForTests`; `translateWith` only ever reads what is
 * already here, never touches storage, and stays pure in the locale it is
 * given.
 */
export function setOverrideCache(entries: ReadonlyMap<string, string>): void {
  overrideCache.clear();
  for (const [key, value] of entries) overrideCache.set(key, value);
}

const reportedMissing = new Set<string>();

/**
 * What a missing id renders as.
 *
 * Visible rather than plausible: rendering the id itself produces
 * `edit.tiles.heading` in the middle of a panel, which reads as a label
 * somebody chose and survives a review. The brackets do not, and the console
 * line names it once so a screen full of them is still one line per id.
 *
 * Production keeps the bare id: an operator on a shoot is better served by an
 * odd-looking label than by a decoration that suggests the build is broken.
 */
function missingMessage(id: string): string {
  if (process.env.NODE_ENV === 'production') return id;
  if (!reportedMissing.has(id)) {
    reportedMissing.add(id);
    console.error(`[localization] no message for id "${id}"`);
  }
  return `⟦${id}⟧`;
}

/**
 * `PluralForms` reached with no `count` parameter.
 *
 * Always `other`, never bracketed: a missing count is a caller bug, and
 * `missingMessage`'s bracket marker exists to make an author notice a hole in
 * the catalogue, not to make an operator watch a shoot-day screen go blank
 * because one call site forgot a parameter. Logged through the same
 * once-per-id guard `missingMessage` uses, under a `plural-count:` prefix so
 * it cannot suppress -- or be suppressed by -- a genuine missing-id report for
 * the same id.
 */
function reportMissingCount(id: string): void {
  if (process.env.NODE_ENV === 'production') return;
  const key = `plural-count:${id}`;
  if (reportedMissing.has(key)) return;
  reportedMissing.add(key);
  console.error(`[localization] "${id}" has plural forms but received no "count" parameter`);
}

/** Test seam: the guard reports each id once per process, which a suite reuses. */
export function forgetMissingMessageReports(): void {
  reportedMissing.clear();
}

const pluralRulesByLocale = new Map<AppLocale, Intl.PluralRules>();

/**
 * `Intl.PluralRules` for one of this application's own locales, cached the
 * same way `intl.ts` caches its formatters -- but kept here rather than
 * imported from there. `intl.ts` imports `intlTag` from `./locale`, which
 * imports `sourceLocale` and `translateWith` from this file; if this file
 * imported `intl.ts` back for the one function it needs, the three files
 * would form a cycle, and this file has to stay the leaf the other two build
 * on. The two caches never disagree: an `AppLocale` (`ru`/`en`) is already a
 * valid `Intl.PluralRules` locale argument on its own, no BCP 47 region tag
 * required, and there are only ever as many entries as there are locales.
 */
function pluralCategoryFor(locale: AppLocale, count: number): Intl.LDMLPluralRule {
  const existing = pluralRulesByLocale.get(locale);
  const rules = existing ?? new Intl.PluralRules(locale);
  if (existing === undefined) pluralRulesByLocale.set(locale, rules);
  return rules.select(count);
}

function selectPluralForm(
  id: MessageId,
  forms: PluralForms,
  locale: AppLocale,
  params: MessageParams | undefined,
): string {
  const count = params?.count;
  if (count === undefined) {
    reportMissingCount(id);
    return forms.other;
  }
  const category = pluralCategoryFor(locale, Number(count));
  return forms[category] ?? forms.other;
}

/**
 * One message, in one locale.
 *
 * Pure: the locale is an argument, so a test can render both without touching
 * the store, the PR builder can compose a file for a locale nobody is
 * currently looking at, and neither `intl.ts` nor `translationOverrides.ts`
 * has to be imported for this function to resolve a token, an override, a
 * plural form or a fallback. `locale.ts` holds the store-bound readers over
 * it.
 *
 * A placeholder with no matching parameter is left standing rather than
 * replaced with an empty string, for the same reason a missing id is bracketed:
 * `Перейти: {target}` is a bug someone will notice, and `Перейти: ` is not.
 */
export function translateWith(locale: AppLocale, id: MessageId, params?: MessageParams): string {
  const token = (tokens as Readonly<Partial<Record<MessageId, string>>>)[id];
  const override =
    token === undefined ? overrideCache.get(overrideCacheKey(locale, id)) : undefined;
  const value: MessageValue | undefined =
    token ?? override ?? resolveFromTables(tables, locale, id);
  if (value === undefined) return missingMessage(id);
  const text = typeof value === 'string' ? value : selectPluralForm(id, value, locale, params);
  if (params === undefined) return text;
  return text.replaceAll(placeholderPattern, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}
