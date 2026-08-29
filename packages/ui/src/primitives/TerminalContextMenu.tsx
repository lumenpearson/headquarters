'use client';

import { ContextMenu } from '@base-ui/react/context-menu';
import type { ReactElement } from 'react';

import { classNames } from './classNames.js';
import type { TerminalMenuItem } from './TerminalMenu.js';
import {
  TERMINAL_MENU_BASE_UTILITY,
  TERMINAL_MENU_ITEM_KBD_UTILITY,
  TERMINAL_MENU_ITEM_UTILITY,
  TERMINAL_POPUP_POSITIONER_UTILITY,
} from './terminalOverlayStyles.js';

export interface TerminalContextMenuProps {
  readonly trigger: ReactElement;
  readonly items: ReadonlyArray<TerminalMenuItem>;
  readonly label: string;
  readonly className?: string;
}

export function TerminalContextMenu({
  trigger,
  items,
  label,
  className,
}: TerminalContextMenuProps) {
  return (
    <ContextMenu.Root>
      {/*
        The marker says "this element already answers the right button", so an
        application-wide right-click runtime yields here instead of opening a
        second menu over this one.
      */}
      <ContextMenu.Trigger data-context-menu-own="" render={trigger} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner
          className={classNames('terminal-menu__positioner', TERMINAL_POPUP_POSITIONER_UTILITY)}
        >
          <ContextMenu.Popup
            aria-label={label}
            className={classNames(
              'terminal-menu',
              'terminal-context-menu',
              TERMINAL_MENU_BASE_UTILITY,
              className,
            )}
          >
            {items.map((item) => (
              <ContextMenu.Item
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
              </ContextMenu.Item>
            ))}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
