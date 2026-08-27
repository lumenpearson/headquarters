import { appLocales, type AppLocale } from './messages';

/**
 * A caption one operator gave one element, in one language.
 *
 * R28's edit-mode half: the catalogue translates what the application ships,
 * and this translates what a particular shoot calls a particular tile. A group
 * that calls the objects registry something else on their wall says so here,
 * once, and the change lands in the settings draft with everything else --
 * undo, the history, the issue draft, the group scope.
 *
 * ## The address
 *
 * `locale:screen:element=<encoded>`, following `tiles.spans` and
 * `tiles.animations` (`personalization/tileMotion.ts`) rather than inventing a
 * third storage shape. Two of the three parts are there for reasons already
 * paid for once:
 *
 * - **screen**, because a tile identifier is unique only within a screen.
 *   `registry` is the table on four of them, and `edit.selectedElementId`
 *   holds the bare tile id -- so a caption stored under `registry` alone would
 *   rename the table on all four. `TileMotionPicker` re-qualifies with the
 *   route at read and write time, and so does the surface over this.
 * - **locale**, because a caption that applied in every language is the one
 *   thing localization cannot mean. Without it, typing an English caption
 *   would overwrite the Russian one, and the operator would have translated
 *   the element out of existence in their own language.
 *
 * ## Why the value is percent-encoded
 *
 * A caption is free operator text. The setting is a `string-list`, whose
 * editor splits on `,`, and the entry itself is split on `=` and `:`. A
 * caption containing any of the three would be silently cut in half or dropped
 * on the next read. `encodeURIComponent` escapes all three along with the
 * Cyrillic, so an entry holds no separator it does not mean, and the raw list
 * stays inspectable in the settings catalogue rather than becoming an opaque
 * blob.
 */

/**
 * The definition this list is stored under.
 *
 * Named here rather than at each call site, so the panel that writes a caption
 * and the tile header that draws one address the same list. The definition
 * itself lives in `packages/settings-schema`, which validates the entry shape
 * this module writes -- the schema is the trust boundary, and a caption that
 * reached the draft in a shape no reader can parse would be a caption the
 * operator wrote and never saw again.
 */
export const elementTranslationsSetting = 'localization.elementOverrides';

/**
 * Long enough for a tile caption in either language, short enough that the
 * whole list still fits a prefilled URL. Tile headers are two or three words.
 */
export const maxElementTranslationLength = 120;

export interface ElementTranslationAddress {
  readonly locale: AppLocale;
  readonly screen: string;
  readonly element: string;
}

export interface ElementTranslationEntry extends ElementTranslationAddress {
  readonly text: string;
}

/*
 * The encoded value carries no whitespace -- `encodeURIComponent` turns a
 * space into `%20` -- so `\S+` both matches what this module writes and
 * rejects an entry hand-typed with a space in it, which would not survive the
 * next round trip anyway.
 */
const entryPattern = /^([a-z]{2}):([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)=(\S+)$/u;

function isAppLocale(value: string): value is AppLocale {
  return (appLocales as readonly string[]).includes(value);
}

export function elementTranslationKey({
  locale,
  screen,
  element,
}: ElementTranslationAddress): string {
  return `${locale}:${screen}:${element}`;
}

/**
 * Reads the stored list into a map keyed by {@link elementTranslationKey}.
 *
 * An entry that does not parse is skipped rather than thrown on: the list is
 * editable by hand in the settings catalogue, and one malformed line should
 * cost that line, not every caption on the screen.
 */
export function readElementTranslations(entries: readonly string[]): ReadonlyMap<string, string> {
  const translations = new Map<string, string>();
  for (const entry of entries) {
    const match = entryPattern.exec(entry);
    if (match === null) continue;
    const [, locale, screen, element, encoded] = match;
    if (
      locale === undefined ||
      screen === undefined ||
      element === undefined ||
      encoded === undefined
    ) {
      continue;
    }
    if (!isAppLocale(locale)) continue;
    const text = decode(encoded);
    if (text === undefined || text === '') continue;
    translations.set(elementTranslationKey({ locale, screen, element }), text);
  }
  return translations;
}

/** The caption for one element, or nothing when the operator has given none. */
export function elementTranslation(
  entries: readonly string[],
  address: ElementTranslationAddress,
): string | undefined {
  return readElementTranslations(entries).get(elementTranslationKey(address));
}

/**
 * What one element is called on screen right now: the caption the operator
 * wrote for it in the language in force, or the one the application ships.
 *
 * This is R28's read path, and it is deliberately a pure function rather than a
 * hook or a store reader. The entries and the locale arrive as arguments so the
 * single subscription lives in `TileGrid`, which already holds one for every
 * other per-tile setting; a resolver that read the store itself would put a
 * second subscription under every panel on the screen and would be untestable
 * without one.
 *
 * The fallback is the source caption, never the empty string and never the
 * element id. An override is a rename, and a rename that could erase a heading
 * would let one malformed entry leave a panel with no name at all.
 */
export function elementCaption(
  entries: readonly string[],
  address: ElementTranslationAddress,
  source: string,
): string {
  return elementTranslation(entries, address) ?? source;
}

/**
 * Rewrites the list for one element, dropping the entry when the caption is
 * cleared.
 *
 * Clearing removes rather than storing an empty string, in the idiom
 * `withTileMotion` uses for `inherit`: an override equal to no override is a
 * change the operator would then have to find and undo.
 */
export function withElementTranslation(
  entries: readonly string[],
  address: ElementTranslationAddress,
  text: string,
): readonly string[] {
  const prefix = `${elementTranslationKey(address)}=`;
  const rest = entries.filter((entry) => !entry.startsWith(prefix));
  const trimmed = text.trim().slice(0, maxElementTranslationLength);
  if (trimmed === '') return rest;
  return [...rest, `${prefix}${encodeURIComponent(trimmed)}`].sort();
}

/**
 * Every caption stored for one locale, in the order the list holds them.
 *
 * This is what the translation pull request carries, so it returns the address
 * as well as the text: a reviewer reading the proposal has to see which screen
 * and which tile a caption belongs to, and `overview:brief` alone would not
 * say which language it was written for.
 */
export function elementTranslationsFor(
  entries: readonly string[],
  locale: AppLocale,
): readonly ElementTranslationEntry[] {
  const found: ElementTranslationEntry[] = [];
  for (const entry of entries) {
    const match = entryPattern.exec(entry);
    if (match === null) continue;
    const [, entryLocale, screen, element, encoded] = match;
    if (entryLocale !== locale || screen === undefined || element === undefined) continue;
    const text = encoded === undefined ? undefined : decode(encoded);
    if (text === undefined || text === '') continue;
    found.push({ locale, screen, element, text });
  }
  return found;
}

/**
 * A hand-edited list can hold a lone `%` or a truncated escape, which
 * `decodeURIComponent` answers with a thrown `URIError`. That is one bad
 * entry, not a broken screen.
 */
function decode(encoded: string): string | undefined {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}
