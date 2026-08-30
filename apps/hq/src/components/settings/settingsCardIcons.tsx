'use client';

import { TerminalIcon } from '@gremuchaya/ui/primitives';

import { useStringSetting } from '@/application/personalization/useSetting';

/**
 * The settings-card grid's sixteen marks -- folded into `TerminalIcon`'s own
 * `IconName` vocabulary rather than kept as a second one. This module used to
 * draw them itself (`.settings-card__icon svg`, stroke-on-viewBox, no icon
 * dependency); those sixteen shapes are now `terminal.ts`'s adapter entries
 * of the same names, and `styles.iconSet` at its `'terminal'` default renders
 * this grid byte-identical to before.
 */
export type SettingsCardIconKind =
  | 'interface'
  | 'simulation'
  | 'workspace'
  | 'group'
  | 'data'
  | 'keybinds'
  | 'history'
  | 'keymap'
  | 'appearance'
  | 'layout'
  | 'motion'
  | 'information'
  | 'media'
  | 'session'
  | 'system'
  | 'update';

export function SettingsCardIcon({ kind }: { readonly kind: SettingsCardIconKind }) {
  const iconSet = useStringSetting('styles.iconSet');
  return <TerminalIcon name={kind} iconSet={iconSet} />;
}
