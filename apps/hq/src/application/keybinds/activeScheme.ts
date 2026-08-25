'use client';

import { readStringSetting, useStringSetting } from '@/application/personalization/useSetting';

import type { Keybind } from './registry';
import { keybindsForScheme, resolveKeybindScheme, type KeybindScheme } from './schemes';

/**
 * `keybinds.scheme`, read where React cannot be.
 *
 * The single keydown listener is a plain DOM handler, so it reads the setting
 * at the moment the key arrives rather than closing over a value from the
 * render that installed it. Changing the scheme in settings therefore takes
 * effect on the next press, with no remount and no listener to re-register.
 */
export function activeKeybindScheme(): KeybindScheme {
  return resolveKeybindScheme(readStringSetting('keybinds.scheme'));
}

export function activeKeybinds(): readonly Keybind[] {
  return keybindsForScheme(activeKeybindScheme());
}

/**
 * The same collection, for the surfaces that print it.
 *
 * The list in settings and the first-launch card are what an operator learns
 * the keyboard from, so they subscribe to the setting and redraw when it
 * changes. A list that kept showing Ctrl+Shift+Alt+S after the operator chose
 * the accessibility collection would be teaching a chord that no longer fires.
 */
export function useActiveKeybinds(): readonly Keybind[] {
  return keybindsForScheme(resolveKeybindScheme(useStringSetting('keybinds.scheme')));
}
