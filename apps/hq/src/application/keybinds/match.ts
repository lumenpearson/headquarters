/**
 * A key combination, declared once so it can be matched, listed and printed
 * from the same description.
 *
 * `code` is the physical key (`KeyboardEvent.code`), not the character it
 * produces: on a Russian layout `event.key` for the K key is `л`, and the
 * handlers this replaces were split between the two conventions.
 */
export interface Chord {
  readonly code: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  /**
   * A key pressed and released just before `code`, rather than held with it.
   *
   * `keybinds.scheme`'s vim-inspired collection addresses the nine numbered
   * routes as `g` then a digit, which is a sequence and not a combination.
   * Without a second field the scheme could only spell that as a modifier, and
   * the printed chord would tell the operator to hold a key vim never holds.
   */
  readonly prefix?: string;
}

/**
 * Every declared modifier must be held and every undeclared one must not.
 *
 * The scattered handlers this replaces tested only the modifiers they cared
 * about, so Ctrl+Shift+Alt+E fired edit mode -- declared as Ctrl+Shift+E --
 * even though Ctrl+Shift+Alt+S is a different command. Exact matching is what
 * lets the registry promise that a listed chord does one thing.
 *
 * The command key stands in for control, which is the same gesture on a Mac
 * keyboard, and is how Ctrl+K already behaved before this registry existed.
 *
 * `pending` is the prefix key the runtime is holding open, or `undefined` when
 * none is. It must equal the chord's own prefix: a scheme that let a prefixed
 * chord fire without its prefix would give the same key two meanings.
 */
export function matchesChord(
  event: KeyboardEvent,
  chord: Chord,
  pending?: string | undefined,
): boolean {
  if (chord.prefix !== pending) return false;
  if (event.code !== chord.code) return false;
  if ((chord.ctrl === true) !== (event.ctrlKey || event.metaKey)) return false;
  if ((chord.shift === true) !== event.shiftKey) return false;
  return (chord.alt === true) === event.altKey;
}

const printedKeys: Readonly<Record<string, string>> = {
  Escape: 'Esc',
  Space: 'Пробел',
  Slash: '/',
  Semicolon: ';',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
};

/** Prints a chord the way the key is labelled on a keyboard. */
export function formatChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl === true) parts.push('Ctrl');
  if (chord.shift === true) parts.push('Shift');
  if (chord.alt === true) parts.push('Alt');
  parts.push(printKey(chord.code));
  const combination = parts.join(' + ');
  // A prefixed chord is two presses in turn. Printing it with `+` like the
  // rest would tell the operator to hold G down while pressing 1, which is the
  // one gesture that does not work.
  return chord.prefix === undefined ? combination : `${printKey(chord.prefix)} → ${combination}`;
}

function printKey(code: string): string {
  return printedKeys[code] ?? stripCodePrefix(code);
}

function stripCodePrefix(code: string): string {
  for (const prefix of ['Key', 'Digit', 'Numpad']) {
    if (code.startsWith(prefix)) return code.slice(prefix.length);
  }
  return code;
}
