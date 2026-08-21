import { describe, expect, it } from 'vitest';

import { formatChord } from './match';
import { findKeybind, keybindRegistry } from './registry';

const event = (init: Partial<KeyboardEvent> & { code: string }): KeyboardEvent =>
  ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...init }) as KeyboardEvent;

describe('keybind registry', () => {
  it('never declares the same chord twice', () => {
    // The invariant a registry exists to buy. While every keybind was its own
    // `if` in somebody's effect, nothing could notice two of them colliding.
    const printed = keybindRegistry.map((keybind) => formatChord(keybind.chord));
    expect(printed).toEqual([...new Set(printed)]);
  });

  it('never declares the same id twice', () => {
    const ids = keybindRegistry.map((keybind) => keybind.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it('gives every keybind something to show in the list', () => {
    // R11 asks for a list of them. A keybind with no description cannot appear
    // in one, so the registry is the wrong place to leave that blank.
    for (const keybind of keybindRegistry) {
      expect(keybind.description.length, keybind.id).toBeGreaterThan(0);
      expect(keybind.category.length, keybind.id).toBeGreaterThan(0);
    }
  });

  it('routes the digit keys to the navigation entries they are numbered for', () => {
    // This was dead code: the handler compared the display badge "02" against
    // the key "2", so no digit ever matched and none of the numbered routes
    // could be reached from the keyboard.
    expect(findKeybind(event({ code: 'Digit1' }), { typing: false })?.id).toBe('navigate.overview');
    expect(findKeybind(event({ code: 'Digit2' }), { typing: false })?.id).toBe('navigate.objects');
    expect(findKeybind(event({ code: 'Digit9' }), { typing: false })?.id).toBe(
      'navigate.analytics',
    );
  });

  it('withholds the typing-unsafe keybinds while a field has focus', () => {
    // Typing "2" into a search box must not navigate away from it.
    expect(findKeybind(event({ code: 'Digit2' }), { typing: true })).toBeUndefined();
    expect(findKeybind(event({ code: 'KeyF' }), { typing: true })).toBeUndefined();
  });

  it('still reaches the keybinds that exist to get out of a field', () => {
    expect(findKeybind(event({ code: 'Escape' }), { typing: true })?.id).toBe('shell.dismiss');
    expect(findKeybind(event({ code: 'KeyK', ctrlKey: true }), { typing: true })?.id).toBe(
      'shell.search',
    );
  });

  it('keeps edit mode and the material import apart, which loose matching did not', () => {
    const editMode = event({ code: 'KeyE', ctrlKey: true, shiftKey: true });
    expect(findKeybind(editMode, { typing: false })?.id).toBe('edit.toggle');
    // Ctrl+Shift+Alt+E used to toggle edit mode too, because the old handler
    // never looked at Alt.
    const withAlt = event({ code: 'KeyE', ctrlKey: true, shiftKey: true, altKey: true });
    expect(findKeybind(withAlt, { typing: false })).toBeUndefined();
  });
});
