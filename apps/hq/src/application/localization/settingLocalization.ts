'use client';

import type { SettingDefinition } from '@gremuchaya/settings-schema';

import { tilePresentationLabel } from './tileLabels';
import type { MessageId } from './messages';
import { messagesFor, sourceLocale, type AppLocale } from './messages';

/**
 * The setting definitions `packages/settings-schema` ships have no
 * localization key of their own -- `apps/control-plane/src/settings/schema.ts`
 * sends `localizationKey: ''` on the wire deliberately, because the registry
 * is a trust boundary and inventing a key on the server side would only add a
 * second source of truth no message catalogue answers. This is the
 * catalogue-side half of that decision: a lookup keyed by the definition's own
 * id, so a description or an enum option can be given a Russian and an
 * English reading without the schema learning either language exists.
 *
 * Coverage is intentionally partial. `messages.ts` carries a
 * `settingDescription.<id>` entry for every setting this pass translated; a
 * definition with none falls back to its own `description`, in English, the
 * way every one of them did before this module existed. That fallback is not
 * a defect the way a missing chrome string is -- there is no bracketed
 * `⟦…⟧` marker and no console line for it, because leaving the schema's own
 * words standing is the designed behaviour for an id nobody has translated
 * yet, not a bug in this lookup.
 */
export function localizedSettingDescription(
  definition: SettingDefinition,
  locale: AppLocale,
): string {
  const id = `settingDescription.${definition.id}` as MessageId;
  return messagesFor(locale)[id] ?? messagesFor(sourceLocale)[id] ?? definition.description;
}

/**
 * The label an `enum` setting's dropdown shows for one of its options.
 *
 * The first lookup is `settingOption.<id>.<option>` in the catalogue --
 * `dateTime.mode`'s clocks live there as full words, because the
 * 4-character status-line markers (`dateTime.ts`'s `dateTimeModeLabel`) are
 * abbreviations a surface paying for every character earns and a dropdown
 * does not. `tiles.presentation` reuses the same four phrases the per-tile
 * presentation picker draws (`tileLabels.ts`'s `tilePresentationLabel`).
 * Every other enum setting still shows its option's own identifier,
 * uppercased, the way `SchemaSetting` drew it before this module existed --
 * the fallback `SchemaSetting` itself used to apply inline, now applied here
 * so both call sites agree. That fallback is also what spells
 * `dateTime.mode`'s third option `UTC` in every locale.
 */
export function localizedEnumOptionLabel(
  definition: SettingDefinition,
  option: string,
  locale: AppLocale,
): string {
  const id = `settingOption.${definition.id}.${option}` as MessageId;
  const translated = messagesFor(locale)[id] ?? messagesFor(sourceLocale)[id];
  if (translated !== undefined) return translated;
  if (definition.id === 'tiles.presentation' && isTilePresentationOption(option)) {
    return tilePresentationLabel(option);
  }
  return option.toUpperCase();
}

function isTilePresentationOption(value: string): value is 'auto' | 'full' | 'compact' | 'minimal' {
  return value === 'auto' || value === 'full' || value === 'compact' || value === 'minimal';
}
