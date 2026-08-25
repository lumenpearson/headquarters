'use client';

import { useEffect } from 'react';

import { useBooleanSetting } from '@/application/personalization/useSetting';
import { useKeybind } from '@/components/keybinds/KeybindRuntime';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

import {
  connectLiveEdit,
  createBrowserLiveEditTransport,
} from '@/infrastructure/browser/LiveEditBus';
import type { LiveEditTransport } from '@/infrastructure/browser/LiveEditBus';

interface EditModeRuntimeProps {
  /**
   * The channel live edit travels over. Supplied only where the caller owns
   * one already -- a test, and later the authenticated transport F10 brings --
   * so the application itself mounts this component with no props at all.
   */
  readonly transport?: LiveEditTransport;
}

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
 *
 * It also owns the group's live-edit connection, because the connection has
 * the same lifetime as this runtime and none at all beyond it: it is mounted
 * once for the whole application, so a patch made anywhere -- the edit panel,
 * the settings screen -- is carried by the same channel, and the sessions on
 * the receiving end are display sessions that never enter edit mode themselves.
 */
export function EditModeRuntime({ transport }: EditModeRuntimeProps) {
  const active = useOperationsStore((state) => state.edit.active);
  const liveEdit = useBooleanSetting('advanced.liveEdit');

  useEffect(() => {
    document.documentElement.dataset.editMode = active ? 'on' : 'off';
    return () => {
      delete document.documentElement.dataset.editMode;
    };
  }, [active]);

  /*
   * `advanced.liveEdit` decides whether the channel exists, not whether a
   * message is filtered on its way out. With the group's opt-in off -- the
   * default, and the state of any group that has not agreed to synchronized
   * editing -- no `BroadcastChannel` is opened, nothing is written to
   * `localStorage`, and no listener is registered, so this session's edits
   * cannot leave it and another session's cannot enter it.
   *
   * Enabling and withdrawing are not symmetric, deliberately: the patch that
   * turns the opt-in on cannot travel, because there is no channel yet to
   * carry it and a group is joined one deliberate opt-in at a time, while the
   * patch that turns it off goes out over the connection this effect then
   * closes -- which is how the rest of the group hears that the decision
   * changed. Everything after that stays in this session.
   */
  useEffect(() => {
    if (!liveEdit) return;
    const bus = transport ?? createBrowserLiveEditTransport();
    const disconnect = connectLiveEdit(bus, (patches) => {
      operationsStore.getState().applySettingsPatch(patches);
    });
    return () => {
      disconnect();
      // A transport handed in belongs to whoever handed it in; only the one
      // opened here is closed here.
      if (transport === undefined) bus.close();
    };
  }, [liveEdit, transport]);

  useKeybind('edit.toggle', () => {
    const state = operationsStore.getState();
    if (state.edit.active) state.exitEditMode();
    else state.enterEditMode();
  });

  return null;
}
