import { chromeMessages } from './chromeMessages';
import { connectionMessages } from './connectionMessages';
import { editMessages } from './editMessages';
import { galleryMessages } from './galleryMessages';
import { keybindMessages } from './keybindMessages';
import { materialMessages } from './materialMessages';
import { pairingMessages } from './pairingMessages';
import { pluralMessages } from './pluralMessages';
import { recordMessages } from './recordMessages';
import { settingLabelMessages } from './settingLabelMessages';
import { settingOptionMessages } from './settingOptionMessages';
import { settingsMessages } from './settingsMessages';
import { systemMessages } from './systemMessages';
import { tileMessages } from './tileMessages';
import { updateMessages } from './updateMessages';

import type { CatalogEntry, CatalogModule } from './catalogTypes';

export {
  appLocales,
  type AppLocale,
  type CatalogEntry,
  type MessageValue,
  type PluralForms,
} from './catalogTypes';

/**
 * The message catalogue, split so several people can add to it in the same
 * afternoon without touching each other's file.
 *
 * ## The partition
 *
 * One module per surface the ids describe, not per component -- the id
 * convention in `../messages.ts` already ties an id to the surface that draws
 * it rather than to the file that happens to hold it, and the split follows
 * the same rule, so a label moving between files still finds its entry:
 *
 * - `chromeMessages` -- the rail, the commands menu, the top bar, the status
 *   line, the title bar and the clock marker: what an operator reads on every
 *   route without having gone anywhere.
 * - `keybindMessages` -- shortcut descriptions and their category headings.
 * - `settingsMessages` -- the settings surface, including the per-definition
 *   descriptions and option labels the schema does not carry itself.
 * - `tileMessages` -- tile categories, motion and presentation.
 * - `editMessages` -- edit mode and the translation proposal flow.
 * - `updateMessages` -- the in-app updater and the autostart switch.
 * - `materialMessages` -- materials, transport, the record drawer and the
 *   production panel: the surfaces built around a file rather than a screen.
 * - `pairingMessages` -- the group pairing dialog: the control-plane address,
 *   the join-or-create wizard, group administration, the device roster,
 *   presence and the links a paired session holds to the group.
 * - `galleryMessages` -- the primitive gallery at `/dev/ui`, a developer
 *   surface whose text never appears on a shoot-day route.
 * - `pluralMessages` -- every message whose text depends on a count, grouped
 *   by the mechanism they share rather than by the surface that draws them.
 * - `recordMessages` -- the record screens: overview, map, cases, objects,
 *   analytics, search, reports, communications and archive.
 * - `settingLabelMessages` -- a label and a description for every setting
 *   definition, plus the `settingScope.*` vocabulary the detail line draws
 *   from. Totality is a compile error, not a convention: `settingLocalization`
 *   declares `Record<SettingId, MessageId>` over the schema's own id union.
 * - `settingOptionMessages` -- the option labels an enum setting's dropdown
 *   shows.
 * - `connectionMessages` -- why a configured control-plane address was refused,
 *   read before any request is attempted rather than after one fails.
 * - `systemMessages` -- the settings screen's own chrome and its ten shared
 *   sections, the group-history sub-panel, the `/system` screen and the
 *   developer contour (`DeveloperGate`, `DeveloperPanel`).
 *
 * A wave translating a surface with no module of its own adds one here rather
 * than appending to an existing file: `<area>Messages.ts`, exporting
 * `<area>Messages` typed `as const satisfies CatalogModule`, imported and
 * spread below. That is the point of the split -- what it replaces is two
 * agents' diffs landing on the same 900-line object.
 *
 * ## Why a hole is a compile error
 *
 * `CatalogEntry` requires every locale in `AppLocale`, so an entry missing a
 * language does not parse, and adding a third locale stops every module
 * compiling until its line is filled in. That is the mandate -- every string
 * translated into every available language -- encoded once here instead of
 * carried as a convention that several hundred entries would each have to
 * remember.
 *
 * The guarantee is only as good as the modules staying disjoint, which is what
 * {@link catalogModules} and the duplicate-id test exist to hold: a spread
 * silently lets a later module shadow an earlier one with no error at all, so
 * two modules declaring one id would otherwise build cleanly with one of the
 * two texts unreachable.
 */
const catalogModulesByName = {
  chrome: chromeMessages,
  keybind: keybindMessages,
  settings: settingsMessages,
  settingLabel: settingLabelMessages,
  settingOption: settingOptionMessages,
  tile: tileMessages,
  edit: editMessages,
  update: updateMessages,
  material: materialMessages,
  pairing: pairingMessages,
  gallery: galleryMessages,
  plural: pluralMessages,
  record: recordMessages,
  connection: connectionMessages,
  system: systemMessages,
} as const satisfies Readonly<Record<string, CatalogModule>>;

/** Every module, by name, so a test can check the modules stay disjoint. */
export const catalogModules: Readonly<Record<string, CatalogModule>> = catalogModulesByName;

/** The merged catalogue: every id from every module, in one lookup. */
export const catalog = {
  ...chromeMessages,
  ...keybindMessages,
  ...settingsMessages,
  ...settingLabelMessages,
  ...settingOptionMessages,
  ...tileMessages,
  ...editMessages,
  ...updateMessages,
  ...materialMessages,
  ...pairingMessages,
  ...galleryMessages,
  ...pluralMessages,
  ...recordMessages,
  ...connectionMessages,
  ...systemMessages,
} as const satisfies Readonly<Record<string, CatalogEntry>>;

export type CatalogId = keyof typeof catalog;
