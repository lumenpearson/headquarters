import { getSettingDefinition } from '@gremuchaya/settings-schema';
import { describe, expect, it } from 'vitest';

import { formatChord, type Chord } from './match';
import { keybindRegistry } from './registry';
import {
  keybindSchemes,
  keybindsForScheme,
  resolveKeybindScheme,
  type KeybindScheme,
} from './schemes';

const definition = getSettingDefinition('keybinds.scheme');

const chordOf = (scheme: KeybindScheme, id: string): Chord | undefined =>
  keybindsForScheme(scheme).find((keybind) => keybind.id === id)?.chord;

const modifierCount = (chord: Chord): number =>
  [chord.ctrl, chord.shift, chord.alt].filter((held) => held === true).length;

/**
 * Keys the hand already holding a modifier can also reach.
 *
 * Ctrl, Shift and Alt all sit at the bottom left, so a modified chord is a
 * one-handed gesture only when its key sits on the left half of the board.
 * Space is the thumb of that same hand.
 */
const withinOneHandOfAModifier = new Set([
  'KeyQ',
  'KeyW',
  'KeyE',
  'KeyR',
  'KeyT',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyF',
  'KeyG',
  'KeyZ',
  'KeyX',
  'KeyC',
  'KeyV',
  'KeyB',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Space',
  'Tab',
  'Escape',
]);

describe('keybind schemes', () => {
  it('offers exactly the collections the definition accepts', () => {
    // The names are written twice -- once in the schema, once here -- because
    // the definition exposes only a validator. This is what stops the two
    // copies drifting into a scheme the operator can choose and nothing reads.
    for (const scheme of keybindSchemes) {
      expect(definition?.validate(scheme), scheme).toBe(true);
    }
    expect(definition?.validate('emacs-inspired')).toBe(false);
  });

  it('narrows an unusable value to the definition’s own default', () => {
    expect(resolveKeybindScheme('emacs-inspired')).toBe(definition?.defaultValue);
  });

  it('leaves terminal-default as the declarations themselves', () => {
    expect(keybindsForScheme('terminal-default')).toEqual(keybindRegistry);
  });

  it('gives every scheme the same actions, only different chords', () => {
    // A scheme is a chord table, not a second registry: an action must not be
    // reachable in one collection and missing from another.
    const ids = keybindRegistry.map((keybind) => keybind.id);
    for (const scheme of keybindSchemes) {
      expect(
        keybindsForScheme(scheme).map((keybind) => keybind.id),
        scheme,
      ).toEqual(ids);
    }
  });

  it('never declares the same chord twice inside one scheme', () => {
    for (const scheme of keybindSchemes) {
      const printed = keybindsForScheme(scheme).map((keybind) => formatChord(keybind.chord));
      expect(printed, scheme).toEqual([...new Set(printed)]);
    }
  });

  it('changes both navigation and the shell in every scheme that is not the default', () => {
    // The defect this table exists to remove: a named collection an operator
    // can select that gives every action the chord it already had.
    for (const scheme of keybindSchemes.filter((name) => name !== 'terminal-default')) {
      const moved = keybindsForScheme(scheme).filter(
        (keybind, index) =>
          formatChord(keybind.chord) !== formatChord(keybindRegistry[index]!.chord),
      );
      expect(
        moved.some((keybind) => keybind.category === 'navigation'),
        scheme,
      ).toBe(true);
      expect(
        moved.some((keybind) => keybind.id.startsWith('shell.')),
        scheme,
      ).toBe(true);
    }
  });

  it('addresses the rail with a g-prefixed sequence in the vim collection', () => {
    expect(chordOf('vim-inspired', 'navigate.overview')).toEqual({
      prefix: 'KeyG',
      code: 'Digit1',
    });
    expect(chordOf('vim-inspired', 'navigate.analytics')).toEqual({
      prefix: 'KeyG',
      code: 'Digit9',
    });
    // Printed as two presses, because that is what it is.
    expect(formatChord(chordOf('vim-inspired', 'navigate.objects')!)).toBe('G → 2');
  });

  it('puts motion on h, j, k and l in the vim collection', () => {
    expect(chordOf('vim-inspired', 'scene.sectionFiles')).toEqual({ code: 'KeyH' });
    expect(chordOf('vim-inspired', 'scene.sectionMap')).toEqual({ code: 'KeyL' });
    expect(chordOf('vim-inspired', 'scene.previousCue')).toEqual({ code: 'KeyK' });
    expect(chordOf('vim-inspired', 'scene.nextCue')).toEqual({ code: 'KeyJ' });
  });

  it('keeps every accessibility chord to one modifier and one hand', () => {
    // The promise the name makes. The default collection breaks it three
    // times over -- Ctrl+Shift+Alt+S, Ctrl+Shift+Alt+D and Ctrl+Shift+E --
    // and puts Ctrl+K and Ctrl+/ across the board from the control key.
    for (const keybind of keybindsForScheme('accessibility')) {
      const modifiers = modifierCount(keybind.chord);
      expect(
        modifiers,
        `${keybind.id} holds ${modifiers.toString()} modifiers`,
      ).toBeLessThanOrEqual(1);
      if (modifiers === 1) {
        expect(
          withinOneHandOfAModifier.has(keybind.chord.code),
          `${keybind.id} reaches ${keybind.chord.code} while holding a modifier`,
        ).toBe(true);
      }
      // A sequence is fine for vim; a prefix key is one more thing to hold in
      // mind, and this collection buys simplicity rather than reach.
      expect(keybind.chord.prefix, keybind.id).toBeUndefined();
    }
  });

  it('withdraws the typing guard from a chord the operator could type', () => {
    // `/` opens search in the vim collection, so it can no longer fire from
    // inside a field: it would swallow the slash of a path being typed.
    const vimSearch = keybindsForScheme('vim-inspired').find(
      (keybind) => keybind.id === 'shell.search',
    );
    expect(vimSearch?.chord).toEqual({ code: 'Slash' });
    expect(vimSearch?.whileTyping).toBe(false);

    // Ctrl+F is not a character, so the accessibility collection keeps the
    // guard and search still reaches out of a field.
    const accessibleSearch = keybindsForScheme('accessibility').find(
      (keybind) => keybind.id === 'shell.search',
    );
    expect(accessibleSearch?.whileTyping).toBe(true);
  });

  it('lets nothing but Ctrl, Alt and Escape through the typing guard', () => {
    for (const scheme of keybindSchemes) {
      for (const keybind of keybindsForScheme(scheme).filter((entry) => entry.whileTyping)) {
        const { chord } = keybind;
        expect(
          chord.ctrl === true || chord.alt === true || chord.code === 'Escape',
          `${scheme}/${keybind.id}`,
        ).toBe(true);
      }
    }
  });
});
