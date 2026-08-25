import { primaryNavigation } from '../navigation';
import type { Chord } from './match';
import { keybindRegistry, type Keybind } from './registry';

/**
 * The collections `keybinds.scheme` chooses between.
 *
 * The names are the ones `packages/settings-schema` declares for the setting.
 * They are repeated here because the definition exposes only a validator, and
 * `schemes.test.ts` asserts every name below is one the definition accepts, so
 * the two lists cannot drift apart without a test failing.
 */
export const keybindSchemes = ['terminal-default', 'vim-inspired', 'accessibility'] as const;

export type KeybindScheme = (typeof keybindSchemes)[number];

type ChordTable = Readonly<Record<string, Chord>>;

/**
 * The nine numbered routes, re-chorded together.
 *
 * They are generated from `primaryNavigation` for the same reason the registry
 * generates them: the badge drawn beside an entry in the rail is a promise
 * about which key goes there, and a scheme that listed the ids by hand would
 * be a second copy of the list to keep in step.
 */
function navigationChords(chordFor: (position: number) => Chord): ChordTable {
  return Object.fromEntries(
    primaryNavigation
      .slice(0, 9)
      .map((entry, index) => [`navigate.${entry[0]}`, chordFor(index + 1)]),
  );
}

/**
 * Motion where vim puts motion, and `g` for going somewhere.
 *
 * `h`/`l` step between the two scene sections, `k`/`j` up and down the cue
 * sheet, and `g` opens a sequence rather than a combination -- `g` then `4` is
 * the fourth rail entry, the way `4gg` is the fourth line. The commands that
 * have a vim spelling take it: `/` searches, `?` asks what the keys are, `i`
 * enters the mode that edits, `:` opens the command line, `Z` zooms one panel
 * to the whole screen and `Shift+U` undoes the scene back to its start.
 *
 * Escape and Space keep their default chords. Escape is vim's own key for
 * leaving something, and space-as-playback is not a gesture vim has an opinion
 * about; changing either would be difference for its own sake.
 */
const vimInspired: ChordTable = {
  ...navigationChords((position) => ({ prefix: 'KeyG', code: `Digit${position.toString()}` })),
  'shell.search': { code: 'Slash' },
  'shell.productionPanel': { prefix: 'KeyG', code: 'KeyP' },
  'shell.fullscreen': { code: 'KeyZ' },
  'keybinds.list': { code: 'Slash', shift: true },
  'edit.toggle': { code: 'KeyI' },
  'files.import': { code: 'KeyR', shift: true },
  'scene.commandPalette': { code: 'Semicolon', shift: true },
  'scene.sectionFiles': { code: 'KeyH' },
  'scene.sectionMap': { code: 'KeyL' },
  'scene.previousCue': { code: 'KeyK' },
  'scene.nextCue': { code: 'KeyJ' },
  'scene.resetScene': { code: 'KeyU', shift: true },
  'developer.toggle': { prefix: 'KeyG', code: 'KeyD' },
};

/**
 * One modifier at most, and never a key the modifier hand cannot reach.
 *
 * The default collection asks for Ctrl+Shift+Alt+S to import material and
 * Ctrl+Shift+Alt+D to open the developer panel: three modifiers held at once,
 * which a single hand cannot do and sticky keys turn into a four-press
 * sequence. It also puts Ctrl+K and Ctrl+/ across the keyboard from the
 * control key, so both need two hands.
 *
 * This collection answers with function keys, which are one press and no
 * modifier at all, and with single-modifier chords whose letter sits under the
 * same hand that holds Ctrl. `schemes.test.ts` enforces both rules over every
 * entry, so a later addition cannot quietly break the promise the name makes.
 *
 * The nine numbered routes keep their digits. A bare digit is already one
 * press with no modifier -- the ideal this collection exists to enforce -- and
 * the badge in the rail names it, so moving them would cost the operator the
 * label and buy nothing.
 */
const accessibility: ChordTable = {
  'shell.search': { code: 'KeyF', ctrl: true },
  'shell.productionPanel': { code: 'F4' },
  'keybinds.list': { code: 'F1' },
  'edit.toggle': { code: 'KeyE', ctrl: true },
  'files.import': { code: 'KeyS', ctrl: true },
  'scene.commandPalette': { code: 'Space', ctrl: true },
  'developer.toggle': { code: 'F10' },
};

const schemeChords: Readonly<Record<KeybindScheme, ChordTable>> = {
  // The declarations in the registry are this collection; it overrides nothing.
  'terminal-default': {},
  'vim-inspired': vimInspired,
  accessibility,
};

/**
 * Whether a chord can still fire while a field has focus.
 *
 * A chord the operator can type is a chord that eats a character. Ctrl and Alt
 * put a combination outside what a field receives, and Escape is the one bare
 * key whose whole purpose is leaving a field, so those three are the only ways
 * a keybind survives the typing guard. Deriving it rather than restating it
 * per scheme is what stops `/` -- vim's search key -- from swallowing the
 * slash in a path the operator is typing into the import dialog.
 */
function survivesTyping(chord: Chord): boolean {
  return chord.ctrl === true || chord.alt === true || chord.code === 'Escape';
}

const resolved = new Map<KeybindScheme, readonly Keybind[]>();

/**
 * The registry as one scheme chords it.
 *
 * Cached per scheme: the result is read on every keydown and on every render
 * of the list, and rebuilding an array of twenty-four objects each time would
 * also hand React a new identity on every render.
 */
export function keybindsForScheme(scheme: KeybindScheme): readonly Keybind[] {
  const cached = resolved.get(scheme);
  if (cached !== undefined) return cached;
  const chords = schemeChords[scheme];
  const keybinds = keybindRegistry.map((keybind) => {
    const chord = chords[keybind.id];
    if (chord === undefined) return keybind;
    return { ...keybind, chord, whileTyping: keybind.whileTyping && survivesTyping(chord) };
  });
  resolved.set(scheme, keybinds);
  return keybinds;
}

/**
 * Narrows a stored value to a scheme.
 *
 * The fallback is not a second copy of the setting's default: the readers in
 * `personalization/useSetting` have already resolved the definition's default
 * and rejected anything it would not accept, so a value reaching here is
 * always one of the three. The branch exists for the compiler, and
 * `schemes.test.ts` asserts it lands on the definition's own default so the
 * literal cannot drift from the schema.
 */
export function resolveKeybindScheme(value: string): KeybindScheme {
  return keybindSchemes.find((scheme) => scheme === value) ?? 'terminal-default';
}
