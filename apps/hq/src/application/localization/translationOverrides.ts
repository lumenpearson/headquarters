import {
  messageIds,
  overrideCacheKey,
  placeholdersMatch,
  setOverrideCache,
  sourceMessageValue,
  type AppLocale,
  type MessageId,
} from './messages';

import { appLocales } from './catalog';

/**
 * The read side of the in-app translation editor a later wave builds:
 * storage, validation and resolution for the operator's own per-id, per-locale
 * text overrides. No UI here -- this is the tenth key `localStorage` grows to,
 * `hq.translation-overrides.v1` (the roster is a stated contract in
 * `CLAUDE.md`, `docs/release/environment.md` and
 * `docs/architecture/dependency-map.md`, amended alongside this file).
 *
 * ## The idiom
 *
 * Modelled on `apps/hq/src/components/operations/materialAnnotations.ts`: an
 * exported key constant, pure functions over a `StorageLike`, try/catch around
 * every storage touch (materialAnnotations.ts only wraps the read; every touch
 * here is wrapped, because a corrupt write is exactly as recoverable as a
 * corrupt read and there is no reason the guarantee should differ), normalize
 * on read, and explicit caps rather than an unbounded blob.
 *
 * ## Caps
 *
 * 512 characters per entry -- long enough for any label this catalogue has
 * carried so far with room to spare, short enough that one override cannot
 * become a paragraph. 4000 entries total: the campaign this module is the
 * keystone for adds roughly 1,600 ids, which at full catalogue size is well
 * under 4,000 (locale, id) pairs even if an operator overrode every message in
 * both languages, and 4,000 entries at 512 characters each caps the blob at
 * roughly 2 MB -- comfortably inside a browser's `localStorage` quota beside
 * the application's other keys. This is why the mandate explicitly rules out
 * `personalization.draft.values`: settings history snapshots the whole values
 * object twice per change, and a full-catalogue override table living there
 * would take the persisted blob to tens of megabytes for a single settings
 * edit.
 *
 * ## Validation refuses an entry, not the file
 *
 * A hand-edited or partially-written blob should cost the operator the one
 * override that does not parse, not the rest of the table -- the same
 * reasoning `elementTranslations.ts`'s `readElementTranslations` applies, but
 * unlike that reader, {@link validateTranslationOverride} returns *why* an
 * entry was refused rather than only that it was, because the editor this
 * module exists for has to show that reason next to the row, not just drop
 * the row silently. The checks: `locale` names a locale this application
 * ships, `id` names a real catalogue entry (not a token -- overriding `UTC`
 * would defeat the reason it is a token -- and not yet a plural-valued entry,
 * out of scope for this wave), the text is non-empty, at most 512 characters,
 * free of the C0/C1 control code points and of the bidi-override code points
 * this module's own patterns list, and asks for exactly the placeholders the
 * source message does -- an override that dropped `{target}` would silently
 * break a label instead of visibly failing to save.
 */

export const translationOverridesStorageKey = 'hq.translation-overrides.v1';

const maxOverrideTextLength = 512;
const maxOverrideEntryCount = 4000;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The stored blob: `${locale}:${id}` -> the operator's own text for it. */
export type TranslationOverrides = Readonly<Record<string, string>>;

export interface TranslationOverrideAddress {
  readonly locale: AppLocale;
  readonly id: MessageId;
}

export function translationOverrideKey(address: TranslationOverrideAddress): string {
  return overrideCacheKey(address.locale, address.id);
}

export type TranslationOverrideRefusalReason =
  | 'unknown-locale'
  | 'unknown-id'
  | 'non-catalog-id'
  | 'plural-message'
  | 'empty'
  | 'too-long'
  | 'control-character'
  | 'bidi-override'
  | 'placeholder-mismatch';

export type TranslationOverrideValidation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: TranslationOverrideRefusalReason };

/**
 * C0 and C1 control code points, U+0000 through U+001F and U+007F through
 * U+009F, built from a code-point range so the source file holds no literal
 * control bytes of its own.
 */
const controlCharacterPattern = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'u');

/**
 * Bidi-embedding and bidi-isolate override code points, U+202A through
 * U+202E and U+2066 through U+2069, built the same way and for the same
 * reason.
 */
const bidiOverridePattern = new RegExp('[\\u202A-\\u202E\\u2066-\\u2069]', 'u');

function isAppLocale(value: string): value is AppLocale {
  return (appLocales as readonly string[]).includes(value);
}

function isMessageId(value: string): value is MessageId {
  return (messageIds as readonly string[]).includes(value);
}

/**
 * One override entry, checked against every rule in this module's header.
 *
 * Takes a plain-string address rather than {@link TranslationOverrideAddress}:
 * the whole point of validating is that `locale` and `id` are not trusted yet,
 * which is exactly what an id typed `MessageId` would assert without proof.
 */
export function validateTranslationOverride(
  address: { readonly locale: string; readonly id: string },
  rawValue: string,
): TranslationOverrideValidation {
  if (!isAppLocale(address.locale)) return { ok: false, reason: 'unknown-locale' };
  if (!isMessageId(address.id)) return { ok: false, reason: 'unknown-id' };
  const source = sourceMessageValue(address.id);
  if (source === undefined) return { ok: false, reason: 'non-catalog-id' };
  if (typeof source !== 'string') return { ok: false, reason: 'plural-message' };
  const value = rawValue.normalize('NFC').trim();
  if (value.length === 0) return { ok: false, reason: 'empty' };
  if (value.length > maxOverrideTextLength) return { ok: false, reason: 'too-long' };
  if (controlCharacterPattern.test(value)) return { ok: false, reason: 'control-character' };
  if (bidiOverridePattern.test(value)) return { ok: false, reason: 'bidi-override' };
  if (!placeholdersMatch(source, value)) return { ok: false, reason: 'placeholder-mismatch' };
  return { ok: true, value };
}

/**
 * Sorts by key and truncates to `limit`, so which entries survive a cap is
 * deterministic rather than dependent on `Object.entries`' enumeration order
 * for whatever the blob happened to contain.
 *
 * A separate, exported function -- with the limit as a parameter rather than
 * the module's own {@link maxOverrideEntryCount} -- because the real cap is
 * sized for the catalogue this campaign is building towards (roughly 1,600
 * more ids), too large to reach with the ids that exist today; a test proves
 * this function's behaviour at a limit it can actually exceed.
 */
export function capTranslationOverrideEntries(
  entries: readonly (readonly [string, string])[],
  limit: number,
): TranslationOverrides {
  const sorted = [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(sorted.slice(0, limit));
}

/**
 * Reads a stored blob into the validated map, dropping (not throwing on) any
 * entry that fails {@link validateTranslationOverride}, then applies
 * {@link capTranslationOverrideEntries} at {@link maxOverrideEntryCount}.
 */
export function normalizeTranslationOverrides(value: unknown): TranslationOverrides {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const validated: [string, string][] = [];
  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== 'string') continue;
    const separatorIndex = key.indexOf(':');
    if (separatorIndex === -1) continue;
    const locale = key.slice(0, separatorIndex);
    const id = key.slice(separatorIndex + 1);
    const result = validateTranslationOverride({ locale, id }, text);
    if (!result.ok || !isAppLocale(locale) || !isMessageId(id)) continue;
    validated.push([overrideCacheKey(locale, id), result.value]);
  }
  return capTranslationOverrideEntries(validated, maxOverrideEntryCount);
}

export function readTranslationOverrides(storage: StorageLike): TranslationOverrides {
  try {
    return normalizeTranslationOverrides(
      JSON.parse(storage.getItem(translationOverridesStorageKey) ?? '{}'),
    );
  } catch {
    return {};
  }
}

export function writeTranslationOverrides(
  storage: StorageLike,
  overrides: TranslationOverrides,
): void {
  try {
    storage.setItem(
      translationOverridesStorageKey,
      JSON.stringify(normalizeTranslationOverrides(overrides)),
    );
  } catch {
    // Storage blocked or full. The override lives for this process only, the
    // same trade-off `writeManualControlPlaneAddress` makes for its own key.
  }
}

export type TranslationOverrideWriteResult =
  | { readonly kind: 'set'; readonly overrides: TranslationOverrides }
  | { readonly kind: 'cleared'; readonly overrides: TranslationOverrides }
  | { readonly kind: 'refused'; readonly reason: TranslationOverrideRefusalReason };

/**
 * Rewrites one entry, clearing it on blank text -- the same "clearing is a
 * removal, not a stored empty string" idiom `withElementTranslation` uses, so
 * an override equal to no override is not a change the operator later has to
 * find and undo. A refusal leaves `overrides` untouched and says why, for the
 * editor to show beside the row.
 */
export function withTranslationOverride(
  overrides: TranslationOverrides,
  address: TranslationOverrideAddress,
  text: string,
): TranslationOverrideWriteResult {
  const key = translationOverrideKey(address);
  if (text.trim() === '') {
    const { [key]: _removed, ...rest } = overrides;
    return { kind: 'cleared', overrides: rest };
  }
  const validation = validateTranslationOverride(address, text);
  if (!validation.ok) return { kind: 'refused', reason: validation.reason };
  return { kind: 'set', overrides: { ...overrides, [key]: validation.value } };
}

/**
 * Populates `translateWith`'s runtime cache from storage.
 *
 * Refreshes the cache wholesale; nothing calls this per lookup; it is meant
 * to run once at startup and again whenever the editor this module has no UI
 * for yet saves a change.
 */
export function loadTranslationOverrides(storage: StorageLike): void {
  setOverrideCache(new Map(Object.entries(readTranslationOverrides(storage))));
}

export interface TranslationOverrideFixture {
  readonly locale: AppLocale;
  readonly id: MessageId;
  readonly value: string;
}

/**
 * Test seam: sets the runtime cache directly, bypassing storage and
 * validation, so a test can assert exactly what `translateWith` does with a
 * given override without first proving `normalizeTranslationOverrides`
 * correct in the same breath. Call with `[]` to clear it between tests.
 */
export function setTranslationOverridesForTests(
  entries: readonly TranslationOverrideFixture[],
): void {
  setOverrideCache(new Map(entries.map((entry) => [translationOverrideKey(entry), entry.value])));
}
