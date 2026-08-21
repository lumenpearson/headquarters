import { describe, expect, it } from 'vitest';

import { formatChord, matchesChord, type Chord } from './match';

const event = (init: Partial<KeyboardEvent> & { code: string }): KeyboardEvent =>
  ({
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...init,
  }) as KeyboardEvent;

describe('chord matching', () => {
  it('matches a plain key only when no modifier is held', () => {
    const chord: Chord = { code: 'KeyF' };
    expect(matchesChord(event({ code: 'KeyF' }), chord)).toBe(true);
    expect(matchesChord(event({ code: 'KeyF', ctrlKey: true }), chord)).toBe(false);
  });

  it('requires every declared modifier and rejects any extra one', () => {
    // The scattered handlers this replaces tested only the modifiers they
    // cared about, so Ctrl+Shift+Alt+E also toggled edit mode, which is
    // Ctrl+Shift+E, while Ctrl+Shift+Alt+S was a different command entirely.
    const chord: Chord = { code: 'KeyE', ctrl: true, shift: true };
    expect(matchesChord(event({ code: 'KeyE', ctrlKey: true, shiftKey: true }), chord)).toBe(true);
    expect(
      matchesChord(event({ code: 'KeyE', ctrlKey: true, shiftKey: true, altKey: true }), chord),
    ).toBe(false);
    expect(matchesChord(event({ code: 'KeyE', ctrlKey: true }), chord)).toBe(false);
  });

  it('accepts the command key where a chord asks for control', () => {
    // The same physical gesture on a Mac keyboard.
    const chord: Chord = { code: 'KeyK', ctrl: true };
    expect(matchesChord(event({ code: 'KeyK', metaKey: true }), chord)).toBe(true);
    expect(matchesChord(event({ code: 'KeyK', ctrlKey: true }), chord)).toBe(true);
  });

  it('formats a chord the way a keyboard is labelled', () => {
    expect(formatChord({ code: 'KeyK', ctrl: true })).toBe('Ctrl + K');
    expect(formatChord({ code: 'KeyE', ctrl: true, shift: true })).toBe('Ctrl + Shift + E');
    expect(formatChord({ code: 'KeyS', ctrl: true, shift: true, alt: true })).toBe(
      'Ctrl + Shift + Alt + S',
    );
    expect(formatChord({ code: 'Escape' })).toBe('Esc');
    expect(formatChord({ code: 'Space' })).toBe('Пробел');
    expect(formatChord({ code: 'Digit1' })).toBe('1');
  });
});
