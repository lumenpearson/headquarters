import { beforeEach, describe, expect, it } from 'vitest';

import { operationsStore } from '@/state/operationsStore';

import { contextMenuFor, entryShortcut, type ContextMenuEntry } from './registry';

function shellEntry(id: string): ContextMenuEntry {
  const entry = contextMenuFor('shell')?.items.find((item) => item.id === id);
  if (entry === undefined) throw new Error(`the shell menu has no ${id} entry`);
  return entry;
}

describe('context menu shortcuts', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('prints the chord of the collection the operator selected, not the default one', () => {
    // `shell.search` is Ctrl+K in `terminal-default` and `/` in `vim-inspired`,
    // so the two collections disagree about this entry and the assertion cannot
    // pass by accident.
    expect(entryShortcut(shellEntry('shell.search'))).toBe('Ctrl + K');

    operationsStore
      .getState()
      .applySettingsPatch([{ id: 'keybinds.scheme', value: 'vim-inspired' }]);

    /*
     * It used to read `keybindRegistry` — the default collection — whatever the
     * operator had chosen, so a menu under this scheme advertised Ctrl+K for a
     * command that answers to `/`. The same defect the shell's own hint carried
     * (C35): a chord printed in a second place drifts from the one that fires.
     */
    expect(entryShortcut(shellEntry('shell.search'))).toBe('/');
  });

  it('prints nothing for an entry that raises an action rather than a keybind', () => {
    // Diagnostics is an action, not a chord. Inventing a shortcut for it would
    // advertise a key that does nothing.
    expect(entryShortcut(shellEntry('shell.diagnostics'))).toBeUndefined();
  });
});
