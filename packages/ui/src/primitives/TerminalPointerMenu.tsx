'use client';

import { Menu } from '@base-ui/react/menu';
import { useMemo } from 'react';

import { classNames } from './classNames.js';
import type { TerminalMenuItem } from './TerminalMenu.js';
import {
  TERMINAL_MENU_BASE_UTILITY,
  TERMINAL_MENU_ITEM_KBD_UTILITY,
  TERMINAL_MENU_ITEM_UTILITY,
  TERMINAL_POPUP_POSITIONER_UTILITY,
} from './terminalOverlayStyles.js';

export interface TerminalPointerMenuProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly x: number;
  readonly y: number;
  readonly items: ReadonlyArray<TerminalMenuItem>;
  readonly label: string;
  readonly className?: string;
}

/**
 * A menu anchored to a point rather than to a trigger element.
 *
 * `TerminalContextMenu` covers the case where one element owns one menu and
 * can be wrapped in JSX. This one exists for the opposite case: a single
 * application-wide runtime that decides which declared menu belongs to
 * whatever the pointer landed on, and opens it where the pointer is. Base UI's
 * positioner takes a virtual anchor, so the point is expressed as a
 * zero-sized rect rather than by absolutely positioning a popup by hand --
 * collision flipping near the window edges then comes from the library.
 */
export function TerminalPointerMenu({
  open,
  onOpenChange,
  x,
  y,
  items,
  label,
  className,
}: TerminalPointerMenuProps) {
  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () => ({
        x,
        y,
        width: 0,
        height: 0,
        top: y,
        right: x,
        bottom: y,
        left: x,
      }),
    }),
    [x, y],
  );

  return (
    <Menu.Root open={open} onOpenChange={(nextOpen) => onOpenChange(nextOpen)}>
      <Menu.Portal>
        <Menu.Positioner
          anchor={anchor}
          side="inline-end"
          align="start"
          sideOffset={2}
          className={classNames('terminal-menu__positioner', TERMINAL_POPUP_POSITIONER_UTILITY)}
        >
          <Menu.Popup
            aria-label={label}
            className={classNames(
              'terminal-menu',
              'terminal-pointer-menu',
              TERMINAL_MENU_BASE_UTILITY,
              className,
            )}
          >
            {items.map((item) => (
              <Menu.Item
                key={item.id}
                disabled={item.disabled}
                className={classNames('terminal-menu__item', TERMINAL_MENU_ITEM_UTILITY)}
                data-tone={item.tone ?? 'neutral'}
                onClick={item.onSelect}
              >
                <span>{item.label}</span>
                {item.shortcut ? (
                  <kbd className={TERMINAL_MENU_ITEM_KBD_UTILITY}>{item.shortcut}</kbd>
                ) : null}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
