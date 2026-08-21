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
 */
export function matchesChord(event: KeyboardEvent, chord: Chord): boolean {
  if (event.code !== chord.code) return false;
  if ((chord.ctrl === true) !== (event.ctrlKey || event.metaKey)) return false;
  if ((chord.shift === true) !== event.shiftKey) return false;
  return (chord.alt === true) === event.altKey;
}

const printedKeys: Readonly<Record<string, string>> = {
  Escape: 'Esc',
  Space: 'Пробел',
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
  parts.push(printedKeys[chord.code] ?? stripCodePrefix(chord.code));
  return parts.join(' + ');
}

function stripCodePrefix(code: string): string {
  for (const prefix of ['Key', 'Digit', 'Numpad']) {
    if (code.startsWith(prefix)) return code.slice(prefix.length);
  }
  return code;
}
