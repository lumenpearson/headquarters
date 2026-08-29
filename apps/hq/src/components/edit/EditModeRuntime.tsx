'use client';

import { useEffect, useSyncExternalStore } from 'react';

import { useBooleanSetting } from '@/application/personalization/useSetting';
import { useKeybind } from '@/components/keybinds/KeybindRuntime';
import {
  currentGroupRuntime,
  noGroupRuntime,
  subscribeGroupRuntime,
} from '@/components/sync/groupRuntimeHolder';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

import {
  connectLiveEdit,
  createBrowserLiveEditTransport,
} from '@/infrastructure/browser/LiveEditBus';
import type { LiveEditTransport } from '@/infrastructure/browser/LiveEditBus';
import { createGroupLiveEditTransport } from '@/infrastructure/controlPlane/GroupLiveEditTransport';

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
  /*
   * External state, read with the hook for external state, as
   * `ControlPlaneRuntime` reads its session. A group appears and disappears
   * with `JoinGroup`, which is not a render of this component, so mirroring it
   * into component state would leave two copies to disagree about whether a
   * channel exists.
   */
  const group = useSyncExternalStore(subscribeGroupRuntime, currentGroupRuntime, noGroupRuntime);

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
    /*
     * Which transport, in one line: the group's when this session is in one,
     * the browser's when it is not. F10 replaces the wire underneath live edit
     * and nothing else -- the gate above still decides whether any wire exists,
     * and the re-validation below still decides what may land.
     *
     * A patch published to the group reaches every admitted device rather than
     * only the tabs of one browser profile, which is what R27 asks for; a
     * local-only session keeps exactly the behaviour it had.
     */
    const bus =
      transport ??
      (group === null
        ? createBrowserLiveEditTransport()
        : createGroupLiveEditTransport({
            channel: group.channel,
            onPublishFailed: () =>
              operationsStore
                .getState()
                .patchConnection({ failure: 'ЖИВОЕ РЕДАКТИРОВАНИЕ НЕ ПРИНЯТО ГРУППОЙ' }),
          }));
    const disconnect = connectLiveEdit(bus, (patchSet) => {
      // R4: a content patch lands through the same action a local edit takes,
      // so the receiving session's undo stack gets its own entry for a
      // neighbor's edit instead of the content-overrides record being
      // replaced wholesale underneath the ledger.
      if (patchSet.kind === 'content')
        operationsStore.getState().applyContentPatch(patchSet.patches);
      else operationsStore.getState().applySettingsPatch(patchSet.patches);
    });
    return () => {
      disconnect();
      // A transport handed in belongs to whoever handed it in; only the one
      // opened here is closed here.
      if (transport === undefined) bus.close();
    };
  }, [group, liveEdit, transport]);

  useKeybind('edit.toggle', () => {
    const state = operationsStore.getState();
    if (state.edit.active) state.exitEditMode();
    else state.enterEditMode();
  });

  return null;
}
