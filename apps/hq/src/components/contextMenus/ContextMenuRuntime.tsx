'use client';

import { TerminalPointerMenu, type TerminalMenuItem } from '@gremuchaya/ui/primitives';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { copyDiagnosticsReport } from '@/application/contextMenus/diagnostics';
import { readAppLocale } from '@/application/localization/locale';
import {
  contextMenuFor,
  contextMenuRegistry,
  entryShortcut,
  type ContextMenuDefinition,
} from '@/application/contextMenus/registry';
import {
  readBooleanSetting,
  useBooleanSetting,
  useNumberSetting,
  useStringSetting,
} from '@/application/personalization/useSetting';
import {
  fireKeybind,
  keybindOwnerIds,
  subscribeKeybindOwners,
} from '@/components/keybinds/KeybindRuntime';
import { operationsStore } from '@/state/operationsStore';

type ContextMenuHandler = (subject: string | undefined) => void;

/*
 * One subscriber table for the whole document, in the same idiom as the
 * keybind runtime next door: the application is a single client runtime, and a
 * context through every screen that owns an action would be ceremony around
 * one instance.
 */
const handlers = new Map<string, Set<ContextMenuHandler>>();
const ownerListeners = new Set<() => void>();

function announceOwners(): void {
  for (const listener of [...ownerListeners]) listener();
}

/**
 * A stable description of everything a menu could run right now.
 *
 * Passed into the builder as an argument rather than read from the tables
 * inside it, so that "which entries are available" is a visible input: the
 * compiler may then cache a built list against it and still be correct, and a
 * claim made or dropped produces a different string and a fresh list.
 *
 * `|` is safe as the separator: every id in both registries is a dotted
 * lowercase identifier.
 *
 * A setting that gates an entry belongs here for exactly the reason a claim
 * does. `privacy.copyDiagnostics` decides whether the diagnostics entry may
 * run, so leaving it out would let a list cached against this string keep
 * answering with the permission the operator gave before they changed it.
 *
 * `localization.locale` belongs here on the same argument, and it is what
 * makes a menu follow the language. `contextMenuFor` resolves a label at the
 * moment the menu is built, but a subscriber whose snapshot did not change is
 * never asked to build one -- so without the locale in this string the shell's
 * commands button would keep the previous language until some unrelated claim
 * moved.
 */
function menuOwnerSnapshot(): string {
  const claimed = [...handlers.keys()].filter((id) => (handlers.get(id)?.size ?? 0) > 0);
  const permitted = new Set(
    contextMenuRegistry
      .flatMap((definition) => definition.items)
      .flatMap((entry) =>
        entry.requiresSetting !== undefined && readBooleanSetting(entry.requiresSetting)
          ? [`s:${entry.requiresSetting}`]
          : [],
      ),
  );
  return [
    ...keybindOwnerIds().map((id) => `k:${id}`),
    ...claimed.map((id) => `a:${id}`),
    ...permitted,
    `l:${readAppLocale()}`,
  ]
    .sort()
    .join('|');
}

/** Subscribes a surface to both claim tables and to the settings draft. */
export function useMenuOwners(): string {
  return useSyncExternalStore(
    useCallback((listener: () => void) => {
      const unsubscribeKeybinds = subscribeKeybindOwners(listener);
      // Every store change, not a selector: the snapshot is a string, so a
      // notification that changes nothing in it costs one comparison and no
      // render.
      const unsubscribeSettings = operationsStore.subscribe(listener);
      ownerListeners.add(listener);
      return () => {
        unsubscribeKeybinds();
        unsubscribeSettings();
        ownerListeners.delete(listener);
      };
    }, []),
    menuOwnerSnapshot,
    // The server renders no menus; an empty claim set is the honest snapshot.
    () => '',
  );
}

/**
 * Claims a declared context-menu action for as long as the screen is mounted.
 *
 * The screen that can carry an action out owns it -- objects push their own
 * route, files open their own drawer -- while the declaration and the menu
 * live in one place. An action nothing claims is drawn disabled rather than
 * hidden: the operator learns the command exists and does not apply here.
 */
export function useContextMenuAction(id: string, handler: ContextMenuHandler): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const existing = handlers.get(id) ?? new Set<ContextMenuHandler>();
    const wrapped: ContextMenuHandler = (subject) => latest.current(subject);
    existing.add(wrapped);
    handlers.set(id, existing);
    announceOwners();
    return () => {
      existing.delete(wrapped);
      if (existing.size === 0) handlers.delete(id);
      announceOwners();
    };
  }, [id]);
}

/**
 * Turns a declared menu into the items a `Terminal*` menu renders.
 *
 * Shared by the right-click runtime and by any visible trigger that offers the
 * same commands, so the two cannot come to disagree about what a surface
 * offers or about which entry is available. Read at the moment the menu is
 * shown: ownership is a property of what is mounted right now.
 *
 * An entry a setting has switched off is disabled here and still listed, the
 * same treatment an unclaimed one gets: an operator who cannot see a command
 * cannot go and turn it back on.
 */
export function buildContextMenuItems(
  definition: ContextMenuDefinition,
  subject: string | undefined,
  ownerSnapshot: string,
): TerminalMenuItem[] {
  const owners = new Set(ownerSnapshot.split('|'));
  return definition.items.map((entry) => {
    const owned =
      entry.keybind === undefined
        ? owners.has(`a:${entry.action ?? ''}`)
        : owners.has(`k:${entry.keybind}`);
    const permitted =
      entry.requiresSetting === undefined || owners.has(`s:${entry.requiresSetting}`);
    const shortcut = entryShortcut(entry);
    return {
      id: entry.id,
      label: entry.label,
      disabled: !owned || !permitted,
      ...(shortcut === undefined ? {} : { shortcut }),
      ...(entry.tone === undefined ? {} : { tone: entry.tone }),
      onSelect: () => {
        if (entry.keybind !== undefined) {
          fireKeybind(entry.keybind);
          return;
        }
        const owners = handlers.get(entry.action ?? '');
        if (owners === undefined) return;
        for (const owner of [...owners]) owner(subject);
      },
    };
  });
}

interface OpenMenu {
  readonly definition: ContextMenuDefinition;
  readonly subject: string | undefined;
  readonly x: number;
  readonly y: number;
}

/**
 * The single application-wide right-click menu (R12).
 *
 * One `contextmenu` listener rather than a Base UI `ContextMenu.Root` wrapped
 * around every surface: the surfaces that need one are table rows and the
 * shell itself, and wrapping each row would put one menu instance per row on
 * screen. A surface declares itself with `data-context-menu` and, for a row,
 * `data-context-subject` -- the record the action applies to.
 */
export function ContextMenuRuntime() {
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const owners = useMenuOwners();
  // Through the shared reader rather than a lookup with a literal beside it:
  // the definition already states the default.
  const longPressEnabled = useBooleanSetting('popups.longPress');
  const longPressDelay = useNumberSetting('popups.longPressDelay');
  const fieldMenu = useStringSetting('popups.fieldMenu');

  /*
   * Claimed by the runtime rather than by a screen, unlike the record actions:
   * a diagnostic report describes the client, not the row under the pointer,
   * and it has to be available from wherever the fault happened. This
   * component is mounted once in the root layout, so the command exists on
   * every route.
   */
  useContextMenuAction('shell.copyDiagnostics', () => {
    void copyDiagnosticsReport();
  });

  const openAt = useCallback(
    (target: EventTarget | null, x: number, y: number): boolean => {
      if (!(target instanceof Element)) return false;
      // A field keeps the browser's own menu: cut, copy, paste and spellcheck are
      // real commands there and this application has nothing better to offer.
      if (
        fieldMenu === 'native' &&
        target.closest('input, textarea, [contenteditable="true"]') !== null
      ) {
        return false;
      }
      /*
       * The nearest declared surface wins, and `data-context-menu-own` is part
       * of the selector on purpose: an element carrying its own Base UI context
       * menu stops the walk without naming a surface, so nothing opens over it.
       * Two menus for one click would be two places deciding what the right
       * button does.
       *
       * No declared surface falls back to the shell menu rather than to the
       * web engine's. The engine's menu offers reload and inspection commands
       * that mean nothing to an operator, and it used to appear on every
       * surface outside `.ops-shell` -- the portalled dialogs, the edit panel
       * -- because only the shell root carried the attribute. The two ways to
       * keep it are still deliberate: a field under `popups.fieldMenu:
       * 'native'` above, and an element owning a Base UI menu here.
       */
      const surface = target.closest('[data-context-menu], [data-context-menu-own]');
      if (surface !== null && surface.getAttribute('data-context-menu') === null) return false;
      const definition = contextMenuFor(surface?.getAttribute('data-context-menu') ?? 'shell');
      if (definition === undefined) return false;
      setOpen({
        definition,
        subject: surface?.getAttribute('data-context-subject') ?? undefined,
        x,
        y,
      });
      return true;
      // `fieldMenu` belongs here: with an empty list this closes over the value
      // the runtime mounted with, and the guard would keep yielding a field to
      // the browser however the operator had set it.
    },
    [fieldMenu],
  );

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (openAt(event.target, event.clientX, event.clientY)) event.preventDefault();
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, [openAt]);

  /*
   * `popups.longPress` was declared in the settings schema and read by nothing
   * at all until here. Touch has no right button, so a long press is the same
   * gesture by other means; a mouse never reaches this path.
   */
  useEffect(() => {
    if (!longPressEnabled) return undefined;
    let timer = 0;
    const cancel = () => window.clearTimeout(timer);
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      const { target, clientX, clientY } = event;
      cancel();
      timer = window.setTimeout(() => openAt(target, clientX, clientY), longPressDelay);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointerup', cancel);
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('pointermove', cancel);
    return () => {
      cancel();
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointerup', cancel);
      document.removeEventListener('pointercancel', cancel);
      document.removeEventListener('pointermove', cancel);
    };
  }, [longPressDelay, longPressEnabled, openAt]);

  if (open === null) return null;

  const items = buildContextMenuItems(open.definition, open.subject, owners);

  return (
    <TerminalPointerMenu
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setOpen(null);
      }}
      x={open.x}
      y={open.y}
      items={items}
      label={open.definition.label}
    />
  );
}
