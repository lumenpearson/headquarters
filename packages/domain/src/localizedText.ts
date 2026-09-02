/**
 * Fictional content -- scene titles, dossier text, cue labels -- under the
 * ruling that every string the application shows has a Russian and an
 * English side, with Russian the source and English the side that lands
 * later, one field at a time.
 *
 * This is deliberately not `MessageId`. `MessageId` is `keyof typeof ru` in
 * an `apps/hq` catalogue built for ~310 reusable chrome strings; routing the
 * 560 single-use pieces of shooting-script prose through it would make
 * `packages/domain` (or a package under it) depend on that catalogue, which
 * inverts presentation -> application -> domain, and would turn a scene
 * definition from dossier prose a reviewer can check against the script into
 * a table of opaque ids no one can. Nor is it machine translation: an
 * invented English side nobody checked against the script is worse than an
 * honest gap, which is what the resolver and the counters below report
 * instead of papering over.
 */

/**
 * A locale tag, e.g. `'ru'` or `'en'`. A plain string rather than a fixed
 * union: the application's locale set is `AppLocale`, owned by
 * `apps/hq/src/application/localization/messages.ts`, and this package sits
 * at the bottom of the dependency direction (presentation -> application ->
 * domain) and does not import it -- doing so would make the bottom of the
 * stack depend on its own composition root. Every function below takes the
 * locale (and, where a fallback applies, the source locale) as a parameter
 * instead, so it resolves and counts against whatever tag the caller names
 * without knowing which tags exist.
 */
export type LocaleTag = string;

/**
 * One piece of translatable content, keyed by locale once it has more than
 * one side.
 *
 * A bare `string` means "source locale, not yet translated" -- exactly the
 * shape every scene definition already has, which is what makes widening a
 * field from `string` to `LocalizedText` additive: every existing value
 * keeps parsing and keeps compiling unchanged. Once an English side exists,
 * the value becomes a record; the record stays partial (`Partial`, not a
 * required pair) because a translation lands one locale at a time, not both
 * at once, and a field mid-translation is a real, representable state, not
 * an error.
 */
export type LocalizedText = string | Readonly<Partial<Record<LocaleTag, string>>>;

export interface LocalizedTextResolution {
  /** The best available string: the requested locale, the fallback locale, or `''` when neither has one. */
  readonly text: string;
  /**
   * True whenever `text` did not come from the exact requested locale --
   * because the fallback locale supplied it instead, or because neither
   * locale had anything and `text` is `''`. A caller that reads only `text`
   * cannot tell a real translation from a gap papered over; `usedFallback`
   * is what lets it count the gap instead.
   */
  readonly usedFallback: boolean;
}

/**
 * Resolves one piece of content against a requested locale, falling back to
 * `fallbackLocale` and finally to `''` when neither is present.
 *
 * Pure and framework-free: both locale tags are parameters, so this function
 * carries no opinion about which locale is Russian, which is English, or how
 * many locales the application has. A bare string is treated as
 * `fallbackLocale` content that has not been split into a record yet, so
 * requesting any other locale falls back to it -- consistent with
 * {@link LocalizedText}'s "source locale, not yet translated" reading.
 */
export function resolveLocalizedText(
  value: LocalizedText,
  locale: LocaleTag,
  fallbackLocale: LocaleTag,
): LocalizedTextResolution {
  if (typeof value === 'string') {
    return { text: value, usedFallback: locale !== fallbackLocale };
  }
  const requested = value[locale];
  if (requested !== undefined) return { text: requested, usedFallback: false };
  const fallback = value[fallbackLocale];
  if (fallback !== undefined) return { text: fallback, usedFallback: true };
  return { text: '', usedFallback: true };
}

/**
 * True when `value` has no string for `locale` -- neither an explicit record
 * key nor, for a bare string, the implicit `sourceLocale` reading that
 * {@link LocalizedText} gives it. Shared by the counters below; a caller that
 * wants the text itself wants {@link resolveLocalizedText}.
 */
export function isLocalizedTextMissing(
  value: LocalizedText,
  locale: LocaleTag,
  sourceLocale: LocaleTag,
): boolean {
  if (typeof value === 'string') return locale !== sourceLocale;
  return value[locale] === undefined;
}

/**
 * Counts how many of `values` lack `locale`, treating a bare string as
 * already written in `sourceLocale`.
 *
 * This is the measure behind "the mechanism is total, the data is measured":
 * an operator can be told how many scene strings still need an English side
 * rather than being handed a slogan. A caller with its own `LocalizedText`
 * fields -- the operations seed, say -- collects them into a flat list and
 * calls this directly; {@link countSceneMissingLocalizedText} is the
 * `SceneDefinition`-shaped convenience over the same primitive.
 */
export function countMissingLocalizedText(
  values: readonly LocalizedText[],
  locale: LocaleTag,
  sourceLocale: LocaleTag,
): number {
  let missing = 0;
  for (const value of values) {
    if (isLocalizedTextMissing(value, locale, sourceLocale)) missing += 1;
  }
  return missing;
}
