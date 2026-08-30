/**
 * The vocabulary of marks the shell needs, independent of which library draws
 * them.
 *
 * Sixteen are the settings-card kinds `settingsCardIcons.tsx` used to own
 * alone (folded in here so there is one vocabulary rather than two); seven are
 * the window chrome and shell controls this pass moves off raw Unicode
 * glyphs. Adding a name here is a compile error in every adapter's
 * `satisfies Record<IconName, IconNode>` until that adapter answers it -- a
 * library that cannot draw a mark the shell needs has to fail at build time,
 * not leave a blank tile on a wall screen mid-shoot.
 */
export const iconNames = [
  'interface',
  'simulation',
  'workspace',
  'group',
  'data',
  'keybinds',
  'history',
  'keymap',
  'appearance',
  'layout',
  'motion',
  'information',
  'media',
  'session',
  'system',
  'update',
  'minimize',
  'maximize',
  'restore',
  'close',
  'menu',
  'expand',
  'collapse',
] as const;

export type IconName = (typeof iconNames)[number];

/**
 * One SVG child element, as a tag name and its attributes.
 *
 * This is the shape `@hugeicons/core-free-icons` already publishes each of
 * its icons in, and the one every adapter here normalizes to -- lucide-react
 * and `@tabler/icons-react` keep the identical shape internally (each
 * per-icon module's own `__iconNode`), so one rendering path in `TerminalIcon`
 * serves all four libraries. `key` lives inside the attributes, exactly as
 * every source library already writes it, rather than as a second parameter:
 * an icon with one child has no need of one, and `TerminalIcon` falls back to
 * the array index for those.
 */
export type IconNode = readonly (readonly [string, Readonly<Record<string, string | number>>])[];

/** A library's answer for every name the shell can ask for. */
export type IconAdapter = Readonly<Record<IconName, IconNode>>;

/**
 * The switchable libraries, in the order `SchemaSetting.tsx`'s preview and
 * the `styles.iconSet` enum both draw them.
 *
 * `'terminal'` is first and stays the setting's `defaultValue`
 * (`packages/settings-schema`): the repository's own drawn marks, so shoot-day
 * appearance does not move for an operator who never opens this setting.
 */
export const iconSetIds = ['terminal', 'lucide', 'hugeicons', 'tabler'] as const;

export type IconSetId = (typeof iconSetIds)[number];
