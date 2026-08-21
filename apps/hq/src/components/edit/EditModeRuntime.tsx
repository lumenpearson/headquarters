'use client';

import { useEffect } from 'react';

import { operationsStore, useOperationsStore } from '@/state/operationsStore';

/**
 * Mounts the edit-mode keybind and publishes the mode onto the document root.
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

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.code !== 'KeyE') return;
      // Typing in a field must not toggle the mode out from under the operator.
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }
      event.preventDefault();
      const state = operationsStore.getState();
      if (state.edit.active) state.exitEditMode();
      else state.enterEditMode();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return null;
}
