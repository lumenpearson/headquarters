'use client';

import { useEffect } from 'react';

import { useKeybind } from '@/components/keybinds/KeybindRuntime';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

/**
 * Publishes the edit mode onto the document root and owns its toggle.
 *
 * The chord itself, and the guard that stops it firing while the operator is
 * typing, are declared in the keybind registry; this component only says what
 * happens when it fires.
 *
 * The `data-edit-mode` attribute is what edit.css keys the resize cursors off.
 * A data attribute rather than a class so a stray `className` edit elsewhere
 * cannot silently switch those rules off.
 */
export function EditModeRuntime() {
  const active = useOperationsStore((state) => state.edit.active);

  useEffect(() => {
    document.documentElement.dataset.editMode = active ? 'on' : 'off';
    return () => {
      delete document.documentElement.dataset.editMode;
    };
  }, [active]);

  useKeybind('edit.toggle', () => {
    const state = operationsStore.getState();
    if (state.edit.active) state.exitEditMode();
    else state.enterEditMode();
  });

  return null;
}
